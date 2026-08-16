# Tauri finds the plugin class by name, from Rust, through JNI. R8 cannot see that
# reference, so without this the release build strips it and every share_* call fails.
-keep class com.bittery.mobile.share.SharePlugin { *; }
