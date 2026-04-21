package eu.prplcrm.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Hardware-backed token storage.
 *
 * EncryptedSharedPreferences šifruje obsah AES-256-GCM kľúčom, ktorý leží
 * v Android Keystore (TEE / StrongBox). Equivalent iOS Keychain.
 *
 * Použitie:
 *   - JS (web appka) token bridge: WebAppInterface zapisuje/číta tu.
 *   - FCM registration: FCM token sa tu cachuje, aby sme nevolali /api/push/fcm/register
 *     pri každom štarte appky (len ked sa zmení).
 */
object TokenStore {

    private const val PREFS_NAME = "prpl_secure_prefs"
    private const val KEY_AUTH_TOKEN = "auth_token"
    private const val KEY_CURRENT_WORKSPACE = "current_workspace_id"
    private const val KEY_FCM_TOKEN = "fcm_token_last_synced"
    private const val KEY_FCM_LAST_STATUS = "fcm_last_status"

    private fun prefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        return EncryptedSharedPreferences.create(
            context.applicationContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getAuthToken(context: Context): String? =
        prefs(context).getString(KEY_AUTH_TOKEN, null)

    fun setAuthToken(context: Context, token: String?) {
        prefs(context).edit().apply {
            if (token.isNullOrEmpty()) remove(KEY_AUTH_TOKEN) else putString(KEY_AUTH_TOKEN, token)
        }.apply()
    }

    fun getCurrentWorkspaceId(context: Context): String? =
        prefs(context).getString(KEY_CURRENT_WORKSPACE, null)

    fun setCurrentWorkspaceId(context: Context, workspaceId: String?) {
        prefs(context).edit().apply {
            if (workspaceId.isNullOrEmpty()) remove(KEY_CURRENT_WORKSPACE)
            else putString(KEY_CURRENT_WORKSPACE, workspaceId)
        }.apply()
    }

    /** Posledný FCM token, ktorý sme úspešne zaregistrovali na backend. */
    fun getLastSyncedFcmToken(context: Context): String? =
        prefs(context).getString(KEY_FCM_TOKEN, null)

    fun setLastSyncedFcmToken(context: Context, token: String?) {
        prefs(context).edit().apply {
            if (token.isNullOrEmpty()) remove(KEY_FCM_TOKEN) else putString(KEY_FCM_TOKEN, token)
        }.apply()
    }

    /** Posledný stav FCM register POST — pre diagnostiku (úspech / chyba / HTTP kód). */
    fun getLastFcmStatus(context: Context): String? =
        prefs(context).getString(KEY_FCM_LAST_STATUS, null)

    fun setLastFcmStatus(context: Context, status: String?) {
        prefs(context).edit().apply {
            if (status.isNullOrEmpty()) remove(KEY_FCM_LAST_STATUS)
            else putString(KEY_FCM_LAST_STATUS, status)
        }.apply()
    }

    fun clearAll(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
