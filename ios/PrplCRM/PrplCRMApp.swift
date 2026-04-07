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
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge when app is opened
        application.applicationIconBadgeNumber = 0
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

    // Handle notification when app is in foreground — show banner
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .badge, .sound])
    }

    // Handle notification tap — extract deep link URL
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo

        // Clear badge on notification tap
        UIApplication.shared.applicationIconBadgeNumber = 0

        if let urlString = userInfo["url"] as? String {
            print("[Push] Deep link: \(urlString)")
            DispatchQueue.main.async {
                self.pushManager.pendingDeepLink = urlString
            }
        }

        completionHandler()
    }
}
