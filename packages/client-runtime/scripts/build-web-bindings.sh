#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
combined_root="${1:-$package_root/../crypto/wasm/generated/wasm-bindgen}"

"$package_root/../crypto/core/build-wasm.sh" "$combined_root"
