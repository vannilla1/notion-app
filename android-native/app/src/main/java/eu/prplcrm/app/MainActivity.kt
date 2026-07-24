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
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import androidx.activity.OnBackPressedCallback
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
    // Prediktívny back (targetSdk 36): enabled sa synchronizuje s
    // webView.canGoBack() v doUpdateVisitedHistory + po crash-recovery.
    private var backCallback: OnBackPressedCallback? = null

    // Posledná načítaná URL na našej doméne — pre recovery po onRenderProcessGone.
    // Mŕtvy WebView vráti webView.url == null, takže ho trackujeme samostatne
    // (inak by crash recovery vždy hodil usera na /app namiesto jeho stránky).
    private var lastLoadedUrl: String? = null

    /** Requestuje notification permission pri prvom spustení na Android 13+. */
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Ak user denied, banner vo web appke mu neskôr vysvetlí ako to zapnúť
        // v systémových nastaveniach. Žiadna akcia tu.
    }

    /**
     * Callback z WebView `<input type="file">` — uložíme si ho pri otvorení
     * file chooseru a doručíme doň URIs vybratých súborov po návrate z Activity
     * resultu. Ak user chooser zruší, musíme zavolať callback s null, inak by
     * WebView ostal v "čaká na súbor" stave a ďalší klik na input by nefungoval.
     */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /** Picker pre `<input type="file">` — zvláda single aj multiple, všetky mime typy. */
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        val uris: Array<Uri>? = when {
            result.resultCode != android.app.Activity.RESULT_OK -> null
            result.data?.clipData != null -> {
                // Multiple files (user podržal a vybral viac)
                val clip = result.data!!.clipData!!
                Array(clip.itemCount) { clip.getItemAt(it).uri }
            }
            result.data?.data != null -> arrayOf(result.data!!.data!!)
            else -> null
        }
        callback.onReceiveValue(uris)
        filePathCallback = null
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

        // Späť = navigácia vo WebView, nie zatvorenie appky. Od targetSdk 36
        // je prediktívne spätné gesto zapnuté DEFAULTNE a systém na Androide
        // 13+ prestáva doručovať KEYCODE_BACK/onBackPressed — starý onKeyDown
        // handler (nižšie, ostáva ako fallback pre staré verzie) by sa už
        // nezavolal a Späť by okamžite zatváralo appku. OnBackPressedDispatcher
        // je moderná cesta, ktorú prediktívny back rešpektuje.
        // Štartuje disabled (root stránka nemá kam ísť späť) — enabled sa
        // priebežne synchronizuje v doUpdateVisitedHistory. Vďaka tomu na
        // root stránke systém prehrá natívnu prediktívnu close animáciu.
        backCallback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    // Poistka pre stav rozsynchronizovania — pusti systémový back
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        }.also { onBackPressedDispatcher.addCallback(this, it) }

        configureWebView()
        injectLocalStorageBootstrap()
        setupWebViewClients()
        // NativeBridge sa registruje podmieňne v WebViewClient.onPageStarted podľa hostu
        // (hostname guard, defence-in-depth pre prípad navigácie mimo našej domény).

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
            resolveAgainstBase(it)?.let { resolved -> return resolved }
        }
        // ACTION_VIEW → data Uri. Host guard aj tu: explicitný intent na náš
        // exported komponent OBCHÁDZA intent-filter matching, takže App Links
        // verifikácia sama osebe cudziu URL nezastaví.
        if (intent.action == Intent.ACTION_VIEW) {
            intent.data?.toString()
                ?.takeIf { it.startsWith("https://") && isOurHost(it) }
                ?.let { return it }
        }
        return null
    }

    /** Host guard — porovnanie s hostom webapp_url (prplcrm.eu). */
    private fun isOurHost(url: String): Boolean {
        val ourHost = Uri.parse(getString(R.string.webapp_url)).host
        return Uri.parse(url).host == ourHost
    }

    /**
     * Query/fragment sa NIKDY nereportuje do diagnostiky — OAuth callback
     * (/auth/callback?token=<JWT>) by inak pri 5xx/network chybe poslal
     * session token do error logov v cleartexte.
     */
    private fun sanitizeUrlForReport(uri: Uri?): String =
        uri?.buildUpon()?.clearQuery()?.fragment(null)?.build()?.toString()
            ?: "https://prplcrm.eu/native-android"

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
    private fun resolveAgainstBase(link: String): String? {
        if (link.startsWith("https://") || link.startsWith("http://")) {
            // MainActivity je exported — deep_link extra vie poslať HOCIKTORÁ
            // appka na zariadení. Absolútne URL preto pustíme len na náš host;
            // inak by cudzia appka vedela do nášho brandovaného okna načítať
            // phishingovú stránku (vyzerala by ako súčasť Prpl CRM).
            return if (isOurHost(link)) link else null
        }
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

    /**
     * Recovery po onRenderProcessGone — mŕtvy WebView sa už nedá použiť, treba
     * vytvoriť nový a načítať poslednú URL. Rovnaký setup ako v onCreate. Beží
     * na UI threade (WebViewClient callback), takže setContentView je bezpečné.
     */
    private fun recreateWebViewAfterCrash() {
        try {
            // webView.url je na mŕtvom rendereri null → použijeme trackovanú URL.
            val lastUrl = lastLoadedUrl ?: getString(R.string.webapp_url)
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
            webView = WebView(this).apply {
                layoutParams = android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT
                )
            }
            setContentView(webView)
            configureWebView()
            setupWebViewClients()
            // Nový WebView = prázdna história — resync prediktívneho backu
            backCallback?.isEnabled = false
            webView.loadUrl(lastUrl)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "WebView recreate after crash failed", e)
        }
    }

    private fun setupWebViewClients() {
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                // Ne-http(s) schémy (mailto:, tel:, sms:, ...) NEMAJÚ host
                // (url.host == null), takže host-podmienka nižšie ich nechávala
                // prepadnúť do WebView → net::ERR_UNKNOWN_URL_SCHEME (diagnostika
                // 1.0.3: mailto:support@prplcrm.eu). Otvárame ich v systémovom
                // handleri (mail appka, dialer) a VŽDY vraciame true — do WebView
                // nesmú. Ak zariadenie handler nemá, ticho nič (nie je to chyba).
                val scheme = url.scheme?.lowercase()
                if (scheme != null && scheme != "http" && scheme != "https") {
                    // Allowlist kontaktných schém + vyžadujeme user gesture —
                    // stránkový JS bez kliknutia nesmie potichu otvárať cudzie
                    // appky (XSS/kompromitovaný redirect by inak vedel spúšťať
                    // ľubovoľné deep-linky). Ostatné schémy sa zhltnú: do
                    // WebView nepatria (ERR_UNKNOWN_URL_SCHEME) a von nejdú.
                    val allowed = scheme == "mailto" || scheme == "tel" || scheme == "sms" || scheme == "geo"
                    if (allowed && request?.hasGesture() == true) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, url))
                        } catch (_: Exception) { /* žiadna appka pre danú schému */ }
                    }
                    return true
                }
                // External http(s) linky (iné domény) otvoríme v systémovom
                // prehliadači namiesto v našom WebView.
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

                // Defence-in-depth hostname guard na NativeBridge:
                // Ak sa WebView akýmkoľvek spôsobom dostal na cudziu doménu (napr. OAuth
                // callback, server redirect, XSS scenario), odstráni NativeBridge aby
                // untrusted stránka nemohla volať setAuthToken/clearAll a krajdúc token
                // z Keystore. Po návrate na našu doménu ho znovu registrujeme.
                // shouldOverrideUrlLoading už bloknut externé navigácie, ale toto je
                // druhá vrstva pre edge cases (in-document redirect, history.pushState).
                val ourHost = Uri.parse(getString(R.string.webapp_url)).host
                val currentHost = url?.let { Uri.parse(it).host }
                if (currentHost == ourHost) {
                    webView.addJavascriptInterface(WebAppInterface(this@MainActivity, webView), "NativeBridge")
                    url?.let { lastLoadedUrl = it } // pre crash recovery
                } else {
                    webView.removeJavascriptInterface("NativeBridge")
                }

                // Token bridge — tokeny z Keystore → localStorage (pre React appku).
                // Injectneme len na našej doméne; localStorage je beztak origin-scoped,
                // takže inject na cudziu doménu by bol no-op na našich dátach, ale
                // leak by nás stál token — radšej skip.
                if (currentHost != ourHost) return

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

            // Natívna telemetria — predtým Android nemal žiadnu. Reportujeme len
            // main-frame chyby (subresource fails ako favicon/analytics by spamovali).
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame != true) return
                // ERR_UNKNOWN_URL_SCHEME (-10): ne-http schéma prenikla do WebView.
                // Legitímne (mailto/tel/...) rieši shouldOverrideUrlLoading vyššie;
                // zvyšok nie je chyba našej stránky — nereportovať (šum v paneli).
                if (error?.errorCode == ERROR_UNSUPPORTED_SCHEME) return
                val safeUrl = sanitizeUrlForReport(request.url)
                NativeErrorReporter.report(
                    this@MainActivity,
                    "AndroidWebViewError",
                    "code=${error?.errorCode} desc=${error?.description} url=$safeUrl",
                    safeUrl
                )
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                super.onReceivedHttpError(view, request, errorResponse)
                if (request?.isForMainFrame != true) return
                val safeUrl = sanitizeUrlForReport(request.url)
                NativeErrorReporter.report(
                    this@MainActivity,
                    "AndroidWebViewHttpError",
                    "status=${errorResponse?.statusCode} url=$safeUrl",
                    safeUrl
                )
            }

            // História sa zmenila (aj SPA pushState) → synchronizuj prediktívny
            // back: callback aktívny len keď má WebView kam ísť späť. Pri root
            // stránke je vypnutý a systém prehrá natívnu close animáciu.
            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                backCallback?.isEnabled = webView.canGoBack()
            }

            // Android ekvivalent iOS WebContent termination (memory jetsam / render
            // crash). onRenderProcessGone existuje až od API 26 — na API 24/25
            // (Android 7.x, <1% zariadení) ho framework nevolá a render crash appku
            // zhodí ako predtým. Na API 26+ vrátime true → appka prežije + recovery.
            @RequiresApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val crashed = detail?.didCrash() == true
                NativeErrorReporter.report(
                    this@MainActivity,
                    "AndroidRenderProcessGone",
                    "didCrash=$crashed (memory jetsam alebo render crash)",
                    "https://prplcrm.eu/native-android/render-gone"
                )
                // Mŕtvy WebView treba nahradiť novým — inak biela obrazovka.
                recreateWebViewAfterCrash()
                return true // appka nespadne
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                // Users nikdy nevidia, ale pri `adb logcat` si môžeme prečítať
                // web app JS errory pri debugingu.
                android.util.Log.d("WebViewConsole", "${consoleMessage?.message()} -- ${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()}")
                return true
            }

            // File chooser pre HTML input[type=file] — bez override-u WebView
            // na Androide file inputs ignoruje. ACTION_OPEN_DOCUMENT (Storage
            // Access Framework) zvláda obrázky aj dokumenty bez runtime permissions.
            // Rešpektuje accept mime typy aj multiple atribút z HTML.
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                // Ak už čakáme na iný picker, zatvoríme ho s null aby sa WebView
                // neupchalo.
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                // MIME typy podľa accept atribútu z HTML inputu.
                val acceptTypes: Array<String> = params?.acceptTypes
                    ?.filter { it.isNotBlank() }
                    ?.toTypedArray()
                    ?: emptyArray()

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                if (acceptTypes.isEmpty()) {
                    intent.type = "*/*"
                } else if (acceptTypes.size == 1) {
                    intent.type = acceptTypes[0]
                } else {
                    intent.type = "*/*"
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                }
                if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }

                try {
                    val chooser = Intent.createChooser(intent, "Vyberte súbor")
                    filePickerLauncher.launch(chooser)
                } catch (e: Exception) {
                    android.util.Log.w("MainActivity", "File chooser launch failed", e)
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    return false
                }
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
