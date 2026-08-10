use std::path::PathBuf;

use bittery_server::create_rpc_router;
use qubit::TypeScript;

fn main() {
    let output_dir = std::env::var_os("BITTERY_RUST_RPC_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_output_dir);

    let output_path = output_dir.join("index.ts");
    create_rpc_router()
        .as_codegen()
        .write_type(&output_path, TypeScript::new())
        .expect("failed to write Qubit bindings");
    println!("wrote Qubit bindings to {}", output_dir.display());
}

fn default_output_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/rust-rpc/src/generated")
}
