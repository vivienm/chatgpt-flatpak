#!/usr/bin/env bash
# Check installed Flatpak metadata on stdin, including inherited grants.
set -euo pipefail

# Normalize only permission-bearing fields. Flatpak represents explicit denials
# with a leading ! in Context, and with "none" in D-Bus policies.
actual=$(awk '
    function trim(s) {
        sub(/^[[:space:]]+/, "", s)
        sub(/[[:space:]]+$/, "", s)
        return s
    }
    /^[[:space:]]*($|#|;)/ { next }
    /^\[/ { section = $0; sub(/\r$/, "", section); next }
    {
        separator = index($0, "=")
        if (!separator) next
        key = trim(substr($0, 1, separator - 1))
        value = trim(substr($0, separator + 1))
        if (section == "[Context]" &&
            key ~ /^(shared|sockets|devices|filesystems|features|persistent)$/) {
            count = split(value, values, ";")
            for (i = 1; i <= count; i++) {
                grant = trim(values[i])
                if (grant != "" && grant !~ /^!/) print section, key "=" grant
            }
        } else if ((section == "[Session Bus Policy]" ||
                    section == "[System Bus Policy]") && value != "none") {
            print section, key "=" value
        }
    }
' | LC_ALL=C sort)

expected=$(LC_ALL=C sort <<'EOF'
[Context] shared=network
[Context] sockets=wayland
[Context] sockets=pulseaudio
[Context] devices=dri
[Context] persistent=.codex
[Context] persistent=.cache
[Session Bus Policy] org.freedesktop.secrets=talk
[Session Bus Policy] org.kde.StatusNotifierWatcher=talk
[Session Bus Policy] org.freedesktop.StatusNotifierItem-2-1=own
EOF
)

if ! diff -u --label expected --label actual \
    <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"); then
    echo "Unexpected sandbox permissions" >&2
    exit 1
fi
echo "sandbox permissions OK: Wayland, private IPC, Secret Service only"
