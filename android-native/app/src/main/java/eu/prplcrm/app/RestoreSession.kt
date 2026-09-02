package eu.prplcrm.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Orchestrácia obnovy prihlásenia (Google Play zero-tap sign-in):
 *
 *   login  → issueAfterLogin(): POST /api/auth/restore-token → Block Store
 *   start  → tryRestore(): Block Store → POST /api/auth/restore → TokenStore
 *   logout → revokeAndClear(): DELETE /api/auth/restore-token + Block Store clear
 *
 * Vzor HTTP volania = FcmRegistrar (OkHttp, api_base_url). Plaintext tokenu
 * sa nikdy neloguje. Všetky callbacky sa vracajú na main thread.
 * Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
object RestoreSession {

    private const val TAG = "RestoreSession"
    private val JSON = "application/json".toMediaType()
    private val mainHandler = Handler(Looper.getMainLooper())

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS)
            .writeTimeout(3, TimeUnit.SECONDS)
            .build()
    }

    private fun apiUrl(context: Context, path: String): String =
        context.getString(R.string.api_base_url).removeSuffix("/") + path

    private fun jsonBody(vararg pairs: Pair<String, String>) =
        JSONObject().apply { pairs.forEach { (k, v) -> put(k, v) } }.toString().toRequestBody(JSON)

    /** Po každom novom logine: vydaj obnovovací token a ulož ho do Block Store. */
    fun issueAfterLogin(context: Context, jwt: String) {
        val app = context.applicationContext
        val label = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120)
        val request = Request.Builder()
            .url(apiUrl(app, "/api/auth/restore-token"))
            .post(jsonBody("deviceLabel" to label))
            .addHeader("Authorization", "Bearer $jwt")
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "issue failed: ${e.javaClass.simpleName}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string() ?: ""
                    if (!it.isSuccessful) { Log.w(TAG, "issue HTTP ${it.code}"); return }
                    val token = try { JSONObject(text).optString("restoreToken") } catch (e: Exception) { "" }
                    if (token.isBlank()) { Log.w(TAG, "issue: empty token"); return }
                    mainHandler.post {
                        RestoreCredentialStore.save(app, token, TokenStore.getCurrentWorkspaceId(app))
                    }
                }
            }
        })
    }

    /**
     * Pokus o obnovu pri cold starte. `onDone(true)` = TokenStore má nový JWT.
     * Volá sa presne raz (aj pri timeoute) na main threade. Ak server odpovie
     * až po timeoute, ale úspešne, JWT sa uloží a zavolá sa `onLateSuccess`.
     */
    fun tryRestore(
        context: Context,
        timeoutMs: Long = 3000,
        onLateSuccess: (() -> Unit)? = null,
        onDone: (Boolean) -> Unit
    ) {
        val app = context.applicationContext
        val finished = AtomicBoolean(false)
        fun finish(ok: Boolean) {
            if (finished.compareAndSet(false, true)) mainHandler.post { onDone(ok) }
            else if (ok) mainHandler.post { onLateSuccess?.invoke() }
        }
        mainHandler.postDelayed({
            if (!finished.get()) Log.i(TAG, "restore timeout")
            finish(false)
        }, timeoutMs)

        RestoreCredentialStore.load(app) { snapshot ->
            val restoreToken = snapshot?.restoreToken
            if (restoreToken.isNullOrBlank()) { finish(false); return@load }

            val request = Request.Builder()
                .url(apiUrl(app, "/api/auth/restore"))
                .post(jsonBody("restoreToken" to restoreToken))
                .build()
            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    Log.w(TAG, "restore failed: ${e.javaClass.simpleName}")
                    finish(false)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val text = it.body?.string() ?: ""
                        if (it.code == 401) {
                            Log.i(TAG, "restore token rejected → clearing Block Store")
                            mainHandler.post { RestoreCredentialStore.clear(app) }
                            finish(false)
                            return
                        }
                        if (!it.isSuccessful) { Log.w(TAG, "restore HTTP ${it.code}"); finish(false); return }
                        val json = try { JSONObject(text) } catch (e: Exception) { finish(false); return }
                        val jwt = json.optString("token")
                        val rotated = json.optString("restoreToken")
                        if (jwt.isBlank()) { finish(false); return }

                        TokenStore.setAuthToken(app, jwt)
                        snapshot.workspaceId?.let { ws -> TokenStore.setCurrentWorkspaceId(app, ws) }
                        if (rotated.isNotBlank()) {
                            mainHandler.post { RestoreCredentialStore.save(app, rotated, snapshot.workspaceId) }
                        }
                        Log.i(TAG, "restore OK")
                        finish(true)
                    }
                }
            })
        }
    }

    /** Logout: zruš token na serveri (best-effort) a zmaž Block Store. */
    fun revokeAndClear(context: Context) {
        val app = context.applicationContext
        RestoreCredentialStore.load(app) { snapshot ->
            val token = snapshot?.restoreToken
            if (!token.isNullOrBlank()) {
                val request = Request.Builder()
                    .url(apiUrl(app, "/api/auth/restore-token"))
                    .delete(jsonBody("restoreToken" to token))
                    .build()
                client.newCall(request).enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        Log.w(TAG, "revoke failed: ${e.javaClass.simpleName}")
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use { Log.i(TAG, "revoke HTTP ${it.code}") }
                    }
                })
            }
            RestoreCredentialStore.clear(app)
        }
    }
}
