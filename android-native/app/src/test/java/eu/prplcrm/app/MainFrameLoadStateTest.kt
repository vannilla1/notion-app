package eu.prplcrm.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Poradie callbackov podľa Chromium WebView (viď dokumentácia MainFrameLoadState). */
class MainFrameLoadStateTest {

    private val state = MainFrameLoadState()

    @Test
    fun `uspesne nacitanie`() {
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `http 5xx - chyba pride pred onPageStarted a nesmie vyzerat ako uspech`() {
        state.onHttpFailure()
        state.onPageStarted()
        assertFalse(state.onPageFinished())
    }

    @Test
    fun `http 5xx a potom uspesny reload`() {
        state.onHttpFailure()
        state.onPageStarted()
        assertFalse(state.onPageFinished())
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `opakovane 5xx po sebe`() {
        repeat(3) {
            state.onHttpFailure()
            state.onPageStarted()
            assertFalse(state.onPageFinished())
        }
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `sietova chyba`() {
        state.onPageStarted()
        state.onNetworkFailure()
        assertFalse(state.onPageFinished())
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `sietova chyba po 5xx a potom uspech`() {
        state.onHttpFailure()
        state.onPageStarted()
        assertFalse(state.onPageFinished())
        state.onPageStarted()
        state.onNetworkFailure()
        assertFalse(state.onPageFinished())
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `synteticke onPageFinished pri duplicitnej navigacii pred commitom 5xx nie je uspech`() {
        state.onHttpFailure()
        assertFalse(state.onPageFinished()) // ignorovaná duplicita
        state.onPageStarted()
        assertFalse(state.onPageFinished())
    }

    @Test
    fun `ERR_ABORTED bez onPageStarted nie je uspech`() {
        state.onHttpFailure()
        state.onPageStarted()
        assertFalse(state.onPageFinished())
        assertFalse(state.onPageFinished()) // prerušená navigácia
    }

    @Test
    fun `onPageFinished predoslej chybovej stranky medzi 5xx a jej commitom nie je uspech`() {
        // Reload počas načítavania chybovej stránky (WebView bez RenderDocument):
        // prerušená predošlá stránka dostane onPageFinished až po 5xx novej navigácie.
        state.onHttpFailure()
        state.onPageStarted()
        state.onHttpFailure()
        assertFalse(state.onPageFinished()) // predošlá stránka
        state.onPageStarted()
        assertFalse(state.onPageFinished()) // commit novej 5xx
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `5xx zrusena pred commitom - dalsia navigacia uspeje najneskor na druhy pokus`() {
        state.onHttpFailure()
        assertFalse(state.onPageFinished()) // zrušená, bez commitu
        state.onPageStarted()
        assertFalse(state.onPageFinished()) // o pokus dlhšie (prekrytie naplánuje ďalší)
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }

    @Test
    fun `reset po novom WebView`() {
        state.onHttpFailure()
        state.reset()
        state.onPageStarted()
        assertTrue(state.onPageFinished())
    }
}
