#!/usr/bin/env bash
# Prints the id of the GitHub Release for $TAG, creating a draft (notes from CHANGELOG.md) if needed.
# Used by .github/workflows/release.yml. Needs: gh (authenticated), node, GITHUB_REPOSITORY, TAG.
set -euo pipefail

version="${TAG#v}"
prerelease=false
case "$version" in *-*) prerelease=true ;; esac

numeric() { [[ "$1" =~ ^[0-9]+$ ]]; }

# Releases are listed with drafts included (the by-tag endpoint skips drafts and answers 404 –
# and gh then prints the error body, which must never be taken for an id).
id=""
if out=$(gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --jq ".[] | select(.tag_name == \"${TAG}\") | .id" 2>/dev/null); then
  id=$(printf '%s\n' "$out" | head -n 1)
fi

if numeric "$id"; then
  echo "Reusing release $id for $TAG" >&2
else
  node scripts/release-notes.mjs "$version" > notes.md
  id=$(gh api -X POST "repos/${GITHUB_REPOSITORY}/releases" \
    -f tag_name="$TAG" -f name="Leverframe $version" \
    -F draft=true -F prerelease="$prerelease" -F body=@notes.md --jq .id)
  echo "Created draft release $id for $TAG" >&2
fi

if ! numeric "$id"; then
  echo "::error::Could not determine the release id for $TAG (got: $id)" >&2
  exit 1
fi
echo "$id"
