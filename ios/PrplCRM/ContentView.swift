import SwiftUI
import WebKit
import LocalAuthentication
import Security

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
                    onAuthenticate: { authenticate() },
                    onPasscode: { authenticateWithPasscode() }
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

        // Use .deviceOwnerAuthentication which tries Face ID / Touch ID first
        // and automatically falls back to device passcode if biometrics fail.
        // Unlike .deviceOwnerAuthenticationWithBiometrics, this gives the user
        // the system "Enter Passcode" option after Face ID fails.
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Overenie identity pre prístup do Prpl CRM"
            ) { success, authError in
                DispatchQueue.main.async {
                    if success {
                        isLocked = false
                    } else {
                        biometricFailed = true
                    }
                }
            }
        } else {
            // No authentication method available (no passcode set on device)
            // Allow access since the device itself has no lock
            isLocked = false
        }
    }

    /// Skip Face ID and show device passcode input directly.
    /// Uses SecAccessControl with .devicePasscode flag which bypasses
    /// biometry and shows only the passcode entry screen.
    private func authenticateWithPasscode() {
        biometricFailed = false

        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .devicePasscode,
            nil
        ) else {
            authenticate()
            return
        }

        let context = LAContext()
        context.evaluateAccessControl(
            accessControl,
            operation: .useItem,
            localizedReason: "Zadajte kód pre prístup do Prpl CRM"
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

struct LockScreenView: View {
    var biometricFailed: Bool
    var onAuthenticate: () -> Void
    var onPasscode: () -> Void

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

                    // Retry with Face ID / Touch ID + passcode fallback
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

                    // Direct passcode entry option
                    Button(action: onPasscode) {
                        HStack(spacing: 8) {
                            Image(systemName: "rectangle.and.pencil.and.ellipsis")
                                .font(.title3)
                            Text("Zadať kód")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                        .background(.white.opacity(0.2))
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
        // Disable iOS edge-swipe back gesture: on iOS the CSS pins body to
        // `position: fixed` and scroll happens inside `.crm-main`. When the
        // user started a vertical scroll with their finger near the left edge
        // of the screen, WKWebView mis-interpreted it as a back-swipe and
        // navigated the WebView history back to /app (the dashboard) — the
        // "scroll-down jumps to dashboard" bug. The app has its own BottomNav
        // for navigation, so the native back gesture is unnecessary.
        webView.allowsBackForwardNavigationGestures = false
        // Disable outer scrollView bouncing. Scroll happens inside the inner
        // `.crm-main` container on iOS; letting the outer WKWebView bounce on
        // top of that caused scroll-position desync and visual jumps.
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 99/255, green: 102/255, blue: 241/255, alpha: 1)

        // Set mobile user agent
        webView.customUserAgent = "PrplCRM-iOS/1.0 " + (webView.value(forKey: "userAgent") as? String ?? "")

        // Restore token from Keychain BEFORE page JS runs — ONLY if localStorage is
        // empty. WKUserScript source is baked in at WebView-init time and runs on
        // every page load (including window.location.href navigations). If we
        // unconditionally overwrote localStorage here, a stale baked-in token (e.g.
        // from before JWT_SECRET rotation, or from a Keychain that still holds the
        // old value due to a race between axios's 401-interceptor logout and the
        // async bridge "logout" message) would re-infect localStorage on every
        // workspace switch — causing the user to get 401'd → kicked to /login on
        // every reload, even after a fresh login. The `if (!localStorage.getItem)`
        // guard preserves any fresh token already in localStorage from the current
        // session.
        if let savedToken = KeychainHelper.getToken() {
            let escapedToken = savedToken.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let restoreScript = WKUserScript(
                source: "if (!localStorage.getItem('token')) { localStorage.setItem('token', '\(escapedToken)'); }",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            config.userContentController.addUserScript(restoreScript)
            debugLog("[Keychain] Injecting saved token into WebView localStorage (only if empty)")
        }

        // Inject CSS safe area variables + auth token bridge
        let script = WKUserScript(
            source: """
            document.documentElement.style.setProperty('--sat', 'env(safe-area-inset-top)');
            document.documentElement.style.setProperty('--sab', 'env(safe-area-inset-bottom)');
            document.documentElement.style.setProperty('--sal', 'env(safe-area-inset-left)');
            document.documentElement.style.setProperty('--sar', 'env(safe-area-inset-right)');
            document.body.classList.add('ios-app');

            // Phase 4 native OAuth support flag — FE OAuthButtons-y kontrolujú
            // window.__nativeOAuthSupported aby sa rozhodli medzi web flow
            // (window.location.assign + Safari redirect) a native bridge
            // (postMessage startGoogleSignIn / startAppleSignIn). Bez tohto
            // flag-u by stará iOS appka (pred Phase 4 rebuild-om) ignorovala
            // postMessage a tlačítko by zostalo v "Načítavam..." stave.
            window.__nativeOAuthSupported = true;

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

        // If a push notification arrived before the app launched, load the
        // deep link URL directly instead of the default /app. Avoids race
        // where /app finishes loading first and the deep link never applies.
        var initialURL = url
        if let deepLink = pushManager.pendingDeepLink, let u = buildDeepLinkURL(deepLink) {
            debugLog("[Push] makeUIView: cold-start deep link = \(u.absoluteString)")
            initialURL = u
            // Clear now so updateUIView doesn't try to reload it again
            let pm = pushManager
            DispatchQueue.main.async { pm.pendingDeepLink = nil }
        }
        webView.load(URLRequest(url: initialURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if loadError == false && isLoading == true && webView.url == nil {
            webView.load(URLRequest(url: url))
        }

        // Handle deep link from push notification tap.
        // This is the ONLY place that processes pendingDeepLink.
        // The body closure no longer touches it — that was the root cause
        // of the bug: body consumed pendingDeepLink (set it to nil) but
        // updateUIView never used the resulting URL, so deep links were lost.
        guard let deepLink = pushManager.pendingDeepLink else { return }

        debugLog("[Push] updateUIView: deepLink = \(deepLink), pageLoaded = \(context.coordinator.hasFinishedInitialLoad)")

        // Clear pendingDeepLink asynchronously to avoid "mutating state
        // during view update" warnings from SwiftUI
        let pm = pushManager
        DispatchQueue.main.async {
            pm.pendingDeepLink = nil
        }

        // Always use direct webView.load for deep links — reliable across
        // cold-start AND hot-start. Previously hot-start relied on JS injection
        // + custom event dispatch, which silently failed when:
        //   (a) SwiftUI skipped updateUIView due to class-reference equality,
        //   (b) the React `iosDeepLink` listener hadn't attached yet,
        //   (c) the app had been memory-killed and JS context reset.
        // A full page load costs ~300ms of cache-warm render but is 100%
        // deterministic. React (App.jsx) reads ws= + highlight params on mount
        // and routes the user correctly.
        if let deepLinkUrl = buildDeepLinkURL(deepLink) {
            debugLog("[Push] Loading deep link URL directly = \(deepLinkUrl.absoluteString) (pageLoaded=\(context.coordinator.hasFinishedInitialLoad))")
            // Oznámime foreground handleru: tento cyklus sme obslúžili deep linkom,
            // reload treba preskočiť, inak by zahodil práve navigovanú URL.
            context.coordinator.didHandleDeepLinkThisCycle = true
            webView.load(URLRequest(url: deepLinkUrl))
        }
    }

    /// Build a loadable URL from either a path ("/tasks?x=1") or a full URL
    /// ("https://prplcrm.eu/tasks?x=1"). Universal Links arrive as full URLs
    /// via SwiftUI .onOpenURL / .onContinueUserActivity; push notifications
    /// traditionally arrive as bare paths. Both flow through pendingDeepLink,
    /// so this normalises them in one place. Always appends a timestamp to
    /// bypass any stale cache from a prior visit to the same path.
    private func buildDeepLinkURL(_ raw: String) -> URL? {
        let base = "https://prplcrm.eu"
        let isFullUrl = raw.hasPrefix("http://") || raw.hasPrefix("https://")
        let urlString: String
        if isFullUrl {
            urlString = raw
        } else {
            let path = raw.hasPrefix("/") ? raw : "/\(raw)"
            urlString = base + path
        }
        let sep = urlString.contains("?") ? "&" : "?"
        let ts = Int(Date().timeIntervalSince1970 * 1000)
        return URL(string: "\(urlString)\(sep)_t=\(ts)")
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebView
        weak var webView: WKWebView?
        var hasFinishedInitialLoad = false
        private var didOpenExternalAuth = false
        // Nastavuje sa keď updateUIView stihne obslúžiť pendingDeepLink v tomto
        // foreground cykle — napr. Universal Link z OAuth redirectu. appWillEnter-
        // Foreground potom vynechá fallback `webView.reload()`, ktorý predtým
        // clobberol deep-link navigáciu a hodil užívateľa späť na /app dashboard.
        fileprivate var didHandleDeepLinkThisCycle = false
        var pendingDeepLinkJS: String?
        // Track last successfully loaded URL so we can restore it if the
        // WebContent process terminates (iOS jetsam kills it under memory
        // pressure — common when scrolling long lists). Without this the
        // view would reload to the initial /app URL, which is exactly the
        // "scroll jumps to dashboard" bug the user reported.
        var lastURL: URL?

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
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(appDidReceiveMemoryWarning),
                name: UIApplication.didReceiveMemoryWarningNotification,
                object: nil
            )
            // Direct deep-link receiver — bypasses SwiftUI @Published/updateUIView.
            // AppDelegate posts this whenever a notification tap arrives
            // (cold-start via launchOptions, hot-start via didReceive).
            // Going through SwiftUI's observation chain turned out to be
            // unreliable on hot-start: the user would see the app foreground
            // with the SAME page they left, as if webView.load() never ran.
            // This observer gives us a deterministic path: NSNotification →
            // Coordinator → webView.load().
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleDeepLinkReceived(_:)),
                name: Notification.Name("PrplCRMDeepLinkReceived"),
                object: nil
            )
        }

        @objc private func handleDeepLinkReceived(_ notification: Notification) {
            guard let urlString = notification.userInfo?["url"] as? String,
                  let webView = webView else {
                debugLog("[Push] Coordinator.handleDeepLinkReceived: no URL or no webView")
                return
            }
            // Universal Links prichádzajú ako plné URL ("https://..."). Push deep
            // linky historicky ako bare path ("/tasks?..."). Normalizujeme oboje
            // do plnej URL, inak by buildDeepLinkURL-like logika zlyhala na prefix.
            let isFullUrl = urlString.hasPrefix("http://") || urlString.hasPrefix("https://")
            let base = "https://prplcrm.eu"
            let normalized: String
            if isFullUrl {
                normalized = urlString
            } else {
                let link = urlString.hasPrefix("/") ? urlString : "/\(urlString)"
                normalized = base + link
            }
            let sep = normalized.contains("?") ? "&" : "?"
            let ts = Int(Date().timeIntervalSince1970 * 1000)
            let fullUrl = "\(normalized)\(sep)_t=\(ts)"
            guard let url = URL(string: fullUrl) else { return }
            debugLog("[Push] Coordinator: loading deep link via NotificationCenter bypass = \(fullUrl)")
            // KRITICKÉ: nastaviť flag SYNCHRÓNNE pred akýmkoľvek async dispatch,
            // aby príslušný appWillEnterForeground (ktorý môže fire-nuť tesne
            // pred týmto observer-om) videl, že už sme handle-li deep link a
            // skipol by inak destructive reload na pôvodnú URL.
            didHandleDeepLinkThisCycle = true
            DispatchQueue.main.async {
                webView.load(URLRequest(url: url))
            }
        }

        @objc private func appDidReceiveMemoryWarning() {
            debugLog("[WebView] ⚠ Memory warning received — at URL \(lastURL?.absoluteString ?? "nil")")
        }

        @objc private func appWillEnterForeground() {
            // Po návrate zo Safari (napr. OAuth flow) bol fallback reload WebView,
            // aby sa stránka dozvedela aktuálny stav integrácie. S Universal Links
            // ale deep link (prplcrm.eu/tasks?google_tasks=connected) sám navigačne
            // pristane na správnej URL a React ju obslúži. Reload v tom prípade
            // clobberol deep-link navigáciu: Tasks sa nakrátko zobrazil a appka
            // padla späť na /app dashboard, lebo reload prebehol na pôvodnej URL.
            //
            // Preto reload spúšťame iba ak tento foreground cyklus NEBUDE obsluhovať
            // deep link. Po 0.5s skontrolujeme, či medzičasom updateUIView nastavil
            // didHandleDeepLinkThisCycle; ak áno, preskočíme. Ak nie, bežne reloadneme.
            guard didOpenExternalAuth else { return }
            didOpenExternalAuth = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self else { return }
                if self.didHandleDeepLinkThisCycle {
                    debugLog("[Foreground] Skipping reload — deep link already handled this cycle")
                    self.didHandleDeepLinkThisCycle = false
                    return
                }
                debugLog("[Foreground] No deep link this cycle, reloading WebView (OAuth-return fallback)")
                self.webView?.reload()
            }
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        // Handle messages from JavaScript (auth token + file downloads + external URLs)
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            // Hostname guard (defence-in-depth):
            // WKScriptMessage bridge môže byť potenciálne volaný z ľubovoľnej stránky
            // ktorá beží v tomto WKWebView. `decidePolicyFor` a `createWebViewWith`
            // blokujú navigáciu na cudzie domény, ale ak by sa cudzia stránka predsa
            // dostala do hlavného frame (XSS na prplcrm.eu, otvorený iframe, race
            // condition), mohla by zavolať `iosNative.postMessage({type:'authToken',
            // token:'fake'})` a otráviť nám Keychain. Odmietneme všetky správy ktoré
            // nevznikli na našej doméne.
            let senderHost = message.frameInfo.request.url?.host
            let isOurDomain = senderHost == "prplcrm.eu"
            if !isOurDomain {
                debugLog("[WebView] DROP message from untrusted origin: \(senderHost ?? "nil") name=\(message.name)")
                return
            }

            if message.name == "fileDownload" {
                handleFileDownload(message)
                return
            }

            // Open external URL in Safari (used by billing page)
            if message.name == "openExternal",
               let urlString = message.body as? String,
               let url = URL(string: urlString) {
                debugLog("[WebView] Opening external URL: \(urlString.prefix(60))")
                UIApplication.shared.open(url)
                return
            }

            guard message.name == "iosNative",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            if type == "authToken", let token = body["token"] as? String {
                debugLog("[Push] Got auth token from WebView: \(token.prefix(20))...")
                parent.pushManager.authToken = token
                // Save to Keychain for persistent login + Face ID
                KeychainHelper.saveToken(token)
                // Registration is triggered automatically via authToken didSet
            }

            if type == "logout" {
                debugLog("[Auth] User logged out, clearing Keychain")
                KeychainHelper.deleteToken()
                parent.pushManager.authToken = nil
            }

            // ── Native OAuth bridge (Phase 4) ──────────────────────────
            // Web OAuth flow nefunguje v WKWebView (Google blokuje, Apple
            // má obmedzenia). Tieto handlery spustia native auth flow,
            // ktorý cez OAuthController POSTne id_token na backend
            // /api/auth/{provider}/native, dostane Prpl CRM JWT a injectne
            // ho do WebView cez window.__nativeAuthLogin.
            if type == "startGoogleSignIn" {
                debugLog("[OAuth] Starting native Google Sign In")
                if let webView = self.webView {
                    OAuthController.startGoogleSignIn(from: webView)
                }
            }

            if type == "startAppleSignIn" {
                debugLog("[OAuth] Starting native Sign in with Apple")
                if let webView = self.webView {
                    OAuthController.startAppleSignIn(from: webView)
                }
            }
        }

        private func handleFileDownload(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let base64Data = body["data"] as? String,
                  let fileName = body["fileName"] as? String,
                  let data = Data(base64Encoded: base64Data) else {
                debugLog("[FileDownload] Invalid message data")
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
                    debugLog("[FileDownload] Failed to write temp file: \(error)")
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

                // Safety net: if a deep link was deferred (edge case where
                // updateUIView fires before didFinish), execute it now.
                // Normally cold-start deep links are handled by loading the
                // deep link URL directly in ContentView.
                if let deepLinkJS = pendingDeepLinkJS {
                    pendingDeepLinkJS = nil
                    debugLog("[Push] Executing deferred deep link after page load")
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

        // Track every committed navigation so we know where the user really is.
        // When WebContent process dies, we restore THIS URL, not the hardcoded
        // initial /app URL.
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            if let url = webView.url {
                lastURL = url
                debugLog("[WebView] didCommit \(url.absoluteString)")
            }
        }

        // Fires when iOS kills the WebContent process (memory pressure, etc.)
        // Without this handler, WKWebView stays blank or gets reloaded from
        // initial URL by our updateUIView fallback — either way the user
        // loses their current location. We reload the last known URL.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            let restoreURL = lastURL ?? parent.url
            debugLog("[WebView] ⚠ WebContent process terminated — reloading \(restoreURL.absoluteString)")
            reportNativeError(
                name: "iOSWebContentProcessTerminated",
                message: "WKWebView WebContent process terminated (memory jetsam). URL: \(restoreURL.absoluteString)"
            )
            webView.load(URLRequest(url: restoreURL))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if !hasFinishedInitialLoad {
                parent.loadError = true
                parent.isLoading = false
            }
            let nsErr = error as NSError
            // -999 = NSURLErrorCancelled (user zrušil — neignoruj ak to je legitímny abort)
            if nsErr.code != NSURLErrorCancelled {
                reportNativeError(
                    name: "iOSProvisionalNavigationFailed",
                    message: "\(nsErr.domain) code=\(nsErr.code): \(nsErr.localizedDescription)"
                )
            }
        }

        // Pošle native iOS chybu na in-house tracking (nahradí Sentry).
        // Volá sa pri WebContent jetsam + failed navigation. Best-effort,
        // fire-and-forget. Endpoint je rovnaký ako pre web errory, iba
        // s platform='ios' markerom v userAgent a v kontexte.
        private func reportNativeError(name: String, message: String) {
            let body: [String: Any] = [
                "name": name,
                "message": message,
                "url": (lastURL ?? parent.url).absoluteString,
                "userAgent": "PrplCRM-iOS/native",
                "release": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
            ]
            guard let json = try? JSONSerialization.data(withJSONObject: body),
                  let endpoint = URL(string: "https://prplcrm.eu/api/errors/client") else { return }
            var req = URLRequest(url: endpoint)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = json
            req.timeoutInterval = 5
            URLSession.shared.dataTask(with: req).resume()
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
                // Block /ochrana-udajov and other marketing pages in the app
                if path == "/ochrana-udajov" {
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
