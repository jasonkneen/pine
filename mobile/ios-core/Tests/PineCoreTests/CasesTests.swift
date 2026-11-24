import Foundation
import Testing
import PineCore

// Both cores replay every file of mobile/cases (its README): a file added there and replayed by no
// test of this core fails here, and the remote command is the very file the Android core reads.
struct CasesTests {
	/** The subjects this core's tests replay, and the suite that replays each. */
	let replayed = [
		"hosts": "HostsTests",
		"loopback": "HostsTests",
		"links": "LinksTests",
		"media-paths": "MediaTests",
		"media-types": "MediaTests",
		"fingerprints": "KeysTests",
		"service-lines": "ServiceTests",
		"failures": "ServiceTests",
		"pair-links": "PairedTests",
		"opened-links": "PairedTests",
		"machine-ids": "PairedTests",
		"device-names": "PairedTests",
		"paired-machines": "PairedTests",
	]

	@Test("every case file is replayed")
	func everyFile() throws {
		let files = try FileManager.default.contentsOfDirectory(atPath: casesDir.path)
			.filter { $0.hasSuffix(".json") }
			.map { String($0.dropLast(".json".count)) }
		#expect(Set(files) == Set(replayed.keys))
	}

	@Test("the command run on the other machine is the shared file")
	func remoteCommand() throws {
		let shared = try String(contentsOf: casesDir.appendingPathComponent("remote-command.txt"), encoding: .utf8)
		#expect(REMOTE_COMMAND == shared)
		#expect(REMOTE_COMMAND.hasPrefix("exec /bin/sh -c "))
	}
}
