#!/usr/bin/env bash
# Exercise repeated fork renaming, including raw screenshot URLs.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/Makefile" "$work/Makefile"
cp "$root"/*.ChatGPT.yaml "$work/"
mkdir "$work/build-aux"
cp "$root"/build-aux/*.metainfo.xml "$work/build-aux/"

for owner in fork-test-a fork-test-b; do
    make -s -C "$work" rename GH_USER="$owner"
    test -f "$work/io.github.$owner.ChatGPT.yaml"
    metadata="$work/build-aux/io.github.$owner.ChatGPT.metainfo.xml"
    test -f "$metadata"
    grep -Fq "<id>io.github.$owner.ChatGPT</id>" "$metadata"
    grep -Fq "https://github.com/$owner/chatgpt-flatpak/issues" "$metadata"
    grep -Fq "https://raw.githubusercontent.com/$owner/chatgpt-flatpak/" "$metadata"
    before=$(sha256sum "$metadata" "$work/Makefile")
    make -s -C "$work" rename GH_USER="$owner"
    test "$before" = "$(sha256sum "$metadata" "$work/Makefile")"
done
echo 'rename: repeated renames, screenshot URLs and idempotence passed'
