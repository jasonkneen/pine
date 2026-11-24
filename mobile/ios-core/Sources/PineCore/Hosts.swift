// What names the other machine, and where its daemon may answer: src/remote.ts's `sshHost` and
// `loopbackEnd`, on the phone, as the Kotlin core's Hosts.kt. Kept the same on purpose: a change
// there is a change here, and mobile/cases holds both cores to it.
import Foundation

/**
 * Why a connection did not come about. `kind` is "ssh" (not reached, or pine is not there) or
 * "failed" (its pine said why it did not start), as `RemoteError` in src/remote.ts. `hostKey` is set
 * when the machine's host key is the reason: Kotlin's `HostKeyError`.
 */
public struct RemoteError: Error, Equatable, CustomStringConvertible {
	public let kind: String
	public let message: String
	public let hostKey: HostKeyRefusal?
	/**
	 * A trouble that may pass by itself (the network, a computer that sleeps): a paired computer is
	 * tried again after it, with a growing wait. One only the owner can fix is not.
	 */
	public let passing: Bool

	public init(_ kind: String, _ message: String, hostKey: HostKeyRefusal? = nil, passing: Bool = false) {
		self.kind = kind
		self.message = message
		self.hostKey = hostKey
		self.passing = passing
	}

	public var description: String { message }
}

/**
 * The machine's host key is not the one the owner confirmed, or none was confirmed yet. `fingerprint`
 * is the key's SHA256 fingerprint as OpenSSH prints it; for an unknown key, confirming that
 * fingerprint (`KnownHosts.confirm`) lets the next connection through. A changed key is refused
 * until the stored one is forgotten.
 */
public struct HostKeyRefusal: Equatable, Sendable {
	public let host: String
	public let port: Int
	public let fingerprint: String
	public let changed: Bool
}

/** A machine as the owner wrote it (`given`), and its parts. `label` is the host without the user and the domain. */
public struct SshHost: Equatable, Sendable {
	public let given: String
	public let user: String?
	public let host: String
	public let port: Int
	public let label: String

	public init(given: String, user: String?, host: String, port: Int, label: String) {
		self.given = given
		self.user = user
		self.host = host
		self.port = port
		self.label = label
	}
}

/**
 * The groups of a whole match of `pattern` in `text` (an empty string for a group that took no part),
 * or nil. Whole means to the last character: `\z`, since ICU's `$` also matches before a line break
 * that ends the text.
 */
func wholeMatch(_ pattern: String, _ text: String) -> [String]? {
	let regex = try! NSRegularExpression(pattern: "^(?:\(pattern))\\z")
	let all = NSRange(text.startIndex..., in: text)
	guard let m = regex.firstMatch(in: text, range: all) else { return nil }
	return (0..<m.numberOfRanges).map { i in
		Range(m.range(at: i), in: text).map { String(text[$0]) } ?? ""
	}
}

/** What may name the other machine: host, user@host or user@host:port, never an option for ssh. */
public func sshHost(_ value: String?) throws -> SshHost? {
	guard let given = value?.trimmingCharacters(in: .whitespacesAndNewlines), !given.isEmpty else { return nil }
	let refused = RemoteError("ssh", "\"\(given.prefix(80))\" is not a host for ssh. Write it as host, user@host or user@host:port.")
	// A paired computer (Paired.swift), never a host "paired" whose port follows the colon.
	if given.hasPrefix(PAIRED) { throw refused }
	let colon = given.lastIndex(of: ":")
	let name = colon.map { String(given[..<$0]) } ?? given
	var port = 22
	if let colon {
		let digits = String(given[given.index(after: colon)...])
		guard wholeMatch("[0-9]{1,5}", digits) != nil, let n = Int(digits) else { throw refused }
		port = n
	}
	guard wholeMatch("[A-Za-z0-9_][A-Za-z0-9_.@-]*", name) != nil, (1...65535).contains(port), name.filter({ $0 == "@" }).count <= 1 else { throw refused }
	let at = name.firstIndex(of: "@")
	let user = at.map { String(name[..<$0]) }.flatMap { $0.isEmpty ? nil : $0 }
	let host = at.map { String(name[name.index(after: $0)...]) } ?? name
	if host.isEmpty { throw refused }
	// An address is its own short name: its first number alone would name nothing.
	let first = host.split(separator: ".", omittingEmptySubsequences: false)[0]
	let label = wholeMatch("[0-9.]+", host) != nil ? host : (first.isEmpty ? host : String(first))
	return SshHost(given: given, user: user, host: host, port: port, label: label)
}

/** Where the other machine's daemon answers: a port of its own loopback. `hostHeader` is what the daemon expects in `Host`. */
public struct Loopback: Equatable, Sendable {
	public let host: String
	public let port: Int

	public init(host: String, port: Int) {
		self.host = host
		self.port = port
	}

	public var hostHeader: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }
}

/**
 * A daemon always listens on loopback, so a service line that names anything else is not taken:
 * the channel would carry the token to another host.
 */
public func loopbackEnd(_ base: String) throws -> Loopback {
	let m = wholeMatch(#"http://(?:\[(::1)\]|(127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})):([0-9]{1,5})(?:[/?#].*)?"#, base)
	let host = m.map { $0[1].isEmpty ? $0[2] : $0[1] }
	let port = m.flatMap { Int($0[3]) }
	let octets = host.map { $0 == "::1" || $0.split(separator: ".").allSatisfy { Int($0)! <= 255 } } ?? true
	guard let host, let port, (1...65535).contains(port), octets else {
		throw RemoteError("failed", "The other machine's pine says it answers at \(base.prefix(80)), which is not a port of its own loopback. Only that is connected to.")
	}
	return Loopback(host: host, port: port)
}
