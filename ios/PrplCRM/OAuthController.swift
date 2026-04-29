//
//  OAuthController.swift
//  PrplCRM
//
//  Native Sign in with Apple + Google Sign In bridge pre WKWebView.
//
//  Tok dát:
//   1. JS v WebView klikne na "Pokračovať s Google/Apple" → OAuthButtons.jsx
//      detekuje iOS native (window.webkit.messageHandlers.iosNative) a pošle
//      cez bridge { type: "startGoogleSignIn" } / { type: "startAppleSignIn" }.
//   2. WKWebView Coordinator (ContentView.swift) zachytí message a zavolá
//      OAuthController.startGoogleSignIn(...) alebo .startAppleSignIn(...).
//   3. Tu beží native flow:
//        - Google: GIDSignIn.sharedInstance.signIn → idToken
//        - Apple:  ASAuthorizationAppleIDProvider → identityToken
//   4. Po úspechu POST na backend /api/auth/google/native alebo /apple/native
//      s `idToken` (alebo `identityToken`).
//   5. Backend overí JWT (cez Google library / Apple JWKS), nájde alebo vytvorí
//      user-a, vystaví Prpl CRM JWT a vráti ho.
//   6. iOS injekt cez evaluateJavaScript("window.__nativeAuthLogin('JWT')")
//      → AuthContext.loginWithToken → user je v CRM.
//
//  Apple Sign In je v iOS SDK od iOS 13 (AuthenticationServices framework).
//  Google Sign In vyžaduje SPM dependency `GoogleSignIn-iOS`. Aby sa appka
//  mohla buildit aj bez SPM (napr. pre dev preview), používame
//  #if canImport(GoogleSignIn) — keď SPM nie je zahrnuté, Google flow ticho
//  failuje s alertom.
//

import UIKit
import WebKit
import AuthenticationServices

#if canImport(GoogleSignIn)
import GoogleSignIn
#endif

// MARK: - Konfigurácia

enum OAuthConfig {
    /// Backend URL — match s `API_BASE_URL` v JS. Render web service.
    static let backendBaseURL = "https://perun-crm-api.onrender.com"

    /// Google iOS OAuth Client ID. Hodnotu vlož do GoogleService-Info.plist
    /// alebo do Info.plist pod kľúčom "GIDClientID". OAuthController ho
    /// načíta z bundle automaticky.
    /// Backend používa GOOGLE_IOS_CLIENT_ID env var pre audience verifikáciu.
}

// MARK: - Backend client

/// Posiela id_token na backend a vracia Prpl CRM JWT.
struct OAuthBackendClient {
    static func exchangeIdToken(provider: String, idToken: String,
                                fullName: String? = nil,
                                email: String? = nil,
                                completion: @escaping (Result<String, Error>) -> Void) {
        guard let url = URL(string: "\(OAuthConfig.backendBaseURL)/api/auth/\(provider)/native") else {
            completion(.failure(NSError(domain: "OAuth", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid backend URL"])))
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30

        // Pre Google používa "idToken" (Google SDK token).
        // Pre Apple používa "identityToken" (z AppleIDCredential).
        // Backend (auth-google.js / auth-apple.js) toto rešpektuje.
        var body: [String: Any] = [:]
        if provider == "google" {
            body["idToken"] = idToken
        } else if provider == "apple" {
            body["identityToken"] = idToken
            if let fullName = fullName, !fullName.isEmpty {
                body["fullName"] = fullName
            }
            if let email = email, !email.isEmpty {
                body["email"] = email
            }
        }

        do {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            completion(.failure(error))
            return
        }

        URLSession.shared.dataTask(with: req) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            guard let data = data else {
                completion(.failure(NSError(domain: "OAuth", code: -2, userInfo: [NSLocalizedDescriptionKey: "Empty response"])))
                return
            }
            do {
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(.failure(NSError(domain: "OAuth", code: -3, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON"])))
                    return
                }
                if let token = json["token"] as? String {
                    completion(.success(token))
                    return
                }
                let message = (json["message"] as? String) ?? "Unknown OAuth backend error"
                completion(.failure(NSError(domain: "OAuth", code: -4, userInfo: [NSLocalizedDescriptionKey: message])))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }
}

// MARK: - JWT injekcia do WebView

extension WKWebView {
    /// Inject Prpl CRM JWT into WebView via global handler nainštalovaný v AuthContext.
    /// AuthContext zachytí token, persistne ho do localStorage + Keychain
    /// (cez existing iosNative bridge), a redirectne na /app.
    ///
    /// SECURITY: používa `callAsyncJavaScript(arguments:)` ktoré JSON-enkoduje
    /// parametre na úrovni WebKit-u. Predošlá verzia robila string-concat injection
    /// s manuálnym escape (iba `\\` a `'`) — útočník s kompromitovaným backendom
    /// alebo MITM mohol vrátiť token obsahujúci backtick, `</script>`, unicode
    /// escape sekvencie atď. a injektnúť ľubovoľný JS. `callAsyncJavaScript` cez
    /// `arguments` parameter je proti tomu odolné — token sa do JS prostredia
    /// dostane ako bezpečná premenná.
    func injectPrplCrmAuthToken(_ token: String) {
        let js = """
        if (typeof window.__nativeAuthLogin === 'function') {
            window.__nativeAuthLogin(token);
        } else {
            try { localStorage.setItem('token', token); } catch (e) {}
            window.location.assign('/app');
        }
        """
        DispatchQueue.main.async {
            // arguments dictionary sa JSON-enkoduje WebKit-om do JS premenných
            // s daným názvom — rovnaké ako definovať `let token = "..."` na začiatku
            // skriptu, ale bez možnosti string injection.
            self.callAsyncJavaScript(
                js,
                arguments: ["token": token],
                in: nil,
                in: .page,
                completionHandler: nil
            )
        }
    }
}

// MARK: - Apple Sign In

class AppleSignInController: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// Strong reference (predtým weak) — Apple Sign In sheet na iPade s iPadOS 26+
    /// vyžaduje stabilnú window referenciu počas celého flow-u (~5–30 s vrátane
    /// network call na Render backend ktorý môže mať cold-start). Pri weak referencii
    /// SwiftUI rerender vie WKWebView dealokovať a window referenciu zhodiť na nil
    /// → ASAuthorizationController nemá kde zobraziť sheet → "error message" čo
    /// vidi reviewer (Apple rejection 2.1(a) na iPad Air 11" iPadOS 26.4.1).
    var presentingWindow: UIWindow?
    weak var webView: WKWebView?
    /// Retencia delegáta — ASAuthorizationController nedrží silnú referenciu, takže
    /// bez tohto by self bolo dealokované hneď po začatí flow-u.
    private static var activeControllers: [AppleSignInController] = []

    func startSignIn(presentingWindow: UIWindow?, webView: WKWebView?) {
        // Resolve window so ASAuthorizationController má kam zobraziť sheet aj na
        // iPade s multi-scene / multi-window. Priorita:
        //   1. Window prešla z webView.window (normálna cesta)
        //   2. KeyWindow z foreground-active UIWindowScene (iPad multi-scene safe)
        //   3. Akákoľvek window z prvej foreground scene
        // Bez tohto fallbacku padalo na iPade kde webView.window bolo nil v momente
        // tap-u (SwiftUI rerender po Render backend wakeup).
        self.presentingWindow = presentingWindow ?? AppleSignInController.resolveActiveWindow()
        self.webView = webView

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self

        AppleSignInController.activeControllers.append(self)
        controller.performRequests()
    }

    /// Scene-aware window lookup. iPad podporuje multi-window (Slide Over, Split View),
    /// takže `UIApplication.shared.windows` je deprecated od iOS 15+. Treba prejsť cez
    /// `connectedScenes` a vybrať aktívnu foreground scene.
    static func resolveActiveWindow() -> UIWindow? {
        let activeScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })

        if let scene = activeScene {
            return scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
        }

        // Posledný fallback: akákoľvek scene (nie nutne foreground-active)
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow })
    }

    private func cleanup() {
        AppleSignInController.activeControllers.removeAll { $0 === self }
    }

    // MARK: ASAuthorizationControllerDelegate

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { cleanup() }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = credential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            print("[AppleSignIn] Missing identity token in credential")
            return
        }

        // fullName a email Apple pošle LEN PRI PRVOM sign-in s touto appkou.
        // Posunieme ich do backend native endpointu — backend ich použije pri
        // prvom create-new-user. Pri ďalších sign-in-och budú nil — backend
        // nájde user-a cez appleId match.
        var fullName: String? = nil
        if let nameComp = credential.fullName {
            let parts = [nameComp.givenName, nameComp.familyName].compactMap { $0 }.joined(separator: " ")
            if !parts.isEmpty { fullName = parts }
        }

        let webViewRef = self.webView
        OAuthBackendClient.exchangeIdToken(
            provider: "apple",
            idToken: identityToken,
            fullName: fullName,
            email: credential.email
        ) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let jwt):
                    webViewRef?.injectPrplCrmAuthToken(jwt)
                case .failure(let error):
                    print("[AppleSignIn] Backend exchange failed: \(error.localizedDescription)")
                    OAuthController.showAlert(in: self.presentingWindow,
                        title: "Apple prihlásenie",
                        message: error.localizedDescription)
                }
            }
        }
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        defer { cleanup() }
        // User cancel je ASAuthorizationError.canceled — ticho ignorujeme.
        if (error as NSError).code == ASAuthorizationError.canceled.rawValue {
            return
        }
        print("[AppleSignIn] Authorization error: \(error.localizedDescription)")
        OAuthController.showAlert(in: presentingWindow,
            title: "Apple prihlásenie",
            message: "Prihlásenie sa nepodarilo. Skús to znova.")
    }

    // MARK: ASAuthorizationControllerPresentationContextProviding

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Priorita 1: window prešla do startSignIn (zachytená pri zahájení flow-u).
        if let window = presentingWindow {
            return window
        }
        // Priorita 2: scene-aware lookup pre iPad multi-scene podporu. iPad Air 11"
        // s iPadOS 26+ vyžaduje window viazanú na konkrétny UIWindowScene, inak
        // ASAuthorizationController nevie kam zobraziť sheet a flow zlyháva
        // s "error message" (Apple rejection 2.1(a)).
        if let window = AppleSignInController.resolveActiveWindow() {
            return window
        }
        // Posledná záchrana — UIWindow() bez scene. Na iPhone funguje, na iPade
        // s multi-scene nie. Aspoň sa vyhneme crash-u — ASAuthorizationController
        // vráti error namiesto pádu.
        return UIWindow()
    }
}

// MARK: - Google Sign In

#if canImport(GoogleSignIn)
class GoogleSignInController {
    static func startSignIn(presentingViewController: UIViewController, webView: WKWebView?) {
        // GIDSignIn config sa nastaví automaticky z GoogleService-Info.plist
        // (alebo Info.plist GIDClientID). Ak nie je nastavený, fail-uje s message.
        if GIDSignIn.sharedInstance.configuration == nil {
            // Try to load from Info.plist
            if let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String, !clientID.isEmpty {
                GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            } else {
                OAuthController.showAlert(in: presentingViewController.view.window,
                    title: "Google Sign In",
                    message: "Chýba GIDClientID v Info.plist alebo GoogleService-Info.plist.")
                return
            }
        }

        GIDSignIn.sharedInstance.signIn(withPresenting: presentingViewController) { result, error in
            if let error = error {
                let nsErr = error as NSError
                // User cancel — ticho.
                if nsErr.code == GIDSignInError.canceled.rawValue { return }
                print("[GoogleSignIn] Error: \(error.localizedDescription)")
                OAuthController.showAlert(in: presentingViewController.view.window,
                    title: "Google prihlásenie",
                    message: error.localizedDescription)
                return
            }
            guard let result = result,
                  let idToken = result.user.idToken?.tokenString else {
                OAuthController.showAlert(in: presentingViewController.view.window,
                    title: "Google prihlásenie",
                    message: "Chýbajúci ID token od Google.")
                return
            }
            OAuthBackendClient.exchangeIdToken(provider: "google", idToken: idToken) { backendResult in
                DispatchQueue.main.async {
                    switch backendResult {
                    case .success(let jwt):
                        webView?.injectPrplCrmAuthToken(jwt)
                    case .failure(let err):
                        print("[GoogleSignIn] Backend exchange failed: \(err.localizedDescription)")
                        OAuthController.showAlert(in: presentingViewController.view.window,
                            title: "Google prihlásenie",
                            message: err.localizedDescription)
                    }
                }
            }
        }
    }

    static func handleOpenURL(_ url: URL) -> Bool {
        return GIDSignIn.sharedInstance.handle(url)
    }
}
#endif

// MARK: - Verejný entry point

enum OAuthController {
    static func startGoogleSignIn(from webView: WKWebView) {
        guard let viewController = topPresentedViewController(from: webView) else {
            print("[OAuth] No view controller available")
            return
        }
        #if canImport(GoogleSignIn)
        GoogleSignInController.startSignIn(presentingViewController: viewController, webView: webView)
        #else
        showAlert(in: webView.window,
            title: "Google Sign In",
            message: "GoogleSignIn-iOS SPM package nie je zahrnuté v build-e. Postupuj podľa README.")
        #endif
    }

    static func startAppleSignIn(from webView: WKWebView) {
        // webView.window môže byť nil na iPade keď SwiftUI WKWebView ešte nedokončil
        // layout cyklus. AppleSignInController.startSignIn má vlastný fallback cez
        // scene resolution — posielame mu webView.window ako primárne, on si nájde
        // window-cez-scene ako záchranu.
        let controller = AppleSignInController()
        controller.startSignIn(presentingWindow: webView.window, webView: webView)
    }

    /// Univerzálny error alert helper.
    /// iPad-safe: ak `window` je nil, fallback na scene resolution (podobne ako
    /// AppleSignInController). Plus `popoverPresentationController` anchor pre
    /// `.alert` style — niektoré iPad konfigurácie vyžadujú anchor aj pre alert
    /// (technicky nie, ale Apple guidelines odporúčajú).
    static func showAlert(in window: UIWindow?, title: String, message: String) {
        let targetWindow = window ?? AppleSignInController.resolveActiveWindow()
        guard let resolvedWindow = targetWindow,
              let rootVC = resolvedWindow.rootViewController else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        // iPad: pre `.alert` style anchor obvykle nie je potrebný, ale pri rotácii
        // alebo Split View môže systém vyžadovať popover anchor — nastav defenzívne.
        if let popover = alert.popoverPresentationController {
            popover.sourceView = rootVC.view
            popover.sourceRect = CGRect(x: rootVC.view.bounds.midX,
                                        y: rootVC.view.bounds.midY,
                                        width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        DispatchQueue.main.async {
            // Find the topmost presented view controller
            var topVC: UIViewController = rootVC
            while let presented = topVC.presentedViewController {
                topVC = presented
            }
            topVC.present(alert, animated: true)
        }
    }

    /// Pomocný — nájde top presented view controller pre WKWebView aby
    /// GoogleSignIn vedel ako zobraziť authorize sheet.
    static func topPresentedViewController(from view: UIView) -> UIViewController? {
        guard let rootVC = view.window?.rootViewController else { return nil }
        var topVC: UIViewController = rootVC
        while let presented = topVC.presentedViewController {
            topVC = presented
        }
        return topVC
    }

    /// Volá sa z PrplCRMApp.onOpenURL keď iOS doručí OAuth callback URL
    /// (Google Sign In používa custom scheme `com.googleusercontent.apps.XXX`).
    /// Vracia true ak URL patrí Google SDK, false pre ostatné (universal links).
    static func handleGoogleOpenURL(_ url: URL) -> Bool {
        #if canImport(GoogleSignIn)
        return GoogleSignInController.handleOpenURL(url)
        #else
        return false
        #endif
    }
}
