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

    static let baseURL = "https://perun-crm.onrender.com"

    func registerDeviceToken(_ tokenHex: String) {
        guard let token = authToken, !token.isEmpty else {
            print("[Push] No auth token yet, will retry after login")
            UserDefaults.standard.set(tokenHex, forKey: "pendingDeviceToken")
            return
        }
        sendTokenToServer(tokenHex, authToken: token)
    }

    func sendTokenToServer(_ tokenHex: String, authToken: String) {
        guard let url = URL(string: "\(PushNotificationManager.baseURL)/api/push/apns/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": tokenHex])

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                print("[Push] Register failed: \(error.localizedDescription)")
                return
            }
            if let httpResponse = response as? HTTPURLResponse {
                print("[Push] Register response: \(httpResponse.statusCode)")
            }
        }.resume()
    }

    func retryPendingRegistration() {
        guard let token = authToken,
              let pendingToken = UserDefaults.standard.string(forKey: "pendingDeviceToken") else { return }
        UserDefaults.standard.removeObject(forKey: "pendingDeviceToken")
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
