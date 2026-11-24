package pine.mobile.core

import org.apache.sshd.common.config.keys.AuthorizedKeyEntry

/** A phone, a machine whose host key it confirmed, and the daemon on that machine: what the tests of events and media start from. */
class Rig : AutoCloseable {
	val vault = MemoryVault()
	val key = DeviceKey(vault)
	val daemon = StandInDaemon()
	val service = Service("""{"base":"${daemon.base}","token":"secret-token","mode":"attached","started":false,"home":"/home/me/.pine","version":"0.40.0"}""")
	val machine = Machine(AuthorizedKeyEntry.parseAuthorizedKeyEntry(key.publicKey).resolvePublicKey(null, null), service)
	val known = KnownHosts(vault).apply { confirm("127.0.0.1", machine.port, machine.fingerprint) }
	val remote = Remote(key, known, LibDataChannelRtc, answerMs = 1_000)
	val host get() = "me@127.0.0.1:${machine.port}"
	private val open = mutableListOf<AutoCloseable>()

	fun connected(): RemoteService = remote.connect(host).also { s -> open.add(AutoCloseable { s.stop() }) }

	/** Something to close with the rig. */
	fun <T : AutoCloseable> held(it: T): T = it.also { open.add(it) }

	override fun close() {
		open.forEach { runCatching { it.close() } }
		machine.close()
		daemon.close()
	}
}

/** Waits up to two seconds for `ok`. */
fun eventually(what: String, ok: () -> Boolean) {
	val until = System.currentTimeMillis() + 2_000
	while (!ok()) {
		if (System.currentTimeMillis() > until) throw AssertionError("still not: $what")
		Thread.sleep(10)
	}
}
