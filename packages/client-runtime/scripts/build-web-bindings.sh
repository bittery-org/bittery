#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:-$package_root/generated/web}"
wasm_bindgen_version="0.2.126"

if ! command -v wasm-bindgen >/dev/null 2>&1 || \
	[[ "$(wasm-bindgen --version)" != "wasm-bindgen ${wasm_bindgen_version}" ]]; then
	cargo install wasm-bindgen-cli --version "$wasm_bindgen_version" --locked
fi

cargo build --release --target wasm32-unknown-unknown \
	--manifest-path "$package_root/Cargo.toml" -p bittery-client-bindings
mkdir -p "$output_root"
wasm-bindgen --target web --out-dir "$output_root" \
	"$package_root/target/wasm32-unknown-unknown/release/bittery_client_bindings.wasm"
