import Foundation
import NIOCore
import NIOPosix
@testable import PineCore

// The other machine and its daemon, as Machine.kt is for the Kotlin core: here a real OpenSSH
// server, macOS's own /usr/sbin/sshd, started unprivileged by the test on a loopback port with a
// configuration, a host key and an authorized_keys file of its own. An implementation of SSH the
// client did not write, as MINA is for sshj.

/** A store in memory that more than one thread may use: the SSH handshake reads it on NIO's threads. */
final class SharedStore: SecretStore, @unchecked Sendable {
	private let lock = NSLock()
	private var entries: [String: Data] = [:]

	func read(_ name: String) throws -> Data? { lock.withLock { entries[name] } }
	func write(_ name: String, _ value: Data) throws { lock.withLock { entries[name] = value } }
	func remove(_ name: String) throws { _ = lock.withLock { entries.removeValue(forKey: name) } }
}

/** Runs a program to its end; its output. */
@discardableResult
func run(_ path: String, _ args: [String]) throws -> String {
	let p = Process()
	p.executableURL = URL(fileURLWithPath: path)
	p.arguments = args
	let out = Pipe()
	p.standardOutput = out
	p.standardError = FileHandle.nullDevice
	try p.run()
	let data = out.fileHandleForReading.readDataToEndOfFile()
	p.waitUntilExit()
	return String(decoding: data, as: UTF8.self)
}

/** A port of the loopback nobody listens on (for a moment). */
func freePort() throws -> Int {
	let server = try ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton).bind(host: "127.0.0.1", port: 0).wait()
	let port = server.localAddress!.port!
	try server.close().wait()
	return port
}

/** Whether something listens at that port of the loopback. */
func listening(_ port: Int) -> Bool {
	let fd = socket(AF_INET, SOCK_STREAM, 0)
	defer { close(fd) }
	var addr = sockaddr_in()
	addr.sin_family = sa_family_t(AF_INET)
	addr.sin_port = in_port_t(UInt16(port).bigEndian)
	addr.sin_addr.s_addr = inet_addr("127.0.0.1")
	return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
}

/** Waits up to five seconds for `ok`. */
func eventually(_ what: String, _ ok: () async throws -> Bool) async throws {
	let until = Date().addingTimeInterval(5)
	while try await !ok() {
		if Date() > until { throw Still(what: what) }
		try await Task.sleep(for: .milliseconds(10))
	}
}

struct Still: Error, CustomStringConvertible {
	let what: String
	var description: String { "still not: \(what)" }
}

/**
 * The other machine: sshd lets in the one key given, and runs every command through a forced
 * command. That script accepts only the command src/remote.ts builds (any other gets exit 2), notes
 * it, and does what `behaviour` (shell) says. `direct-tcpip` is let through, as `ssh -L` would be.
 */
final class Machine: @unchecked Sendable {
	let dir: URL
	let port: Int
	private var sshd: Process?
	let user = NSUserName()

	init(authorized: String, behaviour: String) async throws {
		dir = FileManager.default.temporaryDirectory.appendingPathComponent("pine-sshd-\(UUID().uuidString.prefix(8))")
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		port = try freePort()
		try (authorized + "\n").write(to: file("authorized_keys"), atomically: true, encoding: .utf8)
		try FileManager.default.copyItem(at: casesDir.appendingPathComponent("remote-command.txt"), to: file("expected"))
		let force = """
		#!/bin/sh
		D='\(dir.path)'
		if [ "$SSH_ORIGINAL_COMMAND" != "$(cat "$D/expected")" ]; then echo "not the command of src/remote.ts: $SSH_ORIGINAL_COMMAND" >&2; exit 2; fi
		echo ran | tee -a "$D/commands" >/dev/null
		. "$D/behaviour"

		"""
		try force.write(to: file("force.sh"), atomically: true, encoding: .utf8)
		try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file("force.sh").path)
		self.behaviour = behaviour
		let config = """
		ListenAddress 127.0.0.1
		Port \(port)
		HostKey \(file("host_key").path)
		AuthorizedKeysFile \(file("authorized_keys").path)
		PidFile none
		UsePAM no
		StrictModes no
		PasswordAuthentication no
		KbdInteractiveAuthentication no
		AllowTcpForwarding local
		ForceCommand \(file("force.sh").path)

		"""
		try config.write(to: file("sshd_config"), atomically: true, encoding: .utf8)
		try makeHostKey()
		try await start()
	}

	func file(_ name: String) -> URL { dir.appendingPathComponent(name) }

	/** What the machine does with the command, as shell: what it writes, reads and exits with. */
	var behaviour: String {
		get { (try? String(contentsOf: file("behaviour"), encoding: .utf8)) ?? "" }
		set { try! newValue.write(to: file("behaviour"), atomically: true, encoding: .utf8) }
	}

	/** How many commands it ran. */
	var commands: Int { ((try? String(contentsOf: file("commands"), encoding: .utf8)) ?? "").split(separator: "\n").count }

	/** How many `pine service` saw their stdin end. */
	var leashesEnded: Int { ((try? String(contentsOf: file("leash"), encoding: .utf8)) ?? "").split(separator: "\n").count }

	/** The host key's fingerprint, as ssh-keygen prints it. */
	var fingerprint: String {
		try! run("/usr/bin/ssh-keygen", ["-l", "-f", file("host_key.pub").path]).split(separator: " ")[1].description
	}

	private func makeHostKey() throws {
		try? FileManager.default.removeItem(at: file("host_key"))
		try? FileManager.default.removeItem(at: file("host_key.pub"))
		try run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file("host_key").path])
	}

	private func start() async throws {
		let p = Process()
		p.executableURL = URL(fileURLWithPath: "/usr/sbin/sshd")
		p.arguments = ["-D", "-e", "-f", file("sshd_config").path]
		FileManager.default.createFile(atPath: file("sshd.log").path, contents: nil)
		let log = try FileHandle(forWritingTo: file("sshd.log"))
		log.seekToEndOfFile()
		p.standardError = log
		p.standardOutput = log
		try p.run()
		sshd = p
		let until = Date().addingTimeInterval(5)
		while !listening(port) {
			if Date() > until || !p.isRunning { throw Still(what: "sshd listening on \(port): \((try? String(contentsOf: file("sshd.log"), encoding: .utf8)) ?? "")") }
			try await Task.sleep(for: .milliseconds(10))
		}
	}

	/** The machine was reinstalled: another host key, on the same port. */
	func newHostKey() async throws {
		let old = stopSSHD()
		// Its port is free again once it is gone. Never waited for by blocking: the test's thread may be the only one.
		try await eventually("sshd gone") { !(old?.isRunning ?? false) && !listening(port) }
		try makeHostKey()
		try await start()
	}

	/** Stops the listener (the sessions it started end with their clients). */
	@discardableResult
	private func stopSSHD() -> Process? {
		guard let p = sshd else { return nil }
		p.terminate()
		sshd = nil
		return p
	}

	func close() {
		stopSSHD()
		try? FileManager.default.removeItem(at: dir)
	}

	/** `pine service` that prints `line`, then holds until stdin ends, as `cat` does there. */
	static func service(_ line: String) -> String {
		"printf '%s\\n' '\(line)'\ncat >/dev/null\necho ended | tee -a \"$D/leash\" >/dev/null\n"
	}
}

/** A request as the stand-in daemon received it. */
struct Seen: Sendable {
	let method: String
	let url: String
	let headers: [String: String]
	let body: String
	func header(_ name: String) -> String? { headers[name.lowercased()] }
}

/** One request being answered: what a route of a test writes, as `HttpExchange` is in the Kotlin tests. */
final class Exchange: @unchecked Sendable {
	let request: Seen
	private let channel: Channel
	private var chunked = false

	init(_ request: Seen, _ channel: Channel) {
		self.request = request
		self.channel = channel
	}

	/** The status line and headers. `length` as `sendResponseHeaders`: 0 sends the body in chunks, -1 sends none, else its length. */
	func head(_ status: Int, _ headers: [String: String] = [:], length: Int) {
		chunked = length == 0
		var text = "HTTP/1.1 \(status) X\r\n"
		for (k, v) in headers { text += "\(k): \(v)\r\n" }
		text += chunked ? "Transfer-Encoding: chunked\r\n" : "Content-Length: \(max(0, length))\r\n"
		text += "Connection: close\r\n\r\n"
		channel.writeAndFlush(ByteBuffer(string: text), promise: nil)
	}

	func write(_ bytes: [UInt8]) {
		if bytes.isEmpty { return }
		var out = chunked ? Array("\(String(bytes.count, radix: 16))\r\n".utf8) : []
		out += bytes
		if chunked { out += Array("\r\n".utf8) }
		channel.writeAndFlush(ByteBuffer(bytes: out), promise: nil)
	}

	func write(_ text: String) { write(Array(text.utf8)) }

	/** Writes a body without chunks and waits until it left: closing the connection drops what still waits to be written. */
	func written(_ bytes: [UInt8]) async {
		try? await channel.writeAndFlush(ByteBuffer(bytes: bytes)).get()
	}

	/** The end of the answer: the connection closes. */
	func finish() {
		if chunked { channel.write(ByteBuffer(string: "0\r\n\r\n"), promise: nil) }
		channel.writeAndFlush(ByteBuffer(), promise: nil)
		channel.close(promise: nil)
	}
}

/** Something a route waits on until the test lets it go (or a few seconds pass). */
final class Hold: @unchecked Sendable {
	private let lock = NSLock()
	private var released = false

	func release() { lock.withLock { released = true } }

	func wait(_ limit: Duration = .seconds(5)) async {
		let until = ContinuousClock.now + limit
		while !lock.withLock({ released }), ContinuousClock.now < until {
			try? await Task.sleep(for: .milliseconds(10))
		}
	}
}

/** The daemon on the other machine's loopback: notes each request, and answers by its path (or as a test's `routes` say). */
final class StandInDaemon: @unchecked Sendable {
	static let PNG: [UInt8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]
	private let lock = NSLock()
	private var _seen: [Seen] = []
	private var _routes: [String: @Sendable (Exchange) async -> Void] = [:]
	private var server: Channel!

	init() throws {
		server = try ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
			.serverChannelOption(.socketOption(.so_reuseaddr), value: 1)
			.childChannelInitializer { [unowned self] channel in
				channel.eventLoop.makeCompletedFuture { try channel.pipeline.syncOperations.addHandler(Asked(self)) }
			}
			.bind(host: "127.0.0.1", port: 0).wait()
	}

	var base: String { "http://127.0.0.1:\(server.localAddress!.port!)" }
	var seen: [Seen] { lock.withLock { _seen } }

	subscript(route path: String) -> (@Sendable (Exchange) async -> Void)? {
		get { lock.withLock { _routes[path] } }
		set { lock.withLock { _routes[path] = newValue } }
	}

	fileprivate func answer(_ request: Seen, _ channel: Channel) {
		lock.withLock { _seen.append(request) }
		let x = Exchange(request, channel)
		let path = String(request.url.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
		if let route = self[route: path] {
			Task.detached {
				await route(x)
				x.finish()
			}
			return
		}
		let json = ["content-type": "application/json"]
		switch path {
		case "/picture":
			x.head(200, ["content-type": "image/png"], length: Self.PNG.count)
			x.write(Self.PNG)
		case "/streamed":
			x.head(200, ["content-type": "application/json; charset=utf-8"], length: 0)
			x.write(#"{"streamed":true}"#)
		case "/missing":
			let body = #"{"error":"not found"}"#
			x.head(404, json, length: body.utf8.count)
			x.write(body)
		case "/broken":
			x.head(200, json, length: 5)
			x.write("{nope")
		default:
			let body = #"{"method":"\#(request.method)","url":"\#(request.url)"}"#
			x.head(200, json, length: body.utf8.count)
			x.write(body)
		}
		x.finish()
	}

	func close() {
		try? server.close().wait()
	}
}

/** Reads one request off a connection, and hands it to the daemon. */
private final class Asked: ChannelInboundHandler {
	typealias InboundIn = ByteBuffer
	private let daemon: StandInDaemon
	private var bytes: [UInt8] = []
	private var done = false

	init(_ daemon: StandInDaemon) {
		self.daemon = daemon
	}

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		bytes += Array(unwrapInboundIn(data).readableBytesView)
		guard !done, let end = bytes.indices.dropLast(3).first(where: { bytes[$0] == 13 && bytes[$0 + 1] == 10 && bytes[$0 + 2] == 13 && bytes[$0 + 3] == 10 }) else { return }
		let lines = String(decoding: bytes[..<end], as: UTF8.self).components(separatedBy: "\r\n")
		var headers: [String: String] = [:]
		for line in lines.dropFirst() {
			guard let colon = line.firstIndex(of: ":") else { continue }
			headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
		}
		let length = Int(headers["content-length"] ?? "0") ?? 0
		guard bytes.count >= end + 4 + length else { return }
		done = true
		let first = lines[0].split(separator: " ")
		let request = Seen(method: String(first[0]), url: String(first[1]), headers: headers, body: String(decoding: bytes[(end + 4)..<(end + 4 + length)], as: UTF8.self))
		daemon.answer(request, context.channel)
	}

	func errorCaught(context: ChannelHandlerContext, error: Error) {
		context.close(promise: nil)
	}
}

/** A phone, a machine whose host key it confirmed, and the daemon on that machine: what most tests start from. */
final class Rig: @unchecked Sendable {
	let store = SharedStore()
	let key: DeviceKey
	let daemon: StandInDaemon
	let machine: Machine
	let known: KnownHosts
	let remote: Remote
	private let lock = NSLock()
	private var open: [RemoteService] = []
	private var stops: [@Sendable () async -> Void] = []

	init(confirmed: Bool = true, answer: Duration = .seconds(5), read: Duration = .seconds(60)) async throws {
		key = DeviceKey(store)
		daemon = try StandInDaemon()
		machine = try await Machine(authorized: try key.publicKey(), behaviour: Machine.service(Rig.line(daemon.base)))
		known = KnownHosts(store)
		remote = Remote(key: key, known: known, answer: answer, read: read)
		if confirmed { try confirm() }
	}

	/** The line `pine service` writes for a daemon at `base`. */
	static func line(_ base: String) -> String {
		#"{"base":"\#(base)","token":"secret-token","mode":"attached","started":false,"home":"/home/me/.pine","version":"0.40.0"}"#
	}

	var host: String { "\(machine.user)@127.0.0.1:\(machine.port)" }

	func confirm() throws { try known.confirm(host: "127.0.0.1", port: machine.port, fingerprint: machine.fingerprint) }

	func connected(_ remote: Remote? = nil) async throws -> RemoteService {
		let s = try await (remote ?? self.remote).connect(host)
		lock.withLock { open.append(s) }
		return s
	}

	/** Something to stop with the rig. */
	func atEnd(_ stop: @escaping @Sendable () async -> Void) { lock.withLock { stops.append(stop) } }

	func close() async {
		let (services, others) = lock.withLock { (open, stops) }
		for s in services { await s.stop() }
		for stop in others { await stop() }
		machine.close()
		daemon.close()
	}
}

/** Runs `body` with a rig, and closes the rig whatever happens. */
func withRig(confirmed: Bool = true, answer: Duration = .seconds(5), read: Duration = .seconds(60), _ body: (Rig) async throws -> Void) async throws {
	let rig = try await Rig(confirmed: confirmed, answer: answer, read: read)
	do {
		try await body(rig)
	} catch {
		await rig.close()
		throw error
	}
	await rig.close()
}
