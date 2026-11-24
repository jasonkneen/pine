import Foundation
import Testing
@testable import PineCore

/** The plugin's core on a running access host, and its page. */
private func withPairedPines(options: [String] = [], _ body: (PeerRig, Pines, SeenPage) async throws -> Void) async throws {
	try await withPeer(known: false, options: options) { rig in
		let hold = Hold()
		defer { hold.release() }
		rig.daemon[route: "/events/stream"] = { x in
			stream(x, ": connected\n\n")
			await hold.wait(.seconds(30))
		}
		let page = SeenPage()
		let pines = Pines(remote: rig.remote, shelf: MemoryShelf(), page: page, retry: .milliseconds(50))
		do {
			try await body(rig, pines, page)
		} catch {
			await pines.close()
			throw error
		}
		await pines.close()
	}
}

extension PeerRig {
	/** The link of a pairing opened at the computer, as the QR code carries it (its service an https origin). */
	func openedLink() async throws -> String {
		let link = try #require(try await host.command("open")["link"] as? String)
		#expect(link.hasPrefix(TEST_SERVICE + "/#pair="))
		return link
	}

	/** Paired by the owner's yes, through `pines`, and reached: the device's id at the computer. */
	func paired(_ pines: Pines, _ page: SeenPage) async throws -> String {
		let link = try await openedLink()
		try await host.command("allow")
		try pines.pair(link, name: "Pine on iPhone 17 Pro")
		try await eventually("ready") { page.status == "ready" }
		return try #require(host.events("paired").first?["id"] as? String)
	}

	func connections(_ device: String) -> Int {
		host.events("connected").filter { $0["id"] as? String == device }.count
	}
}

// The plugin's core pairs, keeps the computer, and reconnects to it, in the states the page expects
// (ticket 06's contract, the web client's words), as ticket 05 proves it for the Kotlin core.
struct PinesPairingTests {
	@Test("a pairing link is paired with, the computer kept under its name, made the machine in use and reached")
	func paired() async throws {
		try await withPairedPines { rig, pines, page in
			pines.ready()
			let device = try await rig.paired(pines, page)
			let host = "paired:\(rig.host.machineId)"
			let states = page.states
			let pairing = states.compactMap { $0["pairing"] as? [String: String] }
			#expect(pairing.first == ["name": "Pine on iPhone 17 Pro"])
			#expect(pairing.last == ["name": "Pine on iPhone 17 Pro", "code": rig.host.events("asked").first?["code"] as? String ?? "?", "computer": "Test Mac"])
			#expect(states.contains { $0["status"] as? String == "starting" && $0["host"] as? String == host })
			#expect(page.last?["host"] as? String == host)
			#expect(page.last?["label"] as? String == "Test Mac")
			#expect(page.last?["from"] as? String == "paired Test Mac")
			#expect(pines.hosts == [host])
			#expect(pines.inUse == host)
			#expect(pines.names == [host: "Test Mac"])
			#expect(pines.paired(host) == PairedComputer(id: rig.host.machineId, service: TEST_SERVICE, name: "Test Mac"))
			#expect(rig.connections(device) == 1, "reached without a second link")
			#expect(await pines.call(method: "GET", url: "/agents").ok)
		}
	}

	@Test("a link whose service is not https is refused")
	func httpRefused() async throws {
		try await withPairedPines { rig, pines, page in
			let link = rig.host.service + (try await rig.openedLink()).dropFirst(TEST_SERVICE.count)
			#expect(link.hasPrefix("http://"))
			#expect(throws: RemoteError.self) { try pines.pair(link, name: "Pine on a test") }
			#expect(throws: RemoteError.self) { try pines.pair("pine://pair?service=http%3A%2F%2F127.0.0.1&id=\(rig.host.machineId)&code=\(String(repeating: "A", count: 22))", name: "Pine on a test") }
			#expect(page.states.isEmpty)
			#expect(rig.host.events("asked").isEmpty)
		}
	}

	@Test("a refusal and an expired code say so in the web client's words, and keep nothing")
	func refusedAndExpired() async throws {
		try await withPairedPines(options: ["--answer-ms", "300"]) { rig, pines, page in
			try await rig.host.command("refuse")
			try pines.pair(try await rig.openedLink(), name: "Pine on a test")
			try await eventually("refused") { page.status == "error" }
			#expect(page.last?["message"] as? String == "Your computer refused this phone: nothing was kept. To pair it after all, open Pine on your computer and add this device again.")
			#expect(page.last?["host"] == nil)
			let told = page.states.count
			try pines.pair(try await rig.openedLink(), name: "Pine on a test")
			try await eventually("expired") { page.states.count > told + 1 && page.status == "error" }
			#expect(page.last?["message"] as? String == "This pairing link has expired or was used already. Open Pine on your computer and add this device again.")
			#expect(pines.hosts.isEmpty)
			#expect(pines.inUse == nil)
		}
	}

	@Test("an open pairing is the only one, and cancelling it keeps nothing and shows the state from before")
	func cancelled() async throws {
		try await withPairedPines { rig, pines, page in
			pines.ready()
			let before = try #require(page.last?["message"] as? String)
			let link = try await rig.openedLink()
			try pines.pair(link, name: "Pine on a test")
			try await eventually("the four digits") { (page.last?["pairing"] as? [String: String])?["code"] != nil }
			#expect(throws: RemoteError.self) { try pines.pair(link, name: "Pine on a test") }
			pines.cancelPairing()
			#expect(page.last?["message"] as? String == before)
			try await eventually("no connection left") { rig.host.events("left").contains { ($0["id"] as? String)?.hasPrefix("pairing:") == true } }
			try await rig.host.command("allow")
			try await Task.sleep(for: .milliseconds(300))
			#expect(page.last?["message"] as? String == before)
			#expect(pines.hosts.isEmpty)
			pines.cancelPairing()
		}
	}

	@Test("using another machine ends an open pairing: its connection is closed and a new pairing is accepted at once")
	func endedByUse() async throws {
		try await withPairedPines { rig, pines, page in
			pines.ready()
			try pines.pair(try await rig.openedLink(), name: "Pine on a test")
			try await eventually("the four digits") { (page.last?["pairing"] as? [String: String])?["code"] != nil }
			_ = try pines.addHost("me@127.0.0.1:1")
			try pines.use("me@127.0.0.1:1")
			try await eventually("the first pairing's connection closed") { rig.host.events("left").contains { ($0["id"] as? String)?.hasPrefix("pairing:") == true } }
			try pines.pair(try await rig.openedLink(), name: "Pine on a test")
			try await eventually("the second pairing's four digits") { (page.last?["pairing"] as? [String: String])?["code"] != nil }
			pines.cancelPairing()
		}
	}

	@Test("a cut connection is made again by itself; once the computer removed the phone, it stops and says to pair again")
	func reconnectsThenRemoved() async throws {
		try await withPairedPines { rig, pines, page in
			let device = try await rig.paired(pines, page)
			try await rig.host.command("cut \(device)")
			try await eventually("connected again") { rig.connections(device) == 2 }
			try await eventually("up") { page.status == "ready" && pines.connected }

			try await rig.host.command("remove \(device)")
			try await eventually("told to pair again") { page.status == "error" }
			#expect(page.last?["message"] as? String == "This phone is no longer known to Test Mac. Open Pine on Test Mac and add this device again.")
			#expect(page.last?["host"] as? String == "paired:\(rig.host.machineId)")
			let told = page.states.count
			await pines.check()
			try await Task.sleep(for: .milliseconds(500))
			#expect(page.states.count == told, "final: not tried again")
		}
	}

	@Test("a trouble that may pass is tried again with a growing wait until the computer is reached")
	func growingWait() async throws {
		try await withPairedPines { rig, pines, page in
			let device = try await rig.paired(pines, page)
			try await rig.host.command("meeting limits")
			try await rig.host.command("cut \(device)")
			try await eventually("the limits said") { page.status == "error" }
			#expect(page.last?["message"] as? String == "The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile.")
			try await rig.host.command("meeting normal")
			try await eventually("reached again without the owner") { page.status == "ready" }
			#expect(rig.connections(device) == 2)
		}
	}

	@Test("a computer that shows another key is refused for good")
	func changedKey() async throws {
		try await withPairedPines { rig, pines, page in
			let device = try await rig.paired(pines, page)
			let other = try #require(try await rig.host.command("meeting swap")["impostor"] as? String)
			try await rig.host.command("cut \(device)")
			try await eventually("refused") { page.status == "error" }
			#expect(page.last?["changed"] as? Bool == true)
			#expect(page.last?["fingerprint"] as? String == pairedFingerprint(other))
			try await rig.host.command("meeting normal")
			await pines.check()
			try await Task.sleep(for: .milliseconds(500))
			#expect(page.status == "error", "never tried again")
			#expect(rig.connections(device) == 1)
		}
	}

	@Test("the check on return to the front connects a paired computer again when it no longer answers")
	func checkOnReturn() async throws {
		try await withPairedPines { rig, pines, page in
			let device = try await rig.paired(pines, page)
			await pines.check()
			#expect(rig.connections(device) == 1, "one that answers is kept")
			rig.daemon[route: "/health"] = { x in x.head(503, length: -1) }
			await pines.check()
			// Made again whole; a first attempt that a loaded machine lets go of is tried again by itself.
			try await eventually("ready again") { page.status == "ready" }
			#expect(rig.connections(device) >= 2)
		}
	}

	@Test("a computer found on the network is paired without a code: its name comes with the digits, and a yes keeps it")
	func nearby() async throws {
		try await withPairedPines { rig, pines, page in
			pines.ready()
			try await rig.host.command("nearby on")
			try pines.pairNearby(id: rig.host.machineId, service: TEST_SERVICE, nonce: rig.host.nonce, name: "Pine on iPhone 17 Pro")
			try await eventually("the four digits") { (page.last?["pairing"] as? [String: String])?["code"] != nil }
			let code = try #require(rig.host.events("asked").first?["code"] as? String)
			#expect(page.last?["pairing"] as? [String: String] == ["name": "Pine on iPhone 17 Pro", "code": code, "computer": "Test Mac"])
			try await rig.host.command("allow")
			try await eventually("ready") { page.status == "ready" }
			let host = "paired:\(rig.host.machineId)"
			#expect(page.last?["host"] as? String == host)
			#expect(pines.inUse == host)
			#expect(pines.paired(host) == PairedComputer(id: rig.host.machineId, service: TEST_SERVICE, name: "Test Mac"))
		}
	}

	@Test("a codeless request the computer does not let in is told to the page; an id, a service or a nonce of another shape is refused")
	func nearbyRefused() async throws {
		try await withPairedPines { rig, pines, page in
			let nonce = rig.host.nonce
			#expect(throws: RemoteError.self) { try pines.pairNearby(id: "nope", service: TEST_SERVICE, nonce: nonce, name: "Pine on a test") }
			#expect(throws: RemoteError.self) { try pines.pairNearby(id: rig.host.machineId, service: "http://pine.test", nonce: nonce, name: "Pine on a test") }
			#expect(throws: RemoteError.self) { try pines.pairNearby(id: rig.host.machineId, service: TEST_SERVICE + "/", nonce: nonce, name: "Pine on a test") }
			#expect(throws: RemoteError.self) { try pines.pairNearby(id: rig.host.machineId, service: TEST_SERVICE, nonce: "short", name: "Pine on a test") }
			#expect(page.states.isEmpty)
			try pines.pairNearby(id: rig.host.machineId, service: TEST_SERVICE, nonce: nonce, name: "Pine on a test")
			try await eventually("not let in") { page.status == "error" }
			#expect(page.last?["message"] as? String == PairWords.notLetIn)
			#expect(page.last?["host"] == nil)
			#expect(pines.hosts.isEmpty)
		}
	}
}
