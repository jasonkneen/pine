// A computer paired by its link, reached over the data channel of Peer.swift: the same SSH, the
// same `pine service` and the same calls as over TCP, signed in as user `pine`, with the computer
// held to its machine id. The words of every failure are the web client's (web/src/host.ts
// `peerTrouble`, `notKnown` and its paired host-key sentence), "this browser" said "this phone",
// and the Kotlin core's.
import Foundation
import NIOCore
import NIOSSH

/** The user a paired phone signs in as, once the computer knows its key (web/src/pairing.ts `PAIRED_USER`). */
let PAIRED_USER = "pine"

/** What a paired computer is called before it gave a name (desktop/src/machines.ts `YOUR_COMPUTER`). */
let YOUR_COMPUTER = "your computer"

/** The words the owner reads about the paired computer called `label`. */
struct PairedWords {
	let label: String

	/** The label at the start of a sentence. */
	var atStart: String { label == YOUR_COMPUTER ? "Your computer" : label }

	func peer(_ reason: PeerClosed.Reason) -> String {
		switch reason {
		case .absent: "\(atStart) does not answer: it is off, asleep, or Pine is closed. This phone keeps trying, and connects when \(label) is back."
		case .noPath: "\(atStart) is there, but no direct connection could be made from this network. Try another network (another Wi-Fi, or your phone's data); this phone keeps trying meanwhile."
		case .limits: "The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile."
		case .noService: "Could not connect to \(label). The meeting service could not be reached. Check the network, then try again."
		}
	}

	func changed(was: String, seen: String) -> String {
		"The host key of \(label) changed: it was \(was), it is now \(seen). Someone may stand between this phone and \(label). Forget it here, then open Pine on \(label) and add this device again."
	}

	var notKnown: String { "This phone is no longer known to \(label). Open Pine on \(label) and add this device again." }

	var cut: String { "Could not connect to \(label). The connection to the computer closed before SSH let this phone in." }
}

extension Remote {
	/**
	 * The daemon of a paired computer, through its meeting service: the data channel, SSH over it as
	 * `pine` with the phone's key, offered only once the computer showed the host key its machine id
	 * stands for.
	 */
	public func connect(paired computer: PairedComputer) async throws -> RemoteService {
		let label = computer.name ?? YOUR_COMPUTER
		let words = PairedWords(label: label)
		let host = computer.host
		guard let trusted = pairedFingerprint(computer.id) else { throw RemoteError("ssh", "This phone has nothing kept for that paired computer: pair it again from the Pine app.") }
		let signIn = SignIn(user: PAIRED_USER, key: try key.privateKey())
		let hostKey = MachineIdCheck(trusted: trusted, words: words, host: host)
		let link: PeerLink
		do {
			link = try await openPeer(service: computer.service, id: computer.id, within: meet, route: route)
		} catch let e as PeerClosed {
			throw RemoteError("ssh", words.peer(e.reason), passing: true)
		}
		let session: Channel
		do {
			session = try await link.bridge(group: group) { channel in
				channel.eventLoop.makeCompletedFuture {
					let ssh = NIOSSHHandler(role: .client(.init(userAuthDelegate: signIn, serverAuthDelegate: hostKey)), allocator: channel.allocator, inboundChildChannelInitializer: nil)
					try channel.pipeline.syncOperations.addHandlers(ssh, Quiet())
				}
			}
		} catch {
			throw RemoteError("ssh", words.cut, passing: true)
		}
		// Only for the words of what `pine service` says: the machine is the computer's label there.
		let named = SshHost(given: label, user: PAIRED_USER, host: label, port: 0, label: label)
		return try await serve(session, host: host, label: label, paired: true, named: named) { _ in
			if let refused = hostKey.refused { return refused }
			if signIn.refused { return RemoteError("ssh", words.notKnown) }
			return RemoteError("ssh", words.cut, passing: true)
		}
	}
}

/**
 * The computer's host key, held to the machine id of its link: any other key is refused during the
 * key exchange, before the phone's key is offered, and for good (`changed`, so that no one is asked
 * to trust it).
 */
final class MachineIdCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
	private let trusted: String
	private let words: PairedWords
	private let host: String
	private let lock = NSLock()
	private var _refused: RemoteError?

	init(trusted: String, words: PairedWords, host: String) {
		self.trusted = trusted
		self.words = words
		self.host = host
	}

	var refused: RemoteError? { lock.withLock { _refused } }

	func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
		let seen = fingerprint(of: hostKey)
		if seen == trusted { return validationCompletePromise.succeed(()) }
		let e = RemoteError("ssh", words.changed(was: trusted, seen: seen), hostKey: HostKeyRefusal(host: host, port: 0, fingerprint: seen, changed: true))
		lock.withLock { _refused = e }
		validationCompletePromise.fail(e)
	}
}
