package eu.prplcrm.app

import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JwtUtilsTest {

    private fun jwt(payloadJson: String): String {
        val header = """{"alg":"HS256","typ":"JWT"}""".encodeUtf8().base64Url().trimEnd('=')
        val payload = payloadJson.encodeUtf8().base64Url().trimEnd('=')
        return "$header.$payload.podpis"
    }

    private val now = 1_800_000_000L

    @Test
    fun `expiresAtSeconds precita exp`() {
        assertEquals(1_800_000_600L, JwtUtils.expiresAtSeconds(jwt("""{"id":"abc","exp":1800000600,"iat":1}""")))
    }

    @Test
    fun `platny token nie je expirovany`() {
        assertFalse(JwtUtils.isExpired(jwt("""{"exp":${now + 3600}}"""), nowSeconds = now))
    }

    @Test
    fun `token po exp je expirovany`() {
        assertTrue(JwtUtils.isExpired(jwt("""{"exp":${now - 1}}"""), nowSeconds = now))
    }

    @Test
    fun `token tesne pred exp (v ramci skew) je expirovany`() {
        assertTrue(JwtUtils.isExpired(jwt("""{"exp":${now + 30}}"""), nowSeconds = now, skewSeconds = 60))
    }

    @Test
    fun `null, prazdny, poskodeny a bez exp = expirovany`() {
        assertTrue(JwtUtils.isExpired(null, nowSeconds = now))
        assertTrue(JwtUtils.isExpired("", nowSeconds = now))
        assertTrue(JwtUtils.isExpired("nie.je.jwt", nowSeconds = now))
        assertTrue(JwtUtils.isExpired("abc", nowSeconds = now))
        assertTrue(JwtUtils.isExpired(jwt("""{"id":"abc"}"""), nowSeconds = now))
        assertNull(JwtUtils.expiresAtSeconds("nie.je.jwt"))
    }
}
