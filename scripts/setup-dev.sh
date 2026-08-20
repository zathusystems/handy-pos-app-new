#!/bin/bash
# Development setup for Handy POS

set -e

echo "🚀 Handy POS Development Setup"
echo ""

# Check prerequisites
echo "✓ Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org/"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found. Install from https://python.org/"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo "❌ Rust not found. Install from https://rustup.rs/"
    exit 1
fi

echo "✓ All prerequisites found"
echo ""

# Setup frontend
echo "📦 Setting up frontend..."
cd frontend
npm install
cd ..

# Setup backend
echo "📦 Setting up backend..."
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
deactivate
cd ..

# Install Tauri CLI
echo "📦 Installing Tauri CLI..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo ""
echo "Terminal 1 - Start Django backend:"
echo "  cd backend"
echo "  source venv/bin/activate"
echo "  python manage.py runserver 127.0.0.1:8000"
echo ""
echo "Terminal 2 - Start Tauri dev:"
echo "  npm run tauri:dev"
echo ""
