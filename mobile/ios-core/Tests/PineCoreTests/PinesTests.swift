import Foundation
import Testing
@testable import PineCore

/** A shelf in memory, as the app's UserDefaults are. */
final class MemoryShelf: Shelf, @unchecked Sendable {
	private let lock = NSLock()
	private var entries: [String: String] = [:]
	func get(_ name: String) -> String? { lock.withLock { entries[name] } }
	func set(_ name: String, _ value: String?) { lock.withLock { entries[name] = value } }
}

/** What the page is told, as it is told it. */
final class SeenPage: Page, @unchecked Sendable {
	private let lock = NSLock()
	private var _states: [[String: Any]] = []
	private var _batches: [[Any]] = []
	private var _ups: [Bool] = []

	var states: [[String: Any]] { lock.withLock { _states } }
	var batches: [[Any]] { lock.withLock { _batches } }
	var ups: [Bool] { lock.withLock { _ups } }
	var last: [String: Any]? { states.last }
	var status: String? { last?["status"] as? String }

	func service(_ state: [String: Any]) { lock.withLock { _states.append(state) } }
	func events(_ batch: [Any]) { lock.withLock { _batches.append(batch) } }
	func connection(_ up: Bool) { lock.withLock { _ups.append(up) } }
}

/** A rig with the plugin's core on it: the page it tells, and the shelf it keeps the machines on. */
private func withPines(_ body: (Rig, Pines, SeenPage, MemoryShelf) async throws -> Void) async throws {
	try await withRig { rig in
		let shelf = MemoryShelf()
		let page = SeenPage()
		let pines = Pines(remote: rig.remote, shelf: shelf, page: page, retry: .milliseconds(20))
		rig.atEnd { await pines.close() }
		try await body(rig, pines, page, shelf)
	}
}

// The native plugin's part that has no iOS in it, as PinesTest.kt proves it for Android: the
// machines, the one in use, its connection and what the page is told about it.
struct PinesTests {
	@Test("machines are added as ssh would take them, with a user, at most twenty, and kept")
	func hosts() async throws {
		try await withPines { rig, pines, _, shelf in
			#expect(try pines.addHost(" me@server ") == ["me@server"])
			#expect(try pines.addHost("me@other:2222") == ["me@server", "me@other:2222"])
			#expect(try pines.addHost("me@server") == ["me@server", "me@other:2222"], "once")
			#expect(throws: RemoteError.self) { try pines.addHost("-oProxyCommand=evil") }
			#expect(throws: RemoteError.self) { try pines.addHost("server") }
			for n in 3...20 { try pines.addHost("me@host\(n)") }
			#expect(throws: RemoteError.self) { try pines.addHost("me@one-too-many") }
			#expect(Pines(remote: rig.remote, shelf: shelf, page: SeenPage()).hosts.count == 20, "kept on the shelf")
		}
	}

	@Test("the page's preferences and the phone's key are kept as they were given")
	func prefsAndKey() async throws {
		try await withPines { rig, pines, _, shelf in
			#expect(pines.prefs == nil)
			pines.prefs = #"{"theme":"dark"}"#
			#expect(Pines(remote: rig.remote, shelf: shelf, page: SeenPage()).prefs == #"{"theme":"dark"}"#)
			let line = try rig.key.publicKey()
			#expect(try pines.publicKey() == line)
		}
	}

	@Test("with no machine the page is told to add one, and a machine not yet known asks the owner for its host key")
	func firstMachine() async throws {
		try await withPines { rig, pines, page, shelf in
			pines.ready()
			#expect(page.status == "error")
			// Both ways to a pine: pairing with a computer by its link, and user@host over SSH.
			let none = page.last?["message"] as? String ?? ""
			#expect(none.contains("Pair this phone with your computer"), "\(none)")
			#expect(none.contains("user@host"), "\(none)")
			#expect(page.last?["host"] == nil)
			try rig.known.forget(host: "127.0.0.1", port: rig.machine.port)
			try pines.addHost(rig.host)
			try pines.use(rig.host)
			#expect(page.states.contains { $0["status"] as? String == "starting" })
			try await eventually("the host key put to the owner") { page.status == "error" && page.last?["fingerprint"] != nil }
			let asked = try #require(page.last)
			#expect(asked["host"] as? String == rig.host)
			#expect(asked["fingerprint"] as? String == rig.machine.fingerprint)
			#expect(asked["changed"] as? Bool == false)
			#expect((asked["message"] as? String)?.contains(rig.machine.fingerprint) == true)
			#expect(rig.machine.commands == 0, "nothing runs on a machine whose key is not trusted")
			#expect(throws: RemoteError.self) { try pines.trust(host: rig.host, fingerprint: "SHA256:" + String(repeating: "A", count: 43)) }
			try pines.trust(host: rig.host, fingerprint: rig.machine.fingerprint)
			try await eventually("connected") { page.status == "ready" }
			#expect(page.last?["host"] as? String == rig.host)
			#expect(page.last?["mode"] as? String == "on 127.0.0.1")
			#expect(page.last?["home"] as? String == "127.0.0.1:/home/me/.pine")
			#expect(page.last?["version"] as? String == "0.40.0")
			#expect(try rig.known.fingerprintOf(host: "127.0.0.1", port: rig.machine.port) == rig.machine.fingerprint)
			#expect(Pines(remote: rig.remote, shelf: shelf, page: SeenPage()).inUse == rig.host, "kept as the one in use")
		}
	}

	@Test("calls and media go to the pine in use with its token, and nothing before it is reached")
	func calls() async throws {
		try await withPines { rig, pines, page, _ in
			#expect(await pines.call(method: "GET", url: "/agents").status == 503)
			try pines.addHost(rig.host)
			try pines.use(rig.host)
			try await eventually("connected") { page.status == "ready" }
			let r = await pines.call(method: "POST", url: "/agents", body: ["a": 1])
			#expect(r.status == 200)
			let seen = try #require(rig.daemon.seen.last)
			#expect(seen.header("authorization") == "Bearer secret-token")
			#expect(seen.header("origin") == nil)
			#expect(await pines.media(method: "GET", path: "/agents", search: "").status == 404, "only what the media list names")
		}
	}

	@Test("a changed host key is refused, cannot be trusted, and the machine can then be forgotten with its key")
	func changedKey() async throws {
		try await withPines { rig, pines, page, _ in
			try pines.addHost(rig.host)
			try pines.use(rig.host)
			try await eventually("connected") { page.status == "ready" }
			#expect(throws: RemoteError.self) { try pines.forgetHost(rig.host) }
			// The machine is another one now: the held session no longer answers, and a new one meets another key.
			rig.daemon[route: "/health"] = { x in x.head(503, length: -1) }
			try await rig.machine.newHostKey()
			pines.retry()
			try await eventually("refused") { page.status == "error" }
			#expect(page.last?["changed"] as? Bool == true)
			#expect(throws: RemoteError.self) { try pines.trust(host: rig.host, fingerprint: rig.machine.fingerprint) }
			try pines.forgetKey(rig.host)
			#expect(try pines.forgetHost(rig.host) == [])
			#expect(try rig.known.fingerprintOf(host: "127.0.0.1", port: rig.machine.port) == nil)
			#expect(pines.inUse == nil)
			#expect(page.last?["host"] == nil)
		}
	}

	@Test("only the machine in use speaks to the page, and a check after a pause connects again when it no longer answers")
	func checkAfterPause() async throws {
		try await withPines { rig, pines, page, _ in
			let hold = Hold()
			defer { hold.release() }
			rig.daemon[route: "/events/stream"] = { x in
				stream(x, "data: {\"topic\":\"a/b\"}\n\n")
				await hold.wait(.seconds(3))
			}
			rig.daemon[route: "/health"] = { x in x.head(200, length: -1) }
			try pines.addHost(rig.host)
			try pines.use(rig.host)
			try await eventually("an event") { !page.batches.isEmpty }
			try await eventually("up") { pines.connected }
			await pines.check()
			#expect(rig.machine.commands == 1, "a pine that answers is kept")
			rig.daemon[route: "/health"] = { x in x.head(503, length: -1) }
			await pines.check()
			#expect(page.status == "ready")
			#expect(rig.machine.commands == 2, "connected again")
		}
	}

	@Test("a check after a pause tries again a machine that could not be reached, but not one whose host key waits for the owner")
	func checkUnreached() async throws {
		try await withPines { rig, pines, page, _ in
			rig.machine.behaviour = "echo 'Welcome to the server!'\n"
			try pines.addHost(rig.host)
			try pines.use(rig.host)
			try await eventually("not reached") { page.status == "error" }
			rig.machine.behaviour = Machine.service(Rig.line(rig.daemon.base))
			await pines.check()
			#expect(page.status == "ready")

			// Another machine, whose key this phone does not know.
			let other = try await Machine(authorized: try rig.key.publicKey(), behaviour: Machine.service(Rig.line(rig.daemon.base)))
			defer { other.close() }
			let host = "\(other.user)@127.0.0.1:\(other.port)"
			try pines.addHost(host)
			try pines.use(host)
			try await eventually("the host key put to the owner") { page.status == "error" && page.last?["fingerprint"] != nil }
			let told = page.states.count
			await pines.check()
			#expect(page.states.count == told, "it waits for the owner's yes")
			#expect(other.commands == 0)
		}
	}

	@Test("switching back to a machine whose events already flow tells the page it is connected")
	func switching() async throws {
		try await withPines { rig, pines, page, _ in
			let hold = Hold()
			defer { hold.release() }
			streams(rig, hold)
			let other = try await Machine(authorized: try rig.key.publicKey(), behaviour: Machine.service(Rig.line(rig.daemon.base)))
			defer { other.close() }
			try rig.known.confirm(host: "127.0.0.1", port: other.port, fingerprint: other.fingerprint)
			let second = "\(other.user)@127.0.0.1:\(other.port)"
			try pines.addHost(rig.host)
			try pines.addHost(second)
			try pines.use(rig.host)
			try await eventually("the first up") { pines.connected }
			try pines.use(second)
			try await eventually("the second up") { page.status == "ready" && page.last?["host"] as? String == second && pines.connected }
			try pines.use(rig.host)
			try await eventually("the first shown again") { page.status == "ready" && page.last?["host"] as? String == rig.host }
			#expect(pines.connected)
			#expect(page.ups.last == true)
			await pines.close()
		}
	}
}

// A computer paired by its link in the list, beside the user@host machines: PinesTest.kt's cases of it.
struct PairedPinesTests {
	let id = "EKN2VkO6uLv7SOTEAyIGDru_1I_cTOGadqwTlLFm-qs"
	var computer: String { "paired:\(id)" }

	@Test("a paired computer is listed beside user@host machines, with its service and its name, and kept")
	func listed() async throws {
		try await withPines { rig, pines, _, shelf in
			try pines.addHost("me@server")
			#expect(try pines.addPaired(id: id, service: "https://pine.example.com:8443", name: "Studio\u{7} Mac") == ["me@server", computer])
			#expect(pines.paired(computer) == PairedComputer(id: id, service: "https://pine.example.com:8443", name: "Studio Mac"))
			#expect(pines.names == [computer: "Studio Mac"], "the name the page shows, cleaned")
			#expect(pines.paired("me@server") == nil)
			// Paired again: one entry, the service and the name it gave this time.
			#expect(try pines.addPaired(id: id, service: TEST_SERVICE, name: "") == ["me@server", computer])
			#expect(pines.paired(computer) == PairedComputer(id: id, service: TEST_SERVICE, name: nil))
			#expect(pines.names.isEmpty, "no name given: the page says \"your computer\"")
			let again = Pines(remote: rig.remote, shelf: shelf, page: SeenPage())
			#expect(again.hosts == ["me@server", computer], "kept on the shelf")
			#expect(again.paired(computer) == PairedComputer(id: id, service: TEST_SERVICE, name: nil))
		}
	}

	@Test("a paired computer comes only from a pairing, with a machine id and an https service")
	func onlyFromPairing() async throws {
		try await withPines { _, pines, _, shelf in
			#expect(throws: RemoteError.self) { try pines.addHost(computer) }
			#expect(throws: RemoteError.self) { try pines.addHost("paired:22") }
			#expect(throws: RemoteError.self) { try pines.addPaired(id: id, service: "http://pine.example.com", name: nil) }
			#expect(throws: RemoteError.self) { try pines.addPaired(id: id, service: "https://pine.example.com/x", name: nil) }
			#expect(throws: RemoteError.self) { try pines.addPaired(id: String(id.dropFirst()), service: TEST_SERVICE, name: nil) }
			#expect(pines.hosts.isEmpty)
			#expect(shelf.get("paired") == nil)
		}
	}

	@Test("paired computers count among the twenty machines")
	func twenty() async throws {
		try await withPines { _, pines, _, _ in
			for n in 1...19 { try pines.addHost("me@host\(n)") }
			try pines.addPaired(id: id, service: TEST_SERVICE, name: nil)
			#expect(throws: RemoteError.self) { try pines.addPaired(id: "B5IL6HvjP-x66mzgtrtt447XrwHKB2n5qq7O5jRB8oE", service: TEST_SERVICE, name: nil) }
			#expect(throws: RemoteError.self) { try pines.addHost("me@one-too-many") }
			#expect(pines.hosts.count == 20)
		}
	}

	@Test("a paired computer is selected and forgotten like any machine, and forgetting it forgets its service")
	func selectedAndForgotten() async throws {
		try await withPines { _, pines, page, _ in
			try pines.addHost("me@server")
			try pines.addPaired(id: id, service: TEST_SERVICE, name: "Studio")
			try pines.use(computer)
			#expect(pines.inUse == computer)
			// Nothing reaches a paired computer yet: the page is told so, and the machine can go.
			try await eventually("not reached") { page.status == "error" && page.last?["host"] as? String == computer }
			try pines.forgetKey(computer)
			#expect(try pines.forgetHost(computer) == ["me@server"])
			#expect(pines.paired(computer) == nil)
			#expect(pines.inUse == nil)
			#expect(pines.names.isEmpty)
		}
	}

	@Test("a list stored before paired computers existed still loads")
	func oldList() async throws {
		try await withPines { rig, _, _, shelf in
			shelf.set("hosts", #"["me@server","you@other:2222"]"#)
			shelf.set("use", "you@other:2222")
			let old = Pines(remote: rig.remote, shelf: shelf, page: SeenPage())
			#expect(old.hosts == ["me@server", "you@other:2222"])
			#expect(old.inUse == "you@other:2222")
			#expect(old.names.isEmpty)
			let added = try old.addPaired(id: id, service: TEST_SERVICE, name: nil)
			#expect(added == ["me@server", "you@other:2222", computer])
		}
	}
}
