package eu.prplcrm.app

import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Natívne prekrytie pri zlyhaní načítania HLAVNEJ stránky (bez siete, DNS,
 * timeout, server 5xx vrátane Cloudflare 502/503/504).
 *
 * Prečo: do 1.0.8 appka takúto chybu len nahlásila do Diagnostiky
 * (AndroidWebViewHttpError status=504) a používateľovi nechala surovú chybovú
 * stránku Cloudflare / Chromu bez možnosti skúsiť znova — jediná cesta von bolo
 * zabiť appku. iOS má na to ErrorView, Android nemal nič.
 *
 * Správanie: zobrazí značkovú obrazovku s tlačidlom „Skúsiť znova", automaticky
 * opakuje s rastúcim odstupom (3, 5, 10, 20, 30 s…) a MainActivity ju navyše
 * spustí hneď pri návrate siete alebo pri návrate appky na popredie. Po
 * úspešnom načítaní sa skryje a počítadlo sa vynuluje.
 */
class LoadErrorOverlay(
    root: FrameLayout,
    private val onRetry: () -> Unit
) {
    private val view: View = LayoutInflater.from(root.context).inflate(R.layout.view_load_error, root, false)
    private val message: TextView = view.findViewById(R.id.load_error_message)
    private val countdown: TextView = view.findViewById(R.id.load_error_countdown)
    private val handler = Handler(Looper.getMainLooper())
    private var attempt = 0
    private var secondsLeft = 0
    private var tick: Runnable? = null
    // Pokus práve beží (WebView načítava) — automatické spúšťače (návrat siete,
    // onResume, odpočet) ho neduplikujú; tlačidlo ho vynúti vždy.
    private var retryInFlight = false

    val isShowing: Boolean get() = view.visibility == View.VISIBLE

    init {
        view.visibility = View.GONE
        root.addView(view)
        view.findViewById<Button>(R.id.load_error_retry).setOnClickListener { retryNow(force = true) }
    }

    /** Zobrazí prekrytie (alebo len aktualizuje text) a naplánuje ďalší pokus. */
    fun show(offline: Boolean) {
        retryInFlight = false // pokus skončil chybou
        message.setText(if (offline) R.string.load_error_message_offline else R.string.load_error_message_server)
        if (!isShowing) {
            view.visibility = View.VISIBLE
            view.bringToFront()
        }
        scheduleRetry()
    }

    /** Úspešné načítanie → skry a vynuluj odstupy. */
    fun hide() {
        cancelTimer()
        attempt = 0
        retryInFlight = false
        view.visibility = View.GONE
    }

    /**
     * Načítanie hlavného rámca skončilo bez úspechu, ale aj bez chybového
     * callbacku (prerušená navigácia, zriedkavé poradie callbackov). Ak prekrytie
     * svieti a žiadny pokus nie je naplánovaný, naplánuj ďalší — inak by ostalo
     * visieť s retryInFlight = true (návrat siete ani onResume ho nespustia).
     */
    fun attemptEnded() {
        if (!isShowing || tick != null) return
        retryInFlight = false
        scheduleRetry()
    }

    /** Activity končí — zastav odpočet, aby Handler nedržal referenciu na Activity. */
    fun destroy() {
        cancelTimer()
        retryInFlight = false
    }

    /**
     * Okamžitý pokus (tlačidlo = force, návrat siete, návrat na popredie).
     * Bez force sa nespustí, kým predchádzajúci pokus ešte beží — onStart
     * (registrácia sieťového callbacku ihneď hlási onAvailable) a onResume
     * idú tesne za sebou a robili by dva reloady.
     */
    fun retryNow(force: Boolean = false) {
        if (!isShowing) return
        if (retryInFlight && !force) return
        startRetry()
    }

    private fun startRetry() {
        cancelTimer()
        retryInFlight = true
        countdown.setText(R.string.load_error_countdown_now)
        onRetry()
    }

    private fun scheduleRetry() {
        cancelTimer()
        val delay = BACKOFF_SECONDS.getOrElse(attempt) { BACKOFF_SECONDS.last() }
        attempt++
        if (attempt > MAX_AUTO_ATTEMPTS) {
            // Po ~20 minútach prestaneme automaticky skúšať — tlačidlo ostáva.
            countdown.text = ""
            return
        }
        secondsLeft = delay
        countdown.text = view.context.getString(R.string.load_error_countdown, secondsLeft)
        tick = object : Runnable {
            override fun run() {
                secondsLeft--
                if (secondsLeft <= 0) {
                    tick = null
                    startRetry()
                } else {
                    countdown.text = view.context.getString(R.string.load_error_countdown, secondsLeft)
                    handler.postDelayed(this, 1000)
                }
            }
        }.also { handler.postDelayed(it, 1000) }
    }

    private fun cancelTimer() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }

    private companion object {
        val BACKOFF_SECONDS = intArrayOf(3, 5, 10, 20, 30)
        const val MAX_AUTO_ATTEMPTS = 40
    }
}
