#!/usr/bin/env python3
"""Check the installed Flatpak metadata (stdin), including inherited grants."""

import configparser
import sys


def check(metadata):
    errors = []
    allowed = {
        "shared": {"network"},
        "sockets": {"wayland", "pulseaudio"},
        "devices": {"dri"},
        "filesystems": set(),
        "features": set(),
        "persistent": {".codex", ".cache"},
    }
    for key, expected in allowed.items():
        # Flatpak serializes explicit denials with a leading '!'. They do not
        # grant access and need not be present when the builder normalizes it.
        actual = {
            value for value in metadata.get("Context", key, fallback="").split(";")
            if value and not value.startswith("!")
        }
        if actual != expected:
            errors.append(f"Context.{key}: expected {sorted(expected)}, got {sorted(actual)}")

    session_policy = {
        "org.freedesktop.secrets": "talk",
        "org.kde.StatusNotifierWatcher": "talk",
        "org.freedesktop.StatusNotifierItem-2-1": "own",
    }
    for section, expected in (
        ("Session Bus Policy", session_policy),
        ("System Bus Policy", {}),
    ):
        actual = {
            name: policy for name, policy in metadata.items(section)
            if policy != "none"
        } if metadata.has_section(section) else {}
        if actual != expected:
            errors.append(f"{section}: expected {expected}, got {actual}")
    return errors


if __name__ == "__main__":
    metadata = configparser.ConfigParser(interpolation=None)
    metadata.optionxform = str  # D-Bus names are case-sensitive.
    metadata.read_file(sys.stdin)
    errors = check(metadata)
    if errors:
        sys.exit("Unexpected sandbox permissions:\n" + "\n".join(errors))
    print("sandbox permissions OK: Wayland, private IPC, Secret Service only")
