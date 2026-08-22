#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if (( $# > 1 )); then
	echo "usage: $0 [wasm-bindgen-output-directory]" >&2
	exit 2
fi
if (( $# == 1 )); then
	mkdir -p -- "$1"
	WASM_BINDINGS_OUTPUT="$(cd "$1" && pwd)"
fi
cd "$SCRIPT_DIR/../wasm"
WASM_BINDINGS_OUTPUT="${WASM_BINDINGS_OUTPUT:-$PWD/generated/wasm-bindgen}"

WASM_BINDGEN_VERSION="0.2.126"
if ! command -v wasm-bindgen >/dev/null 2>&1 ||
	[[ "$(wasm-bindgen --version)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
	cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
fi

pnpm exec ubrn build web --config ../core/ubrn.config.yaml --release --no-wasm-pack

GENERATED_ENTRYPOINT="$SCRIPT_DIR/../wasm/crate/src/lib.rs"
EXPECTED_ENTRYPOINT="$SCRIPT_DIR/wasm-entrypoint.generated.rs"
COMBINED_ENTRYPOINT="$SCRIPT_DIR/wasm-entrypoint.combined.rs"
GENERATED_PACKAGE_ENTRYPOINT="$SCRIPT_DIR/../wasm/index.ts"
EXPECTED_PACKAGE_ENTRYPOINT="$SCRIPT_DIR/wasm-index.generated.ts"
COMBINED_PACKAGE_ENTRYPOINT="$SCRIPT_DIR/wasm-index.combined.ts"
if [[ "$(cat "$EXPECTED_ENTRYPOINT")" != "$(cat "$GENERATED_ENTRYPOINT")" ]]; then
	echo "error: UBRN's generated WASM entrypoint changed; refusing to compose it." >&2
	diff -u "$EXPECTED_ENTRYPOINT" "$GENERATED_ENTRYPOINT" >&2 || true
	exit 1
fi
if [[ "$(cat "$EXPECTED_PACKAGE_ENTRYPOINT")" != "$(cat "$GENERATED_PACKAGE_ENTRYPOINT")" ]]; then
	echo "error: UBRN's generated package entrypoint changed; refusing to compose it." >&2
	diff -u "$EXPECTED_PACKAGE_ENTRYPOINT" "$GENERATED_PACKAGE_ENTRYPOINT" >&2 || true
	exit 1
fi
cp "$COMBINED_ENTRYPOINT" "$GENERATED_ENTRYPOINT"
cp "$COMBINED_PACKAGE_ENTRYPOINT" "$GENERATED_PACKAGE_ENTRYPOINT"

cargo build --manifest-path crate/Cargo.toml --release --target wasm32-unknown-unknown
wasm-bindgen --target web --omit-default-module-path --out-name index \
	--out-dir "$WASM_BINDINGS_OUTPUT" \
	crate/target/wasm32-unknown-unknown/release/bittery_crypto_wasm.wasm
pnpm exec prettier --write \
	"$WASM_BINDINGS_OUTPUT"/*.js \
	"$WASM_BINDINGS_OUTPUT"/*.d.ts >/dev/null

WASM_FILE="$WASM_BINDINGS_OUTPUT/index_bg.wasm"

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
