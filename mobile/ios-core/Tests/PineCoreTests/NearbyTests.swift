import Foundation
import Testing
@testable import PineCore

// What the phone keeps of a computer that announces itself on the network (Nearby.swift), and the
// list of those found. The same cases as the Kotlin core's NearbyTest.kt.
struct NearbyTests {
	let id = "EKN2VkO6uLv7SOTEAyIGDru_1I_cTOGadqwTlLFm-qs"
	let nonce = "q3b0cJ2-Zk_9xYw1LmNoPA"

	func record(v: String? = "1", id: String? = nil, service: String?? = .some(OFFICIAL_SERVICE), nonce: String?? = nil) -> [String: String?] {
		var out: [String: String?] = [:]
		if let v { out["v"] = .some(v) }
		out["id"] = .some(id ?? self.id)
		if case let .some(service) = service { out["service"] = .some(service) }
		switch nonce {
		case .none: out["nonce"] = .some(self.nonce)
		case let .some(given): out["nonce"] = .some(given)
		}
		return out
	}

	func computer(_ service: String, id: String? = nil, nonce: String? = nil) -> NearbyComputer {
		NearbyComputer(id: id ?? self.id, service: service, nonce: nonce ?? self.nonce)
	}

	@Test("a record of version 1 names a machine id, an https service and a nonce")
	func read() {
		#expect(nearbyComputer(record()) == computer(OFFICIAL_SERVICE))
		#expect(nearbyComputer(record(service: "https://pine-pr-57.drcmda.workers.dev")) == computer("https://pine-pr-57.drcmda.workers.dev"))
		#expect(nearbyComputer(record(service: "https://pine.example.com:8443")) == computer("https://pine.example.com:8443"))
		#expect(nearbyComputer(record(service: OFFICIAL_SERVICE + ":443")) == computer(OFFICIAL_SERVICE), "without :443")
		#expect(nearbyComputer(record(service: "HTTPS://PINE.Example.com")) == computer("https://pine.example.com"), "in lower case")
		#expect(nearbyComputer(["V": "1", "ID": id, "Service": OFFICIAL_SERVICE, "NONCE": nonce]) == computer(OFFICIAL_SERVICE), "keys in any case")
	}

	@Test("a record without a service names the official one")
	func official() {
		#expect(nearbyComputer(record(service: .none)) == computer(OFFICIAL_SERVICE))
	}

	@Test("a record of another version, without a good machine id, or with a service that is not an https origin, is ignored")
	func ignored() {
		#expect(nearbyComputer(record(v: "2")) == nil)
		#expect(nearbyComputer(record(v: nil)) == nil)
		#expect(nearbyComputer(["v": "1", "service": OFFICIAL_SERVICE, "nonce": nonce]) == nil)
		#expect(nearbyComputer(record(id: String(id.dropFirst()))) == nil)
		#expect(nearbyComputer(record(id: String(id.dropLast()) + "+")) == nil)
		for service in ["http://pine.example.com", "", "https://pine.example.com/", "https://pine.example.com/x", "https://me@pine.example.com", "javascript:alert(1)"] {
			#expect(nearbyComputer(record(service: .some(service))) == nil, "service \(service)")
		}
		#expect(nearbyComputer(record(service: .some(nil))) == nil, "a service key without a value")
	}

	@Test("a record without a nonce of the announced shape is ignored")
	func nonces() {
		var none = record()
		none["nonce"] = nil
		#expect(nearbyComputer(none) == nil, "no nonce: a Pine app that lets no codeless request in without one")
		#expect(nearbyComputer(record(nonce: .some(nil))) == nil, "a nonce key without a value")
		for given in ["", String(nonce.dropFirst()), nonce + "A", String(nonce.dropLast()) + "+", String(nonce.dropLast()) + "=", String(nonce.dropLast()) + "\n", nonce + "\n", "nearby.\(nonce)"] {
			#expect(nearbyComputer(record(nonce: .some(given))) == nil, "nonce \(given)")
		}
		#expect(nearbyComputer(record(nonce: "A-_zA-_zA-_zA-_zA-_z09")) == computer(OFFICIAL_SERVICE, nonce: "A-_zA-_zA-_zA-_zA-_z09"))
	}

	@Test("of two records of one computer the official service is kept, else the first found, and the event carries the nonce")
	func preferred() {
		let found = NearbyFound()
		let b = String(repeating: "B", count: 22)
		let c = String(repeating: "C", count: 22)
		#expect(found.found("Pine", computer("https://pine.example.com")))
		#expect(found.found("Pine (2)", computer(OFFICIAL_SERVICE, nonce: b)), "the official service wins")
		#expect(found.list == [computer(OFFICIAL_SERVICE, nonce: b)])
		#expect(!found.found("Pine (3)", computer("https://elsewhere.example.com")), "a later record names no other service")
		#expect(found.list == [computer(OFFICIAL_SERVICE, nonce: b)])
		#expect(found.lost("Pine (2)"))
		#expect(found.list == [computer("https://pine.example.com")], "the first found of the others")
		#expect(found.found("Pine", computer("https://pine.example.com", nonce: c)), "a record published again with a new nonce")
		#expect(found.event["computers"] as? [[String: String]] == [["id": id, "service": "https://pine.example.com", "nonce": c]])
	}

	@Test("the list holds each computer once, follows what is lost, and says when it changed")
	func list() {
		let found = NearbyFound()
		#expect((found.event["computers"] as? [[String: String]])?.isEmpty == true)
		#expect(found.found("Pine", computer(OFFICIAL_SERVICE)))
		#expect(!found.found("Pine", computer(OFFICIAL_SERVICE)), "the same again changes nothing")
		#expect(!found.found("Pine (2)", computer(OFFICIAL_SERVICE)), "the same machine under another name is listed once")
		let other = String(repeating: "A", count: 43)
		#expect(found.found("Pine (3)", computer("https://pine.example.com", id: other)))
		#expect(found.list == [computer(OFFICIAL_SERVICE), computer("https://pine.example.com", id: other)])
		#expect(!found.lost("Pine"), "still there under its other name")
		#expect(found.lost("Pine (2)"))
		#expect(found.found("Pine (3)", nil), "a record it no longer reads takes it out")
		#expect(found.list.isEmpty)
		#expect(!found.lost("never seen"))
	}
}
