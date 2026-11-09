#!/usr/bin/env bash
# Uploads a file to a (possibly draft) release by id, replacing an asset with the same name.
# Usage: upload-release-asset.sh <release id> <file>. Needs: gh, GITHUB_REPOSITORY.
set -euo pipefail
release_id="$1"
file="$2"
name=$(basename "$file")
[[ "$release_id" =~ ^[0-9]+$ ]] || { echo "::error::Invalid release id: $release_id" >&2; exit 1; }

existing=$(gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}/assets?per_page=100" --jq ".[] | select(.name == \"${name}\") | .id")
for asset in $existing; do
  gh api -X DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/${asset}" >/dev/null
  echo "Replaced existing $name" >&2
done
gh api -X POST "https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${release_id}/assets?name=${name}" \
  -H "Content-Type: application/octet-stream" --input "$file" --jq .browser_download_url
