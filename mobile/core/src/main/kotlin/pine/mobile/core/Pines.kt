// The native plugin without Android: the machines the owner added, the one in use, its connection
// and what the page is told about it. It is what desktop/electron/main.ts does for the desktop page
// (`startService`, `use`, `pine:hosts-add`, `pine:hosts-forget`, `follow`), with one thing more: a
// host key the phone does not know yet is put to the owner in the page, and trusted on their yes.
package pine.mobile.core

import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** Where the plugin keeps what is not secret (the app's SharedPreferences): text by name, none to remove. */
interface Shelf {
	fun get(name: String): String?
	fun set(name: String, value: String?)
}

/** What the page is told: the desktop's `pine:service`, `pine:events` and `pine:connection`. */
interface Page {
	fun service(state: JSONObject)
	fun events(batch: List<Any>)
	fun connection(up: Boolean)
}

/** How long to wait before the attempt after the `n`th failed one to connect again: doubling from a second, at most half a minute (web/src/host.ts `backoff`). */
fun backoff(n: Int): Long = minOf(1000L shl n.coerceIn(0, 5), 30_000L)

/** How many machines the list holds at most, as on the desktop. */
const val MAX_HOSTS = 20

/**
 * The pines of the owner's machines, one shown at a time. Each machine used is held (`HeldRemote`)
 * until it is forgotten or the app ends, so that switching back is quick and an agent at work on one
 * goes on; only the one in use speaks to the page.
 */
class Pines(
	private val remote: Remote,
	private val known: KnownHosts,
	private val shelf: Shelf,
	private val page: Page,
	private val retryMs: Long = 1_000,
	private val batchMs: Long = 24,
	/** How long to wait before the attempt after the `n`th failed one to reach a paired computer again. */
	private val backoffMs: (Int) -> Long = ::backoff,
) : AutoCloseable {
	private val lock = Object()
	/** The pairing under way, if there is one. */
	private var pairing: Pairing? = null
	/** Paired computers whose last trouble only the owner can fix (the phone is no longer known there): not tried again by `check()`. */
	private val stuck = mutableSetOf<String>()
	private val held = mutableMapOf<String, HeldRemote>()
	/** Host keys seen and not known yet, by machine: what the owner's yes may trust. */
	private val unknown = mutableMapOf<String, HostKeyError>()
	private var state: JSONObject = JSONObject().put("status", "starting")
	/** Which connection is the latest asked for: an older one that ends late changes nothing. */
	private var round = 0
	private var shown: String? = null
	private var begun = false
	private var closed = false

	/** Whether each held machine's event stream is up, by machine: what the page is told when it is shown again. */
	private val streams = mutableMapOf<String, Boolean>()

	/** Whether the event stream of the machine in use is up. */
	@Volatile
	var connected = false
		private set

	/** The machines, as the owner added them. */
	val hosts: List<String>
		get() = shelf.get(HOSTS)?.let { text -> runCatching { JSONArray(text) }.getOrNull() }?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList()

	/** The machine in use: one of the list, or none. */
	val use: String? get() = shelf.get(USE)?.takeIf { it in hosts }

	/** The page's own preferences, as the page gave them (JSON text): the plugin reads nothing in them. */
	var prefs: String?
		get() = shelf.get(PREFS)
		set(value) = shelf.set(PREFS, value)

	/** The state as the page was last told it. */
	fun state(): JSONObject = synchronized(lock) { JSONObject(state.toString()) }

	/** The page has started: it is told the state, and on the first time the machine in use is connected to. */
	fun ready() {
		val first = synchronized(lock) { !begun.also { begun = true } }
		if (first) start(use) else page.service(state())
	}

	/** Add a machine: host, user@host or user@host:port, with a user, since a phone has no user name of its own. */
	fun addHost(value: String): List<String> {
		val named = sshHost(value) ?: throw RemoteError("ssh", "Write the machine as you would after ssh: user@host, or user@host:port.")
		if (named.user == null) throw RemoteError("ssh", "Name the user too: user@${named.given}. A phone has no user name of its own to sign in with.")
		synchronized(lock) {
			val list = hosts
			if (named.given in list) return list
			if (list.size >= MAX_HOSTS) throw RemoteError("ssh", "There are $MAX_HOSTS machines in the list already: forget one first.")
			return (list + named.given).also { shelf.set(HOSTS, JSONArray(it).toString()) }
		}
	}

	/**
	 * Add a computer the phone was paired with by its link, as `paired:<machine id>`, with the
	 * meeting service it is reached through and the name it gave (cleaned; none kept when empty).
	 * Paired again, it keeps its place and takes the new service and name.
	 */
	fun addPaired(id: String, service: String, name: String?): List<String> {
		if (pairedFingerprint(id) == null) throw RemoteError("ssh", "That is not a computer's machine id: pair it again from the Pine app.")
		if (httpsOrigin(service)?.first != service) throw RemoteError("ssh", "The meeting service of a paired computer is an https address: pair it again from the Pine app.")
		val host = PAIRED + id
		synchronized(lock) {
			val list = hosts
			if (host !in list && list.size >= MAX_HOSTS) throw RemoteError("ssh", "There are $MAX_HOSTS machines in the list already: forget one first.")
			val entry = JSONObject().put("service", service)
			cleanName(name ?: "").ifEmpty { null }?.let { entry.put("name", it) }
			shelf.set(PAIRED_ENTRIES, pairedEntries().put(host, entry).toString())
			return (if (host in list) list else list + host).also { shelf.set(HOSTS, JSONArray(it).toString()) }
		}
	}

	/** What is kept beside a paired computer of the list; null for any other machine. */
	fun paired(host: String): PairedComputer? {
		val id = (runCatching { listed(host) }.getOrNull() as? Listed.Paired)?.id ?: return null
		val entry = pairedEntries().optJSONObject(host)?.takeIf { host in hosts } ?: return null
		val service = entry.optString("service").takeIf { httpsOrigin(it)?.first == it } ?: return null
		return PairedComputer(id, service, entry.optString("name").ifEmpty { null })
	}

	/**
	 * Pairs with the computer a pairing link names (either form `pairLink` reads), after the owner's
	 * yes in the page, as the phone called `name` (`deviceName`). The page is told
	 * `{status: "starting", pairing: {name}}`, then the same with `code` once the computer shows the
	 * four digits. A yes keeps the computer (`addPaired`), makes it the machine in use and connects to
	 * it; anything else is told as `{status: "error", kind: "ssh", message}` with no host, and nothing
	 * is kept. A link that cannot be read, or a pairing under way already, is refused here.
	 */
	fun pair(link: String, name: String) {
		val read = pairLink(link) ?: throw RemoteError("ssh", PairWords.NOT_A_LINK)
		begin(read.id, read.service, name, nearby = false) { on -> remote.pair(read, name, on) }
	}

	/**
	 * Pairs with a computer found on the network (`nearbyComputer`), without a code: as `pair`, as
	 * user `nearby.<nonce>`. `id` is the machine id it announced, `service` its meeting service, an
	 * https origin as `nearbyComputer` writes it, `nonce` the nonce of its announcement; anything
	 * else, or a pairing under way, is refused here. The page is told the computer's name with the
	 * four digits (`pairing.computer`), and a request the computer did not let in as an error in
	 * `PairWords.NOT_LET_IN`. On a yes the service kept is the one the computer named on the pairing
	 * channel, which the pairing checked to be the announced one (`PairWords.NEARBY_SERVICE`).
	 */
	fun pairNearby(id: String, service: String, nonce: String, name: String) {
		if (pairedFingerprint(id) == null || httpsOrigin(service)?.first != service || !nearbyNonce(nonce)) throw RemoteError("ssh", PairWords.NOT_NEARBY)
		val computer = NearbyComputer(id, service, nonce)
		begin(id, service, name, nearby = true) { on -> remote.pairNearby(computer, name, on) }
	}

	/** Starts a pairing with the computer `id` reached through `service`; `start` begins it at the remote. */
	private fun begin(id: String, service: String, name: String, nearby: Boolean, start: ((PairingState) -> Unit) -> Pairing) {
		val mine = synchronized(lock) {
			if (pairing != null) throw RemoteError("ssh", PairWords.BUSY)
			if (closed) return
			++round
		}
		show(mine, asking(name, null, null), null)
		val started = start { state -> paired(mine, id, service, nearby, name, state) }
		val gone = synchronized(lock) {
			if (round == mine && !closed && ended != mine) {
				pairing = started
				false
			} else true
		}
		// Ended already, or something else was started meanwhile: nothing is kept open.
		if (gone) started.cancel()
	}

	/** The round of the last pairing that came to its end. */
	private var ended = 0

	/** What the pairing `mine` reported. */
	private fun paired(mine: Int, id: String, service: String, nearby: Boolean, name: String, state: PairingState) {
		if (state is PairingState.Pairing) return show(mine, asking(name, state.code, state.computer), null)
		synchronized(lock) {
			ended = mine
			if (round != mine || closed) return
			pairing = null
		}
		val words = PairWords.of(state, nearby) ?: run {
			try {
				addPaired(id, service, (state as PairingState.Allowed).name)
			} catch (e: RemoteError) {
				// The link was read already: what can refuse it now is a list that is full.
				return show(mine, JSONObject().put("status", "error").put("kind", "ssh").put("message", PairWords.FULL), null)
			}
			shelf.set(USE, PAIRED + id)
			return start(PAIRED + id)
		}
		show(mine, JSONObject().put("status", "error").put("kind", "ssh").put("message", words), null)
	}

	/** Ends the pairing under way, keeping nothing: the machine in use is shown again, as before it began. */
	fun cancelPairing() {
		if (synchronized(lock) { pairing } == null) return
		start(use)
	}

	/** The names the owner sees for machines, by machine: those paired computers gave (`Prefs.names` of the page). */
	val names: Map<String, String>
		get() = hosts.mapNotNull { host -> paired(host)?.name?.let { host to it } }.toMap()

	private fun pairedEntries(): JSONObject = shelf.get(PAIRED_ENTRIES)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

	/**
	 * Take a machine out of the list and let go of its connection (a pine it started there stops).
	 * The one in use is refused while it is reached or being reached; one that could not be reached
	 * may go (its host key changed, say), and then no machine is in use.
	 */
	fun forgetHost(host: String): List<String> {
		val stop: HeldRemote?
		val wasInUse: Boolean
		synchronized(lock) {
			wasInUse = host == use
			if (wasInUse && state.optString("status") != "error") throw RemoteError("ssh", "The app uses this machine now. Use another one first.")
			if (wasInUse) shelf.set(USE, null)
			shelf.set(HOSTS, JSONArray(hosts.filter { it != host }).toString())
			// Only the phone's entry: the computer keeps this phone until Remove in the Pine app.
			pairedEntries().let { if (it.remove(host) != null) shelf.set(PAIRED_ENTRIES, it.toString()) }
			unknown.remove(host)
			streams.remove(host)
			stop = held.remove(host)
		}
		stop?.stop()
		if (wasInUse) start(null)
		return hosts
	}

	/** Use the pine of a machine of the list: it is kept as the one in use, and connected to. */
	fun use(host: String) {
		if (host !in hosts) throw RemoteError("ssh", "That machine is not in the list: add it first.")
		shelf.set(USE, host)
		start(host)
	}

	/** Connect again to the machine in use. */
	fun retry() = start(use)

	/**
	 * The owner's yes to the host key a connection stopped at: only the one the machine showed, never
	 * a key that changed. The machine in use is then connected to again.
	 */
	fun trust(host: String, fingerprint: String) {
		synchronized(lock) {
			val seen = unknown[host] ?: throw RemoteError("ssh", "No host key of $host waits for your yes: try again to connect.")
			if (seen.fingerprint != fingerprint) throw RemoteError("ssh", "That is not the key $host showed: try again to connect.")
			known.confirm(seen.host, seen.port, seen.fingerprint)
			unknown.remove(host)
		}
		if (host == use) start(host)
	}

	/** Forget the host key stored for a machine: the next connection shows its key again. */
	fun forgetKey(host: String) {
		// A paired computer's key is its machine id: there is nothing to forget but the machine.
		val named = (runCatching { listed(host) }.getOrNull() as? Listed.Ssh)?.host ?: return
		known.forget(named.host, named.port)
		synchronized(lock) { unknown.remove(host) }
	}

	/** One call of the control API to the pine in use (503 before there is one). */
	fun call(method: String, url: String, body: Any?): CallResult = callDaemon(daemon(), method, url, body)

	/** A picture, video or sound of the pine in use, under `mediaFromDaemon`'s rules. */
	fun media(method: String, path: String, search: String): MediaAnswer = mediaFromDaemon(daemon(), method, path, search)

	private fun daemon(): RemoteService? = synchronized(lock) {
		if (state.optString("status") != "ready") null else held[shown]?.service
	}

	/**
	 * The app came back to the front: the pine in use is asked whether it still answers (Android may
	 * have cut the link meanwhile), and connected to again when it does not. A machine that could not
	 * be reached is tried again, except when its host key waits for the owner's yes. Returns when that is known.
	 */
	fun check() {
		val (host, mine, service) = synchronized(lock) {
			val host = shown ?: return
			val status = state.optString("status")
			val again = status == "error" && host == use && state.optString("kind") in listOf("ssh", "failed") && !state.has("fingerprint") && host !in stuck
			if (status != "ready" && !again) return
			Triple(host, round, if (status == "ready") held[host]?.service else null)
		}
		if (service != null && service.isOpen && answers(service)) return
		val again = synchronized(lock) {
			if (mine != round) return
			++round
		}
		show(again, starting(host), host)
		connect(host, again)
	}

	private fun start(host: String?) {
		val (mine, open) = synchronized(lock) { ++round to pairing.also { pairing = null } }
		// Whatever is started now ends a pairing under way, which keeps nothing.
		open?.cancel()
		if (host == null) return show(mine, nobody(), null)
		show(mine, starting(host), host)
		thread(isDaemon = true, name = "pine-connect") { connect(host, mine) }
	}

	/** Connects to `host` for the connection `mine`; `tries` is how many attempts failed before, for a paired computer tried again. */
	private fun connect(host: String, mine: Int, tries: Int = 0) {
		try {
			val h = synchronized(lock) {
				if (closed) return
				held.getOrPut(host) { HeldRemote(remote, host, follow(host), failed = { e -> lost(host, e) }, retryMs, batchMs, computer = { paired(host) }) }
			}
			val s = h.ensure()
			synchronized(lock) { stuck.remove(host) }
			show(mine, ready(s), host)
		} catch (e: Exception) {
			show(mine, failure(host, e), host)
			later(host, mine, tries, e)
		}
	}

	/**
	 * A paired computer that could not be reached for a reason that may pass is tried again after a
	 * growing wait, for as long as that connection is the latest asked for: the web client's
	 * `reconnect`. One that only the owner can fix (the phone is no longer known there, its host key
	 * is not its machine id) is not. A machine reached over SSH is not tried again by itself, as before.
	 */
	private fun later(host: String, mine: Int, tries: Int, e: Exception) {
		if (!host.startsWith(PAIRED) || !(e is RemoteError && e.passing)) return
		thread(isDaemon = true, name = "pine-reconnect") {
			Thread.sleep(backoffMs(tries))
			if (synchronized(lock) { round == mine && !closed }) connect(host, mine, tries + 1)
		}
	}

	/**
	 * The page is told `next`, when it is still what the latest connection is about, and whether the
	 * shown machine's events flow when that changed: a held machine's stream may have been up all along.
	 */
	private fun show(mine: Int, next: JSONObject, host: String?) = synchronized(lock) {
		if (mine != round || closed) return
		val switched = shown != host
		val was = connected
		connected = next.optString("status") == "ready" && host != null && streams[host] == true
		shown = host
		state = next
		page.service(JSONObject(next.toString()))
		if (switched || connected != was) page.connection(connected)
	}

	/** A held machine's events reach the page only while it is the one shown. */
	private fun follow(host: String) = object : EventHandlers {
		override fun batch(events: List<Any>) {
			if (synchronized(lock) { shown == host }) page.events(events)
		}
		override fun connection(up: Boolean) {
			synchronized(lock) {
				if (closed || held[host] == null) return
				streams[host] = up
				if (shown != host) return
				connected = up
			}
			page.connection(up)
		}
	}

	/** A held machine whose session could not be made again after its stream was lost. */
	private fun lost(host: String, e: Exception) {
		val mine = synchronized(lock) { if (shown != host) return else round }
		show(mine, failure(host, e), host)
		later(host, mine, 0, e)
	}

	private fun failure(host: String, e: Exception): JSONObject {
		if (host.startsWith(PAIRED)) synchronized(lock) { if (e is RemoteError && e.passing) stuck.remove(host) else stuck.add(host) }
		val out = JSONObject().put("status", "error").put("host", host)
		when (e) {
			// A paired computer's key is its machine id: another one is refused for good, in the words of Remote.
			is HostKeyError if host.startsWith(PAIRED) -> out.put("kind", "ssh").put("fingerprint", e.fingerprint).put("changed", true).put("message", e.message ?: "")
			is HostKeyError -> {
				if (!e.changed) synchronized(lock) { unknown[host] = e }
				out.put("kind", "ssh").put("fingerprint", e.fingerprint).put("changed", e.changed).put(
					"message",
					if (e.changed) "The host key of $host changed: it is now ${e.fingerprint}, not the one this phone confirmed. Not connecting, since another machine may stand in for it. If that machine was reinstalled, forget it in the list of machines, add it again and confirm its new key."
					else "This phone does not know $host yet. Its host key's fingerprint is ${e.fingerprint}. If that is what the machine shows (ssh-keygen -lf on its /etc/ssh/ssh_host_*_key.pub), press Trust this key to connect.",
				)
			}
			is RemoteError -> out.put("kind", e.kind).put("message", e.message ?: "")
			else -> out.put("kind", "failed").put("message", e.message ?: e.javaClass.simpleName)
		}
		return out
	}

	private fun nobody(): JSONObject = JSONObject().put("status", "error").put("kind", "ssh").put(
		"message",
		if (hosts.isEmpty()) "Pair this phone with your computer: in the Pine app there, go to Settings > Browser access, press Add a device, and open its link on this phone. Or add a machine as you would write it after ssh (user@host, or user@host:port), with this phone's key in ~/.ssh/authorized_keys there."
		else "Choose the machine whose pine this phone is to use.",
	)

	override fun close() {
		val (all, open) = synchronized(lock) {
			closed = true
			held.values.toList().also { held.clear() } to pairing.also { pairing = null }
		}
		open?.cancel()
		all.forEach { it.stop() }
	}

	private companion object {
		const val HOSTS = "hosts"
		const val USE = "use"
		const val PREFS = "prefs"
		/** What is kept beside each paired computer of the list, by machine: `{service, name}`. */
		const val PAIRED_ENTRIES = "paired"

		fun starting(host: String) = JSONObject().put("status", "starting").put("host", host)

		/** A pairing under way, as the page shows it: the phone's name, and the four digits and the computer's name once the computer shows them. */
		fun asking(name: String, code: String?, computer: String?) = JSONObject().put("status", "starting").put("pairing", JSONObject().put("name", name).apply {
			code?.let { put("code", it) }
			computer?.let { put("computer", it) }
		})

		fun ready(s: RemoteService) = JSONObject().put("status", "ready").put("mode", "on ${s.label}").put("started", s.started).put("home", "${s.label}:${s.home}").apply { s.version?.let { put("version", it) } }.put("from", if (s.paired) "paired ${s.label}" else "ssh ${s.host}").put("host", s.host).put("label", s.label)
	}
}
