#!/usr/bin/env bash
# Builds the Arch Linux package (.pkg.tar.zst) from a release's .deb.
# Usage: make-package.sh <leverframe .deb> <tag, e.g. v0.7.0> <output directory>
# Runs on Arch Linux (makepkg). makepkg refuses to run as root; as root it runs as user "builder".
set -euo pipefail
deb=$(realpath "$1")
tag="$2"
out=$(mkdir -p "$3" && realpath "$3")
here=$(dirname "$(realpath "$0")")

version="${tag#v}"
# pkgver may not contain "-": 0.8.0-beta.1 → 0.8.0_beta.1
pkgver="${version//-/_}"
[[ "$pkgver" =~ ^[0-9][0-9A-Za-z._]*$ ]] || { echo "::error::Invalid version: $version" >&2; exit 1; }

work=$(mktemp -d)
cp "$deb" "$work/leverframe.deb"
sed -e "s/@PKGVER@/${pkgver}/" -e "s/@SHA256@/$(sha256sum "$deb" | cut -d' ' -f1)/" \
  "$here/PKGBUILD.in" > "$work/PKGBUILD"

# Dependencies are checked when the package is installed, not here (nothing is compiled).
if [ "$(id -u)" = 0 ]; then
  id builder >/dev/null 2>&1 || useradd -m builder
  chown -R builder "$work" "$out"
  runuser -u builder -- env -C "$work" PKGDEST="$out" makepkg --nodeps --noconfirm
else
  (cd "$work" && PKGDEST="$out" makepkg --nodeps --noconfirm)
fi
ls "$out"/leverframe-"${pkgver}"-1-x86_64.pkg.tar.zst
