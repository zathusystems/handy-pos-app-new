#!/bin/bash

# MRA EIS Sandbox Testing Quick Start Script
# Usage: bash mra_eis_sandbox_test.sh

set -e

echo "=========================================="
echo "MRA EIS Sandbox Testing Quick Start"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Django project is set up
if [ ! -f "manage.py" ]; then
    echo -e "${YELLOW}Error: manage.py not found. Please run this script from the Django project root.${NC}"
    exit 1
fi

echo -e "${BLUE}Step 1: Setting up test data...${NC}"
python manage.py setup_mra_sandbox_test_data --clean

echo ""
echo -e "${BLUE}Step 2: Running migrations...${NC}"
python manage.py migrate

echo ""
echo -e "${BLUE}Step 3: Creating superuser (if needed)...${NC}"
python manage.py shell << EOF
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(username='admin').exists():
    User.objects.create_superuser('admin', 'admin@test.com', 'admin123')
    print("✓ Superuser created: admin / admin123")
else:
    print("✓ Superuser already exists")
EOF

echo ""
echo -e "${GREEN}=========================================="
echo "Setup Complete!"
echo "==========================================${NC}"
echo ""
echo -e "${BLUE}Test Data Created:${NC}"
echo "  Business: MRA Sandbox Test Business"
echo "  TIN: 123456789"
echo "  Branch: Test Branch"
echo "  Terminal: TERM-TEST-001"
echo "  TAC: TAC-TEST-001"
echo "  Products: 3 test products"
echo ""
echo -e "${BLUE}Frontend Testing:${NC}"
echo "  1. Go to Settings → MRA EIS"
echo "  2. Enable EIS Integration"
echo "  3. Enter TIN: 123456789"
echo "  4. Save Settings"
echo "  5. Go to Terminal Activation"
echo "  6. Enter TAC: TAC-TEST-001"
echo "  7. Activate Terminal"
echo "  8. Go to POS and create a test sale"
echo ""
echo -e "${BLUE}Backend Testing:${NC}"
echo "  python manage.py shell"
echo "  from mra_eis.models import Terminal, MRAInvoice"
echo "  terminal = Terminal.objects.get(terminal_id='TERM-TEST-001')"
echo "  invoices = MRAInvoice.objects.filter(terminal=terminal)"
echo ""
echo -e "${BLUE}API Testing:${NC}"
echo "  curl -X GET http://localhost:8000/api/mra-eis/terminals/"
echo ""
echo -e "${YELLOW}Note: Make sure your MRA sandbox credentials are configured in settings.py${NC}"
echo ""
