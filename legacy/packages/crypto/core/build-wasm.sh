#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../wasm"

WASM_BINDGEN_VERSION="0.2.126"
if ! command -v wasm-bindgen >/dev/null 2>&1 ||
	[[ "$(wasm-bindgen --version)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
	cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
fi

pnpm exec ubrn build web --config ../core/ubrn.config.yaml --release

WASM_FILE="$PWD/generated/wasm-bindgen/index_bg.wasm"

# `std::time::SystemTime::now()` compiles for wasm32-unknown-unknown and then
# traps at runtime, taking the whole instance down. The panic message is the
# only trace it leaves, so fail the build if anything reintroduces it.
if grep -qa "time not implemented on this platform" "$WASM_FILE"; then
	echo "error: the wasm build calls std::time::SystemTime::now(), which traps in browsers." >&2
	echo "       Read the clock through js_sys::Date::now() instead (see totp.rs)." >&2
	exit 1
fi

OPTIMIZED_WASM="$(mktemp "${TMPDIR:-/tmp}/bittery-crypto-wasm.XXXXXX")"
trap 'rm -f "$OPTIMIZED_WASM"' EXIT
pnpm exec wasm-opt -Oz "$WASM_FILE" -o "$OPTIMIZED_WASM"
mv "$OPTIMIZED_WASM" "$WASM_FILE"
trap - EXIT
