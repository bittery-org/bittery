use std::env;
use std::path::PathBuf;

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_path = PathBuf::from(&crate_dir).join("include");

    // Create include directory if it doesn't exist
    std::fs::create_dir_all(&out_path).ok();

    // Generate C header
    cbindgen::Builder::new()
        .with_crate(crate_dir)
        .with_language(cbindgen::Language::C)
        .with_include_guard("BITTERY_CRYPTO_H")
        .with_documentation(true)
        .generate()
        .expect("Unable to generate bindings")
        .write_to_file(out_path.join("bittery_crypto.h"));
}
