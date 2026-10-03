package eu.prplcrm.app

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * Most medzi JavaScript (web appka v WebView) a natívnym Androidom.
 *
 * Web appka cez `window.NativeBridge.setAuthToken(token)` uloží token do
 * hardware-backed EncryptedSharedPreferences. Pri ďalšom spustení appky
 * MainActivity tento token injectne späť do localStorage PREDTÝM ako sa
 * načíta / , takže web appka vidí usera ako prihláseného aj po swipe-kill.
 *
 * Paralela s iOS: tam je to WKUserContentController + WKScriptMessageHandler
 * + Keychain. Android equivalent = JavascriptInterface + EncryptedSharedPreferences.
 *
 * SECURITY: `@JavascriptInterface` anotácia je nutná — bez nej WebView nevolá
 * metódy. Volania idú z web appky (naša doména, nad HTTPS), takže untrusted
 * injection nie je realistický vektor — ALE aj tak tu nerobíme nič citlivé
 * ako exec shell alebo file I/O. Len read/write do encrypted prefs.
 */
class WebAppInterface(private val context: Context, private val webView: WebView) {

    private companion object {
        // JWT = base64url segmenty oddelené bodkami; workspaceId = Mongo ObjectId
        val JWT_CHARS = Regex("^[A-Za-z0-9_.-]+$")
        val OBJECT_ID = Regex("^[a-f0-9]{24}$")
    }

    /**
     * Defence-in-depth: bridge smie používať len stránka na našej doméne.
     * shouldOverrideUrlLoading cudzí host do WebView nepustí a onPageStarted
     * bridge na cudzom hoste odoberá — toto je tretia vrstva (metódy bežia na
     * JavaBridge vlákne, webView.url tu čítať nemožno → flag z MainActivity).
     */
    private fun trusted(): Boolean = MainActivity.pageOnOurHost

    /** Web appka po úspešnom login/register zavolá túto metódu s JWT tokenom. */
    @JavascriptInterface
    fun setAuthToken(token: String?) {
        if (!trusted()) return
        // Tvar sa vkladá späť do JS (bootstrap v onPageStarted) — nič iné než JWT.
        if (!token.isNullOrEmpty() && !JWT_CHARS.matches(token)) return
        val previous = TokenStore.getAuthToken(context)
        TokenStore.setAuthToken(context, token)
        // Po login (alebo user-switch): reset FCM "last synced" cache a zaregistruj
        // FCM token na backend. Bez tohto trigger-u by onCreate FCM register skončil
        // skip-om (lebo auth token bol null pri starte appky), a notifikácie medzi
        // zariadeniami by nefungovali kým user neukončí appku a znovu neotvorí.
        if (!token.isNullOrEmpty() && token != previous) {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        task.result?.let { fcmToken ->
                            FcmRegistrar.forceReregister(context, fcmToken)
                        }
                    }
                }
            // Google Play zero-tap sign-in: po každom novom logine vydaj obnovovací
            // token a ulož ho do Block Store (prežije reinštaláciu / nový telefón).
            RestoreSession.issueAfterLogin(context, token)
        }
    }

    @JavascriptInterface
    fun getAuthToken(): String? = if (trusted()) TokenStore.getAuthToken(context) else null

    /** Per-device workspace context — synchronizuje sa s X-Workspace-Id hlavičkou. */
    @JavascriptInterface
    fun setCurrentWorkspaceId(workspaceId: String?) {
        if (!trusted()) return
        if (!workspaceId.isNullOrEmpty() && !OBJECT_ID.matches(workspaceId)) return
        val previous = TokenStore.getCurrentWorkspaceId(context)
        TokenStore.setCurrentWorkspaceId(context, workspaceId)
        // Block Store drží aj workspace, aby obnova otvorila správne prostredie.
        if (!workspaceId.isNullOrEmpty() && workspaceId != previous) {
            RestoreCredentialStore.saveWorkspaceId(context, workspaceId)
        }
    }

    @JavascriptInterface
    fun getCurrentWorkspaceId(): String? = if (trusted()) TokenStore.getCurrentWorkspaceId(context) else null

    /** Na logout zmažeme všetko — JS zavolá clearAll() pri removeStoredToken(). */
    @JavascriptInterface
    fun clearAll() {
        if (!trusted()) return
        // Web volá clearAll() aj pri VYNÚTENOM odhlásení po expirácii 7-dňového
        // JWT (401 → prpl:force-logout). Vtedy Block Store token NECHÁVAME —
        // je to jediná cesta, ako sa pri ďalšom štarte prihlásiť bez hesla
        // (zero-tap). Skutočný logout (platný JWT) token zruší aj na serveri.
        val jwt = TokenStore.getAuthToken(context)
        if (!JwtUtils.isExpired(jwt)) {
            RestoreSession.revokeAndClear(context)
        } else {
            android.util.Log.i("WebAppInterface", "clearAll: expirovaná session → Block Store ponechaný")
        }
        // Push predošlého používateľa nesmie chodiť ďalej (FcmDevice by na
        // serveri ostal priradený k odhlásenému účtu).
        FcmRegistrar.unregisterOnLogout(context, jwt, TokenStore.getLastSyncedFcmToken(context))
        TokenStore.clearAll(context)
    }

    /**
     * Uloženie súboru z web appky do priečinka Stiahnuté.
     *
     * Android WebView bez tohto nevie stiahnuť NIČ — blob: URL ani
     * `<a download>` nikam nevedú a klik je tichý no-op (do 1.0.5 bola
     * teda každá príloha na Androide nestiahnuteľná). Ekvivalent iOS
     * handleru 'fileDownload' v ContentView.swift.
     *
     * base64 sa posiela cez JS most, takže sa hodí na bežné prílohy;
     * veľké ZIP-y idú priamo cez DownloadListener v MainActivity
     * (streamované DownloadManagerom, bez záťaže pamäte WebView).
     *
     * Vráti "ok" / "error: …" — klient podľa toho zobrazí hlášku a vie
     * rozlíšiť starú verziu appky (metóda chýba → undefined).
     */
    @JavascriptInterface
    fun saveFile(base64: String?, fileName: String?, mimetype: String?): String {
        if (base64.isNullOrEmpty()) return "error: no data"
        val safeName = sanitizeFileName(fileName)
        return try {
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            val mime = if (mimetype.isNullOrBlank()) "application/octet-stream" else mimetype

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                // Android 10+ — scoped storage, žiadne permissions netreba
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                    put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return "error: insert failed"
                try {
                    resolver.openOutputStream(uri)?.use { it.write(bytes) }
                        ?: throw java.io.IOException("stream failed")
                    values.clear()
                    values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                } catch (e: Exception) {
                    // Inak by v Downloads ostal neviditeľný „pending“ záznam
                    try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                    throw e
                }
            } else if (androidx.core.content.ContextCompat.checkSelfPermission(
                    context, android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                // Android 7–9 s udeleným oprávnením — legacy verejný priečinok
                @Suppress("DEPRECATION")
                val dir = android.os.Environment.getExternalStoragePublicDirectory(
                    android.os.Environment.DIRECTORY_DOWNLOADS
                )
                if (!dir.exists()) dir.mkdirs()
                // Rovnomenný súbor neprepisujeme — „nazov (1).ext“
                uniqueFile(dir, safeName).outputStream().use { it.write(bytes) }
            } else {
                // Android 7–9 bez oprávnenia (appka ho za behu nežiada): súbor do
                // vlastného priečinka appky (bez permission) a ponúkneme ho cez
                // share sheet — predtým zápis vždy zlyhal (Permission denied).
                return shareFromAppStorage(bytes, safeName, mime)
            }
            webView.post {
                android.widget.Toast.makeText(context, "Uložené do Stiahnuté: $safeName", android.widget.Toast.LENGTH_LONG).show()
            }
            "ok"
        } catch (e: Exception) {
            android.util.Log.e("PrplCRM", "saveFile failed", e)
            "error: ${e.message}"
        }
    }

    private fun uniqueFile(dir: java.io.File, name: String): java.io.File {
        var candidate = java.io.File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (candidate.exists() && i < 1000) {
            candidate = java.io.File(dir, "$base ($i)$ext")
            i++
        }
        return candidate
    }

    /** Android 7–9 bez WRITE_EXTERNAL_STORAGE: app-specific priečinok + share sheet. */
    private fun shareFromAppStorage(bytes: ByteArray, name: String, mime: String): String {
        val dir = context.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS)
            ?: return "error: storage unavailable"
        if (!dir.exists()) dir.mkdirs()
        val file = uniqueFile(dir, name)
        file.outputStream().use { it.write(bytes) }
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context, "${BuildConfig.APPLICATION_ID}.fileprovider", file
        )
        webView.post {
            try {
                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(android.content.Intent.EXTRA_STREAM, uri)
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val chooser = android.content.Intent.createChooser(send, name)
                if (context !is android.app.Activity) chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(chooser)
            } catch (e: Exception) {
                android.util.Log.e("PrplCRM", "share fallback failed", e)
            }
        }
        return "ok"
    }

    /** Názov bez ciest a riadiacich znakov — nikdy nesmie uniknúť z Downloads. */
    private fun sanitizeFileName(name: String?): String {
        val cleaned = (name ?: "")
            .replace(Regex("[/\\\\]"), "-")
            .replace(Regex("[\\x00-\\x1f\\x7f]"), "")
            .trimStart('.')
            .trim()
            .take(120)
        return if (cleaned.isBlank()) "subor" else cleaned
    }

    /**
     * Otvorenie soft klávesnice pre input fokusnutý z JS. WebView otvorí
     * klávesnicu len pri fokuse z priameho gesta používateľa — po výbere
     * súboru v natívnom pickeri (galéria/kamera) už gesto nie je, takže
     * modal na pomenovanie prílohy síce input fokusne, ale klávesnica sa
     * neukáže. Web appka preto po prenesení fokusu zavolá tento bridge.
     * webView.post — JavascriptInterface metódy bežia mimo UI vlákna.
     */
    @JavascriptInterface
    fun showKeyboard() {
        webView.post {
            webView.requestFocus()
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE)
                as? android.view.inputmethod.InputMethodManager
            imm?.showSoftInput(webView, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
    }

    /**
     * Identifikácia prostredia pre web appku. React kód môže detect-núť
     * že beží v natívnom Kotlin wrapperi (vs. Chrome / TWA) a podľa toho
     * sa správať — napr. použiť natívny token bridge namiesto localStorage.
     *
     * User agent sniffing (/PrplCRM-Android/) funguje aj bez tohto, ale
     * tento bridge je spoľahlivejší (UA môže byť overridnutý).
     */
    @JavascriptInterface
    fun isNativeApp(): Boolean = true

    @JavascriptInterface
    fun getPlatform(): String = "android"

    @JavascriptInterface
    fun getAppVersion(): String = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

    /**
     * Force FCM registration — pre diagnostiku. Web appka môže zavolať aby si
     * vynútila re-register FCM tokenu na backend (bez waiting for onResume).
     * Vracia stav: "ok-fired" ak sa register POST spustil, "no-auth" ak user
     * nie je prihlásený, "no-token" ak Firebase ešte nemá token.
     */
    /**
     * Posledný stav FCM registrácie — čo sa stalo pri poslednom POST-e.
     * Hodnoty: "OK HTTP 200 · ...", "HTTP 401 · ...", "IOException: ...",
     * "skip: no auth token", "POST in flight → ..." ap.
     */
    @JavascriptInterface
    fun getLastFcmStatus(): String? = TokenStore.getLastFcmStatus(context)

    @JavascriptInterface
    fun forceFcmRegister(): String {
        val authToken = TokenStore.getAuthToken(context)
        if (authToken.isNullOrEmpty()) return "no-auth"
        try {
            val task = com.google.firebase.messaging.FirebaseMessaging.getInstance().token
            task.addOnCompleteListener { t ->
                if (t.isSuccessful) {
                    t.result?.let { FcmRegistrar.forceReregister(context, it) }
                }
            }
            return "ok-fired"
        } catch (e: Exception) {
            return "error: ${e.message}"
        }
    }
}
