// Looking for computers that announce themselves on this network (`_pine._tcp`, the Pine app's
// Bonjour record), with Android's NsdManager: each service found is resolved to read its TXT record,
// which the core reads (`nearbyComputer`) and lists once per machine id (`NearbyFound`). Only the
// owner's tap on one starts anything (`Pines.pairNearby`); a record is never trusted.
//
// NSD needs no permission beyond INTERNET: the system's mDNS service does the multicast, so no
// multicast lock, and neither NEARBY_WIFI_DEVICES nor a location permission (those are for Wi-Fi
// Aware, Wi-Fi Direct, RTT and scans, which this does not use).
package dev.pmndre.pine

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import androidx.annotation.RequiresApi
import org.json.JSONObject
import pine.mobile.core.NEARBY_TYPE
import pine.mobile.core.NearbyFound
import pine.mobile.core.nearbyComputer
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** `changed` is told the whole list (`{computers: [{id, service, nonce}]}`) at each start and at each change. */
internal class NearbyBrowser(context: Context, private val changed: (JSONObject) -> Unit) {
	private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
	/** Everything here happens on this one thread: NsdManager calls back on threads of its own. */
	private val loop = Executors.newSingleThreadScheduledExecutor()
	private val found = NearbyFound()
	private var discovery: NsdManager.DiscoveryListener? = null
	/** Which look a callback belongs to: one from a look that was stopped changes nothing. */
	private var look = 0
	/** Android 14 and later: a callback per service, which also says when its record changes. */
	private val watched = mutableMapOf<String, Any>()
	/** Before Android 14: services to resolve, one at a time (NsdManager refuses a second at once). */
	private val queue = ArrayDeque<NsdServiceInfo>()
	private var resolving = false

	fun start() = onLoop {
		if (discovery != null) return@onLoop
		val mine = ++look
		found.clear()
		tell()
		val listener = object : NsdManager.DiscoveryListener {
			override fun onDiscoveryStarted(serviceType: String) {}
			override fun onDiscoveryStopped(serviceType: String) {}
			override fun onServiceFound(service: NsdServiceInfo) = onLoop { if (mine == look) resolve(service, mine) }
			override fun onServiceLost(service: NsdServiceInfo) = onLoop { if (mine == look) lost(service.serviceName) }
			override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = onLoop { if (discovery === this) discovery = null }
			override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
		}
		discovery = listener
		// A new listener for every look: NsdManager refuses one that is still in use by a look being stopped.
		runCatching { nsd.discoverServices(NEARBY_TYPE, NsdManager.PROTOCOL_DNS_SD, listener) }.onFailure { discovery = null }
	}

	fun stop() = onLoop {
		val listener = discovery ?: return@onLoop
		discovery = null
		look++
		runCatching { nsd.stopServiceDiscovery(listener) }
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) watched.values.forEach { unwatch(it) }
		watched.clear()
		queue.clear()
		found.clear()
	}

	/**
	 * Runs `block` on `loop`; nothing once `close()` ended it, for a callback of NsdManager that comes
	 * late, on a thread where a throw would end the app.
	 */
	private fun onLoop(block: () -> Unit) {
		try {
			loop.execute(block)
		} catch (e: RejectedExecutionException) {
			// Closed.
		}
	}

	/** Stops looking for good: the look is stopped and the thread ends after it. Nothing starts again. */
	fun close() {
		stop()
		loop.shutdown()
	}

	private fun tell() = changed(found.event())

	private fun lost(name: String) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) watched.remove(name)?.let { unwatch(it) }
		queue.removeAll { it.serviceName == name }
		if (found.lost(name)) tell()
	}

	private fun record(service: NsdServiceInfo, mine: Int) {
		if (mine != look) return
		val txt = service.attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8) }
		if (found.found(service.serviceName, nearbyComputer(txt))) tell()
	}

	private fun resolve(service: NsdServiceInfo, mine: Int) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return watch(service, mine)
		if (queue.none { it.serviceName == service.serviceName }) queue.add(service)
		next(mine)
	}

	/** Before Android 14: the next service of the queue is resolved once the one before has ended. */
	@Suppress("DEPRECATION")
	private fun next(mine: Int) {
		if (resolving || mine != look) return
		val service = queue.removeFirstOrNull() ?: return
		resolving = true
		val done = { resolving = false; next(look) }
		val listener = object : NsdManager.ResolveListener {
			override fun onServiceResolved(info: NsdServiceInfo) = onLoop {
				record(info, mine)
				done()
			}
			override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = onLoop {
				// Busy with a resolve of a look that was stopped: this one is tried again in a moment.
				if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE && mine == look) {
					queue.addFirst(service)
					loop.schedule({ resolving = false; next(look) }, 300, TimeUnit.MILLISECONDS)
				} else done()
			}
		}
		runCatching { nsd.resolveService(service, listener) }.onFailure { done() }
	}

	@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
	private fun watch(service: NsdServiceInfo, mine: Int) {
		val name = service.serviceName
		if (name in watched) return
		val callback = object : NsdManager.ServiceInfoCallback {
			override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
				if (watched[name] === this) watched.remove(name)
			}
			override fun onServiceUpdated(info: NsdServiceInfo) = record(info, mine)
			override fun onServiceLost() {
				if (mine == look && found.lost(name)) tell()
			}
			override fun onServiceInfoCallbackUnregistered() {}
		}
		watched[name] = callback
		// Its callbacks come on `loop`, as everything else here.
		runCatching { nsd.registerServiceInfoCallback(service, loop, callback) }.onFailure { watched.remove(name) }
	}

	@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
	private fun unwatch(callback: Any) {
		runCatching { nsd.unregisterServiceInfoCallback(callback as NsdManager.ServiceInfoCallback) }
	}
}
