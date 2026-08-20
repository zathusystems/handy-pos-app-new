#!/bin/bash

# Development startup script for Tauri + Django
# Starts all services needed for development

set -e

echo "=========================================="
echo "Handy POS - Development Environment"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if concurrently is installed
if ! npm list concurrently > /dev/null 2>&1; then
    echo -e "${YELLOW}Installing concurrently...${NC}"
    npm install --save-dev concurrently
fi

echo -e "${GREEN}Starting development environment...${NC}"
echo ""
echo "Services starting:"
echo "  - Django Backend: http://127.0.0.1:8000"
echo "  - Next.js Frontend: http://localhost:3000"
echo "  - Tauri Window: Will open automatically"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Run all services concurrently
npm run dev:all
