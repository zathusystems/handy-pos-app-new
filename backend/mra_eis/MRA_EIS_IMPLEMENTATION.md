# MRA EIS Integration - Complete Implementation Guide

## Overview

This is a **production-ready MRA (Malawi Revenue Authority) Electronic Invoicing System (EIS) integration** for Django POS systems. It provides full compliance with MRA requirements including online/offline sales, immutable invoicing, and comprehensive audit trails.

## Architecture

### Core Modules

#### 1. Terminal & Onboarding Module
- **Terminal Model**: Represents a POS terminal registered with MRA
  - One terminal = one device + OS combination
  - Tracks online/offline invoice counters separately
  - Manages MRA authentication tokens
  - Stores device identifiers (MAC, serial)

- **TerminalActivationCode (TAC)**: One-time use activation codes
  - Prevents TAC reuse
  - Tracks usage history
  - Enforces expiration

**Key Features:**
- Terminal activation using TAC
- Secure credential storage
- Token refresh with expiration tracking
- Online/offline status management

#### 2. Configuration Management
- **MRAConfiguration Model**: Immutable configuration snapshots
  - Tax rules
  - Receipt formatting rules
  - Product codes
  - System settings

- **ConfigurationSyncLog**: Tracks sync attempts

**Key Features:**
- Periodic fetching from MRA
- Immutable storage (never modified)
- Version control
- Auto-refresh on startup and daily

#### 3. Product & Stock Mapping
- **MRAProductMapping Model**: Maps internal products to MRA codes
  - Enforces MRA-approved products only
  - Immutable pricing and tax rates
  - Supports fuel stations (volume-based)
  - Supports service-only businesses

**Key Features:**
- Product code mapping
- Tax category assignment
- Price enforcement
- Approval tracking

#### 4. Sales & Invoice Submission
- **MRAInvoice Model**: MRA-compliant invoice records
  - Immutable once created
  - Sequential numbering per terminal
  - Client TIN always used as seller
  - Full tax breakdown

**Key Features:**
- Invoice creation with validation
- Real-time submission (when online)
- Signature generation
- MRA response tracking

#### 5. Offline Sales Engine (Critical)
- **OfflineInvoiceQueue Model**: Queue for offline invoices
  - Maintains order for sequential sync
  - Tracks sync attempts
  - Prevents data loss

- **OfflineAuditLog Model**: Audit trail for offline operations

**Key Features:**
- Internet availability detection
- Local invoice generation
- MRA offline signature rules
- Secure queuing
- Auto-sync when online
- Prevents edits after sync

#### 6. Receipt & QR Code Generation
- **Receipt Model**: Receipt records with QR codes
  - Encodes invoice signature
  - Scannable by MRA verification tools
  - Immutable once generated

**Key Features:**
- Receipt formatting
- QR code generation
- Signature encoding
- MRA compliance

#### 7. Security & Audit Controls
- **InvoiceAuditLog Model**: Write-once audit trail
  - Tracks all invoice operations
  - Records user, timestamp, action
  - Immutable records

- **TerminalAuditLog Model**: Terminal operation audit trail

**Key Features:**
- Write-once storage
- Full audit trail (who, when, what)
- Role-based permissions
- Invoice deletion prevention
- Tax rate modification prevention

#### 8. Error Handling & Resilience
- **MRAAPIError Model**: Tracks API errors
  - Connection errors
  - Token expiry
  - Network loss
  - Rate limiting

- **SyncRetryQueue Model**: Database-backed retry queue
  - Exponential backoff
  - Idempotent operations
  - Automatic retries

**Key Features:**
- Graceful error handling
- Automatic retries with backoff
- Clear error codes for UI
- Resilience to EIS downtime

## Database Models

### Terminal Management
```python
Terminal
├── terminal_id (unique)
├── mra_terminal_id (unique)
├── device_serial
├── mac_address
├── pos_name, pos_version, os_type
├── mra_api_key, mra_token
├── status (pending_activation, active, suspended, deactivated)
├── is_online
├── online_invoice_counter
├── offline_invoice_counter
└── audit fields

TerminalActivationCode
├── code (unique)
├── status (unused, used, expired, revoked)
├── used_by_terminal (OneToOne)
├── expires_at
└── audit fields
```

### Configuration
```python
MRAConfiguration
├── config_type (tax_rules, receipt_format, product_codes, system_settings)
├── config_version
├── config_data (JSON)
├── effective_from, effective_to
├── is_active
└── fetched_from_mra_at

ConfigurationSyncLog
├── status (pending, success, failed)
├── config_types (JSON list)
├── error_message
└── timestamps
```

### Products & Invoices
```python
MRAProductMapping
├── inventory_item_id
├── mra_product_code
├── tax_category (standard, zero, exempt)
├── approved_price
├── tax_rate
├── is_approved, is_active
└── audit fields

MRAInvoice
├── invoice_number (sequential per terminal)
├── mra_invoice_id
├── seller_tin, seller_name
├── buyer_tin, buyer_name
├── items (JSON)
├── net_amount, tax_amount, gross_amount
├── tax_breakdown (JSON)
├── invoice_signature
├── status (draft, submitted, accepted, rejected, offline_queued, offline_synced)
├── is_online
└── audit fields
```

### Offline & Audit
```python
OfflineInvoiceQueue
├── terminal (FK)
├── mra_invoice (OneToOne)
├── queue_position
├── status (queued, syncing, synced, failed)
├── sync_attempts
└── timestamps

InvoiceAuditLog
├── mra_invoice (FK)
├── action (created, submitted, accepted, rejected, etc.)
├── user (FK)
├── details (JSON)
├── ip_address
└── created_at

TerminalAuditLog
├── terminal (FK)
├── action (activated, token_refreshed, online_status_changed, etc.)
├── details (JSON)
└── created_at
```

### Error Handling
```python
MRAAPIError
├── terminal (FK)
├── error_type (connection_error, timeout, token_expired, etc.)
├── error_message
├── error_code
├── retry_count
├── next_retry_at
├── is_resolved
└── related_invoice (FK, nullable)

SyncRetryQueue
├── terminal (FK)
├── operation_type (submit_invoice, sync_offline_invoices, etc.)
├── status (pending, processing, completed, failed)
├── payload (JSON)
├── attempt_count, max_attempts
├── next_attempt_at
└── timestamps
```

## API Endpoints

### Terminal Management
```
POST   /api/mra/terminals/activate/
       - Activate terminal using TAC
       - Params: business_id, branch_id
       - Body: {tac_code, pos_name, pos_version, os_type, device_serial, mac_address}

GET    /api/mra/terminals/{id}/
       - Get terminal details

POST   /api/mra/terminals/{id}/refresh_token/
       - Refresh MRA authentication token

GET    /api/mra/terminals/{id}/status/
       - Get terminal status (online/offline, counters, pending invoices)

POST   /api/mra/terminals/{id}/update_online_status/
       - Update terminal online/offline status
       - Body: {is_online: boolean}

GET    /api/mra/terminals/{id}/audit_logs/
       - Get terminal audit logs
```

### Configuration Management
```
GET    /api/mra/configurations/
       - List active configurations

GET    /api/mra/configurations/{id}/
       - Get configuration details

POST   /api/mra/configurations/sync_from_mra/
       - Fetch and sync configurations from MRA
       - Params: business_id
       - Body: {config_types: [optional list]}
```

### Product Mapping
```
GET    /api/mra/product-mappings/
       - List product mappings

POST   /api/mra/product-mappings/
       - Create product mapping
       - Params: business_id
       - Body: {inventory_item_id, product_name, mra_product_code, ...}

GET    /api/mra/product-mappings/{id}/
       - Get mapping details
```

### Invoice Management
```
POST   /api/mra/invoices/
       - Create invoice
       - Params: terminal_id
       - Body: {seller_tin, seller_name, items, buyer_tin, buyer_name, is_online}

GET    /api/mra/invoices/
       - List invoices

GET    /api/mra/invoices/{id}/
       - Get invoice details

POST   /api/mra/invoices/{id}/submit/
       - Submit invoice to MRA (online only)

POST   /api/mra/invoices/{id}/queue_offline/
       - Queue invoice for offline sync

POST   /api/mra/invoices/sync_offline/
       - Sync offline invoices
       - Params: terminal_id

GET    /api/mra/invoices/{id}/audit_logs/
       - Get invoice audit logs
```

### Receipts
```
GET    /api/mra/receipts/
       - List receipts

GET    /api/mra/receipts/{id}/
       - Get receipt details

POST   /api/mra/receipts/generate/
       - Generate receipt for invoice
       - Params: invoice_id
```

### Offline Queue
```
GET    /api/mra/offline-queue/
       - List offline queue entries

GET    /api/mra/offline-queue/pending/
       - Get pending offline invoices
       - Params: terminal_id
```

### Error Tracking
```
GET    /api/mra/api-errors/
       - List API errors

GET    /api/mra/api-errors/unresolved/
       - Get unresolved errors
```

## Services

### TerminalService
```python
TerminalService.activate_terminal(business, branch, tac_code, pos_name, pos_version, os_type, device_serial, mac_address)
TerminalService.refresh_token(terminal)
TerminalService.update_online_status(terminal, is_online)
```

### ConfigurationService
```python
ConfigurationService.fetch_and_store_configuration(business, config_types)
ConfigurationService.get_active_configuration(business, config_type)
```

### ProductMappingService
```python
ProductMappingService.create_product_mapping(business, inventory_item_id, product_name, mra_product_code, mra_product_name, tax_category, approved_price, tax_rate)
ProductMappingService.get_product_mapping(business, inventory_item_id)
ProductMappingService.validate_product_for_sale(business, inventory_item_id)
```

### InvoiceService
```python
InvoiceService.create_invoice(terminal, seller_tin, seller_name, items, buyer_tin, buyer_name, is_online)
InvoiceService.submit_invoice(invoice)
InvoiceService.queue_offline_invoice(invoice)
InvoiceService.sync_offline_invoices(terminal)
```

### ReceiptService
```python
ReceiptService.generate_receipt(invoice)
```

### RetryService
```python
RetryService.queue_retry(terminal, operation_type, payload, max_attempts)
RetryService.process_retry_queue()
```

## Management Commands

### Sync MRA Configuration
```bash
python manage.py sync_mra_config
python manage.py sync_mra_config --business-id <business_id>
```

### Process Retry Queue
```bash
python manage.py process_mra_retries
```

## Integration with Existing POS

### From POS Sales to MRA Invoice

1. **Create POS Order** (existing flow)
   ```python
   order = Order.objects.create(
       business=business,
       branch=branch,
       session=session,
       order_number=next_order_number,
       payment_method='Cash',
       subtotal=Decimal('100.00'),
       total=Decimal('116.50'),
       # ... other fields
   )
   ```

2. **Create MRA Invoice** (new flow)
   ```python
   from mra_eis.services import InvoiceService, ProductMappingService
   
   # Validate products
   items = []
   for order_item in order.items.all():
       mapping = ProductMappingService.validate_product_for_sale(
           business, 
           order_item.inventory_item_id
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
   invoice = InvoiceService.create_invoice(
       terminal=terminal,
       seller_tin=business.settings.mra_tin,
       seller_name=business.name,
       items=items,
       is_online=terminal.is_online
   )
   
   # Submit or queue
   if terminal.is_online:
       InvoiceService.submit_invoice(invoice)
   else:
       InvoiceService.queue_offline_invoice(invoice)
   ```

3. **Generate Receipt**
   ```python
   from mra_eis.services import ReceiptService
   
   receipt = ReceiptService.generate_receipt(invoice)
   # Use receipt.receipt_text for printing
   # Use receipt.qr_code_data for QR code generation
   ```

## Configuration

### Django Settings
```python
# settings.py

INSTALLED_APPS = [
    # ...
    'mra_eis',
]

# MRA EIS Configuration
MRA_EIS_API_URL = 'https://api.mra.gov.mw/eis'  # MRA API endpoint
MRA_EIS_SANDBOX_MODE = True  # Set to False in production
MRA_EIS_TIMEOUT = 30  # API timeout in seconds
```

### Environment Variables
```bash
MRA_EIS_API_URL=https://api.mra.gov.mw/eis
MRA_EIS_SANDBOX_MODE=False
MRA_EIS_TIMEOUT=30
```

## Security Considerations

### Encryption
- MRA API keys should be encrypted in production
- Use Django's `django-cryptography` or similar
- Never log sensitive credentials

### Audit Trail
- All invoice operations are logged
- Immutable audit logs prevent tampering
- User tracking for compliance

### Invoice Immutability
- Invoices cannot be edited after submission
- Deletion is prevented for submitted invoices
- Tax rates are frozen at invoice creation time

### Token Management
- Tokens are refreshed automatically
- Expiration is tracked
- Failed token refresh triggers error handling

## Certification Readiness

### Sandbox Testing
1. Activate terminal with sandbox TAC
2. Create test invoices
3. Submit to MRA sandbox
4. Verify responses

### Offline Demo
1. Disable internet connectivity
2. Create invoices (queued offline)
3. Re-enable connectivity
4. Sync invoices
5. Verify sequential submission

### Immutable Receipts
1. Generate receipt
2. Verify QR code encodes signature
3. Verify receipt cannot be modified
4. Verify audit trail is complete

### MRA Audit Expectations
- Sequential invoice numbering ✓
- Immutable records ✓
- Complete audit trail ✓
- Tax rate enforcement ✓
- Offline capability ✓
- Error handling ✓

## Troubleshooting

### Terminal Activation Fails
- Verify TAC is valid and not expired
- Check business and branch exist
- Verify user has permission

### Invoice Submission Fails
- Check terminal is online
- Verify token is not expired
- Check product mappings exist
- Verify seller TIN is correct

### Offline Sync Fails
- Check internet connectivity
- Verify terminal status
- Check retry queue for errors
- Review MRA API error logs

### Configuration Sync Fails
- Verify MRA API is accessible
- Check API credentials
- Review error logs
- Retry manually

## Performance Optimization

### Database Indexes
- Terminal: (business, branch), (status), (mra_terminal_id)
- MRAInvoice: (business, branch), (terminal, invoice_number), (status), (invoice_date)
- OfflineInvoiceQueue: (terminal, status), (queue_position)
- InvoiceAuditLog: (mra_invoice, action), (created_at)

### Query Optimization
- Use `select_related()` for foreign keys
- Use `prefetch_related()` for reverse relations
- Implement pagination for large result sets
- Cache active configurations

### Batch Operations
- Sync multiple offline invoices in transaction
- Batch retry processing
- Bulk audit log creation

## Monitoring & Logging

### Key Metrics
- Terminal online/offline ratio
- Invoice submission success rate
- Offline queue size
- API error rate
- Token refresh frequency

### Logging
```python
import logging

logger = logging.getLogger('mra_eis')

logger.info(f"Invoice {invoice.invoice_number} submitted")
logger.error(f"Invoice submission failed: {error}")
logger.warning(f"Terminal {terminal.terminal_id} offline")
```

### Alerts
- Terminal offline for > 1 hour
- Offline queue > 100 invoices
- API error rate > 5%
- Token refresh failures

## Future Enhancements

1. **Batch Invoice Submission**
   - Submit multiple invoices in single API call
   - Reduce API calls and latency

2. **Advanced Offline Mode**
   - Local signature generation
   - Encrypted offline storage
   - Offline receipt printing

3. **Real-time Sync**
   - WebSocket support for real-time updates
   - Push notifications for sync status

4. **Analytics Dashboard**
   - Invoice submission metrics
   - Tax compliance reporting
   - Error tracking and resolution

5. **Multi-terminal Support**
   - Centralized management
   - Cross-terminal reporting
   - Consolidated audit logs

## Support & Documentation

- MRA EIS API Documentation: https://mra.gov.mw/eis/api
- Django Documentation: https://docs.djangoproject.com/
- REST Framework: https://www.django-rest-framework.org/

## License

This implementation is part of the Handy POS system and follows the same license terms.
