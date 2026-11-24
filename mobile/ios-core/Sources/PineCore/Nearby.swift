// Computers that announce themselves on the local network: the Pine app's Bonjour record
// (`_pine._tcp`, its TXT record `v=1`, `id=<machine id>`, `service=<https origin>`, `nonce=<22
// characters>`), read as the phone keeps it, and the list of those found, which the plugin hands the
// page as `nearby` events. What a record says is not trusted: the machine id is only where the phone
// looks, and the pairing checks the host key against it and shows the owner four digits on both
// screens (ADR 0005). The nonce is what the computer lets a codeless request in with (`nearby.<nonce>`):
// only a device that hears the announcement on the network has it, and it changes every few minutes.
// The same in the Kotlin core (Nearby.kt).
import Foundation

/** The Bonjour service type the Pine app announces itself with. */
public let NEARBY_TYPE = "_pine._tcp"

/** The meeting service the Pine app uses unless the owner names another (desktop/src/machines.ts `OFFICIAL_SERVICE`). */
public let OFFICIAL_SERVICE = "https://pine-main.drcmda.workers.dev"

/** Whether `nonce` has the shape of an announced one: 16 random bytes in base64url (desktop/electron/access/nearby.ts). */
public func nearbyNonce(_ nonce: String?) -> Bool {
	guard let nonce else { return false }
	return wholeMatch("[A-Za-z0-9_-]{22}", nonce) != nil
}

/**
 * A computer found on the network: its machine id, the meeting service it is reached through, and the
 * nonce of its announcement, which a codeless request names.
 */
public struct NearbyComputer: Equatable, Sendable {
	public let id: String
	public let service: String
	public let nonce: String

	public init(id: String, service: String, nonce: String) {
		self.id = id
		self.service = service
		self.nonce = nonce
	}

	/** As the page is told it. */
	public var json: [String: String] { ["id": id, "service": service, "nonce": nonce] }
}

/**
 * What the phone keeps of a TXT record, its keys in any case (RFC 6763 says they are compared
 * without it); nil for a record it ignores: a version other than 1, no machine id or one of another
 * shape, a service that is not an https origin, no nonce or one of another shape. A record without
 * a service names the official one. A key given without a value is `.some(nil)`.
 */
public func nearbyComputer(_ txt: [String: String?]) -> NearbyComputer? {
	var by: [String: String?] = [:]
	for (key, value) in txt { by[key.lowercased()] = value }
	guard case let .some(.some(v)) = by["v"], v == "1" else { return nil }
	guard case let .some(.some(id)) = by["id"], pairedFingerprint(id) != nil else { return nil }
	let service: String
	switch by["service"] {
	case .none: service = OFFICIAL_SERVICE
	case .some(.none): return nil
	case let .some(.some(given)):
		guard let origin = httpsOrigin(given)?.origin else { return nil }
		service = origin
	}
	guard case let .some(.some(nonce)) = by["nonce"], nearbyNonce(nonce) else { return nil }
	return NearbyComputer(id: id, service: service, nonce: nonce)
}

/**
 * The computers found so far, by the name each service was announced under: one computer may be
 * found under two names (on two networks, or renamed "Pine (2)"), and is listed once.
 */
public final class NearbyFound: @unchecked Sendable {
	private let lock = NSLock()
	private var names: [String] = []
	private var byName: [String: NearbyComputer] = [:]

	public init() {}

	/** A service resolved: kept when its record is one the phone reads. True when the list changed. */
	@discardableResult
	public func found(_ name: String, _ computer: NearbyComputer?) -> Bool {
		lock.withLock {
			let before = listed()
			if let computer {
				if byName[name] == nil { names.append(name) }
				byName[name] = computer
			} else {
				forget(name)
			}
			return listed() != before
		}
	}

	/** A service gone from the network. True when the list changed. */
	@discardableResult
	public func lost(_ name: String) -> Bool {
		lock.withLock {
			let before = listed()
			forget(name)
			return listed() != before
		}
	}

	public func clear() {
		lock.withLock {
			names = []
			byName = [:]
		}
	}

	/**
	 * Each computer once, the first found first. Of two records of the same machine id the one that
	 * names the official service is kept, else the first found: a later record cannot move the
	 * computer to a service of its choosing.
	 */
	public var list: [NearbyComputer] { lock.withLock { listed() } }

	/** What the page is told: `{computers: [{id, service, nonce}]}`. */
	public var event: [String: Any] { ["computers": list.map(\.json)] }

	private func forget(_ name: String) {
		byName[name] = nil
		names.removeAll { $0 == name }
	}

	private func listed() -> [NearbyComputer] {
		var order: [String] = []
		var kept: [String: NearbyComputer] = [:]
		for name in names {
			guard let c = byName[name] else { continue }
			if let first = kept[c.id] {
				if first.service != OFFICIAL_SERVICE, c.service == OFFICIAL_SERVICE { kept[c.id] = c }
			} else {
				order.append(c.id)
				kept[c.id] = c
			}
		}
		return order.map { kept[$0]! }
	}
}
