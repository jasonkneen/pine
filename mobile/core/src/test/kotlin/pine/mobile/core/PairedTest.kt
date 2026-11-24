package pine.mobile.core

import net.schmizz.sshj.common.Buffer
import org.json.JSONObject
import org.junit.jupiter.api.TestFactory
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

// A computer paired by its link: web/src/pairing.ts and desktop/electron/access/store.ts, on the
// phone. The cases are mobile/cases/pair-links.json, opened-links.json, machine-ids.json,
// device-names.json and paired-machines.json.
class PairedTest {
	@TestFactory
	fun `a pairing link is read in either form, and only with an https service`() = replay("pair-links") { case ->
		val expect = plain(android(case.opt("expect")))
		val read = pairLink(case.text("input"))
		if (expect == null) return@replay assertNull(read)
		expect as JSONObject
		// `host` and `official` are what the page shows the owner of the service: the page's test reads them, the core keeps neither.
		assertEquals(PairLink(expect.getString("service"), expect.getString("id"), expect.getString("code")), read)
	}

	@TestFactory
	fun `an address the app is opened with reaches the page only as a pairing link comes`() = replay("opened-links") { case ->
		val input = case.text("input")
		assertEquals(if (android(case.get("expect")) as Boolean) input else null, openedLink(input))
	}

	@TestFactory
	fun `a machine id is the fingerprint of the computer's host key`() = replay("machine-ids") { case ->
		val expect = plain(android(case.opt("expect"))) as String?
		assertEquals(expect, pairedFingerprint(case.getString("id")))
		// The key the computer presents has that fingerprint, as the rule of fingerprints.json computes it.
		case.text("blob")?.let { assertEquals(expect, fingerprint(Buffer.PlainBuffer(Base64.getDecoder().decode(it)).readPublicKey())) }
	}

	@TestFactory
	fun `the phone's name is its model, cleaned as the Pine app cleans it`() = replay("device-names") { case ->
		assertEquals(android(case.get("expect")), deviceName(case.text("model")))
	}

	@TestFactory
	fun `a paired computer is a machine beside user@host`() = replay("paired-machines") { case ->
		val input = case.text("input")
		val expect = plain(android(case.opt("expect"))) as JSONObject?
		when {
			expect == null -> assertNull(listed(input))
			expect.has("error") -> assertEquals(expect.getString("error"), assertFailsWith<RemoteError> { listed(input) }.kind)
			expect.has("paired") -> assertEquals(Listed.Paired(expect.getString("paired")), listed(input))
			else -> assertEquals(expect.getString("ssh"), (listed(input) as Listed.Ssh).host.given)
		}
	}
}
