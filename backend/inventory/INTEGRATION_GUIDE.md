# Inventory → Invoice → MRA Integration Guide

## 🎯 Complete Flow

This guide shows how to integrate the MRA-compliant inventory module with the POS and MRA EIS app.

---

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    POS SYSTEM                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Order Creation                                              │
│       ↓                                                       │
│  Inventory Validation (InventoryService)                    │
│       ↓                                                       │
│  Create Snapshot (InventorySnapshot)                        │
│       ↓                                                       │
│  Reduce Stock (InventoryItem)                               │
│       ↓                                                       │
│  Create Audit Log (AuditLog)                                │
│       ↓                                                       │
├─────────────────────────────────────────────────────────────┤
│                    MRA EIS APP                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Create Invoice (MRAInvoice)                                │
│       ↓                                                       │
│  Link to Snapshot (related_invoice_number)                  │
│       ↓                                                       │
│  Submit to MRA                                               │
│       ↓                                                       │
│  Generate Receipt with QR Code                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Implementation Steps

### Step 1: Product Setup

```python
# In admin or API endpoint

from inventory.models import InventoryItem, MRAProductMapping

# Create inventory item
item = InventoryItem.objects.create(
    business=business,
    branch=branch,
    name="Coca Cola 500ml",
    category="Beverages",
    item_type='sellable',
    price=Decimal('2500.00'),
    cost=Decimal('1500.00'),
    stock_units=Decimal('100'),
    unit_type='bottle',
)

# Create MRA mapping
mapping = MRAProductMapping.objects.create(
    inventory_item=item,
    mra_product_code='BEVERAGE-001',
    mra_product_name='Soft Drink - 500ml',
    mra_tax_type='standard',
    mra_tax_rate=Decimal('16.50'),
    mra_unit_measure='bottle',
    is_approved=True,
    mra_synced=True,
)

# Lock price and tax
item.price_locked = True
item.tax_locked = True
item.save()
```

### Step 2: Order Completion Handler

```python
# In pos_sessions/views.py or order completion signal

from inventory.services import InventoryService
from mra_eis.services import InvoiceService
from decimal import Decimal

@transaction.atomic
def complete_order(order, user=None):
    """Complete a POS order and create MRA invoice"""
    
    # Step 1: Validate all products
    items_data = []
    for order_item in order.items.all():
        # Get inventory item
        inventory_item = InventoryItem.objects.get(
            id=order_item.inventory_item_id
        )
        
        # Validate for MRA sale
        try:
            mapping = InventoryService.validate_product_for_sale(inventory_item)
        except ValidationError as e:
            raise ValueError(f"Product validation failed: {e}")
        
        items_data.append({
            'order_item': order_item,
            'inventory_item': inventory_item,
            'mapping': mapping,
        })
    
    # Step 2: Create snapshots and reduce stock
    snapshots = []
    for item_data in items_data:
        order_item = item_data['order_item']
        inventory_item = item_data['inventory_item']
        mapping = item_data['mapping']
        
        # Create snapshot
        snapshot = InventoryService.create_inventory_snapshot(
            inventory_item=inventory_item,
            quantity_sold=order_item.quantity,
            related_invoice_number=f"INV-{order.id}",  # Temporary
            related_order_id=str(order.id),
            user=user,
        )
        snapshots.append(snapshot)
        
        # Reduce stock
        InventoryService.reduce_stock(
            inventory_item=inventory_item,
            quantity=order_item.quantity,
            reason='SALE',
            user=user,
        )
    
    # Step 3: Prepare MRA invoice items
    mra_items = []
    for item_data in items_data:
        mapping = item_data['mapping']
        order_item = item_data['order_item']
        
        mra_items.append({
            'mra_product_code': mapping.mra_product_code,
            'name': mapping.mra_product_name,
            'quantity': order_item.quantity,
            'unit_price': order_item.price,
            'tax_rate': mapping.mra_tax_rate,
            'tax_category': mapping.mra_tax_type,
        })
    
    # Step 4: Create MRA invoice
    terminal = Terminal.objects.filter(
        branch=order.branch,
        status='active'
    ).first()
    
    if not terminal:
        raise ValueError("No active terminal for branch")
    
    mra_invoice = InvoiceService.create_invoice(
        terminal=terminal,
        seller_tin=order.business.settings.mra_tin,
        seller_name=order.business.name,
        items=mra_items,
        is_online=terminal.is_online,
    )
    
    # Step 5: Update snapshots with real invoice number
    for snapshot in snapshots:
        snapshot.related_invoice_number = str(mra_invoice.invoice_number)
        snapshot.save()
    
    # Step 6: Submit or queue invoice
    try:
        if terminal.is_online:
            InvoiceService.submit_invoice(mra_invoice)
        else:
            InvoiceService.queue_offline_invoice(mra_invoice)
    except Exception as e:
        # Log error but don't fail order
        logger.error(f"Failed to submit MRA invoice: {e}")
    
    # Step 7: Generate receipt
    receipt = ReceiptService.generate_receipt(mra_invoice)
    
    # Step 8: Link to order
    order.mra_invoice_id = str(mra_invoice.id)
    order.save()
    
    return {
        'order': order,
        'mra_invoice': mra_invoice,
        'receipt': receipt,
        'snapshots': snapshots,
    }
```

### Step 3: Waste Recording

```python
# In inventory/views.py or waste recording endpoint

from inventory.services import InventoryService

def record_waste(request):
    """Record waste with approval"""
    
    inventory_item = InventoryItem.objects.get(id=request.data['item_id'])
    
    waste = InventoryService.record_waste(
        inventory_item=inventory_item,
        quantity=Decimal(request.data['quantity']),
        reason=request.data['reason'],
        cost=Decimal(request.data['cost']),
        notes=request.data.get('notes', ''),
        approved_by=request.data.get('approved_by'),
        user=request.user,
    )
    
    return {
        'waste_id': str(waste.id),
        'status': 'recorded',
    }
```

### Step 4: Stock Transfer

```python
# In inventory/views.py or transfer endpoint

from inventory.services import InventoryService
import uuid

def transfer_stock(request):
    """Transfer stock between branches"""
    
    from_branch = Branch.objects.get(id=request.data['from_branch_id'])
    to_branch = Branch.objects.get(id=request.data['to_branch_id'])
    inventory_item = InventoryItem.objects.get(id=request.data['item_id'])
    
    transfer_reference = f"TRF-{uuid.uuid4().hex[:8].upper()}"
    
    transfer = InventoryService.transfer_stock(
        from_branch=from_branch,
        to_branch=to_branch,
        inventory_item=inventory_item,
        quantity=Decimal(request.data['quantity']),
        transfer_reference=transfer_reference,
        user=request.user,
    )
    
    return {
        'transfer_id': str(transfer.id),
        'reference': transfer_reference,
        'status': 'transferred',
    }
```

---

## 🔍 MRA Audit Queries

### Query 1: Show all sales of a product

```python
from inventory.services import InventoryAuditService

product = InventoryItem.objects.get(name="Coca Cola 500ml")
snapshots = InventoryAuditService.get_sales_by_product(product)

for snapshot in snapshots:
    print(f"Invoice {snapshot.related_invoice_number}: "
          f"{snapshot.quantity_sold} units @ {snapshot.product_price}")
```

### Query 2: Verify tax calculation

```python
from inventory.services import InventoryAuditService

snapshot = InventorySnapshot.objects.get(related_invoice_number='INV-001')
tax_info = InventoryAuditService.verify_tax_calculation(snapshot)

print(f"Tax Rate: {tax_info['tax_rate']}%")
print(f"Tax Type: {tax_info['tax_type']}")
print(f"Expected Tax: {tax_info['expected_tax']}")
```

### Query 3: Get complete audit trail for invoice

```python
from inventory.services import InventoryService

traceability = InventoryService.get_invoice_traceability('INV-001')

print("Snapshots:")
for snapshot in traceability['snapshots']:
    print(f"  - {snapshot.inventory_item.name}: {snapshot.quantity_sold} units")

print("Audit Logs:")
for log in traceability['audit_logs']:
    print(f"  - {log.action_type}: {log.details}")
```

### Query 4: Get waste records

```python
from inventory.services import InventoryAuditService
from datetime import datetime, timedelta

start_date = datetime.now() - timedelta(days=30)
waste = InventoryAuditService.get_waste_records(branch, start_date=start_date)

for record in waste:
    print(f"Waste: {record.inventory_item.name} - "
          f"{record.quantity} units - Approved by: {record.approved_by}")
```

### Query 5: Validate stock consistency

```python
from inventory.services import InventoryService

consistency = InventoryService.validate_stock_consistency(branch)

if consistency['is_consistent']:
    print("✓ Stock is consistent")
else:
    print("✗ Issues found:")
    for issue in consistency['issues']:
        print(f"  - {issue}")
```

---

## 📋 Database Migration

```bash
# Create migration
python manage.py makemigrations inventory

# Review migration
python manage.py showmigrations inventory

# Apply migration
python manage.py migrate inventory
```

---

## 🧪 Testing

### Test 1: Product Validation

```python
from django.test import TestCase
from inventory.services import InventoryService
from inventory.models import InventoryItem, MRAProductMapping

class ProductValidationTest(TestCase):
    def test_validate_mra_ready_product(self):
        """Test product validation"""
        item = InventoryItem.objects.create(
            name="Test Product",
            item_type='sellable',
            price=Decimal('100.00'),
        )
        
        mapping = MRAProductMapping.objects.create(
            inventory_item=item,
            mra_product_code='TEST-001',
            mra_product_name='Test',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            is_approved=True,
            mra_synced=True,
        )
        
        # Should validate successfully
        result = InventoryService.validate_product_for_sale(item)
        self.assertEqual(result.mra_product_code, 'TEST-001')
```

### Test 2: Snapshot Creation

```python
def test_create_snapshot(self):
    """Test snapshot creation"""
    snapshot = InventoryService.create_inventory_snapshot(
        inventory_item=item,
        quantity_sold=Decimal('5'),
        related_invoice_number='INV-001',
    )
    
    self.assertEqual(snapshot.quantity_sold, Decimal('5'))
    self.assertEqual(snapshot.related_invoice_number, 'INV-001')
```

### Test 3: Stock Reduction

```python
def test_reduce_stock(self):
    """Test stock reduction"""
    item.stock_units = Decimal('100')
    item.save()
    
    InventoryService.reduce_stock(item, Decimal('10'))
    
    item.refresh_from_db()
    self.assertEqual(item.stock_units, Decimal('90'))
```

### Test 4: Waste Recording

```python
def test_record_waste(self):
    """Test waste recording"""
    waste = InventoryService.record_waste(
        inventory_item=item,
        quantity=Decimal('5'),
        reason='Expired',
        cost=Decimal('500.00'),
        approved_by='Manager',
    )
    
    self.assertEqual(waste.quantity, Decimal('5'))
    self.assertEqual(waste.reason, 'Expired')
    self.assertTrue(waste.affects_tax)
```

---

## ✅ Certification Checklist

- [ ] All products have MRA mappings
- [ ] All mappings are approved and synced
- [ ] Snapshots are created for every sale
- [ ] Stock is reduced after snapshot
- [ ] Audit logs are created for all operations
- [ ] Waste is approved before recording
- [ ] Stock transfers have unique references
- [ ] Tax calculations are verified
- [ ] Traceability queries work
- [ ] Stock consistency is validated

---

## 🚀 Deployment

1. **Backup database**
   ```bash
   python manage.py dumpdata inventory > inventory_backup.json
   ```

2. **Create migration**
   ```bash
   python manage.py makemigrations inventory
   ```

3. **Test migration**
   ```bash
   python manage.py migrate inventory --plan
   ```

4. **Apply migration**
   ```bash
   python manage.py migrate inventory
   ```

5. **Create product mappings**
   - Use admin or API to create MRA mappings
   - Approve and sync all products

6. **Test flows**
   - Test order completion
   - Test waste recording
   - Test stock transfer
   - Test audit queries

7. **Go live**
   - Monitor for errors
   - Verify audit logs
   - Confirm MRA sync

---

## 📞 Support

For questions about:
- **Product Setup**: See Step 1
- **Order Completion**: See Step 2
- **Waste Recording**: See Step 3
- **Stock Transfer**: See Step 4
- **Audit Queries**: See MRA Audit Queries section
- **Testing**: See Testing section

---

**Status**: ✅ Ready for Implementation
**Effort**: Medium (mostly integration work)
**Risk**: Low (backward compatible)
