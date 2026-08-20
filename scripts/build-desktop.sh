#!/bin/bash

# Handy POS Desktop App Build Script
# Builds the Tauri desktop app using the remote backend API (no bundled backend)

set -euo pipefail

echo "=========================================="
echo "Handy POS - Desktop App Builder"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed${NC}"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Error: Rust/Cargo is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✓ All prerequisites found${NC}"
echo ""

# Ensure remote API defaults for build-time config
if [[ -z "${NEXT_PUBLIC_API_URL:-}" ]]; then
    export NEXT_PUBLIC_API_URL="https://api.handypos.online/api"
fi
if [[ -z "${NEXT_PUBLIC_API_BASE_URL:-}" ]]; then
    export NEXT_PUBLIC_API_BASE_URL="https://api.handypos.online/api"
fi
if [[ -z "${NEXT_PUBLIC_DJANGO_URL:-}" ]]; then
    export NEXT_PUBLIC_DJANGO_URL="https://api.handypos.online"
fi

# Install Node dependencies
echo -e "${YELLOW}Installing Node dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Node dependencies installed${NC}"
echo ""

# Build Next.js
echo -e "${YELLOW}Building Next.js frontend...${NC}"
npm run build
echo -e "${GREEN}✓ Next.js build completed${NC}"
echo ""

# Build Tauri
echo -e "${YELLOW}Building Tauri application...${NC}"
npm run build:tauri
echo -e "${GREEN}✓ Tauri build completed${NC}"
echo ""

# Show build output location
echo -e "${GREEN}=========================================="
echo "Build completed successfully!"
echo "==========================================${NC}"
echo ""
echo "Build artifacts are located in:"
echo "  src-tauri/target/release/bundle/"
echo ""
echo "Platform-specific installers:"
if [ "$(uname)" == "Linux" ]; then
    echo "  - .AppImage (portable)"
    echo "  - .deb (Debian/Ubuntu)"
elif [ "$(uname)" == "Darwin" ]; then
    echo "  - .dmg (macOS)"
else
    echo "  - .msi (Windows)"
fi
echo ""
