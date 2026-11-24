// The way to a paired computer: a WebRTC data channel made through the meeting service, as
// web/src/peer.ts makes it in the web client, on libdatachannel (the library the Pine app's access
// host runs on), whose C interface is wrapped here. The meeting service only passes the few messages
// that set the connection up; what crosses the channel is SSH, end to end, checked against the
// machine id's host key (PeerRemote.swift).
//
// swift-nio-ssh runs on a NIO channel, and NIO has none over a data channel. So the channel is
// bridged through a socket pair: one end is the SSH session's channel, an ordinary NIO socket
// channel; the other end is pumped by `Pump`, which writes what the data channel brings into it and
// sends what SSH writes onto the data channel, cut into pieces, holding back while too much waits.
import Foundation
import NIOCore
import NIOPosix
import libdatachannel

/** The channel the phone makes and the paired computer takes. */
let PEER_LABEL = "ssh"
/** Writes are cut to this: the size every data channel carries without trouble. */
let PEER_PIECE = 16 * 1024
/** Writing waits while more than this waits in the channel, and goes on once it fell to `PEER_LOW`. */
let PEER_HIGH = 1024 * 1024
let PEER_LOW = 256 * 1024

/** The meeting's close codes (web/relay/src/meet.ts `CLOSE`) that say why a meeting ended. */
private let ABSENT = 4404
private let TIMEOUT = 4408
private let LIMITS = 4429

/** Why no channel to the paired computer opened, as the web client's `PeerClosed` says it. */
struct PeerClosed: Error, Equatable, CustomStringConvertible {
	enum Reason: Equatable, Sendable {
		/** No computer waits under its machine id: it is off, asleep, or Pine is closed. */
		case absent
		/** The computer is there, but no connection was made in time. */
		case noPath
		/** The meeting service is over its limits. */
		case limits
		/** The meeting service could not be reached at all. */
		case noService
	}

	let reason: Reason
	let detail: String

	init(_ reason: Reason, _ detail: String = "") {
		self.reason = reason
		self.detail = detail
	}

	var description: String { detail.isEmpty ? "\(reason)" : detail }
}

/** A meeting that ended before the channel opened, by its close code. */
private func whyClosed(_ code: Int) -> PeerClosed {
	if code == ABSENT { return PeerClosed(.absent) }
	if code == LIMITS { return PeerClosed(.limits) }
	if code == TIMEOUT { return PeerClosed(.noPath) }
	// The computer ended the meeting (it has as many phones as it takes), or the service went: no way this time.
	return PeerClosed(.noPath, "The meeting ended before a connection to the computer was made (\(code)).")
}

/** The servers that help a connection, as the service's configuration names them (`{ice: [{urls}]}`); anything that is not a STUN or TURN address is left out. */
func iceServers(_ config: Any?) -> [String] {
	guard let ice = (config as? [String: Any])?["ice"] as? [Any] else { return [] }
	let fits = { (u: Any) -> Bool in (u as? String).map { wholeMatch("(stun|stuns|turn|turns):[^\\s]+", $0) != nil } ?? false }
	var out: [String] = []
	for server in ice {
		guard let urls = (server as? [String: Any])?["urls"] else { continue }
		if fits(urls) { out.append(urls as! String) }
		else if let list = urls as? [Any], !list.isEmpty, list.allSatisfy(fits) { out += list.map { $0 as! String } }
	}
	return out
}

/** What the data channel says besides its bytes. */
enum PeerEvent: Sendable {
	case open
	/** What waits in the channel fell to `PEER_LOW`. */
	case low
	/** The channel or the peer connection closed or failed: the end of the stream. Said once. */
	case ended
}

/**
 * The links that are alive, by a number of their own: libdatachannel calls back through C function
 * pointers, which capture nothing, with the number as the user pointer. A callback that comes after
 * its link went finds nothing, instead of an object that is gone.
 */
private final class Links: @unchecked Sendable {
	static let shared = Links()
	private let lock = NSLock()
	private var next = 1
	private var all: [Int: PeerLink] = [:]

	func add(_ link: PeerLink) -> Int {
		lock.withLock {
			defer { next += 1 }
			all[next] = link
			return next
		}
	}

	func remove(_ token: Int) { _ = lock.withLock { all.removeValue(forKey: token) } }

	func find(_ ptr: UnsafeMutableRawPointer?) -> PeerLink? {
		guard let ptr else { return nil }
		let token = Int(bitPattern: ptr)
		return lock.withLock { all[token] }
	}
}

/**
 * One peer connection with its one channel `ssh`, ordered and reliable. Bytes that arrive before
 * anyone listens are kept for the listener (SSH's banner comes as soon as the channel opens).
 * Callbacks run on libdatachannel's threads; nothing is ever deleted from one of them.
 */
final class PeerLink: @unchecked Sendable {
	private let lock = NSLock()
	private var token = 0
	private var pc: Int32 = -1
	private var dc: Int32 = -1
	private var early: [[UInt8]] = []
	private var listener: (([UInt8]) -> Void)?
	private var handler: ((PeerEvent) -> Void)?
	private var over = false
	private let signal: @Sendable ([String: Any]) -> Void

	/** A connection that offers itself through `signal` (the offer, then its candidates) and tells `events` what happens. */
	init(ice: [String], signal: @escaping @Sendable ([String: Any]) -> Void, events: @escaping (PeerEvent) -> Void) throws {
		self.signal = signal
		handler = events
		token = Links.shared.add(self)
		let user = UnsafeMutableRawPointer(bitPattern: token)
		var config = rtcConfiguration()
		let made: Int32 = withCStrings(ice) { servers in
			config.iceServers = servers
			config.iceServersCount = Int32(ice.count)
			return rtcCreatePeerConnection(&config)
		}
		guard made >= 0 else {
			Links.shared.remove(token)
			throw PeerClosed(.noPath, "No connection could be offered to the computer.")
		}
		pc = made
		rtcSetUserPointer(pc, user)
		rtcSetLocalDescriptionCallback(pc) { _, sdp, type, ptr in
			guard let link = Links.shared.find(ptr), let sdp, let type else { return }
			link.signal(["sdp": ["type": String(cString: type), "sdp": String(cString: sdp)]])
		}
		rtcSetLocalCandidateCallback(pc) { _, candidate, mid, ptr in
			guard let link = Links.shared.find(ptr), let candidate else { return }
			let text = String(cString: candidate)
			// The web client's form: the candidate line without SDP's "a=".
			link.signal(["ice": ["candidate": text.hasPrefix("a=") ? String(text.dropFirst(2)) : text, "sdpMid": mid.map { String(cString: $0) } ?? "0", "sdpMLineIndex": 0]])
		}
		rtcSetStateChangeCallback(pc) { _, state, ptr in
			if state == RTC_FAILED || state == RTC_CLOSED { Links.shared.find(ptr)?.close() }
		}
		dc = rtcCreateDataChannel(pc, PEER_LABEL)
		guard dc >= 0 else {
			close()
			throw PeerClosed(.noPath, "No connection could be offered to the computer.")
		}
		rtcSetUserPointer(dc, user)
		rtcSetBufferedAmountLowThreshold(dc, Int32(PEER_LOW))
		rtcSetOpenCallback(dc) { _, ptr in Links.shared.find(ptr)?.tell(.open) }
		rtcSetClosedCallback(dc) { _, ptr in Links.shared.find(ptr)?.close() }
		rtcSetErrorCallback(dc) { _, _, ptr in Links.shared.find(ptr)?.close() }
		rtcSetBufferedAmountLowCallback(dc) { _, ptr in Links.shared.find(ptr)?.tell(.low) }
		rtcSetMessageCallback(dc) { _, message, size, ptr in
			// A negative size is a text message: the paired path carries bytes only.
			guard let message, size >= 0, let link = Links.shared.find(ptr) else { return }
			link.heard(Array(UnsafeRawBufferPointer(start: message, count: Int(size))))
		}
	}

	private func tell(_ event: PeerEvent) {
		let to = lock.withLock { over ? nil : handler }
		to?(event)
	}

	private func heard(_ bytes: [UInt8]) {
		// Under the lock, so that what was kept and what comes next reach the listener in order.
		lock.withLock {
			if over { return }
			if let listener { listener(bytes) } else { early.append(bytes) }
		}
	}

	/** The computer's answer. */
	func answer(_ sdp: String) -> Bool { rtcSetRemoteDescription(pc, sdp, "answer") >= 0 }

	/** One of the computer's candidates. */
	func candidate(_ line: String, mid: String?) {
		_ = rtcAddRemoteCandidate(pc, line, mid ?? "0")
	}

	/**
	 * From now on bytes go to `listener` (what was kept first) and events to `events`. False when the
	 * link has ended already; `events` then hears nothing.
	 */
	func attach(listener: @escaping ([UInt8]) -> Void, events: @escaping (PeerEvent) -> Void) -> Bool {
		lock.withLock {
			if over { return false }
			handler = events
			self.listener = listener
			for bytes in early { listener(bytes) }
			early.removeAll()
			return true
		}
	}

	/** How many bytes wait in the channel to be sent. */
	var buffered: Int { Int(max(0, rtcGetBufferedAmount(dc))) }

	/** Sends one piece; false when the channel took it not. */
	func send(_ bytes: UnsafeRawBufferPointer) -> Bool {
		rtcSendMessage(dc, bytes.baseAddress?.assumingMemoryBound(to: CChar.self), Int32(bytes.count)) >= 0
	}

	/** Ends the channel and the connection; `ended` is said once. Safe from any thread, a callback's included. */
	func close() {
		let (to, pc, dc, token) = lock.withLock { () -> (((PeerEvent) -> Void)?, Int32, Int32, Int) in
			if over { return (nil, -1, -1, 0) }
			over = true
			listener = nil
			early.removeAll()
			defer { handler = nil }
			return (handler, self.pc, self.dc, self.token)
		}
		guard token != 0 else { return }
		to?(.ended)
		// libdatachannel's objects are never deleted from one of its own callbacks.
		DispatchQueue.global().async {
			if dc >= 0 { rtcDelete(dc) }
			if pc >= 0 { rtcDeletePeerConnection(pc) }
			Links.shared.remove(token)
		}
	}
}

/** `body` with `strings` as an array of C strings that lives as long as the call. */
private func withCStrings<T>(_ strings: [String], _ body: (UnsafeMutablePointer<UnsafePointer<CChar>?>?) -> T) -> T {
	let copies = strings.map { strdup($0) }
	defer { copies.forEach { free($0) } }
	var pointers = copies.map { UnsafePointer<CChar>($0) }
	return pointers.isEmpty ? body(nil) : pointers.withUnsafeMutableBufferPointer { body($0.baseAddress) }
}

/**
 * The meeting for one machine id: the join socket of the meeting service, the offer and the `ssh`
 * channel, the computer's answer and the candidates both ways. The computer's candidates may come
 * before its answer is set: they wait for it. Once the channel is open the socket is closed: the
 * meeting has done its part.
 */
private final class Meeting: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
	private let lock = NSLock()
	private let url: URL
	private let ice: [String]
	private var session: URLSession!
	private var task: URLSessionWebSocketTask!
	private var continuation: CheckedContinuation<PeerLink, Error>?
	private var link: PeerLink?
	private var opened = false
	private var answered = false
	private var pending: [(String, String?)] = []
	private var settled = false

	init(url: URL, ice: [String]) {
		self.url = url
		self.ice = ice
	}

	func run(within limit: Duration) async throws -> PeerLink {
		try await withCheckedThrowingContinuation { (c: CheckedContinuation<PeerLink, Error>) in
			lock.withLock { continuation = c }
			session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
			task = session.webSocketTask(with: url)
			task.resume()
			receive()
			Task.detached { [weak self] in
				try? await Task.sleep(for: limit)
				self?.finish(.failure(PeerClosed(.noPath)))
			}
		}
	}

	private func finish(_ result: Result<PeerLink, Error>) {
		let (c, link) = lock.withLock { () -> (CheckedContinuation<PeerLink, Error>?, PeerLink?) in
			if settled { return (nil, nil) }
			settled = true
			defer { continuation = nil }
			return (continuation, self.link)
		}
		guard let c else { return }
		switch result {
		case .success:
			task.cancel(with: .normalClosure, reason: Data("The channel is open.".utf8))
		case .failure:
			task.cancel()
			link?.close()
		}
		session.finishTasksAndInvalidate()
		c.resume(with: result)
	}

	private func send(_ d: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: ["t": "signal", "d": d]) else { return }
		task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
	}

	private func receive() {
		task.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .success(let message):
				let text: String
				switch message {
				case .string(let s): text = s
				case .data(let d): text = String(decoding: d, as: UTF8.self)
				@unknown default: text = ""
				}
				self.heard(text)
				self.receive()
			case .failure:
				self.ended(code: self.task.closeCode.rawValue)
			}
		}
	}

	private func ended(code: Int) {
		let wasOpen = lock.withLock { opened }
		// A socket that never opened: the service could not be reached, or refused it outright.
		if !wasOpen { return finish(.failure(PeerClosed(.noService))) }
		finish(.failure(whyClosed(code == 0 ? 1006 : code)))
	}

	private func heard(_ text: String) {
		guard let message = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
		if message["t"] as? String == "ready" {
			if lock.withLock({ link != nil || settled }) { return }
			do {
				let made = try PeerLink(ice: ice, signal: { [weak self] d in self?.send(d) }) { [weak self] event in
					switch event {
					case .open:
						if let self, let link = self.lock.withLock({ self.link }) { self.finish(.success(link)) }
					case .ended:
						self?.finish(.failure(PeerClosed(.noPath)))
					case .low:
						break
					}
				}
				// The time limit or the socket's end may have settled the attempt while the link was made:
				// finish() closed no link then, so this one is closed here, or it stays registered for good.
				let kept = lock.withLock { () -> Bool in
					if settled { return false }
					link = made
					return true
				}
				if !kept { made.close() }
			} catch {
				finish(.failure(error))
			}
			return
		}
		guard message["t"] as? String == "signal", let d = message["d"] as? [String: Any], let link = lock.withLock({ self.link }) else { return }
		// A message that does not fit this connection changes nothing: the time limit ends the attempt.
		if let sdp = d["sdp"] as? [String: Any], sdp["type"] as? String == "answer", let text = sdp["sdp"] as? String {
			guard link.answer(text) else { return }
			let waiting = lock.withLock {
				answered = true
				defer { pending.removeAll() }
				return pending
			}
			for (line, mid) in waiting { link.candidate(line, mid: mid) }
		} else if let ice = d["ice"] as? [String: Any], let line = ice["candidate"] as? String, !line.isEmpty {
			let mid = ice["sdpMid"] as? String
			let now = lock.withLock {
				if !answered { pending.append((line, mid)) }
				return answered
			}
			if now { link.candidate(line, mid: mid) }
		}
	}

	func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
		lock.withLock { opened = true }
	}

	func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
		ended(code: closeCode.rawValue)
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		if error != nil { ended(code: self.task.closeCode.rawValue) }
	}
}

/** The service's configuration (`GET /meet/config`), read within a few seconds; nil when it cannot be. */
private func meetConfig(_ service: URL) async -> Any? {
	var request = URLRequest(url: service.appendingPathComponent("meet/config"))
	request.timeoutInterval = 5
	let session = URLSession(configuration: .ephemeral)
	defer { session.finishTasksAndInvalidate() }
	guard let (data, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
	return try? JSONSerialization.jsonObject(with: data)
}

/**
 * Opens the way to the paired computer `id` through the meeting service at `service` (an https
 * origin, and nothing else), within `limit` from the join to the open channel. Throws `PeerClosed`.
 * `route` is where that origin is reached: itself, except in a test (`Remote.route`).
 */
func openPeer(service: String, id: String, within limit: Duration, route: (String) -> String = { $0 }) async throws -> PeerLink {
	guard httpsOrigin(service)?.origin == service else { throw PeerClosed(.noService, "A meeting service is an https address.") }
	guard let base = URL(string: route(service) + "/"), var join = URLComponents(url: base.appendingPathComponent("meet/join"), resolvingAgainstBaseURL: false) else {
		throw PeerClosed(.noService)
	}
	let ice = iceServers(await meetConfig(base))
	join.scheme = join.scheme == "https" ? "wss" : "ws"
	join.queryItems = [URLQueryItem(name: "id", value: id)]
	guard let url = join.url else { throw PeerClosed(.noService) }
	return try await Meeting(url: url, ice: ice).run(within: limit)
}

/**
 * What SSH writes, on its way onto the data channel: pieces of at most `PEER_PIECE`, sent while no
 * more than `PEER_HIGH` waits in the channel; the rest waits for room.
 */
struct Outgoing {
	private var pending: [ByteBuffer] = []

	var isEmpty: Bool { pending.isEmpty }

	mutating func add(_ bytes: ByteBuffer) {
		if bytes.readableBytes > 0 { pending.append(bytes) }
	}

	/**
	 * Sends what it can into `sink`. `.paused` when bytes are left that wait for room, `.failed`
	 * when the sink refused a piece.
	 */
	mutating func drain(_ sink: PieceSink) -> Drained {
		while !pending.isEmpty {
			if sink.buffered > PEER_HIGH { return .paused }
			let n = min(PEER_PIECE, pending[0].readableBytes)
			let ok = pending[0].readableBytesView.prefix(n).withUnsafeBytes { sink.send($0) }
			if !ok { return .failed }
			pending[0].moveReaderIndex(forwardBy: n)
			if pending[0].readableBytes == 0 { pending.removeFirst() }
		}
		return .done
	}

	enum Drained: Equatable { case done, paused, failed }
}

/** Where `Outgoing` sends its pieces: the data channel, or a test's stand-in. */
protocol PieceSink {
	var buffered: Int { get }
	func send(_ piece: UnsafeRawBufferPointer) -> Bool
}

extension PeerLink: PieceSink {}

/**
 * The pumped end of the socket pair: what arrives from the data channel is written into it, what
 * SSH wrote at the other end is read from it and sent. While the channel has no room it is not
 * read, so that SSH's own writes wait. Either side's end closes the other.
 */
private final class Pump: ChannelInboundHandler {
	typealias InboundIn = ByteBuffer
	typealias OutboundOut = ByteBuffer

	private let link: PeerLink
	private var outgoing = Outgoing()
	private var context: ChannelHandlerContext?

	init(_ link: PeerLink) {
		self.link = link
	}

	func channelActive(context: ChannelHandlerContext) {
		self.context = context
		context.fireChannelActive()
		let channel = context.channel
		let me = NIOLoopBound(self, eventLoop: context.eventLoop)
		let loop = context.eventLoop
		let alive = link.attach(
			listener: { bytes in channel.writeAndFlush(ByteBuffer(bytes: bytes), promise: nil) },
			events: { event in
				switch event {
				case .low: loop.execute { me.value.room() }
				case .ended: channel.close(promise: nil)
				case .open: break
				}
			}
		)
		if !alive { context.close(promise: nil) }
	}

	func handlerRemoved(context: ChannelHandlerContext) {
		self.context = nil
	}

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		outgoing.add(unwrapInboundIn(data))
		send()
	}

	/** The channel has room again. */
	private func room() {
		guard context != nil else { return }
		send()
	}

	private func send() {
		guard let context else { return }
		switch outgoing.drain(link) {
		case .done:
			if context.channel.isActive, (try? context.channel.syncOptions?.getOption(.autoRead)) == false {
				try? context.channel.syncOptions?.setOption(.autoRead, value: true)
				context.read()
			}
		case .paused:
			try? context.channel.syncOptions?.setOption(.autoRead, value: false)
		case .failed:
			link.close()
			context.close(promise: nil)
		}
	}

	func channelInactive(context: ChannelHandlerContext) {
		link.close()
		context.fireChannelInactive()
	}

	func errorCaught(context: ChannelHandlerContext, error: Error) {
		link.close()
		context.close(promise: nil)
	}
}

extension PeerLink {
	/**
	 * The data channel as a NIO channel, made by `initializer` (swift-nio-ssh's handlers): the end of
	 * a socket pair whose other end `Pump` feeds from the channel and empties onto it. Closing that
	 * NIO channel ends the link, and the link's end closes it.
	 */
	func bridge(group: EventLoopGroup, _ initializer: @escaping @Sendable (Channel) -> EventLoopFuture<Void>) async throws -> Channel {
		var fds: [Int32] = [-1, -1]
		guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else {
			close()
			throw PeerClosed(.noPath, "No socket pair for the connection (errno \(errno)).")
		}
		// Room for a few pieces each way, so that a write is not cut into tiny ones.
		var size: Int32 = 256 * 1024
		for fd in fds {
			setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
			setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
		}
		let link = self
		do {
			_ = try await ClientBootstrap(group: group)
				.channelInitializer { channel in channel.eventLoop.makeCompletedFuture { try channel.pipeline.syncOperations.addHandler(Pump(link)) } }
				.withConnectedSocket(fds[1]).get()
		} catch {
			Darwin.close(fds[0])
			Darwin.close(fds[1])
			close()
			throw error
		}
		do {
			return try await ClientBootstrap(group: group).channelInitializer(initializer).withConnectedSocket(fds[0]).get()
		} catch {
			Darwin.close(fds[0])
			close()
			throw error
		}
	}
}
