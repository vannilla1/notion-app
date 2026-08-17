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

    /** Web appka po úspešnom login/register zavolá túto metódu s JWT tokenom. */
    @JavascriptInterface
    fun setAuthToken(token: String?) {
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
        }
    }

    @JavascriptInterface
    fun getAuthToken(): String? = TokenStore.getAuthToken(context)

    /** Per-device workspace context — synchronizuje sa s X-Workspace-Id hlavičkou. */
    @JavascriptInterface
    fun setCurrentWorkspaceId(workspaceId: String?) {
        TokenStore.setCurrentWorkspaceId(context, workspaceId)
    }

    @JavascriptInterface
    fun getCurrentWorkspaceId(): String? = TokenStore.getCurrentWorkspaceId(context)

    /** Na logout zmažeme všetko — JS zavolá clearAll() pri removeStoredToken(). */
    @JavascriptInterface
    fun clearAll() {
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
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return "error: stream failed"
                values.clear()
                values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                // Android 7–9 — legacy verejný priečinok (permission v manifeste
                // s maxSdkVersion=28)
                @Suppress("DEPRECATION")
                val dir = android.os.Environment.getExternalStoragePublicDirectory(
                    android.os.Environment.DIRECTORY_DOWNLOADS
                )
                if (!dir.exists()) dir.mkdirs()
                java.io.File(dir, safeName).outputStream().use { it.write(bytes) }
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
