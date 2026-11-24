// A machine's pine held while the app runs, as desktop/electron/main.ts holds one: its SSH
// session, and its events followed. Android may have cut the link while the app was in the
// background, so a held session is asked whether it still answers before it is used again
// (`answers`, main.ts's probe), and one whose event stream is lost five times in a row is made anew.
package pine.mobile.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Whether a daemon still answers: `GET /health`, which needs no token, within `timeoutMs`. */
fun answers(daemon: Daemon, timeoutMs: Long = 2_500): Boolean {
	val conn = try {
		daemon.open()
	} catch (e: Exception) {
		return false
	}
	val asked = CompletableFuture.supplyAsync {
		send(daemon, conn, "GET", "/health", authorized = false)
		readResponse(conn.input).status in 200..299
	}
	return try {
		asked.get(timeoutMs, TimeUnit.MILLISECONDS)
	} catch (e: Exception) {
		false
	} finally {
		conn.close()
	}
}

/**
 * The pine of the machine `host` names, held: `ensure()` connects or makes sure the held session
 * still answers, and follows its events into `on`. When the stream is lost five times in a row the
 * session is let go of and made again; `failed` hears it when that cannot be done.
 */
class HeldRemote(
	private val remote: Remote,
	val host: String,
	private val on: EventHandlers,
	private val failed: (Exception) -> Unit = {},
	private val retryMs: Long = 1_000,
	private val batchMs: Long = 24,
	/** What the list keeps beside a paired computer (its meeting service, its name), read at each connection; none for user@host. */
	private val computer: () -> PairedComputer? = { null },
) : AutoCloseable {
	private val lock = Object()
	private var following: Following? = null
	private var stopped = false

	/** The session in use, if there is one. */
	@Volatile
	var service: RemoteService? = null
		private set

	/** The held session when it still answers, else a new one (a `RemoteError` or `HostKeyError` when it cannot be made). */
	fun ensure(): RemoteService = synchronized(lock) {
		service?.let { s -> if (s.isOpen && answers(s)) return s }
		letGo()
		val s = remote.connect(host, computer())
		if (stopped) {
			s.stop()
			throw RemoteError("failed", "The connection to $host was closed.")
		}
		service = s
		following = followEvents(s, object : EventHandlers by on {
			// An SSH connection that broke does not come back by waiting: it is made again.
			override fun lost(times: Int): Boolean {
				if (times != 5) return on.lost(times)
				thread(isDaemon = true, name = "pine-reconnect") { again(s) }
				return true
			}
		}, retryMs, batchMs)
		s
	}

	private fun again(lost: RemoteService) {
		synchronized(lock) {
			if (stopped || service !== lost) return
			letGo()
		}
		try {
			ensure()
		} catch (e: Exception) {
			failed(e)
		}
	}

	private fun letGo() {
		following?.stop()
		following = null
		service?.stop()
		service = null
	}

	/** Lets go of the session: a daemon it started there stops. */
	fun stop() = synchronized(lock) {
		stopped = true
		letGo()
	}

	override fun close() = stop()
}
