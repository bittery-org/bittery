#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

name_a="$(scripts/worktree-db-name.sh 'feature/foo-bar' '/repo/.git/worktrees/one')"
name_b="$(scripts/worktree-db-name.sh 'feature/foo_bar' '/repo/.git/worktrees/two')"
[[ "$name_a" != "$name_b" ]]

long_prefix=feature/this-is-a-very-long-branch-name-whose-readable-prefix-collides
name_c="$(scripts/worktree-db-name.sh "${long_prefix}-one" '/repo/.git/worktrees/three')"
name_d="$(scripts/worktree-db-name.sh "${long_prefix}-two" '/repo/.git/worktrees/four')"
[[ "$name_c" != "$name_d" ]]

same_branch_a="$(scripts/worktree-db-name.sh 'feature/same-branch' '/repo/.git/worktrees/five')"
same_branch_b="$(scripts/worktree-db-name.sh 'feature/same-branch' '/repo/.git/worktrees/six')"
[[ "$same_branch_a" != "$same_branch_b" ]]

for name in "$name_a" "$name_b" "$name_c" "$name_d" "$same_branch_a" "$same_branch_b"; do
	[[ ${#name} -le 63 ]]
	[[ "$name" =~ ^[a-z0-9_]+$ ]]
done
