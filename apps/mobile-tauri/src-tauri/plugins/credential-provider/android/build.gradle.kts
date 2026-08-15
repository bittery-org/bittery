plugins {
	id("com.android.library")
	id("org.jetbrains.kotlin.android")
	// Room's annotation processor. KSP, not kapt: kapt is deprecated for Kotlin 2.x
	// and runs a whole extra stub-generating javac pass over 7 900 lines of Kotlin.
	// The version is pinned in gen/android/build.gradle.kts, matched to Kotlin 2.1.20.
	id("com.google.devtools.ksp")
}

android {
	namespace = "com.bittery.mobile.credentialprovider"
	// 36 to match the app. CredentialProviderService needs 34 to compile at all.
	compileSdk = 36

	defaultConfig {
		// Same floor as the app. Everything API-34-only is behind @RequiresApi plus a
		// Build.VERSION.SDK_INT check, so an API 24 device still installs and runs.
		minSdk = 24
		consumerProguardFiles("proguard-rules.pro")
		testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
	}

	sourceSets.getByName("main") {
		// The UniFFI Kotlin bindings for the Rust crypto core are *generated*, and ADR
		// 0012 says a generated cross-language definition has exactly one copy. So this
		// source set reaches across the repo rather than vendoring a 4 200-line file
		// that would silently fork the next time the Rust API changes.
		//
		// The srcDir is the `uniffi` directory, not its `java` parent, because the
		// parent also holds com/bittery/crypto/CryptoReactNativeModule.kt, which extends
		// ReactContextBaseJavaModule and would drag React Native onto this classpath.
		// (That is also why this module does *not* depend on the whole
		// :bittery_crypto-react-native Gradle project the way the Expo module did.)
		// Kotlin does not require the directory layout to mirror the package, so the
		// file's `package uniffi.bittery_crypto_api` still resolves.
		java.srcDir("../../../../../../packages/crypto/react-native/android/src/main/java/uniffi")

		// The matching .so, one per ABI. Gitignored and produced by
		// `pnpm build:crypto-android`; if it is missing the Kotlin still compiles and
		// NativeCrypto.isAvailable simply answers false at runtime.
		jniLibs.srcDirs("../../../../../../packages/crypto/react-native/android/src/main/jniLibs")
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
	// Versions matched to apps/mobile/modules/credential-provider/android/build.gradle
	// so the port ships the artifacts the Expo build already proved.
	implementation("androidx.credentials:credentials:1.6.0-rc01")
	implementation("androidx.autofill:autofill:1.1.0")
	implementation("androidx.biometric:biometric:1.2.0-alpha05")
	implementation("androidx.room:room-runtime:2.7.0")
	implementation("androidx.room:room-ktx:2.7.0")
	ksp("androidx.room:room-compiler:2.7.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
	// FragmentActivity, which BiometricPrompt requires.
	implementation("androidx.appcompat:appcompat:1.6.1")
	implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

	// The UniFFI bindings call into libbittery_crypto_api.so through JNA, not
	// System.loadLibrary. Leaving this out is not a build error — it is an
	// UnsatisfiedLinkError the first time a credential is decrypted.
	implementation("net.java.dev.jna:jna:5.17.0@aar")

	implementation(project(":tauri-android"))

	// JVM unit tests (src/test) — no emulator, so they run anywhere. org.json is only
	// a stub in the unit-test android.jar, so the real artifact is needed to parse the
	// shared domain-matching vectors.
	testImplementation("junit:junit:4.13.2")
	testImplementation("org.json:json:20250107")

	androidTestImplementation("androidx.room:room-testing:2.7.0")
	androidTestImplementation("androidx.test:core:1.6.1")
	androidTestImplementation("androidx.test.ext:junit:1.2.1")
	androidTestImplementation("androidx.test:runner:1.6.2")
}
