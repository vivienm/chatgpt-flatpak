#!/usr/bin/env bash
# Exercise the refusal paths without touching repository settings or a real PR.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cat > "$fixture/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'api repos/example/repo/branches/main/protection/required_status_checks --jq '* ]]
case "$SCENARIO" in
    protected) printf '%s\n' shellcheck lint 'build (x86_64)' 'build (aarch64)' ;;
    partial) printf '%s\n' shellcheck lint 'build (x86_64)' ;;
    misleading) printf '%s\n' shellcheck lint 'build (x86_64)' 'old build (aarch64)' ;;
    empty) ;;
    unavailable) exit 1 ;;
esac
MOCK
chmod +x "$fixture/gh"
export PATH="$fixture:$PATH"
SCENARIO=protected "$repo/scripts/check-auto-merge.sh" example/repo
for scenario in partial misleading empty unavailable; do
    if SCENARIO=$scenario "$repo/scripts/check-auto-merge.sh" example/repo > "$fixture/output" 2>&1; then
        echo "unexpected auto-merge approval: $scenario" >&2
        exit 1
    fi
    grep -Fq 'refusing to merge' "$fixture/output"
done
# The guard must run before gh is allowed to arm or perform a merge.
python3 - "$repo/.github/workflows/update-check.yml" <<'PY'
import pathlib, sys
workflow = pathlib.Path(sys.argv[1]).read_text()
assert workflow.index('./scripts/check-auto-merge.sh "$GH_REPO"') < workflow.index('gh pr merge "$num"')
PY
echo "auto-merge guard: protected, missing, partial and unavailable checks passed"
