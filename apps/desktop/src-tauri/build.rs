fn main() {
    println!("cargo:rerun-if-changed=src/native_host.rs");
    let runtime = tauri_build::InlinedPlugin::new()
        .commands(&[
            "runtime_attach",
            "runtime_request",
            "runtime_observe",
            "runtime_unobserve",
            "runtime_cancel",
            "runtime_detach",
        ])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("client-runtime", runtime))
        .expect("Tauri build metadata must be valid");
}
