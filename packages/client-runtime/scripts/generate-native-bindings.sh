#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:-$package_root/generated/native}"
library="$package_root/target/release/libbittery_client_bindings.so"

cargo build --release --manifest-path "$package_root/Cargo.toml" -p bittery-client-bindings
mkdir -p "$output_root/kotlin" "$output_root/swift"

(
	cd "$package_root"
	cargo run --quiet --manifest-path "$package_root/Cargo.toml" \
		-p bittery-client-uniffi-bindgen --bin bittery-client-uniffi-bindgen -- \
		generate --library "$library" --language kotlin --no-format \
		--out-dir "$output_root/kotlin"
	cargo run --quiet --manifest-path "$package_root/Cargo.toml" \
		-p bittery-client-uniffi-bindgen --bin bittery-client-uniffi-bindgen -- \
		generate --library "$library" --language swift --no-format \
		--out-dir "$output_root/swift"
)

# UniFFI's no-format templates contain trailing spaces. Normalize committed output here so both
# generation and drift checks produce repository-clean files on every host.
while IFS= read -r -d '' generated_file; do
	perl -0pi -e 's/[ \t]+(?=\r?\n)//g; s/\s*\z/\n/' "$generated_file"
done < <(find "$output_root" -type f -print0)
