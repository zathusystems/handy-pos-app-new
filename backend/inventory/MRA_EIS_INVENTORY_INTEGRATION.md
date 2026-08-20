# MRA EIS Inventory Integration

## Overview

The inventory backend has been enhanced with comprehensive MRA EIS compliance features. This document outlines all new fields, models, and integrations.

---

## 1. New MRA EIS Models

### A. MRAProductMapping (CRITICAL)
Maps internal inventory items to MRA-approved products.

**Key Fields:**
```python
mra_product_code          # MRA-assigned product code (unique)
mra_product_name          # MRA-approved product name
mra_tax_type              # Tax classification (standard, zero, exempt)
mra_tax_rate              # Tax rate (immutable)
mra_unit_measure          # Unit of measure (unit, kg, liter, etc.)
is_approved               # MRA approval status
approved_at               # Approval timestamp
mra_synced                # Sync status with MRA
last_synced_at            # Last sync timestamp
```

**Methods:**
- `is_ready_for_sale()` - Check if product is ready for MRA sales

**Relationships:**
- OneToOne with InventoryItem

---

### B. InventorySnapshot (CRITICAL FOR AUDIT)
Point-in-time inventory state when a sale is made.

**Key Fields:**
```python
inventory_item            # FK to InventoryItem
branch                    # FK to Branch
quantity_before_sale      # Stock before sale (immutable)
quantity_sold             # Quantity sold (immutable)
quantity_after_sale       # Stock after sale (immutable)
related_invoice_number    # Invoice number (MRA traceability)
related_order_id          # POS order ID
product_price             # Price at time of sale
product_tax_rate          # Tax rate at time of sale
product_tax_type          # Tax type at time of sale
created_at                # Snapshot timestamp
```

**Purpose:**
- Provides complete audit trail for MRA
- Prevents price/tax manipulation
- Links inventory to invoices

---

### C. StockAudit (MRA COMPLIANCE)
Stock take/audit records with MRA authority control.

**Key Fields:**
```python
business                  # FK to Business
branch                    # FK to Branch
status                    # Pending, Approved, Rejected
total_discrepancy_value   # Total value of discrepancies
approval_role             # Manager, Auditor, MRA Official
mra_visible               # Is audit visible to MRA?
inventory_locked          # Is inventory locked after approval?
created_by                # User who created audit
approved_by               # User who approved audit
approved_at               # Approval timestamp
```

**Related Model:**
- StockAuditItem - Individual items in audit

---

## 2. Enhanced Existing Models

### A. InventoryItem (Enhanced)

**New MRA Fields:**
```python
price_locked              # Is price locked by MRA?
tax_locked                # Is tax rate locked?
```

**New Methods:**
- `is_mra_ready()` - Check if item is ready for MRA sales
- `get_available_portions()` - For Bar & Liquor items
- `get_portion_info()` - Portion information

**Relationships:**
- OneToOne with MRAProductMapping (via mra_mapping)
- OneToMany with InventorySnapshot

---

### B. Supplier (Enhanced)

**New MRA Fields:**
```python
supplier_tin              # Supplier's Tax Identification Number
vat_registered            # Is supplier VAT registered?
```

**New Methods:**
- `get_balance_due()` - Calculate balance due
- `get_total_purchase_orders_amount()` - Total PO amount
- `get_unpaid_purchase_orders_amount()` - Unpaid PO amount

---

### C. PurchaseOrder (Enhanced)

**New MRA Fields:**
```python
supplier_tin              # Supplier TIN for VAT reclaim
supplier_vat_registered   # Is supplier VAT registered?
```

**Purpose:**
- Track VAT reclaim eligibility
- Maintain supplier compliance records

---

### D. StockTransfer (Enhanced)

**New MRA Fields:**
```python
transfer_reference        # Unique transfer reference for MRA
mra_notified              # Has MRA been notified?
```

**Purpose:**
- Track inter-branch transfers for MRA
- Maintain transfer audit trail

---

### E. WasteRecord (Enhanced)

**New MRA Fields:**
```python
affects_tax               # Does waste affect tax reporting?
approved_by               # Manager/Auditor who approved
```

**Purpose:**
- Track waste that affects tax
- Maintain waste approval trail

---

### F. AuditLog (Enhanced)

**New MRA Fields:**
```python
mra_related               # Is operation related to MRA?
mra_reference             # MRA invoice or reference number
```

**New Action Types:**
- STOCK_WASTE
- STOCK_RECEIVE
- STOCK_TRANSFER
- STOCK_AUDIT
- INVENTORY_UPDATE
- PRICE_CHANGE
- TAX_CHANGE
- MRA_SYNC

**New Entity Types:**
- WasteRecord
- PurchaseOrder
- StockTransfer
- InventoryItem
- MRAProductMapping
- InventorySnapshot

---

## 3. Frontend Integration

### New Tabs in Inventory Page

#### A. MRA Mappings Tab
- View all product mappings
- Map products to MRA codes
- Approve/sync mappings
- Track sync status

#### B. MRA Compliance Tab
- View compliance status
- Track price locks
- Monitor tax locks
- View approval status

#### C. Stock Audit Tab
- Create stock audits
- Record discrepancies
- Approve audits
- View audit history

---

## 4. API Endpoints (Backend)

### MRA Product Mapping
```
GET    /inventory/mra-mappings/
POST   /inventory/mra-mappings/
GET    /inventory/mra-mappings/{id}/
PUT    /inventory/mra-mappings/{id}/
POST   /inventory/mra-mappings/{id}/approve/
POST   /inventory/mra-mappings/{id}/sync/
```

### Inventory Snapshots
```
GET    /inventory/snapshots/
POST   /inventory/snapshots/
GET    /inventory/snapshots/{id}/
```

### Stock Audits
```
GET    /inventory/stock-audits/
POST   /inventory/stock-audits/
GET    /inventory/stock-audits/{id}/
POST   /inventory/stock-audits/{id}/approve/
POST   /inventory/stock-audits/{id}/reject/
```

### Audit Logs
```
GET    /inventory/audit-logs/
GET    /inventory/audit-logs/?mra_related=true
GET    /inventory/audit-logs/?mra_reference={reference}
```

---

## 5. MRA Compliance Features

### A. Price Control
- Prices can be locked by MRA
- Locked prices cannot be changed locally
- Prevents price manipulation

### B. Tax Control
- Tax rates locked for sellable items
- Tax rates immutable once set
- Prevents tax evasion

### C. Inventory Traceability
- Every sale creates InventorySnapshot
- Links inventory to invoice
- Complete audit trail

### D. Supplier Compliance
- Track supplier TIN
- Track VAT registration
- Maintain VAT reclaim records

### E. Waste Tracking
- Track waste that affects tax
- Require approval for waste
- Maintain waste audit trail

### F. Stock Audits
- Create point-in-time audits
- Track discrepancies
- Require MRA/Auditor approval
- Lock inventory after approval

---

## 6. Database Indexes

### MRAProductMapping
```python
Index(fields=['mra_product_code'])
Index(fields=['is_approved'])
Index(fields=['mra_synced'])
```

### InventorySnapshot
```python
Index(fields=['inventory_item', 'branch'])
Index(fields=['related_invoice_number'])
Index(fields=['created_at'])
```

### StockAudit
```python
Index(fields=['branch', 'status'])
Index(fields=['mra_visible'])
```

### AuditLog
```python
Index(fields=['business', 'created_at'])
Index(fields=['branch', 'created_at'])
Index(fields=['action_type'])
Index(fields=['entity_type'])
Index(fields=['mra_related'])
Index(fields=['mra_reference'])
```

---

## 7. MRA Compliance Workflow

### Product Mapping Workflow
```
1. Create InventoryItem
   ↓
2. Create MRAProductMapping
   ↓
3. Get MRA approval (is_approved = True)
   ↓
4. Sync to MRA (mra_synced = True)
   ↓
5. Product ready for sale (is_mra_ready() = True)
```

### Sale Workflow
```
1. Sale created in POS
   ↓
2. InventorySnapshot created (immutable)
   ↓
3. Stock updated
   ↓
4. Invoice created with snapshot reference
   ↓
5. AuditLog created with MRA reference
```

### Waste Workflow
```
1. WasteRecord created
   ↓
2. If affects_tax = True, requires approval
   ↓
3. Manager/Auditor approves
   ↓
4. Stock adjusted
   ↓
5. AuditLog created with MRA reference
```

### Stock Audit Workflow
```
1. StockAudit created
   ↓
2. StockAuditItem records created
   ↓
3. Discrepancies calculated
   ↓
4. Approval required (Manager/Auditor/MRA)
   ↓
5. If approved, inventory locked
   ↓
6. AuditLog created
```

---

## 8. Immutability & Audit Trail

### Immutable Records
- InventorySnapshot (once created, never modified)
- MRAProductMapping (tax_rate immutable)
- StockAudit (once approved, locked)

### Audit Trail
- AuditLog tracks all operations
- MRA reference links to invoices
- Complete traceability from stock to invoice

### Write-Once Storage
- Snapshots created at point of sale
- Cannot be edited or deleted
- Provides MRA audit evidence

---

## 9. Frontend Components

### New Components
- `MRAComplianceTab` - Compliance status display
- `StockAuditTab` - Stock audit management
- `MRAMappingsTab` - Product mapping management

### Updated Components
- `InventoryTab` - Shows MRA-ready status
- `PurchasesTab` - Shows supplier TIN
- `WasteTab` - Shows approval status

---

## 10. Testing

### Unit Tests
- MRA product mapping creation
- Inventory snapshot creation
- Stock audit workflow
- Waste approval workflow

### Integration Tests
- End-to-end sale with snapshot
- Audit trail verification
- MRA sync verification

### Compliance Tests
- Price lock enforcement
- Tax lock enforcement
- Immutability verification
- Audit trail completeness

---

## 11. Migration Guide

### For Existing Installations

1. **Run Migrations**
   ```bash
   python manage.py migrate inventory
   ```

2. **Create MRA Mappings**
   - Map existing products to MRA codes
   - Get MRA approval
   - Sync to MRA

3. **Enable Snapshots**
   - Snapshots created automatically on sales
   - No manual action required

4. **Configure Audits**
   - Set up stock audit schedule
   - Configure approval roles

---

## 12. Compliance Checklist

✅ Product mapping to MRA codes
✅ Tax rate immutability
✅ Price lock enforcement
✅ Inventory snapshots at point of sale
✅ Complete audit trail
✅ Supplier compliance tracking
✅ Waste approval workflow
✅ Stock audit workflow
✅ MRA reference linking
✅ Write-once storage
✅ Immutable records
✅ Role-based approvals

---

## Summary

The inventory backend now provides:
- **Full MRA compliance** with product mapping and tax control
- **Complete audit trail** with immutable snapshots
- **Supplier compliance** tracking with VAT records
- **Waste management** with approval workflow
- **Stock audits** with MRA authority control
- **Price/tax locks** to prevent manipulation
- **Traceability** from stock to invoice

All features are designed to pass MRA certification and audit requirements.
