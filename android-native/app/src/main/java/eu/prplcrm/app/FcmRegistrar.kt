package eu.prplcrm.app

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Registruje FCM token na backend (`POST /api/push/fcm/register`).
 *
 * Backend si uloží mapping `{ userId, fcmToken, platform: "android", appVersion }`
 * a pri posielaní notifikácie pre daného usera použije Admin SDK na publish do FCM.
 *
 * Registrácia je idempotentná — backend rozoznáva existujúci token pre rovnakého
 * usera a aktualizuje `lastSeenAt`. My si posledný odoslaný token cachujeme v
 * TokenStore, aby sme neopakovali request pri každom štarte appky.
 *
 * Prečo OkHttp a nie Retrofit/Ktor: appka má jediný endpoint — nepotrebujeme full
 * HTTP klient. OkHttp máme aj tak vo Firebase deps, takže žiadna extra závislosť.
 */
object FcmRegistrar {

    private const val TAG = "FcmRegistrar"

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    /**
     * Pokúsi sa zaregistrovať FCM token. Skip-uje ak:
     *   - User nie je prihlásený (auth token je null) → retry po najbližšom login
     *   - FCM token je rovnaký ako posledný úspešne zaregistrovaný → nič nemení
     *
     * Volanie je safe z ľubovoľného threadu — OkHttp enqueue beží v pool threade.
     */
    fun registerIfNeeded(context: Context, fcmToken: String) {
        val authToken = TokenStore.getAuthToken(context)
        if (authToken.isNullOrEmpty()) {
            Log.d(TAG, "Skip: user not logged in yet, will register after login")
            return
        }
        val lastSynced = TokenStore.getLastSyncedFcmToken(context)
        if (lastSynced == fcmToken) {
            Log.d(TAG, "Skip: FCM token unchanged since last sync")
            return
        }
        register(context, authToken, fcmToken)
    }

    private fun register(context: Context, authToken: String, fcmToken: String) {
        val url = context.getString(R.string.webapp_url)
            .removeSuffix("/")
            .substringBefore("/app") + "/api/push/fcm/register"

        val body = JSONObject().apply {
            put("fcmToken", fcmToken)
            put("platform", "android")
            put("appVersion", BuildConfig.VERSION_NAME)
            put("packageName", BuildConfig.APPLICATION_ID)
        }.toString().toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url(url)
            .post(body)
            .addHeader("Authorization", "Bearer $authToken")
            .addHeader("Content-Type", "application/json")
            .build()

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                Log.w(TAG, "FCM registration failed (will retry on next app resume)", e)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use {
                    if (it.isSuccessful) {
                        TokenStore.setLastSyncedFcmToken(context, fcmToken)
                        Log.i(TAG, "FCM token registered successfully")
                    } else {
                        Log.w(TAG, "FCM registration HTTP ${it.code}: ${it.body?.string()?.take(200)}")
                    }
                }
            }
        })
    }

    /**
     * Force re-registration — použije sa napr. po logout-login flow keď si chceme
     * byť istí že backend má najnovšie mapping (iný user sa prihlásil na rovnaké
     * zariadenie). Zmaže cached "last synced" a pokúsi sa znova.
     */
    fun forceReregister(context: Context, fcmToken: String) {
        TokenStore.setLastSyncedFcmToken(context, null)
        registerIfNeeded(context, fcmToken)
    }
}
