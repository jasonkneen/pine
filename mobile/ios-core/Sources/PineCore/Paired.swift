// A computer paired by its link, as the phone knows it: the pairing link the Pine app's QR code
// carries (or the web client hands the iOS app), the fingerprint its machine id stands for, the
// name the phone gives itself, and how such a machine is written in the list. The web client's
// rules (web/src/pairing.ts, desktop/src/machines.ts) and the Pine app's (cleanName and keyId in
// desktop/electron/access/store.ts) on the phone, as the Kotlin core's Paired.kt; mobile/cases
// holds both cores to them.
import Foundation

/** How a computer paired by its link is written among the machines: `paired:` and its machine id. */
public let PAIRED = "paired:"

/** A machine id: SHA-256 of the paired computer's SSH host key blob, base64url without padding. */
private let MACHINE_ID = "[A-Za-z0-9_-]{43}"

/** A pairing code: 16 random bytes, base64url without padding. */
private let PAIR_CODE = "[A-Za-z0-9_-]{22}"

/**
 * What a pairing link names: the meeting service every connection to that computer goes through
 * (`service`, an https origin), the computer's machine id and the one-time code.
 */
public struct PairLink: Equatable, Sendable {
	public let service: String
	public let id: String
	public let code: String

	public init(service: String, id: String, code: String) {
		self.service = service
		self.id = id
		self.code = code
	}
}

/** An https origin, scheme and host in lower case and without :443, and its host and port; nil for anything else. */
func httpsOrigin(_ text: String) -> (origin: String, host: String)? {
	guard let m = wholeMatch("(?i:https)://([A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?", text) else { return nil }
	let name = m[1].lowercased()
	let port = m[2].isEmpty ? nil : Int(m[2])
	if let port, !(1...65535).contains(port) { return nil }
	let host = port == nil || port == 443 ? name : "\(name):\(port!)"
	return ("https://\(host)", host)
}

/** Percent-decoding of a query value, without `+` for a space; nil for a broken escape. */
private func unescape(_ text: String) -> String? {
	var out = [UInt8]()
	var bytes = Array(text.utf8)[...]
	while let b = bytes.popFirst() {
		if b != UInt8(ascii: "%") {
			out.append(b)
			continue
		}
		guard bytes.count >= 2, let n = UInt8(String(decoding: bytes.prefix(2), as: UTF8.self), radix: 16), bytes.prefix(2).allSatisfy({ ($0 as UInt8).isHexDigit }) else { return nil }
		out.append(n)
		bytes = bytes.dropFirst(2)
	}
	return String(bytes: out, encoding: .utf8)
}

private extension UInt8 {
	var isHexDigit: Bool { (48...57).contains(self) || (65...70).contains(self) || (97...102).contains(self) }
}

/**
 * A pairing link, in either form: the web client's `<service origin>/#pair=<machine id>.<code>`, or
 * the app's own `pine://pair?service=<percent-encoded https origin>&id=<machine id>&code=<code>`.
 * Nil for anything else, a service that is not https included: the phone connects to nothing
 * else. Reading one starts nothing.
 */
public func pairLink(_ value: String?) -> PairLink? {
	guard let given = value?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
	let origin: String, id: String, code: String
	if given.hasPrefix("pine://pair?") {
		let parts: [(String, String)] = given.dropFirst("pine://pair?".count).split(separator: "&", omittingEmptySubsequences: false).map { part in
			let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
			return pair.count == 2 ? (String(pair[0]), String(pair[1])) : ("", "")
		}
		let byName: [String: String] = Dictionary(parts, uniquingKeysWith: { first, _ in first })
		guard parts.count == 3, Set(byName.keys) == ["service", "id", "code"], let service = unescape(byName["service"]!) else { return nil }
		(origin, id, code) = (service, byName["id"]!, byName["code"]!)
	} else {
		guard let hash = given.range(of: "#pair="), hash.lowerBound > given.startIndex, given[given.index(before: hash.lowerBound)] == "/" else { return nil }
		let ids = given[hash.upperBound...].split(separator: ".", omittingEmptySubsequences: false)
		guard ids.count == 2 else { return nil }
		(origin, id, code) = (String(given[..<given.index(before: hash.lowerBound)]), String(ids[0]), String(ids[1]))
	}
	guard let service = httpsOrigin(origin), wholeMatch(MACHINE_ID, id) != nil, wholeMatch(PAIR_CODE, code) != nil else { return nil }
	return PairLink(service: service.origin, id: id, code: code)
}

/** The longest address the app hands the page: more than any pairing link has. */
private let OPENED_LENGTH = 1024

/** The app's own address for a pairing, as the web client's "Open in the Pine app" writes it. */
private let OPENED_PREFIX = "pine://pair?"

/**
 * An address the app was opened with (its own scheme, Info.plist's `CFBundleURLTypes`, which any
 * app or page can open), as the plugin hands it to the page; nil when it drops it. Only what comes
 * as the web client's address for the app comes: `pine://pair?` and something after it, printable
 * ASCII, at most 1024 characters. Handing it on starts nothing: the page asks the owner, and `pair`
 * reads the link again with `pairLink`. Android is opened with an address of the web instead (Paired.kt).
 */
public func openedLink(_ value: String?) -> String? {
	guard let value, value.utf8.count <= OPENED_LENGTH, value.utf8.allSatisfy({ (0x21...0x7E).contains($0) }) else { return nil }
	guard value.hasPrefix(OPENED_PREFIX), value.utf8.count > OPENED_PREFIX.utf8.count else { return nil }
	return value
}

/** The host key fingerprint a machine id stands for, as OpenSSH prints it (`SHA256:` and base64); nil for what is not a machine id. */
public func pairedFingerprint(_ id: String) -> String? {
	guard wholeMatch(MACHINE_ID, id) != nil else { return nil }
	return "SHA256:" + id.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
}

/** The longest name the Pine app keeps for a device (`NAME_LENGTH`). */
private let NAME_LENGTH = 60

/**
 * A name to be shown as text, as the Pine app cleans a device's name: no terminal escape, no control
 * or format character, no spaces around it, at most 60 characters (code points).
 */
public func cleanName(_ text: String) -> String {
	let unescaped = text.replacingOccurrences(of: "\u{1b}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
	var kept = String.UnicodeScalarView()
	kept.append(contentsOf: unescaped.unicodeScalars.filter { ![.control, .format].contains($0.properties.generalCategory) })
	var cut = String.UnicodeScalarView()
	cut.append(contentsOf: String(kept).trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.prefix(NAME_LENGTH))
	return String(cut).trimmingCharacters(in: .whitespacesAndNewlines)
}

/** The name the phone gives itself when it pairs: "Pine on" and its model ("Pine on iPhone 17 Pro"). */
public func deviceName(_ model: String?) -> String {
	let named = cleanName(model ?? "")
	return named.isEmpty ? "Pine on a phone" : cleanName("Pine on \(named)")
}

/**
 * A computer paired by its link, as the list keeps it beside its `paired:<machine id>`: the meeting
 * service every connection to it goes through, and the name it gave when the owner allowed the
 * phone (none: the page says "your computer"). The machine id is the trusted host key: nothing else
 * is kept for it.
 */
public struct PairedComputer: Equatable, Sendable {
	public let id: String
	public let service: String
	public let name: String?

	public init(id: String, service: String, name: String?) {
		self.id = id
		self.service = service
		self.name = name
	}

	public var host: String { PAIRED + id }
}

/** A machine of the list: a computer paired by its link, or one reached over SSH as user@host[:port]. */
public enum Listed: Equatable, Sendable {
	case paired(id: String)
	case ssh(SshHost)

	public var given: String {
		switch self {
		case let .paired(id): PAIRED + id
		case let .ssh(host): host.given
		}
	}
}

/** A machine as it is stored: `paired:<machine id>` or what `sshHost` takes; nil for nothing written. */
public func listed(_ value: String?) throws -> Listed? {
	guard let given = value?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
	if given.hasPrefix(PAIRED) {
		let id = String(given.dropFirst(PAIRED.count))
		guard wholeMatch(MACHINE_ID, id) != nil else { throw RemoteError("ssh", "\"\(given.prefix(80))\" is not a paired computer: pair it again from the Pine app.") }
		return .paired(id: id)
	}
	return try sshHost(given).map { .ssh($0) }
}
