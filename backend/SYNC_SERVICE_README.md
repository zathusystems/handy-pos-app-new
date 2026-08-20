# Standalone Cloud Sync Service

Centralized, independent sync manager for all system operations across all apps.

## Location

**Standalone files** (not tied to any app):
- `/backend/sync_service.py` - Main sync manager
- `/backend/sync_views.py` - API endpoints
- `/backend/core/management/commands/sync_cloud.py` - CLI command

## How to Use

### 1. Via Management Command

```bash
# Sync all dirty records
python manage.py sync_cloud

# Check sync status without syncing
python manage.py sync_cloud --status

# Custom cloud URL
python manage.py sync_cloud --cloud-url http://custom-cloud.com:8001
```

### 2. Via API Endpoints

```bash
# Sync all dirty records
curl -X POST http://localhost:8000/api/sync-to-cloud/ \
  -H "Authorization: Bearer <token>"

# Check sync status
curl http://localhost:8000/api/sync-status/ \
  -H "Authorization: Bearer <token>"
```

### 3. Programmatically

```python
from sync_service import sync_all_to_cloud, get_sync_status

# Sync everything
results = sync_all_to_cloud()
print(f"Synced: {results['total_synced']}, Failed: {results['total_failed']}")

# Check status
status = get_sync_status()
print(f"Total dirty records: {status['total_dirty']}")
```

## What It Syncs

Automatically handles all models from all apps:

**Business App:**
- Business, Branch, TaxRate, BusinessSettings
- Customer, InvoiceLine, Invoice, Expense

**Inventory App:**
- Product, Stock, Supplier, Purchase, PurchaseRecord, Waste

**Staff App:**
- Staff

**Subscription App:**
- Subscription

## Configuration

Set in `settings.py`:

```python
CLOUD_BACKEND_URL = os.getenv('CLOUD_BACKEND_URL', 'http://localhost:8001')
```

Or via environment variable:

```bash
export CLOUD_BACKEND_URL=http://cloud.example.com:8001
```

## Sync Report

Returns comprehensive report:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "cloud_url": "http://localhost:8001",
  "total_models": 8,
  "total_records": 25,
  "total_synced": 24,
  "total_failed": 1,
  "models": {
    "Invoice": {
      "total": 10,
      "synced": 10,
      "failed": 0,
      "records": [...]
    }
  }
}
```

## Architecture

```
sync_service.py (CloudSyncManager)
    ├── Registers all models from all apps
    ├── Finds all dirty records
    ├── Serializes records
    ├── Sends to cloud backend
    └── Marks as synced

sync_views.py (API endpoints)
    ├── /api/sync-to-cloud/ (POST)
    └── /api/sync-status/ (GET)

core/management/commands/sync_cloud.py (CLI)
    └── python manage.py sync_cloud
```

## Single Point of Sync

All system operations sync through this one centralized service:
- Not tied to any app
- Easy to manage and maintain
- Can be used from anywhere in the project
- Handles all models automatically

## Features

✅ Centralized sync for all apps
✅ Automatic model registration
✅ Comprehensive error handling
✅ Detailed sync reports
✅ CLI and API access
✅ Programmatic access
✅ Status checking
✅ Logging

Done!





Bless Jasi
jasibless@gmail.com
Fyness
fyness265mw@gmail.com
Signed out
Handy pos receipts
handyposreceipts@gmail.com
Signed out
brown mwase
brownmwase265@gmail.com
Signed out
Ethan Malembo
ethan265mw@gmail.com
Signed out
Ibrahim
ibrahim22mw@gmail.com
Lindazathu
lindazathu265@gmail.com
Signed out
Hanneck Malembo
zathusystems@gmail.com
hanneck malembo
mudzimw@gmail.com
Signed out
Hanneck Malembo
malembohanneck@gmail.com
Jamizo
jamizomw@gmail.com
Hanneck
zathusys@gmail.com
Precious Msonda
preciousmsonda55@gmail.com
Lestina
lestina265mwa@gmail.com
Gasten
gasten265mw@gmail.com
Brightmwa
brightmwa020@gmail.com




Category
Select your product's primary category and features.
Initially, your product will be listed in one category on our marketplace. Once your product is published, you can request for it to be added to other relevant categories.
To ensure catalog accuracy and integrity, our team will make the final category placement decision.
Restaurant POS
Select at least 7 features that best describe your product offering
27 of 54
Online Ordering
Loyalty Program
Barcode/Ticket Scanning
Access Controls/Permissions
Data Import/Export
Purchase Order Management
Gift Card Management
Discount Management
Credit Card Processing
Returns Management
Point of Sale (POS)
Customizable Reports
Mobile Access
Inventory Tracking
Activity Dashboard
Accounting Integration
Real-Time Data
Barcode Recognition
Split Checks
Tips Management
API
Third-Party Integrations
Order Tracking
Customer History
Real-Time Updates
Delivery Management
Reporting/Analytics
Reporting & Statistics
Receipt Management
Order Entry
Sales Tax Management
Order Management
Inventory Management
Electronic Payments
Stock Management
Sales Trend Analysis
Cash Management
Multi-Location
Employee Management
Promotions Management
Offline Access
Customer Database
Transaction History
Separate Checks
Table Management
Sales Reports
Real-Time Reporting
Alerts/Notifications
Reservations Management
Price/Margin Management
For Restaurants
Payment Processing
Generative AI
AI Copilot
Back
Save & Continue


server {

    server_name app.handypos.online www.handypos.online handypos.online;

    root /home/handypos-app;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /_next/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/handypos.online-0001/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/handypos.online-0001/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot



} 
server {
    if ($host = app.handypos.online) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    server_name app.handypos.online;
    return 404; # managed by Certbot



    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/app.handypos.online/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/app.handypos.online/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}

server {
    if ($host = app.handypos.online) {
        return 301 https://$host$request_uri;
    } # managed by Certbot




    listen 80;
    listen [::]:80;

    server_name app.handypos.online;
    return 404; # managed by Certbot


}


Kitchen/order modal UI needs to display selected options clearly

POS “process sale from order” needs to make sure selected options are carried into the POS sale payload

Menu management UI is basic; it needs edit/delete options, better recipe builder, required/max selection polish

Reports/session stock tracking should display option-driven ingredient usage more clearly

Printable bills/receipts should show selected sides/options under the meal

Need wider regression test around order-to-POS sale processing with selected options