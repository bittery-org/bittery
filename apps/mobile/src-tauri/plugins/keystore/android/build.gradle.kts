plugins {
	id("com.android.library")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "com.bittery.mobile.keystore"
	// Matched to the app. Nothing here needs a recent SDK to *run*; API 31's
	// KeyInfo.getSecurityLevel needs it to compile, and is behind a version check.
	compileSdk = 36

	defaultConfig {
		// Same floor as the app. AES-GCM in the AndroidKeyStore provider needs API 23,
		// so every device that can install this app can use the Keystore path.
		minSdk = 24
		consumerProguardFiles("proguard-rules.pro")
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_1_8
		targetCompatibility = JavaVersion.VERSION_1_8
	}

	kotlinOptions {
		jvmTarget = "1.8"
	}

	lint {
		abortOnError = false
	}
}

dependencies {
	// Deliberately no androidx.security:security-crypto. EncryptedSharedPreferences is
	// deprecated by Google, and a deprecated dependency in the file that holds vault
	// keys is exactly what a security review rejects. The ~60 lines it would save are
	// hand-rolled in KeystorePlugin.kt instead.
	implementation(project(":tauri-android"))
}
