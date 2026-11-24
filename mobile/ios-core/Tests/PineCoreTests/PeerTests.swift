import CryptoKit
import Foundation
import NIOCore
import NIOPosix
import Testing
@testable import PineCore

// A computer paired by its link, reached over a WebRTC data channel through the meeting service, as
// the Kotlin core's tests prove it for Android: against the Pine app's real access host (AccessHost.swift),
// whose service line names this test's own stand-in daemon, so that what reaches the daemon is seen.

/** A phone that the computer of a running access host knows already (unless `known` is false), and the daemon behind it. */
final class PeerRig: @unchecked Sendable {
	let store = SharedStore()
	let key: DeviceKey
	let daemon: StandInDaemon
	let host: AccessHost
	let remote: Remote
	/** Where the https origins the tests name are reached: `TEST_SERVICE` is the helper's meeting service. */
	let routes: MemoryShelf
	/** The phone's device id at the computer, once it was added. */
	private(set) var device = ""

	init(known: Bool = true, meet: Duration = .seconds(15), read: Duration = .seconds(60), options: [String] = []) async throws {
		key = DeviceKey(store)
		daemon = try StandInDaemon()
		let host = try await AccessHost.start(serviceLine: Rig.line(daemon.base), options: options)
		self.host = host
		let routes = MemoryShelf()
		self.routes = routes
		routes.set(TEST_SERVICE, host.service)
		// A link names an https service; the helper's answers on http on the loopback. Only a test routes one to the other.
		remote = Remote(key: key, known: KnownHosts(store), read: read, meet: meet, route: { routes.get($0) ?? $0 })
		if known { device = try await host.add(try key.publicKey()) }
	}

	/** The computer as the phone keeps it once paired. */
	var computer: PairedComputer { PairedComputer(id: host.machineId, service: TEST_SERVICE, name: "Test Mac") }

	func connected() async throws -> RemoteService {
		try await remote.connect(computer.host, paired: computer)
	}

	func close() async {
		await host.stop()
		daemon.close()
	}
}

func withPeer(known: Bool = true, meet: Duration = .seconds(15), options: [String] = [], _ body: (PeerRig) async throws -> Void) async throws {
	let rig = try await PeerRig(known: known, meet: meet, options: options)
	do {
		try await body(rig)
	} catch {
		await rig.close()
		throw error
	}
	await rig.close()
}

/** Bytes of a pattern that a lost, doubled or swapped piece would break. */
func pattern(_ count: Int) -> [UInt8] {
	var out = [UInt8](repeating: 0, count: count)
	var x: UInt32 = 2_463_534_242
	for i in 0..<count {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		out[i] = UInt8(truncatingIfNeeded: x)
	}
	return out
}

/** What arrives on a NIO channel, kept. */
private final class Collected: ChannelInboundHandler, @unchecked Sendable {
	typealias InboundIn = ByteBuffer
	private let lock = NSLock()
	private var bytes: [UInt8] = []

	var heard: [UInt8] { lock.withLock { bytes } }

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		let more = Array(unwrapInboundIn(data).readableBytesView)
		lock.withLock { bytes += more }
	}
}

/** A stand-in for the data channel: what was sent, piece by piece, and how much it says waits. */
private final class Sink: PieceSink {
	var buffered = 0
	var pieces: [[UInt8]] = []
	var refuse = false

	func send(_ piece: UnsafeRawBufferPointer) -> Bool {
		if refuse { return false }
		pieces.append(Array(piece))
		buffered += piece.count
		return true
	}
}

struct PeerTests {
	@Test("a paired computer is reached through the meeting: the service line, a call and a media range")
	func reach() async throws {
		try await withPeer { rig in
			let clip = Array(UInt8(0)..<UInt8(100))
			rig.daemon[route: "/media/tool/clip"] = { x in
				let asked = x.request.header("range").flatMap { wholeMatch(#"bytes=(\d+)-(\d+)"#, $0) }
				guard let asked, let from = Int(asked[1]), let to = Int(asked[2]) else {
					x.head(200, ["content-type": "video/mp4", "accept-ranges": "bytes"], length: clip.count)
					x.write(clip)
					return
				}
				let part = Array(clip[from...min(to, clip.count - 1)])
				x.head(206, ["content-type": "video/mp4", "accept-ranges": "bytes", "content-range": "bytes \(from)-\(from + part.count - 1)/\(clip.count)"], length: part.count)
				x.write(part)
			}
			let s = try await rig.connected()
			#expect(s.paired)
			#expect(s.host == "paired:\(rig.host.machineId)")
			#expect(s.label == "Test Mac")
			#expect(s.token == "secret-token")
			#expect(s.version == "0.40.0")
			#expect(s.isOpen)
			#expect(rig.host.saw("connected", rig.device), "signed in as the device the computer knows")

			let r = await s.call(method: "POST", url: "/agents/main/message", body: ["text": "hello"])
			#expect(r.ok)
			let seen = try #require(rig.daemon.seen.last)
			#expect(seen.url == "/agents/main/message")
			#expect(seen.header("authorization") == "Bearer secret-token")
			#expect(seen.body == #"{"text":"hello"}"#)

			let part = await mediaFromDaemon(s, method: "GET", path: "/media/tool/clip", search: "", range: "bytes=90-94")
			#expect(part.status == 206)
			#expect(part.headers["content-range"] == "bytes 90-94/100")
			#expect(try await part.body.all() == Data(90...94))
			#expect(rig.daemon.seen.last?.header("range") == "bytes=90-94")
			#expect(await answers(s))

			await s.stop()
			#expect(!s.isOpen)
			try await eventually("the computer saw the phone leave") { rig.host.saw("left", rig.device) }
		}
	}

	@Test("several megabytes cross each way whole and in order")
	func megabytes() async throws {
		try await withPeer { rig in
			let size = 4 * 1024 * 1024
			let down = pattern(size)
			rig.daemon[route: "/down"] = { x in
				x.head(200, ["content-type": "application/octet-stream"], length: down.count)
				await x.written(down)
			}
			rig.daemon[route: "/up"] = { x in
				let body = Array(x.request.body.utf8)
				let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
				let answer = #"{"length":\#(body.count),"sha":"\#(digest)"}"#
				x.head(200, ["content-type": "application/json"], length: answer.utf8.count)
				x.write(answer)
			}
			let s = try await rig.connected()
			let got = try #require(await s.call(method: "GET", url: "/down").data as? [String: Any])
			#expect(got["base64"] != nil, "\(got)")
			#expect(Data(base64Encoded: got["base64"] as? String ?? "") == Data(down))

			// Letters of the pattern, so that the body is JSON text as the daemon reads it.
			let letters = String(decoding: pattern(size).map { UInt8(ascii: "a") + $0 % 26 }, as: UTF8.self)
			let sent = Array("\"\(letters)\"".utf8)
			let up = try #require(await s.call(method: "POST", url: "/up", body: letters).data as? [String: Any])
			#expect(up["length"] as? Int == sent.count)
			#expect(up["sha"] as? String == SHA256.hash(data: sent).map { String(format: "%02x", $0) }.joined())
			await s.stop()
		}
	}

	@Test("bytes the computer sends before SSH listens are kept for it")
	func early() async throws {
		try await withPeer { rig in
			let link = try await openPeer(service: TEST_SERVICE, id: rig.host.machineId, within: .seconds(15), route: rig.remote.route)
			// The access host sends its SSH banner as soon as the channel opens; nothing reads it yet.
			try await Task.sleep(for: .milliseconds(500))
			let collected = Collected()
			let channel = try await link.bridge(group: MultiThreadedEventLoopGroup.singleton) { channel in
				channel.eventLoop.makeCompletedFuture { try channel.pipeline.syncOperations.addHandler(collected) }
			}
			try await eventually("the computer's banner") { String(decoding: collected.heard, as: UTF8.self).hasPrefix("SSH-2.0-") }
			// The data channel's end is the end of the stream SSH reads.
			let closed = ContinuousClock.now
			link.close()
			try await eventually("the NIO channel closed with the data channel") { !channel.isActive }
			#expect(ContinuousClock.now - closed < .seconds(2))
		}
	}

	@Test("a computer whose key is not the machine id is refused before the phone's key is offered")
	func impostor() async throws {
		try await withPeer { rig in
			let other = try #require(try await rig.host.command("meeting swap")["impostor"] as? String)
			let e = try await #require(throws: RemoteError.self) { try await rig.connected() }
			let key = try #require(e.hostKey)
			#expect(key.changed)
			#expect(key.fingerprint == pairedFingerprint(other))
			#expect(e.kind == "ssh")
			// Not "no longer known": the impostor knows no phone, so a key offered to it would have been refused.
			#expect(e.message == "The host key of Test Mac changed: it was \(pairedFingerprint(rig.host.machineId)!), it is now \(pairedFingerprint(other)!). Someone may stand between this phone and Test Mac. Forget it here, then open Pine on Test Mac and add this device again.")
			#expect(rig.daemon.seen.isEmpty)
		}
	}

	@Test("a phone the computer does not know is told to pair again")
	func notKnown() async throws {
		try await withPeer(known: false) { rig in
			let e = try await #require(throws: RemoteError.self) { try await rig.connected() }
			#expect(e.kind == "ssh")
			#expect(e.hostKey == nil)
			#expect(e.message == "This phone is no longer known to Test Mac. Open Pine on Test Mac and add this device again.")
		}
	}

	@Test("a cut connection ends the session at once, and the held machine is reported lost")
	func lost() async throws {
		try await withPeer { rig in
			let s = try await rig.connected()
			try await rig.host.command("cut \(rig.device)")
			let started = ContinuousClock.now
			try await eventually("the session ended") { !s.isOpen }
			#expect(ContinuousClock.now - started < .seconds(3))
			await s.stop()

			let hold = Hold()
			defer { hold.release() }
			rig.daemon[route: "/events/stream"] = { x in
				stream(x, ": connected\n\n")
				await hold.wait(.seconds(30))
			}
			let heard = Heard()
			let computer = rig.computer
			let held = HeldRemote(remote: rig.remote, host: computer.host, on: heard, retry: .milliseconds(100), paired: { computer })
			_ = try await held.ensure()
			try await eventually("the event stream is up") { heard.ups == [true] }
			try await rig.host.command("cut \(rig.device)")
			try await eventually("the loss is reported") { heard.ups.prefix(2) == [true, false] }
			await held.stop()
		}
	}

	@Test("no computer waiting, the service's limits, no path and no meeting, each in the web client's words")
	func failures() async throws {
		try await withPeer(meet: .seconds(1)) { rig in
			let words = PairedWords(label: "Test Mac")
			let absent = PairedComputer(id: String(repeating: "A", count: 43), service: TEST_SERVICE, name: "Test Mac")
			let e1 = try await #require(throws: RemoteError.self) { try await rig.remote.connect(paired: absent) }
			#expect(e1.message == "Test Mac does not answer: it is off, asleep, or Pine is closed. This phone keeps trying, and connects when Test Mac is back.")

			try await rig.host.command("meeting limits")
			let e2 = try await #require(throws: RemoteError.self) { try await rig.connected() }
			#expect(e2.message == "The meeting service is over its limits for now. Try again later; this phone keeps trying meanwhile.")

			try await rig.host.command("meeting hold")
			let started = ContinuousClock.now
			let e3 = try await #require(throws: RemoteError.self) { try await rig.connected() }
			#expect(e3.message == "Test Mac is there, but no direct connection could be made from this network. Try another network (another Wi-Fi, or your phone's data); this phone keeps trying meanwhile.")
			#expect(ContinuousClock.now - started < .seconds(4), "within the time to the open channel")

			rig.routes.set("https://nowhere.test", "http://127.0.0.1:\(try freePort())")
			let nowhere = PairedComputer(id: rig.host.machineId, service: "https://nowhere.test", name: nil)
			let e4 = try await #require(throws: RemoteError.self) { try await rig.remote.connect(paired: nowhere) }
			#expect(e4.message == "Could not connect to your computer. The meeting service could not be reached. Check the network, then try again.")
			#expect(PairedWords(label: YOUR_COMPUTER).peer(.absent).hasPrefix("Your computer does not answer"))

			for e in [e1, e2, e3, e4] {
				#expect(e.kind == "ssh")
				#expect(e.hostKey == nil)
			}
			#expect(words.peer(.limits) == e2.message)
			#expect(rig.daemon.seen.isEmpty)
		}
	}

	@Test("a meeting service that is not https is never reached, for a paired computer or a pairing")
	func httpsOnly() async throws {
		try await withPeer { rig in
			// The app's own Remote: no route, as on the phone.
			let remote = Remote(key: rig.key, known: KnownHosts(rig.store))
			let http = PairedComputer(id: rig.host.machineId, service: rig.host.service, name: "Test Mac")
			let e = try await #require(throws: RemoteError.self) { try await remote.connect(paired: http) }
			#expect(e.hostKey == nil)
			let link = try #require(try await rig.host.command("open")["link"] as? String)
			let code = String(link.split(separator: ".").last!)
			let end = await remote.pair(PairLink(service: rig.host.service, id: rig.host.machineId, code: code), name: "Pine on a test") { _ in }.result()
			#expect(end != nil && end != .allowed(name: "Test Mac") && end != .expired)
			#expect(rig.host.events("connected").isEmpty, "no session reached the computer")
			#expect(rig.host.events("asked").isEmpty)
		}
	}

	@Test("a paired machine without what is kept for it is not connected to")
	func nothingKept() async throws {
		let remote = Remote(key: DeviceKey(SharedStore()), known: KnownHosts(SharedStore()))
		let id = String(repeating: "B", count: 43)
		let e = try await #require(throws: RemoteError.self) { try await remote.connect("paired:\(id)") }
		#expect(e.message.contains("pair it again"))
		let other = PairedComputer(id: String(repeating: "C", count: 43), service: TEST_SERVICE, name: nil)
		#expect(try await #require(throws: RemoteError.self) { try await remote.connect("paired:\(id)", paired: other) }.message.contains("pair it again"))
	}

	@Test("writes are cut into pieces of 16 KiB, wait while more than 1 MiB waits, and go on once there is room")
	func pieces() {
		var out = Outgoing()
		let sink = Sink()
		let bytes = pattern(3 * 1024 * 1024 + 5)
		out.add(ByteBuffer(bytes: bytes))
		#expect(out.drain(sink) == .paused)
		#expect(sink.pieces.allSatisfy { $0.count == PEER_PIECE })
		// It stops at the first piece that finds more than 1 MiB waiting.
		#expect(sink.buffered > PEER_HIGH && sink.buffered <= PEER_HIGH + PEER_PIECE)
		#expect(out.drain(sink) == .paused, "no room yet")
		let before = sink.pieces.count
		#expect(sink.pieces.count == before)
		sink.buffered = PEER_LOW
		#expect(out.drain(sink) == .paused)
		sink.buffered = 0
		while out.drain(sink) == .paused { sink.buffered = 0 }
		#expect(out.isEmpty)
		#expect(sink.pieces.allSatisfy { $0.count <= PEER_PIECE })
		#expect(Array(sink.pieces.joined()) == bytes, "whole and in order")

		let refusing = Sink()
		refusing.refuse = true
		var more = Outgoing()
		more.add(ByteBuffer(bytes: [1, 2, 3]))
		#expect(more.drain(refusing) == .failed)
	}

	@Test("only STUN and TURN servers of the service's configuration are used")
	func ice() {
		let config: [String: Any] = ["ice": [["urls": "stun:stun.example:3478"], ["urls": ["turn:t.example", "turns:t.example:443"]], ["urls": "http://x"], ["urls": ["stun:ok", "nope"]], "x"], "relay": false]
		#expect(iceServers(config) == ["stun:stun.example:3478", "turn:t.example", "turns:t.example:443"])
		#expect(iceServers(["ice": []]).isEmpty)
		#expect(iceServers(nil).isEmpty)
	}
}
