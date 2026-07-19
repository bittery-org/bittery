#!/usr/bin/env bash
# Bootstraps a fresh git worktree so all checks can run:
#   1. copies .env from the main checkout (if present there and missing here)
#   2. builds the generated @bittery/crypto-wasm workspace package (required
#      before pnpm install can resolve the workspace)
#   3. installs JS dependencies
#   4. gives the worktree its own database, cloned from the dev one, so
#      branches with diverging migrations don't share a schema
set -euo pipefail

PG_CONTAINER=bittery-postgres
SOURCE_DB=bittery

cd "$(dirname "$0")/.."

# Locate the main checkout (the worktree that owns the shared .git dir).
main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

if [[ ! -f .env && -f "$main_checkout/.env" && "$main_checkout" != "$PWD" ]]; then
	cp "$main_checkout/.env" .env
	echo "setup-worktree: copied .env from $main_checkout"
fi

if [[ ! -f packages/crypto/wasm/package.json ]]; then
	# build-wasm.sh installs wasm-pack itself when it is missing, so don't
	# pre-empt that with our own hard failure.
	(cd packages/crypto/core && ./build-wasm.sh)
fi

pnpm install --prefer-offline

# ---------------------------------------------------------------------------
# 4. Per-worktree database
# ---------------------------------------------------------------------------
# The main checkout keeps using the plain dev database; only linked worktrees
# get a clone. Nothing below runs for the main checkout.
if [[ "$main_checkout" == "$PWD" ]]; then
	echo "setup-worktree: main checkout, keeping the shared '$SOURCE_DB' database"
	echo "setup-worktree: done"
	exit 0
fi

if [[ ! -f .env ]]; then
	echo "setup-worktree: no .env, skipping database setup" >&2
	echo "setup-worktree: done"
	exit 0
fi

psql_db() {
	docker exec -i "$PG_CONTAINER" psql -U postgres -d postgres -tAc "$1"
}

if ! docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
	echo "setup-worktree: Postgres container '$PG_CONTAINER' is not running." >&2
	echo "                Start it with 'pnpm db:start', then re-run this script." >&2
	exit 1
fi

# Name the database after the branch, sanitised to a legal identifier. The
# 63-char identifier limit leaves 52 chars once 'bittery_wt_' is prefixed.
branch="$(git branch --show-current || true)"
[[ -n "$branch" ]] || branch="$(basename "$PWD")"
slug="$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed -e 's/__*/_/g' -e 's/^_//' -e 's/_$//' | cut -c1-52)"
worktree_db="bittery_wt_${slug}"

if [[ "$(psql_db "SELECT 1 FROM pg_database WHERE datname = '$worktree_db'")" == "1" ]]; then
	echo "setup-worktree: reusing existing database '$worktree_db'"
else
	# Deliberately dump-and-restore rather than CREATE DATABASE ... TEMPLATE:
	# TEMPLATE needs zero sessions on the source, and the dev server holds an
	# idle pool open more or less permanently. pg_dump reads a consistent
	# snapshot from a live database instead.
	psql_db "CREATE DATABASE \"$worktree_db\"" >/dev/null
	if ! docker exec "$PG_CONTAINER" sh -c \
		"pg_dump -U postgres '$SOURCE_DB' | psql -q -v ON_ERROR_STOP=1 -U postgres -d '$worktree_db'" >/dev/null; then
		echo "setup-worktree: failed to copy '$SOURCE_DB' into '$worktree_db'." >&2
		psql_db "DROP DATABASE IF EXISTS \"$worktree_db\"" >/dev/null || true
		exit 1
	fi
	echo "setup-worktree: created '$worktree_db' as a copy of '$SOURCE_DB'"
fi

# Point this worktree's .env at its own database, preserving the credentials,
# host and any query string from the URL we copied out of the main checkout.
current_url="$(sed -n 's/^DATABASE_URL=//p' .env | head -n1 | sed -e 's/^"//' -e 's/"$//')"
if [[ -z "$current_url" ]]; then
	echo "setup-worktree: no DATABASE_URL in .env, leaving it alone" >&2
else
	base="${current_url%%\?*}"
	query="${current_url#"$base"}"
	worktree_url="${base%/*}/${worktree_db}${query}"

	tmp_env="$(mktemp)"
	sed "s|^DATABASE_URL=.*|DATABASE_URL=\"$worktree_url\"|" .env >"$tmp_env"
	mv "$tmp_env" .env
	echo "setup-worktree: .env now points at '$worktree_db'"

	# The clone carries the main branch's migration history. If this branch is
	# behind, sqlx will refuse to run against applied-but-missing versions.
	if ! DATABASE_URL="$worktree_url" pnpm db:migrate; then
		echo "setup-worktree: migrations failed against '$worktree_db'." >&2
		echo "                If this branch predates migrations already applied on the" >&2
		echo "                template, drop it and start clean:" >&2
		echo "                  docker exec $PG_CONTAINER psql -U postgres -c 'DROP DATABASE \"$worktree_db\"'" >&2
		echo "                  docker exec $PG_CONTAINER psql -U postgres -c 'CREATE DATABASE \"$worktree_db\"'" >&2
		echo "                  pnpm setup:worktree" >&2
		exit 1
	fi
fi

echo "setup-worktree: done"
