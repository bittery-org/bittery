#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "usage: $0 <branch-name> <absolute-worktree-git-dir>" >&2
	exit 2
fi

branch=$1
worktree_git_dir=$2

if [[ "$worktree_git_dir" != /* ]]; then
	echo "worktree Git directory must be absolute" >&2
	exit 2
fi

prefix=bittery_wt_
hash_length=12
# prefix + 39-char slug + separator + 12-char hash = 63 characters.
slug_length=39

slug="$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed -e 's/__*/_/g' -e 's/^_//' -e 's/_$//' | cut -c1-$slug_length)"
[[ -n "$slug" ]] || slug=worktree

# git hash-object is already required by setup-worktree.sh and behaves the
# same on macOS and Linux, unlike platform-specific SHA utility names.
git_dir_hash="$(printf '%s' "$worktree_git_dir" | git hash-object --stdin | cut -c1-$hash_length)"
printf '%s%s_%s\n' "$prefix" "$slug" "$git_dir_hash"
