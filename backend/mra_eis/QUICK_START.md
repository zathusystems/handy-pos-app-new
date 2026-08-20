# MRA EIS Integration - Quick Start Guide

## Installation & Setup

### 1. Update Django Settings

Add to `backend/core/settings.py`:

```python
INSTALLED_APPS = [
    # ... existing apps
    'mra_eis',
]

# MRA EIS Configuration
MRA_EIS_API_URL = os.getenv('MRA_EIS_API_URL', 'https://api.mra.gov.mw/eis')
MRA_EIS_SANDBOX_MODE = os.getenv('MRA_EIS_SANDBOX_MODE', 'True') == 'True'
MRA_EIS_TIMEOUT = int(os.getenv('MRA_EIS_TIMEOUT', '30'))
```

### 2. Update URL Configuration

Add to `backend/core/urls.py`:

```python
urlpatterns = [
    # ... existing patterns
    path('api/mra/', include('mra_eis.urls')),
]
```

### 3. Run Migrations

```bash
python manage.py makemigrations mra_eis
python manage.py migrate mra_eis
```

### 4. Create Superuser (if not exists)

```bash
python manage.py createsuperuser
```

## Basic Usage

### Step 1: Create Terminal Activation Code (TAC)

In Django admin or via API:

```python
from mra_eis.models import TerminalActivationCode
from business.models import Business
from datetime import timedelta
from django.utils import timezone

business = Business.objects.first()

tac = TerminalActivationCode.objects.create(
    business=business,
    code='TAC-2024-001',
    status='unused',
    expires_at=timezone.now() + timedelta(days=30)
)
```

### Step 2: Activate Terminal

```bash
curl -X POST http://localhost:8000/api/mra/terminals/activate/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tac_code": "TAC-2024-001",
    "pos_name": "Handy POS",
    "pos_version": "1.0.0",
    "os_type": "Web",
    "device_serial": "DEVICE-001",
    "mac_address": "00:1A:2B:3C:4D:5E"
  }' \
  -G -d "business_id=<business_id>&branch_id=<branch_id>"
```

### Step 3: Sync MRA Configuration

```bash
curl -X POST http://localhost:8000/api/mra/configurations/sync_from_mra/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"config_types": ["tax_rules", "product_codes"]}' \
  -G -d "business_id=<business_id>"
```

### Step 4: Create Product Mappings

```bash
curl -X POST http://localhost:8000/api/mra/product-mappings/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "inventory_item_id": "item-uuid",
    "product_name": "Coca Cola 500ml",
    "mra_product_code": "BEVERAGE-001",
    "mra_product_name": "Soft Drink",
    "tax_category": "standard",
    "approved_price": "2500.00",
    "tax_rate": "16.50"
  }' \
  -G -d "business_id=<business_id>"
```

### Step 5: Create and Submit Invoice

```python
from mra_eis.services import InvoiceService
from mra_eis.models import Terminal

terminal = Terminal.objects.first()

# Create invoice
invoice = InvoiceService.create_invoice(
    terminal=terminal,
    seller_tin='1234567890',
    seller_name='My Business',
    items=[
        {
            'mra_product_code': 'BEVERAGE-001',
            'name': 'Coca Cola 500ml',
            'quantity': 2,
            'unit_price': 2500.00,
            'tax_rate': 16.50,
            'tax_category': 'standard',
        }
    ],
    is_online=True
)

# Submit to MRA
InvoiceService.submit_invoice(invoice)
```

### Step 6: Generate Receipt

```python
from mra_eis.services import ReceiptService

receipt = ReceiptService.generate_receipt(invoice)
print(receipt.receipt_text)
# Use receipt.qr_code_data for QR code generation
```

## Offline Mode

### Detect Offline and Queue Invoice

```python
from mra_eis.services import InvoiceService, TerminalService

# Update terminal status
TerminalService.update_online_status(terminal, is_online=False)

# Create invoice (will be queued offline)
invoice = InvoiceService.create_invoice(
    terminal=terminal,
    seller_tin='1234567890',
    seller_name='My Business',
    items=[...],
    is_online=False
)

# Queue for offline sync
InvoiceService.queue_offline_invoice(invoice)
```

### Sync When Online

```python
# Update terminal status
TerminalService.update_online_status(terminal, is_online=True)

# Sync offline invoices
result = InvoiceService.sync_offline_invoices(terminal)
print(f"Synced: {result['synced']}, Failed: {result['failed']}")
```

## Monitoring

### Check Terminal Status

```bash
curl -X GET http://localhost:8000/api/mra/terminals/<terminal_id>/status/ \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{
  "terminal_id": "branch-001-1234567890",
  "status": "active",
  "is_online": true,
  "online_invoice_counter": 42,
  "offline_invoice_counter": 5,
  "pending_offline_invoices": 0,
  "token_expires_at": "2024-01-15T10:30:00Z",
  "last_sync_at": "2024-01-14T15:45:00Z"
}
```

### Check Offline Queue

```bash
curl -X GET http://localhost:8000/api/mra/offline-queue/pending/ \
  -H "Authorization: Bearer <token>" \
  -G -d "terminal_id=<terminal_id>"
```

### View Audit Logs

```bash
curl -X GET http://localhost:8000/api/mra/invoices/<invoice_id>/audit_logs/ \
  -H "Authorization: Bearer <token>"
```

## Periodic Tasks

### Setup Cron Jobs

Add to crontab:

```bash
# Sync MRA configuration daily at 2 AM
0 2 * * * cd /path/to/project && python manage.py sync_mra_config

# Process retry queue every 5 minutes
*/5 * * * * cd /path/to/project && python manage.py process_mra_retries
```

Or use Celery:

```python
# tasks.py
from celery import shared_task
from mra_eis.services import ConfigurationService, RetryService

@shared_task
def sync_mra_configurations():
    from business.models import Business
    for business in Business.objects.filter(is_active=True):
        ConfigurationService.fetch_and_store_configuration(business)

@shared_task
def process_retry_queue():
    RetryService.process_retry_queue()

# Beat schedule
from celery.schedules import crontab

app.conf.beat_schedule = {
    'sync-mra-config': {
        'task': 'tasks.sync_mra_configurations',
        'schedule': crontab(hour=2, minute=0),  # Daily at 2 AM
    },
    'process-retries': {
        'task': 'tasks.process_retry_queue',
        'schedule': crontab(minute='*/5'),  # Every 5 minutes
    },
}
```

## Testing

### Run Tests

```bash
python manage.py test mra_eis
```

### Manual Testing Checklist

- [ ] Terminal activation with TAC
- [ ] Configuration sync from MRA
- [ ] Product mapping creation
- [ ] Online invoice submission
- [ ] Offline invoice queuing
- [ ] Offline sync when online
- [ ] Receipt generation
- [ ] Audit log tracking
- [ ] Error handling and retries
- [ ] Token refresh

## Troubleshooting

### Terminal Activation Fails

```python
# Check TAC validity
from mra_eis.models import TerminalActivationCode
tac = TerminalActivationCode.objects.get(code='TAC-2024-001')
print(tac.is_valid())  # Should be True
```

### Invoice Submission Fails

```python
# Check terminal status
from mra_eis.models import Terminal
terminal = Terminal.objects.first()
print(f"Status: {terminal.status}")
print(f"Online: {terminal.is_online}")
print(f"Token expires: {terminal.token_expires_at}")

# Check for API errors
from mra_eis.models import MRAAPIError
errors = MRAAPIError.objects.filter(terminal=terminal, is_resolved=False)
for error in errors:
    print(f"{error.error_type}: {error.error_message}")
```

### Offline Sync Fails

```python
# Check offline queue
from mra_eis.models import OfflineInvoiceQueue
queue = OfflineInvoiceQueue.objects.filter(terminal=terminal, status='failed')
for entry in queue:
    print(f"Queue #{entry.queue_position}: {entry.last_sync_error}")
```

## Next Steps

1. **Integrate with POS Sales Flow**
   - Hook into order completion
   - Create MRA invoice automatically
   - Generate receipt

2. **Setup Monitoring**
   - Monitor terminal status
   - Track offline queue size
   - Alert on errors

3. **Configure Periodic Tasks**
   - Setup configuration sync
   - Setup retry processing
   - Setup token refresh

4. **Test with MRA Sandbox**
   - Get sandbox credentials
   - Test all flows
   - Verify compliance

5. **Deploy to Production**
   - Update settings
   - Run migrations
   - Setup monitoring
   - Enable periodic tasks

## Support

For issues or questions:
1. Check the full documentation: `MRA_EIS_IMPLEMENTATION.md`
2. Review Django admin for data inspection
3. Check audit logs for operation history
4. Review error logs for API issues
