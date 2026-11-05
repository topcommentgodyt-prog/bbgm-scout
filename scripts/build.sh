#!/usr/bin/env bash
# Builds the installable ZIPs into dist/ (Chrome/Edge/Brave/Arc and Firefox).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
mkdir -p "$tmp/c/bbgm-scout" "$tmp/f/bbgm-scout" dist
cp -r manifest.json src popup icons README.md LICENSE "$tmp/c/bbgm-scout/"
cp -r src popup icons README.md LICENSE "$tmp/f/bbgm-scout/"
cp manifest.firefox.json "$tmp/f/bbgm-scout/manifest.json"
rm -f dist/bbgm-scout.zip dist/bbgm-scout-firefox.zip
(cd "$tmp/c" && zip -qrX "$OLDPWD/dist/bbgm-scout.zip" bbgm-scout)
(cd "$tmp/f" && zip -qrX "$OLDPWD/dist/bbgm-scout-firefox.zip" bbgm-scout)
rm -rf "$tmp"
echo "Built dist/bbgm-scout.zip and dist/bbgm-scout-firefox.zip ($(grep -o '"version": "[^"]*"' manifest.json))"
