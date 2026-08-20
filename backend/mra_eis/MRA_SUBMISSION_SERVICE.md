# MRA EIS Submission Service - Centralized Architecture

## 🎯 Overview

All MRA submission functionality has been centralized in the `mra_eis` app's `POSOrderSubmissionService` class. This service is reused throughout the system, ensuring consistent MRA compliance and reducing code duplication.

---

## 📍 Service Location

**File**: `/backend/mra_eis/services.py`
**Class**: `POSOrderSubmissionService`

---

## 🔧 Available Methods

### 1. Submit POS Order to MRA
```python
POSOrderSubmissionService.submit_pos_order_to_mra(
    pos_order,           # Order object from pos_sessions
    eis_uuid,            # UUID from MRA
    qr_code_payload,     # QR code data from MRA
    digital_signature    # Digital signature from MRA
)
```

**Returns**: Updated pos_order object
**Raises**: ValueError if order cannot be submitted

**Example**:
```python
from mra_eis.services import POSOrderSubmissionService
from pos_sessions.models import Order

order = Order.objects.get(id='order-uuid')
updated_order = POSOrderSubmissionService.submit_pos_order_to_mra(
    order,
    eis_uuid='eis-uuid-from-mra',
    qr_code_payload='qr-data',
    digital_signature='signature'
)
```

---

### 2. Get Pending POS Orders
```python
POSOrderSubmissionService.get_pending_pos_orders(
    business=None,  # Optional: filter by business
    branch=None     # Optional: filter by branch
)
```

**Returns**: QuerySet of pending orders

**Example**:
```python
# Get all pending orders
pending = POSOrderSubmissionService.get_pending_pos_orders()

# Get pending orders for specific business
pending = POSOrderSubmissionService.get_pending_pos_orders(business=business_obj)

# Get pending orders for specific branch
pending = POSOrderSubmissionService.get_pending_pos_orders(branch=branch_obj)
```

---

### 3. Get Submitted POS Orders
```python
POSOrderSubmissionService.get_submitted_pos_orders(
    business=None,  # Optional: filter by business
    branch=None     # Optional: filter by branch
)
```

**Returns**: QuerySet of submitted orders

---

### 4. Get Locked POS Orders
```python
POSOrderSubmissionService.get_locked_pos_orders(
    business=None,  # Optional: filter by business
    branch=None     # Optional: filter by branch
)
```

**Returns**: QuerySet of locked orders

---

### 5. Batch Submit POS Orders
```python
POSOrderSubmissionService.batch_submit_pos_orders(
    orders_data  # List of dicts with order submission data
)
```

**Parameters**:
```python
orders_data = [
    {
        'order_id': 'uuid-1',
        'eis_uuid': 'eis-uuid-1',
        'qr_code_payload': 'qr-data-1',
        'digital_signature': 'sig-1'
    },
    {
        'order_id': 'uuid-2',
        'eis_uuid': 'eis-uuid-2',
        'qr_code_payload': 'qr-data-2',
        'digital_signature': 'sig-2'
    }
]
```

**Returns**: Dict with results
```python
{
    'success': 2,
    'failed': 0,
    'errors': []
}
```

---

## 🔄 Usage Across the System

### From POS Sessions Views
```python
from mra_eis.services import POSOrderSubmissionService

# In a view or API endpoint
pending_orders = POSOrderSubmissionService.get_pending_pos_orders(business=request.user.business)
```

### From Business Module
```python
from mra_eis.services import POSOrderSubmissionService

# In business logic
submitted_orders = POSOrderSubmissionService.get_submitted_pos_orders(branch=branch_obj)
```

### From Inventory Module
```python
from mra_eis.services import POSOrderSubmissionService

# In inventory operations
locked_orders = POSOrderSubmissionService.get_locked_pos_orders(business=business_obj)
```

### From MRA EIS Views
```python
from mra_eis.services import POSOrderSubmissionService

# In MRA EIS API endpoints
result = POSOrderSubmissionService.batch_submit_pos_orders(orders_data)
```

---

## ✅ What Was Removed from POS Sessions Views

The following MRA submission actions were removed from `pos_sessions/views.py` to avoid duplication:

- ❌ `submit_to_mra` action
- ❌ `pending_mra_submission` action
- ❌ `mra_submitted` action
- ❌ `locked` action

These are now accessed through the centralized `POSOrderSubmissionService`.

---

## 🎯 Benefits of Centralization

✅ **Single Source of Truth**: All MRA submission logic in one place
✅ **Reusability**: Used across all modules without duplication
✅ **Consistency**: Same validation and error handling everywhere
✅ **Maintainability**: Changes to MRA logic only need to be made once
✅ **Testability**: Service can be tested independently
✅ **Scalability**: Easy to add new submission methods

---

## 📊 Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   MRA EIS App                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  POSOrderSubmissionService (Centralized)         │   │
│  │  - submit_pos_order_to_mra()                     │   │
│  │  - get_pending_pos_orders()                      │   │
│  │  - get_submitted_pos_orders()                    │   │
│  │  - get_locked_pos_orders()                       │   │
│  │  - batch_submit_pos_orders()                     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         ↑                    ↑                    ↑
         │                    │                    │
    ┌────────────┐    ┌──────────────┐    ┌──────────────┐
    │ POS Views  │    │ Business     │    │ Inventory    │
    │            │    │ Module       │    │ Module       │
    └────────────┘    └──────────────┘    └──────────────┘
```

---

## 🚀 Integration Example

### In MRA EIS Views
```python
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from mra_eis.services import POSOrderSubmissionService

class MRASubmissionViewSet(viewsets.ViewSet):
    
    @action(detail=False, methods=['get'])
    def pending_orders(self, request):
        """Get pending POS orders for submission"""
        business = request.user.businesses.first()
        orders = POSOrderSubmissionService.get_pending_pos_orders(business=business)
        # Serialize and return
        return Response(serializer.data)
    
    @action(detail=False, methods=['post'])
    def batch_submit(self, request):
        """Batch submit orders to MRA"""
        result = POSOrderSubmissionService.batch_submit_pos_orders(request.data)
        return Response(result)
```

---

## 📝 Notes

- All methods are static and can be called without instantiating the service
- The service handles validation and error handling
- Orders are automatically locked when submitted
- The service is transaction-safe
- All operations are logged for audit purposes

---

**Status**: ✅ Centralized MRA submission service implemented
**Location**: `/backend/mra_eis/services.py`
**Class**: `POSOrderSubmissionService`
**Ready for**: System-wide reuse
