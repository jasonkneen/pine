// A machine's pine held while the app runs, as desktop/electron/main.ts holds one and Held.kt on
// Android: its SSH session, and its events followed. iOS may have cut the link while the app was in
// the background, so a held session is asked whether it still answers before it is used again
// (`answers`, main.ts's probe), and one whose event stream is lost five times in a row is made anew.
import Foundation

/** Whether a daemon still answers: `GET /health`, which needs no token, within `limit`. */
public func answers(_ daemon: Daemon, within limit: Duration = .milliseconds(2500)) async -> Bool {
	guard let conn = try? await daemon.open() else { return false }
	defer { conn.close() }
	return await withTaskGroup(of: Bool.self) { group in
		group.addTask {
			do {
				try await send(daemon, conn, method: "GET", url: "/health", authorized: false)
				return (200...299).contains(try await readResponse(Reader(conn)).status)
			} catch {
				return false
			}
		}
		group.addTask {
			try? await Task.sleep(for: limit)
			// What waits on the connection ends with it.
			conn.close()
			return false
		}
		let first = await group.next() ?? false
		group.cancelAll()
		return first
	}
}

/** One at a time: what `synchronized` is to the Kotlin core, for code that awaits. */
actor Turn {
	private var busy = false
	private var waiting: [CheckedContinuation<Void, Never>] = []

	func take() async {
		if !busy {
			busy = true
			return
		}
		await withCheckedContinuation { waiting.append($0) }
	}

	func give() {
		if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
	}

	func run<T: Sendable>(_ work: @Sendable () async throws -> T) async rethrows -> T {
		await take()
		do {
			let result = try await work()
			give()
			return result
		} catch {
			give()
			throw error
		}
	}
}

/**
 * The pine of the machine `host` names, held: `ensure()` connects or makes sure the held session
 * still answers, and follows its events into `on`. When the stream is lost five times in a row the
 * session is let go of and made again; `failed` hears it when that cannot be done.
 */
public final class HeldRemote: @unchecked Sendable {
	public let host: String
	private let remote: Remote
	private let on: EventHandlers
	private let failed: @Sendable (Error) -> Void
	private let retry: Duration
	private let batch: Duration
	/** What is kept for a paired computer, read again at each connection (it is paired anew, say). */
	private let paired: @Sendable () -> PairedComputer?
	private let turn = Turn()
	private let lock = NSLock()
	private var following: Following?
	private var stopped = false
	private var _service: RemoteService?

	public init(remote: Remote, host: String, on: EventHandlers, failed: @escaping @Sendable (Error) -> Void = { _ in }, retry: Duration = .seconds(1), batch: Duration = .milliseconds(24), paired: @escaping @Sendable () -> PairedComputer? = { nil }) {
		self.remote = remote
		self.host = host
		self.on = on
		self.failed = failed
		self.retry = retry
		self.batch = batch
		self.paired = paired
	}

	/** The session in use, if there is one. */
	public var service: RemoteService? { lock.withLock { _service } }

	/** The held session when it still answers, else a new one (a `RemoteError` when it cannot be made). */
	@discardableResult
	public func ensure() async throws -> RemoteService {
		try await turn.run { try await self.ensureInTurn() }
	}

	private func ensureInTurn() async throws -> RemoteService {
		if let s = service, s.isOpen, await answers(s) { return s }
		await letGo()
		let s = try await remote.connect(host, paired: paired())
		let kept = lock.withLock {
			if stopped { return false }
			_service = s
			return true
		}
		if !kept {
			await s.stop()
			throw RemoteError("failed", "The connection to \(host) was closed.")
		}
		let f = followEvents(s, Relay(on) { [weak self] times in
			// An SSH connection that broke does not come back by waiting: it is made again.
			// A data channel that ended took its session with it: nothing comes back by waiting there
			// (that path has no TCP keepalive to say so later), so it is made again at the first loss.
			guard times == 5 || (s.paired && !s.isOpen) else { return false }
			Task.detached { await self?.again(s) }
			return true
		}, retry: retry, batch: batch)
		lock.withLock { following = f }
		return s
	}

	private func again(_ lost: RemoteService) async {
		let go = await turn.run { () -> Bool in
			guard !self.lock.withLock({ self.stopped }), self.service === lost else { return false }
			await self.letGo()
			return true
		}
		guard go else { return }
		do {
			try await ensure()
		} catch {
			failed(error)
		}
	}

	private func letGo() async {
		let (f, s) = lock.withLock {
			defer {
				following = nil
				_service = nil
			}
			return (following, _service)
		}
		f?.stop()
		await s?.stop()
	}

	/** Lets go of the session: a daemon it started there stops. */
	public func stop() async {
		lock.withLock { stopped = true }
		await turn.run { await self.letGo() }
	}
}

/** The caller's handlers, with what to do after a loss decided here first. */
private final class Relay: EventHandlers, @unchecked Sendable {
	private let to: EventHandlers
	private let onLoss: (Int) -> Bool

	init(_ to: EventHandlers, onLoss: @escaping (Int) -> Bool) {
		self.to = to
		self.onLoss = onLoss
	}

	func batch(_ events: [Any]) { to.batch(events) }
	func connection(_ up: Bool) { to.connection(up) }
	func lost(_ times: Int) -> Bool { onLoss(times) || to.lost(times) }
}
