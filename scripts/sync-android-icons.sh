#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/src-tauri/icons/icon.png"
ANDROID_ICONS_DIR="$ROOT_DIR/src-tauri/icons/android"
GENERATED_ANDROID_RES_DIR="$ROOT_DIR/src-tauri/gen/android/app/src/main/res"
TAURI_BINARY="$ROOT_DIR/node_modules/.bin/tauri"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/handypos-android-icons.XXXXXX")"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Missing shared Handy POS icon: $SOURCE_ICON"
  exit 1
fi

if [[ ! -x "$TAURI_BINARY" ]]; then
  echo "Tauri CLI not found at $TAURI_BINARY. Run npm ci first."
  exit 1
fi

"$TAURI_BINARY" icon "$SOURCE_ICON" --output "$TEMP_DIR"

if [[ ! -d "$TEMP_DIR/android" ]]; then
  echo "Tauri did not generate Android icon assets."
  exit 1
fi

mkdir -p "$ANDROID_ICONS_DIR"
rm -rf "$ANDROID_ICONS_DIR/mipmap-anydpi-v26" "$ANDROID_ICONS_DIR/mipmap-hdpi" \
  "$ANDROID_ICONS_DIR/mipmap-mdpi" "$ANDROID_ICONS_DIR/mipmap-xhdpi" \
  "$ANDROID_ICONS_DIR/mipmap-xxhdpi" "$ANDROID_ICONS_DIR/mipmap-xxxhdpi" \
  "$ANDROID_ICONS_DIR/values"
cp -R "$TEMP_DIR/android/." "$ANDROID_ICONS_DIR/"

# Tauri's Android template also copies this full-resolution source into the
# generated project. Keep it identical to the desktop icon source.
cp "$SOURCE_ICON" "$ANDROID_ICONS_DIR/handy_pos_icon.png"

# `tauri android init` materializes the launcher assets in this generated
# project. Update it too when it exists; otherwise the current CI run can
# still package stale icons even though the source assets were refreshed.
if [[ -d "$GENERATED_ANDROID_RES_DIR" ]]; then
  cp -R "$TEMP_DIR/android/." "$GENERATED_ANDROID_RES_DIR/"
  cp "$SOURCE_ICON" "$GENERATED_ANDROID_RES_DIR/handy_pos_icon.png"
fi

echo "Android launcher icons now match src-tauri/icons/icon.png"
