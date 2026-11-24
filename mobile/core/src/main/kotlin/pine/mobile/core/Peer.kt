// The way to a paired computer: a WebRTC data channel, through the computer's meeting service, as
// the web client opens it (web/src/peer.ts). The phone joins the meeting under the computer's
// machine id, makes the offer and one channel labelled `ssh`, and the two exchange the offer, the
// answer and their candidates as the service's signal messages; once the channel is open the
// meeting is left. The channel is then SSH's byte stream (Remote.kt), end to end, checked against
// the machine id's host key. The WebRTC library below is handed in (WebRtc.kt): Google's libwebrtc in
// the Android app, libdatachannel in the tests.
package pine.mobile.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

/** The channel the phone makes and the paired computer takes. */
const val LABEL = "ssh"

/** Writes are cut to this: the size every data channel carries without trouble. */
const val PIECE = 16 * 1024

/** A writer waits while more than this waits in the channel, and goes on once it fell to `LOW`. */
const val HIGH = 1024 * 1024
const val LOW = 256 * 1024

/**
 * Why the way to a paired computer could not be opened: the meeting service could not be reached
 * ("unreachable"), no computer waits under its id ("absent"), no connection was made in time or the
 * meeting ended first ("no-path"), or the service is over its limits ("limits"). The words are
 * `PairedWords.peer`'s.
 */
class PeerClosed(val reason: String) : Exception(reason)

/** "your computer": a paired computer that gave no name. */
const val YOUR_COMPUTER = "your computer"

/**
 * What the owner is told about a paired computer, in the web client's words (`peerTrouble`,
 * `notKnown` and the paired host-key sentence of web/src/host.ts) with "this phone" for "this
 * browser", word for word as the iOS core says them (PairedWords in PeerRemote.swift). `label` is
 * the name the computer gave when it was paired, or "your computer".
 */
class PairedWords(val label: String) {
	private val atStart = if (label == YOUR_COMPUTER) "Your computer" else label

	/** The way to the computer could not be opened. */
	fun peer(reason: String): String = when (reason) {
		"absent" -> "$atStart does not answer: it is off, asleep, or Pine is closed. This phone keeps trying, and connects when $label is back."
		"no-path" -> "$atStart is there, but no direct connection could be made from this network. Try another network (another Wi-Fi, or your phone's data); this phone keeps trying meanwhile."
		"limits" -> "The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile."
		else -> "Could not connect to $label. The meeting service could not be reached. Check the network, then try again."
	}

	/** The computer presented a host key that is not its machine id. */
	fun changed(was: String, seen: String) = "The host key of $label changed: it was $was, it is now $seen. Someone may stand between this phone and $label. Forget it here, then open Pine on $label and add this device again."

	/** The computer did not take the phone's key: it was removed there. */
	val notKnown: String get() = "This phone is no longer known to $label. Open Pine on $label and add this device again."

	/** The channel closed before SSH let the phone in. */
	val cut: String get() = "Could not connect to $label. The connection to the computer closed before SSH let this phone in."

	/** The channel went while `pine service` was asked. */
	val lost: String get() = "The connection to $label was lost while pine there was asked to start."
}

/** The servers that help a connection, as the service's configuration names them (`GET /meet/config`); anything that is not a STUN or TURN address is left out. */
fun iceOf(config: JSONObject?): List<URI> {
	val ice = config?.optJSONArray("ice") ?: return emptyList()
	val url = Regex("^(stun|stuns|turn|turns):\\S+$")
	return (0 until ice.length()).flatMap { i ->
		val urls = ice.optJSONObject(i)?.opt("urls")
		val list = when (urls) {
			is String -> listOf(urls)
			is JSONArray -> (0 until urls.length()).map { urls.opt(it) as? String ?: "" }
			else -> emptyList()
		}
		if (list.isEmpty() || !list.all { url.matches(it) }) emptyList() else list.mapNotNull { runCatching { URI(it) }.getOrNull() }
	}
}

/** The meeting's close codes (web/relay/src/meet.ts `CLOSE`) that say why a meeting ended. */
private fun whyClosed(code: Int): PeerClosed = PeerClosed(
	when (code) {
		4404 -> "absent"
		4429 -> "limits"
		// 4408 (the session ran out of time), or the computer or the service ended it: no way this time.
		else -> "no-path"
	},
)

/**
 * Where a meeting service answers: an https origin, and nothing else, the loopback included. Null
 * for anything else: the phone connects to nothing else. (The tests reach the access host's helper,
 * which answers on http on the loopback, through `route` of `Remote`, which only a test hands in.)
 */
fun meetingService(service: String): String? = httpsOrigin(service)?.first?.takeIf { it == service }

/**
 * The data channel, open, as SSH's byte stream: what arrives is read from `input` in order, bytes
 * that came before anybody read included, and the channel's end is its end (-1), so that SSH does
 * not hang on a channel that closed. `output` cuts writes into pieces of `PIECE` and waits while
 * more than `HIGH` is buffered. Closing either closes the channel and the connection.
 *
 * `make` makes the connection and its channel (`WebRtc.offer`) with the events this stream listens
 * to; `around` hears them too, for the signals and the channel's end. The library calls back on
 * threads of its own, where a throw is lost without a word, and where its own calls must not be made
 * (closing there can wait on itself): the callbacks only copy bytes and set flags, and the connection
 * is closed on a thread of its own.
 */
class ChannelStream internal constructor(make: (PeerEvents) -> PeerChannel, private val around: PeerEvents? = null) : AutoCloseable {
	private val lock = Object()
	private val arrived = LinkedBlockingQueue<ByteArray>()
	@Volatile
	private var ended = false
	private var closing = false

	/** Done once the channel is open. */
	internal val opened = CompletableFuture<Unit>()

	private val channel: PeerChannel = make(object : PeerEvents {
		override fun description(type: String, sdp: String) {
			around?.description(type, sdp)
		}

		override fun candidate(candidate: String, mid: String) {
			around?.candidate(candidate, mid)
		}

		override fun open() {
			opened.complete(Unit)
			around?.open()
		}

		override fun message(bytes: ByteArray) {
			if (!ended) arrived.add(bytes)
		}

		override fun drained() {
			synchronized(lock) { lock.notifyAll() }
		}

		override fun ended() {
			end()
			around?.ended()
		}
	})

	/** The computer's answer, and its candidates after it. */
	internal fun answer(sdp: String) = channel.answer(sdp)
	internal fun candidate(candidate: String, mid: String) = channel.candidate(candidate, mid)

	/** Whether the channel still stands. */
	val isOpen: Boolean get() = !ended

	/** The channel ended (from either side): readers get its end, writers an error. */
	private fun end() {
		if (ended) return
		ended = true
		arrived.add(END)
		synchronized(lock) { lock.notifyAll() }
	}

	val input: InputStream = object : InputStream() {
		private var piece: ByteArray = ByteArray(0)
		private var at = 0

		override fun read(): Int {
			val one = ByteArray(1)
			return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
		}

		override fun read(b: ByteArray, off: Int, len: Int): Int {
			if (len == 0) return 0
			while (at >= piece.size) {
				val next = arrived.take()
				if (next === END) {
					// Every reader after this one hears the end too.
					arrived.add(END)
					return -1
				}
				piece = next
				at = 0
			}
			val n = minOf(len, piece.size - at)
			System.arraycopy(piece, at, b, off, n)
			at += n
			return n
		}

		override fun close() = this@ChannelStream.close()
	}

	val output: OutputStream = object : OutputStream() {
		override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

		// One write at a time, so that the pieces of two writes never interleave while one waits for room.
		override fun write(b: ByteArray, off: Int, len: Int) = synchronized(this) {
			var at = off
			while (at < off + len) {
				synchronized(lock) {
					while (!ended && this@ChannelStream.buffered() > HIGH) lock.wait(50)
				}
				if (ended) throw IOException("The connection to the computer is closed.")
				val n = minOf(PIECE, off + len - at)
				try {
					channel.send(b, at, n)
				} catch (e: Exception) {
					end()
					throw IOException("The connection to the computer is closed.", e)
				}
				at += n
			}
		}

		override fun close() = this@ChannelStream.close()
	}

	/** How many bytes wait in the channel to be sent. */
	fun buffered(): Long = if (ended) 0 else runCatching { channel.buffered() }.getOrDefault(0)

	override fun close() {
		end()
		synchronized(lock) {
			if (closing) return
			closing = true
		}
		thread(isDaemon = true, name = "pine-peer-close") { runCatching { channel.close() } }
	}

	private companion object {
		/** The end of the stream, in the queue of what arrived. */
		val END = ByteArray(0)
	}
}

/**
 * Opens the way to the paired computer `id` through the meeting service at `base` (an origin
 * `Remote` checked to be https, then routed) on the library `webrtc`: its configuration (the ICE
 * servers), the join socket, the offer and the `ssh` channel, the computer's answer and candidates
 * (kept until its answer is set). Throws `PeerClosed` when there is no way to it, and when no
 * channel opened within `openMs`.
 *
 * The library's calls may wait for its own threads (libwebrtc's do), so its callbacks here take no
 * lock that is held while one of its calls is made: they only send signals and complete futures.
 */
internal fun openPeer(base: String, id: String, http: OkHttpClient, webrtc: WebRtc, openMs: Long = 20_000): ChannelStream {
	val config = runCatching {
		http.newCall(Request.Builder().url("$base/meet/config").build()).execute().use { r -> if (r.isSuccessful) JSONObject(r.body.string()) else null }
	}.getOrNull()
	val ice = iceOf(config)
	val result = CompletableFuture<ChannelStream>()
	val lock = Object()
	var stream: ChannelStream? = null
	var answered = false
	val pending = mutableListOf<Pair<String, String>>()

	val join = base.replaceFirst(Regex("^http"), "ws") + "/meet/join?id=$id"
	lateinit var socket: WebSocket
	val fail = { e: Exception -> if (result.completeExceptionally(e)) socket.cancel() }

	socket = http.newWebSocket(Request.Builder().url(join).build(), object : WebSocketListener() {
		override fun onMessage(webSocket: WebSocket, text: String) {
			val message = runCatching { JSONObject(text) }.getOrNull() ?: return
			val signal = { d: JSONObject -> webSocket.send(JSONObject().put("t", "signal").put("d", d).toString()) }
			try {
				if (message.optString("t") == "ready") {
					synchronized(lock) {
						if (stream != null || result.isDone) return
						// Made before the channel opens, so that the bytes the computer sends at once (SSH's banner) are kept.
						val made = ChannelStream({ events -> webrtc.offer(ice, LABEL, events) }, object : PeerEvents {
							override fun description(type: String, sdp: String) {
								signal(JSONObject().put("sdp", JSONObject().put("type", type).put("sdp", sdp)))
							}

							override fun candidate(candidate: String, mid: String) {
								signal(JSONObject().put("ice", JSONObject().put("candidate", candidate.removePrefix("a=")).put("sdpMid", mid).put("sdpMLineIndex", 0)))
							}

							override fun open() = Unit
							override fun message(bytes: ByteArray) = Unit
							override fun drained() = Unit

							// Before the channel opened there is no way this time; after, it is the stream's own end.
							override fun ended() {
								fail(PeerClosed("no-path"))
							}
						})
						stream = made
						made.opened.thenRun { if (result.complete(made)) webSocket.close(1000, "The channel is open.") }
					}
					return
				}
				if (message.optString("t") != "signal") return
				val d = message.optJSONObject("d") ?: return
				synchronized(lock) {
					val peer = stream ?: return
					val sdp = d.optJSONObject("sdp")
					val ice = d.optJSONObject("ice")
					if (sdp != null && sdp.optString("type") == "answer" && sdp.opt("sdp") is String) {
						if (answered) return
						peer.answer(sdp.getString("sdp"))
						answered = true
						pending.forEach { (c, mid) -> peer.candidate(c, mid) }
						pending.clear()
					} else if (ice != null && ice.optString("candidate").isNotEmpty()) {
						val candidate = ice.getString("candidate") to (ice.opt("sdpMid") as? String ?: "0")
						if (answered) peer.candidate(candidate.first, candidate.second) else pending.add(candidate)
					}
				}
			} catch (e: Exception) {
				// A message that does not fit this connection changes nothing: the time limit ends the attempt.
			}
		}

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
			webSocket.close(1000, null)
			fail(whyClosed(code))
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
			// A socket that never reached the meeting: the service could not be reached, or refused it outright.
			fail(if (synchronized(lock) { stream == null }) PeerClosed("unreachable") else PeerClosed("no-path"))
		}
	})

	try {
		return result.get(openMs, TimeUnit.MILLISECONDS)
	} catch (e: Exception) {
		fail(PeerClosed("no-path"))
		synchronized(lock) { stream?.close() }
		throw when (e) {
			is ExecutionException -> e.cause as? Exception ?: PeerClosed("no-path")
			is TimeoutException -> PeerClosed("no-path")
			else -> PeerClosed("no-path")
		}
	}
}