# ProGuard / R8 pravidlá pre release build.
#
# Minifikácia zmenší APK/AAB o ~30-40 % a skomplikuje reverse engineering.
# Konzervatívny prístup: explicitne keep-neme WebView interfaces, Firebase
# messaging classes, a model classes čo ide cez JSON / Intent.

# WebView JavaScript interfaces — mená metód volaných z JS musia byť zachované.
-keepclassmembers class eu.prplcrm.app.WebAppInterface {
    public *;
}

# Firebase Messaging Service — intent filter ho hľadá podľa FQCN.
-keep class eu.prplcrm.app.PrplFcmService { *; }

# Generické Firebase / Google Services — BOM sa o väčšinu stará, ale istota.
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }

# OkHttp — potrebuje platform-specific reflection.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# AndroidX Security (EncryptedSharedPreferences) — interne reflection na Tink.
-keep class com.google.crypto.tink.** { *; }

# Tink KeysDownloader referencuje Google HTTP client + Joda Time iba v utility
# path ktorý my nepoužívame (kľúče generujeme lokálne cez Android Keystore TEE,
# žiadne key fetching z webu). R8 by inak failnulo na missing classes.
-dontwarn com.google.api.client.http.**
-dontwarn com.google.api.client.http.javanet.**
-dontwarn org.joda.time.**
