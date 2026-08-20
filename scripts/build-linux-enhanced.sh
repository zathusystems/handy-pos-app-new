#!/bin/bash
# Enhanced build script for Handy POS (remote backend API)

set -euo pipefail

echo "Building Handy POS for Linux (remote backend API)..."
echo "====================================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Error: Rust/Cargo not found. Install from https://rustup.rs/${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm not found. Install Node.js from https://nodejs.org/${NC}"
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

# Step 1: Install Node dependencies
echo -e "${YELLOW}Step 1: Installing Node dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Node dependencies installed${NC}"
echo ""

# Step 2: Build Next.js frontend
echo -e "${YELLOW}Step 2: Building Next.js frontend...${NC}"
npm run build
echo -e "${GREEN}✓ Next.js frontend built${NC}"
echo ""

# Step 3: Build Tauri
echo -e "${YELLOW}Step 3: Building Tauri for Linux...${NC}"
npm run tauri build -- --target x86_64-unknown-linux-gnu
echo -e "${GREEN}✓ Tauri build complete${NC}"
echo ""

# Summary
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Build completed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Build artifacts:${NC}"
echo "  AppImage: src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/"
echo "  Deb: src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/"
echo ""
