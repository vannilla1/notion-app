// Gradle settings pre Prpl CRM Android native wrapper.
//
// Prečo samostatný projekt oproti `../android/` (TWA Bubblewrap)?
// TWA je len chromeless Chrome wrapper — nevie native FCM push keď je appka
// killed (OEM battery optimization zabije Chrome background process). Tento
// Kotlin projekt je full native WebView + FCM + EncryptedSharedPreferences,
// rovnaká architektúra ako iOS wrapper (WKWebView + APNs + Keychain).
//
// Package name `eu.prplcrm.app` a keystore sú ZDIEĽANÉ s TWA → Play Store
// vníma tento build ako update existujúcej TWA appky, nie novú appku.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "PrplCrmAndroid"
include(":app")
