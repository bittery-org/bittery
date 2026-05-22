use std::path::PathBuf;

use bittery_server_rust::create_rpc_router;

fn main() {
    let output_dir = std::env::var_os("BITTERY_RUST_RPC_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_output_dir);

    create_rpc_router().write_bindings_to_dir(&output_dir);
    println!("wrote Qubit bindings to {}", output_dir.display());
}

fn default_output_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/rust-rpc/src/generated")
}
