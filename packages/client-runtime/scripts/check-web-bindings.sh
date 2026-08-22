#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/bittery-client-web-bindings.XXXXXX")"
trap 'rm -rf -- "$temporary_root"' EXIT

"$package_root/scripts/build-web-bindings.sh" "$temporary_root"
diff -ru --exclude='*.wasm' "$package_root/generated/web" "$temporary_root"
BITTERY_WEB_BINDINGS_ROOT="$temporary_root" node --test "$package_root/scripts/web-bindings.test.mjs"
