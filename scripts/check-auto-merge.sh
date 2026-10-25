#!/usr/bin/env bash
# gh pr merge --auto can merge immediately when main has no required checks.
# Require the classic branch protection documented in README before arming it.
set -euo pipefail

repo=${1:?usage: check-auto-merge.sh OWNER/REPO}
required=$(gh api "repos/$repo/branches/main/protection/required_status_checks" \
    --jq '(.contexts + [.checks[]?.context]) | unique | .[]') || {
    echo "auto-merge: cannot verify required checks on main; refusing to merge" >&2
    echo "Configure classic branch protection with shellcheck, lint, build (x86_64), build (aarch64)." >&2
    exit 1
}

for check in shellcheck lint 'build (x86_64)' 'build (aarch64)'; do
    if ! grep -Fxq -- "$check" <<<"$required"; then
        echo "auto-merge: main does not require '$check'; refusing to merge" >&2
        exit 1
    fi
done
echo "auto-merge: all four checks are required on main"
