use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=src/native_host.rs");

    // Check if native host binary exists (for bundling)
    let profile = std::env::var("PROFILE").unwrap_or_default();

    #[cfg(target_os = "windows")]
    let binary_name = "bittery-native-host.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "bittery-native-host";

    let binary_path = Path::new("target").join(&profile).join(binary_name);

    if binary_path.exists() {
        // Tell Tauri to include the native host binary as a resource
        println!(
            "cargo:rustc-env=NATIVE_HOST_BINARY_PATH={}",
            binary_path.display()
        );
        println!("cargo:warning=Native messaging host binary found, will be bundled");
    } else {
        println!(
            "cargo:warning=Native messaging host binary not found at {:?}",
            binary_path
        );
        println!("cargo:warning=Biometric unlock will not work until binary is built");
        println!("cargo:warning=Run: cargo build --release --bin bittery-native-host");
    }

    tauri_build::build()
}
