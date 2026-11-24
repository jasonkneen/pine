import Foundation

// The Pine app's real access host, as the peer of the paired path: mobile/test/support/access-host.ts
// (its line protocol is at its top), run under Node beside the meeting service on loopback ports, as
// the Kotlin core's tests run it. It needs `npm install` in desktop/.

/** The helper script, beside this package in the mobile folder. */
let accessHostScript = casesDir.deletingLastPathComponent().appendingPathComponent("test/support/access-host.ts")

struct HelperTrouble: Error, CustomStringConvertible {
	let description: String
}

/** One running helper: its first line, the lines it wrote since, and its standard input for commands. */
final class AccessHost: @unchecked Sendable {
	private let process = Process()
	private let input = Pipe()
	private let output = Pipe()
	private let lock = NSLock()
	private var lines: [[String: Any]] = []
	private var partial = Data()
	/** The meeting service's origin, `http://127.0.0.1:<port>`. */
	private(set) var service = ""
	/** This computer's machine id. */
	private(set) var machineId = ""
	/** The nonce its announcement carries now, which a codeless request names; `rotate()` changes it. */
	private(set) var nonce = ""

	/**
	 * Starts the helper; `serviceLine` points the access host at a daemon of the test's own. The meeting
	 * service it names (in a pairing link, on the pairing channel) is `TEST_SERVICE`, which a test's
	 * `Remote` routes to `service`.
	 */
	static func start(serviceLine: String? = nil, name: String = "Test Mac", options: [String] = []) async throws -> AccessHost {
		let host = AccessHost()
		try host.run(["--computer-name", name, "--service-name", TEST_SERVICE] + (serviceLine.map { ["--service-line", $0] } ?? []) + options)
		let ready = try await host.next { _ in true }
		guard ready["t"] as? String == "ready" else {
			await host.stop()
			throw HelperTrouble(description: "the access host helper did not start: \(ready["message"] ?? ready)")
		}
		host.service = ready["service"] as! String
		host.machineId = ready["machineId"] as! String
		host.nonce = ready["nonce"] as! String
		return host
	}

	private func run(_ args: [String]) throws {
		process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		process.arguments = ["node", accessHostScript.path] + args
		process.standardInput = input
		process.standardOutput = output
		process.standardError = FileHandle.nullDevice
		output.fileHandleForReading.readabilityHandler = { [weak self] handle in
			let data = handle.availableData
			guard let self, !data.isEmpty else { return }
			self.lock.withLock {
				self.partial.append(data)
				while let nl = self.partial.firstIndex(of: 10) {
					let line = self.partial[self.partial.startIndex..<nl]
					self.partial = Data(self.partial[(nl + 1)...])
					if let json = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { self.lines.append(json) }
				}
			}
		}
		try process.run()
	}

	/** The first line from `from` on that `matches`, within `limit`; it is taken from those still to come. */
	private func next(after from: Int = 0, within limit: Duration = .seconds(20), _ matches: @escaping ([String: Any]) -> Bool) async throws -> [String: Any] {
		let until = ContinuousClock.now + limit
		while true {
			let found = lock.withLock { lines.indices.dropFirst(from).first { matches(lines[$0]) }.map { lines[$0] } }
			if let found { return found }
			if ContinuousClock.now > until || !process.isRunning { throw HelperTrouble(description: "the access host helper did not say it in time (\(lock.withLock { lines }))") }
			try await Task.sleep(for: .milliseconds(10))
		}
	}

	/** One command, and its answer. */
	@discardableResult
	func command(_ line: String) async throws -> [String: Any] {
		let word = String(line.split(separator: " ")[0])
		let from = lock.withLock { lines.count }
		try input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
		let answer = try await next(after: from) { ($0["t"] as? String) == word || (($0["t"] as? String) == "error" && ($0["to"] as? String) == word) }
		if answer["t"] as? String == "error" { throw HelperTrouble(description: "\(word): \(answer["message"] ?? "")") }
		return answer
	}

	/** A new nonce, as the announcement gets every few minutes: the one before still works, not the one before that. */
	@discardableResult
	func rotate() async throws -> String {
		let fresh = try await command("rotate")["nonce"] as! String
		nonce = fresh
		return fresh
	}

	/** Pairs the phone's key directly, as if the owner had allowed it before. */
	func add(_ publicKey: String, name: String = "Pine on a test") async throws -> String {
		let parts = publicKey.split(separator: " ")
		return try await command("add \(parts[0]) \(parts[1]) \(name)")["id"] as! String
	}

	/** Whether an event `t` for `id` was written. */
	func saw(_ t: String, _ id: String) -> Bool {
		lock.withLock { lines.contains { $0["t"] as? String == t && $0["id"] as? String == id } }
	}

	/** The events `t` written so far, in order. */
	func events(_ t: String) -> [[String: Any]] {
		lock.withLock { lines.filter { $0["t"] as? String == t } }
	}

	/** Ends it as the protocol says: its standard input closed, then its exit waited for (and forced after ten seconds). */
	func stop() async {
		output.fileHandleForReading.readabilityHandler = nil
		try? input.fileHandleForWriting.close()
		let until = ContinuousClock.now + .seconds(10)
		while process.isRunning, ContinuousClock.now < until {
			try? await Task.sleep(for: .milliseconds(20))
		}
		if process.isRunning { process.terminate() }
	}
}
