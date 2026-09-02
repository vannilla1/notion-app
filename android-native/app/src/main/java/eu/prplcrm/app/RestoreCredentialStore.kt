package eu.prplcrm.app

import android.content.Context
import android.util.Log
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData

/**
 * Block Store (Google Play services) — úložisko, ktoré prežije reinštaláciu
 * aj prenos na nový telefón (device-to-device / cloud restore).
 *
 * Ukladáme LEN obnovovací token (nie JWT) a workspace id. Do cloudu sa
 * zálohuje iba pri dostupnom end-to-end šifrovaní (podmienka Google:
 * Android 9+ a nastavený zámok obrazovky); inak ostáva lokálne/D2D.
 * POZOR: podľa dokumentácie zápis bez setShouldBackupToCloud(true) zmaže
 * predchádzajúcu cloud zálohu — preto flag nastavujeme konzistentne pri
 * každom zápise podľa aktuálnej dostupnosti E2EE.
 *
 * Každé volanie je best-effort: bez Google Play services (Huawei) len
 * zaloguje a nikdy nepadá. Callbacky Tasks API bežia na main threade.
 *
 * Google Play požiadavka „zero-tap sign-in" — dizajn:
 * docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
object RestoreCredentialStore {

    private const val TAG = "RestoreCredentialStore"
    const val KEY_RESTORE_TOKEN = "eu.prplcrm.app.restore_token"
    const val KEY_WORKSPACE_ID = "eu.prplcrm.app.workspace_id"

    data class Snapshot(val restoreToken: String?, val workspaceId: String?)

    private fun client(context: Context): BlockstoreClient =
        Blockstore.getClient(context.applicationContext)

    /** Uloží token + (voliteľne) workspace id. */
    fun save(context: Context, restoreToken: String, workspaceId: String?) {
        withE2ee(context) { e2ee ->
            store(context, KEY_RESTORE_TOKEN, restoreToken, e2ee)
            if (!workspaceId.isNullOrBlank()) store(context, KEY_WORKSPACE_ID, workspaceId, e2ee)
        }
    }

    /** Aktualizuje len workspace id (pri prepnutí prostredia). */
    fun saveWorkspaceId(context: Context, workspaceId: String) {
        withE2ee(context) { e2ee -> store(context, KEY_WORKSPACE_ID, workspaceId, e2ee) }
    }

    /** Prečíta oba kľúče; chýbajúci kľúč = null. Pri chybe GMS vráti null. */
    fun load(context: Context, onResult: (Snapshot?) -> Unit) {
        try {
            val request = RetrieveBytesRequest.Builder()
                .setKeys(listOf(KEY_RESTORE_TOKEN, KEY_WORKSPACE_ID))
                .build()
            client(context).retrieveBytes(request)
                .addOnSuccessListener { result ->
                    val map = result.blockstoreDataMap
                    val token = map[KEY_RESTORE_TOKEN]?.bytes?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                    val ws = map[KEY_WORKSPACE_ID]?.bytes?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                    Log.i(TAG, "load: token=${token != null} workspace=${ws != null}")
                    onResult(Snapshot(token, ws))
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "retrieveBytes failed (GMS?)", e)
                    onResult(null)
                }
        } catch (e: Exception) {
            Log.w(TAG, "retrieveBytes threw", e)
            onResult(null)
        }
    }

    /** Zmaže naše kľúče (logout / zrušený token). */
    fun clear(context: Context) {
        try {
            val request = DeleteBytesRequest.Builder()
                .setKeys(listOf(KEY_RESTORE_TOKEN, KEY_WORKSPACE_ID))
                .build()
            client(context).deleteBytes(request)
                .addOnSuccessListener { Log.i(TAG, "cleared") }
                .addOnFailureListener { e -> Log.w(TAG, "deleteBytes failed", e) }
        } catch (e: Exception) {
            Log.w(TAG, "deleteBytes threw", e)
        }
    }

    private fun withE2ee(context: Context, block: (Boolean) -> Unit) {
        try {
            client(context).isEndToEndEncryptionAvailable()
                .addOnSuccessListener { available -> block(available) }
                .addOnFailureListener { e ->
                    Log.w(TAG, "E2EE check failed → local only", e)
                    block(false)
                }
        } catch (e: Exception) {
            Log.w(TAG, "E2EE check threw → local only", e)
            block(false)
        }
    }

    private fun store(context: Context, key: String, value: String, cloud: Boolean) {
        try {
            val data = StoreBytesData.Builder()
                .setBytes(value.toByteArray(Charsets.UTF_8))
                .setKey(key)
                .setShouldBackupToCloud(cloud)
                .build()
            client(context).storeBytes(data)
                .addOnSuccessListener { n -> Log.i(TAG, "stored $key ($n B, cloud=$cloud)") }
                .addOnFailureListener { e -> Log.w(TAG, "storeBytes $key failed", e) }
        } catch (e: Exception) {
            Log.w(TAG, "storeBytes $key threw", e)
        }
    }
}
