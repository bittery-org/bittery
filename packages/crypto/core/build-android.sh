#!/bin/bash
# Builds the Android half of the crypto core: one .so per ABI, plus the UniFFI
# Kotlin that calls into them. Output goes to packages/crypto/android/generated.
# See that package's README for who consumes it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../android/generated"
cd "$SCRIPT_DIR"

CARGO_NDK_VERSION="4.1.2"
if ! command -v cargo-ndk >/dev/null 2>&1 ||
	[[ "$(cargo ndk --version)" != "cargo-ndk ${CARGO_NDK_VERSION}" ]]; then
	cargo install cargo-ndk --version "$CARGO_NDK_VERSION" --locked
fi

# cargo-ndk reads these three; only fall back to a search when none is set, so a
# deliberate choice always wins over the highest installed version.
if [[ -z "${ANDROID_NDK_HOME:-}${ANDROID_NDK_ROOT:-}${NDK_HOME:-}" ]]; then
	ndk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}/ndk"
	ANDROID_NDK_HOME="$(ls -d "$ndk_root"/* 2>/dev/null | sort -V | tail -1 || true)"
	if [[ -z "$ANDROID_NDK_HOME" ]]; then
		echo "error: no Android NDK found under $ndk_root." >&2
		echo "       Install one, or point ANDROID_NDK_HOME at it." >&2
		exit 1
	fi
	export ANDROID_NDK_HOME
fi

# API 24 is the app's minSdk. A higher platform here would link against symbols
# the app is allowed to run without.
cargo ndk \
	-t arm64-v8a -t armeabi-v7a -t x86 -t x86_64 \
	-o "$OUT_DIR/jniLibs" \
	--platform 24 \
	build --release -p bittery-crypto-api

# `--library` reads the metadata uniffi's proc macros embedded in the .so, so the
# bindings cannot drift from the binary they are generated beside. Any ABI would
# do; they all carry the same metadata.
#
# Not formatted: ktlint is not a dependency of this repo, and the generator's raw
# output is what has always been committed.
cargo run --quiet -p bittery-uniffi-bindgen --bin uniffi-bindgen -- \
	generate \
	--library "$OUT_DIR/jniLibs/arm64-v8a/libbittery_crypto_api.so" \
	--language kotlin \
	--no-format \
	--out-dir "$OUT_DIR/java"
