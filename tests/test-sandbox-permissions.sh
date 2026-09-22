#!/usr/bin/env bash
# Reject permission regressions in built metadata, not just manifest text.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
python3 -B - "$REPO" <<'PY'
import importlib.util
import configparser
import sys

spec = importlib.util.spec_from_file_location(
    "permissions", sys.argv[1] + "/scripts/check-sandbox-permissions.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

fixture = """
[Context]
shared=network;!ipc;
sockets=wayland;pulseaudio;!x11;!fallback-x11;
devices=dri;
persistent=.codex;.cache;
[Session Bus Policy]
org.freedesktop.secrets=talk
org.kde.StatusNotifierWatcher=talk
org.freedesktop.StatusNotifierItem-2-1=own
"""


def metadata():
    result = configparser.ConfigParser(interpolation=None)
    result.optionxform = str
    result.read_string(fixture)
    return result


assert not module.check(metadata()), "valid permissions rejected"
for section, key, value in (
    ("Context", "sockets", "wayland;pulseaudio;x11;"),
    ("Context", "sockets", "wayland;pulseaudio;fallback-x11;"),
    ("Context", "sockets", "wayland;pulseaudio;session-bus;"),
    ("Context", "shared", "network;ipc;"),
    ("Context", "filesystems", "home;"),
    ("Context", "devices", "all;"),
    ("Session Bus Policy", "org.kde.kwalletd5", "talk"),
    ("Session Bus Policy", "org.kde.kwalletd6", "talk"),
    ("Session Bus Policy", "org.freedesktop.Flatpak", "talk"),
    ("Session Bus Policy", "org.freedesktop.secrets", "none"),
):
    candidate = metadata()
    candidate.set(section, key, value)
    assert module.check(candidate), f"unsafe or broken permission accepted: {key}={value}"
    print(f"  ok   rejects {key}={value}")
print("sandbox permissions: valid policy accepted, 10 regressions rejected")
PY
