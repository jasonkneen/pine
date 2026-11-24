package pine.mobile.core

import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.security.SecureRandom
import java.util.Base64
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Waits up to `ms` for `ok`. */
fun within(ms: Long, what: String, ok: () -> Boolean) {
	val until = System.currentTimeMillis() + ms
	while (!ok()) {
		if (System.currentTimeMillis() > until) throw AssertionError("still not within ${ms}ms: $what")
		Thread.sleep(20)
	}
}

// A computer paired by its link, reached over a WebRTC data channel through its meeting service:
// the Pine app's real access host (AccessHost), whose service line names this test's own stand-in
// daemon, as web/test/peer.test.ts pairs the web bridge with it. The words are the iOS core's
// (PeerTests.swift asserts the same sentences).
class PeerTest {
	private val vault = MemoryVault()
	private val key = DeviceKey(vault)
	private val daemon = StandInDaemon()
	private val computer = AccessHost("""{"base":"${daemon.base}","token":"secret-token","mode":"safe","started":true,"home":"/Users/me/.pine","version":"0.40.0"}""")
	private val remote = remote()
	private val host get() = PAIRED + computer.machineId
	private val open = mutableListOf<AutoCloseable>()
	private val hold = CountDownLatch(1)

	/** Where the test's https names of meeting services are reached: the helper's meeting is http on the loopback, which no link and no stored machine may name. */
	private val routes = mutableMapOf(SERVICE to computer.service)

	private fun remote(openMs: Long = 20_000) = Remote(key, KnownHosts(vault), answerMs = 5_000, openMs = openMs, webrtc = LibDataChannelRtc, route = { routes[it] ?: it })

	/** The computer as the phone keeps it once paired, under the https name the test routes to the helper's meeting. */
	private fun paired(name: String? = "Test Mac", id: String = computer.machineId, service: String = SERVICE) = PairedComputer(id, service, name)

	/** The phone's device id at the computer, once it was added there. */
	private var device = ""

	private fun connected(): RemoteService {
		device = computer.pair(key).getString("id")
		return remote.connect(host, paired()).also { s -> open.add(AutoCloseable { s.stop() }) }
	}

	@AfterTest
	fun end() {
		hold.countDown()
		open.forEach { runCatching { it.close() } }
		computer.close()
		daemon.close()
	}

	@Test
	fun `it reaches a paired computer, reads its service line and calls its daemon through it`() {
		val s = connected()
		assertEquals("secret-token", s.token)
		assertEquals(host, s.host)
		assertEquals("Test Mac", s.label)
		assertEquals("/Users/me/.pine", s.home)
		assertTrue(s.started)
		assertTrue(s.paired)
		val r = s.call("POST", "/agents/main/message", JSONObject().put("text", "hello"))
		assertTrue(r.ok, "$r")
		val seen = daemon.seen.single()
		assertEquals("/agents/main/message", seen.url)
		assertEquals("Bearer secret-token", seen.header("authorization"))
		assertEquals("""{"text":"hello"}""", seen.body)
		assertEquals(daemon.base.removePrefix("http://"), seen.header("host"))
		assertNull(seen.header("origin"))
		assertTrue(computer.command("devices").getJSONArray("devices").getJSONObject(0).getBoolean("connected"), "signed in as the paired device")
	}

	@Test
	fun `a picture comes through it as over SSH on TCP`() {
		daemon.routes["/media/tool/pic"] = { x ->
			x.responseHeaders.add("content-type", "image/png")
			x.sendResponseHeaders(200, StandInDaemon.PNG.size.toLong())
			x.responseBody.write(StandInDaemon.PNG)
		}
		val answer = mediaFromDaemon(connected(), "GET", "/media/tool/pic", "?v=1")
		assertEquals(200, answer.status)
		assertEquals("image/png", answer.headers["content-type"])
		assertEquals(StandInDaemon.PNG.toList(), answer.body.use { it.readBytes() }.toList())
		assertEquals("/media/tool/pic?v=1", daemon.seen.single().url)
	}

	@Test
	fun `several megabytes cross in each direction, whole and in order`() {
		val random = SecureRandom()
		val up = Base64.getEncoder().encodeToString(ByteArray(4 * 1024 * 1024).also { random.nextBytes(it) })
		val down = ByteArray(4 * 1024 * 1024).also { random.nextBytes(it) }
		daemon.routes["/down"] = { x ->
			x.responseHeaders.add("content-type", "application/octet-stream")
			x.sendResponseHeaders(200, down.size.toLong())
			x.responseBody.write(down)
		}
		val s = connected()
		val got = s.call("GET", "/down", null)
		assertTrue(got.ok, got.data.toString().take(300))
		assertTrue(down.contentEquals(Base64.getDecoder().decode((got.data as JSONObject).getString("base64"))), "the bytes down, whole and in order")
		assertTrue(s.call("POST", "/agents/main/message", JSONObject().put("data", up)).ok)
		assertEquals(up, JSONObject(daemon.seen.last().body).getString("data"), "the bytes up, whole and in order")
	}

	@Test
	fun `a computer whose host key is not the machine id is refused before the phone's key is offered`() {
		computer.pair(key)
		val impostor = computer.command("meeting swap").getString("impostor")
		val e = assertFailsWith<HostKeyError> { remote.connect(host, paired()) }
		// Not "no longer known": the impostor never saw the phone's key, which it would have refused.
		assertEquals("ssh", e.kind)
		assertTrue(e.changed)
		assertEquals(pairedFingerprint(impostor), e.fingerprint)
		assertEquals(host, e.host)
		assertEquals("The host key of Test Mac changed: it was ${pairedFingerprint(computer.machineId)}, it is now ${pairedFingerprint(impostor)}. Someone may stand between this phone and Test Mac. Forget it here, then open Pine on Test Mac and add this device again.", e.message)
		// Back to the computer the link names: the same phone gets in.
		computer.command("meeting normal")
		open.add(remote.connect(host, paired()).let { s -> AutoCloseable { s.stop() } })
	}

	@Test
	fun `a computer that no longer knows the phone says so`() {
		val e = assertFailsWith<RemoteError> { remote.connect(host, paired()) }
		assertEquals("This phone is no longer known to Test Mac. Open Pine on Test Mac and add this device again.", e.message)
	}

	@Test
	fun `closing the channel ends the session promptly, and the held machine is reported lost`() {
		val s = connected()
		computer.command("cut $device")
		val cut = System.currentTimeMillis()
		within(5_000, "the session ended") { !s.isOpen }
		assertTrue(System.currentTimeMillis() - cut < 3_000, "without waiting for SSH's keepalive")
		assertEquals(0, s.call("GET", "/agents", null).status)
		s.stop()

		daemon.routes["/events/stream"] = { x ->
			x.responseHeaders.add("content-type", "text/event-stream")
			x.sendResponseHeaders(200, 0)
			x.responseBody.write(": connected\n\n".toByteArray())
			x.responseBody.flush()
			hold.await(30, TimeUnit.SECONDS)
		}
		val ups = Collections.synchronizedList(mutableListOf<Boolean>())
		val on = object : EventHandlers {
			override fun batch(events: List<Any>) {}
			override fun connection(up: Boolean) {
				ups.add(up)
			}
		}
		val held = HeldRemote(remote, host, on, retryMs = 100, computer = { paired() }).also { open.add(it) }
		held.ensure()
		within(10_000, "the event stream is up") { ups.toList() == listOf(true) }
		computer.command("cut $device")
		within(5_000, "the loss reported") { ups.take(2) == listOf(true, false) }
	}

	@Test
	fun `no meeting service, no computer waiting, no path and the limits each say why`() {
		val nobody = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
		routes["https://nobody.test"] = "http://127.0.0.1:$nobody"
		val elsewhere = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
		computer.pair(key)
		val failures = listOf(
			assertFailsWith<RemoteError> { remote.connect(host, paired(name = null, service = "https://nobody.test")) } to
				"Could not connect to your computer. The meeting service could not be reached. Check the network, then try again.",
			assertFailsWith<RemoteError> { remote.connect(PAIRED + elsewhere, paired(id = elsewhere)) } to
				"Test Mac does not answer: it is off, asleep, or Pine is closed. This phone keeps trying, and connects when Test Mac is back.",
			assertFailsWith<RemoteError> { remote.connect(PAIRED + elsewhere, paired(name = null, id = elsewhere)) } to
				"Your computer does not answer: it is off, asleep, or Pine is closed. This phone keeps trying, and connects when your computer is back.",
			computer.command("meeting limits").let { assertFailsWith<RemoteError> { remote.connect(host, paired()) } } to
				"The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile.",
		)
		computer.command("meeting hold")
		val t = System.currentTimeMillis()
		val noPath = assertFailsWith<RemoteError> { remote(openMs = 1_000).connect(host, paired()) }
		assertTrue(System.currentTimeMillis() - t < 3_000, "within its time to the open channel")
		for ((e, words) in failures + (noPath to "Test Mac is there, but no direct connection could be made from this network. Try another network (another Wi-Fi, or your phone's data); this phone keeps trying meanwhile.")) {
			assertEquals(words, e.message)
			assertEquals("ssh", e.kind)
			assertFalse(e is HostKeyError)
		}
		assertTrue(daemon.seen.isEmpty())
	}

	@Test
	fun `a paired machine without what is kept for it, or with a meeting service that is not https, is not connected to`() {
		assertContains(assertFailsWith<RemoteError> { remote.connect(host) }.message!!, "pair it again")
		assertContains(assertFailsWith<RemoteError> { remote.connect(host, paired(id = "A".repeat(43))) }.message!!, "pair it again")
		assertContains(assertFailsWith<RemoteError> { remote.connect(host, paired(service = "http://pine.example")) }.message!!, "https")
		assertFailsWith<RemoteError> { remote.connect("paired:nope", paired()) }
		// The list keeps a paired computer with an https service only: the helper's is not taken from it.
		val shelf = MemoryShelf()
		shelf.set("hosts", """["$host"]""")
		shelf.set("paired", JSONObject().put(host, JSONObject().put("service", computer.service)).toString())
		assertNull(Pines(remote, KnownHosts(vault), shelf, SeenPage()).paired(host))
		assertTrue(daemon.seen.isEmpty())
	}

	@Test
	fun `without the test's seam, the helper's http meeting service is not reached, on the loopback or anywhere`() {
		computer.pair(key)
		// The app's Remote: no route but the service itself.
		val app = Remote(key, KnownHosts(vault), answerMs = 5_000, openMs = 2_000, webrtc = LibDataChannelRtc)
		for (service in listOf(computer.service, "http://127.0.0.1:1", "http://pine.example")) {
			assertNull(meetingService(service), service)
			assertContains(assertFailsWith<RemoteError> { app.connect(host, paired(service = service)) }.message!!, "https", message = service)
		}
		assertFalse(computer.command("devices").getJSONArray("devices").getJSONObject(0).getBoolean("connected"))
		assertTrue(daemon.seen.isEmpty())
	}
}

/** The https name under which the tests reach the access host's meeting (`route` of `Remote`). */
const val SERVICE = "https://meet.test"

// The servers that help a connection, as a meeting service's configuration names them: a table of
// what `iceOf` keeps and what it leaves out, with no computer and no network.
class IceTest {
	private fun ice(text: String?): List<String> = iceOf(text?.let { JSONObject(it) }).map { it.toString() }

	@Test
	fun `one address, a list of them, a bad server left out with the others kept, and nothing`() {
		val table = listOf(
			"""{"ice":[{"urls":"stun:stun.example.com:3478"}]}""" to listOf("stun:stun.example.com:3478"),
			"""{"ice":[{"urls":["turn:turn.example.com:3478","turns:turn.example.com:5349"]}]}""" to listOf("turn:turn.example.com:3478", "turns:turn.example.com:5349"),
			// A server with an address that is not STUN or TURN is left out whole; the others stay.
			"""{"ice":[{"urls":"stun:a.example.com"},{"urls":["stun:b.example.com","https://b.example.com"]},{"urls":42},{"urls":"stuns:c.example.com"}]}""" to listOf("stun:a.example.com", "stuns:c.example.com"),
			"""{"ice":[{"urls":[]}]}""" to emptyList(),
			"""{"ice":[]}""" to emptyList(),
			"""{}""" to emptyList(),
			null to emptyList(),
		)
		for ((config, expected) in table) assertEquals(expected, ice(config), "for $config")
	}
}
