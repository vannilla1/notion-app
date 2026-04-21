package eu.prplcrm.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Hlavná Activity appky.
 *
 * Rola:
 *   1. Načíta splash screen (Android 12+ API + backport cez core-splashscreen)
 *   2. Vytvorí WebView nakonfigurovaný pre plnohodnotnú PWA (JS, storage, cookies)
 *   3. Injectne WebAppInterface pre token bridge — web appka volá
 *      `window.NativeBridge.setAuthToken(jwt)` a token sa uloží do
 *      EncryptedSharedPreferences (hardware-backed).
 *   4. Pri cold-start prečíta lokálny token a injectne ho do `localStorage`
 *      PREDTÝM ako sa načíta hlavná appka — React sa prihlási bez opätovného
 *      zobrazenia /login stránky.
 *   5. Requestne POST_NOTIFICATIONS permission (Android 13+)
 *   6. Zaregistruje FCM token na backend po úspešnom login
 *   7. Handle-uje deep link intenty (ak user klikne notifikáciu → otvorí sa
 *      na konkrétnej stránke)
 *   8. Handle-uje back button ako browser back (namiesto zatvorenia appky)
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /** Requestuje notification permission pri prvom spustení na Android 13+. */
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Ak user denied, banner vo web appke mu neskôr vysvetlí ako to zapnúť
        // v systémových nastaveniach. Žiadna akcia tu.
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Install splash MUSÍ byť pred super.onCreate() inak nefunguje.
        installSplashScreen()
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(webView)

        configureWebView()
        injectLocalStorageBootstrap()
        setupWebViewClients()
        webView.addJavascriptInterface(WebAppInterface(this, webView), "NativeBridge")

        // Načítaj web appku — alebo deep link URL z intentu ak appka bola otvorená
        // kliknutím na notifikáciu.
        val startUrl = resolveStartUrl(intent) ?: getString(R.string.webapp_url)
        webView.loadUrl(startUrl)

        maybeRequestNotificationPermission()
        ensureFcmTokenRegistered()
    }

    /**
     * Ak príde nový intent (napr. appka beží, user klikne push notifikáciu
     * otvárajúcu iný deep link), presmerujeme WebView bez reštartu Activity.
     * `singleTask` launch mode v manifeste zabezpečuje že táto Activity sa
     * neduplikuje.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        resolveStartUrl(intent)?.let { webView.loadUrl(it) }
    }

    /**
     * Pokúsi sa extrahovať deep link URL z intentu.
     *
     * 1. ACTION_VIEW s data Uri → klasický web link tap (napr. z push notifikácie
     *    Firebase SDK doručenej ako system notification)
     * 2. "deep_link" extra v intentu — posielame si ho z PrplFcmService keď
     *    zobrazujeme vlastnú notifikáciu s data payloadom
     */
    private fun resolveStartUrl(intent: Intent?): String? {
        if (intent == null) return null
        // Explicit extra z PrplFcmService — môže byť absolútny (https://...) alebo
        // relatívny (/tasks?highlightTask=...), keďže backend `generateNotificationUrl`
        // vracia relatívne cesty (ten istý deep-link formát používa aj iOS a rieši to
        // tam vo Swifte). Musíme ich resolvovať proti webapp_url hostu — inak
        // WebView.loadUrl("/tasks?...") sa pokúsi načítať ako file:// scheme a vráti
        // net::ERR_ACCESS_DENIED.
        intent.getStringExtra(EXTRA_DEEP_LINK)?.takeIf { it.isNotBlank() }?.let {
            return resolveAgainstBase(it)
        }
        // ACTION_VIEW → data Uri
        if (intent.action == Intent.ACTION_VIEW) {
            intent.data?.toString()?.takeIf { it.startsWith("https://") }?.let { return it }
        }
        return null
    }

    /**
     * Normalizuje deep link na absolútnu https URL.
     *  - "https://..."  → nezmenené
     *  - "/tasks?..."   → "<host>/tasks?..."
     *  - "tasks?..."    → "<host>/tasks?..."
     *
     * POZOR: Client-side routes (`/app`, `/tasks`, `/crm`, `/messages`) sú všetky
     * na koreňovej úrovni. Úvodné webapp_url = "https://prplcrm.eu/app" je len
     * vstupná URL (dashboard route), NIE je to path prefix. Ak by sme pridali
     * "/app" pred "/tasks", dostali by sme "/app/tasks" ktoré ako route neexistuje
     * a React vráti biely fallback.
     */
    private fun resolveAgainstBase(link: String): String {
        if (link.startsWith("https://") || link.startsWith("http://")) return link
        val webappUrl = getString(R.string.webapp_url).removeSuffix("/")
        val host = Uri.parse(webappUrl).let { "${it.scheme}://${it.host}" }
        val normalizedPath = if (link.startsWith("/")) link else "/$link"
        return "$host$normalizedPath"
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false      // Security — žiadne file:// URI
            allowContentAccess = false    // Security — žiadne content:// URI
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // User agent identifikuje appku pre backend (navigator.userAgent
            // sa číta v isNativeIOSApp() / isNativePlatform() util funkciách).
            userAgentString = "$userAgentString PrplCRM-Android/${BuildConfig.VERSION_NAME}"
        }
        // Cookies — web appka používa ich len pre auth bridge; povolíme third-party
        // kvôli Google OAuth redirectom.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    }

    /**
     * Injectne auth token a workspaceId do localStorage PREDTÝM ako sa načíta
     * hlavná JS appka. Bez toho by React pri štarte videl prázdny localStorage
     * a redirectol na /login — čím by každé cold-start otvorilo login obrazovku
     * napriek tomu že token máme bezpečne v EncryptedSharedPreferences.
     *
     * Implementácia: registrujeme document-start script cez evaluateJavascript
     * pri onPageStarted. Alternatíva by bola inject-nuť cez URI rewriting alebo
     * service worker, ale document-start je najjednoduchšie.
     */
    private fun injectLocalStorageBootstrap() {
        // Skutočný inject sa deje v WebViewClient.onPageStarted — táto metóda
        // je len placeholder aby bol kód strukturovaný (document-start JS injection).
    }

    private fun setupWebViewClients() {
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                // External linky (mailto, tel, iné domény) otvoríme v systémovom
                // handleri namiesto v našom WebView.
                val urlStr = url.toString()
                val ourHost = Uri.parse(getString(R.string.webapp_url)).host
                if (url.host != null && url.host != ourHost && !urlStr.startsWith("https://prplcrm.eu")) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                        return true
                    } catch (_: Exception) { /* fall through, load in WebView */ }
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // Token bridge — tokeny z Keystore → localStorage (pre React appku).
                val token = TokenStore.getAuthToken(this@MainActivity)
                val workspaceId = TokenStore.getCurrentWorkspaceId(this@MainActivity)
                val sb = StringBuilder("(function(){try{")
                if (!token.isNullOrEmpty()) {
                    // Quoting: token je JWT (iba base64url + dots), bezpečný pre JS string.
                    sb.append("localStorage.setItem('token',\"").append(token).append("\");")
                }
                if (!workspaceId.isNullOrEmpty()) {
                    sb.append("localStorage.setItem('currentWorkspaceId',\"").append(workspaceId).append("\");")
                }
                sb.append("}catch(e){}})();")
                view?.evaluateJavascript(sb.toString(), null)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                // Users nikdy nevidia, ale pri `adb logcat` si môžeme prečítať
                // web app JS errory pri debugingu.
                android.util.Log.d("WebViewConsole", "${consoleMessage?.message()} -- ${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()}")
                return true
            }
        }
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /**
     * FCM registration lifecycle:
     *   1. FirebaseMessaging.getToken() vráti aktuálny FCM token
     *   2. Ak je iný než posledný synchronizovaný → pošleme na backend
     *   3. Ak backend zlyhá, skúsime znova na ďalšom resume
     *
     * Registration vyžaduje auth token — ak user nie je prihlásený, FCM token
     * si zapamätáme a odošleme po najbližšom login.
     */
    private fun ensureFcmTokenRegistered() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) return@addOnCompleteListener
            val fcmToken = task.result ?: return@addOnCompleteListener
            FcmRegistrar.registerIfNeeded(applicationContext, fcmToken)
        }
    }

    /** Back button = browser back, nie zatvorenie appky (kým sa dá ísť naspäť). */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // Appka ide na popredie → NotificationToast (WebSocket in-app toast)
        // preberá zobrazovanie notifikácií. PrstFcmService sa pozrie na tento
        // flag a ak je true, vypadne bez zobrazenia systémovej notifikácie
        // (inak by user videl duplicitu: systémová notifikácia + in-app toast).
        isAppInForeground = true
        // Retry FCM registration pri každom resume — rieši edge case keď user
        // bol pri onCreate nelogovaný (ensureFcmTokenRegistered skipol) a medzitým
        // sa prihlásil. FcmRegistrar.registerIfNeeded je idempotentný (skip ak
        // lastSynced == current token), takže opakovaný resume nespamuje backend.
        ensureFcmTokenRegistered()
    }

    override fun onPause() {
        webView.onPause()
        // Appka ide na pozadie → FCM zobrazí systémovú notifikáciu normálne.
        isAppInForeground = false
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        // Kill swiped alebo destroy → určite nie na popredí. Ak by onPause
        // nestihlo bežat (rare race), tento fallback zabezpečí že ďalšia push
        // sa zobrazí systémovo.
        isAppInForeground = false
        super.onDestroy()
    }

    companion object {
        const val EXTRA_DEEP_LINK = "deep_link"

        /**
         * Jednoduchý volatile flag pre foreground stav. Alternatíva by bola
         * ProcessLifecycleOwner + ProcessLifecycleObserver, ale to by vyžadovalo
         * extra lifecycle-process dependency a Application subclass. Pre jedno-
         * -activity appku s WebView postačuje tento flag nastavovaný v Activity
         * onResume/onPause. PrplFcmService ho číta pri každej prichádzajúcej
         * push správe.
         */
        @Volatile
        var isAppInForeground: Boolean = false
    }
}
