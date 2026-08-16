#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // The `autofill-unlock` deep link the credential-provider plugin's
        // `AutofillAuthActivity`/`GetCredentialsActivity` launch (see their
        // `bittery://autofill-unlock?passwordRequired=...`), plus any future
        // externally-triggered link. Cross-platform — no `#[cfg(mobile)]` needed.
        .plugin(tauri_plugin_deep_link::init())
        // `opener`, `dialog` and `fs` are the three the migration brief flags as only
        // partially supported on mobile. `dialog` (file/document picker) and `fs`
        // (reading the picked file) are registered so the pair can be exercised from
        // `/debug` and proven on-device rather than assumed from the docs — see
        // README's "peripherals" section for what that run found.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // The `secret` tier's Android Keystore backing. Registering it is safe on every
        // platform: off Android it answers `available: false` and `packages/storage`'s
        // adapter keeps using `secrets.json`.
        .plugin(tauri_plugin_bittery_keystore::init())
        // Bittery's credential provider and autofill services. The commands here are
        // almost beside the point — registering the plugin is what pulls its Android
        // module in, and the module's own manifest is what puts the services in front
        // of the system. Off Android the one command answers `Unsupported`.
        .plugin(tauri_plugin_bittery_credential_provider::init())
        // First-party `ACTION_SEND` wrapper for the share-link flow. Off Android the
        // one command answers `Unsupported`.
        .plugin(tauri_plugin_bittery_share::init());

    // `tauri-plugin-barcode-scanner` is `#![cfg(mobile)]` at its crate root: the crate
    // body — including `init()` — compiles to nothing on desktop, so the registration
    // has to be gated the same way or `cargo check`/clippy on this host fails to find
    // `init` at all.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
