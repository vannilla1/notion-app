# Prpl CRM — Android native wrapper

Kotlin WebView wrapper nad `https://prplcrm.eu/app`, nahrádza predošlú
Bubblewrap TWA verziu (v `android/`).

Prečo: OEMs killujú Chrome background procesy → Web Push v TWA nedoručil
notifikácie keď bola appka swipe-killnutá. Native FirebaseMessagingService
má vyššiu systémovú prioritu a push príde aj po force-stop.

## Prvotný setup

1. **Skopíruj keystore** z TWA (rovnaký signing key musíme použiť, aby Play Store
   prijal nový AAB ako update `eu.prplcrm.app`):
   ```bash
   cp ../android/android.keystore ./android.keystore
   ```
   (Už je skopírovaný.)

2. **Vyplň `keystore.properties`** (v .gitignore):
   ```bash
   cp keystore.properties.example keystore.properties
   # edituj, vyplň storePassword a keyPassword
   ```

3. **Firebase config** — `app/google-services.json` (v .gitignore). Stiahnutý
   z Firebase Console → Project `prpl-crm` → Android app `eu.prplcrm.app`.

4. **SDK path** — `local.properties` ukazuje na Bubblewrap Android SDK
   (`~/.bubblewrap/android_sdk`). Ak chceš použiť iný, zmeň cestu.

## Build

### Debug APK (pre local install test, nepodpísaný Play Store signingom)
```bash
./gradlew assembleDebug
# výstup: app/build/outputs/apk/debug/app-debug.apk
```

### Release AAB (pre Play Store upload)
```bash
./gradlew bundleRelease
# výstup: app/build/outputs/bundle/release/app-release.aab
```

### Release APK (pre local install test so Play Store signingom)
```bash
./gradlew assembleRelease
# výstup: app/build/outputs/apk/release/app-release.apk
```

## Lokálny test na zariadení

1. Zapni **Developer options + USB debugging** v nastaveniach Android telefónu.
2. Pripoj cez USB, povoľ "Trust this computer" na telefóne.
3. Install:
   ```bash
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```
4. Otvor **Prpl CRM** v app draweri — malo by sa načítať `https://prplcrm.eu/app`
   bez URL baru (assetlinks.json funguje).

## Push notifikácie (FCM)

Flow:
1. Po login web appka zavolá `window.NativeBridge.setAuthToken(jwt)`.
2. `MainActivity.ensureFcmTokenRegistered()` získa FCM token cez
   `FirebaseMessaging.getInstance().token`.
3. `FcmRegistrar.registerIfNeeded()` pošle `POST /api/push/fcm/register`
   s Bearer tokenom → backend uloží do MongoDB.
4. Keď backend zavolá `notificationService.createNotification()`, paralelne
   hodí message na FCM (Admin SDK) + APNs (iOS) + Web Push (desktop).
5. FCM message príde do `PrplFcmService.onMessageReceived()` → zobrazí
   NotificationCompat → tap otvorí deep link v MainActivity.

### Test FCM end-to-end (po prihlásení v appke)
```bash
# z prehliadača DevTools console v prihlásenej session:
fetch('/api/push/fcm/test', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
}).then(r => r.json()).then(console.log)
```
Čakáme `{ result: { sent: 1, ... } }` — push do appky do ~2 sekúnd.

## Deep linking

Intent filter v `AndroidManifest.xml` zachytáva `https://prplcrm.eu/app/*`
cez `autoVerify=true`. Vyžaduje verified Digital Asset Links:

```bash
curl https://prplcrm.eu/.well-known/assetlinks.json
```
Musí vrátiť JSON s `sha256_cert_fingerprints` matching
`bubblewrap fingerprint` (alebo `keytool -list -v -keystore android.keystore`).

## Package name

`eu.prplcrm.app` — identický ako TWA, aby Play Store rozpoznal ako update.
versionCode začína na **100** (TWA bol 1–99), aby update prešiel bez downgrade
chyby.
