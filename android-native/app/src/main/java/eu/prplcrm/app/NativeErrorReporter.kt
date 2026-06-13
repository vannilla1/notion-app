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
 * Reporter natívnych Android chýb → POST {api_base_url}/api/errors/client
 * (rovnaký endpoint ako web reportError + iOS NativeErrorReporter).
 *
 * Doteraz Android nemal ŽIADNU natívnu telemetriu — WebView load/HTTP chyby a
 * render-process crashe išli len do logcatu (neviditeľné v admin Diagnostike).
 *
 * ⚠️ POST ide na api_base_url (perun-crm-api.onrender.com), NIE na prplcrm.eu —
 * to je len static frontend, ktorý by na neexistujúcu route vrátil index.html
 * (HTTP 200) a report by nikdy nedorazil na backend. (Rovnaký pozor ako
 * FcmRegistrar.)
 *
 * Best-effort, fire-and-forget (OkHttp enqueue v pool threade). Throttled
 * per-name (1×/min) — render-crash / load-error loop by inak spamoval backend.
 */
object NativeErrorReporter {

    private const val TAG = "NativeErrorReporter"
    private const val THROTTLE_MS = 60_000L

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    // Per-name throttle proti spamu pri error/crash loope.
    private val lastSent = HashMap<String, Long>()

    @Synchronized
    private fun shouldSend(name: String): Boolean {
        val now = System.currentTimeMillis()
        val last = lastSent[name]
        if (last != null && now - last < THROTTLE_MS) return false
        if (lastSent.size > 200) lastSent.clear()
        lastSent[name] = now
        return true
    }

    fun report(
        context: Context,
        name: String,
        message: String,
        url: String = "https://prplcrm.eu/native-android"
    ) {
        try {
            if (!shouldSend(name)) return
            val base = context.getString(R.string.api_base_url).removeSuffix("/")
            val endpoint = "$base/api/errors/client"

            val payload = JSONObject().apply {
                put("name", name)
                put("message", message.take(1000))
                put("url", url)
                put("userAgent", "PrplCRM-Android/native")
                put("release", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            }.toString().toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url(endpoint)
                .post(payload)
                .addHeader("Content-Type", "application/json")
                .build()

            client.newCall(request).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    Log.w(TAG, "report failed: ${e.message}")
                }
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    response.close()
                }
            })
        } catch (e: Exception) {
            // Reporter sa nesmie nikdy sám rozbiť.
            Log.w(TAG, "report exception: ${e.message}")
        }
    }
}
