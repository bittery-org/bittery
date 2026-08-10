fn main() {
    println!("cargo:rerun-if-changed=src/native_host.rs");
    tauri_build::build()
}
