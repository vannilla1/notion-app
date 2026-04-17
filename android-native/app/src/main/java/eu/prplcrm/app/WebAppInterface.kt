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
        TokenStore.setAuthToken(context, token)
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
    fun getAppVersion(): String = BuildConfig.VERSION_NAME
}
