package eu.prplcrm.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.widget.FrameLayout
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.KeyEvent
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
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
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File
import java.util.Date

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
    // Koreňový kontajner: WebView + natívne prekrytie pri zlyhaní načítania.
    private lateinit var rootLayout: FrameLayout
    private lateinit var loadErrorOverlay: LoadErrorOverlay
    // true = aktuálna navigácia hlavného rámca zlyhala (sieť / HTTP 5xx). WebView
    // po chybe aj tak zavolá onPageFinished (pre svoju chybovú stránku), takže
    // prekrytie sa smie skryť len keď táto navigácia NEzlyhala.
    private var mainFrameFailed = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    // Prediktívny back (targetSdk 36): enabled sa synchronizuje s
    // webView.canGoBack() v doUpdateVisitedHistory + po crash-recovery.
    private var backCallback: OnBackPressedCallback? = null

    // Posledná načítaná URL na našej doméne — pre recovery po onRenderProcessGone.
    // Mŕtvy WebView vráti webView.url == null, takže ho trackujeme samostatne
    // (inak by crash recovery vždy hodil usera na /app namiesto jeho stránky).
    private var lastLoadedUrl: String? = null

    // Stav WebView (URL + história) uložený systémom pri zničení Activity
    // (skladací telefón bez obsluhy danej konfigurácie, zmena jazyka, low-memory
    // kill s obnovou…). V proceedToWeb() má prednosť pred startUrl, aby sa
    // používateľ vrátil presne tam, kde bol, a nie na /app.
    private var pendingWebViewState: Bundle? = null

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
     *
     * Doručuje sa VÝHRADNE cez completeFileChooser() — WebView pri druhom
     * doručení toho istého callbacku hodí IllegalStateException („Duplicate
     * showFileChooser result") a appka spadne.
     */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /** Natívna voľba „Odfotiť / Nahrať video / Vybrať súbor", kým je otvorená. */
    private var fileSourceDialog: AlertDialog? = null

    /**
     * Súbor, do ktorého práve zapisuje appka fotoaparátu. Ukladá sa aj do
     * onSaveInstanceState: pri nedostatku RAM systém počas fotenia náš proces
     * zabije a po návrate treba aspoň upratať súbor. WebView callback smrť
     * procesu (ani znovuvytvorenie Activity) neprežije — user prílohu pridá znova.
     */
    private var pendingCapture: File? = null

    /** Picker pre `<input type="file">` — zvláda single aj multiple, všetky mime typy. */
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
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
        completeFileChooser(uris)
    }

    /**
     * „Odfotiť" / „Nahrať video" — systémová appka fotoaparátu zapíše záber do
     * nášho FileProvider URI (práva na zápis pridá framework sám z EXTRA_OUTPUT).
     * Launchery sú registrované pri konštrukcii Activity (pred STARTED, inak
     * registerForActivityResult hodí výnimku) — vďaka tomu ActivityResultRegistry
     * doručí výsledok aj novej inštancii po obnove Activity.
     */
    private val takePictureLauncher = registerForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { saved -> onCaptureResult(saved, CaptureKind.PHOTO) }

    private val captureVideoLauncher = registerForActivityResult(
        SizeLimitedCaptureVideo(VIDEO_SIZE_LIMIT_BYTES)
    ) { saved -> onCaptureResult(saved, CaptureKind.VIDEO) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Install splash MUSÍ byť pred super.onCreate() inak nefunguje.
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        pendingWebViewState = savedInstanceState?.getBundle(KEY_WEBVIEW_STATE)
        pendingCapture = savedInstanceState?.getString(KEY_PENDING_CAPTURE)?.let { File(it) }
        cleanUpStaleCaptures()

        webView = WebView(this).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        rootLayout = FrameLayout(this).apply { addView(webView) }
        setContentView(rootLayout)
        // Prekrytie „Nepodarilo sa pripojiť" (view_load_error.xml) — leží nad
        // WebView, zobrazí sa len pri zlyhaní hlavnej stránky (viď WebViewClient).
        loadErrorOverlay = LoadErrorOverlay(rootLayout) { retryMainFrameLoad() }

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

        // Google Play zero-tap sign-in: bez platného JWT (nový telefón,
        // reinštalácia, expirovaný 7-dňový token) skús obnovu z Block Store
        // EŠTE PRED načítaním webu — user nabootuje rovno prihlásený, bez
        // login obrazovky. Splash ostáva, kým sa nerozhodne (max 3 s).
        // Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
        if (JwtUtils.isExpired(TokenStore.getAuthToken(this))) {
            var restoring = true
            splash.setKeepOnScreenCondition { restoring }
            RestoreSession.tryRestore(
                this,
                onLateSuccess = { if (!isFinishing && !isDestroyed) webView.reload() }
            ) { _ ->
                restoring = false
                proceedToWeb(startUrl)
            }
        } else {
            proceedToWeb(startUrl)
        }
    }

    /** Načíta web appku a spustí veci, ktoré potrebujú (prípadne obnovený) auth token. */
    private fun proceedToWeb(startUrl: String) {
        // Rekonštrukcia Activity (viď KEY_WEBVIEW_STATE): obnov poslednú stránku
        // a históriu namiesto štartu z /app. restoreState vráti null, ak je
        // bundle prázdny/nekompatibilný — vtedy fallback na startUrl.
        val restored = pendingWebViewState?.let { webView.restoreState(it) } != null
        pendingWebViewState = null
        if (!restored) webView.loadUrl(startUrl)
        maybeRequestNotificationPermission()
        ensureFcmTokenRegistered()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) {
            val state = Bundle()
            webView.saveState(state)
            outState.putBundle(KEY_WEBVIEW_STATE, state)
        }
        pendingCapture?.let { outState.putString(KEY_PENDING_CAPTURE, it.absolutePath) }
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

        // Sťahovanie z priamej URL (hromadný ZIP export príloh). DownloadManager
        // streamuje na disk mimo WebView — pamäť appky sa nezaťaží ani pri
        // stovkách MB, na rozdiel od base64 mosta (NativeBridge.saveFile),
        // ktorý je pre bežné prílohy. Bez tohto listenera WebView odpoveď
        // s Content-Disposition: attachment jednoducho zahodí.
        //
        // Auth: ZIP odkaz nesie jednorazový token priamo v URL, takže
        // DownloadManager (beží mimo WebView, hlavičky nedostane) prejde.
        // Preto sem púšťame LEN našu doménu — cudzí odkaz by sme sťahovali
        // bez kontroly obsahu.
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val uri = Uri.parse(url)
                if (!isOurHost(url)) {
                    android.util.Log.w("PrplCRM", "[Download] Odmietnutý cudzí host: ${uri.host}")
                    return@setDownloadListener
                }
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(uri).apply {
                    setMimeType(mimeType)
                    setTitle(fileName)
                    setDescription("Prpl CRM")
                    addRequestHeader("User-Agent", userAgent)
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                }
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Sťahujem $fileName…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                android.util.Log.e("PrplCRM", "[Download] Zlyhalo", e)
                Toast.makeText(this, "Sťahovanie zlyhalo", Toast.LENGTH_SHORT).show()
            }
        }
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
            // Rozbehnutý výber súboru patrí mŕtvemu WebView (render proces často
            // padá práve pri otvorenom fotoaparáte — pamäť). Zahodíme ho, aby
            // výsledok z fotoaparátu skončil hláškou „skúste znova", nie v prázdne.
            filePathCallback = null
            fileSourceDialog?.dismiss()
            fileSourceDialog = null
            rootLayout.removeView(webView)
            webView.destroy()
            webView = WebView(this).apply {
                layoutParams = android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT
                )
            }
            rootLayout.addView(webView, 0) // index 0 = pod prekrytím chyby
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
                mainFrameFailed = false // nová navigácia hlavného rámca

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
                // Bez siete / DNS / timeout → namiesto Chrome „Webpage not available"
                // ukáž natívne prekrytie s automatickým opakovaním. LEN pre chyby,
                // ktoré má zmysel opakovať: prerušená navigácia (ERR_ABORTED —
                // presmerovanie, window.location počas načítania, OAuth návrat) alebo
                // zlá/zablokovaná URL nie sú výpadok a prekrytie by len preblikávalo.
                if (isRetryableLoadError(error)) {
                    mainFrameFailed = true
                    loadErrorOverlay.show(offline = !isOnline())
                }
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                super.onReceivedHttpError(view, request, errorResponse)
                if (request?.isForMainFrame != true) return
                val safeUrl = sanitizeUrlForReport(request.url)
                val status = errorResponse?.statusCode ?: 0
                NativeErrorReporter.report(
                    this@MainActivity,
                    "AndroidWebViewHttpError",
                    "status=$status url=$safeUrl",
                    safeUrl
                )
                // 5xx (Render/Cloudflare 502/503/504, výpadok, deploy) → WebView by
                // inak zobrazil surovú chybovú stránku Cloudflare bez cesty von.
                // 4xx nechávame (statický web servíruje index.html pre všetky cesty,
                // takže na hlavnom rámci reálne nenastáva).
                if (status >= 500) {
                    mainFrameFailed = true
                    loadErrorOverlay.show(offline = false)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // Volá sa aj pre chybovú stránku po zlyhaní — skry prekrytie LEN
                // keď táto navigácia prešla.
                if (!mainFrameFailed) loadErrorOverlay.hide()
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
            // na Androide file inputs ignoruje. Voľba fotoaparát / súbory a
            // samotné spustenie je v handleFileChooser().
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean = handleFileChooser(callback, params)
        }
    }

    /**
     * `<input type="file">` z WebView.
     *
     * Ak input prijíma obrázky/video (alebo nemá `accept`), najprv ponúkneme
     * natívnu voľbu „Odfotiť / Nahrať video / Vybrať súbor" — systémový výber
     * súborov (ACTION_OPEN_DOCUMENT) fotoaparát neponúka, takže prílohu sa na
     * Androide nedalo odfotiť priamo z appky. Vlastný dialóg namiesto
     * EXTRA_INITIAL_INTENTS v systémovom chooseri: právo zápisu do URI sa cez
     * initial intents u niektorých výrobcov neprenesie a fotoaparát by nemal
     * kam fotku uložiť.
     *
     * Kontrakt s WebView: keď vrátime true, callback MUSÍ byť doručený presne
     * raz (completeFileChooser) — nedoručený = input ostane zaseknutý,
     * doručený dvakrát = IllegalStateException a pád appky.
     */
    private fun handleFileChooser(
        callback: ValueCallback<Array<Uri>>?,
        params: WebChromeClient.FileChooserParams?
    ): Boolean {
        if (callback == null) return false
        // Predošlý neukončený výber (picker / dialóg) uzavrieme s null, aby sa
        // WebView neupchalo. Listener starého dialógu sa potom už nechytí —
        // kontroluje, či je jeho callback stále aktuálny.
        completeFileChooser(null)
        fileSourceDialog?.dismiss()
        fileSourceDialog = null
        filePathCallback = callback

        val captureRequested = params?.isCaptureEnabled == true
        val spec = FileChooserSupport.buildSpec(params?.acceptTypes, captureRequested) { ext ->
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        }
        val multiple = params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val canPhoto = spec.offerPhoto && canCapture(MediaStore.ACTION_IMAGE_CAPTURE)
        val canVideo = spec.offerVideo && canCapture(MediaStore.ACTION_VIDEO_CAPTURE)

        when {
            // HTML `capture` atribút = rovno fotoaparát, bez voľby (ako Chrome).
            captureRequested && (canPhoto || canVideo) ->
                launchCapture(if (canPhoto) CaptureKind.PHOTO else CaptureKind.VIDEO)
            canPhoto || canVideo -> showFileSourceDialog(spec, multiple, canPhoto, canVideo)
            else -> launchDocumentPicker(spec.mimeTypes, multiple)
        }
        // Vždy true: callback sme prevzali a doručíme ho sami, aj pri chybe.
        // Predtým catch vrátil false po onReceiveValue(null) → WebView doručil
        // ten istý callback druhýkrát a appka spadla („Duplicate showFileChooser result").
        return true
    }

    /** Jediné miesto, ktoré doručuje výsledok do WebView — zaručí „presne raz". */
    private fun completeFileChooser(uris: Array<Uri>?) {
        val callback = filePathCallback ?: return
        filePathCallback = null
        callback.onReceiveValue(uris)
    }

    private fun showFileSourceDialog(
        spec: FileChooserSupport.Spec,
        multiple: Boolean,
        canPhoto: Boolean,
        canVideo: Boolean
    ) {
        if (isFinishing || isDestroyed) {
            completeFileChooser(null)
            return
        }
        val owner = filePathCallback
        val labels = mutableListOf<String>()
        val actions = mutableListOf<() -> Unit>()
        if (canPhoto) {
            labels += getString(R.string.file_chooser_take_photo)
            actions += { launchCapture(CaptureKind.PHOTO) }
        }
        if (canVideo) {
            labels += getString(R.string.file_chooser_record_video)
            actions += { launchCapture(CaptureKind.VIDEO) }
        }
        labels += getString(R.string.file_chooser_pick_file)
        actions += { launchDocumentPicker(spec.mimeTypes, multiple) }

        var chosen = false
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (spec.imagesOnly) R.string.file_chooser_title_photo else R.string.file_chooser_title_file)
            .setItems(labels.toTypedArray()) { _, which ->
                chosen = true
                // Medzitým mohol prísť nový výber s iným callbackom — ten nie je náš.
                if (filePathCallback === owner) actions[which]()
            }
            .create()
        // Späť, ťuk mimo dialógu aj akékoľvek iné zatvorenie bez voľby → null.
        // Listener beží asynchrónne až po dismiss(), preto porovnávame callback:
        // nový výber mohol medzitým nastaviť iný a ten zatvárať nesmieme.
        dialog.setOnDismissListener {
            if (fileSourceDialog === dialog) fileSourceDialog = null
            if (!chosen && filePathCallback === owner) completeFileChooser(null)
        }
        fileSourceDialog = dialog
        try {
            dialog.show()
        } catch (e: Exception) {
            // Okno Activity už neplatí (BadTokenException) — aspoň výber súborov.
            android.util.Log.w("MainActivity", "File source dialog failed", e)
            fileSourceDialog = null
            launchDocumentPicker(spec.mimeTypes, multiple)
        }
    }

    /**
     * Systémový výber súborov (Storage Access Framework) — obrázky aj dokumenty
     * bez runtime oprávnení. Rešpektuje accept typy aj multiple z HTML.
     */
    private fun launchDocumentPicker(mimeTypes: List<String>, multiple: Boolean) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            when (mimeTypes.size) {
                0 -> type = "*/*"
                1 -> type = mimeTypes[0]
                else -> {
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                }
            }
            if (multiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            filePickerLauncher.launch(
                Intent.createChooser(intent, getString(R.string.file_chooser_system_title))
            )
        } catch (e: Exception) {
            // Zariadenie bez použiteľného DocumentsUI / choosera, SecurityException…
            android.util.Log.w("MainActivity", "File chooser launch failed", e)
            NativeErrorReporter.report(
                this,
                "AndroidFileChooserLaunchFailed",
                "${e.javaClass.simpleName}: ${e.message.orEmpty().take(300)} mimeTypes=${mimeTypes.size} multiple=$multiple"
            )
            Toast.makeText(this, R.string.file_chooser_picker_failed, Toast.LENGTH_SHORT).show()
            completeFileChooser(null)
        }
    }

    /**
     * Vie zariadenie odfotiť / nahrať video? Chromebook bez kamery, tablet bez
     * appky fotoaparátu… — vtedy voľbu vôbec neponúkneme. resolveActivity()
     * potrebuje <queries> v manifeste (package visibility od Androidu 11).
     */
    private fun canCapture(action: String): Boolean = try {
        packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) &&
            Intent(action).resolveActivity(packageManager) != null
    } catch (_: Exception) {
        false
    }

    /**
     * Spustí systémovú appku fotoaparátu so zápisom do cacheDir/captures.
     * Súbor má príponu .jpg / .mp4 — server aj web podľa nej určujú typ prílohy.
     */
    private fun launchCapture(kind: CaptureKind) {
        var file: File? = null
        try {
            file = FileChooserSupport.newCaptureFile(
                File(cacheDir, FileChooserSupport.CAPTURES_DIR), kind, Date()
            )
            val uri = FileProvider.getUriForFile(this, FILE_PROVIDER_AUTHORITY, file)
            pendingCapture = file
            when (kind) {
                CaptureKind.PHOTO -> takePictureLauncher.launch(uri)
                CaptureKind.VIDEO -> captureVideoLauncher.launch(uri)
            }
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "Camera launch failed", e)
            pendingCapture = null
            file?.delete()
            NativeErrorReporter.report(
                this,
                "AndroidCameraLaunchFailed",
                "kind=${kind.name} ${e.javaClass.simpleName}: ${e.message.orEmpty().take(300)}"
            )
            Toast.makeText(this, R.string.file_chooser_camera_failed, Toast.LENGTH_SHORT).show()
            completeFileChooser(null)
        }
    }

    /** Výsledok z fotoaparátu → WebView (alebo upratanie pri zrušení). */
    private fun onCaptureResult(saved: Boolean, kind: CaptureKind) {
        val file = pendingCapture
        pendingCapture = null
        // Len úspech + neprázdny súbor. Prázdny súbor = appka fotoaparátu nič
        // nezapísala a server by ho aj tak odmietol.
        val captured = if (saved && file != null && file.length() > 0) file else null

        if (filePathCallback == null) {
            // Activity bola medzitým znovu vytvorená alebo proces zabitý — WebView
            // callback (aj stránka, ktorá o súbor žiadala) je preč, záber sa
            // pripojiť nedá. Uprac a povedz userovi, nech to skúsi znova.
            file?.delete()
            if (captured != null) {
                Toast.makeText(this, R.string.file_chooser_capture_lost, Toast.LENGTH_LONG).show()
                NativeErrorReporter.report(this, "AndroidCaptureResultLost", "kind=${kind.name}")
            }
            return
        }
        if (captured == null) {
            file?.delete()
            if (saved) {
                // Appka fotoaparátu ohlásila úspech, ale do nášho súboru nič
                // nezapísala (niektoré OEM fotoaparáty ignorujú EXTRA_OUTPUT
                // pri videu a uložia záznam do galérie). Bez hlášky by sa
                // „nič nestalo" pri každom pokuse — ponúkneme cestu cez galériu.
                Toast.makeText(this, R.string.file_chooser_capture_empty, Toast.LENGTH_LONG).show()
                NativeErrorReporter.report(this, "AndroidCaptureEmpty", "kind=${kind.name} fileNull=${file == null}")
            }
            // Inak zrušené fotenie (Späť v appke fotoaparátu).
            completeFileChooser(null)
            return
        }
        val uri = try {
            FileProvider.getUriForFile(this, FILE_PROVIDER_AUTHORITY, captured)
        } catch (e: Exception) {
            NativeErrorReporter.report(
                this,
                "AndroidCaptureUriFailed",
                "kind=${kind.name} ${e.javaClass.simpleName} size=${captured.length()}"
            )
            null
        }
        if (uri == null) {
            captured.delete()
            completeFileChooser(null)
            return
        }
        completeFileChooser(arrayOf(uri))
    }

    /**
     * Zábery staršie ako deň zmaže mimo UI vlákna (I/O nesmie brzdiť štart).
     * Hneď po odovzdaní do WebView ich mazať nemôžeme — web súbor číta až neskôr.
     */
    private fun cleanUpStaleCaptures() {
        val dir = File(cacheDir, FileChooserSupport.CAPTURES_DIR)
        Thread {
            try {
                FileChooserSupport.deleteStaleCaptures(dir, System.currentTimeMillis())
            } catch (e: Exception) {
                android.util.Log.w("MainActivity", "Stale capture cleanup failed", e)
            }
        }.start()
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

    override fun onStart() {
        super.onStart()
        // Návrat siete → okamžitý pokus (namiesto čakania na odpočet prekrytia).
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread { if (loadErrorOverlay.isShowing) loadErrorOverlay.retryNow() }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "registerDefaultNetworkCallback failed", e)
        }
    }

    override fun onStop() {
        networkCallback?.let { cb ->
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(cb)
            } catch (e: Exception) { /* už odregistrované */ }
        }
        networkCallback = null
        super.onStop()
    }

    /**
     * Chyby hlavného rámca, pri ktorých má zmysel ukázať prekrytie a opakovať:
     * sieť (DNS, spojenie, I/O, timeout, SSL handshake), preťažený server,
     * ERROR_UNKNOWN len ak nejde o prerušenie (net::ERR_ABORTED / ERR_BLOCKED_BY_*).
     */
    private fun isRetryableLoadError(error: WebResourceError?): Boolean {
        val desc = error?.description?.toString().orEmpty()
        if (desc.contains("ERR_ABORTED") || desc.contains("ERR_BLOCKED_BY")) return false
        return when (error?.errorCode) {
            WebViewClient.ERROR_HOST_LOOKUP,
            WebViewClient.ERROR_CONNECT,
            WebViewClient.ERROR_IO,
            WebViewClient.ERROR_TIMEOUT,
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE,
            WebViewClient.ERROR_TOO_MANY_REQUESTS,
            WebViewClient.ERROR_UNKNOWN -> true
            else -> false
        }
    }

    /** Je k dispozícii sieť s internetom? (ACCESS_NETWORK_STATE máme v manifeste.) */
    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Opakovanie po zlyhaní hlavnej stránky. WebView po chybe drží pôvodnú URL
     * (aj pri Chrome chybovej stránke aj pri 5xx odpovedi), takže reload() načíta
     * znova to, čo zlyhalo, a nepridá záznam do histórie (Späť nevedie na chybu).
     */
    private fun retryMainFrameLoad() {
        if (isFinishing || isDestroyed) return
        val current = webView.url
        if (!current.isNullOrEmpty() && current.startsWith("http") && isOurHost(current)) {
            webView.reload()
        } else {
            webView.loadUrl(lastLoadedUrl ?: getString(R.string.webapp_url))
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // Návrat na popredie s prekrytím chyby → skús hneď (sieť sa mohla vrátiť
        // kým bola appka na pozadí a callback už nemusel byť registrovaný).
        if (loadErrorOverlay.isShowing) loadErrorOverlay.retryNow()
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
        // Otvorený dialóg by inak „unikol" (WindowLeaked). Callback patrí
        // zanikajúcemu WebView — vynulujeme ho, aby ho dismiss listener už
        // nedoručoval.
        filePathCallback = null
        fileSourceDialog?.dismiss()
        fileSourceDialog = null
        loadErrorOverlay.destroy()
        webView.destroy()
        // Kill swiped alebo destroy → určite nie na popredí. Ak by onPause
        // nestihlo bežat (rare race), tento fallback zabezpečí že ďalšia push
        // sa zobrazí systémovo.
        isAppInForeground = false
        super.onDestroy()
    }

    companion object {
        private const val KEY_WEBVIEW_STATE = "prpl_webview_state"
        private const val KEY_PENDING_CAPTURE = "prpl_pending_capture"

        /** MUSÍ sedieť s android:authorities FileProvidera v AndroidManifest.xml. */
        private const val FILE_PROVIDER_AUTHORITY = "${BuildConfig.APPLICATION_ID}.fileprovider"

        /**
         * Strop pre video z fotoaparátu = najväčší limit prílohy na serveri
         * (úlohy/kontakty 50 MB). Bez neho by pár minút videa server vždy odmietol.
         */
        private const val VIDEO_SIZE_LIMIT_BYTES = 50L * 1024 * 1024
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

/**
 * CaptureVideo s limitom veľkosti (MediaStore.EXTRA_SIZE_LIMIT) — väčšina
 * systémových appiek fotoaparátu nahrávanie pri limite sama zastaví.
 */
private class SizeLimitedCaptureVideo(
    private val maxBytes: Long
) : ActivityResultContracts.CaptureVideo() {
    override fun createIntent(context: Context, input: Uri): Intent =
        super.createIntent(context, input).putExtra(MediaStore.EXTRA_SIZE_LIMIT, maxBytes)
}
