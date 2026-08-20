# MRA EIS - Migration & Deployment Guide

## Pre-Deployment Checklist

### Code Review
- [ ] Review all models in `models.py`
- [ ] Review all services in `services.py`
- [ ] Review all API endpoints in `views.py`
- [ ] Review admin configuration in `admin.py`
- [ ] Review test coverage in `tests.py`

### Configuration
- [ ] Update `settings.py` with MRA configuration
- [ ] Set environment variables
- [ ] Configure logging
- [ ] Setup periodic tasks
- [ ] Configure error alerts

### Database
- [ ] Backup existing database
- [ ] Test migrations on staging
- [ ] Verify migration rollback plan
- [ ] Check database indexes

### Security
- [ ] Review credential storage
- [ ] Setup encryption (if needed)
- [ ] Configure HTTPS
- [ ] Setup firewall rules
- [ ] Review access controls

## Step-by-Step Deployment

### 1. Backup Existing Database

```bash
# SQLite
cp backend/db.sqlite3 backend/db.sqlite3.backup

# PostgreSQL
pg_dump handy_pos > handy_pos_backup.sql

# MySQL
mysqldump -u user -p handy_pos > handy_pos_backup.sql
```

### 2. Update Django Settings

Add to `backend/core/settings.py`:

```python
INSTALLED_APPS = [
    # ... existing apps ...
    'mra_eis',
]

# MRA EIS Configuration
MRA_EIS_API_URL = os.getenv('MRA_EIS_API_URL', 'https://api.mra.gov.mw/eis')
MRA_EIS_SANDBOX_MODE = os.getenv('MRA_EIS_SANDBOX_MODE', 'True') == 'True'
MRA_EIS_TIMEOUT = int(os.getenv('MRA_EIS_TIMEOUT', '30'))
```

### 3. Update URL Configuration

Add to `backend/core/urls.py`:

```python
urlpatterns = [
    # ... existing patterns ...
    path('api/mra/', include('mra_eis.urls')),
]
```

### 4. Create Migrations

```bash
cd backend

# Create migrations
python manage.py makemigrations mra_eis

# Review migrations
python manage.py showmigrations mra_eis

# Test migrations on staging
python manage.py migrate mra_eis --plan
```

### 5. Run Migrations

```bash
# Development
python manage.py migrate mra_eis

# Production (with backup)
python manage.py migrate mra_eis --no-input
```

### 6. Create Initial Data

```bash
# Create superuser (if not exists)
python manage.py createsuperuser

# Create TAC codes
python manage.py shell
```

```python
from mra_eis.models import TerminalActivationCode
from business.models import Business
from datetime import timedelta
from django.utils import timezone

business = Business.objects.first()

# Create TAC for testing
tac = TerminalActivationCode.objects.create(
    business=business,
    code='TAC-PROD-001',
    status='unused',
    expires_at=timezone.now() + timedelta(days=365)
)

print(f"Created TAC: {tac.code}")
```

### 7. Verify Installation

```bash
# Check models are registered
python manage.py showmigrations mra_eis

# Check admin is accessible
python manage.py runserver
# Visit http://localhost:8000/admin/

# Run tests
python manage.py test mra_eis
```

### 8. Setup Periodic Tasks

#### Option A: Cron

```bash
# Edit crontab
crontab -e

# Add:
0 2 * * * cd /path/to/project && python manage.py sync_mra_config
*/5 * * * * cd /path/to/project && python manage.py process_mra_retries
```

#### Option B: Celery

```bash
# Install Celery
pip install celery redis

# Create tasks.py (see SETTINGS_TEMPLATE.md)

# Start Celery worker
celery -A core worker -l info

# Start Celery beat
celery -A core beat -l info
```

### 9. Configure Monitoring

```python
# In settings.py

# Email alerts
ADMINS = [('Admin', 'admin@example.com')]

# Error tracking (optional)
import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration

sentry_sdk.init(
    dsn="your-sentry-dsn",
    integrations=[DjangoIntegration()],
    traces_sample_rate=0.1,
)
```

### 10. Test All Flows

```bash
# Run full test suite
python manage.py test mra_eis

# Test specific flows
python manage.py test mra_eis.tests.TerminalActivationTests
python manage.py test mra_eis.tests.InvoiceTests
python manage.py test mra_eis.tests.OfflineInvoiceTests
```

## Integration with Existing POS

### 1. Extend BusinessSettings

```python
# In business/models.py

class BusinessSettings(models.Model):
    # ... existing fields ...
    
    mra_tin = models.CharField(max_length=50, blank=True)
    mra_enabled = models.BooleanField(default=False)
    mra_sandbox_mode = models.BooleanField(default=True)
```

### 2. Extend Order Model

```python
# In pos_sessions/models.py

class Order(models.Model):
    # ... existing fields ...
    
    mra_invoice_id = models.CharField(max_length=255, blank=True, null=True)
    mra_status = models.CharField(max_length=20, blank=True)
```

### 3. Hook into Order Completion

```python
# In pos_sessions/views.py

from mra_eis.services import InvoiceService, ProductMappingService, ReceiptService

def complete_order(order):
    """Complete order and submit to MRA"""
    
    # Get terminal
    terminal = Terminal.objects.filter(
        branch=order.branch,
        status='active'
    ).first()
    
    if not terminal:
        raise ValueError("No active terminal")
    
    # Prepare items
    items = []
    for order_item in order.items.all():
        mapping = ProductMappingService.validate_product_for_sale(
            order.business,
            str(order_item.inventory_item_id)
        )
        items.append({
            'mra_product_code': mapping.mra_product_code,
            'name': order_item.name,
            'quantity': order_item.quantity,
            'unit_price': order_item.price,
            'tax_rate': mapping.tax_rate,
            'tax_category': mapping.tax_category,
        })
    
    # Create invoice
    mra_invoice = InvoiceService.create_invoice(
        terminal=terminal,
        seller_tin=order.business.settings.mra_tin,
        seller_name=order.business.name,
        items=items,
        is_online=terminal.is_online
    )
    
    # Submit or queue
    if terminal.is_online:
        InvoiceService.submit_invoice(mra_invoice)
    else:
        InvoiceService.queue_offline_invoice(mra_invoice)
    
    # Generate receipt
    receipt = ReceiptService.generate_receipt(mra_invoice)
    
    # Link to order
    order.mra_invoice_id = str(mra_invoice.id)
    order.save()
    
    return mra_invoice, receipt
```

## Rollback Plan

### If Migration Fails

```bash
# Rollback migrations
python manage.py migrate mra_eis zero

# Restore database
# SQLite
cp backend/db.sqlite3.backup backend/db.sqlite3

# PostgreSQL
psql handy_pos < handy_pos_backup.sql

# MySQL
mysql -u user -p handy_pos < handy_pos_backup.sql
```

### If Issues Occur

```bash
# Check migration status
python manage.py showmigrations mra_eis

# Rollback to specific migration
python manage.py migrate mra_eis 0001_initial

# Remove app from INSTALLED_APPS
# Restart Django
```

## Post-Deployment Verification

### 1. Check Database

```bash
python manage.py shell

from mra_eis.models import Terminal, MRAInvoice
print(f"Terminals: {Terminal.objects.count()}")
print(f"Invoices: {MRAInvoice.objects.count()}")
```

### 2. Check Admin

```bash
# Visit http://localhost:8000/admin/
# Verify MRA EIS section is visible
# Verify models are listed
```

### 3. Check API

```bash
# Test API endpoints
curl -H "Authorization: Bearer <token>" \
  http://localhost:8000/api/mra/terminals/

# Should return empty list (no terminals yet)
```

### 4. Check Logs

```bash
# Check for errors
tail -f logs/mra_eis.log

# Should show no errors
```

### 5. Run Tests

```bash
# Run full test suite
python manage.py test mra_eis

# All tests should pass
```

## Production Deployment

### 1. Environment Setup

```bash
# Set environment variables
export MRA_EIS_API_URL=https://api.mra.gov.mw/eis
export MRA_EIS_SANDBOX_MODE=False
export MRA_EIS_TIMEOUT=30
```

### 2. Security Hardening

```python
# In settings.py

DEBUG = False
ALLOWED_HOSTS = ['yourdomain.com']
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
```

### 3. Performance Optimization

```python
# In settings.py

# Database connection pooling
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'CONN_MAX_AGE': 600,
        'OPTIONS': {
            'connect_timeout': 10,
        }
    }
}

# Caching
CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://127.0.0.1:6379/1',
    }
}
```

### 4. Monitoring Setup

```bash
# Install monitoring tools
pip install sentry-sdk
pip install django-health-check

# Configure Sentry
# Configure health checks
# Setup alerts
```

### 5. Backup Strategy

```bash
# Daily backups
0 3 * * * pg_dump handy_pos | gzip > /backups/handy_pos_$(date +\%Y\%m\%d).sql.gz

# Keep 30 days
find /backups -name "handy_pos_*.sql.gz" -mtime +30 -delete
```

## Troubleshooting

### Migration Issues

```bash
# Check migration status
python manage.py showmigrations mra_eis

# Show migration plan
python manage.py migrate mra_eis --plan

# Fake migration if needed
python manage.py migrate mra_eis --fake-initial
```

### Import Errors

```bash
# Check imports
python -c "from mra_eis import models"

# Check app is installed
python manage.py shell
from django.apps import apps
print(apps.get_app_config('mra_eis'))
```

### Database Errors

```bash
# Check database connection
python manage.py dbshell

# Check tables exist
python manage.py shell
from django.db import connection
cursor = connection.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
print(cursor.fetchall())
```

### API Errors

```bash
# Check API is accessible
curl http://localhost:8000/api/mra/terminals/

# Check authentication
curl -H "Authorization: Bearer <token>" \
  http://localhost:8000/api/mra/terminals/
```

## Support

For issues:
1. Check logs: `tail -f logs/mra_eis.log`
2. Check admin: http://localhost:8000/admin/mra_eis/
3. Run tests: `python manage.py test mra_eis`
4. Review documentation: See `MRA_EIS_IMPLEMENTATION.md`

## Success Criteria

After deployment, verify:

- [ ] All migrations applied successfully
- [ ] Admin interface shows MRA EIS models
- [ ] API endpoints are accessible
- [ ] Tests pass
- [ ] No errors in logs
- [ ] Periodic tasks are running
- [ ] Monitoring is active
- [ ] Backups are working
- [ ] Terminal activation works
- [ ] Invoice creation works
- [ ] Offline mode works
- [ ] Audit logs are recorded
