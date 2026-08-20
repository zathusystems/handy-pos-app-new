# Inventory API - Complete Documentation

## 🎯 Overview

This document describes all API endpoints for the MRA EIS-compliant inventory module.

---

## 📋 Base URL

```
/api/inventory/
```

---

## 🔐 Authentication

All endpoints require authentication:

```bash
Authorization: Bearer <token>
```

---

## 📊 Endpoints

### SUPPLIERS

#### List Suppliers
```
GET /api/inventory/suppliers/
```

**Query Parameters:**
- `business_id` - Filter by business (required)
- `search` - Search by name, email, or TIN
- `ordering` - Order by field

**Response:**
```json
{
  "count": 10,
  "next": null,
  "previous": null,
  "results": [
    {
      "id": "uuid",
      "name": "Supplier Name",
      "email": "supplier@example.com",
      "phone": "+265123456789",
      "supplier_tin": "1234567890",
      "vat_registered": true,
      "total_amount_due": "50000.00",
      "total_amount_paid": "30000.00",
      "balance_due": "20000.00",
      "is_active": true,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### Create Supplier
```
POST /api/inventory/suppliers/
```

**Query Parameters:**
- `business_id` - Business ID (required)

**Request Body:**
```json
{
  "name": "Supplier Name",
  "email": "supplier@example.com",
  "phone": "+265123456789",
  "address": "123 Main St",
  "city": "Lilongwe",
  "country": "Malawi",
  "supplier_tin": "1234567890",
  "vat_registered": true
}
```

#### Get Supplier Details
```
GET /api/inventory/suppliers/{id}/
```

#### Update Supplier
```
PUT /api/inventory/suppliers/{id}/
PATCH /api/inventory/suppliers/{id}/
```

#### Delete Supplier
```
DELETE /api/inventory/suppliers/{id}/
```

#### Get Supplier Balance
```
GET /api/inventory/suppliers/{id}/balance/
```

**Response:**
```json
{
  "supplier_id": "uuid",
  "name": "Supplier Name",
  "total_amount_due": "50000.00",
  "total_amount_paid": "30000.00",
  "balance_due": "20000.00"
}
```

#### Get Supplier Purchase Orders
```
GET /api/inventory/suppliers/{id}/purchase_orders/
```

---

### MRA PRODUCT MAPPINGS

#### List Mappings
```
GET /api/inventory/mra-mappings/
```

**Query Parameters:**
- `business_id` - Filter by business
- `search` - Search by code or name
- `ordering` - Order by field

#### Create Mapping
```
POST /api/inventory/mra-mappings/
```

**Request Body:**
```json
{
  "inventory_item": "item-uuid",
  "mra_product_code": "BEVERAGE-001",
  "mra_product_name": "Soft Drink - 500ml",
  "mra_tax_type": "standard",
  "mra_tax_rate": "16.50",
  "mra_unit_measure": "bottle"
}
```

#### Approve Mapping
```
POST /api/inventory/mra-mappings/{id}/approve/
```

**Request Body:**
```json
{
  "is_approved": true,
  "mra_synced": true
}
```

#### Get Unapproved Mappings
```
GET /api/inventory/mra-mappings/unapproved/
```

#### Get Unsynced Mappings
```
GET /api/inventory/mra-mappings/unsynced/
```

---

### INVENTORY ITEMS

#### List Items
```
GET /api/inventory/items/
```

**Query Parameters:**
- `business_id` - Filter by business
- `branch_id` - Filter by branch
- `search` - Search by name, SKU, or barcode
- `ordering` - Order by field

#### Create Item
```
POST /api/inventory/items/
```

**Query Parameters:**
- `business_id` - Business ID (required)
- `branch_id` - Branch ID (required)

**Request Body:**
```json
{
  "name": "Coca Cola 500ml",
  "category": "Beverages",
  "item_type": "sellable",
  "stock_units": "100.000",
  "unit_type": "bottle",
  "reorder_level": "20.000",
  "cost": "1500.00",
  "price": "2500.00",
  "sku": "CC-500",
  "barcode": "1234567890",
  "expiry": "2025-12-31"
}
```

#### Get Item Details
```
GET /api/inventory/items/{id}/
```

#### Update Item
```
PUT /api/inventory/items/{id}/
PATCH /api/inventory/items/{id}/
```

#### Lock Price/Tax
```
POST /api/inventory/items/{id}/lock/
```

**Request Body:**
```json
{
  "price_locked": true,
  "tax_locked": true
}
```

#### Get Product Traceability
```
GET /api/inventory/items/{id}/traceability/
```

**Response:**
```json
{
  "product_id": "uuid",
  "product_name": "Coca Cola 500ml",
  "snapshots_count": 5,
  "waste_count": 2,
  "transfers_count": 1,
  "snapshots": [...],
  "waste": [...],
  "transfers": [...]
}
```

#### Get Low Stock Items
```
GET /api/inventory/items/low_stock/
```

#### Get Out of Stock Items
```
GET /api/inventory/items/out_of_stock/
```

#### Get MRA-Ready Items
```
GET /api/inventory/items/mra_ready/
```

---

### INVENTORY SNAPSHOTS

#### List Snapshots
```
GET /api/inventory/snapshots/
```

**Query Parameters:**
- `business_id` - Filter by business
- `invoice_number` - Filter by invoice
- `search` - Search by invoice or product name

#### Get Snapshot Details
```
GET /api/inventory/snapshots/{id}/
```

#### Get Snapshots by Invoice
```
GET /api/inventory/snapshots/by_invoice/?invoice_number=INV-001
```

---

### WASTE RECORDS

#### List Waste Records
```
GET /api/inventory/waste/
```

**Query Parameters:**
- `business_id` - Filter by business
- `branch_id` - Filter by branch
- `search` - Search by product name or reason

#### Create Waste Record
```
POST /api/inventory/waste/
```

**Request Body:**
```json
{
  "inventory_item_id": "item-uuid",
  "quantity": "5.000",
  "unit": "bottle",
  "cost": "12500.00",
  "reason": "Expired",
  "notes": "Expired on 2024-01-01",
  "approved_by": "Manager Name"
}
```

#### Get Waste by Reason
```
GET /api/inventory/waste/by_reason/?reason=Expired
```

#### Get Unapproved Waste
```
GET /api/inventory/waste/unapproved/
```

---

### STOCK TRANSFERS

#### List Transfers
```
GET /api/inventory/transfers/
```

**Query Parameters:**
- `business_id` - Filter by business
- `search` - Search by reference or product

#### Create Transfer
```
POST /api/inventory/transfers/
```

**Request Body:**
```json
{
  "from_branch_id": "branch-uuid",
  "to_branch_id": "branch-uuid",
  "inventory_item_id": "item-uuid",
  "quantity": "10.000"
}
```

#### Mark as Notified
```
POST /api/inventory/transfers/{id}/mark_notified/
```

#### Get Unnotified Transfers
```
GET /api/inventory/transfers/unnotified/
```

---

### AUDIT LOGS

#### List Audit Logs
```
GET /api/inventory/audit-logs/
```

**Query Parameters:**
- `business_id` - Filter by business
- `entity_type` - Filter by entity type
- `action_type` - Filter by action type
- `mra_related` - Filter by MRA-related (true/false)

#### Get Logs by Entity
```
GET /api/inventory/audit-logs/by_entity/?entity_id=uuid
```

#### Get MRA-Related Logs
```
GET /api/inventory/audit-logs/mra_related/
```

#### Get Logs by Invoice
```
GET /api/inventory/audit-logs/by_invoice/?invoice_number=INV-001
```

---

## 🔄 Integration with MRA EIS

### Order Completion Flow

```python
# 1. Validate product
GET /api/inventory/items/{id}/
# Check: is_mra_ready = true

# 2. Create snapshot
POST /api/inventory/snapshots/
{
  "inventory_item": "item-uuid",
  "quantity_before_sale": 100,
  "quantity_sold": 5,
  "related_invoice_number": "INV-001"
}

# 3. Reduce stock
PATCH /api/inventory/items/{id}/
{
  "stock_units": 95
}

# 4. Get audit logs
GET /api/inventory/audit-logs/by_invoice/?invoice_number=INV-001
```

---

## 🧪 Example Requests

### Create Product with MRA Mapping

```bash
# 1. Create inventory item
curl -X POST http://localhost:8000/api/inventory/items/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Coca Cola 500ml",
    "category": "Beverages",
    "item_type": "sellable",
    "stock_units": "100.000",
    "price": "2500.00",
    "cost": "1500.00"
  }' \
  -G -d "business_id=<business_id>&branch_id=<branch_id>"

# 2. Create MRA mapping
curl -X POST http://localhost:8000/api/inventory/mra-mappings/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "inventory_item": "<item_id>",
    "mra_product_code": "BEVERAGE-001",
    "mra_product_name": "Soft Drink",
    "mra_tax_type": "standard",
    "mra_tax_rate": "16.50",
    "mra_unit_measure": "bottle"
  }'

# 3. Approve mapping
curl -X POST http://localhost:8000/api/inventory/mra-mappings/<mapping_id>/approve/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "is_approved": true,
    "mra_synced": true
  }'

# 4. Lock price and tax
curl -X POST http://localhost:8000/api/inventory/items/<item_id>/lock/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "price_locked": true,
    "tax_locked": true
  }'
```

### Record Waste

```bash
curl -X POST http://localhost:8000/api/inventory/waste/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "inventory_item_id": "<item_id>",
    "quantity": "5.000",
    "cost": "12500.00",
    "reason": "Expired",
    "approved_by": "Manager Name"
  }' \
  -G -d "business_id=<business_id>&branch_id=<branch_id>"
```

### Transfer Stock

```bash
curl -X POST http://localhost:8000/api/inventory/transfers/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "from_branch_id": "<from_branch_id>",
    "to_branch_id": "<to_branch_id>",
    "inventory_item_id": "<item_id>",
    "quantity": "10.000"
  }'
```

### Get Product Traceability

```bash
curl -X GET http://localhost:8000/api/inventory/items/<item_id>/traceability/ \
  -H "Authorization: Bearer <token>"
```

---

## ✅ Error Handling

### Common Errors

#### 400 Bad Request
```json
{
  "error": "Product not MRA-approved",
  "details": "Product must have MRA mapping and be approved"
}
```

#### 404 Not Found
```json
{
  "detail": "Not found."
}
```

#### 401 Unauthorized
```json
{
  "detail": "Authentication credentials were not provided."
}
```

#### 403 Forbidden
```json
{
  "detail": "You do not have permission to perform this action."
}
```

---

## 📊 Response Formats

### List Response
```json
{
  "count": 100,
  "next": "http://api.example.com/items/?page=2",
  "previous": null,
  "results": [...]
}
```

### Detail Response
```json
{
  "id": "uuid",
  "name": "Product Name",
  ...
}
```

### Error Response
```json
{
  "error": "Error message",
  "details": {...}
}
```

---

## 🔍 Filtering & Searching

### Search
```
GET /api/inventory/items/?search=coca
```

### Ordering
```
GET /api/inventory/items/?ordering=-created_at
GET /api/inventory/items/?ordering=name
```

### Pagination
```
GET /api/inventory/items/?page=2
```

---

## 📞 Support

For API issues:
1. Check authentication token
2. Verify business_id and branch_id parameters
3. Review error messages
4. Check audit logs for operation history

---

**Status**: ✅ Ready for Use
**Version**: 1.0.0
**Last Updated**: 2024
