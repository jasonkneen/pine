import Foundation
import Testing
@testable import PineCore

// Pairing from a link against the Pine app's real access host (AccessHost.swift), as ticket 05's
// Kotlin tests prove it for Android: the four digits, the owner's answer, and only a yes keeps anything.

/** The https origin the tests' links name; the rig's `Remote` reaches the helper's http meeting service for it. */
let TEST_SERVICE = "https://pine.test"

/** What a pairing reported, as it reported it. */
final class Told: @unchecked Sendable {
	private let lock = NSLock()
	private var _states: [PairingState] = []
	var states: [PairingState] { lock.withLock { _states } }
	func add(_ s: PairingState) { lock.withLock { _states.append(s) } }
	var code: String? {
		for s in states { if case let .pairing(code, _) = s { return code } }
		return nil
	}
}

extension PeerRig {
	/** A pairing opened at the computer, as the phone reads its link (the service said as an https origin). */
	func opened() async throws -> PairLink {
		let link = try #require(try await host.command("open")["link"] as? String)
		#expect(link.hasPrefix(TEST_SERVICE + "/#pair="))
		return try #require(pairLink(link))
	}

	/** The computer as the phone found it on the network, under the https name the test routes to the helper. */
	func found(service: String = TEST_SERVICE, nonce: String? = nil) -> NearbyComputer {
		NearbyComputer(id: host.machineId, service: service, nonce: nonce ?? host.nonce)
	}

	func devices() async throws -> [[String: Any]] {
		try #require(try await host.command("devices")["devices"] as? [[String: Any]])
	}

	/** Pairs and waits for the end. */
	func pair(_ link: PairLink, name: String = "Pine on iPhone 17 Pro") async -> (PairingState?, Told) {
		let told = Told()
		let pairing = remote.pair(link, name: name) { told.add($0) }
		return (await pairing.result(), told)
	}
}

struct PairingTests {
	@Test("pairing shows the computer's four digits, takes the owner's yes, and the computer then knows the phone")
	func allowed() async throws {
		try await withPeer(known: false) { rig in
			let link = try await rig.opened()
			try await rig.host.command("allow")
			let (end, told) = await rig.pair(link)
			#expect(end == .allowed(name: "Test Mac"))
			// The helper's line may come after the phone heard the answer.
			try await eventually("the owner asked") { !rig.host.events("asked").isEmpty }
			let asked = try #require(rig.host.events("asked").first)
			#expect(asked["name"] as? String == "Pine on iPhone 17 Pro")
			#expect(told.states == [.pairing(code: asked["code"] as! String, computer: "Test Mac"), .allowed(name: "Test Mac")])
			let devices = try await rig.devices()
			#expect(devices.count == 1)
			#expect(devices.first?["name"] as? String == "Pine on iPhone 17 Pro")
			#expect(devices.first?["key"] as? String == String(try rig.key.publicKey().split(separator: " ")[1]))
			// Reached as a paired phone, without a second link.
			let s = try await rig.remote.connect(paired: PairedComputer(id: link.id, service: TEST_SERVICE, name: "Test Mac"))
			#expect(s.token == "secret-token")
			await s.stop()
		}
	}

	@Test("a refusal ends the pairing as refused, and nothing is kept")
	func refused() async throws {
		try await withPeer(known: false) { rig in
			let link = try await rig.opened()
			try await rig.host.command("refuse")
			let (end, told) = await rig.pair(link)
			#expect(end == .refused)
			#expect(told.code != nil)
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("no answer in time ends the pairing as expired, and nothing is kept")
	func expired() async throws {
		try await withPeer(known: false, options: ["--answer-ms", "300"]) { rig in
			let link = try await rig.opened()
			let (end, told) = await rig.pair(link)
			#expect(end == .expired)
			#expect(told.code != nil)
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("a wrong code, and a code used already, are expired, and nothing is kept")
	func wrongCode() async throws {
		try await withPeer(known: false) { rig in
			let link = try await rig.opened()
			let wrong = PairLink(service: link.service, id: link.id, code: String(repeating: "A", count: 22))
			let (end, told) = await rig.pair(wrong)
			#expect(end == .expired)
			#expect(told.states == [.expired], "no digits: the computer never asked")
			try await rig.host.command("refuse")
			_ = await rig.pair(link)
			#expect(await rig.pair(link).0 == .expired, "used")
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("an open pairing can be cancelled: nothing more is reported, and no connection is left")
	func cancelled() async throws {
		try await withPeer(known: false) { rig in
			let link = try await rig.opened()
			let told = Told()
			let pairing = rig.remote.pair(link, name: "Pine on a test") { told.add($0) }
			try await eventually("the four digits") { told.code != nil }
			pairing.cancel()
			#expect(await pairing.result() == nil)
			try await eventually("the pairing session left") { rig.host.events("left").contains { ($0["id"] as? String)?.hasPrefix("pairing:") == true } }
			try await rig.host.command("allow")
			try await Task.sleep(for: .milliseconds(300))
			#expect(told.states.count == 1, "\(told.states)")
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("a computer whose key is not the link's machine id is refused before the phone's key is offered")
	func impostor() async throws {
		try await withPeer(known: false) { rig in
			let link = try await rig.opened()
			try await rig.host.command("meeting swap")
			let (end, _) = await rig.pair(link)
			#expect(end == .failed(message: "The computer that answered is not the one this pairing link names: nothing was trusted. Open Pine on your computer and add this device again."))
			#expect(rig.host.events("asked").isEmpty)
		}
	}

	@Test("a computer that is not there ends the pairing in the web client's words")
	func absent() async throws {
		try await withPeer(known: false) { rig in
			let link = PairLink(service: TEST_SERVICE, id: String(repeating: "A", count: 43), code: String(repeating: "B", count: 22))
			let (end, _) = await rig.pair(link)
			#expect(end == .failed(message: "Your computer does not answer: it is off, asleep, or Pine is closed. Open Pine on your computer and add this device again."))
		}
	}

	@Test("a computer found on the network is paired without a code, and its name comes with the four digits")
	func nearby() async throws {
		try await withPeer(known: false) { rig in
			#expect(try await rig.host.command("nearby on")["on"] as? Bool == true)
			try await rig.host.command("allow")
			let told = Told()
			let end = await rig.remote.pairNearby(rig.found(), name: "Pine on iPhone 17 Pro") { told.add($0) }.result()
			#expect(end == .allowed(name: "Test Mac"))
			try await eventually("the owner asked") { !rig.host.events("asked").isEmpty }
			let asked = try #require(rig.host.events("asked").first)
			#expect(asked["kind"] as? String == "nearby", "asked without a code")
			#expect(told.states == [.pairing(code: asked["code"] as! String, computer: "Test Mac"), .allowed(name: "Test Mac")])
			#expect(try await rig.devices().first?["key"] as? String == String(try rig.key.publicKey().split(separator: " ")[1]))
		}
	}

	@Test("a codeless request the computer does not let in fails in words that say so, and the owner never hears of it")
	func nearbyNotLetIn() async throws {
		try await withPeer(known: false) { rig in
			try await rig.host.command("allow")
			let told = Told()
			let end = await rig.remote.pairNearby(rig.found(), name: "Pine on iPhone 17 Pro") { told.add($0) }.result()
			#expect(end == .failed(message: PairWords.notLetIn))
			#expect(told.states == [.failed(message: PairWords.notLetIn)])
			#expect(rig.host.events("asked").isEmpty)
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("a codeless request the owner refuses ends as refused, and a computer whose key is not the announced id is refused")
	func nearbyRefusedAndImpostor() async throws {
		try await withPeer(known: false) { rig in
			try await rig.host.command("nearby on")
			try await rig.host.command("refuse")
			let found = rig.found()
			#expect(await rig.remote.pairNearby(found, name: "Pine on a test") { _ in }.result() == .refused)
			try await rig.host.command("meeting swap")
			#expect(await rig.remote.pairNearby(found, name: "Pine on a test") { _ in }.result() == .failed(message: PairWords.nearbyImpostor))
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("a codeless request with a nonce the computer did not announce, or no longer does, is not let in")
	func nearbyNonce() async throws {
		try await withPeer(known: false) { rig in
			try await rig.host.command("nearby on")
			try await rig.host.command("allow")
			let nonce = rig.host.nonce
			let wrong = (nonce.hasPrefix("A") ? "B" : "A") + nonce.dropFirst()
			let told = Told()
			#expect(await rig.remote.pairNearby(rig.found(nonce: wrong), name: "Pine on a test") { told.add($0) }.result() == .failed(message: PairWords.notLetIn))
			try await rig.host.rotate()
			try await rig.host.rotate()
			#expect(await rig.remote.pairNearby(rig.found(nonce: nonce), name: "Pine on a test") { told.add($0) }.result() == .failed(message: PairWords.notLetIn))
			#expect(told.states == [.failed(message: PairWords.notLetIn), .failed(message: PairWords.notLetIn)])
			#expect(rig.host.events("asked").isEmpty)
			#expect(try await rig.devices().isEmpty)
		}
	}

	@Test("a computer found on the network that names another meeting service than its announcement is not paired with")
	func nearbyOtherService() async throws {
		try await withPeer(known: false) { rig in
			// Another name that reaches the helper, whose pairing channel names TEST_SERVICE.
			rig.routes.set("https://elsewhere.test", rig.host.service)
			try await rig.host.command("nearby on")
			let told = Told()
			let end = await rig.remote.pairNearby(rig.found(service: "https://elsewhere.test"), name: "Pine on a test") { told.add($0) }.result()
			#expect(end == .failed(message: PairWords.nearbyService))
			#expect(told.states == [.failed(message: PairWords.nearbyService)], "the four digits are never shown")
			try await eventually("the session ended at the computer") { !rig.host.events("left").isEmpty }
			try await rig.host.command("allow")
			#expect(try await rig.devices().isEmpty)
		}
	}
}
