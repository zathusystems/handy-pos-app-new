#!/usr/bin/env bash

set -euo pipefail

echo "Building Handy POS for Linux (.deb)..."

npm run build
npm run tauri:build:linux

echo "Linux build complete."
echo "Artifacts: src-tauri/target/release/bundle/deb/"
