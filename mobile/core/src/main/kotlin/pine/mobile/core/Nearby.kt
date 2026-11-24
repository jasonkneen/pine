// Computers that announce themselves on the local network: the Pine app's Bonjour record
// (`_pine._tcp`, its TXT record `v=1`, `id=<machine id>`, `service=<https origin>`, `nonce=<22
// characters>`), read as the phone keeps it, and the list of those found, which the plugin hands the
// page as `nearby` events. What a record says is not trusted: the machine id is only where the phone
// looks, and the pairing checks the host key against it and shows the owner four digits on both
// screens (ADR 0005). The nonce is what the computer lets a codeless request in with (`nearby.<nonce>`):
// only a device that hears the announcement on the network has it, and it changes every few minutes.
// The same in the Swift core (Nearby.swift).
package pine.mobile.core

import org.json.JSONArray
import org.json.JSONObject

/** The Bonjour service type the Pine app announces itself with. */
const val NEARBY_TYPE = "_pine._tcp"

/** The meeting service the Pine app uses unless the owner names another (desktop/src/machines.ts `OFFICIAL_SERVICE`). */
const val OFFICIAL_SERVICE = "https://pine-main.drcmda.workers.dev"

/** The shape of the nonce a computer announces: 16 random bytes in base64url (desktop/electron/access/nearby.ts). */
private val NONCE = Regex("^[A-Za-z0-9_-]{22}$")

/** Whether `nonce` has the shape of an announced one. */
fun nearbyNonce(nonce: String?): Boolean = nonce != null && NONCE.matches(nonce)

/**
 * A computer found on the network: its machine id, the meeting service it is reached through, and the
 * nonce of its announcement, which a codeless request names.
 */
data class NearbyComputer(val id: String, val service: String, val nonce: String) {
	fun json(): JSONObject = JSONObject().put("id", id).put("service", service).put("nonce", nonce)
}

/**
 * What the phone keeps of a TXT record, its keys in any case (RFC 6763 says they are compared
 * without it); null for a record it ignores: a version other than 1, no machine id or one of another
 * shape, a service that is not an https origin, no nonce or one of another shape. A record without a
 * service names the official one.
 */
fun nearbyComputer(txt: Map<String, String?>): NearbyComputer? {
	val by = txt.entries.associate { it.key.lowercase() to it.value }
	if (by["v"] != "1") return null
	val id = by["id"] ?: return null
	if (pairedFingerprint(id) == null) return null
	val service = if ("service" in by) httpsOrigin(by["service"] ?: return null)?.first ?: return null else OFFICIAL_SERVICE
	val nonce = by["nonce"]?.takeIf(::nearbyNonce) ?: return null
	return NearbyComputer(id, service, nonce)
}

/**
 * The computers found so far, by the name each service was announced under: one computer may be
 * found under two names (on two networks, or renamed "Pine (2)"), and is listed once.
 */
class NearbyFound {
	private val byName = LinkedHashMap<String, NearbyComputer>()

	/** A service resolved: kept when its record is one the phone reads. True when the list changed. */
	@Synchronized
	fun found(name: String, computer: NearbyComputer?): Boolean {
		val before = list()
		if (computer == null) byName.remove(name) else byName[name] = computer
		return list() != before
	}

	/** A service gone from the network. True when the list changed. */
	@Synchronized
	fun lost(name: String): Boolean {
		val before = list()
		byName.remove(name)
		return list() != before
	}

	@Synchronized
	fun clear() = byName.clear()

	/**
	 * Each computer once, the first found first. Of two records of the same machine id the one that
	 * names the official service is kept, else the first found: a later record cannot move the
	 * computer to a service of its choosing.
	 */
	@Synchronized
	fun list(): List<NearbyComputer> = byName.values.groupBy { it.id }.map { (_, all) -> all.firstOrNull { it.service == OFFICIAL_SERVICE } ?: all.first() }

	/** What the page is told: `{computers: [{id, service, nonce}]}`. */
	fun event(): JSONObject = JSONObject().put("computers", JSONArray(list().map { it.json() }))
}
