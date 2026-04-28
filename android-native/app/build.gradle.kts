// App-level Gradle — core konfigurácia appky.
//
// Signing config číta heslo z env variables (KEYSTORE_PASSWORD, KEY_PASSWORD)
// alebo z `keystore.properties` súboru (local only, v .gitignore). Toto je
// rovnaké heslo ako používa Bubblewrap pre TWA keystore, aby Play Store
// vedel že ide o update toho istého appu (rovnaký signing key).
import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

// Load keystore credentials from keystore.properties (local dev) or env vars (CI).
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        load(FileInputStream(keystorePropertiesFile))
    }
}

android {
    namespace = "eu.prplcrm.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "eu.prplcrm.app"
        minSdk = 24            // Android 7.0 Nougat — 99% zariadení, pokrýva TWA baseline
        targetSdk = 35         // Android 15 — Play Store 2025 requirement
        versionCode = 202      // production.3 — pridané /auth pathPrefix do App Links pre Sign in with Google/Apple OAuth callback (prplcrm.eu/auth/callback#token=...). Bez tohto Chrome ostal otvorený a appka nedostala JWT.
        versionName = "1.0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            val keystoreFile = file("../android.keystore")
            if (keystoreFile.exists()) {
                storeFile = keystoreFile
                storePassword = keystoreProperties.getProperty("storePassword")
                    ?: System.getenv("KEYSTORE_PASSWORD")
                keyAlias = keystoreProperties.getProperty("keyAlias") ?: "android"
                keyPassword = keystoreProperties.getProperty("keyPassword")
                    ?: System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
            // Žiadny applicationIdSuffix — Firebase google-services.json je registrovaný
            // len pre `eu.prplcrm.app`, a debug buildy potrebujú rovnaký package name
            // aby FCM fungovalo v dev testovaní.
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // Základy — AppCompat / Core / lifecycle
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")

    // WebView security — moderné WebView už má tieto API v Android frameworku, ale
    // `webkit` library poskytuje unified interface aj pre staršie verzie (API 24+).
    implementation("androidx.webkit:webkit:1.12.1")

    // Splash screen — natívny splash API z Androidu 12+, s backport pre staršie verzie.
    implementation("androidx.core:core-splashscreen:1.0.1")

    // EncryptedSharedPreferences — token storage chránený Android Keystore.
    // Equivalent iOS Keychain, šifruje obsah AES-256-GCM pomocou hardvérového TEE/SE.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Firebase BOM + FCM Messaging. BOM zjednocuje verzie všetkých Firebase závislostí.
    implementation(platform("com.google.firebase:firebase-bom:33.6.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    // Biometric — BiometricPrompt API (Face/Fingerprint unlock). Pre teraz len
    // dependency pripravená; aktivuje sa v druhej iterácii (bio lock na resume).
    implementation("androidx.biometric:biometric:1.1.0")

    // OkHttp — HTTP klient pre register FCM token na náš backend (/api/push/fcm/register).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
