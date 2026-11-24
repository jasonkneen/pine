import Foundation
import Testing
import PineCore

// A computer paired by its link: web/src/pairing.ts and desktop/electron/access/store.ts, on the
// phone. The cases are mobile/cases/pair-links.json, opened-links.json, machine-ids.json,
// device-names.json and paired-machines.json.
struct PairedTests {
	@Test("a pairing link is read in either form, and only with an https service", arguments: try cases("pair-links"))
	func link(_ c: Case) {
		let read = pairLink(c.text("input"))
		guard let e = c.expect as? [String: Any] else { return #expect(read == nil) }
		// `host` and `official` of the case are the page's to read (desktop/src/machines.ts); the phone needs neither.
		#expect(read == PairLink(service: e["service"] as! String, id: e["id"] as! String, code: e["code"] as! String))
	}

	@Test("an address the app is opened with reaches the page only as a pairing link comes", arguments: try cases("opened-links"))
	func opened(_ c: Case) {
		let input = c.text("input")
		#expect(openedLink(input) == (c.expect as! Bool ? input : nil))
	}

	@Test("a machine id is the fingerprint of the computer's host key", arguments: try cases("machine-ids"))
	func machineId(_ c: Case) {
		let expect = c.expect as! String?
		#expect(pairedFingerprint(c.text("id")!) == expect)
		// The key the computer presents has that fingerprint, as the rule of fingerprints.json computes it.
		if let blob = c.text("blob") { #expect(fingerprint(blob: Data(base64Encoded: blob)!) == expect) }
	}

	@Test("the phone's name is its model, cleaned as the Pine app cleans it", arguments: try cases("device-names"))
	func device(_ c: Case) {
		#expect(deviceName(c.text("model")) == c.expect as! String)
	}

	@Test("a paired computer is a machine beside user@host", arguments: try cases("paired-machines"))
	func machine(_ c: Case) throws {
		let input = c.text("input")
		switch c.expect {
		case nil:
			#expect(try listed(input) == nil)
		case let e as [String: Any] where e["error"] != nil:
			do {
				_ = try listed(input)
				Issue.record("\(input ?? "nil") was taken")
			} catch let error as RemoteError {
				#expect(error.kind == e["error"] as! String)
			}
		case let e as [String: Any] where e["paired"] != nil:
			#expect(try listed(input) == .paired(id: e["paired"] as! String))
		case let e as [String: Any]:
			guard case let .ssh(host)? = try listed(input) else {
				Issue.record("not a user@host machine")
				return
			}
			#expect(host.given == e["ssh"] as? String)
		default:
			Issue.record("paired-machines.json: an expectation that is not null or an object")
		}
	}
}
