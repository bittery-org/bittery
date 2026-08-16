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
	implementation(project(":tauri-android"))
}
