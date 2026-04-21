package eu.prplcrm.app

import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging service — listener pre push notifikácie.
 *
 * Lifecycle:
 *   1. Android systém hodí service-u `onNewToken(token)` keď FCM vygeneruje nový
 *      registration token (first install, reinstall, data clear, Google Play
 *      services update, atď.). Pošleme ho na backend cez FcmRegistrar.
 *   2. Keď backend pošle push message (cez Admin SDK), FCM ju doručí a zavolá
 *      `onMessageReceived(message)`. My zostavíme NotificationCompat a zobrazíme.
 *
 * TWA (predošlá verzia) sa spoliehala na Web Push + service worker, ktoré OEMs
 * killovali keď bol Chrome background killnutý → notifikácie sa nedoručili keď
 * appka bola zavretá. Native FirebaseMessagingService má vlastný WakeLock a
 * OEMs ho na whitelist-e cez Google Play Services → notifikácie prídu vždy.
 *
 * Data vs. notification payload:
 *   - Backend posiela DATA-only payload (žiadny "notification" field), aby sme
 *     mali plnú kontrolu nad renderovaním. FCM inak v data+notification
 *     kombinácii zobrazí notifikáciu systémovo iba ak je appka v pozadí a my
 *     dostaneme onMessageReceived iba ak je v popredí — nekonzistentné.
 *   - Data payload: { title, body, url, notificationId? }
 */
class PrplFcmService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "PrplFcmService"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "FCM token refreshed")
        // Try to register immediately. Ak user nie je logged in, FcmRegistrar
        // skip-ne bez errora a MainActivity ho zavolá znova po najbližšom resume.
        FcmRegistrar.registerIfNeeded(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        // Ak je appka aktuálne na popredí, web appka má svoj vlastný
        // NotificationToast (WebSocket in-app toast) ktorý zobrazí notifikáciu
        // v UI. Duplikovať to ešte aj systémovou notifikáciou v trayi nedáva
        // zmysel — user by videl dve rovnaké notifikácie. Skipneme; keď appka
        // pôjde do pozadia, ďalšie push-e pôjdu systémovo normálne.
        if (MainActivity.isAppInForeground) {
            Log.d(TAG, "App is in foreground — skip system notification (in-app toast will handle it)")
            return
        }

        val data = message.data
        val title = data["title"] ?: getString(R.string.app_name)
        val body = data["body"] ?: ""
        val url = data["url"]  // deep link, napr. "https://prplcrm.eu/app/tasks/123"
        val notificationIdStr = data["notificationId"]

        // Unique ID pre systémovú notifikáciu — ak backend posiela server-side
        // notificationId, použijeme ho (umožní potom overwrite tej istej), inak
        // timestamp (každá nová notifikácia = nová entry v trayi).
        val notificationId = notificationIdStr?.hashCode() ?: System.currentTimeMillis().toInt()

        showNotification(title, body, url, notificationId)
    }

    private fun showNotification(title: String, body: String, url: String?, notificationId: Int) {
        // Tap na notifikáciu → otvorí MainActivity s deep link URL v extras.
        // singleTask launch mode zabezpečuje že ak appka beží, zrecyklujeme
        // existujúcu Activity a len presmerujeme WebView (onNewIntent).
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            url?.let { putExtra(MainActivity.EXTRA_DEEP_LINK, it) }
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getActivity(this, notificationId, tapIntent, pendingFlags)

        val channelId = getString(R.string.default_notification_channel_id)
        val builder = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.brand_primary))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)

        try {
            NotificationManagerCompat.from(this).notify(notificationId, builder.build())
        } catch (se: SecurityException) {
            // POST_NOTIFICATIONS permission denied (Android 13+). FCM token
            // registration ostáva valid, takže keď user neskôr permission povolí,
            // ďalšie notifikácie prídu normálne.
            Log.w(TAG, "Notification permission denied — drop notification", se)
        }
    }
}
