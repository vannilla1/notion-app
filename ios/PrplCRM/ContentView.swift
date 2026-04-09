import SwiftUI
import WebKit
import LocalAuthentication

struct ContentView: View {
    @EnvironmentObject var pushManager: PushNotificationManager
    @State private var isLoading = true
    @State private var loadError = false
    @State private var isLocked = false
    @State private var biometricFailed = false

    var body: some View {
        ZStack {
            WebView(
                url: URL(string: "https://prplcrm.eu/app")!,
                isLoading: $isLoading,
                loadError: $loadError,
                pushManager: pushManager
            )

            if isLoading {
                SplashView()
                    .transition(.opacity)
            }

            if loadError {
                ErrorView(onRetry: {
                    loadError = false
                    isLoading = true
                })
            }

            // Face ID / biometric lock screen
            if isLocked {
                LockScreenView(
                    biometricFailed: biometricFailed,
                    onAuthenticate: { authenticate() }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isLoading)
        .animation(.easeInOut(duration: 0.3), value: loadError)
        .animation(.easeInOut(duration: 0.3), value: isLocked)
        .onAppear {
            // If we have a saved token, require biometric auth
            if KeychainHelper.getToken() != nil {
                isLocked = true
                authenticate()
            }
        }
    }

    private func authenticate() {
        biometricFailed = false
        let context = LAContext()
        var error: NSError?

        // Try biometrics first (Face ID / Touch ID)
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Overenie identity pre prístup do Prpl CRM"
            ) { success, _ in
                DispatchQueue.main.async {
                    if success {
                        isLocked = false
                    } else {
                        biometricFailed = true
                    }
                }
            }
        } else {
            // Fallback to device passcode
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Overenie identity pre prístup do Prpl CRM"
            ) { success, _ in
                DispatchQueue.main.async {
                    if success {
                        isLocked = false
                    } else {
                        biometricFailed = true
                    }
                }
            }
        }
    }
}

struct LockScreenView: View {
    var biometricFailed: Bool
    var onAuthenticate: () -> Void

    var body: some View {
        ZStack {
            Color(red: 99/255, green: 102/255, blue: 241/255)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                Image("AppLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 80, height: 80)
                    .cornerRadius(16)

                Text("Prpl CRM")
                    .font(.title.bold())
                    .foregroundColor(.white)

                if biometricFailed {
                    Text("Overenie zlyhalo")
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.8))
                        .padding(.top, 8)

                    Button(action: onAuthenticate) {
                        HStack(spacing: 8) {
                            Image(systemName: biometricIconName())
                                .font(.title3)
                            Text("Skúsiť znova")
                        }
                        .font(.headline)
                        .foregroundColor(Color(red: 99/255, green: 102/255, blue: 241/255))
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                        .background(.white)
                        .cornerRadius(12)
                    }
                } else {
                    Image(systemName: biometricIconName())
                        .font(.system(size: 48))
                        .foregroundColor(.white)
                        .padding(.top, 16)
                }
            }
        }
    }

    private func biometricIconName() -> String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        default: return "lock.shield"
        }
    }
}

struct SplashView: View {
    var body: some View {
        ZStack {
            Color(red: 99/255, green: 102/255, blue: 241/255)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Image("AppLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 80, height: 80)
                    .cornerRadius(16)

                Text("Prpl CRM")
                    .font(.title.bold())
                    .foregroundColor(.white)

                ProgressView()
                    .tint(.white)
                    .padding(.top, 8)
            }
        }
    }
}

struct ErrorView: View {
    var onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(red: 99/255, green: 102/255, blue: 241/255)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 48))
                    .foregroundColor(.white)

                Text("Nepodarilo sa pripojiť")
                    .font(.title2.bold())
                    .foregroundColor(.white)

                Text("Skontrolujte internetové pripojenie\na skúste znova.")
                    .font(.body)
                    .foregroundColor(.white.opacity(0.8))
                    .multilineTextAlignment(.center)

                Button(action: onRetry) {
                    Text("Skúsiť znova")
                        .font(.headline)
                        .foregroundColor(Color(red: 99/255, green: 102/255, blue: 241/255))
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                        .background(.white)
                        .cornerRadius(12)
                }
                .padding(.top, 8)
            }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool
    @Binding var loadError: Bool
    let pushManager: PushNotificationManager

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        // Enable service worker for PWA
        if #available(iOS 16.4, *) {
            config.preferences.isElementFullscreenEnabled = true
        }

        // Add message handlers
        config.userContentController.add(
            context.coordinator, name: "iosNative"
        )
        config.userContentController.add(
            context.coordinator, name: "fileDownload"
        )
        config.userContentController.add(
            context.coordinator, name: "openExternal"
        )

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 99/255, green: 102/255, blue: 241/255, alpha: 1)

        // Set mobile user agent
        webView.customUserAgent = "PrplCRM-iOS/1.0 " + (webView.value(forKey: "userAgent") as? String ?? "")

        // Restore token from Keychain BEFORE page JS runs
        if let savedToken = KeychainHelper.getToken() {
            let escapedToken = savedToken.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let restoreScript = WKUserScript(
                source: "localStorage.setItem('token', '\(escapedToken)');",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            config.userContentController.addUserScript(restoreScript)
            print("[Keychain] Injecting saved token into WebView localStorage")
        }

        // Inject CSS safe area variables + auth token bridge
        let script = WKUserScript(
            source: """
            document.documentElement.style.setProperty('--sat', 'env(safe-area-inset-top)');
            document.documentElement.style.setProperty('--sab', 'env(safe-area-inset-bottom)');
            document.documentElement.style.setProperty('--sal', 'env(safe-area-inset-left)');
            document.documentElement.style.setProperty('--sar', 'env(safe-area-inset-right)');
            document.body.classList.add('ios-app');

            // Force header padding for status bar - inject CSS directly
            var iosStyle = document.createElement('style');
            iosStyle.textContent = '.crm-header { padding-top: calc(env(safe-area-inset-top, 59px) + 16px) !important; }';
            document.head.appendChild(iosStyle);

            // Extract auth token from localStorage and send to native
            (function() {
                function sendTokenToNative(token) {
                    try {
                        if (token && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosNative) {
                            window.webkit.messageHandlers.iosNative.postMessage({ type: 'authToken', token: token });
                            return true;
                        }
                    } catch(e) {}
                    return false;
                }

                // Try immediately
                var token = localStorage.getItem('token');
                if (token) {
                    sendTokenToNative(token);
                }

                // Watch for token changes (after login)
                try {
                    var origSetItem = localStorage.setItem.bind(localStorage);
                    localStorage.setItem = function(key, value) {
                        origSetItem(key, value);
                        if (key === 'token') {
                            sendTokenToNative(value);
                        }
                    };
                } catch(e) {}

                // Watch for logout (token removal)
                try {
                    var origRemoveItem = localStorage.removeItem.bind(localStorage);
                    localStorage.removeItem = function(key) {
                        origRemoveItem(key);
                        if (key === 'token') {
                            try {
                                window.webkit.messageHandlers.iosNative.postMessage({ type: 'logout' });
                            } catch(e) {}
                        }
                    };
                } catch(e) {}

                // Fallback: retry every 3s for 30s in case token arrives late
                var attempts = 0;
                var checkInterval = setInterval(function() {
                    attempts++;
                    var t = localStorage.getItem('token');
                    if (t) {
                        sendTokenToNative(t);
                        clearInterval(checkInterval);
                    } else if (attempts >= 10) {
                        clearInterval(checkInterval);
                    }
                }, 3000);
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)

        // Store reference for deep link navigation + start foreground observer
        context.coordinator.webView = webView
        context.coordinator.startForegroundObserver()

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if loadError == false && isLoading == true && webView.url == nil {
            webView.load(URLRequest(url: url))
        }

        // Handle deep link from push notification tap
        if let deepLink = pushManager.pendingDeepLink {
            pushManager.pendingDeepLink = nil
            let escapedLink = deepLink
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = """
            (function() {
                // Refresh data on current page
                window.dispatchEvent(new CustomEvent('app-resumed', { detail: { timestamp: Date.now(), fromNotification: true } }));
                // Parse URL — handle both full URLs and relative paths
                var raw = '\(escapedLink)';
                var path;
                try {
                    var u = new URL(raw, window.location.origin);
                    path = u.pathname + u.search;
                } catch(e) {
                    path = raw;
                }
                // Routes are /crm, /tasks, /messages — navigate with timestamp to force refresh
                var sep = path.includes('?') ? '&' : '?';
                window.location.href = path + sep + '_t=' + Date.now();
            })();
            """

            // If page hasn't loaded yet (cold start), defer until didFinish
            if context.coordinator.hasFinishedInitialLoad {
                webView.evaluateJavaScript(js, completionHandler: nil)
            } else {
                print("[Push] Page not loaded yet, deferring deep link")
                context.coordinator.pendingDeepLinkJS = js
            }
        }
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebView
        weak var webView: WKWebView?
        var hasFinishedInitialLoad = false
        private var didOpenExternalAuth = false
        var pendingDeepLinkJS: String?

        init(_ parent: WebView) {
            self.parent = parent
        }

        /// Start observing foreground events (called after webView is assigned)
        func startForegroundObserver() {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(appWillEnterForeground),
                name: UIApplication.willEnterForegroundNotification,
                object: nil
            )
        }

        @objc private func appWillEnterForeground() {
            // If we opened Safari for OAuth, reload WebView when user returns
            if didOpenExternalAuth {
                didOpenExternalAuth = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.webView?.reload()
                }
            }
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        // Handle messages from JavaScript (auth token + file downloads + external URLs)
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            if message.name == "fileDownload" {
                handleFileDownload(message)
                return
            }

            // Open external URL in Safari (used by billing page)
            if message.name == "openExternal",
               let urlString = message.body as? String,
               let url = URL(string: urlString) {
                print("[WebView] Opening external URL: \(urlString.prefix(60))")
                UIApplication.shared.open(url)
                return
            }

            guard message.name == "iosNative",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            if type == "authToken", let token = body["token"] as? String {
                print("[Push] Got auth token from WebView: \(token.prefix(20))...")
                parent.pushManager.authToken = token
                // Save to Keychain for persistent login + Face ID
                KeychainHelper.saveToken(token)
                // Registration is triggered automatically via authToken didSet
            }

            if type == "logout" {
                print("[Auth] User logged out, clearing Keychain")
                KeychainHelper.deleteToken()
                parent.pushManager.authToken = nil
            }
        }

        private func handleFileDownload(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let base64Data = body["data"] as? String,
                  let fileName = body["fileName"] as? String,
                  let data = Data(base64Encoded: base64Data) else {
                print("[FileDownload] Invalid message data")
                return
            }

            // mimetype available as body["mimetype"] if needed

            DispatchQueue.main.async {
                let tempDir = FileManager.default.temporaryDirectory
                let fileURL = tempDir.appendingPathComponent(fileName)

                do {
                    try data.write(to: fileURL)
                    guard let viewController = self.webView?.window?.rootViewController else { return }

                    let activityVC = UIActivityViewController(
                        activityItems: [fileURL],
                        applicationActivities: nil
                    )

                    // iPad requires popover presentation
                    if let popover = activityVC.popoverPresentationController {
                        popover.sourceView = viewController.view
                        popover.sourceRect = CGRect(x: viewController.view.bounds.midX, y: viewController.view.bounds.midY, width: 0, height: 0)
                        popover.permittedArrowDirections = []
                    }

                    viewController.present(activityVC, animated: true)
                } catch {
                    print("[FileDownload] Failed to write temp file: \(error)")
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Inject actual safe area inset values from native
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                if let window = webView.window {
                    let top = window.safeAreaInsets.top
                    let bottom = window.safeAreaInsets.bottom
                    let js = """
                    document.documentElement.style.setProperty('--safe-area-top', '\(Int(top))px');
                    document.documentElement.style.setProperty('--safe-area-bottom', '\(Int(bottom))px');
                    var s = document.getElementById('ios-safe-area-style');
                    if (!s) { s = document.createElement('style'); s.id = 'ios-safe-area-style'; document.head.appendChild(s); }
                    s.textContent = '.crm-header { padding-top: \(Int(top) + 16)px !important; }';
                    """
                    webView.evaluateJavaScript(js, completionHandler: nil)
                }
            }

            if !hasFinishedInitialLoad {
                hasFinishedInitialLoad = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.parent.isLoading = false
                }

                // Execute deferred deep link from cold start notification tap
                if let deepLinkJS = pendingDeepLinkJS {
                    pendingDeepLinkJS = nil
                    print("[Push] Executing deferred deep link after page load")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        webView.evaluateJavaScript(deepLinkJS, completionHandler: nil)
                    }
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if !hasFinishedInitialLoad {
                parent.loadError = true
                parent.isLoading = false
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if !hasFinishedInitialLoad {
                parent.loadError = true
                parent.isLoading = false
            }
        }

        // Handle JavaScript alert()
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let viewController = webView.window?.rootViewController else {
                completionHandler()
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            viewController.present(alert, animated: true)
        }

        // Handle JavaScript confirm()
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let viewController = webView.window?.rootViewController else {
                completionHandler(false)
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Zrušiť", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            viewController.present(alert, animated: true)
        }

        // Handle target="_blank" links and window.open()
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                let host = url.host ?? ""
                // Open external URLs (Stripe, etc.) in Safari
                let isExternal = host.contains("stripe.com") ||
                                 (!host.isEmpty && !host.contains("prplcrm.eu") && !host.contains("localhost"))
                if isExternal {
                    UIApplication.shared.open(url)
                    return nil
                }
            }
            // Internal target="_blank" — load in same WebView
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }

        // Handle navigation: block landing page, open external links in Safari
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // Block blob: URL navigation (file downloads are handled via JS bridge)
            if url.scheme == "blob" {
                decisionHandler(.cancel)
                return
            }

            let host = url.host ?? ""
            let isInternal = host.isEmpty || host.contains("prplcrm.eu") || host.contains("localhost")

            // Google blocks OAuth in WKWebView — must open in Safari
            let isGoogleAuth = host.contains("accounts.google.com") || host.contains("accounts.youtube.com")
            if isGoogleAuth {
                didOpenExternalAuth = true
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            // Stripe checkout/portal — open in Safari
            if host.contains("stripe.com") {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            if isInternal {
                // Block landing page — redirect to /app
                let path = url.path
                if path == "/" || path.isEmpty {
                    let appURL = URL(string: "https://prplcrm.eu/app")!
                    webView.load(URLRequest(url: appURL))
                    decisionHandler(.cancel)
                    return
                }
                // Block /privacy and other marketing pages in the app
                if path == "/privacy" {
                    UIApplication.shared.open(url)
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.allow)
            } else if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}
