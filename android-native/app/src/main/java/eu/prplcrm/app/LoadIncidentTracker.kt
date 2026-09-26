package eu.prplcrm.app

/**
 * Výpadok načítania hlavnej stránky — od prvého zlyhania po úspešné načítanie.
 *
 * Prečo: statický web (prplcrm.eu, CDN hostingu Render) občas na pár sekúnd
 * vráti 502/503/504. Appka to rieši sama ([LoadErrorOverlay] + automatické
 * opakovanie), ale 1.0.9 a 1.0.10 každé zlyhanie zároveň hneď hlásili do
 * Diagnostiky — krátky výpadok tak znovu otvoril chybu „status=504 url=/app"
 * (Diagnostika 25. 9. 2026, verzia 1.0.10).
 *
 * Hlásime preto len výpadok, ktorý appka nevyriešila ani [reportAfterMs] od
 * prvého zlyhania SO SIEŤOU. Čas bez internetu v telefóne sa nepočíta — nie je
 * to chyba nášho webu, a prvý pokus po návrate siete často zlyhá len preto, že
 * sa sieť ešte len nadväzuje. Jeden výpadok = najviac jedno hlásenie.
 *
 * Hodiny: SystemClock.uptimeMillis (rovnaké ako Handler.postDelayed) — hlboký
 * spánok telefónu sa do trvania výpadku nepočíta, appka vtedy aj tak neskúša.
 *
 * Čistá logika bez Android API (hodiny sa podávajú zvonka) → unit testy.
 */
class LoadIncidentTracker(
    private val now: () -> Long,
    val reportAfterMs: Long = DEFAULT_REPORT_AFTER_MS
) {
    data class Failure(val message: String, val url: String)

    data class Report(
        /** Prvé zlyhanie so sieťou — charakterizuje výpadok (stabilný text = jedna skupina v Diagnostike). */
        val failure: Failure,
        val attempts: Int,
        val offlineAttempts: Int,
        /** Od prvého zlyhania so sieťou. */
        val durationMs: Long,
        /** Stránka sa v tomto spustení appky už predtým načítala (false = studený štart). */
        val loadedBefore: Boolean
    )

    private var open = false
    private var onlineSince = NOT_STARTED
    private var firstOnline: Failure? = null
    private var attempts = 0
    private var offlineAttempts = 0
    private var reported = false
    private var loadedBefore = false
    private var everLoaded = false

    val isOpen: Boolean get() = open

    /**
     * Zlyhanie načítania. Vráti true, keď týmto začalo meranie výpadku (prvé
     * zlyhanie so sieťou) — volajúci naplánuje kontrolu o [msUntilDue].
     */
    fun onFailure(failure: Failure, online: Boolean): Boolean {
        if (!open) {
            open = true
            onlineSince = NOT_STARTED
            firstOnline = null
            attempts = 0
            offlineAttempts = 0
            reported = false
            loadedBefore = everLoaded
        }
        attempts++
        if (!online) {
            offlineAttempts++
            return false
        }
        if (firstOnline != null) return false
        firstOnline = failure
        onlineSince = now()
        return true
    }

    /** Stránka sa načítala. Vráti trvanie práve skončeného výpadku v ms (od prvého zlyhania so sieťou; 0 ak také nebolo), alebo null. */
    fun onSuccess(): Long? {
        everLoaded = true
        if (!open) return null
        val duration = if (onlineSince == NOT_STARTED) 0 else now() - onlineSince
        open = false
        onlineSince = NOT_STARTED
        firstOnline = null
        return duration
    }

    /** Koľko ms zostáva do termínu hlásenia (0 = už teraz); null, ak nie je čo hlásiť. */
    fun msUntilDue(): Long? {
        if (!open || reported || onlineSince == NOT_STARTED) return null
        return (onlineSince + reportAfterMs - now()).coerceAtLeast(0)
    }

    /**
     * Hlásenie, ak výpadok trvá aspoň [reportAfterMs] od prvého zlyhania so
     * sieťou a ešte nebol nahlásený. Po vrátení hlásenia je výpadok označený ako
     * nahlásený — ďalšie volania vrátia null až do nového výpadku.
     */
    fun takeDueReport(): Report? {
        if (!open || reported) return null
        val failure = firstOnline ?: return null
        val duration = now() - onlineSince
        if (duration < reportAfterMs) return null
        reported = true
        return Report(failure, attempts, offlineAttempts, duration, loadedBefore)
    }

    companion object {
        const val DEFAULT_REPORT_AFTER_MS = 60_000L
        private const val NOT_STARTED = -1L
    }
}
