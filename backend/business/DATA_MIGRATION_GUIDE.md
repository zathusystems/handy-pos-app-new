# MRA EIS Data Migration Guide

## Overview

This guide helps you migrate existing invoices from JSON-based items to the new relational `InvoiceLine` model while maintaining MRA compliance.

---

## Step 1: Create Empty Migration

```bash
python manage.py makemigrations business --empty --name migrate_invoices_to_lines
```

---

## Step 2: Create Migration File

Create a data migration file at:
`backend/business/migrations/0XXX_migrate_invoices_to_lines.py`

```python
from django.db import migrations
from decimal import Decimal
import json

def migrate_invoices_to_lines(apps, schema_editor):
    """
    Migrate existing Invoice items from JSON to InvoiceLine model.
    """
    Invoice = apps.get_model('business', 'Invoice')
    InvoiceLine = apps.get_model('business', 'InvoiceLine')
    
    migrated_count = 0
    error_count = 0
    
    for invoice in Invoice.objects.all():
        try:
            # Skip if items is empty or None
            if not invoice.items:
                continue
            
            # Parse items (should be list of dicts)
            items = invoice.items if isinstance(invoice.items, list) else json.loads(invoice.items)
            
            # Create InvoiceLine for each item
            for item in items:
                InvoiceLine.objects.create(
                    invoice=invoice,
                    product_code=item.get('product_code', ''),
                    product_name=item.get('name', item.get('product_name', '')),
                    quantity=Decimal(str(item.get('quantity', 0))),
                    unit_price=Decimal(str(item.get('price', item.get('unit_price', 0)))),
                    tax_rate=Decimal(str(item.get('tax_rate', 0))),
                    tax_amount=Decimal(str(item.get('tax_amount', 0))),
                    total_amount=Decimal(str(item.get('total_amount', 0))),
                    mra_product_code=item.get('mra_product_code', None),
                )
            
            # Lock paid invoices
            if invoice.status == 'Paid':
                invoice.is_locked = True
                invoice.save(update_fields=['is_locked'])
            
            migrated_count += 1
            
        except Exception as e:
            print(f"Error migrating invoice {invoice.id}: {str(e)}")
            error_count += 1
    
    print(f"Migration complete: {migrated_count} invoices migrated, {error_count} errors")


def reverse_migration(apps, schema_editor):
    """
    Reverse migration - delete all InvoiceLine records.
    """
    InvoiceLine = apps.get_model('business', 'InvoiceLine')
    InvoiceLine.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0XXX_previous_migration'),  # Update this
    ]

    operations = [
        migrations.RunPython(migrate_invoices_to_lines, reverse_migration),
    ]
```

---

## Step 3: Run Migration

```bash
# Test the migration
python manage.py migrate business --plan

# Apply the migration
python manage.py migrate business
```

---

## Step 4: Verify Migration

```python
# In Django shell
python manage.py shell

from business.models import Invoice, InvoiceLine

# Check migration success
invoices_with_items = Invoice.objects.filter(items__isnull=False).exclude(items=[])
print(f"Invoices with items: {invoices_with_items.count()}")

# Check line items created
line_items = InvoiceLine.objects.all()
print(f"Line items created: {line_items.count()}")

# Verify locked invoices
locked_invoices = Invoice.objects.filter(is_locked=True)
print(f"Locked invoices: {locked_invoices.count()}")

# Sample verification
sample_invoice = Invoice.objects.first()
print(f"Invoice {sample_invoice.id}:")
print(f"  Status: {sample_invoice.status}")
print(f"  Locked: {sample_invoice.is_locked}")
print(f"  Line items: {sample_invoice.lines.count()}")
```

---

## Step 5: Cleanup (Optional)

After verifying the migration, you can optionally remove the `items` JSONField from Invoice:

```python
# Create a new migration
python manage.py makemigrations business --empty --name remove_invoice_items_json

# In the migration file:
class Migration(migrations.Migration):
    dependencies = [
        ('business', '0XXX_migrate_invoices_to_lines'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='invoice',
            name='items',
        ),
    ]
```

---

## Rollback Plan

If you need to rollback:

```bash
# Reverse the migration
python manage.py migrate business 0XXX_previous_migration

# This will:
# 1. Delete all InvoiceLine records
# 2. Restore the original state
```

---

## Verification Checklist

- [ ] Migration runs without errors
- [ ] All invoices have corresponding line items
- [ ] Paid invoices are locked
- [ ] Line item totals match invoice totals
- [ ] Tax amounts are preserved
- [ ] MRA product codes are migrated
- [ ] Audit trail is complete

---

## Troubleshooting

### Issue: Migration fails with "items is not JSON"

**Solution**: Update the migration to handle both JSON and list formats:

```python
items = invoice.items
if isinstance(items, str):
    items = json.loads(items)
elif not isinstance(items, list):
    items = []
```

### Issue: Decimal conversion errors

**Solution**: Ensure all numeric values are converted to Decimal:

```python
from decimal import Decimal

value = Decimal(str(item.get('quantity', 0)))
```

### Issue: Missing product codes

**Solution**: Use empty string as default:

```python
product_code=item.get('product_code', ''),
```

---

## Post-Migration

After successful migration:

1. ✅ Update Invoice creation code to use InvoiceLine
2. ✅ Update Invoice serializers to include lines
3. ✅ Update Invoice views to handle line items
4. ✅ Test invoice creation with new model
5. ✅ Test invoice locking
6. ✅ Test immutability enforcement

---

## Integration with MRA EIS

Once migration is complete, integrate with MRA EIS:

```python
# When submitting to MRA
invoice = Invoice.objects.get(id=invoice_id)

# Build MRA payload from line items
mra_items = []
for line in invoice.lines.all():
    mra_items.append({
        'product_code': line.mra_product_code or line.product_code,
        'name': line.product_name,
        'quantity': str(line.quantity),
        'unit_price': str(line.unit_price),
        'tax_rate': str(line.tax_rate),
        'tax_amount': str(line.tax_amount),
        'total_amount': str(line.total_amount),
    })

# Submit to MRA
response = submit_to_mra(mra_items)

# Update invoice with MRA response
invoice.mra_invoice_number = response['invoice_number']
invoice.mra_receipt_signature = response['signature']
invoice.mra_qr_code = response['qr_code']
invoice.mra_status = 'SUBMITTED'
invoice.mra_submitted_at = timezone.now()
invoice.is_locked = True
invoice.save()
```

---

## Success Criteria

✅ All invoices migrated to InvoiceLine
✅ Paid invoices are locked
✅ Line item totals match invoice totals
✅ No data loss
✅ Audit trail is complete
✅ MRA compliance maintained

---

**Status**: Ready for Migration
**Estimated Time**: 5-10 minutes
**Risk Level**: Low (reversible)
