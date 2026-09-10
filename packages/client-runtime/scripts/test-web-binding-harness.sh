#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/bittery-web-binding-harness.XXXXXX")"
trap 'rm -rf -- "$temporary_root"' EXIT

BITTERY_BINDING_TEST_HARNESS=1 \
	"$package_root/scripts/build-web-bindings.sh" "$temporary_root"
BITTERY_BINDING_TEST_HARNESS=1 \
	BITTERY_COMBINED_WEB_BINDINGS_ROOT="$temporary_root" \
	node --test "$package_root/scripts/combined-web-bindings.test.mjs"
