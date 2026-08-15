# Tauri finds the plugin class by name, from Rust, through JNI. R8 cannot see that
# reference, so without this the release build strips it and every command fails.
-keep class com.bittery.mobile.credentialprovider.CredentialProviderPlugin { *; }

# The system binds these by the name in the merged manifest, not by any code
# reference, so R8 would treat them as dead too.
-keep class com.bittery.mobile.credentialprovider.service.** { *; }
-keep class com.bittery.mobile.credentialprovider.activity.** { *; }

# JNA reaches the Rust crypto core reflectively: the interfaces are never
# instantiated in Kotlin, only registered by name.
-keep class com.sun.jna.** { *; }
-keep class uniffi.bittery_crypto_api.** { *; }
