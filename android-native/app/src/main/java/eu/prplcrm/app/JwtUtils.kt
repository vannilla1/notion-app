package eu.prplcrm.app

import okio.ByteString.Companion.decodeBase64

/**
 * Lokálne (bez overenia podpisu) čítanie `exp` z JWT.
 *
 * Slúži LEN na rozhodnutie pri cold starte, či má zmysel uložený token
 * injectnúť do webu, alebo rovno skúsiť obnovu z Block Store. Server token
 * vždy overuje sám — toto nie je bezpečnostné rozhodnutie. Čistý Kotlin
 * (okio + regex, bez android.* tried), aby bol testovateľný v JVM unit testoch.
 */
object JwtUtils {

    private val EXP_REGEX = Regex("\"exp\"\\s*:\\s*(\\d+)")

    /** Sekundy od epochy z claimu `exp`, alebo null ak sa nedá prečítať. */
    fun expiresAtSeconds(jwt: String?): Long? {
        if (jwt.isNullOrBlank()) return null
        val parts = jwt.split('.')
        if (parts.size < 2) return null
        val payload = parts[1].decodeBase64()?.utf8() ?: return null
        return EXP_REGEX.find(payload)?.groupValues?.get(1)?.toLongOrNull()
    }

    /** true = expirovaný, poškodený alebo chýbajúci token (vždy radšej obnova). */
    fun isExpired(
        jwt: String?,
        nowSeconds: Long = System.currentTimeMillis() / 1000,
        skewSeconds: Long = 60
    ): Boolean {
        val exp = expiresAtSeconds(jwt) ?: return true
        return exp - skewSeconds <= nowSeconds
    }
}
