package eu.prplcrm.app

/**
 * Stav navigácie hlavného rámca z callbackov WebViewClient — rozhoduje, kedy
 * načítanie naozaj prešlo (skryť prekrytie chyby, ukončiť výpadok).
 *
 * Poradie callbackov v dnešnom Chromium WebView (overené v zdrojákoch Chromia —
 * AwWebContentsObserver, AwContentsClientBridge, AwComputedFlags — 26. 9. 2026):
 * onPageStarted sa posiela až pri COMMITE navigácie (pageStartedOnCommitEnabled
 * je true pre každú appku okrem GMS), takže:
 *  - HTTP 5xx:       onReceivedHttpError → onPageStarted → onPageFinished
 *  - sieťová chyba:  onPageStarted → onReceivedError → onPageFinished
 *  - ERR_ABORTED a ignorovaná duplicitná navigácia (napr. reload počas reloadu):
 *    samotné onPageFinished bez onPageStarted — pri duplicite ešte PRED
 *    onPageStarted pôvodnej navigácie
 *
 * 1.0.9 a 1.0.10 nulovali príznak chyby v onPageStarted. Pri 5xx tak prišlo
 * onPageStarted až po chybe, onPageFinished potom vyzeralo ako úspech a prekrytie
 * „Nepodarilo sa pripojiť" sa hneď po zobrazení skrylo — používateľ ostal na
 * surovej chybovej stránke Cloudflare bez opakovania.
 *
 * Čistá logika bez Android API → unit testy s presným poradím z Chromia.
 */
class MainFrameLoadState {
    private var failed = false
    // 5xx prišla, ale jej commit (onPageStarted) ešte nie.
    private var httpFailurePending = false
    // Od posledného onPageStarted ešte neprišlo onPageFinished.
    private var committed = false

    fun onHttpFailure() {
        failed = true
        httpFailurePending = true
    }

    fun onNetworkFailure() {
        failed = true
    }

    fun onPageStarted() {
        if (httpFailurePending) {
            httpFailurePending = false // commit práve tej odpovede 5xx — ostáva zlyhaním
        } else {
            failed = false // nová navigácia
        }
        committed = true
    }

    /**
     * @return true = hlavný rámec sa naozaj načítal bez chyby.
     *
     * Čakajúcu 5xx (httpFailurePending) tu NEmažeme: onPageFinished predošlej
     * stránky (prerušené načítanie pri commite ďalšej navigácie na WebView bez
     * RenderDocument, syntetické pri duplicitnej navigácii) môže prísť medzi
     * onReceivedHttpError a onPageStarted tej istej 5xx navigácie. Keby ju
     * zmazalo, commit 5xx by vyzeral ako úspech a prekrytie by sa skrylo nad
     * chybovou stránkou. Opačný zriedkavý prípad (5xx zrušená pred commitom,
     * ďalšia navigácia uspeje) len nechá prekrytie o jeden pokus dlhšie —
     * LoadErrorOverlay.attemptEnded naplánuje ďalší pokus, ktorý ho skryje.
     */
    fun onPageFinished(): Boolean {
        if (!committed) return false // syntetické: ERR_ABORTED / duplicitná navigácia
        committed = false
        return !failed
    }

    /** Nový WebView (po páde render procesu) — zabudni stav starého. */
    fun reset() {
        failed = false
        httpFailurePending = false
        committed = false
    }
}
