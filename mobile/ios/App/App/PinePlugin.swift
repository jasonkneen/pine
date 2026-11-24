// The native plugin the mobile bridge talks to (mobile/src/plugin.ts, registered as `Pine`): what
// Electron's main process is for the desktop page, and PinePlugin.kt on Android. It holds the SSH
// sessions and the daemons' tokens and makes every call; the page never sees either. A computer
// paired by its link is reached the same way, SSH over a data channel the core opens. What it
// decides lives in the core (mobile/ios-core, PineCore, tested by `swift test`): this file is the
// iOS glue around it (the Keychain, the app's defaults, Safari, the share sheet, the status bar,
// the app's life). PineViewController registers it and hardens the web view.
import Capacitor
import Foundation
import Network
import PineCore
import UIKit
import WebKit

@objc(PinePlugin)
public class PinePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "PinePlugin"
	public let jsName = "Pine"
	public let pluginMethods: [CAPPluginMethod] = [
		"state", "ready", "call", "retry", "use", "addHost", "forgetHost", "loadPrefs", "savePrefs",
		"openExternal", "share", "copy", "systemBars", "leave", "publicKey", "trustHostKey", "forgetHostKey",
		"pair", "cancelPairing", "nearby", "pairNearby",
	].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

	private(set) var pines: Pines?
	private var observers: [NSObjectProtocol] = []
	/**
	 * How an address of the web leaves the app: Safari. The smoke run puts a recorder in its place,
	 * so that a link it follows is noted and not opened.
	 */
	var opener: (URL) -> Void = { UIApplication.shared.open($0) }
	/**
	 * What the computer is told this phone is called when it pairs, and what it lists in its Settings >
	 * Browser access: "Pine on iPhone" (or iPad). iOS gives an app the kind of device, not the owner's
	 * name for it, and no model name without a table of hardware ids that would age.
	 */
	private var phone = deviceName(nil)
	/** Computers that announce themselves on this network, looked for only while the page asks (`nearby`). */
	private var browser: NearbyBrowser?

	override public func load() {
		phone = deviceName(UIDevice.current.model)
		let store = KeychainSecretStore()
		let remote = Remote(key: DeviceKey(store), known: KnownHosts(store))
		pines = Pines(remote: remote, shelf: DefaultsShelf(), page: PageOut(self))
		browser = NearbyBrowser { [weak self] event in self?.notifyListeners("nearby", data: event) }
		// Background keeps nothing on purpose: iOS may cut the link there. On the return the pine in
		// use is checked (and connected again when it no longer answers) before the page has the focus.
		let centre = NotificationCenter.default
		observers.append(centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
			// Looking for computers stops in the back, and starts again on the return if the page still asks.
			self?.browser?.pause()
			self?.notifyListeners("focus", data: ["focused": false])
		})
		observers.append(centre.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
			guard let self, let pines = self.pines else { return }
			self.browser?.resume()
			Task {
				await pines.check()
				self.notifyListeners("focus", data: ["focused": true])
			}
		})
	}

	deinit {
		observers.forEach(NotificationCenter.default.removeObserver)
	}

	// The page stays the page; an address of the web opens in Safari, anything else nowhere. Runs
	// before Capacitor's own policy, which would open any scheme in whatever app takes it.
	override public func shouldOverrideLoad(_ action: WKNavigationAction) -> NSNumber? {
		let url = action.request.url?.absoluteString ?? ""
		if stays(url) { return nil }
		if outside(url), action.targetFrame?.isMainFrame ?? true, let address = action.request.url { openOutside(address) }
		return true
	}

	func openOutside(_ url: URL) {
		guard outside(url.absoluteString) else { return }
		DispatchQueue.main.async { self.opener(url) }
	}

	/** Runs `job` off the bridge's queue; what it throws is the call's rejection, in words the page shows. */
	private func later(_ call: CAPPluginCall, _ job: @escaping (Pines) async throws -> [String: Any]?) {
		guard let pines else { return call.reject("The app has not started yet.") }
		Task {
			do {
				if let out = try await job(pines) { call.resolve(out) } else { call.resolve() }
			} catch {
				call.reject(Self.words(error))
			}
		}
	}

	private static func words(_ e: Error) -> String {
		switch e {
		case let e as RemoteError: return e.message
		case let e as SecretStoreError: return e.message
		default: return String(describing: e)
		}
	}

	private func hostOf(_ call: CAPPluginCall) throws -> String {
		guard let host = call.getString("host") else { throw RemoteError("ssh", "Name the machine.") }
		return host
	}

	@objc func state(_ call: CAPPluginCall) {
		guard let pines else { return call.reject("The app has not started yet.") }
		let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
		// This build pairs with a computer by its link (the page then offers pairing first).
		// It also finds computers on this network and pairs with them without a code.
		call.resolve(["state": pines.state(), "connected": pines.connected, "version": version, "canPair": true, "canPairNearby": true])
	}

	/**
	 * The owner's yes, in the page, to a pairing link: read again by the core (an https service only,
	 * the machine id and code of their shape), which rejects anything else, or a second pairing.
	 */
	@objc func pair(_ call: CAPPluginCall) {
		let link = call.getString("link") ?? ""
		later(call) { [phone] in try $0.pair(link, name: phone); return nil }
	}

	@objc func cancelPairing(_ call: CAPPluginCall) { later(call) { $0.cancelPairing(); return nil } }

	/**
	 * Start or stop looking for computers on this network; what is found comes as `nearby` events,
	 * none at first. Only this asks iOS for the local network, so its prompt never comes at launch.
	 */
	@objc func nearby(_ call: CAPPluginCall) {
		guard let on = call.getBool("on") else { return call.reject("Say whether to look: on, true or false.") }
		if on { browser?.start() } else { browser?.stop() }
		call.resolve()
	}

	/**
	 * The owner's tap on a computer found on the network: paired without a code, as user
	 * `nearby.<nonce>` with the nonce of its announcement. The core checks the id, the service and the
	 * nonce again (a machine id, an https origin, 22 base64url characters), and refuses a second pairing.
	 */
	@objc func pairNearby(_ call: CAPPluginCall) {
		let id = call.getString("id") ?? ""
		let service = call.getString("service") ?? ""
		let nonce = call.getString("nonce") ?? ""
		later(call) { [phone] in try $0.pairNearby(id: id, service: service, nonce: nonce, name: phone); return nil }
	}

	/**
	 * An address of the app's own scheme the app was opened with (the web client's "Open in the Pine
	 * app" on an iPhone). It starts nothing: the page reads it as it reads a pasted link, says so when
	 * it is not one, and otherwise asks the owner, whose yes calls `pair`. Kept until the page listens,
	 * for an address the app was started with. Only what comes as the web client's address for the
	 * app (the core's `openedLink`, mobile/cases/opened-links.json).
	 */
	func opened(_ url: URL) {
		guard let link = openedLink(url.absoluteString) else { return }
		notifyListeners("link", data: ["link": link], retainUntilConsumed: true)
	}

	@objc func ready(_ call: CAPPluginCall) { later(call) { $0.ready(); return nil } }

	@objc func call(_ call: CAPPluginCall) {
		let method = call.getString("method") ?? ""
		let url = call.getString("url") ?? ""
		let body = call.options["body"].flatMap { $0 is NSNull ? nil : $0 }
		later(call) { (await $0.call(method: method, url: url, body: body)).json }
	}

	@objc func retry(_ call: CAPPluginCall) { later(call) { $0.retry(); return nil } }

	@objc func use(_ call: CAPPluginCall) { later(call) { [self] in try $0.use(try hostOf(call)); return nil } }

	@objc func addHost(_ call: CAPPluginCall) { later(call) { [self] in ["hosts": try $0.addHost(try hostOf(call))] } }

	@objc func forgetHost(_ call: CAPPluginCall) { later(call) { [self] in ["hosts": try $0.forgetHost(try hostOf(call))] } }

	@objc func loadPrefs(_ call: CAPPluginCall) {
		later(call) { pines in
			var out: [String: Any] = ["hosts": pines.hosts]
			if let text = pines.prefs, let prefs = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] { out["prefs"] = prefs }
			if let use = pines.inUse { out["use"] = use }
			// The names paired computers gave, which the page shows in place of their machine ids.
			let names = pines.names
			if !names.isEmpty { out["names"] = names }
			return out
		}
	}

	@objc func savePrefs(_ call: CAPPluginCall) {
		guard let prefs = call.options["prefs"], JSONSerialization.isValidJSONObject(prefs), prefs is [AnyHashable: Any],
		      let data = try? JSONSerialization.data(withJSONObject: prefs) else { return call.reject("No preferences given.") }
		later(call) { $0.prefs = String(decoding: data, as: UTF8.self); return nil }
	}

	@objc func openExternal(_ call: CAPPluginCall) {
		let url = call.getString("url") ?? ""
		guard outside(url), let address = URL(string: url) else { return call.reject("Only an address of the web (http or https) opens outside the app.") }
		openOutside(address)
		call.resolve()
	}

	@objc func share(_ call: CAPPluginCall) {
		let text = call.getString("text") ?? ""
		DispatchQueue.main.async {
			guard let presenter = self.bridge?.viewController else { return call.reject("Nothing to show the share sheet over.") }
			let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
			// On an iPad the sheet is a popover, and a popover needs a place to point at.
			sheet.popoverPresentationController?.sourceView = presenter.view
			sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
			presenter.present(sheet, animated: true) { call.resolve() }
		}
	}

	@objc func copy(_ call: CAPPluginCall) {
		let text = call.getString("text") ?? ""
		DispatchQueue.main.async {
			UIPasteboard.general.string = text
			call.resolve()
		}
	}

	// The page's theme, reported by the bridge: a #rrggbb colour and a boolean, and nothing else is taken.
	@objc func systemBars(_ call: CAPPluginCall) {
		let colour = call.getString("color") ?? ""
		// A JSON boolean, not a number that would pass for one.
		guard let rgb = Self.rgb(colour), let flag = call.options["dark"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else {
			return call.reject("The system bars take a colour as #rrggbb and whether the theme is dark.")
		}
		DispatchQueue.main.async {
			(self.bridge?.viewController as? PineViewController)?.paint(rgb, dark: flag.boolValue)
			call.resolve()
		}
	}

	private static func rgb(_ text: String) -> UIColor? {
		guard text.count == 7, text.hasPrefix("#"), text.dropFirst().allSatisfy(\.isHexDigit), let n = UInt32(text.dropFirst(), radix: 16) else { return nil }
		return UIColor(red: CGFloat(n >> 16 & 0xff) / 255, green: CGFloat(n >> 8 & 0xff) / 255, blue: CGFloat(n & 0xff) / 255, alpha: 1)
	}

	// An iOS app is not left by itself: the owner goes home with the system's gesture.
	@objc func leave(_ call: CAPPluginCall) { call.resolve() }

	@objc func publicKey(_ call: CAPPluginCall) { later(call) { ["key": try $0.publicKey()] } }

	@objc func trustHostKey(_ call: CAPPluginCall) {
		let fingerprint = call.getString("fingerprint") ?? ""
		later(call) { [self] in try $0.trust(host: try hostOf(call), fingerprint: fingerprint); return nil }
	}

	@objc func forgetHostKey(_ call: CAPPluginCall) { later(call) { [self] in try $0.forgetKey(try hostOf(call)); return nil } }
}

/**
 * Looking for computers that announce themselves on this network (`_pine._tcp`, the Pine app's
 * Bonjour record) with NWBrowser, their TXT records read by the core (`nearbyComputer`) and listed
 * once per machine id. A record is never trusted: only the owner's tap starts a pairing, which
 * checks the host key against the machine id. When iOS refuses the local network to the app, the
 * page is told so (`denied`), so that it can say where to allow it. A browser that failed is started
 * again while the page still asks, after a wait that doubles from one second to thirty.
 */
private final class NearbyBrowser: @unchecked Sendable {
	/** DNS-SD's "the system's policy refuses this" (dns_sd.h `kDNSServiceErr_PolicyDenied`): the local network is not allowed. */
	private static let policyDenied: DNSServiceErrorType = -65570

	private let queue = DispatchQueue(label: "pine.nearby")
	private let tell: ([String: Any]) -> Void
	private var browser: NWBrowser?
	/** Whether the page asks to look (kept while the app is in the back, where nothing is looked for). */
	private var wanted = false
	private var told: [NearbyComputer]?
	/**
	 * The TXT record last read for each service still found. While a computer changes its nonce the
	 * system reports the service without a record for a moment (its goodbye, then the new record): the
	 * computer stays listed with what was read before, instead of leaving the list and coming back.
	 */
	private var lastRead: [String: [String: String?]] = [:]
	private var toldDenied = false
	private var denied = false
	/** The wait before a browser that failed is started again; back to the first once one is ready. */
	private var wait = NearbyBrowser.firstWait
	private var again: DispatchWorkItem?
	private static let firstWait: TimeInterval = 1
	private static let longestWait: TimeInterval = 30

	init(_ tell: @escaping ([String: Any]) -> Void) {
		self.tell = tell
	}

	func start() {
		queue.async {
			self.wanted = true
			self.wait = Self.firstWait
			self.begin()
		}
	}
	func stop() { queue.async { self.wanted = false; self.end() } }
	func pause() { queue.async { self.end() } }
	func resume() { queue.async { if self.wanted { self.begin() } } }

	/** `retry`: a browser that failed is started again, and the page keeps what it was told meanwhile. */
	private func begin(retry: Bool = false) {
		guard browser == nil else { return }
		if !retry {
			told = nil
			lastRead = [:]
			denied = false
			say([])
		}
		let browser = NWBrowser(for: .bonjourWithTXTRecord(type: NEARBY_TYPE, domain: nil), using: NWParameters())
		browser.stateUpdateHandler = { [weak self, weak browser] state in
			guard let self, let browser, self.browser === browser else { return }
			switch state {
			case let .waiting(error), let .failed(error):
				if case let .dns(code) = error, code == Self.policyDenied {
					self.denied = true
					self.say([])
				}
				if case .failed = state {
					self.end()
					self.later()
				}
			case .ready:
				self.wait = Self.firstWait
				if self.denied {
					self.denied = false
					self.found(browser.browseResults)
				}
			default:
				break
			}
		}
		browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
			guard let self, let browser, self.browser === browser else { return }
			self.found(results)
		}
		self.browser = browser
		browser.start(queue: queue)
	}

	/** Ends the browser, and a start again that waits. */
	private func end() {
		again?.cancel()
		again = nil
		browser?.cancel()
		browser = nil
	}

	/** Starts a browser again after `wait`, while the page still asks; the wait doubles up to `longestWait`. */
	private func later() {
		guard wanted else { return }
		let item = DispatchWorkItem { [weak self] in
			guard let self, self.wanted, self.browser == nil else { return }
			self.again = nil
			self.begin(retry: true)
		}
		again = item
		queue.asyncAfter(deadline: .now() + wait, execute: item)
		wait = min(wait * 2, Self.longestWait)
	}

	/** The whole list again from what the browser holds now; the page is told when it changed. */
	private func found(_ results: Set<NWBrowser.Result>) {
		let list = NearbyFound()
		// In a fixed order, so that the same services make the same list.
		var read: [String: [String: String?]] = [:]
		for (name, result) in results.map({ ("\($0.endpoint)|\($0.interfaces.map(\.name))", $0) }).sorted(by: { $0.0 < $1.0 }) {
			if case let .bonjour(record) = result.metadata, record.count > 0 {
				read[name] = record.dictionary.mapValues { Optional($0) }
			} else if let before = lastRead[name] {
				read[name] = before
			}
			guard let txt = read[name] else { continue }
			list.found(name, nearbyComputer(txt))
		}
		lastRead = read
		say(list.list)
	}

	private func say(_ computers: [NearbyComputer]) {
		if told == computers, toldDenied == denied { return }
		told = computers
		toldDenied = denied
		var event: [String: Any] = ["computers": computers.map(\.json)]
		if denied { event["denied"] = true }
		tell(event)
	}
}

/** What the core tells the page, as the plugin's events. */
private final class PageOut: Page, @unchecked Sendable {
	private weak var plugin: PinePlugin?

	init(_ plugin: PinePlugin) {
		self.plugin = plugin
	}

	func service(_ state: [String: Any]) { plugin?.notifyListeners("service", data: ["state": state]) }
	func events(_ batch: [Any]) { plugin?.notifyListeners("events", data: ["events": batch]) }
	func connection(_ up: Bool) { plugin?.notifyListeners("connection", data: ["connected": up]) }
}

/** The machines, the one in use and the page's preferences: the app's own defaults, not secret. */
private struct DefaultsShelf: Shelf {
	private static let prefix = "pine."

	func get(_ name: String) -> String? { UserDefaults.standard.string(forKey: Self.prefix + name) }

	func set(_ name: String, _ value: String?) {
		if let value { UserDefaults.standard.set(value, forKey: Self.prefix + name) } else { UserDefaults.standard.removeObject(forKey: Self.prefix + name) }
	}
}
