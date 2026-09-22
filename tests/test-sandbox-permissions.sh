#!/usr/bin/env bash
# Reject permission regressions in built metadata, not just manifest text.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
CHECK=$REPO/scripts/check-sandbox-permissions.sh
pass=0

fixture() {
    cat <<'EOF'
[Application]
name=io.github.vivienm.ChatGPT
[Context]
shared=network;!ipc;
sockets=wayland;pulseaudio;!x11;!fallback-x11;
devices=dri;
persistent=.codex;.cache;
[Session Bus Policy]
org.kde.StatusNotifierWatcher=talk
org.freedesktop.StatusNotifierItem-2-1=own
EOF
}

fixture | "$CHECK"
pass=$((pass + 1))
# Serialization order and redundant explicit denials do not change grants.
fixture | sed 's/wayland;pulseaudio;!x11;!fallback-x11;/pulseaudio;wayland;/' | "$CHECK"
pass=$((pass + 1))

reject() {  # metadata on stdin
    if "$CHECK" >/dev/null 2>&1; then
        echo "FAIL: accepted $1" >&2
        exit 1
    fi
    echo "  ok   rejects $1"
}

for socket in x11 fallback-x11 session-bus; do
    fixture | sed "s/^sockets=.*/sockets=wayland;pulseaudio;$socket;/" | reject "$socket"
    pass=$((pass + 1))
done
fixture | sed 's/^shared=.*/shared=network;ipc;/' | reject 'shared IPC'
fixture | sed '/^devices=/a filesystems=home;' | reject 'home access'
fixture | sed 's/^devices=.*/devices=all;/' | reject 'all devices'
pass=$((pass + 3))
for service in org.freedesktop.secrets org.kde.kwalletd5 org.kde.kwalletd6 org.freedesktop.Flatpak; do
    { fixture; printf '%s=talk\n' "$service"; } | reject "$service"
    pass=$((pass + 1))
done
{ fixture; printf '[System Bus Policy]\norg.example.Service=talk\n'; } |
    reject 'system bus access'
printf '' | reject 'empty metadata'
pass=$((pass + 2))
echo "sandbox permissions: $pass passed"
