package eu.prplcrm.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.core.content.getSystemService

/**
 * Custom Application class — bootstraps app-wide singletons pri štarte procesu.
 *
 * Jediná aktuálna zodpovednosť: vytvoriť notification channel. Android 8+
 * (API 26) vyžaduje channel PRED prvým zobrazením notifikácie. FCM inak
 * notifikácie zahodí.
 */
class PrplApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createDefaultNotificationChannel()
    }

    private fun createDefaultNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            getString(R.string.default_notification_channel_id),
            getString(R.string.default_notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = getString(R.string.default_notification_channel_description)
            enableVibration(true)
            setShowBadge(true)
        }

        getSystemService<NotificationManager>()?.createNotificationChannel(channel)
    }
}
