import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let pine = PineViewController()
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = pine
        window?.makeKeyAndVisible()

        // A `pine:` address the app was started with (Info.plist's URL type): handed to the plugin,
        // which keeps it for the page; it never reaches the web view.
        for context in connectionOptions.urlContexts { pine.opened(context.url) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // A `pine:` address while the app runs: the plugin's, and Capacitor's proxy never sees it.
        let pine = URLContexts.filter { PineViewController.isPine($0.url) }
        for context in pine { (window?.rootViewController as? PineViewController)?.opened(context.url) }
        let rest = URLContexts.subtracting(pine)
        if !rest.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: rest) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
