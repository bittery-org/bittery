#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/bittery-client-bindings.XXXXXX")"
trap 'rm -rf -- "$temporary_root"' EXIT

"$package_root/scripts/generate-native-bindings.sh" "$temporary_root"
diff -ru "$package_root/generated/native" "$temporary_root"

kotlin_bindings="$temporary_root/kotlin/uniffi/bittery_client_bindings/bittery_client_bindings.kt"
swift_bindings="$temporary_root/swift/bittery_client_bindings.swift"
rg --fixed-strings 'suspend fun `shutdown`()' "$kotlin_bindings" >/dev/null
if rg --fixed-strings 'suspend fun `close`()' "$kotlin_bindings" >/dev/null; then
	echo "Generated Kotlin reintroduced the UniFFI AutoCloseable.close() collision." >&2
	exit 1
fi
rg --fixed-strings 'func shutdown() async' "$swift_bindings" >/dev/null
