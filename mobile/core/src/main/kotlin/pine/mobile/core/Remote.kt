// A pine on another machine, reached over SSH: `connectRemote` of src/remote.ts on the phone. One
// SSH session per machine runs `pine service` there (the very command src/remote.ts builds, read
// from remote-command.txt, which test/mobile-remote.test.ts holds equal to it), reads its one line,
// and keeps the session's stdin open as the leash of a daemon it started. Calls go through a
// `direct-tcpip` channel of that session each.
package pine.mobile.core

import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException
import java.security.PublicKey
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** What runs on the other machine: src/remote.ts's `remoteCommand()`, character for character. */
val REMOTE_COMMAND: String = Remote::class.java.getResource("remote-command.txt")!!.readText()

/** A daemon on another machine, held by one SSH session. */
class RemoteService internal constructor(
	/** The machine as the owner wrote it. */
	val host: String,
	/** A short name for it: the host name without the user and the domain. */
	val label: String,
	override val token: String,
	/** `pine service` there started the daemon, which this session holds by its stdin: it stops when the session ends. */
	val started: Boolean,
	/** The home of that pine, on that machine. */
	val home: String,
	val version: String?,
	override val end: Loopback,
	private val ssh: SSHClient,
	private val command: Session.Command,
	private val session: Session,
	/** What SSH runs on when it is not a socket of its own: the data channel to a paired computer. */
	private val transport: AutoCloseable? = null,
) : Daemon {
	/** Whether it is a computer paired by its link, reached over a data channel. */
	val paired: Boolean get() = transport != null

	/** Whether the session still stands. */
	val isOpen: Boolean get() = ssh.isConnected && command.isOpen

	override fun open(): Duplex {
		val channel = ssh.newDirectConnection(end.host, end.port)
		return object : Duplex {
			// Buffered once here: what reads it (heads, bodies, the event stream) reads a byte at a time.
			override val input: InputStream = channel.inputStream.buffered()
			override val output: OutputStream = channel.outputStream
			override fun close() = channel.close()
		}
	}

	/** One call of the control API: `callDaemon` with this daemon. */
	fun call(method: String, url: String, body: Any?): CallResult = callDaemon(this, method, url, body)

	/** Ends the session: its stdin first, so that a daemon it started stops, then the connection. */
	fun stop() {
		runCatching { command.outputStream.close() }
		runCatching { command.join(2, TimeUnit.SECONDS) }
		runCatching { session.close() }
		runCatching { ssh.disconnect() }
		runCatching { transport?.close() }
	}
}

/**
 * Connects to other machines with the phone's key, and only to those whose host key the owner
 * confirmed, or, for a computer paired by its link, whose host key is its machine id. `answerMs` is
 * how long `pine service` there has to say where its daemon answers; `connectMs` how long the
 * machine has to answer at all (ssh's ConnectTimeout); `openMs` how long a paired computer has to
 * be reached, from the join of its meeting to the open channel. `webrtc` is the WebRTC library a
 * paired computer is reached with (WebRtc.kt): libwebrtc in the Android app, libdatachannel in the
 * tests. A meeting service's certificate is checked against the system's authorities, and nothing
 * else: no caller can hand in one of its own (the emulator check relies on the debug build's network
 * security configuration instead). (A meeting service is trusted with signals and nothing more: the
 * computer is checked by its host key, whatever the service says.)
 */
class Remote internal constructor(
	private val key: DeviceKey,
	private val known: KnownHosts,
	private val answerMs: Long = 60_000,
	private val connectMs: Int = 15_000,
	/**
	 * How long a read on a channel waits for a byte: a daemon that takes a call and never answers
	 * fails it then. The event stream is read under it too, which the daemon's ping every 20 seconds keeps alive.
	 */
	private val readMs: Int = 60_000,
	private val openMs: Long = 20_000,
	private val webrtc: WebRtc,
	/**
	 * Where a meeting service is reached, by its https origin: the origin itself. Only a test hands
	 * in another (the access host's helper answers on http on the loopback, which no link may name):
	 * this constructor is internal to the core, and the app has the one below, which has no such value.
	 */
	private val route: (String) -> String,
) {
	constructor(
		key: DeviceKey,
		known: KnownHosts,
		webrtc: WebRtc,
		answerMs: Long = 60_000,
		connectMs: Int = 15_000,
		readMs: Int = 60_000,
		openMs: Long = 20_000,
	) : this(key, known, answerMs, connectMs, readMs, openMs, webrtc, { it })

	/** Where the meeting service `service` is reached: checked to be an https origin before anything is routed or reached. */
	private fun meeting(service: String): String =
		route(meetingService(service) ?: throw RemoteError("ssh", "The meeting service of this computer is not an https address: pair it again from the Pine app."))

	private val http: OkHttpClient by lazy {
		OkHttpClient.Builder()
			.connectTimeout(connectMs.toLong(), TimeUnit.MILLISECONDS)
			.readTimeout(connectMs.toLong(), TimeUnit.MILLISECONDS)
			.followRedirects(false)
			.build()
	}

	private fun client(readMs: Int = this.readMs): SSHClient {
		val config = DefaultConfig().apply {
			keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
			channelReadTimeoutMs = readMs
		}
		return SSHClient(config).apply {
			connectTimeout = connectMs
			// A link that died is noticed in under a minute, as ServerAliveInterval=15 and ServerAliveCountMax=3 do.
			(connection.keepAlive as? KeepAliveRunner)?.maxAliveCount = 3
			connection.keepAlive.keepAliveInterval = 15
		}
	}

	/**
	 * The daemon of the machine `value` names (host, user@host, user@host:port, or `paired:<machine
	 * id>` with what the list keeps beside it, `computer`), or a `RemoteError` that says what to do.
	 */
	fun connect(value: String, computer: PairedComputer? = null): RemoteService {
		if (value.trim().startsWith(PAIRED)) return connectPaired(value.trim(), computer)
		val named = sshHost(value) ?: throw RemoteError("ssh", "Name the machine as you would after ssh: user@host, or user@host:port.")
		val user = named.user ?: throw RemoteError("ssh", "Name the user too: user@${named.given}. A phone has no user name of its own to sign in with.")
		val given = named.given
		val ssh = client()
		var refusedKey: RemoteError? = null
		ssh.addHostKeyVerifier(object : HostKeyVerifier {
			override fun verify(hostname: String, port: Int, key: PublicKey): Boolean = try {
				known.check(given, named.host, named.port, key)
				true
			} catch (e: RemoteError) {
				refusedKey = e
				false
			}
			override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
		})
		try {
			try {
				ssh.connect(named.host, named.port)
			} catch (e: IOException) {
				refusedKey?.let { throw it }
				throw RemoteError("ssh", "Could not connect to $given over SSH (${e.message ?: e.javaClass.simpleName}). Check that this phone reaches that machine (the same Wi-Fi, or a VPN such as Tailscale on both), that SSH runs there, and that the port is right.")
			}
			try {
				ssh.authPublickey(user, key.provider())
			} catch (e: UserAuthException) {
				throw RemoteError("ssh", "Could not connect to $given over SSH: it did not take this phone's key for $user. Add the app's public key to ~/.ssh/authorized_keys of $user there, then try again.")
			}
			return serve(ssh, given, named.label, null)
		} catch (e: Exception) {
			runCatching { ssh.disconnect() }
			throw e
		}
	}

	/**
	 * A computer paired by its link, over a data channel opened through its meeting service. The
	 * host key it presents has to be its machine id, checked during key exchange, before the phone's
	 * key is offered; another one is refused for good. The session signs in as `pine`.
	 */
	private fun connectPaired(value: String, computer: PairedComputer?): RemoteService {
		val id = (listed(value) as Listed.Paired).id
		if (computer == null || computer.id != id) throw RemoteError("ssh", "This phone has nothing kept for that paired computer: pair it again from the Pine app.")
		val label = computer.name ?: YOUR_COMPUTER
		val words = PairedWords(label)
		val expected = pairedFingerprint(id)!!
		val stream = try {
			openPeer(meeting(computer.service), id, http, webrtc, openMs)
		} catch (e: PeerClosed) {
			throw RemoteError("ssh", words.peer(e.reason), passing = true)
		}
		val ssh = client()
		// What the computer may send before the phone says it took it in: sshj's own, unless the library
		// cannot take such a burst at once (`WebRtc.sshWindow`).
		webrtc.sshWindow?.let { ssh.connection.windowSize = it }
		val pinned = PinnedKey(expected)
		ssh.addHostKeyVerifier(pinned)
		try {
			try {
				ssh.connectVia(stream.input, stream.output)
			} catch (e: IOException) {
				pinned.seen?.let { throw HostKeyError(words.changed(expected, it), value, 0, it, changed = true) }
				throw RemoteError("ssh", words.cut, passing = true)
			}
			try {
				ssh.authPublickey(PAIRED_USER, key.provider())
			} catch (e: UserAuthException) {
				throw RemoteError("ssh", words.notKnown)
			} catch (e: IOException) {
				throw RemoteError("ssh", words.cut, passing = true)
			}
			return serve(ssh, value, label, stream)
		} catch (e: Exception) {
			runCatching { ssh.disconnect() }
			stream.close()
			throw e
		}
	}

	/**
	 * Pairs with the computer `link` names, as the phone called `name` ("Pine on Pixel 9"): `on`
	 * hears what the pairing reports (`PairingState`, Pairing.kt). Nothing is kept here: on
	 * `Allowed` the caller keeps the computer (`Pines.addPaired`) and connects to it as a paired phone.
	 */
	fun pair(link: PairLink, name: String, on: (PairingState) -> Unit): Pairing = pairAs(link.asked, name, on)

	/**
	 * Pairs with a computer found on the network, without a code: as `pair`, as user
	 * `nearby.<nonce>`. The machine id it announced is checked as a link's is: only its host key is
	 * taken; and the pairing ends when the computer names another meeting service than it announced.
	 */
	fun pairNearby(computer: NearbyComputer, name: String, on: (PairingState) -> Unit): Pairing = pairAs(computer.asked, name, on)

	private fun pairAs(asked: PairAs, name: String, on: (PairingState) -> Unit): Pairing =
		startPairing(asked, name, on, key, open = { openPeer(meeting(asked.service), asked.id, http, webrtc, openMs) }, client = {
			// The owner may take the computer's two minutes to answer: a read waits as long as the pairing does.
			client(readMs = PAIR_WAIT_MS.toInt())
		})

	/** Runs `pine service` in a session of `ssh`, which is signed in, and holds the daemon it names. */
	private fun serve(ssh: SSHClient, given: String, label: String, transport: ChannelStream?): RemoteService {
		val session = ssh.startSession()
		val command = session.exec(REMOTE_COMMAND)
		val err = StringBuilder()
		val reader = thread(isDaemon = true, name = "pine-ssh-stderr") {
			val buf = ByteArray(4096)
			runCatching {
				while (true) {
					val n = command.errorStream.read(buf)
					if (n < 0) break
					synchronized(err) {
						err.append(String(buf, 0, n, Charsets.UTF_8))
						if (err.length > 4000) err.delete(0, err.length - 4000)
					}
				}
			}
		}
		val line = firstLine(command.inputStream)
		val said = try {
			line.get(answerMs, TimeUnit.MILLISECONDS)
		} catch (e: Exception) {
			null
		}
		// A paired computer is named by its name in what the owner reads, never by its machine id.
		val shown = if (transport != null) label else given
		if (said == null) {
			// No line: the command ended (wait for its code and the last of stderr), or it says nothing.
			val ended = line.isDone
			if (ended) runCatching { command.join(5, TimeUnit.SECONDS) }
			reader.join(if (ended) 2_000 else 200)
			val stderr = synchronized(err) { err.toString() }
			if (transport != null && !transport.isOpen) throw RemoteError("ssh", PairedWords(label).lost, passing = true)
			if (Regex("unknown command \"service\"").containsMatchIn(stderr)) throw RemoteError("ssh", "The pine on $shown is too old to be reached this way: it has no \"service\" command. Update it there with \"pine update\", then try again.")
			throw RemoteError("ssh", trouble(shown, if (ended) "exit" else "timeout", command.exitStatus?.toString() ?: "", stderr))
		}
		val answer = try {
			JSONObject(said)
		} catch (e: Exception) {
			throw RemoteError("ssh", trouble(shown, "garbage", said.take(200), ""))
		}
		if (answer.has("error")) throw RemoteError("failed", "The pine on $label did not start: ${answer.opt("error")}")
		val end = loopbackEnd(answer.optString("base"))
		val token = answer.optString("token")
		if (token.isEmpty() || token.any { it.isISOControl() || it.isWhitespace() }) throw RemoteError("failed", "The pine on $label gave no token that can be sent.")
		return RemoteService(
			host = given,
			label = label,
			token = token,
			started = answer.optBoolean("started", false),
			home = answer.optString("home").ifEmpty { "~/.pine" },
			version = answer.opt("version") as? String,
			end = end,
			ssh = ssh,
			command = command,
			session = session,
			transport = transport,
		)
	}

	private companion object {
		/** The user a paired computer's access server takes the phone as, once it is paired. */
		const val PAIRED_USER = "pine"
	}
}

/** The first line the command writes, as a future: null when it ends before one. */
private fun firstLine(input: InputStream): CompletableFuture<String?> {
	val result = CompletableFuture<String?>()
	thread(isDaemon = true, name = "pine-ssh-line") {
		val line = ByteArrayOutputStream()
		try {
			while (true) {
				val b = input.read()
				if (b < 0) break
				if (b == '\n'.code) {
					result.complete(line.toString(Charsets.UTF_8))
					return@thread
				}
				if (line.size() < 64 * 1024) line.write(b)
			}
			result.complete(null)
		} catch (e: SocketTimeoutException) {
			// A command that says nothing for a while: `answerMs` decides when that is too long.
		} catch (e: Exception) {
			result.complete(null)
		}
	}
	return result
}

/** What went wrong, in the words of `sshTrouble` in src/remote.ts. */
private fun trouble(host: String, failed: String, detail: String, err: String): String {
	val said = err.replace(Regex("(?m)^#.*\\n?"), "").trim().takeLast(500)
	val check = Regex("https://login\\.tailscale\\.com/\\S+").find(err)?.value
	if (failed == "timeout") return if (check != null) "Tailscale SSH wants you to confirm it is you before $host lets you in. Open $check, sign in, then try again." else "$host did not answer over SSH within a minute.${if (said.isNotEmpty()) " It said: $said" else ""}"
	if (failed == "garbage") return "$host answered with something that is not pine's service line: $detail"
	if (detail == "127") return "pine is not installed on $host, or not on the PATH of its login shell. $said".trim()
	return said.ifEmpty { "SSH to $host ended (exit ${detail.ifEmpty { "unknown" }}) without saying why." }
}
