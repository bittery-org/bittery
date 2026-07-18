#!/usr/bin/env bash
# Bootstraps a fresh git worktree so all checks can run:
#   1. copies .env from the main checkout (if present there and missing here)
#   2. builds the generated @bittery/crypto-wasm workspace package (required
#      before pnpm install can resolve the workspace)
#   3. installs JS dependencies
set -euo pipefail

cd "$(dirname "$0")/.."

# Locate the main checkout (the worktree that owns the shared .git dir).
main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

if [[ ! -f .env && -f "$main_checkout/.env" && "$main_checkout" != "$PWD" ]]; then
	cp "$main_checkout/.env" .env
	echo "setup-worktree: copied .env from $main_checkout"
fi

if [[ ! -f packages/crypto/wasm/package.json ]]; then
	if ! command -v wasm-pack >/dev/null 2>&1; then
		echo "setup-worktree: wasm-pack is required (https://rustwasm.github.io/wasm-pack/)" >&2
		exit 1
	fi
	(cd packages/crypto/core && ./build-wasm.sh)
fi

pnpm install --prefer-offline

echo "setup-worktree: done"
