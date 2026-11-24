// What names the other machine, and where its daemon may answer: src/remote.ts's `sshHost` and
// `loopbackEnd`, on the phone. Kept the same on purpose: a change there is a change here.
package pine.mobile.core

/** Why a connection did not come about. `kind` is "ssh" (not reached, or pine is not there) or "failed" (its pine said why it did not start), as `RemoteError` in src/remote.ts. */
open class RemoteError(
	val kind: String,
	message: String,
	/**
	 * A trouble that may pass by itself (the network, a computer that sleeps): a paired computer is
	 * tried again after it, with a growing wait. One only the owner can fix is not.
	 */
	val passing: Boolean = false,
) : Exception(message)

/**
 * The machine's host key is not the one the owner confirmed, or none was confirmed yet. `fingerprint`
 * is the key's SHA256 fingerprint as OpenSSH prints it; for an unknown key, confirming that
 * fingerprint (`KnownHosts.confirm`) lets the next connection through. A changed key is refused
 * until the stored one is forgotten.
 */
class HostKeyError(message: String, val host: String, val port: Int, val fingerprint: String, val changed: Boolean) : RemoteError("ssh", message)

/** A machine as the owner wrote it (`given`), and its parts. `label` is the host without the user and the domain. */
data class SshHost(val given: String, val user: String?, val host: String, val port: Int, val label: String)

private val HOST = Regex("^[A-Za-z0-9_][A-Za-z0-9_.@-]*$")

/** What may name the other machine: host, user@host or user@host:port, never an option for ssh. */
fun sshHost(value: String?): SshHost? {
	val given = value?.trim() ?: return null
	if (given.isEmpty()) return null
	val refused = RemoteError("ssh", "\"${given.take(80)}\" is not a host for ssh. Write it as host, user@host or user@host:port.")
	// A paired computer (Paired.kt), never a host "paired" whose port follows the colon.
	if (given.startsWith(PAIRED)) throw refused
	val colon = given.lastIndexOf(':')
	val name = if (colon < 0) given else given.substring(0, colon)
	val port = if (colon < 0) 22 else given.substring(colon + 1).takeIf { Regex("^[0-9]{1,5}$").matches(it) }?.toInt() ?: throw refused
	if (!HOST.matches(name) || port < 1 || port > 65535 || name.count { it == '@' } > 1) throw refused
	val user = name.substringBefore('@', "").ifEmpty { null }
	val host = name.substringAfter('@')
	if (host.isEmpty()) throw refused
	// An address is its own short name: its first number alone would name nothing.
	val label = if (Regex("^[0-9.]+$").matches(host)) host else host.split('.')[0].ifEmpty { host }
	return SshHost(given, user, host, port, label)
}

/** Where the other machine's daemon answers: a port of its own loopback. `hostHeader` is what the daemon expects in `Host`. */
data class Loopback(val host: String, val port: Int) {
	val hostHeader: String get() = if (host.contains(':')) "[$host]:$port" else "$host:$port"
}

private val LOOPBACK = Regex("^http://(?:\\[(::1)]|(127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3})):([0-9]{1,5})(?:[/?#].*)?$")

/**
 * A daemon always listens on loopback, so a service line that names anything else is not taken:
 * the channel would carry the token to another host.
 */
fun loopbackEnd(base: String): Loopback {
	val m = LOOPBACK.matchEntire(base)
	val host = m?.let { it.groupValues[1].ifEmpty { it.groupValues[2] } }
	val port = m?.groupValues?.get(3)?.toIntOrNull()
	val octets = host?.takeIf { it != "::1" }?.split('.')?.all { it.toInt() <= 255 } ?: true
	if (host == null || port == null || port < 1 || port > 65535 || !octets) throw RemoteError("failed", "The other machine's pine says it answers at ${base.take(80)}, which is not a port of its own loopback. Only that is connected to.")
	return Loopback(host, port)
}
