#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // The `secret` tier's Android Keystore backing. Registering it is safe on every
        // platform: off Android it answers `available: false` and `packages/storage`'s
        // adapter keeps using `secrets.json`.
        .plugin(tauri_plugin_bittery_keystore::init())
        // Bittery's credential provider and autofill services. The commands here are
        // almost beside the point — registering the plugin is what pulls its Android
        // module in, and the module's own manifest is what puts the services in front
        // of the system. Off Android the one command answers `Unsupported`.
        .plugin(tauri_plugin_bittery_credential_provider::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
