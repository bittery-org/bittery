#!/bin/bash
set -euo pipefail

mobile_crypto_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$mobile_crypto_script_dir/.."

case "${EAS_BUILD_PLATFORM:-${1:-}}" in
  android)
    pnpm run build:crypto-android
    ;;
  ios)
    pnpm run build:crypto-ios
    ;;
  *)
    echo "Expected mobile crypto platform: android or ios" >&2
    exit 1
    ;;
esac
