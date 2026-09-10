#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
combined_root="$package_root/../crypto/wasm/generated/wasm-bindgen"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/bittery-combined-web-bindings.XXXXXX")"
trap 'rm -rf -- "$temporary_root"' EXIT

"$package_root/scripts/build-web-bindings.sh" "$temporary_root"
diff -ru --exclude='*.wasm' "$combined_root" "$temporary_root"
BITTERY_COMBINED_WEB_BINDINGS_ROOT="$temporary_root" \
	node --test "$package_root/scripts/combined-web-bindings.test.mjs"
