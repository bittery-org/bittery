plugins {
	id("com.android.library")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "com.bittery.mobile.share"
	compileSdk = 36

	defaultConfig {
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
	// `androidx.core.content.FileProvider`, which `shareFile` needs to hand a decrypted
	// attachment out as a `content://` URI. Declared rather than inherited: `:tauri-android`
	// exposes its own dependencies as `implementation`, so none of them are on this
	// module's compile classpath.
	implementation("androidx.core:core-ktx:1.13.1")

	implementation(project(":tauri-android"))
}
