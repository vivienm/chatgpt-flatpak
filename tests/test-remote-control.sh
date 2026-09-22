#!/usr/bin/env sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=${NODE:-}
[ -n "$node_bin" ] || node_bin=$(command -v node 2>/dev/null || true)
[ -n "$node_bin" ] || node_bin=$(command -v nodejs 2>/dev/null || true)
[ -n "$node_bin" ] || { echo "node is required for remote-control tests" >&2; exit 1; }
"$node_bin" --test "$repo/tests/test-remote-control.js" "$repo/tests/test-device-key.js"
