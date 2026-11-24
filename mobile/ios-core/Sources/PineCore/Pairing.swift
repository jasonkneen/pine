// Pairing the phone with a computer by its link, as the web client pairs a browser (web/src/pairing.ts
// `askToPair`, web/src/host.ts `pairWith`) and the Pine app's access host takes it
// (desktop/electron/access/pairing.ts): the data channel of Peer.swift, an SSH session as user
// `pair.<code>` with the phone's key, offered only once the computer showed the host key the link's
// machine id stands for, and one command that names the phone. The computer answers the four digits
// it shows the owner (and its own name), then the owner's answer. Only a yes keeps anything, and that
// is Pines' to keep. A computer found on the network (Nearby.swift) is asked the same way without a
// code: as user `nearby.<nonce>`, with the nonce of its announcement, which the computer lets in only
// while it keeps itself visible there. Its first line names its meeting service too: a codeless
// pairing goes no further when that is not the service it announced, since that is the one the phone keeps.
//
// The surface, the same in the Kotlin core: `Remote.pair(link, name, on)` starts a pairing and
// returns a `Pairing`, whose `cancel()` ends it and whose `result()` is its end;
// `Remote.pairNearby(computer, name, on)` does the same without a code. `on` is told
// `pairing(code, computer)` once the computer shows the four digits, then exactly one of
// `allowed(name)`, `refused`, `expired` or `failed(message)`. After `cancel()` nothing more is told.
import Foundation
import NIOCore
import NIOSSH

/** The user name of a pairing session, before its code (desktop/electron/access/pairing.ts `PAIR_USER`). */
let PAIR_USER = "pair."
/** The user name of a codeless pairing session, before the nonce of the announcement (`NEARBY_USER`). */
let NEARBY_USER = "nearby."
/** The command of the pairing request: this word, a space, and base64url of `{"name": ...}` (`PAIR_COMMAND`). */
let PAIR_COMMAND = "pine-pair"
/** How long a pairing waits for the owner's answer at most: the computer ends it after two minutes itself. */
let PAIR_WAIT: Duration = .seconds(5 * 60)

/** What a pairing reports, in order: `pairing` once the four digits are known, then one end. */
public enum PairingState: Equatable, Sendable {
	/**
	 * The computer shows the owner these four digits beside the phone's name; `computer` is the name
	 * it gave with them (cleaned; nil when it gave none), which a phone that found it by its machine
	 * id alone has no other way to show.
	 */
	case pairing(code: String, computer: String? = nil)
	/** The owner allowed the phone; `name` is the computer's, cleaned, or "your computer". */
	case allowed(name: String)
	/** The owner refused the phone. */
	case refused
	/** No answer in time, a code that is wrong or was used, or a session that closed without an answer. */
	case expired
	/** The computer could not be reached to pair with, or another one answered: `message` says what to do. */
	case failed(message: String)
}

/** The words of a pairing that did not go through: the web client's, "this browser" said "this phone". */
enum PairWords {
	static let refused = "Your computer refused this phone: nothing was kept. To pair it after all, open Pine on your computer and add this device again."
	static let expired = "This pairing link has expired or was used already. Open Pine on your computer and add this device again."
	static let impostor = "The computer that answered is not the one this pairing link names: nothing was trusted. Open Pine on your computer and add this device again."
	static let cut = "Could not reach your computer to pair with it. The connection to the computer closed before SSH let this phone in."
	/** A codeless request the computer did not let in: not visible, busy with another request, or pausing after a refusal. */
	static let notLetIn = "Your computer did not take the request: it may be busy with another one, or no longer visible on this network. Try again in a moment, or pair with the code from Pine > Add a device."
	/** A codeless request that got no answer in time, or whose session closed without one. */
	static let nearbyExpired = "Your computer did not answer in time: nothing was kept. Try again, or pair with the code from Pine > Add a device."
	/** A computer found on the network whose host key is not the machine id it announced. */
	static let nearbyImpostor = "The computer that answered is not the one found on this network: nothing was trusted. Pair with the code from Pine > Add a device instead."
	/** A computer found on the network whose pairing names another meeting service than its announcement. */
	static let nearbyService = "The computer found on this network names another meeting service than its announcement: nothing was kept. Pair with the code from Pine > Add a device instead."
	/** What was found on the network is not a computer this phone can pair with. */
	static let notNearby = "That is not a computer this phone can pair with. Look again, or pair with the code from Pine > Add a device."

	/** While pairing nothing is tried again: the link is for one use and two minutes. */
	static func trouble(_ reason: PeerClosed.Reason) -> String {
		switch reason {
		case .absent: "Your computer does not answer: it is off, asleep, or Pine is closed. Open Pine on your computer and add this device again."
		case .noPath: "Your computer is there, but no direct connection could be made from this network. Try another network (another Wi-Fi, or your phone's data), then add this device again at your computer."
		case .limits: "The meeting service is over its limits for now. Try again later: add this device again at your computer."
		case .noService: "Could not reach your computer to pair with it. The meeting service could not be reached. Check the network, then add this device again at your computer."
		}
	}

	/** What the page is told for an end that is not a yes. `nearby`: a codeless pairing, which had no link. */
	static func of(_ end: PairingState, nearby: Bool = false) -> String? {
		switch end {
		case .pairing, .allowed: nil
		case .refused: refused
		case .expired: nearby ? nearbyExpired : expired
		case let .failed(message): message
		}
	}
}

/**
 * Whom a pairing asks and how: the meeting service, the computer's machine id, and the SSH user
 * (`pair.<code>` for a link, `nearby.<nonce>` for a computer found on the network).
 */
struct PairAs: Sendable {
	let service: String
	let id: String
	let user: String
	var nearby: Bool { user.hasPrefix(NEARBY_USER) }
	var impostor: String { nearby ? PairWords.nearbyImpostor : PairWords.impostor }
}

/** The pairing request for a phone called `name`. */
func pairCommand(_ name: String) -> String {
	let json = try! JSONSerialization.data(withJSONObject: ["name": cleanName(name)], options: [.withoutEscapingSlashes])
	let body = json.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
	return "\(PAIR_COMMAND) \(body)"
}

/** One pairing under way: `cancel()` ends it, `result()` waits for its end (nil when it was cancelled). */
public final class Pairing: @unchecked Sendable {
	private let lock = NSLock()
	private var cancelled = false
	private var link: PeerLink?
	private var session: Channel?
	private var task: Task<PairingState?, Never>?

	/** Ends the pairing: its session and its data channel are closed, and nothing more is told. */
	public func cancel() {
		let (link, session, task) = lock.withLock { () -> (PeerLink?, Channel?, Task<PairingState?, Never>?) in
			cancelled = true
			return (self.link, self.session, self.task)
		}
		session?.close(promise: nil)
		link?.close()
		task?.cancel()
	}

	/** The end it came to; nil when it was cancelled. */
	public func result() async -> PairingState? {
		guard let task = lock.withLock({ task }) else { return nil }
		return await task.value
	}

	var isCancelled: Bool { lock.withLock { cancelled } }

	fileprivate func run(_ task: Task<PairingState?, Never>) { lock.withLock { self.task = task } }

	/** Keeps what `cancel()` closes; false when it was cancelled meanwhile (the caller closes it then). */
	fileprivate func hold(link: PeerLink? = nil, session: Channel? = nil) -> Bool {
		lock.withLock {
			if cancelled { return false }
			if let link { self.link = link }
			if let session { self.session = session }
			return true
		}
	}
}

extension Remote {
	/**
	 * Pairs with the computer `link` names, as the phone called `name` ("Pine on iPhone 17 Pro"):
	 * `on` hears what the pairing reports (see `PairingState`). Nothing is kept here: on `allowed`
	 * the caller keeps the computer (`Pines.addPaired`) and connects to it as a paired phone.
	 */
	public func pair(_ link: PairLink, name: String, on: @escaping @Sendable (PairingState) -> Void) -> Pairing {
		pair(PairAs(service: link.service, id: link.id, user: PAIR_USER + link.code), name: name, on: on)
	}

	/**
	 * Pairs with a computer found on the network, without a code: as `pair`, as user
	 * `nearby.<nonce>`. The machine id it announced is checked as a link's is: only its host key is
	 * taken; and the pairing ends when the computer names another meeting service than it announced.
	 */
	public func pairNearby(_ computer: NearbyComputer, name: String, on: @escaping @Sendable (PairingState) -> Void) -> Pairing {
		pair(PairAs(service: computer.service, id: computer.id, user: NEARBY_USER + computer.nonce), name: name, on: on)
	}

	private func pair(_ link: PairAs, name: String, on: @escaping @Sendable (PairingState) -> Void) -> Pairing {
		let pairing = Pairing()
		let task = Task.detached { [self] () -> PairingState? in
			let end = await runPairing(link, name: name, pairing) { state in
				// Told under no lock of ours; a pairing cancelled meanwhile tells nothing.
				if !pairing.isCancelled { on(state) }
			}
			if pairing.isCancelled { return nil }
			return end
		}
		pairing.run(task)
		return pairing
	}

	private func runPairing(_ link: PairAs, name: String, _ pairing: Pairing, tell: @Sendable (PairingState) -> Void) async -> PairingState {
		let end = await pairingEnd(link, name: name, pairing, tell: tell)
		tell(end)
		return end
	}

	private func pairingEnd(_ link: PairAs, name: String, _ pairing: Pairing, tell: @Sendable (PairingState) -> Void) async -> PairingState {
		guard let trusted = pairedFingerprint(link.id) else { return .failed(message: link.impostor) }
		let privateKey: NIOSSHPrivateKey
		do {
			privateKey = try key.privateKey()
		} catch {
			return .failed(message: "\(error)")
		}
		// A session that closed before the phone's key was offered never used the code (the computer
		// can let go of a channel that is slow to reach it): one more is tried, as the web client does.
		let first = await attempt(link, name: name, trusted: trusted, privateKey, pairing, tell: tell)
		guard case .unused = first else { return first.state }
		if pairing.isCancelled { return .expired }
		return await attempt(link, name: name, trusted: trusted, privateKey, pairing, tell: tell).state
	}

	private enum Attempt {
		case end(PairingState)
		/** Closed before the code was offered. */
		case unused

		var state: PairingState {
			switch self {
			case let .end(state): state
			case .unused: .failed(message: PairWords.cut)
			}
		}
	}

	/** One data channel and one pairing session over it. */
	private func attempt(_ link: PairAs, name: String, trusted: String, _ privateKey: NIOSSHPrivateKey, _ pairing: Pairing, tell: @Sendable (PairingState) -> Void) async -> Attempt {
		let peer: PeerLink
		do {
			peer = try await openPeer(service: link.service, id: link.id, within: meet, route: route)
		} catch let e as PeerClosed {
			return .end(.failed(message: PairWords.trouble(e.reason)))
		} catch {
			return .end(.failed(message: PairWords.cut))
		}
		guard pairing.hold(link: peer) else {
			peer.close()
			return .end(.expired)
		}
		let signIn = SignIn(user: link.user, key: privateKey)
		let hostKey = MachineIdCheck(trusted: trusted, words: PairedWords(label: YOUR_COMPUTER), host: PAIRED + link.id)
		let session: Channel
		do {
			session = try await peer.bridge(group: group) { channel in
				channel.eventLoop.makeCompletedFuture {
					let ssh = NIOSSHHandler(role: .client(.init(userAuthDelegate: signIn, serverAuthDelegate: hostKey)), allocator: channel.allocator, inboundChildChannelInitializer: nil)
					try channel.pipeline.syncOperations.addHandlers(ssh, Quiet())
				}
			}
		} catch {
			return .unused
		}
		// Whatever the end, the pairing session is closed with it: a yes is followed by a session as `pine`.
		defer { session.close(promise: nil) }
		guard pairing.hold(session: session) else { return .end(.expired) }
		let limit = session.eventLoop.scheduleTask(in: connectLimit) { session.close(promise: nil) }
		let exec: Channel
		do {
			exec = try await execChannel(session)
			limit.cancel()
		} catch {
			limit.cancel()
			if hostKey.refused != nil { return .end(.failed(message: link.impostor)) }
			// The computer takes no key under a code that is wrong, used or closed: it says no, or
			// closes the connection once the key was offered. Nor a codeless request while it is not
			// visible, busy with another request, or pausing after a refusal.
			if signIn.refused || signIn.offeredKey { return .end(link.nearby ? .failed(message: PairWords.notLetIn) : .expired) }
			return .unused
		}
		do {
			let command = try await ChannelDuplex.of(exec, limit: read)
			try await exec.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: pairCommand(name), wantReply: false)).get()
			return .end(await answer(link, command, pairing, tell: tell))
		} catch {
			return .end(.expired)
		}
	}

	/**
	 * The computer's lines: the four digits, then the owner's answer. A channel that ends without one is
	 * expired. A codeless pairing ends before the digits are shown when the first line names another
	 * meeting service than the announcement (or none): the phone would keep the announced one. A link's
	 * service is the one the owner's computer put in it, and a Pine app before this line said none.
	 */
	private func answer(_ link: PairAs, _ command: ChannelDuplex, _ pairing: Pairing, tell: @Sendable (PairingState) -> Void) async -> PairingState {
		let until = ContinuousClock.now + PAIR_WAIT
		var text: [UInt8] = []
		while ContinuousClock.now < until {
			if pairing.isCancelled { return .expired }
			let bytes: [UInt8]?
			do {
				bytes = try await command.read(within: .seconds(1))
			} catch is ReadTimeout {
				continue
			} catch {
				bytes = nil
			}
			guard let bytes else { return .expired }
			text += bytes
			while let nl = text.firstIndex(of: 10) {
				let line = Data(text[..<nl])
				text.removeFirst(nl + 1)
				guard let said = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
				if let code = said["code"] as? String, wholeMatch("[0-9]{4}", code) != nil {
					if link.nearby, (said["service"] as? String).flatMap({ httpsOrigin($0)?.origin }) != link.service {
						return .failed(message: PairWords.nearbyService)
					}
					let computer = cleanName(said["computer"] as? String ?? "")
					tell(.pairing(code: code, computer: computer.isEmpty ? nil : computer))
				} else if let ok = said["ok"] as? Bool {
					if !ok { return said["reason"] as? String == "refused" ? .refused : .expired }
					let named = cleanName(said["name"] as? String ?? "")
					return .allowed(name: named.isEmpty ? YOUR_COMPUTER : named)
				}
			}
			if text.count > 64 * 1024 { return .expired }
		}
		return .expired
	}
}
