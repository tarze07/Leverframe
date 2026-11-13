#!/usr/bin/env bash
# Installs the built package with its dependencies (Arch Linux, as root) and checks that the
# binary finds every library and the desktop entry is in place.
# Usage: check-package.sh <leverframe .pkg.tar.zst>
set -euo pipefail
pacman -U --noconfirm --needed "$1"
pacman -Qi leverframe | grep -E '^(Name|Version|Depends On)'
missing=$(ldd /usr/bin/leverframe | grep 'not found' || true)
if [ -n "$missing" ]; then
  echo "::error::Missing libraries:"; echo "$missing"; exit 1
fi
test -f /usr/share/applications/Leverframe.desktop
test -f /usr/share/icons/hicolor/128x128/apps/leverframe.png
echo "OK: all libraries found"
