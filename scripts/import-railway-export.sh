#!/usr/bin/env bash
set -euo pipefail

# Import a Railway Object Storage export into this repository.
# Usage: ./scripts/import-railway-export.sh /path/to/patamu-assets.zip
#
# The export is preserved under storage-export/releases/<release>/ so the
# original object keys and release directories remain intact.

REPO_ROOT="$(git rev-parse --show-toplevel)"
ZIP_PATH="${1:?Usage: $0 /path/to/patamu-assets.zip}"
MANIFEST="$REPO_ROOT/assets/manifest.json"
CURRENT_RELEASE="c6391673b5e2a647135a5af1ce65316c67dc2970"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v shasum >/dev/null || { echo "shasum is required" >&2; exit 1; }
test -f "$MANIFEST" || { echo "Missing $MANIFEST" >&2; exit 1; }
test -f "$ZIP_PATH" || { echo "Archive not found: $ZIP_PATH" >&2; exit 1; }

unzip -q "$ZIP_PATH" -d "$TMP_DIR"
EXPORT_ROOT="$TMP_DIR/patamu-assets"
test -d "$EXPORT_ROOT/releases" || { echo "Archive does not contain patamu-assets/releases/" >&2; exit 1; }

# Verify every manifest entry against its release-specific object before copying.
checked=0
while IFS=$'\t' read -r object_path release expected_hash expected_size; do
  source="$EXPORT_ROOT/releases/$release/$object_path"
  test -f "$source" || { echo "Missing object: releases/$release/$object_path" >&2; exit 1; }
  actual_size="$(wc -c < "$source" | tr -d ' ')"
  actual_hash="$(shasum -a 256 "$source" | awk '{print $1}')"
  test "$actual_size" = "$expected_size" || {
    echo "Size mismatch: $object_path (expected $expected_size, got $actual_size)" >&2
    exit 1
  }
  test "$actual_hash" = "$expected_hash" || {
    echo "SHA-256 mismatch: $object_path" >&2
    exit 1
  }
  checked=$((checked + 1))
done < <(jq -r --arg current "$CURRENT_RELEASE" 'to_entries[] | [.key, (.value.release // $current), .value.sha256, (.value.size|tostring)] | @tsv' "$MANIFEST")

test "$checked" -gt 0 || { echo "Manifest was empty" >&2; exit 1; }

mkdir -p "$REPO_ROOT/storage-export"
cp -a "$EXPORT_ROOT/releases" "$REPO_ROOT/storage-export/"

echo "Verified $checked manifest objects."
echo "Imported release directories into storage-export/releases/."
echo "Review the files, then run:"
echo "  git add storage-export/releases"
echo "  git commit -m 'Add Railway Object Storage export'"
echo "  git push"
