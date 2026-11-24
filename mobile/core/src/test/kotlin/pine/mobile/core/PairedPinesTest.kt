package pine.mobile.core

import org.json.JSONObject
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

// What the page is told of a pairing and of a paired computer's connection (Pines, the plugin
// without Android), against the Pine app's real access host. The plugin calls `pair` and
// `cancelPairing` as ticket 06's contract (mobile/src/plugin.ts) says.
class PairedPinesTest {
	private val vault = MemoryVault()
	private val key = DeviceKey(vault)
	private val daemon = StandInDaemon()
	private val computer = AccessHost("""{"base":"${daemon.base}","token":"secret-token","mode":"safe","started":true,"home":"/Users/me/.pine","version":"0.40.0"}""")
	private val remote = Remote(key, KnownHosts(vault), answerMs = 5_000, openMs = 3_000, webrtc = LibDataChannelRtc, route = { if (it == SERVICE) computer.service else it })
	private val shelf = MemoryShelf()
	private val page = SeenPage()
	/** The waits between attempts that Pines asked for, as `backoff` gives them: each is slept a twentieth of. */
	private val waits = Collections.synchronizedList(mutableListOf<Long>())
	private val pines = Pines(remote, KnownHosts(vault), shelf, page, retryMs = 50, backoffMs = { n -> backoff(n).also { waits.add(it) } / 20 })
	private val hold = CountDownLatch(1)

	init {
		daemon.routes["/events/stream"] = { x ->
			x.responseHeaders.add("content-type", "text/event-stream")
			x.sendResponseHeaders(200, 0)
			x.responseBody.write(": connected\n\n".toByteArray())
			x.responseBody.flush()
			hold.await(30, TimeUnit.SECONDS)
		}
	}

	@AfterTest
	fun end() {
		hold.countDown()
		pines.close()
		computer.close()
		daemon.close()
	}

	/** A pairing opened at the computer: its link, under the https name the test routes to the helper. */
	private fun link(): String = computer.command("open").getString("link").replace(computer.service, SERVICE)

	private fun sees(what: String, ms: Long = 15_000, ok: (JSONObject) -> Boolean): JSONObject {
		within(ms, "$what; the page was told ${page.states.takeLast(3)}") { page.last?.let(ok) == true }
		return page.last!!
	}

	private fun paired(): String {
		pines.ready()
		val link = link()
		computer.command("allow")
		pines.pair(link, "Pine on Pixel 9")
		sees("ready") { it.optString("status") == "ready" }
		return PAIRED + pairLink(link)!!.id
	}

	@Test
	fun `a pairing tells the page the phone's name, then the four digits, and a yes keeps the computer and connects to it`() {
		pines.ready()
		val link = link()
		pines.pair(link, "Pine on Pixel 9")
		val code = computer.event("asked").getString("code")
		val asking = sees("the four digits") { it.optJSONObject("pairing")?.has("code") == true }
		assertEquals("""{"pairing":{"code":"$code","computer":"Test Mac","name":"Pine on Pixel 9"},"status":"starting"}""", sorted(asking))
		assertTrue(page.states.any { sorted(it) == """{"pairing":{"name":"Pine on Pixel 9"},"status":"starting"}""" }, "the name first")
		assertTrue(pines.hosts.isEmpty(), "nothing kept before the yes")
		computer.command("allow")
		val ready = sees("ready") { it.optString("status") == "ready" }
		val host = PAIRED + pairLink(link)!!.id
		assertEquals(host, ready.getString("host"))
		assertEquals("Test Mac", ready.getString("label"))
		assertEquals("paired Test Mac", ready.getString("from"))
		assertEquals(listOf(host), pines.hosts)
		assertEquals(host, pines.use)
		assertEquals(mapOf(host to "Test Mac"), pines.names)
		assertEquals(PairedComputer(pairLink(link)!!.id, SERVICE, "Test Mac"), pines.paired(host))
		assertTrue(pines.call("GET", "/agents", null).ok)
	}

	@Test
	fun `a refusal is told in the page's words, with no machine, and keeps nothing`() {
		pines.ready()
		computer.command("refuse")
		pines.pair(link(), "Pine on Pixel 9")
		val told = sees("the refusal") { it.optString("status") == "error" }
		assertEquals(PairWords.REFUSED, told.getString("message"))
		assertEquals("ssh", told.getString("kind"))
		assertFalse(told.has("host"))
		assertTrue(pines.hosts.isEmpty())
		assertNull(shelf.get("paired")?.takeIf { it != "{}" })
		// It is over: another pairing may start.
		pines.pair(link(), "Pine on Pixel 9")
	}

	@Test
	fun `a link that is not one, a service that is not https, or a second pairing at once is refused`() {
		pines.ready()
		val link = link()
		assertEquals(PairWords.NOT_A_LINK, assertFailsWith<RemoteError> { pines.pair(link.replace(SERVICE, computer.service), "Pine on Pixel 9") }.message)
		assertEquals(PairWords.NOT_A_LINK, assertFailsWith<RemoteError> { pines.pair("https://pine.example/#pair=nope", "Pine on Pixel 9") }.message)
		pines.pair(link, "Pine on Pixel 9")
		assertEquals("A pairing is open already: cancel it first.", assertFailsWith<RemoteError> { pines.pair(link, "Pine on Pixel 9") }.message)
	}

	@Test
	fun `cancelling a pairing keeps nothing and shows the machine in use again`() {
		val host = paired()
		pines.pair(link(), "Pine on another phone")
		computer.event("asked")
		sees("the four digits") { it.optJSONObject("pairing")?.has("code") == true }
		pines.cancelPairing()
		assertTrue(computer.event("left").getString("id").startsWith("pairing:"), "the pairing session ended at the computer")
		val back = sees("the machine in use again") { it.optString("status") == "ready" }
		assertEquals(host, back.getString("host"))
		assertEquals(1, computer.command("devices").getJSONArray("devices").length())
		pines.cancelPairing()
	}

	@Test
	fun `a cut connection is made again by itself, through a trouble that passes, and a removed phone is told to pair again`() {
		val host = paired()
		val device = computer.command("devices").getJSONArray("devices").getJSONObject(0).getString("id")
		within(5_000, "the event stream is up") { pines.connected }

		// The computer is there but the service over its limits: the phone keeps trying, with its wait.
		computer.command("meeting limits")
		computer.command("cut $device")
		val trouble = sees("the trouble") { it.optString("status") == "error" }
		assertEquals("The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile.", trouble.getString("message"))
		assertEquals(host, trouble.getString("host"))
		computer.command("meeting normal")
		sees("connected again, by itself") { it.optString("status") == "ready" }
		within(5_000, "the event stream is up again") { pines.connected }

		// Removed at the computer: final, and said so.
		computer.command("remove $device")
		val removed = sees("the removal") { it.optString("status") == "error" }
		assertEquals("This phone is no longer known to Test Mac. Open Pine on Test Mac and add this device again.", removed.getString("message"))
		val count = page.states.size
		Thread.sleep(600)
		pines.check()
		Thread.sleep(300)
		assertEquals(count, page.states.size, "nothing tried again: ${page.states.takeLast(3)}")
		assertContains(page.last!!.getString("message"), "add this device again")
	}

	/** The phone's device id at the computer, once paired. */
	private fun device(): String = computer.command("devices").getJSONArray("devices").getJSONObject(0).getString("id")

	@Test
	fun `a trouble that may pass is tried again with a growing wait until the computer is reached`() {
		paired()
		val device = device()
		within(5_000, "the event stream is up") { pines.connected }
		computer.command("meeting limits")
		waits.clear()
		computer.command("cut $device")
		sees("the limits said") { it.optString("status") == "error" }
		within(10_000, "three waits asked for: $waits") { waits.size >= 3 }
		assertEquals(listOf(backoff(0), backoff(1), backoff(2)), waits.take(3))
		assertTrue(backoff(0) < backoff(1) && backoff(1) < backoff(2), "each wait longer than the one before")
		assertEquals("The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile.", page.last!!.getString("message"))
		computer.command("meeting normal")
		sees("reached again without the owner") { it.optString("status") == "ready" }
		assertEquals(2, computer.connections(device))
	}

	@Test
	fun `a paired computer that shows another host key is refused for good and not tried again`() {
		val host = paired()
		val device = device()
		within(5_000, "the event stream is up") { pines.connected }
		val other = computer.command("meeting swap").getString("impostor")
		waits.clear()
		computer.command("cut $device")
		val refused = sees("refused") { it.optString("status") == "error" }
		assertEquals(host, refused.getString("host"))
		assertEquals(true, refused.getBoolean("changed"))
		assertEquals(pairedFingerprint(other), refused.getString("fingerprint"))
		computer.command("meeting normal")
		pines.check()
		Thread.sleep(500)
		assertEquals("error", page.last!!.optString("status"), "never tried again")
		assertEquals(emptyList(), waits.toList(), "no wait asked for: nothing to try again")
		assertEquals(1, computer.connections(device))
	}

	@Test
	fun `the check on return to the front connects a paired computer again when it no longer answers`() {
		paired()
		val device = device()
		pines.check()
		assertEquals(1, computer.connections(device), "one that answers is kept")
		daemon.routes["/health"] = { x -> x.sendResponseHeaders(503, -1) }
		pines.check()
		sees("ready again") { it.optString("status") == "ready" }
		assertTrue(computer.connections(device) >= 2, "made again whole")
	}

	@Test
	fun `a yes for a computer the list has no room for says so in the iOS core's words, and keeps nothing`() {
		pines.ready()
		(1..MAX_HOSTS).forEach { pines.addHost("me@host$it") }
		computer.command("allow")
		pines.pair(link(), "Pine on Pixel 9")
		val told = sees("the full list") { it.optString("status") == "error" }
		assertEquals("There are 20 machines already: forget one first, then add this device again at your computer.", told.getString("message"))
		assertEquals(MAX_HOSTS, pines.hosts.size)
		assertTrue(pines.hosts.none { it.startsWith(PAIRED) })
	}

	@Test
	fun `a computer found on the network is paired without a code, the page sees its name with the digits, and a yes keeps it`() {
		pines.ready()
		computer.command("nearby on")
		pines.pairNearby(computer.machineId, SERVICE, computer.nonce, "Pine on Pixel 9")
		val code = computer.event("asked").getString("code")
		val asking = sees("the four digits") { it.optJSONObject("pairing")?.has("code") == true }
		assertEquals("""{"pairing":{"code":"$code","computer":"Test Mac","name":"Pine on Pixel 9"},"status":"starting"}""", sorted(asking))
		computer.command("allow")
		val ready = sees("ready") { it.optString("status") == "ready" }
		val host = PAIRED + computer.machineId
		assertEquals(host, ready.getString("host"))
		assertEquals(host, pines.use)
		assertEquals(PairedComputer(computer.machineId, SERVICE, "Test Mac"), pines.paired(host))
	}

	@Test
	fun `a codeless request the computer does not let in is told to the page, and keeps nothing`() {
		pines.ready()
		pines.pairNearby(computer.machineId, SERVICE, computer.nonce, "Pine on Pixel 9")
		val told = sees("the request not let in") { it.optString("status") == "error" }
		assertEquals(PairWords.NOT_LET_IN, told.getString("message"))
		assertEquals("ssh", told.getString("kind"))
		assertFalse(told.has("host"))
		assertTrue(pines.hosts.isEmpty())
	}

	@Test
	fun `a codeless pairing with an id, a service or a nonce of another shape, or while another is open, is refused`() {
		pines.ready()
		assertEquals(PairWords.NOT_NEARBY, assertFailsWith<RemoteError> { pines.pairNearby("nope", SERVICE, computer.nonce, "Pine on Pixel 9") }.message)
		assertEquals(PairWords.NOT_NEARBY, assertFailsWith<RemoteError> { pines.pairNearby(computer.machineId, "http://meet.test", computer.nonce, "Pine on Pixel 9") }.message)
		assertEquals(PairWords.NOT_NEARBY, assertFailsWith<RemoteError> { pines.pairNearby(computer.machineId, "https://meet.test/", computer.nonce, "Pine on Pixel 9") }.message)
		assertEquals(PairWords.NOT_NEARBY, assertFailsWith<RemoteError> { pines.pairNearby(computer.machineId, SERVICE, "short", "Pine on Pixel 9") }.message)
		pines.pair(link(), "Pine on Pixel 9")
		assertEquals(PairWords.BUSY, assertFailsWith<RemoteError> { pines.pairNearby(computer.machineId, SERVICE, computer.nonce, "Pine on Pixel 9") }.message)
	}

	/** A state as text, its keys in order, so that it is compared whole. */
	private fun sorted(o: JSONObject): String = sortedValue(o)

	private fun sortedValue(v: Any?): String = when (v) {
		is JSONObject -> v.keySet().sorted().joinToString(",", "{", "}") { "\"$it\":${sortedValue(v.get(it))}" }
		is String -> JSONObject.quote(v)
		else -> v.toString()
	}
}
