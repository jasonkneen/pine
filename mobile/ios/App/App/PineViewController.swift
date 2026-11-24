// The app's one window: Capacitor's bridge view controller around the Pine page, with what
// PinePlugin.kt does to the WebView on Android done to the WKWebView here. It registers the plugin,
// answers the `pine-media:` scheme (MediaScheme.swift), and keeps the page to itself: no camera,
// microphone or motion sensors, no new window, no navigation away (the plugin's shouldOverrideLoad),
// no link previews, no web inspector in a release build. The status bar takes the page's theme. A
// `pine:` address the app is opened with goes to the plugin, never to the web view.
import Capacitor
import PineCore
import UIKit
import WebKit

class PineViewController: CAPBridgeViewController {
	/** The page's plugin: the SSH sessions, the daemon's token, every call. */
	private(set) var plugin: PinePlugin?
	/** Capacitor's own UI delegate, wrapped (the web view holds its delegate weakly: this keeps it). */
	private(set) var pageUI: PageUI?
	/** The media scheme's handler, made with the web view's configuration, before the plugin. */
	let media = MediaScheme()
	private var barStyle: UIStatusBarStyle = .lightContent
	/** `pine:` addresses that came before the plugin was there: handed to it as soon as it is. */
	private var waiting: [URL] = []

	/** Whether an address is the app's own scheme, `pine:` (a pairing link from the web client on an iPhone). */
	static func isPine(_ url: URL) -> Bool { url.scheme?.lowercased() == "pine" }

	/**
	 * The app was opened with an address of its scheme (Info.plist's `CFBundleURLTypes`), at the start
	 * or while it runs. The plugin hands it to the page, which asks the owner; nothing pairs here.
	 */
	func opened(_ url: URL) {
		guard Self.isPine(url) else { return }
		if let plugin { plugin.opened(url) } else { waiting.append(url) }
	}

	override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
		let config = super.webViewConfiguration(for: instanceConfiguration)
		config.setURLSchemeHandler(media, forURLScheme: mediaScheme)
		// No window comes up by itself; one asked for by a gesture is refused by PageUI.
		config.preferences.javaScriptCanOpenWindowsAutomatically = false
		return config
	}

	override func capacitorDidLoad() {
		super.capacitorDidLoad()
		let plugin = PinePlugin()
		bridge?.registerPluginInstance(plugin)
		self.plugin = plugin
		waiting.forEach(plugin.opened)
		waiting.removeAll()
		media.pines = { [weak plugin] in plugin?.pines }
		guard let webView else { return }
		// Capacitor's delegate grants the camera, the microphone and the motion sensors, and opens a
		// window's address in whatever app takes its scheme. PageUI answers those, and hands it the rest.
		let ui = PageUI(capacitor: webView.uiDelegate as? WebViewDelegationHandler, open: { [weak plugin] url in plugin?.openOutside(url) })
		pageUI = ui
		webView.uiDelegate = ui
		webView.allowsLinkPreview = false
		#if !DEBUG
		// A release build is not inspected from a Mac's Safari; a debug build keeps Capacitor's default.
		webView.isInspectable = false
		#endif
		paint(UIColor(red: 0x1b / 255, green: 0x1e / 255, blue: 0x28 / 255, alpha: 1), dark: true)
		NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
		NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: UIResponder.keyboardDidShowNotification, object: nil)
		NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: UIResponder.keyboardDidHideNotification, object: nil)
	}

	/**
	 * The web view covers the screen and the page keeps inside the safe area (the iOS build pads it by
	 * `env(safe-area-inset-*)`). The keyboard is made part of that safe area, so that the page ends
	 * above it, its message box in sight and its header below the status bar. WebKit would rather
	 * scroll the whole page up to show a field (the page itself does not scroll: `scrollEnabled` is
	 * off), which takes the header under the status bar: the page is kept where it is. The inset
	 * moves with the keyboard, over its own time and curve.
	 */
	@objc private func keyboardMoved(_ note: Notification) {
		guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
		let hidden = note.name == UIResponder.keyboardDidHideNotification
		let below = view.safeAreaInsets.bottom - additionalSafeAreaInsets.bottom
		let extra = max(0, (hidden ? 0 : covered(by: end)) - below)
		if additionalSafeAreaInsets.bottom != extra {
			let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
			let curve = note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? UInt(UIView.AnimationCurve.easeInOut.rawValue)
			UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
				self.additionalSafeAreaInsets.bottom = extra
				self.view.layoutIfNeeded()
			}
		}
		webView?.scrollView.contentOffset = .zero
	}

	/**
	 * How much of this view's bottom the keyboard covers, in its points. The notice gives the frame in
	 * the screen's coordinates, which are not the window's under Stage Manager or in Slide Over. A
	 * keyboard that does not reach the view's bottom (an iPad's floating or split keyboard, undocked)
	 * covers nothing the page has to keep out of: it floats over it, and the page stays whole.
	 */
	private func covered(by end: CGRect) -> CGFloat {
		guard let screen = view.window?.windowScene?.screen else { return 0 }
		let frame = view.convert(end, from: screen.coordinateSpace)
		let over = frame.intersection(view.bounds)
		guard !over.isNull, over.height > 0, frame.maxY >= view.bounds.maxY - 1 else { return 0 }
		return view.bounds.maxY - over.minY
	}

	/**
	 * The page's background under the status bar, and its icons light on a dark theme and dark on a
	 * light one, as the Android plugin paints the system bars. iOS has no navigation bar to paint.
	 */
	func paint(_ colour: UIColor, dark: Bool) {
		view.backgroundColor = colour
		webView?.backgroundColor = colour
		webView?.scrollView.backgroundColor = colour
		webView?.underPageBackgroundColor = colour
		barStyle = dark ? .lightContent : .darkContent
		setStatusBarStyle(barStyle)
		setNeedsStatusBarAppearanceUpdate()
	}

	override var preferredStatusBarStyle: UIStatusBarStyle { barStyle }
}

/**
 * The page's UI delegate: Capacitor's, with what it would give the page taken away. What the page
 * asks for that would reach outside it is refused, and noted (`refused`) for the smoke run to read;
 * alerts and the rest go to Capacitor's handler, as before.
 */
final class PageUI: NSObject, WKUIDelegate {
	/** Capacitor's delegate, for the panels (alert, confirm, prompt); without it a panel is answered as dismissed. */
	private let capacitor: WebViewDelegationHandler?
	private let open: (URL) -> Void
	/** What was refused, in order: "camera", "microphone", "camera and microphone", "motion", "window". */
	private(set) var refused: [String] = []

	init(capacitor: WebViewDelegationHandler?, open: @escaping (URL) -> Void) {
		self.capacitor = capacitor
		self.open = open
	}

	// The camera and the microphone: never given to the page. A photo comes through the system's picker.
	func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
		refused.append(type == .camera ? "camera" : type == .microphone ? "microphone" : "camera and microphone")
		decisionHandler(.deny)
	}

	func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
		refused.append("motion")
		decisionHandler(.deny)
	}

	// No second web view: an address of the web opens in Safari, anything else nowhere.
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		refused.append("window")
		if let url = navigationAction.request.url, outside(url.absoluteString) { open(url) }
		return nil
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		guard let capacitor else { return completionHandler() }
		capacitor.webView(webView, runJavaScriptAlertPanelWithMessage: message, initiatedByFrame: frame, completionHandler: completionHandler)
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
		guard let capacitor else { return completionHandler(false) }
		capacitor.webView(webView, runJavaScriptConfirmPanelWithMessage: message, initiatedByFrame: frame, completionHandler: completionHandler)
	}

	func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
		guard let capacitor else { return completionHandler(nil) }
		capacitor.webView(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText, initiatedByFrame: frame, completionHandler: completionHandler)
	}
}
