package pine.mobile.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// What the phone keeps of a computer that announces itself on the network (Nearby.kt), and the list
// of those found. The same cases as the iOS core's NearbyTests.swift.
class NearbyTest {
	private val id = "EKN2VkO6uLv7SOTEAyIGDru_1I_cTOGadqwTlLFm-qs"
	private val nonce = "q3b0cJ2-Zk_9xYw1LmNoPA"

	private fun record(v: String? = "1", id: String? = this.id, service: String? = OFFICIAL_SERVICE, noService: Boolean = false, nonce: String? = this.nonce, noNonce: Boolean = false): Map<String, String?> =
		buildMap {
			v?.let { put("v", it) }
			id?.let { put("id", it) }
			if (!noService) put("service", service)
			if (!noNonce) put("nonce", nonce)
		}

	private fun computer(service: String, id: String = this.id, nonce: String = this.nonce) = NearbyComputer(id, service, nonce)

	@Test
	fun `a record of version 1 names a machine id and an https service`() {
		assertEquals(computer(OFFICIAL_SERVICE), nearbyComputer(record()))
		assertEquals(computer("https://pine-pr-57.drcmda.workers.dev"), nearbyComputer(record(service = "https://pine-pr-57.drcmda.workers.dev")))
		assertEquals(computer("https://pine.example.com:8443"), nearbyComputer(record(service = "https://pine.example.com:8443")))
		assertEquals(computer(OFFICIAL_SERVICE), nearbyComputer(record(service = "$OFFICIAL_SERVICE:443")), "without :443")
		assertEquals(computer("https://pine.example.com"), nearbyComputer(record(service = "HTTPS://PINE.Example.com")), "in lower case")
		assertEquals(computer(OFFICIAL_SERVICE), nearbyComputer(mapOf("V" to "1", "ID" to id, "Service" to OFFICIAL_SERVICE, "NONCE" to nonce)), "keys in any case")
	}

	@Test
	fun `a record without a service names the official one`() {
		assertEquals(computer(OFFICIAL_SERVICE), nearbyComputer(record(noService = true)))
	}

	@Test
	fun `a record of another version, without a good machine id, or with a service that is not an https origin, is ignored`() {
		assertNull(nearbyComputer(record(v = "2")))
		assertNull(nearbyComputer(record(v = null)))
		assertNull(nearbyComputer(record(id = null)))
		assertNull(nearbyComputer(record(id = id.drop(1))))
		assertNull(nearbyComputer(record(id = id.dropLast(1) + "+")))
		for (service in listOf("http://pine.example.com", "", "https://pine.example.com/", "https://pine.example.com/x", "https://me@pine.example.com", "javascript:alert(1)", null)) {
			assertNull(nearbyComputer(record(service = service)), "service $service")
		}
	}

	@Test
	fun `a record without a nonce of the announced shape is ignored`() {
		assertNull(nearbyComputer(record(noNonce = true)), "no nonce: a Pine app that lets no codeless request in without one")
		for (nonce in listOf(null, "", nonce.drop(1), nonce + "A", nonce.dropLast(1) + "+", nonce.dropLast(1) + "=", nonce.dropLast(1) + "\n", "nearby.$nonce")) {
			assertNull(nearbyComputer(record(nonce = nonce)), "nonce $nonce")
		}
		assertEquals(computer(OFFICIAL_SERVICE, nonce = "A-_zA-_zA-_zA-_zA-_z09"), nearbyComputer(record(nonce = "A-_zA-_zA-_zA-_zA-_z09")))
	}

	@Test
	fun `of two records of one computer the official service is kept, else the first found, and the event carries the nonce`() {
		val found = NearbyFound()
		assertTrue(found.found("Pine", computer("https://pine.example.com")))
		assertTrue(found.found("Pine (2)", computer(OFFICIAL_SERVICE, nonce = "B".repeat(22))), "the official service wins")
		assertEquals(listOf(computer(OFFICIAL_SERVICE, nonce = "B".repeat(22))), found.list())
		assertFalse(found.found("Pine (3)", computer("https://elsewhere.example.com")), "a later record names no other service")
		assertEquals(listOf(computer(OFFICIAL_SERVICE, nonce = "B".repeat(22))), found.list())
		assertTrue(found.lost("Pine (2)"))
		assertEquals(listOf(computer("https://pine.example.com")), found.list(), "the first found of the others")
		assertTrue(found.found("Pine", computer("https://pine.example.com", nonce = "C".repeat(22))), "a record published again with a new nonce")
		val told = found.event().getJSONArray("computers")
		assertEquals(1, told.length())
		assertEquals(mapOf("id" to id, "service" to "https://pine.example.com", "nonce" to "C".repeat(22)), told.getJSONObject(0).toMap())
	}

	@Test
	fun `the list holds each computer once, follows what is lost, and says when it changed`() {
		val found = NearbyFound()
		assertEquals("""{"computers":[]}""", found.event().toString())
		assertTrue(found.found("Pine", computer(OFFICIAL_SERVICE)))
		assertFalse(found.found("Pine", computer(OFFICIAL_SERVICE)), "the same again changes nothing")
		assertFalse(found.found("Pine (2)", computer(OFFICIAL_SERVICE)), "the same machine under another name is listed once")
		val other = "A".repeat(43)
		assertTrue(found.found("Pine (3)", computer("https://pine.example.com", other)))
		assertEquals(listOf(computer(OFFICIAL_SERVICE), computer("https://pine.example.com", other)), found.list())
		assertFalse(found.lost("Pine"), "still there under its other name")
		assertTrue(found.lost("Pine (2)"))
		assertTrue(found.found("Pine (3)", null), "a record it no longer reads takes it out")
		assertEquals(emptyList(), found.list())
		assertFalse(found.lost("never seen"))
	}
}
