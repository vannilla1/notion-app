import SwiftUI
import UserNotifications

// MARK: - Debug logging
//
// V DEBUG buildoch sa loguje do Console (rovnako ako print). V RELEASE buildoch
// sa volanie kompletne odstráni optimalizátorom (`@inline` s prázdnym telom).
// Takto nebudeme v App Store build-e leakovať interné diagnostické hlášky do
// zariadeniovho Console, ale stále máme plný debug logging lokálne v Xcode.
#if DEBUG
@inline(__always) func debugLog(_ items: Any...) {
    print(items.map { "\($0)" }.joined(separator: " "))
}
#else
@inline(__always) func debugLog(_: Any...) {}
#endif

@main
struct PrplCRMApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    /// Deterministicky dispatchne Universal Link do Coordinatora cez NSNotification-
    /// Center. Obchádza SwiftUI render cyklus (@Published/updateUIView), ktorý v
    /// kombinácii s `appWillEnterForeground`-delayed-reload vytváral race window:
    /// reload vyplavil práve navigovanú deep-link URL a user skončil späť na /app.
    /// Coordinator pozoruje `PrplCRMDeepLinkReceived` synchrónne → webView.load()
    /// prebehne ešte pred tým, ako sa vôbec naplánuje foreground reload.
    ///
    /// `pendingDeepLink` stále nastavíme kvôli UI state visibility (napr. ak by
    /// sme chceli vizuálne loading feedback) a pre kompatibilitu s fallback
    /// updateUIView vetvou pre edge case-y (prvé mount-y keď Coordinator observer
    /// ešte nie je nainštalovaný).
    fileprivate static func dispatchDeepLink(_ urlString: String, via appDelegate: AppDelegate) {
        NotificationCenter.default.post(
            name: Notification.Name("PrplCRMDeepLinkReceived"),
            object: nil,
            userInfo: ["url": urlString]
        )
        appDelegate.pushManager.pendingDeepLink = urlString
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .environmentObject(appDelegate.pushManager)
                // Universal Links — iOS sem doručí URL keď Safari narazí na
                // applinks match (post-OAuth redirect z Google, push deep linky
                // mimo natívnu APNs payload, atď.). Uložíme do pushManager-a
                // `pendingDeepLink` → ContentView `onChange(of:)` reloadne
                // WebView na danú URL.
                .onOpenURL { url in
                    debugLog("[UniversalLink] Received: \(url.absoluteString)")
                    Self.dispatchDeepLink(url.absoluteString, via: appDelegate)
                }
                // Scene-level handler pre continue-user-activity (Safari → app
                // transition používa NSUserActivity s webpageURL, nie onOpenURL).
                // Obidva volajú ten istý state setter, takže je jedno ktorý cestou
                // iOS systém sa rozhodne posielať — vždy to zachytíme.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL {
                        debugLog("[UniversalLink] Continue activity: \(url.absoluteString)")
                        Self.dispatchDeepLink(url.absoluteString, via: appDelegate)
                    }
                }
        }
    }
}

/// Manages push notification state and deep link URLs
class PushNotificationManager: ObservableObject {
    @Published var pendingDeepLink: String?
    var authToken: String? {
        didSet {
            // Whenever auth token is set/changed, try to register device
            if let token = authToken, !token.isEmpty {
                debugLog("[Push] Auth token received, attempting device registration")
                tryRegisterDevice()
            }
        }
    }

    static let baseURL = "https://perun-crm-api.onrender.com"

    private var retryCount = 0
    private let maxRetries = 5

    /// Called when iOS gives us a device token
    func registerDeviceToken(_ tokenHex: String) {
        // Always save the device token
        UserDefaults.standard.set(tokenHex, forKey: "deviceToken")
        debugLog("[Push] Device token saved: \(tokenHex.prefix(16))...")

        guard let token = authToken, !token.isEmpty else {
            debugLog("[Push] No auth token yet, saved device token for later")
            return
        }
        retryCount = 0
        sendTokenToServer(tokenHex, authToken: token)
    }

    /// Try to register with whatever device token we have
    func tryRegisterDevice() {
        guard let deviceToken = UserDefaults.standard.string(forKey: "deviceToken"),
              !deviceToken.isEmpty else {
            debugLog("[Push] No device token available yet")
            return
        }
        guard let token = authToken, !token.isEmpty else {
            debugLog("[Push] No auth token available yet")
            return
        }
        retryCount = 0
        debugLog("[Push] Registering device token \(deviceToken.prefix(16))... with auth token")
        sendTokenToServer(deviceToken, authToken: token)
    }

    func sendTokenToServer(_ tokenHex: String, authToken: String) {
        guard let url = URL(string: "\(PushNotificationManager.baseURL)/api/push/apns/register") else {
            debugLog("[Push] Invalid URL")
            return
        }

        debugLog("[Push] Sending registration to \(PushNotificationManager.baseURL)")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": tokenHex])

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                debugLog("[Push] Register failed: \(error.localizedDescription)")
                self.retryWithBackoff(tokenHex: tokenHex, authToken: authToken)
                return
            }

            if let httpResponse = response as? HTTPURLResponse {
                debugLog("[Push] Register response: \(httpResponse.statusCode)")

                if let data = data, let body = String(data: data, encoding: .utf8) {
                    debugLog("[Push] Response body: \(body.prefix(200))")
                }

                if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
                    debugLog("[Push] Device token registered successfully!")
                    self.retryCount = 0
                } else if httpResponse.statusCode == 401 {
                    debugLog("[Push] Auth token invalid (401)")
                    // Don't retry — wait for new auth token from WebView
                } else {
                    debugLog("[Push] Registration failed with status \(httpResponse.statusCode)")
                    self.retryWithBackoff(tokenHex: tokenHex, authToken: authToken)
                }
            }
        }.resume()
    }

    private func retryWithBackoff(tokenHex: String, authToken: String) {
        guard retryCount < maxRetries else {
            debugLog("[Push] Max retries (\(maxRetries)) reached")
            retryCount = 0
            return
        }

        retryCount += 1
        let delay = pow(2.0, Double(retryCount)) // 2s, 4s, 8s, 16s, 32s
        debugLog("[Push] Retrying in \(delay)s (attempt \(retryCount)/\(maxRetries))")

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.sendTokenToServer(tokenHex, authToken: authToken)
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let pushManager = PushNotificationManager()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        requestPushPermission(application)

        // Cold-start deep link: if the app was launched by tapping a push
        // notification, iOS hands us the payload here — BEFORE SwiftUI
        // renders ContentView. We set pendingDeepLink synchronously so
        // that WebView.makeUIView can load the deep-link URL instead of
        // the default /app. Without this the hardcoded /app loads first
        // and there's a race with updateUIView to redirect.
        if let remoteNotif = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            debugLog("[Push] Cold launch via notification, extracting deep link")
            self.extractDeepLink(from: remoteNotif)
        }

        return true
    }

    /// Extracts deep-link URL from an APNs payload and stores it on
    /// pushManager.pendingDeepLink. Shared by cold-start (launchOptions)
    /// and hot/background taps (didReceive response).
    fileprivate func extractDeepLink(from userInfo: [AnyHashable: Any]) {
        // Diagnostic: dump entire payload so we can verify in Console.app
        // that ws= actually arrived from the server. Cross-workspace routing
        // depends on this — if ws= is missing here, the bug is server-side.
        debugLog("[Push] extractDeepLink: full userInfo=\(userInfo)")
        if let urlString = userInfo["url"] as? String, !urlString.isEmpty, urlString != "/" {
            let hasWs = urlString.contains("ws=")
            debugLog("[Push] Deep link URL: \(urlString) (hasWs=\(hasWs))")
            self.pushManager.pendingDeepLink = urlString
            // Also broadcast via Cocoa NotificationCenter so the WebView
            // Coordinator can load the URL directly — bypasses SwiftUI's
            // @Published re-render chain which was silently dropping hot-start
            // taps (user reported "notification tap did nothing when app was
            // in background"). Coordinator observer handles deterministic load.
            NotificationCenter.default.post(
                name: Notification.Name("PrplCRMDeepLinkReceived"),
                object: nil,
                userInfo: ["url": urlString]
            )
            return
        }

        let type = userInfo["type"] as? String ?? ""
        debugLog("[Push] No valid URL in payload (url=\(userInfo["url"] ?? "nil")), type=\(type)")

        var fallbackUrl: String?
        if type.hasPrefix("message"), let messageId = userInfo["messageId"] as? String {
            fallbackUrl = "/messages?highlight=\(messageId)"
            debugLog("[Push] Constructed message deep link: \(fallbackUrl!)")
        } else if type.hasPrefix("contact"), let contactId = userInfo["contactId"] as? String {
            fallbackUrl = "/crm?expandContact=\(contactId)"
            debugLog("[Push] Constructed contact deep link: \(fallbackUrl!)")
        } else if type.hasPrefix("task") || type.hasPrefix("subtask"),
                  let taskId = userInfo["taskId"] as? String {
            // NOTE: zámerne NEpridávame contactId do URL — Tasks.jsx by ho
            // interpretoval ako filter a navigate('/tasks', replace) by
            // zmazal highlightTask. Viď GEMMA_PROJECT_GUIDE.md §6.3 invariant.
            var url = "/tasks?highlightTask=\(taskId)"
            if let subtaskId = userInfo["subtaskId"] as? String {
                url += "&subtask=\(subtaskId)"
            }
            // Workspace fallback too — if top-level userInfo["url"] was missing
            // but workspaceId is present in the payload, honor it so we still
            // route cross-workspace correctly.
            if let wsId = userInfo["workspaceId"] as? String, !wsId.isEmpty {
                url += "&ws=\(wsId)"
            }
            fallbackUrl = url
            debugLog("[Push] Constructed task deep link: \(url)")
        } else {
            debugLog("[Push] Could not construct deep link, no matching data")
        }
        if let url = fallbackUrl {
            self.pushManager.pendingDeepLink = url
            NotificationCenter.default.post(
                name: Notification.Name("PrplCRMDeepLinkReceived"),
                object: nil,
                userInfo: ["url": url]
            )
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge when app is opened. `setBadgeCount` je iOS 16+ API ktoré
        // nahradzuje deprecated `applicationIconBadgeNumber` z iOS 17+. Deployment
        // target = 16.0, takže sa na deprecation warning už nebojíme.
        UNUserNotificationCenter.current().setBadgeCount(0)
        // Clear delivered notifications from Notification Center too — user is
        // now in the app and can see their unread state there, so stale APNs
        // banners in the Center are noise. Matches Slack/Messenger behavior.
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private func requestPushPermission(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            debugLog("[Push] Permission granted: \(granted)")
            if let error = error {
                debugLog("[Push] Permission error: \(error.localizedDescription)")
            }
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            } else {
                debugLog("[Push] User denied push notifications")
            }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        debugLog("[Push] Got device token from Apple: \(tokenHex.prefix(16))...")
        pushManager.registerDeviceToken(tokenHex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        debugLog("[Push] Apple registration FAILED: \(error.localizedDescription)")
    }

    // Handle notification when app is in foreground — show banner + keep in notification center
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if #available(iOS 16.0, *) {
            completionHandler([.banner, .list, .badge, .sound])
        } else {
            completionHandler([.banner, .badge, .sound])
        }
    }

    // Handle notification tap — extract deep link URL
    // IMPORTANT: Set pendingDeepLink synchronously (no DispatchQueue.main.async)
    // because didReceive is already on the main thread. Async dispatch causes a
    // race condition on cold start: SwiftUI evaluates ContentView.body before
    // the async block runs, so pendingDeepLink is nil and the app loads /app
    // (dashboard) instead of the deep link URL.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo

        // Clear badge on notification tap (iOS 16+ API, viď poznámka vyššie).
        UNUserNotificationCenter.current().setBadgeCount(0)
        // Also clear all delivered notifications — user actively engaged with
        // one, so the rest in the Center are stale context.
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()

        debugLog("[Push] Notification tapped, userInfo keys: \(Array(userInfo.keys))")
        self.extractDeepLink(from: userInfo)
        debugLog("[Push] pendingDeepLink after processing: \(self.pushManager.pendingDeepLink ?? "nil")")
        completionHandler()
    }
}
