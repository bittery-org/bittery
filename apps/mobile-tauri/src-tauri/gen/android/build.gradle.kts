buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        // Chunk C finding, hand-edited away from Tauri 2.11.5's generated 1.9.25.
        // androidx.credentials:1.6.0-rc01 — the version apps/mobile ships — is
        // compiled with Kotlin 2.1 metadata, which a 1.9 compiler refuses to read
        // ("can read versions up to 2.0.0"). Its kotlin-stdlib 2.1.20 then poisons
        // the whole classpath, down to kotlin.Unit. Nothing about the plugin can be
        // built until this moves.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

