// The native plugin without iOS: the machines the owner added, the one in use, its connection and
// what the page is told about it, as Pines.kt on Android. It is what desktop/electron/main.ts does
// for the desktop page (`startService`, `use`, `pine:hosts-add`, `pine:hosts-forget`, `follow`),
// with one thing more: a host key the phone does not know yet is put to the owner in the page, and
// trusted on their yes.
import Foundation

/** Where the plugin keeps what is not secret (the app's UserDefaults): text by name, nil to remove. */
public protocol Shelf: Sendable {
	func get(_ name: String) -> String?
	func set(_ name: String, _ value: String?)
}

/** What the page is told: the desktop's `pine:service`, `pine:events` and `pine:connection`. Called from tasks of the core, never from the main thread. */
public protocol Page: Sendable {
	func service(_ state: [String: Any])
	func events(_ batch: [Any])
	func connection(_ up: Bool)
}

/** How many machines the list holds at most, as on the desktop. */
public let MAX_HOSTS = 20

/**
 * The pines of the owner's machines, one shown at a time: the whole of what the Capacitor plugin
 * asks of the core (ticket 06). Each machine used is held (`HeldRemote`) until it is forgotten or
 * the app ends, so that switching back is quick and an agent at work on one goes on; only the one
 * in use speaks to the page.
 *
 * The plugin's methods map one to one: `state`, `ready`, `retry`, `call`, `use`, `addHost`,
 * `forgetHost`, `prefs`, `publicKey`, `trust` (trustHostKey), `forgetKey` (forgetHostKey), `check`
 * on the app's return to the front, and `media` for the `pine-media:` scheme handler. What the
 * page is told comes through `Page`. The methods that throw throw a `RemoteError` whose `message`
 * is for the owner (or a `SecretStoreError` from the Keychain); the async ones are called from a
 * `Task` of the plugin. Everything here may be called from any thread.
 */
public final class Pines: @unchecked Sendable {
	private let remote: Remote
	private let known: KnownHosts
	private let shelf: Shelf
	private let page: Page
	private let retryEvery: Duration
	private let batch: Duration
	// Reentrant, as Kotlin's `synchronized`: the page is told under it, and a page that asks for the state as it is told stays safe.
	private let lock = NSRecursiveLock()
	private var held: [String: HeldRemote] = [:]
	/** Host keys seen and not known yet, by machine: what the owner's yes may trust. */
	private var unknown: [String: HostKeyRefusal] = [:]
	private var current: [String: Any] = ["status": "starting"]
	/** Which connection is the latest asked for: an older one that ends late changes nothing. */
	private var round = 0
	private var shown: String?
	private var begun = false
	private var closed = false
	/** Whether each held machine's event stream is up, by machine: what the page is told when it is shown again. */
	private var streams: [String: Bool] = [:]
	private var up = false
	/** The pairing under way, if any: only one at a time. */
	private var pairingNow: Pairing?
	/** Paired computers whose last trouble only the owner can fix: neither tried again nor checked on return. */
	private var finals: Set<String> = []

	public init(remote: Remote, shelf: Shelf, page: Page, retry: Duration = .seconds(1), batch: Duration = .milliseconds(24)) {
		self.remote = remote
		self.known = remote.known
		self.shelf = shelf
		self.page = page
		self.retryEvery = retry
		self.batch = batch
	}

	/** Whether the event stream of the machine in use is up. */
	public var connected: Bool { lock.withLock { up } }

	/** The machines, as the owner added them. */
	public var hosts: [String] {
		guard let text = shelf.get(Self.HOSTS), let list = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any] else { return [] }
		return list.compactMap { $0 as? String }
	}

	/** The machine in use: one of the list, or none. */
	public var inUse: String? { shelf.get(Self.USE).flatMap { hosts.contains($0) ? $0 : nil } }

	/** The page's own preferences, as the page gave them (JSON text): the core reads nothing in them. */
	public var prefs: String? {
		get { shelf.get(Self.PREFS) }
		set { shelf.set(Self.PREFS, newValue) }
	}

	/** This phone's public key, as a line for ~/.ssh/authorized_keys. */
	public func publicKey() throws -> String { try remote.key.publicKey() }

	/** The state as the page was last told it. */
	public func state() -> [String: Any] { lock.withLock { current } }

	/** The page has started: it is told the state, and on the first time the machine in use is connected to. */
	public func ready() {
		let first = lock.withLock {
			defer { begun = true }
			return !begun
		}
		if first && lock.withLock({ pairingNow == nil }) { start(inUse) } else { page.service(state()) }
	}

	/** Add a machine: host, user@host or user@host:port, with a user, since a phone has no user name of its own. */
	@discardableResult
	public func addHost(_ value: String) throws -> [String] {
		guard let named = try sshHost(value) else { throw RemoteError("ssh", "Write the machine as you would after ssh: user@host, or user@host:port.") }
		if named.user == nil { throw RemoteError("ssh", "Name the user too: user@\(named.given). A phone has no user name of its own to sign in with.") }
		return try lock.withLock {
			let list = hosts
			if list.contains(named.given) { return list }
			if list.count >= MAX_HOSTS { throw RemoteError("ssh", "There are \(MAX_HOSTS) machines in the list already: forget one first.") }
			let next = list + [named.given]
			shelf.set(Self.HOSTS, Self.text(next))
			return next
		}
	}

	/**
	 * Add a computer the phone was paired with by its link, as `paired:<machine id>`, with the
	 * meeting service it is reached through and the name it gave (cleaned; none kept when empty).
	 * Paired again, it keeps its place and takes the new service and name.
	 */
	@discardableResult
	public func addPaired(id: String, service: String, name: String?) throws -> [String] {
		if pairedFingerprint(id) == nil { throw RemoteError("ssh", "That is not a computer's machine id: pair it again from the Pine app.") }
		if httpsOrigin(service)?.origin != service { throw RemoteError("ssh", "The meeting service of a paired computer is an https address: pair it again from the Pine app.") }
		let host = PAIRED + id
		return try lock.withLock {
			let list = hosts
			if !list.contains(host) && list.count >= MAX_HOSTS { throw RemoteError("ssh", "There are \(MAX_HOSTS) machines in the list already: forget one first.") }
			var entry = ["service": service]
			let cleaned = cleanName(name ?? "")
			if !cleaned.isEmpty { entry["name"] = cleaned }
			var entries = pairedEntries()
			entries[host] = entry
			shelf.set(Self.PAIRED_ENTRIES, Self.text(entries))
			let next = list.contains(host) ? list : list + [host]
			shelf.set(Self.HOSTS, Self.text(next))
			return next
		}
	}

	/** What is kept beside a paired computer of the list; nil for any other machine. */
	public func paired(_ host: String) -> PairedComputer? {
		guard case let .paired(id)? = try? listed(host), hosts.contains(host), let entry = pairedEntries()[host] as? [String: Any],
			let service = entry["service"] as? String, httpsOrigin(service)?.origin == service else { return nil }
		let name = (entry["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return PairedComputer(id: id, service: service, name: name)
	}

	/** The names the owner sees for machines, by machine: those paired computers gave (`Prefs.names` of the page). */
	public var names: [String: String] {
		var out: [String: String] = [:]
		for host in hosts { if let name = paired(host)?.name { out[host] = name } }
		return out
	}

	private func pairedEntries() -> [String: Any] {
		guard let text = shelf.get(Self.PAIRED_ENTRIES), let entries = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return [:] }
		return entries
	}

	/**
	 * Take a machine out of the list and let go of its connection (a pine it started there stops).
	 * The one in use is refused while it is reached or being reached; one that could not be reached
	 * may go (its host key changed, say), and then no machine is in use.
	 */
	@discardableResult
	public func forgetHost(_ host: String) throws -> [String] {
		let (stop, wasInUse) = try lock.withLock { () throws -> (HeldRemote?, Bool) in
			let wasInUse = host == inUse
			if wasInUse && current["status"] as? String != "error" { throw RemoteError("ssh", "The app uses this machine now. Use another one first.") }
			if wasInUse { shelf.set(Self.USE, nil) }
			shelf.set(Self.HOSTS, Self.text(hosts.filter { $0 != host }))
			// Only the phone's entry: the computer keeps this phone until Remove in the Pine app.
			var entries = pairedEntries()
			if entries.removeValue(forKey: host) != nil { shelf.set(Self.PAIRED_ENTRIES, Self.text(entries)) }
			unknown[host] = nil
			streams[host] = nil
			finals.remove(host)
			return (held.removeValue(forKey: host), wasInUse)
		}
		if let stop { Task.detached { await stop.stop() } }
		if wasInUse { start(nil) }
		return hosts
	}

	/** Use the pine of a machine of the list: it is kept as the one in use, and connected to. */
	public func use(_ host: String) throws {
		guard hosts.contains(host) else { throw RemoteError("ssh", "That machine is not in the list: add it first.") }
		shelf.set(Self.USE, host)
		start(host)
	}

	/** Connect again to the machine in use. */
	public func retry() { start(inUse) }

	/**
	 * The owner's yes to the host key a connection stopped at: only the one the machine showed, never
	 * a key that changed. The machine in use is then connected to again.
	 */
	public func trust(host: String, fingerprint: String) throws {
		try lock.withLock {
			guard let seen = unknown[host] else { throw RemoteError("ssh", "No host key of \(host) waits for your yes: try again to connect.") }
			if seen.fingerprint != fingerprint { throw RemoteError("ssh", "That is not the key \(host) showed: try again to connect.") }
			try known.confirm(host: seen.host, port: seen.port, fingerprint: seen.fingerprint)
			unknown[host] = nil
		}
		if host == inUse { start(host) }
	}

	/** Forget the host key stored for a machine: the next connection shows its key again. */
	public func forgetKey(_ host: String) throws {
		// A paired computer's key is its machine id: there is nothing to forget but the machine.
		guard case let .ssh(named)? = try? listed(host) else { return }
		try known.forget(host: named.host, port: named.port)
		lock.withLock { unknown[host] = nil }
	}

	/** One call of the control API to the pine in use (503 before there is one). */
	public func call(method: String, url: String, body: Any? = nil) async -> CallResult {
		await callDaemon(daemon(), method: method, url: url, body: body)
	}

	/** A picture, video or sound of the pine in use, under `mediaFromDaemon`'s rules; `range` is the page's `Range` header. */
	public func media(method: String, path: String, search: String, range: String? = nil) async -> MediaAnswer {
		await mediaFromDaemon(daemon(), method: method, path: path, search: search, range: range)
	}

	private func daemon() -> RemoteService? {
		lock.withLock {
			guard current["status"] as? String == "ready", let shown else { return nil }
			return held[shown]?.service
		}
	}

	/**
	 * The app came back to the front: the pine in use is asked whether it still answers (iOS may have
	 * cut the link meanwhile), and connected to again when it does not. A machine that could not be
	 * reached is tried again, except when its host key waits for the owner's yes. Returns when that is known.
	 */
	public func check() async {
		let found = lock.withLock { () -> (String, Int, RemoteService?)? in
			guard let host = shown else { return nil }
			let status = current["status"] as? String
			let kind = current["kind"] as? String ?? ""
			let again = status == "error" && host == inUse && ["ssh", "failed"].contains(kind) && current["fingerprint"] == nil && !finals.contains(host)
			if status != "ready" && !again { return nil }
			return (host, round, status == "ready" ? held[host]?.service : nil)
		}
		guard let (host, mine, service) = found else { return }
		if let service, service.isOpen, await answers(service) { return }
		let again = lock.withLock { () -> Int? in
			if mine != round { return nil }
			round += 1
			return round
		}
		guard let again else { return }
		show(again, Self.starting(host), host)
		await connect(host, again)
	}

	private func start(_ host: String?) {
		let (mine, open) = lock.withLock { () -> (Int, Pairing?) in
			round += 1
			defer { pairingNow = nil }
			return (round, pairingNow)
		}
		// Whatever is started now ends a pairing under way, which keeps nothing.
		open?.cancel()
		guard let host else { return show(mine, nobody(), nil) }
		show(mine, Self.starting(host), host)
		Task.detached { await self.connect(host, mine) }
	}

	/** `tries`: attempts in a row that failed for a trouble that may pass, before this one. */
	private func connect(_ host: String, _ mine: Int, tries: Int = 0) async {
		let h = lock.withLock { () -> HeldRemote? in
			if closed { return nil }
			if let h = held[host] { return h }
			let h = HeldRemote(remote: remote, host: host, on: Follow(self, host), failed: { [weak self] e in self?.lost(host, e) }, retry: retryEvery, batch: batch, paired: { [weak self] in self?.paired(host) })
			held[host] = h
			return h
		}
		guard let h else { return }
		do {
			let s = try await h.ensure()
			lock.withLock { _ = finals.remove(host) }
			show(mine, Self.ready(s), host)
		} catch {
			fault(host, mine, error, tries: tries)
		}
	}

	/**
	 * The page is told what went wrong. A paired computer is tried again after a trouble that may
	 * pass (it sleeps, the network, the meeting service's limits), with a wait that doubles from
	 * `retry` up to thirty times it, until it is reached, the owner does something else, or a trouble
	 * only the owner can fix comes (the computer no longer knows the phone, another key): that one
	 * is final. A user@host machine waits for the owner or the app's return to the front, as before.
	 */
	private func fault(_ host: String, _ mine: Int, _ e: Error, tries: Int) {
		show(mine, failure(host, e), host)
		guard host.hasPrefix(PAIRED) else { return }
		let passing = (e as? RemoteError)?.passing == true
		lock.withLock {
			if passing { finals.remove(host) } else { finals.insert(host) }
		}
		guard passing else { return }
		let wait = min(retryEvery * (1 << min(tries, 5)), retryEvery * 30)
		Task.detached { [weak self] in
			try? await Task.sleep(for: wait)
			guard let self, self.lock.withLock({ mine == self.round && !self.closed && self.shown == host }) else { return }
			await self.connect(host, mine, tries: tries + 1)
		}
	}

	/**
	 * Pairs with the computer a pairing link names (either form `pairLink` reads: an https service
	 * only), as the phone called `name` ("Pine on iPhone 17 Pro"). Only one pairing at a time. The
	 * page is told, in the web client's words (web/src/host.ts `pairWith`): `starting` with
	 * `pairing: {name}`, then `pairing: {code, name}` once the computer shows the four digits; on the
	 * owner's yes the computer is kept as `paired:<machine id>` with the link's service and the name
	 * it gave, made the machine in use, and connected to (`starting` with its `host`, then `ready`);
	 * otherwise `error` without a `host`, and nothing kept. Throws for a link it cannot read.
	 */
	public func pair(_ value: String, name: String) throws {
		guard let link = pairLink(value) else { throw RemoteError("ssh", "That is not a pairing link this phone can read. Open Pine on your computer and add this device again.") }
		try begin(id: link.id, service: link.service, name: name, nearby: false) { phone, on in self.remote.pair(link, name: phone, on: on) }
	}

	/**
	 * Pairs with a computer found on the network (`nearbyComputer`), without a code: as `pair`, as
	 * user `nearby.<nonce>`. `id` is the machine id it announced, `service` its meeting service, an
	 * https origin as `nearbyComputer` writes it, `nonce` the nonce of its announcement; anything
	 * else, or a pairing under way, is refused here. On a yes the service kept is the one the computer
	 * named on the pairing channel, which the pairing checked to be the announced one
	 * (`PairWords.nearbyService`).
	 * The page is told the computer's name with the four digits (`pairing.computer`), and a request
	 * the computer did not let in as an error in `PairWords.notLetIn`.
	 */
	public func pairNearby(id: String, service: String, nonce: String, name: String) throws {
		guard pairedFingerprint(id) != nil, httpsOrigin(service)?.origin == service, nearbyNonce(nonce) else { throw RemoteError("ssh", PairWords.notNearby) }
		let computer = NearbyComputer(id: id, service: service, nonce: nonce)
		try begin(id: id, service: service, name: name, nearby: true) { phone, on in self.remote.pairNearby(computer, name: phone, on: on) }
	}

	/** Starts a pairing with the computer `id` reached through `service`; `start` begins it at the remote. */
	private func begin(id: String, service: String, name: String, nearby: Bool, _ start: (String, @escaping @Sendable (PairingState) -> Void) -> Pairing) throws {
		let phone = cleanName(name).isEmpty ? deviceName(nil) : cleanName(name)
		let host = PAIRED + id
		let (mine, pairing) = try lock.withLock { () throws -> (Int, Pairing) in
			if closed { throw RemoteError("failed", "The app is closing.") }
			if pairingNow != nil { throw RemoteError("ssh", "A pairing is open already: cancel it first.") }
			round += 1
			let mine = round
			show(mine, ["status": "starting", "pairing": ["name": phone]], nil)
			let pairing = start(phone) { [weak self] state in
				guard case let .pairing(code, computer) = state else { return }
				var shown = ["code": code, "name": phone]
				if let computer { shown["computer"] = computer }
				self?.show(mine, ["status": "starting", "pairing": shown], nil)
			}
			pairingNow = pairing
			return (mine, pairing)
		}
		Task.detached { [weak self] in
			let end = await pairing.result()
			guard let self else { return }
			let still = self.lock.withLock { () -> Bool in
				guard self.pairingNow === pairing else { return false }
				self.pairingNow = nil
				return mine == self.round
			}
			guard still, let end else { return }
			let fail = { (message: String) in self.show(mine, ["status": "error", "kind": "ssh", "message": message], nil) }
			guard case let .allowed(computer) = end else { return fail(PairWords.of(end, nearby: nearby) ?? PairWords.expired) }
			do {
				try self.addPaired(id: id, service: service, name: computer == YOUR_COMPUTER ? nil : computer)
				self.lock.withLock { _ = self.finals.remove(host) }
				try self.use(host)
			} catch {
				fail("There are \(MAX_HOSTS) machines already: forget one first, then add this device again at your computer.")
			}
		}
	}

	/**
	 * Ends the pairing under way, if any: nothing is kept, and the page is told the machine in use
	 * again (or that there is none), as before the pairing.
	 */
	public func cancelPairing() {
		guard lock.withLock({ pairingNow != nil }) else { return }
		start(inUse)
	}

	/**
	 * The page is told `next`, when it is still what the latest connection is about, and whether the
	 * shown machine's events flow when that changed: a held machine's stream may have been up all along.
	 */
	private func show(_ mine: Int, _ next: [String: Any], _ host: String?) {
		let told = lock.withLock { () -> (Bool, Bool)? in
			if mine != round || closed { return nil }
			let switched = shown != host
			let was = up
			up = next["status"] as? String == "ready" && host != nil && streams[host!] == true
			shown = host
			current = next
			// Told under the lock, so that the page hears the states in the order they were decided.
			page.service(next)
			return (switched || up != was, up)
		}
		if let (changed, now) = told, changed { page.connection(now) }
	}

	/** A held machine's events reach the page only while it is the one shown. */
	fileprivate func batch(_ host: String, _ events: [Any]) {
		if lock.withLock({ shown == host }) { page.events(events) }
	}

	fileprivate func stream(_ host: String, _ isUp: Bool) {
		let tell = lock.withLock { () -> Bool in
			if closed || held[host] == nil { return false }
			streams[host] = isUp
			if shown != host { return false }
			up = isUp
			return true
		}
		if tell { page.connection(isUp) }
	}

	/** A held machine whose session could not be made again after its stream was lost. */
	private func lost(_ host: String, _ e: Error) {
		guard let mine = lock.withLock({ shown == host ? round : nil }) else { return }
		fault(host, mine, e, tries: 0)
	}

	private func failure(_ host: String, _ e: Error) -> [String: Any] {
		var out: [String: Any] = ["status": "error", "host": host]
		switch e {
		case let e as RemoteError:
			if let key = e.hostKey, host.hasPrefix(PAIRED) {
				// A paired computer's key is its machine id: another one is refused for good, in the core's words.
				out["kind"] = "ssh"
				out["fingerprint"] = key.fingerprint
				out["changed"] = true
				out["message"] = e.message
			} else if let key = e.hostKey {
				if !key.changed { lock.withLock { unknown[host] = key } }
				out["kind"] = "ssh"
				out["fingerprint"] = key.fingerprint
				out["changed"] = key.changed
				out["message"] = key.changed
					? "The host key of \(host) changed: it is now \(key.fingerprint), not the one this phone confirmed. Not connecting, since another machine may stand in for it. If that machine was reinstalled, forget it in the list of machines, add it again and confirm its new key."
					: "This phone does not know \(host) yet. Its host key's fingerprint is \(key.fingerprint). If that is what the machine shows (ssh-keygen -lf on its /etc/ssh/ssh_host_*_key.pub), press Trust this key to connect."
			} else {
				out["kind"] = e.kind
				out["message"] = e.message
			}
		default:
			out["kind"] = "failed"
			out["message"] = String(describing: e)
		}
		return out
	}

	private func nobody() -> [String: Any] {
		[
			"status": "error",
			"kind": "ssh",
			"message": hosts.isEmpty
				? "Pair this phone with your computer: in the Pine app there, go to Settings > Browser access, press Add a device, and open its link on this phone. Or add a machine as you would write it after ssh (user@host, or user@host:port), with this phone's key in ~/.ssh/authorized_keys there."
				: "Choose the machine whose pine this phone is to use.",
		]
	}

	/** Lets go of every machine: a pine the app started there stops. */
	public func close() async {
		let (all, pairing) = lock.withLock {
			closed = true
			defer {
				held.removeAll()
				pairingNow = nil
			}
			return (Array(held.values), pairingNow)
		}
		pairing?.cancel()
		for h in all { await h.stop() }
	}

	private static let HOSTS = "hosts"
	private static let USE = "use"
	private static let PREFS = "prefs"
	/** What is kept beside each paired computer of the list, by machine: `{service, name}`, the same key as on Android. */
	private static let PAIRED_ENTRIES = "paired"

	private static func text(_ value: Any) -> String {
		String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]), as: UTF8.self)
	}

	private static func starting(_ host: String) -> [String: Any] { ["status": "starting", "host": host] }

	private static func ready(_ s: RemoteService) -> [String: Any] {
		var out: [String: Any] = ["status": "ready", "mode": "on \(s.label)", "started": s.started, "home": "\(s.label):\(s.home)", "from": s.paired ? "paired \(s.label)" : "ssh \(s.host)","host": s.host, "label": s.label]
		if let v = s.version { out["version"] = v }
		return out
	}
}

/** A held machine's events, handed to the Pines that holds it. */
private final class Follow: EventHandlers, @unchecked Sendable {
	private weak var pines: Pines?
	private let host: String

	init(_ pines: Pines, _ host: String) {
		self.pines = pines
		self.host = host
	}

	func batch(_ events: [Any]) { pines?.batch(host, events) }
	func connection(_ up: Bool) { pines?.stream(host, up) }
}
