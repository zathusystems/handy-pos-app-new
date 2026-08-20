# MRA EIS Integration with Existing POS System

## Overview

This guide explains how to integrate the MRA EIS module with your existing POS system (sales, products, stock, users, receipts).

## Integration Points

### 1. POS Order → MRA Invoice Flow

When a POS order is completed, create an MRA invoice:

```python
# In pos_sessions/views.py or order completion handler

from mra_eis.services import InvoiceService, ProductMappingService, ReceiptService
from mra_eis.models import Terminal
from decimal import Decimal

def complete_order(order):
    """Complete a POS order and submit to MRA"""
    
    # Get terminal for this branch
    terminal = Terminal.objects.filter(
        branch=order.branch,
        status='active'
    ).first()
    
    if not terminal:
        raise ValueError(f"No active terminal for branch {order.branch}")
    
    # Prepare invoice items
    items = []
    for order_item in order.items.all():
        # Validate product is MRA-approved
        mapping = ProductMappingService.validate_product_for_sale(
            order.business,
            str(order_item.inventory_item_id)
        )
        
        items.append({
            'mra_product_code': mapping.mra_product_code,
            'name': order_item.name,
            'quantity': order_item.quantity,
            'unit_price': Decimal(str(order_item.price)),
            'tax_rate': mapping.tax_rate,
            'tax_category': mapping.tax_category,
        })
    
    # Get business TIN (should be stored in BusinessSettings)
    business_settings = order.business.settings
    seller_tin = getattr(business_settings, 'mra_tin', '1234567890')
    
    # Create MRA invoice
    mra_invoice = InvoiceService.create_invoice(
        terminal=terminal,
        seller_tin=seller_tin,
        seller_name=order.business.name,
        items=items,
        buyer_tin=order.customer.tin if order.customer else None,
        buyer_name=order.customer.name if order.customer else None,
        is_online=terminal.is_online
    )
    
    # Submit or queue
    try:
        if terminal.is_online:
            InvoiceService.submit_invoice(mra_invoice)
        else:
            InvoiceService.queue_offline_invoice(mra_invoice)
    except Exception as e:
        # Log error but don't fail order completion
        logger.error(f"Failed to submit MRA invoice: {e}")
    
    # Generate receipt
    receipt = ReceiptService.generate_receipt(mra_invoice)
    
    # Link receipt to order
    order.mra_invoice_id = str(mra_invoice.id)
    order.receipt_text = receipt.receipt_text
    order.save()
    
    return mra_invoice, receipt
```

### 2. Product Inventory → MRA Product Mapping

When creating/updating inventory items, create MRA mappings:

```python
# In inventory/views.py or product creation handler

from mra_eis.services import ProductMappingService
from mra_eis.models import MRAProductMapping

def create_inventory_item_with_mra_mapping(business, inventory_item_data, mra_mapping_data):
    """Create inventory item and MRA product mapping"""
    
    # Create inventory item (existing flow)
    inventory_item = InventoryItem.objects.create(
        business=business,
        **inventory_item_data
    )
    
    # Create MRA mapping
    try:
        mra_mapping = ProductMappingService.create_product_mapping(
            business=business,
            inventory_item_id=str(inventory_item.id),
            product_name=inventory_item.name,
            **mra_mapping_data
        )
        return inventory_item, mra_mapping
    except Exception as e:
        # If MRA mapping fails, still create inventory item
        logger.warning(f"Failed to create MRA mapping: {e}")
        return inventory_item, None
```

### 3. Tax Rate Management

Enforce MRA tax rates:

```python
# In business/models.py - extend TaxRate model

class TaxRate(models.Model):
    # ... existing fields
    
    # Link to MRA configuration
    mra_tax_category = models.CharField(
        max_length=20,
        choices=[('standard', 'Standard'), ('zero', 'Zero'), ('exempt', 'Exempt')],
        blank=True,
        help_text="MRA tax category"
    )
    
    def is_mra_compliant(self):
        """Check if tax rate matches MRA configuration"""
        from mra_eis.services import ConfigurationService
        
        config = ConfigurationService.get_active_configuration(
            self.business,
            'tax_rules'
        )
        
        if not config:
            return False
        
        tax_rules = config.config_data.get('tax_rules', {})
        mra_rate = tax_rules.get(self.mra_tax_category, {}).get('rate')
        
        return mra_rate == float(self.rate)
```

### 4. Session Management

Track online/offline status per session:

```python
# In pos_sessions/models.py - extend Session model

class Session(models.Model):
    # ... existing fields
    
    # MRA tracking
    mra_terminal = models.ForeignKey(
        'mra_eis.Terminal',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='sessions'
    )
    was_offline = models.BooleanField(
        default=False,
        help_text="Whether session had offline periods"
    )
    offline_invoices_count = models.IntegerField(
        default=0,
        help_text="Number of invoices created offline"
    )
    
    def get_mra_status(self):
        """Get MRA status for this session"""
        if not self.mra_terminal:
            return None
        
        return {
            'terminal_id': self.mra_terminal.terminal_id,
            'is_online': self.mra_terminal.is_online,
            'online_invoices': self.orders.filter(
                mra_invoice__is_online=True
            ).count(),
            'offline_invoices': self.orders.filter(
                mra_invoice__is_online=False
            ).count(),
        }
```

### 5. Receipt Integration

Extend receipt generation:

```python
# In pos_sessions/views.py - receipt generation

def generate_pos_receipt(order):
    """Generate receipt with MRA QR code"""
    
    from mra_eis.models import Receipt
    
    # Get MRA receipt if exists
    mra_receipt = Receipt.objects.filter(
        mra_invoice__id=order.mra_invoice_id
    ).first()
    
    if mra_receipt:
        # Use MRA receipt with QR code
        receipt_data = {
            'receipt_text': mra_receipt.receipt_text,
            'qr_code_data': mra_receipt.qr_code_data,
            'qr_code_image': mra_receipt.qr_code_image,
        }
    else:
        # Fallback to standard receipt
        receipt_data = generate_standard_receipt(order)
    
    return receipt_data
```

### 6. User Permissions

Add MRA-specific permissions:

```python
# In staff/models.py or create new permissions

from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType

def create_mra_permissions():
    """Create MRA-specific permissions"""
    
    from mra_eis.models import Terminal, MRAInvoice
    
    content_type = ContentType.objects.get_for_model(Terminal)
    
    permissions = [
        Permission.objects.get_or_create(
            codename='activate_terminal',
            name='Can activate MRA terminal',
            content_type=content_type,
        ),
        Permission.objects.get_or_create(
            codename='view_mra_invoices',
            name='Can view MRA invoices',
            content_type=content_type,
        ),
        Permission.objects.get_or_create(
            codename='manage_product_mappings',
            name='Can manage product mappings',
            content_type=content_type,
        ),
    ]
    
    return permissions
```

### 7. Error Handling & Notifications

Handle MRA errors gracefully:

```python
# In pos_sessions/views.py - error handling

def handle_mra_error(order, error):
    """Handle MRA submission errors"""
    
    from mra_eis.models import MRAAPIError
    
    # Log error
    api_error = MRAAPIError.objects.create(
        terminal=order.branch.mra_terminals.first(),
        error_type='invalid_request',
        error_message=str(error),
        related_invoice=order.mra_invoice_id
    )
    
    # Notify user
    notification = {
        'type': 'warning',
        'title': 'MRA Submission Failed',
        'message': f'Invoice {order.order_number} could not be submitted to MRA. It will be retried automatically.',
        'action': 'retry',
        'order_id': order.id,
    }
    
    # Send to frontend
    send_notification_to_user(order.session.user, notification)
    
    return api_error
```

### 8. Offline Mode Detection

Detect and handle offline mode:

```python
# In pos_sessions/views.py - connectivity detection

import requests
from django.utils import timezone

def check_mra_connectivity(terminal):
    """Check if MRA is reachable"""
    
    try:
        response = requests.get(
            f"{settings.MRA_EIS_API_URL}/health",
            timeout=5
        )
        is_online = response.status_code == 200
    except (requests.ConnectionError, requests.Timeout):
        is_online = False
    
    # Update terminal status
    from mra_eis.services import TerminalService
    TerminalService.update_online_status(terminal, is_online)
    
    return is_online

def handle_offline_order(order):
    """Handle order creation when offline"""
    
    # Create invoice with is_online=False
    from mra_eis.services import InvoiceService
    
    invoice = InvoiceService.create_invoice(
        terminal=order.branch.mra_terminals.first(),
        seller_tin=order.business.settings.mra_tin,
        seller_name=order.business.name,
        items=prepare_invoice_items(order),
        is_online=False
    )
    
    # Queue for offline sync
    InvoiceService.queue_offline_invoice(invoice)
    
    # Notify user
    notification = {
        'type': 'info',
        'title': 'Offline Mode',
        'message': f'Invoice {order.order_number} saved offline. Will sync when online.',
    }
    
    return invoice
```

### 9. Dashboard Integration

Add MRA status to dashboard:

```python
# In business/views.py - dashboard data

def get_mra_dashboard_data(business):
    """Get MRA status for dashboard"""
    
    from mra_eis.models import Terminal, MRAInvoice, OfflineInvoiceQueue
    
    terminals = Terminal.objects.filter(business=business)
    
    data = {
        'terminals': {
            'total': terminals.count(),
            'active': terminals.filter(status='active').count(),
            'online': terminals.filter(is_online=True).count(),
            'offline': terminals.filter(is_online=False).count(),
        },
        'invoices': {
            'total': MRAInvoice.objects.filter(business=business).count(),
            'submitted': MRAInvoice.objects.filter(
                business=business,
                status='submitted'
            ).count(),
            'accepted': MRAInvoice.objects.filter(
                business=business,
                status='accepted'
            ).count(),
            'rejected': MRAInvoice.objects.filter(
                business=business,
                status='rejected'
            ).count(),
        },
        'offline_queue': {
            'total': OfflineInvoiceQueue.objects.filter(
                terminal__business=business
            ).count(),
            'pending': OfflineInvoiceQueue.objects.filter(
                terminal__business=business,
                status='queued'
            ).count(),
            'failed': OfflineInvoiceQueue.objects.filter(
                terminal__business=business,
                status='failed'
            ).count(),
        },
    }
    
    return data
```

### 10. Audit Trail Integration

Link POS operations to MRA audit:

```python
# In pos_sessions/views.py - audit logging

def log_order_to_mra_audit(order, user, ip_address):
    """Log order creation to MRA audit trail"""
    
    from mra_eis.models import InvoiceAuditLog
    
    if hasattr(order, 'mra_invoice_id') and order.mra_invoice_id:
        from mra_eis.models import MRAInvoice
        
        mra_invoice = MRAInvoice.objects.get(id=order.mra_invoice_id)
        
        InvoiceAuditLog.objects.create(
            mra_invoice=mra_invoice,
            action='created',
            user=user,
            ip_address=ip_address,
            details={
                'order_id': str(order.id),
                'order_number': order.order_number,
                'payment_method': order.payment_method,
            }
        )
```

## Database Schema Extensions

### Extend BusinessSettings

```python
# In business/models.py

class BusinessSettings(models.Model):
    # ... existing fields
    
    # MRA Configuration
    mra_tin = models.CharField(
        max_length=50,
        blank=True,
        help_text="MRA Tax Identification Number"
    )
    mra_enabled = models.BooleanField(
        default=False,
        help_text="Enable MRA EIS integration"
    )
    mra_sandbox_mode = models.BooleanField(
        default=True,
        help_text="Use MRA sandbox for testing"
    )
```

### Extend Order Model

```python
# In pos_sessions/models.py

class Order(models.Model):
    # ... existing fields
    
    # MRA Integration
    mra_invoice_id = models.CharField(
        max_length=255,
        blank=True,
        null=True,
        help_text="ID of related MRA invoice"
    )
    mra_status = models.CharField(
        max_length=20,
        blank=True,
        choices=[
            ('pending', 'Pending MRA Submission'),
            ('submitted', 'Submitted to MRA'),
            ('accepted', 'Accepted by MRA'),
            ('rejected', 'Rejected by MRA'),
            ('offline_queued', 'Queued for Offline Sync'),
        ],
        help_text="MRA submission status"
    )
```

## API Integration Examples

### Frontend: Submit Order and Get Receipt

```javascript
// In frontend (React/Next.js)

async function submitOrderWithMRA(order) {
  try {
    // 1. Create POS order
    const orderResponse = await fetch('/api/orders/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    const createdOrder = await orderResponse.json();

    // 2. Create MRA invoice
    const mraResponse = await fetch('/api/mra/invoices/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seller_tin: business.mra_tin,
        seller_name: business.name,
        items: order.items.map(item => ({
          mra_product_code: item.mra_code,
          name: item.name,
          quantity: item.quantity,
          unit_price: item.price,
          tax_rate: item.tax_rate,
          tax_category: item.tax_category,
        })),
        is_online: isOnline,
      }),
      params: { terminal_id: terminalId },
    });
    const mraInvoice = await mraResponse.json();

    // 3. Get receipt
    const receiptResponse = await fetch(
      `/api/mra/receipts/generate/?invoice_id=${mraInvoice.id}`,
      { method: 'POST' }
    );
    const receipt = await receiptResponse.json();

    return {
      order: createdOrder,
      invoice: mraInvoice,
      receipt: receipt,
    };
  } catch (error) {
    console.error('Order submission failed:', error);
    throw error;
  }
}
```

## Testing Integration

### Unit Tests

```python
# In mra_eis/tests.py

from django.test import TestCase
from business.models import Business, Branch
from pos_sessions.models import Order, Session
from mra_eis.services import InvoiceService

class MRAIntegrationTests(TestCase):
    def setUp(self):
        self.business = Business.objects.create(name='Test Business')
        self.branch = Branch.objects.create(business=self.business, name='Main')
        
    def test_order_to_mra_invoice_flow(self):
        """Test complete order to MRA invoice flow"""
        # Create order
        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=1,
            payment_method='Cash',
            subtotal=100,
            total=116.50,
        )
        
        # Create MRA invoice
        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name=self.business.name,
            items=[...],
            is_online=True,
        )
        
        self.assertIsNotNone(invoice)
        self.assertEqual(invoice.status, 'draft')
```

## Deployment Checklist

- [ ] Add `mra_eis` to `INSTALLED_APPS`
- [ ] Add MRA URLs to `core/urls.py`
- [ ] Run migrations: `python manage.py migrate mra_eis`
- [ ] Create TAC codes in admin
- [ ] Activate terminals
- [ ] Sync MRA configuration
- [ ] Create product mappings
- [ ] Update BusinessSettings with MRA TIN
- [ ] Setup periodic tasks (cron/Celery)
- [ ] Configure error notifications
- [ ] Test offline mode
- [ ] Test online submission
- [ ] Verify audit logs
- [ ] Setup monitoring

## Support & Troubleshooting

See `MRA_EIS_IMPLEMENTATION.md` for detailed troubleshooting guide.
