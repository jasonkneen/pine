package pine.mobile.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

// Both cores replay every file of mobile/cases (its README): a file added there and replayed by no
// test of this core fails here, and the remote command is the very file the iOS core reads.
class CasesTest {
	/** The subjects this core's tests replay, and the test that replays each. */
	private val replayed = mapOf(
		"hosts" to "HostsTest",
		"loopback" to "HostsTest",
		"links" to "LinksTest",
		"media-paths" to "MediaTest",
		"media-types" to "MediaTest",
		"fingerprints" to "KeysTest",
		"service-lines" to "ServiceTest",
		"failures" to "ServiceTest",
		"pair-links" to "PairedTest",
		"opened-links" to "PairedTest",
		"machine-ids" to "PairedTest",
		"device-names" to "PairedTest",
		"paired-machines" to "PairedTest",
	)

	@Test
	fun `every case file is replayed`() {
		val files = CASES.listFiles { f -> f.name.endsWith(".json") }!!.map { it.name.removeSuffix(".json") }.toSet()
		assertEquals(files, replayed.keys)
	}

	@Test
	fun `the command run on the other machine is the shared file`() {
		assertEquals(File(CASES, "remote-command.txt").readText(), REMOTE_COMMAND)
	}
}
