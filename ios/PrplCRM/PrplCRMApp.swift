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
    var authToken: String?

    static let baseURL = "https://prplcrm.eu"

    private var retryCount = 0
    private let maxRetries = 5

    func registerDeviceToken(_ tokenHex: String) {
        guard let token = authToken, !token.isEmpty else {
            print("[Push] No auth token yet, will retry after login")
            UserDefaults.standard.set(tokenHex, forKey: "pendingDeviceToken")
            return
        }
        retryCount = 0
        sendTokenToServer(tokenHex, authToken: token)
    }

    func sendTokenToServer(_ tokenHex: String, authToken: String) {
        guard let url = URL(string: "\(PushNotificationManager.baseURL)/api/push/apns/register") else { return }

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
                if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
                    print("[Push] Device token registered successfully")
                    self.retryCount = 0
                    UserDefaults.standard.removeObject(forKey: "pendingDeviceToken")
                } else if httpResponse.statusCode == 401 {
                    // Auth token invalid — save for retry after re-login
                    print("[Push] Auth token invalid, saving for retry")
                    UserDefaults.standard.set(tokenHex, forKey: "pendingDeviceToken")
                } else {
                    self.retryWithBackoff(tokenHex: tokenHex, authToken: authToken)
                }
            }
        }.resume()
    }

    private func retryWithBackoff(tokenHex: String, authToken: String) {
        guard retryCount < maxRetries else {
            print("[Push] Max retries (\(maxRetries)) reached, saving token for next app launch")
            UserDefaults.standard.set(tokenHex, forKey: "pendingDeviceToken")
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

    func retryPendingRegistration() {
        guard let token = authToken,
              let pendingToken = UserDefaults.standard.string(forKey: "pendingDeviceToken") else { return }
        retryCount = 0
        sendTokenToServer(pendingToken, authToken: token)
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

    private func requestPushPermission(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            print("[Push] Permission granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[Push] Device token: \(tokenHex.prefix(16))...")
        UserDefaults.standard.set(tokenHex, forKey: "deviceToken")
        pushManager.registerDeviceToken(tokenHex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[Push] Registration failed: \(error.localizedDescription)")
    }

    // Handle notification tap when app is in foreground
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

        if let urlString = userInfo["url"] as? String {
            print("[Push] Deep link: \(urlString)")
            DispatchQueue.main.async {
                self.pushManager.pendingDeepLink = urlString
            }
        }

        completionHandler()
    }
}
