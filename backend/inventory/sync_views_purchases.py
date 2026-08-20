"""
Purchase Sync Views
Handles synchronization of purchase orders between frontend and backend
"""

from collections import defaultdict
from decimal import Decimal
import re
from django.db.models import Q

from .models import InventoryItem, PurchaseOrder, PurchaseOrderItem, Supplier
from business.models import Business, Branch


def _parse_boolean(value, default=False):
    """Parse boolean-like values from sync payloads safely."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'on'}
    return default


def _parse_decimal(value, default=Decimal('0')):
    """Parse decimal-like values from sync payloads safely."""
    if value in (None, ''):
        return default
    try:
        return Decimal(str(value))
    except Exception:
        return default


def _update_inventory_after_purchase_removal(inventory_item, quantity_to_remove):
    """Remove available stock safely and refresh derived inventory fields."""
    safe_quantity = max(Decimal('0'), quantity_to_remove or Decimal('0'))
    if safe_quantity <= 0:
        return

    old_stock = inventory_item.stock_units or Decimal('0')
    new_stock = max(Decimal('0'), old_stock - safe_quantity)
    inventory_item.stock_units = new_stock
    inventory_item.value = new_stock * (inventory_item.cost or Decimal('0'))

    if new_stock > inventory_item.reorder_level:
        inventory_item.status = 'In Stock'
    elif new_stock > 0:
        inventory_item.status = 'Low Stock'
    else:
        inventory_item.status = 'Out of Stock'

    inventory_item.save(update_fields=['stock_units', 'value', 'status'])
    print(f"[Sync] Updated inventory item {inventory_item.id}: stock {old_stock} -> {new_stock}")


def _resolve_branch_for_business(business, branch_id):
    """Resolve branch by id, legacy BRN-<id>, or common 'main' aliases."""
    if branch_id is None:
        return None
    raw = str(branch_id).strip()
    if not raw:
        return None

    match = re.match(r'^BRN-(\d+)$', raw, flags=re.IGNORECASE)
    if match:
        raw = match.group(1)

    if raw.isdigit():
        return Branch.objects.filter(id=int(raw), business=business).first()

    normalized = raw.lower()
    if normalized in {'main', 'main-branch', 'main_branch'}:
        return (
            Branch.objects.filter(business=business, name__iendswith='Main Branch')
            .order_by('created_at', 'id')
            .first()
        )

    return Branch.objects.filter(
        business=business
    ).filter(Q(slug=raw) | Q(name__iexact=raw)).first()


def _should_create_purchase_items_from_header(items_payload):
    """
    Legacy compatibility: only create PurchaseOrderItem rows from the purchase-order
    header when the payload does not already carry explicit batch record IDs.

    In the current offline sync flow, batch rows are authored by PurchaseRecord sync.
    Re-creating them here causes duplicate batches and inaccurate stock history.
    """
    if not isinstance(items_payload, list) or len(items_payload) == 0:
        return False

    for item in items_payload:
        if not isinstance(item, dict):
            continue
        if str(item.get('id') or '').strip():
            return False

    return True


def handle_create_purchase_order(po_id, data, business, branch_id):
    """Handle creation of purchase order from frontend"""
    try:
        print(f"[Sync] Creating PO {po_id} with data: {data}")
        
        # Validate branch exists (accept legacy/alias formats)
        branch = _resolve_branch_for_business(business, branch_id)
        if not branch:
            return {
                'success': False,
                'error': f'Branch {branch_id} not found for this business'
            }
        
        # Check if PO already exists
        existing = PurchaseOrder.objects.filter(id=po_id, business=business).first()
        if existing:
            print(f"[Sync] PO {po_id} already exists, updating instead")
            return handle_update_purchase_order(po_id, data, business, branch_id)
        
        # Get supplier if provided
        supplier = None
        if data.get('supplierId'):
            try:
                supplier = Supplier.objects.get(id=data['supplierId'], business=business)
                print(f"[Sync] Found supplier: {supplier.id} - {supplier.name}")
            except Supplier.DoesNotExist:
                print(f"[Sync] Supplier {data.get('supplierId')} not found for business {business.id}")
                # Don't pass - supplier can be None, but log the issue

        supplier_tin = data.get('supplierTin')
        if supplier_tin is None:
            supplier_tin = data.get('supplier_tin')

        supplier_vat_registered = data.get('supplierVatRegistered')
        if supplier_vat_registered is None:
            supplier_vat_registered = data.get('supplier_vat_registered')

        # Backfill supplier compliance values from linked supplier if payload omitted them.
        if supplier and supplier_tin in (None, ''):
            supplier_tin = supplier.supplier_tin
        if supplier and supplier_vat_registered is None:
            supplier_vat_registered = supplier.vat_registered
        
        # Create new PO
        # Note: order_number is a UUIDField, so we use po_id directly
        # Support both camelCase (from direct API) and snake_case (from sync)
        total_items = int(data.get('totalItems') or data.get('total_items', 0))
        total_cost = float(data.get('totalCost') or data.get('total_cost', 0)) or 0
        reference_number = data.get('referenceNumber')
        if reference_number is None:
            reference_number = data.get('reference_number')
        vat_amount = data.get('vatAmount')
        if vat_amount is None:
            vat_amount = data.get('vat_amount')
        try:
            vat_amount_value = float(vat_amount) if vat_amount not in ('', None) else None
        except (TypeError, ValueError):
            vat_amount_value = None
        print(f"[Sync] PO totals from data: totalItems={total_items}, totalCost={total_cost}, raw data keys={list(data.keys())}")
        
        po_data = {
            'id': po_id,
            'business': business,
            'branch': branch,
            'supplier': supplier,  # ✅ Will be None if not found, but that's OK
            'order_number': po_id,  # Use the UUID directly, not a formatted string
            'status': data.get('status', 'Draft'),
            'total_items': total_items,
            'total_cost': total_cost,
            'payment_status': data.get('paymentStatus', 'Unpaid'),
            'amount_paid': float(data.get('amountPaid', 0)) or 0,
            'amount_due': float(data.get('amountDue', 0)) or 0,
            'reference_number': reference_number if reference_number not in ('', None) else None,
            'vat_amount': vat_amount_value,
            'supplier_tin': supplier_tin if supplier_tin not in ('', None) else None,
            'supplier_vat_registered': _parse_boolean(supplier_vat_registered, default=False),
            'notes': data.get('notes', ''),
            'created_by': data.get('createdBy', 'System'),
        }
        
        # ✅ Don't remove None values - supplier can be None
        # Only remove None values for optional fields that shouldn't be set
        po_data = {k: v for k, v in po_data.items() if v is not None or k == 'supplier'}
        
        po = PurchaseOrder.objects.create(**po_data)
        
        # Legacy fallback: only create PO items from the header when the payload
        # does not already include explicit batch IDs that will be synced via
        # PurchaseRecord changes.
        header_items = data.get('items') if isinstance(data.get('items'), list) else []
        if header_items and not _should_create_purchase_items_from_header(header_items):
            print(
                f"[Sync] Skipping PO header item creation for {po_id}; "
                "PurchaseRecord sync will create/update batch rows."
            )
        elif header_items:
            for item_data in header_items:
                try:
                    inventory_item = InventoryItem.objects.get(
                        id=item_data.get('inventoryItemId'),
                        business=business,
                        branch=branch
                    )
                    
                    # Calculate quantity_remaining: if not provided, default to quantity_received
                    quantity_received = float(item_data.get('quantityReceived', 0))
                    quantity_remaining = float(item_data.get('quantityRemaining', 0))
                    tax_rate = float(item_data.get('taxRate', item_data.get('tax_rate', 0)) or 0)
                    tax_calc_method = item_data.get('taxCalculationMethod') or item_data.get('tax_calculation_method') or 'exclusive'
                    if tax_calc_method not in {'inclusive', 'exclusive'}:
                        tax_calc_method = 'exclusive'
                    
                    # If quantityRemaining is 0 or not provided, set it to quantityReceived
                    if quantity_remaining == 0 and quantity_received > 0:
                        quantity_remaining = quantity_received
                        print(f"[Sync] Setting quantity_remaining to {quantity_remaining} (from quantityReceived)")
                    
                    po_item = PurchaseOrderItem.objects.create(
                        purchase_order=po,
                        inventory_item=inventory_item,
                        quantity_ordered=float(item_data.get('quantityOrdered', 0)),
                        quantity_received=quantity_received,
                        quantity_remaining=quantity_remaining,
                        cost_per_unit=float(item_data.get('costPerUnit', 0)),
                        tax_rate=tax_rate,
                        tax_calculation_method=tax_calc_method,
                        batch_number=item_data.get('batchNumber', ''),
                        expiry_date=item_data.get('expiryDate')
                    )
                    print(f"[Sync] Created PO item: {po_item.inventory_item.name}, received={quantity_received}, remaining={quantity_remaining}")
                except InventoryItem.DoesNotExist:
                    print(f"[Sync] Inventory item {item_data.get('inventoryItemId')} not found")
        
        print(f"[Sync] Created purchase order {po_id}")
        
        return {
            'success': True,
            'server_id': str(po.id)
        }
        
    except Exception as e:
        print(f"[Sync] Error creating purchase order: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


def handle_update_purchase_order(po_id, data, business, branch_id):
    """Handle update of purchase order from frontend"""
    try:
        branch = _resolve_branch_for_business(business, branch_id)
        if branch:
            po = PurchaseOrder.objects.get(id=po_id, business=business, branch=branch)
        else:
            po = PurchaseOrder.objects.get(id=po_id, business=business)
        
        # Update fields
        if 'status' in data:
            po.status = data['status']
        if 'paymentStatus' in data:
            po.payment_status = data['paymentStatus']
        if 'amountPaid' in data:
            po.amount_paid = data['amountPaid']
        if 'amountDue' in data:
            po.amount_due = data['amountDue']
        if 'notes' in data:
            po.notes = data['notes']
        if 'totalItems' in data or 'total_items' in data:
            po.total_items = int(data.get('totalItems') or data.get('total_items') or 0)
        if 'totalCost' in data:
            po.total_cost = data['totalCost']
        if 'referenceNumber' in data or 'reference_number' in data:
            reference_number = data.get('referenceNumber')
            if reference_number is None:
                reference_number = data.get('reference_number')
            po.reference_number = reference_number if reference_number not in ('', None) else None
        if 'vatAmount' in data or 'vat_amount' in data:
            vat_amount = data.get('vatAmount')
            if vat_amount is None:
                vat_amount = data.get('vat_amount')
            try:
                po.vat_amount = float(vat_amount) if vat_amount not in ('', None) else None
            except (TypeError, ValueError):
                po.vat_amount = None
        
        # ✅ Handle supplier update
        if 'supplierId' in data:
            if data['supplierId']:
                try:
                    supplier = Supplier.objects.get(id=data['supplierId'], business=business)
                    po.supplier = supplier
                    print(f"[Sync] Updated PO supplier to: {supplier.id} - {supplier.name}")
                    if 'supplierTin' not in data and 'supplier_tin' not in data:
                        po.supplier_tin = supplier.supplier_tin
                    if 'supplierVatRegistered' not in data and 'supplier_vat_registered' not in data:
                        po.supplier_vat_registered = supplier.vat_registered
                except Supplier.DoesNotExist:
                    print(f"[Sync] Supplier {data['supplierId']} not found, keeping existing supplier")
            else:
                po.supplier = None
                print(f"[Sync] Cleared PO supplier")

        if 'supplierTin' in data or 'supplier_tin' in data:
            supplier_tin = data.get('supplierTin')
            if supplier_tin is None:
                supplier_tin = data.get('supplier_tin')
            po.supplier_tin = supplier_tin if supplier_tin not in ('', None) else None

        if 'supplierVatRegistered' in data or 'supplier_vat_registered' in data:
            supplier_vat_registered = data.get('supplierVatRegistered')
            if supplier_vat_registered is None:
                supplier_vat_registered = data.get('supplier_vat_registered')
            po.supplier_vat_registered = _parse_boolean(
                supplier_vat_registered,
                default=po.supplier_vat_registered,
            )
        
        po.save()
        print(f"[Sync] Updated purchase order {po_id}")
        
        return {
            'success': True,
            'server_id': str(po.id)
        }
        
    except PurchaseOrder.DoesNotExist:
        print(f"[Sync] PO {po_id} not found, creating instead")
        return handle_create_purchase_order(po_id, data, business, branch_id)
    except Exception as e:
        print(f"[Sync] Error updating purchase order: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }


def handle_delete_purchase_order(po_id, business, branch_id, data=None):
    """Handle deletion of purchase order from frontend"""
    try:
        branch = _resolve_branch_for_business(business, branch_id)
        if branch:
            po = PurchaseOrder.objects.get(id=po_id, business=business, branch=branch)
        else:
            po = PurchaseOrder.objects.get(id=po_id, business=business)

        payload_items = data.get('items') if isinstance(data, dict) and isinstance(data.get('items'), list) else []
        payload_quantities_by_item_id = {}
        for payload_item in payload_items:
            item_id = str(payload_item.get('id') or '').strip()
            if not item_id:
                continue
            quantity_remaining = payload_item.get('quantityRemaining')
            if quantity_remaining is None:
                quantity_remaining = payload_item.get('quantity_remaining')
            payload_quantities_by_item_id[item_id] = _parse_decimal(quantity_remaining, None)

        quantities_by_inventory_id = defaultdict(lambda: Decimal('0'))
        purchase_items = list(po.items.select_related('inventory_item'))
        for purchase_item in purchase_items:
            quantity_to_remove = purchase_item.quantity_remaining or Decimal('0')
            payload_quantity = payload_quantities_by_item_id.get(str(purchase_item.id))
            if payload_quantity is not None:
                quantity_to_remove = payload_quantity

            quantity_to_remove = max(Decimal('0'), quantity_to_remove)
            if quantity_to_remove <= 0:
                continue

            quantities_by_inventory_id[purchase_item.inventory_item_id] += quantity_to_remove

        po.delete()
        print(f"[Sync] Deleted purchase order {po_id}")

        if quantities_by_inventory_id:
            inventory_items = InventoryItem.objects.filter(id__in=quantities_by_inventory_id.keys(), business=business)
            for inventory_item in inventory_items:
                _update_inventory_after_purchase_removal(
                    inventory_item,
                    quantities_by_inventory_id.get(inventory_item.id, Decimal('0'))
                )
        
        return {
            'success': True,
            'server_id': po_id
        }
        
    except PurchaseOrder.DoesNotExist:
        print(f"[Sync] PO {po_id} not found for deletion")
        return {
            'success': True,
            'server_id': po_id
        }
    except Exception as e:
        print(f"[Sync] Error deleting purchase order: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }
