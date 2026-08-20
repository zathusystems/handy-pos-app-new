#!/usr/bin/env bash

set -euo pipefail

echo "Building Handy POS for Windows (MSI + NSIS)..."

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required. Install Rust toolchain first."
  exit 1
fi

if ! rustup target list --installed | grep -q "^x86_64-pc-windows-msvc$"; then
  echo "Rust target x86_64-pc-windows-msvc is not installed."
  echo "Run: rustup target add x86_64-pc-windows-msvc"
  exit 1
fi

if [[ -z "${NEXT_PUBLIC_API_URL:-}" ]]; then
  export NEXT_PUBLIC_API_URL="https://api.handypos.online/api"
fi
if [[ -z "${NEXT_PUBLIC_API_BASE_URL:-}" ]]; then
  export NEXT_PUBLIC_API_BASE_URL="https://api.handypos.online/api"
fi
if [[ -z "${NEXT_PUBLIC_DJANGO_URL:-}" ]]; then
  export NEXT_PUBLIC_DJANGO_URL="https://api.handypos.online"
fi

npm run build
npm run tauri:build:windows:x64

echo "Windows build complete."
echo "Artifacts: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{msi,nsis}/"
