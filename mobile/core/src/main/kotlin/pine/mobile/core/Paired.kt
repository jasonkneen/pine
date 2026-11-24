// A computer paired by its link, as the phone knows it: the pairing link the Pine app's QR code
// carries (or the web client hands the iOS app), the fingerprint its machine id stands for, the
// name the phone gives itself, and how such a machine is written in the list. The web client's
// rules (web/src/pairing.ts, desktop/src/machines.ts) and the Pine app's (cleanName and keyId in
// desktop/electron/access/store.ts) on the phone; mobile/cases holds both cores to them.
package pine.mobile.core

import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.security.PublicKey

/** How a computer paired by its link is written among the machines: `paired:` and its machine id. */
const val PAIRED = "paired:"

/** A machine id: SHA-256 of the paired computer's SSH host key blob, base64url without padding. */
private val MACHINE_ID = Regex("^[A-Za-z0-9_-]{43}$")

/** A pairing code: 16 random bytes, base64url without padding. */
private val PAIR_CODE = Regex("^[A-Za-z0-9_-]{22}$")

/**
 * What a pairing link names: the meeting service every connection to that computer goes through
 * (`service`, an https origin), the computer's machine id and the one-time code. What the owner is
 * shown of the service before confirming is the page's to say (it reads the link itself).
 */
data class PairLink(val service: String, val id: String, val code: String)

/** An https origin, scheme and host in lower case and without :443, and its host and port; null for anything else. */
internal fun httpsOrigin(text: String): Pair<String, String>? {
	val m = Regex("^https://([A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?$", RegexOption.IGNORE_CASE).matchEntire(text) ?: return null
	val name = m.groupValues[1].lowercase()
	val port = m.groupValues[2].ifEmpty { null }?.toInt()
	if (port != null && (port < 1 || port > 65535)) return null
	val host = if (port == null || port == 443) name else "$name:$port"
	return "https://$host" to host
}

/** Percent-decoding of a query value, without `+` for a space; null for a broken escape. */
private fun unescape(text: String): String? {
	val out = java.io.ByteArrayOutputStream()
	var i = 0
	while (i < text.length) {
		val c = text[i]
		if (c == '%') {
			val hex = text.substring(i + 1, minOf(i + 3, text.length))
			if (!Regex("^[0-9A-Fa-f]{2}$").matches(hex)) return null
			out.write(hex.toInt(16))
			i += 3
		} else {
			out.write(c.toString().toByteArray())
			i++
		}
	}
	return out.toString(Charsets.UTF_8)
}

/**
 * A pairing link, in either form: the web client's `<service origin>/#pair=<machine id>.<code>`, or
 * the app's own `pine://pair?service=<percent-encoded https origin>&id=<machine id>&code=<code>`.
 * Null for anything else, a service that is not https included: the phone connects to nothing
 * else. Reading one starts nothing.
 */
fun pairLink(value: String?): PairLink? {
	val given = value?.trim() ?: return null
	val (origin, id, code) = when {
		given.startsWith("pine://pair?") -> {
			val parts = given.removePrefix("pine://pair?").split('&').map { it.substringBefore('=', "") to it.substringAfter('=', "") }
			val byName = parts.toMap()
			if (parts.size != 3 || byName.keys != setOf("service", "id", "code")) return null
			Triple(unescape(byName.getValue("service")) ?: return null, byName.getValue("id"), byName.getValue("code"))
		}
		else -> {
			val hash = given.indexOf("#pair=")
			if (hash < 1 || given[hash - 1] != '/') return null
			val ids = given.substring(hash + "#pair=".length).split('.')
			if (ids.size != 2) return null
			Triple(given.substring(0, hash - 1), ids[0], ids[1])
		}
	}
	val (service, _) = httpsOrigin(origin) ?: return null
	if (!MACHINE_ID.matches(id) || !PAIR_CODE.matches(code)) return null
	return PairLink(service, id, code)
}

/** The longest address the app hands the page: more than any pairing link has. */
private const val OPENED_LENGTH = 1024

/**
 * An address the app was opened with (an App Link of Pine's meeting service, or a view intent
 * another app sends it by name), as the plugin hands it to the page; null when it drops it. Only
 * what comes as a pairing link of the web client comes: http or https with a host, the fragment
 * `pair=` and what follows, printable ASCII, at most 1024 characters. An http service and a
 * malformed pairing are let through on purpose: the page says why it refuses them, and the owner
 * sees that the link was read. Handing it on starts nothing: the page asks the owner, and `pair`
 * reads the link again with `pairLink`. iOS is opened with its own scheme instead (Paired.swift).
 */
fun openedLink(value: String?): String? {
	if (value.isNullOrEmpty() || value.length > OPENED_LENGTH) return null
	if (value.any { it < '!' || it > '~' }) return null
	if (!outside(value)) return null
	val hash = value.indexOf('#')
	if (hash < 0 || !value.startsWith("pair=", hash + 1)) return null
	return value
}

/** The host key fingerprint a machine id stands for, as OpenSSH prints it (`SHA256:` and base64); null for what is not a machine id. */
fun pairedFingerprint(id: String): String? =
	if (MACHINE_ID.matches(id)) "SHA256:" + id.replace('-', '+').replace('_', '/') else null

/**
 * The host key check of a computer paired by its link: only the key its machine id stands for
 * (`trusted`, from `pairedFingerprint`) is taken, during key exchange, before the phone's key is
 * offered. `seen` is the other key it presented, if it presented one.
 */
internal class PinnedKey(private val trusted: String) : HostKeyVerifier {
	@Volatile
	var seen: String? = null
		private set

	override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
		val presented = fingerprint(key)
		if (presented == trusted) return true
		seen = presented
		return false
	}

	override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/** The longest name the Pine app keeps for a device (`NAME_LENGTH`). */
private const val NAME_LENGTH = 60

/**
 * A name to be shown as text, as the Pine app cleans a device's name: no terminal escape, no control
 * or format character, no spaces around it, at most 60 characters (code points).
 */
fun cleanName(text: String): String {
	val kept = Regex("\u001b\\[[0-9;?]*[ -/]*[@-~]").replace(text, "").codePoints().filter {
		val type = Character.getType(it)
		type != Character.CONTROL.toInt() && type != Character.FORMAT.toInt()
	}.toArray()
	val trimmed = String(kept, 0, kept.size).trim()
	return trimmed.codePoints().limit(NAME_LENGTH.toLong()).toArray().let { String(it, 0, it.size) }.trim()
}

/** The name the phone gives itself when it pairs: "Pine on" and its model ("Pine on Pixel 9"). */
fun deviceName(model: String?): String {
	val named = cleanName(model ?: "")
	return if (named.isEmpty()) "Pine on a phone" else cleanName("Pine on $named")
}

/** A machine of the list: a computer paired by its link, or one reached over SSH as user@host[:port]. */
sealed interface Listed {
	val given: String

	data class Paired(val id: String) : Listed {
		override val given: String get() = PAIRED + id
	}

	data class Ssh(val host: SshHost) : Listed {
		override val given: String get() = host.given
	}
}

/**
 * A computer paired by its link, as the list keeps it beside its `paired:<machine id>`: the meeting
 * service every connection to it goes through, and the name it gave when the owner allowed the
 * phone (none: the page says "your computer"). The machine id is the trusted host key: nothing else
 * is kept for it.
 */
data class PairedComputer(val id: String, val service: String, val name: String?) {
	val host: String get() = PAIRED + id
}

/** A machine as it is stored: `paired:<machine id>` or what `sshHost` takes; null for nothing written. */
fun listed(value: String?): Listed? {
	val given = value?.trim() ?: return null
	if (given.startsWith(PAIRED)) {
		val id = given.removePrefix(PAIRED)
		if (!MACHINE_ID.matches(id)) throw RemoteError("ssh", "\"${given.take(80)}\" is not a paired computer: pair it again from the Pine app.")
		return Listed.Paired(id)
	}
	return sshHost(given)?.let { Listed.Ssh(it) }
}
