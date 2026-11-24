// The native plugin the mobile bridge talks to (mobile/src/plugin.ts, registered as `Pine`): what
// Electron's main process is for the desktop page. It holds the SSH sessions and the daemons'
// tokens and makes every call; the page never sees either. A computer paired by its link is reached
// the same way, SSH over a data channel the core opens (LibWebRtc.kt). What it decides lives in the
// core (../../../../../../../core, package pine.mobile.core, tested on the JVM): this file is the
// Android glue around it (the Keystore, the shelf, the WebView, intents, App Links, the back button,
// the app's life).
package dev.pmndre.pine

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebChromeClient
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.json.JSONArray
import org.json.JSONObject
import pine.mobile.core.DeviceKey
import pine.mobile.core.KnownHosts
import pine.mobile.core.Page
import pine.mobile.core.Pines
import pine.mobile.core.Remote
import pine.mobile.core.SealedVault
import pine.mobile.core.Shelf
import pine.mobile.core.deviceName
import pine.mobile.core.mediaRequest
import pine.mobile.core.openedLink
import pine.mobile.core.outside
import pine.mobile.core.stays
import java.security.KeyStore
import java.security.Security
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

@CapacitorPlugin(name = "Pine")
class PinePlugin : Plugin() {
	private lateinit var pines: Pines
	private lateinit var device: DeviceKey
	// Calls wait for the network: never on Capacitor's own thread, which every other call waits behind.
	private val work = Executors.newCachedThreadPool()
	// The system bars' color and whether the page's theme is dark: pmndre's (index.css) until the page says.
	private var barColor = Color.parseColor("#1b1e28")
	private var barsDark = true
	/**
	 * What the computer is told this phone is called when it pairs, and what it lists in its Settings >
	 * Browser access: "Pine on" and the phone's model ("Pine on Pixel 9").
	 */
	private val phone = deviceName(Build.MODEL)
	/** Computers that announce themselves on this network, looked for only while the page asks (`nearby`). */
	private lateinit var browser: NearbyBrowser
	/** Whether the page asks to look: looking stops while the app is in the back, and starts again on its return. */
	@Volatile
	private var looking = false

	override fun load() {
		// Android carries a cut-down BouncyCastle under the name sshj asks for; the full one takes its place.
		Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
		Security.addProvider(BouncyCastleProvider())
		val shelf = PrefsShelf(context.getSharedPreferences("pine", Context.MODE_PRIVATE))
		val vault = SealedVault(::keystoreKey, shelf)
		device = DeviceKey(vault)
		val known = KnownHosts(vault)
		pines = Pines(Remote(device, known, LibWebRtc(context)), known, shelf, object : Page {
			override fun service(state: JSONObject) = notifyListeners("service", JSObject().put("state", state))
			override fun events(batch: List<Any>) = notifyListeners("events", JSObject().put("events", JSONArray(batch)))
			override fun connection(up: Boolean) = notifyListeners("connection", JSObject().put("connected", up))
		})
		browser = NearbyBrowser(context) { list -> notifyListeners("nearby", JSObject().put("computers", list.getJSONArray("computers"))) }
		harden(bridge)
		// Posted: Capacitor's SystemBars paints the window's own background when it loads, before this runs.
		activity.window.decorView.post { paintBars() }
		// The back button closes what the page has open, else leaves: the page decides (the bridge's "back").
		activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
			override fun handleOnBackPressed() {
				if (hasListeners("menu")) notifyListeners("menu", JSObject().put("command", "back")) else activity.moveTaskToBack(true)
			}
		})
	}

	/** The page's WebView as main.ts keeps the desktop window: no navigation away, no window, no permission. */
	private fun harden(bridge: Bridge) {
		bridge.setWebViewClient(PageClient(bridge))
		val web = bridge.webView
		web.settings.javaScriptCanOpenWindowsAutomatically = false
		web.settings.setSupportMultipleWindows(false)
		web.settings.allowFileAccess = false
		web.settings.setGeolocationEnabled(false)
		// Capacitor sets its own chrome client when it loads the page, after the plugins: this one follows it.
		// (Made now: it registers for the file chooser's result, which an activity takes only before it starts.)
		val chrome = Chrome(bridge)
		web.post { web.webChromeClient = chrome }
	}

	private inner class PageClient(bridge: Bridge) : BridgeWebViewClient(bridge) {
		override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
			val (path, search) = mediaRequest(request.url.toString()) ?: return super.shouldInterceptRequest(view, request)
			val answer = pines.media(request.method, path, search)
			val type = answer.headers["content-type"] ?: "application/octet-stream"
			val charset = Regex("charset=([^;]+)").find(type)?.groupValues?.get(1)?.trim()
			val reason = when (answer.status) {
				200 -> "OK"
				404 -> "Not Found"
				415 -> "Unsupported Media Type"
				else -> "Error"
			}
			return WebResourceResponse(type.substringBefore(';').trim(), charset, answer.status, reason, answer.headers, answer.body)
		}

		// The page stays the page; an address of the web opens in the phone's browser, anything else nowhere.
		override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
			val url = request.url.toString()
			if (stays(url)) return false
			if (outside(url)) openOutside(url)
			return true
		}
	}

	private class Chrome(bridge: Bridge) : BridgeWebChromeClient(bridge) {
		// The camera, the microphone, MIDI, protected media: none is given to the page. A photo comes through the file chooser.
		override fun onPermissionRequest(request: PermissionRequest) = request.deny()
		override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) = callback.invoke(origin, false, false)
		override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean = false
	}

	private fun openOutside(url: String) {
		if (!outside(url)) return
		runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
	}

	/** The key that seals what the vault keeps: made in the Android Keystore on first use, and never leaves it. */
	private fun keystoreKey(): SecretKey {
		val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
		(store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
		val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
			.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
			.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
			.setKeySize(256)
			.build()
		return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
	}

	/** Runs `job` off Capacitor's thread; what it throws is the call's rejection, in words the page shows. */
	private fun later(call: PluginCall, job: () -> JSObject?) = work.execute {
		try {
			val out = job()
			if (out == null) call.resolve() else call.resolve(out)
		} catch (e: Exception) {
			call.reject(e.message ?: e.javaClass.simpleName)
		}
	}

	private fun hostOf(call: PluginCall): String = call.getString("host") ?: throw IllegalArgumentException("Name the machine.")

	private fun listed(hosts: List<String>) = JSObject().put("hosts", JSArray(hosts))

	@PluginMethod
	fun state(call: PluginCall) {
		val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
		// This build pairs with a computer by its link (the page then offers pairing first).
		// It also finds computers on this network and pairs with them without a code.
		call.resolve(JSObject().put("state", pines.state()).put("connected", pines.connected).put("version", version).put("canPair", true).put("canPairNearby", true))
	}

	/**
	 * The owner's yes, in the page, to a pairing link: read again by the core (an https service only,
	 * the machine id and code of their shape), which rejects anything else, or a second pairing.
	 */
	@PluginMethod
	fun pair(call: PluginCall) = later(call) { pines.pair(call.getString("link") ?: "", phone).let { null } }

	@PluginMethod
	fun cancelPairing(call: PluginCall) = later(call) { pines.cancelPairing().let { null } }

	/** Start or stop looking for computers on this network; what is found comes as `nearby` events, none at first. */
	@PluginMethod
	fun nearby(call: PluginCall) {
		val on = call.data.opt("on") as? Boolean ?: return call.reject("Say whether to look: on, true or false.")
		looking = on
		if (on) browser.start() else browser.stop()
		call.resolve()
	}

	/**
	 * The owner's tap on a computer found on the network: paired without a code, as user
	 * `nearby.<nonce>` with the nonce of its announcement. The core checks the id, the service and the
	 * nonce again (a machine id, an https origin, 22 base64url characters), and refuses a second pairing.
	 */
	@PluginMethod
	fun pairNearby(call: PluginCall) = later(call) {
		pines.pairNearby(call.getString("id") ?: "", call.getString("service") ?: "", call.getString("nonce") ?: "", phone).let { null }
	}

	/**
	 * The app was opened with an address of the web: an App Link of Pine's meeting service (the
	 * manifest's filter), or a view intent another app sent this activity by name. At its start
	 * (BridgeActivity hands the plugins the intent it started with) or while it runs (singleTask). It
	 * starts nothing: the page reads it as it reads a pasted link, says so when it is not one, and
	 * otherwise asks the owner, naming a service that is not Pine's own; only their yes calls `pair`.
	 * Kept until the page listens, for a link the app was started with. Only what comes as a pairing
	 * link (the core's `openedLink`, mobile/cases/opened-links.json): the service's own address
	 * without a pairing opens the app, and nothing more.
	 */
	override fun handleOnNewIntent(intent: Intent) {
		super.handleOnNewIntent(intent)
		if (intent.action != Intent.ACTION_VIEW) return
		val link = openedLink(intent.dataString) ?: return
		notifyListeners("link", JSObject().put("link", link), true)
	}

	@PluginMethod
	fun ready(call: PluginCall) = later(call) { pines.ready().let { null } }

	@PluginMethod
	fun call(call: PluginCall) = later(call) {
		val body = call.data.opt("body").takeIf { it != null && it != JSONObject.NULL }
		val r = pines.call(call.getString("method") ?: "", call.getString("url") ?: "", body)
		JSObject().put("ok", r.ok).put("status", r.status).put("data", r.data)
	}

	@PluginMethod
	fun retry(call: PluginCall) = later(call) { pines.retry().let { null } }

	@PluginMethod
	fun use(call: PluginCall) = later(call) { pines.use(hostOf(call)).let { null } }

	@PluginMethod
	fun addHost(call: PluginCall) = later(call) { listed(pines.addHost(hostOf(call))) }

	@PluginMethod
	fun forgetHost(call: PluginCall) = later(call) { listed(pines.forgetHost(hostOf(call))) }

	@PluginMethod
	fun loadPrefs(call: PluginCall) = later(call) {
		val out = JSObject().put("hosts", JSArray(pines.hosts))
		pines.prefs?.let { text -> runCatching { JSONObject(text) }.getOrNull()?.let { out.put("prefs", it) } }
		pines.use?.let { out.put("use", it) }
		// The names paired computers gave, which the page shows in place of their machine ids.
		val names = pines.names
		if (names.isNotEmpty()) out.put("names", JSONObject(names))
		out
	}

	@PluginMethod
	fun savePrefs(call: PluginCall) = later(call) {
		pines.prefs = (call.getObject("prefs") ?: throw IllegalArgumentException("No preferences given.")).toString()
		null
	}

	@PluginMethod
	fun openExternal(call: PluginCall) {
		val url = call.getString("url") ?: ""
		if (!outside(url)) return call.reject("Only an address of the web (http or https) opens outside the app.")
		openOutside(url)
		call.resolve()
	}

	@PluginMethod
	fun share(call: PluginCall) {
		val text = call.getString("text") ?: ""
		val title = call.getString("title") ?: "Pine"
		val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TITLE, title)
		activity.startActivity(Intent.createChooser(send, title))
		call.resolve()
	}

	@PluginMethod
	fun copy(call: PluginCall) {
		val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
		clipboard.setPrimaryClip(ClipData.newPlainText("Pine", call.getString("text") ?: ""))
		call.resolve()
	}

	// The page's theme, reported by the bridge: a #rrggbb color and a boolean, and nothing else is taken.
	@PluginMethod
	fun systemBars(call: PluginCall) {
		val color = call.getString("color") ?: ""
		val dark = call.data.opt("dark")
		if (!BAR_COLOR.matches(color) || dark !is Boolean) return call.reject("The system bars take a color as #rrggbb and whether the theme is dark.")
		activity.runOnUiThread {
			barColor = Color.parseColor(color)
			barsDark = dark
			paintBars()
			call.resolve()
		}
	}

	/**
	 * With the WebView padded by the system bars (index.html has no viewport-fit=cover), what shows
	 * under them is the window's own background: it takes the page's color, and the icons are light
	 * on a dark theme. Before Android 15 the bars have colors of their own, which take it too.
	 */
	@Suppress("DEPRECATION")
	private fun paintBars() {
		val window = activity.window
		window.decorView.setBackgroundColor(barColor)
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
			window.statusBarColor = barColor
			window.navigationBarColor = barColor
		}
		// No grey veil over the navigation bar with its three buttons: the page's color, as it is.
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
		WindowCompat.getInsetsController(window, window.decorView).apply {
			isAppearanceLightStatusBars = !barsDark
			isAppearanceLightNavigationBars = !barsDark
		}
	}

	// SystemBars paints the window's background and icons for the system's theme again on a rotation
	// or a change of the system's theme: the page's are put back after it.
	override fun handleOnConfigurationChanged(newConfig: Configuration) {
		super.handleOnConfigurationChanged(newConfig)
		activity.window.decorView.post { paintBars() }
	}

	@PluginMethod
	fun leave(call: PluginCall) {
		activity.moveTaskToBack(true)
		call.resolve()
	}

	@PluginMethod
	fun publicKey(call: PluginCall) = later(call) { JSObject().put("key", device.publicKey) }

	@PluginMethod
	fun trustHostKey(call: PluginCall) = later(call) { pines.trust(hostOf(call), call.getString("fingerprint") ?: "").let { null } }

	@PluginMethod
	fun forgetHostKey(call: PluginCall) = later(call) { pines.forgetKey(hostOf(call)).let { null } }

	// Android may cut the link while the app is in the back: on its return the pine in use is checked
	// (and connected again when it no longer answers) before the page is told it has the focus.
	override fun handleOnResume() {
		if (!::pines.isInitialized) return
		if (looking) browser.start()
		work.execute {
			runCatching { pines.check() }
			notifyListeners("focus", JSObject().put("focused", true))
		}
	}

	override fun handleOnPause() {
		// Looking for computers costs the network's multicast and the battery: never while in the back.
		if (::browser.isInitialized) browser.stop()
		notifyListeners("focus", JSObject().put("focused", false))
	}

	override fun handleOnDestroy() {
		if (::browser.isInitialized) browser.close()
		if (::pines.isInitialized) work.execute { pines.close() }
	}

	private class PrefsShelf(private val prefs: android.content.SharedPreferences) : Shelf {
		override fun get(name: String): String? = prefs.getString(name, null)
		override fun set(name: String, value: String?) {
			prefs.edit().apply { if (value == null) remove(name) else putString(name, value) }.commit()
		}
	}

	private companion object {
		const val KEY_ALIAS = "pine-vault"
		val BAR_COLOR = Regex("^#[0-9a-fA-F]{6}$")
	}
}
