// A pine on another machine, reached over SSH: `connectRemote` of src/remote.ts on the phone, as
// Remote.kt on Android. One SSH session per machine runs `pine service` there (`REMOTE_COMMAND`),
// reads its one line, and keeps the session's stdin open as the leash of a daemon it started.
// Calls go through a `direct-tcpip` channel of that session each.
import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/** A daemon on another machine, held by one SSH session. */
public final class RemoteService: Daemon, @unchecked Sendable {
	/** The machine as the owner wrote it. */
	public let host: String
	/** A short name for it: the host name without the user and the domain. */
	public let label: String
	public let token: String
	/** `pine service` there started the daemon, which this session holds by its stdin: it stops when the session ends. */
	public let started: Bool
	/** The home of that pine, on that machine. */
	public let home: String
	public let version: String?
	public let end: Loopback
	private let session: Channel
	private let command: ChannelDuplex
	private let readLimit: TimeAmount

	/** Reached over a data channel through the meeting service: a computer paired by its link. */
	public let paired: Bool

	init(host: String, label: String, paired: Bool, line: ServiceLine, session: Channel, command: ChannelDuplex, readLimit: TimeAmount) {
		self.host = host
		self.label = label
		self.paired = paired
		token = line.token
		started = line.started
		home = line.home
		version = line.version
		end = line.end
		self.session = session
		self.command = command
		self.readLimit = readLimit
	}

	/** Whether the session still stands. */
	public var isOpen: Bool { session.isActive && command.channel.isActive }

	/** A `direct-tcpip` channel of the session to the daemon's port. */
	public func open() async throws -> Duplex {
		let session = self.session
		let end = self.end
		let promise = session.eventLoop.makePromise(of: Channel.self)
		session.eventLoop.execute {
			do {
				let ssh = try session.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
				let target = SSHChannelType.DirectTCPIP(targetHost: end.host, targetPort: end.port, originatorAddress: try SocketAddress(ipAddress: "127.0.0.1", port: 0))
				ssh.createChannel(promise, channelType: .directTCPIP(target)) { channel, _ in ChannelDuplex.initialize(channel) }
			} catch {
				promise.fail(error)
			}
		}
		return try await ChannelDuplex.of(try await promise.futureResult.get(), limit: readLimit)
	}

	/** One call of the control API: `callDaemon` with this daemon. */
	public func call(method: String, url: String, body: Any? = nil) async -> CallResult {
		await callDaemon(self, method: method, url: url, body: body)
	}

	/** Ends the session: its stdin first, so that a daemon it started stops, then the connection. */
	public func stop() async {
		await command.closeOutput()
		_ = await settled(command.channel.closeFuture, within: .seconds(2))
		try? await session.close().get()
	}
}

/**
 * Connects to other machines with the phone's key, and only to those whose host key the owner
 * confirmed. `answer` is how long `pine service` there has to say where its daemon answers;
 * `connect` how long the machine has to answer at all (ssh's ConnectTimeout); `read` how long a
 * read on a channel waits for a byte: a daemon that takes a call and never answers fails it then.
 * The event stream is read under it too, which the daemon's ping every 20 seconds keeps alive.
 */
public final class Remote: Sendable {
	public let key: DeviceKey
	public let known: KnownHosts
	let answer: TimeAmount
	let connectLimit: TimeAmount
	let read: TimeAmount
	/** How long a paired computer has to be reached, from the join of the meeting to the open channel. */
	let meet: Duration
	let group: EventLoopGroup
	/**
	 * Where a meeting service is reached, by its origin: the origin itself. Only a test hands in
	 * another (the access host's helper answers on http on the loopback, which no link may name).
	 */
	let route: @Sendable (String) -> String

	public convenience init(key: DeviceKey, known: KnownHosts, answer: Duration = .seconds(60), connect: Duration = .seconds(15), read: Duration = .seconds(60), meet: Duration = .seconds(20), group: EventLoopGroup = MultiThreadedEventLoopGroup.singleton) {
		self.init(key: key, known: known, answer: answer, connect: connect, read: read, meet: meet, group: group, route: { $0 })
	}

	init(key: DeviceKey, known: KnownHosts, answer: Duration = .seconds(60), connect: Duration = .seconds(15), read: Duration = .seconds(60), meet: Duration = .seconds(20), group: EventLoopGroup = MultiThreadedEventLoopGroup.singleton, route: @escaping @Sendable (String) -> String) {
		self.route = route
		self.key = key
		self.known = known
		self.answer = TimeAmount(answer)
		self.connectLimit = TimeAmount(connect)
		self.read = TimeAmount(read)
		self.meet = meet
		self.group = group
	}

	/**
	 * The daemon of the machine `value` names (host, user@host or user@host:port, or `paired:<machine
	 * id>` with what is kept for that computer as `paired`), or a `RemoteError` that says what to do.
	 */
	public func connect(_ value: String, paired: PairedComputer? = nil) async throws -> RemoteService {
		if value.hasPrefix(PAIRED) {
			guard case let .paired(id)? = try listed(value), let paired, paired.id == id else {
				throw RemoteError("ssh", "This phone has nothing kept for that paired computer: pair it again from the Pine app.")
			}
			return try await connect(paired: paired)
		}
		guard let named = try sshHost(value) else { throw RemoteError("ssh", "Name the machine as you would after ssh: user@host, or user@host:port.") }
		guard let user = named.user else { throw RemoteError("ssh", "Name the user too: user@\(named.given). A phone has no user name of its own to sign in with.") }
		let given = named.given
		let signIn = SignIn(user: user, key: try key.privateKey())
		let hostKey = HostKeyCheck(known: known, named: named)
		let keepAlive = { (level: Int32, name: Int32) in ChannelOptions.Types.SocketOption(level: level, name: name) }
		let bootstrap = ClientBootstrap(group: group)
			.connectTimeout(connectLimit)
			// A link that died is noticed in under a minute, as ServerAliveInterval=15 and ServerAliveCountMax=3 do.
			.channelOption(.socketOption(.so_keepalive), value: 1)
			.channelOption(keepAlive(IPPROTO_TCP, TCP_KEEPALIVE), value: 15)
			.channelOption(keepAlive(IPPROTO_TCP, TCP_KEEPINTVL), value: 15)
			.channelOption(keepAlive(IPPROTO_TCP, TCP_KEEPCNT), value: 3)
			.channelInitializer { channel in
				channel.eventLoop.makeCompletedFuture {
					let ssh = NIOSSHHandler(role: .client(.init(userAuthDelegate: signIn, serverAuthDelegate: hostKey)), allocator: channel.allocator, inboundChildChannelInitializer: nil)
					try channel.pipeline.syncOperations.addHandlers(ssh, Quiet())
				}
			}
		let unreachable = { (error: Error) in
			RemoteError("ssh", "Could not connect to \(given) over SSH: \(unreachableWhy(error, host: named.host, port: named.port)). Check that this phone reaches that machine (the same Wi-Fi, or a VPN such as Tailscale on both), that SSH runs there, and that the port is right.")
		}
		let session: Channel
		do {
			session = try await bootstrap.connect(host: named.host, port: named.port).get()
		} catch {
			throw unreachable(error)
		}
		return try await serve(session, host: given, label: named.label, paired: false, named: named) { error in
			if let refused = hostKey.refused { return refused }
			if signIn.refused { return RemoteError("ssh", "Could not connect to \(given) over SSH: it did not take this phone's key for \(user). Add the app's public key to ~/.ssh/authorized_keys of \(user) there, then try again.") }
			return unreachable(error)
		}
	}

	/**
	 * `pine service` run in a session that stands: its line read, and the session held by its stdin.
	 * `refusal` says why SSH did not let the phone in; `named` is the machine in the words of a
	 * failure. The session is closed when anything fails.
	 */
	func serve(_ session: Channel, host: String, label: String, paired: Bool, named: SshHost, refusal: (Error) -> Error) async throws -> RemoteService {
		let given = named.given
		do {
			// A machine that takes the connection and never gets through SSH's greeting is given up on as one that does not answer.
			let limit = session.eventLoop.scheduleTask(in: connectLimit) { session.close(promise: nil) }
			let exec: Channel
			do {
				exec = try await execChannel(session)
				limit.cancel()
			} catch {
				limit.cancel()
				throw refusal(error)
			}
			let command = try await ChannelDuplex.of(exec, limit: read)
			try await exec.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: REMOTE_COMMAND, wantReply: false)).get()
			let said: String
			switch await firstLine(command) {
			case .line(let line):
				said = line
			case .silent:
				let (stderr, _) = await command.ended()
				throw failure(given: given, stderr: stderr, exit: nil)
			case .ended:
				// Its code and the last of stderr come with the channel's end.
				_ = await settled(command.channel.closeFuture, within: .seconds(5))
				// A data channel that went while pine was asked: the network, not the machine.
				if paired && !session.isActive { throw RemoteError("ssh", "The connection to \(label) was lost while pine there was asked to start.", passing: true) }
				let (stderr, code) = await command.ended()
				throw failure(given: given, stderr: stderr, exit: code ?? -1).withUnknownExit(code == nil)
			}
			return RemoteService(host: host, label: label, paired: paired, line: try serviceLine(said, named: named), session: session, command: command, readLimit: read)
		} catch {
			try? await session.close().get()
			throw error
		}
	}

	/** The session channel `pine service` runs in, once SSH let the phone in. */
	func execChannel(_ session: Channel) async throws -> Channel {
		let promise = session.eventLoop.makePromise(of: Channel.self)
		session.eventLoop.execute {
			do {
				let ssh = try session.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
				ssh.createChannel(promise, channelType: .session) { channel, _ in ChannelDuplex.initialize(channel) }
			} catch {
				promise.fail(error)
			}
		}
		// A connection that closes before the channel opens leaves the promise to the channel's end.
		session.closeFuture.whenComplete { _ in promise.fail(ChannelError.ioOnClosedChannel) }
		return try await promise.futureResult.get()
	}

	private enum Said {
		case line(String)
		/** The command ended before a line. */
		case ended
		/** It said nothing within the answer time. */
		case silent
	}

	/** The first line the command writes, within the answer time. */
	private func firstLine(_ command: ChannelDuplex) async -> Said {
		let until = NIODeadline.now() + answer
		var line: [UInt8] = []
		while true {
			let left = until - .now()
			if left <= .zero { return .silent }
			let bytes: [UInt8]?
			do {
				bytes = try await command.read(within: left)
			} catch is ReadTimeout {
				return .silent
			} catch {
				return .ended
			}
			guard let bytes else { return .ended }
			if let nl = bytes.firstIndex(of: 10) {
				line.append(contentsOf: bytes[..<nl])
				return .line(String(decoding: line, as: UTF8.self))
			}
			if line.count < 64 * 1024 { line.append(contentsOf: bytes) }
		}
	}
}

private extension RemoteError {
	/** A command that ended without saying its code is said as one whose code is unknown. */
	func withUnknownExit(_ unknown: Bool) -> RemoteError {
		guard unknown else { return self }
		return RemoteError(kind, message.replacingOccurrences(of: "(exit -1)", with: "(exit unknown)"))
	}
}

/** Offers the phone's key, once; a machine that does not take it ends the sign-in. */
final class SignIn: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
	private let user: String
	private let key: NIOSSHPrivateKey
	private let lock = NSLock()
	private var offered = false
	private var _refused = false

	init(user: String, key: NIOSSHPrivateKey) {
		self.user = user
		self.key = key
	}

	var refused: Bool { lock.withLock { _refused } }

	/** Whether the phone's key was offered (the host key was taken first). */
	var offeredKey: Bool { lock.withLock { offered } }

	func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
		let first = lock.withLock {
			defer { offered = true }
			if offered || !availableMethods.contains(.publicKey) { _refused = true }
			return !_refused
		}
		if first {
			nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: user, serviceName: "", offer: .privateKey(.init(privateKey: key))))
		} else {
			nextChallengePromise.fail(RemoteError("ssh", "key refused"))
		}
	}
}

/** The machine's host key, held to the one the owner confirmed. */
private final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
	private let known: KnownHosts
	private let named: SshHost
	private let lock = NSLock()
	private var _refused: RemoteError?

	init(known: KnownHosts, named: SshHost) {
		self.known = known
		self.named = named
	}

	var refused: RemoteError? { lock.withLock { _refused } }

	func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
		do {
			try known.check(given: named.given, host: named.host, port: named.port, key: hostKey)
			validationCompletePromise.succeed(())
		} catch let e as RemoteError {
			lock.withLock { _refused = e }
			validationCompletePromise.fail(e)
		} catch {
			validationCompletePromise.fail(error)
		}
	}
}

/** The end of the session's pipeline: an error there closes the connection, and is not logged. */
final class Quiet: ChannelInboundHandler {
	typealias InboundIn = Any
	func errorCaught(context: ChannelHandlerContext, error: Error) {
		context.close(promise: nil)
	}
}

/**
 * Why a connection could not be made, in words the owner reads: never the error's own text, which
 * is a dump of NIO's types.
 */
func unreachableWhy(_ error: Error, host: String, port: Int) -> String {
	knownCause(error, host: host, port: port) ?? "the connection failed"
}

private func knownCause(_ error: Error, host: String, port: Int) -> String? {
	switch error {
	case let e as NIOConnectionError:
		// Each address of the name was tried; the first failure with a known cause speaks for them.
		if let why = e.connectionErrors.lazy.compactMap({ knownCause($0.error, host: host, port: port) }).first { return why }
		if e.connectionErrors.isEmpty && (e.dnsAError != nil || e.dnsAAAAError != nil) { return "no machine is known by the name \(host)" }
		return nil
	case let e as IOError:
		switch e.errnoCode {
		case ECONNREFUSED: return "nothing answers at port \(port) there"
		case ETIMEDOUT: return "it did not answer in time"
		case ENETUNREACH, EHOSTUNREACH: return "this phone has no way to that network"
		default: return nil
		}
	case is SocketAddressError:
		return "no machine is known by the name \(host)"
	case ChannelError.connectTimeout:
		return "it did not answer in time"
	default:
		return nil
	}
}
