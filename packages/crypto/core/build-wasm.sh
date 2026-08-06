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
OPTIMIZED_WASM="$(mktemp "${TMPDIR:-/tmp}/bittery-crypto-wasm.XXXXXX")"
trap 'rm -f "$OPTIMIZED_WASM"' EXIT
pnpm exec wasm-opt -Oz "$WASM_FILE" -o "$OPTIMIZED_WASM"
mv "$OPTIMIZED_WASM" "$WASM_FILE"
trap - EXIT
