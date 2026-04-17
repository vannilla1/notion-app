// Top-level Gradle build — len deklaruje plugin verzie, ich aplikácia je
// v app/build.gradle.kts.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "1.9.25" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}
