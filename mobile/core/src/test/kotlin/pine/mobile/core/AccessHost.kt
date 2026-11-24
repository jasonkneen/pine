package pine.mobile.core

import org.json.JSONObject
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The Pine app's real access host, started for a test: mobile/test/support/access-host.ts under
 * Node (its comment is the protocol). It waits at a meeting service on a loopback port with no
 * STUN server, and its service line names `serviceLine`'s daemon: a stand-in of the test's own. The
 * meeting service it names (in a pairing link, on the pairing channel) is `SERVICE`, which a test's
 * `Remote` routes to `service`.
 * Closing it closes its stdin and waits for it to end, so that its temp home goes with it.
 */
class AccessHost(serviceLine: String, vararg options: String) : AutoCloseable {
	private val process: Process
	private val lines = LinkedBlockingQueue<JSONObject>()
	private val events = LinkedBlockingQueue<JSONObject>()
	/** Every event so far, whether `event()` took it or not. */
	private val all = java.util.concurrent.ConcurrentLinkedQueue<JSONObject>()

	/** The meeting service's origin (http, on the loopback). */
	val service: String

	/** The computer's machine id. */
	val machineId: String

	/** The nonce its announcement carries now, which a codeless request names; `rotate()` changes it. */
	@Volatile
	var nonce: String
		private set

	init {
		val checkout = CASES.parentFile.parentFile
		val script = File(checkout, "mobile/test/support/access-host.ts")
		process = ProcessBuilder("node", script.path, "--service-line", serviceLine, "--service-name", SERVICE, *options)
			.redirectError(ProcessBuilder.Redirect.INHERIT)
			.start()
		thread(isDaemon = true, name = "access-host-out") {
			process.inputStream.bufferedReader().forEachLine { line ->
				val said = runCatching { JSONObject(line) }.getOrNull() ?: return@forEachLine
				if (said.optString("t") in EVENTS) {
					all.add(said)
					events.add(said)
				} else lines.add(said)
			}
		}
		val ready = next(20_000)
		if (ready.optString("t") == "missing") error(ready.optString("message"))
		check(ready.optString("t") == "ready") { "the access host said $ready" }
		service = ready.getString("service")
		machineId = ready.getString("machineId")
		nonce = ready.getString("nonce")
	}

	/** A new nonce, as the announcement gets every few minutes: the one before still works, not the one before that. */
	fun rotate(): String = command("rotate").getString("nonce").also { nonce = it }

	private fun next(ms: Long): JSONObject = lines.poll(ms, TimeUnit.MILLISECONDS) ?: error("the access host said nothing within ${ms}ms")

	/** One command, and its answer. */
	fun command(line: String): JSONObject {
		process.outputStream.write("$line\n".toByteArray())
		process.outputStream.flush()
		val answer = next(10_000)
		check(answer.optString("t") != "error") { "the access host refused $line: ${answer.optString("message")}" }
		return answer
	}

	/** Pairs the phone's key directly, as an earlier pairing would have. */
	fun pair(key: DeviceKey, name: String = "Pine on a test"): JSONObject = command("add ${key.publicKey.split(' ').take(2).joinToString(" ")} $name")

	/** The next event of kind `t`, within `ms`. Events of other kinds before it are dropped. */
	fun event(t: String, ms: Long = 10_000): JSONObject {
		val until = System.currentTimeMillis() + ms
		while (true) {
			val left = until - System.currentTimeMillis()
			val e = events.poll(left.coerceAtLeast(0), TimeUnit.MILLISECONDS) ?: error("no $t event within ${ms}ms")
			if (e.optString("t") == t) return e
		}
	}

	/** How many SSH sessions the device `id` began so far. */
	fun connections(id: String): Int = all.count { it.optString("t") == "connected" && it.optString("id") == id }

	override fun close() {
		runCatching { process.outputStream.close() }
		if (!process.waitFor(15, TimeUnit.SECONDS)) {
			process.destroy()
			process.waitFor(5, TimeUnit.SECONDS)
		}
	}

	private companion object {
		val EVENTS = setOf("asked", "paired", "connected", "left")
	}
}
