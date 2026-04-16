import SwiftUI
import UserNotifications

@main
struct PrplCRMApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .environmentObject(appDelegate.pushManager)
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
                print("[Push] Auth token received, attempting device registration")
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
        print("[Push] Device token saved: \(tokenHex.prefix(16))...")

        guard let token = authToken, !token.isEmpty else {
            print("[Push] No auth token yet, saved device token for later")
            return
        }
        retryCount = 0
        sendTokenToServer(tokenHex, authToken: token)
    }

    /// Try to register with whatever device token we have
    func tryRegisterDevice() {
        guard let deviceToken = UserDefaults.standard.string(forKey: "deviceToken"),
              !deviceToken.isEmpty else {
            print("[Push] No device token available yet")
            return
        }
        guard let token = authToken, !token.isEmpty else {
            print("[Push] No auth token available yet")
            return
        }
        retryCount = 0
        print("[Push] Registering device token \(deviceToken.prefix(16))... with auth token")
        sendTokenToServer(deviceToken, authToken: token)
    }

    func sendTokenToServer(_ tokenHex: String, authToken: String) {
        guard let url = URL(string: "\(PushNotificationManager.baseURL)/api/push/apns/register") else {
            print("[Push] Invalid URL")
            return
        }

        print("[Push] Sending registration to \(PushNotificationManager.baseURL)")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": tokenHex])

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                print("[Push] Register failed: \(error.localizedDescription)")
                self.retryWithBackoff(tokenHex: tokenHex, authToken: authToken)
                return
            }

            if let httpResponse = response as? HTTPURLResponse {
                print("[Push] Register response: \(httpResponse.statusCode)")

                if let data = data, let body = String(data: data, encoding: .utf8) {
                    print("[Push] Response body: \(body.prefix(200))")
                }

                if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
                    print("[Push] Device token registered successfully!")
                    self.retryCount = 0
                } else if httpResponse.statusCode == 401 {
                    print("[Push] Auth token invalid (401)")
                    // Don't retry — wait for new auth token from WebView
                } else {
                    print("[Push] Registration failed with status \(httpResponse.statusCode)")
                    self.retryWithBackoff(tokenHex: tokenHex, authToken: authToken)
                }
            }
        }.resume()
    }

    private func retryWithBackoff(tokenHex: String, authToken: String) {
        guard retryCount < maxRetries else {
            print("[Push] Max retries (\(maxRetries)) reached")
            retryCount = 0
            return
        }

        retryCount += 1
        let delay = pow(2.0, Double(retryCount)) // 2s, 4s, 8s, 16s, 32s
        print("[Push] Retrying in \(delay)s (attempt \(retryCount)/\(maxRetries))")

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
            print("[Push] Cold launch via notification, extracting deep link")
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
        print("[Push] extractDeepLink: full userInfo=\(userInfo)")
        if let urlString = userInfo["url"] as? String, !urlString.isEmpty, urlString != "/" {
            let hasWs = urlString.contains("ws=")
            print("[Push] Deep link URL: \(urlString) (hasWs=\(hasWs))")
            self.pushManager.pendingDeepLink = urlString
            return
        }

        let type = userInfo["type"] as? String ?? ""
        print("[Push] No valid URL in payload (url=\(userInfo["url"] ?? "nil")), type=\(type)")

        if type.hasPrefix("message"), let messageId = userInfo["messageId"] as? String {
            let url = "/messages?highlight=\(messageId)"
            print("[Push] Constructed message deep link: \(url)")
            self.pushManager.pendingDeepLink = url
        } else if type.hasPrefix("contact"), let contactId = userInfo["contactId"] as? String {
            let url = "/crm?expandContact=\(contactId)"
            print("[Push] Constructed contact deep link: \(url)")
            self.pushManager.pendingDeepLink = url
        } else if type.hasPrefix("task") || type.hasPrefix("subtask"),
                  let taskId = userInfo["taskId"] as? String {
            // NOTE: zámerne NEpridávame contactId do URL — Tasks.jsx by ho
            // interpretoval ako filter a navigate('/tasks', replace) by
            // zmazal highlightTask. Viď GEMMA_PROJECT_GUIDE.md §6.3 invariant.
            var url = "/tasks?highlightTask=\(taskId)"
            if let subtaskId = userInfo["subtaskId"] as? String {
                url += "&subtask=\(subtaskId)"
            }
            print("[Push] Constructed task deep link: \(url)")
            self.pushManager.pendingDeepLink = url
        } else {
            print("[Push] Could not construct deep link, no matching data")
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge when app is opened
        application.applicationIconBadgeNumber = 0
        // Clear delivered notifications from Notification Center too — user is
        // now in the app and can see their unread state there, so stale APNs
        // banners in the Center are noise. Matches Slack/Messenger behavior.
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private func requestPushPermission(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            print("[Push] Permission granted: \(granted)")
            if let error = error {
                print("[Push] Permission error: \(error.localizedDescription)")
            }
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            } else {
                print("[Push] User denied push notifications")
            }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[Push] Got device token from Apple: \(tokenHex.prefix(16))...")
        pushManager.registerDeviceToken(tokenHex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[Push] Apple registration FAILED: \(error.localizedDescription)")
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

        // Clear badge on notification tap
        UIApplication.shared.applicationIconBadgeNumber = 0
        // Also clear all delivered notifications — user actively engaged with
        // one, so the rest in the Center are stale context.
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()

        print("[Push] Notification tapped, userInfo keys: \(Array(userInfo.keys))")
        self.extractDeepLink(from: userInfo)
        print("[Push] pendingDeepLink after processing: \(self.pushManager.pendingDeepLink ?? "nil")")
        completionHandler()
    }
}
