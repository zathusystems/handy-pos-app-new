"""
Purchase Records Sync Views
Handles synchronization of purchase records (stock receipts) between frontend and backend
Implements offline-first pattern with FIFO batch tracking
"""

import re
from django.db.models import Q

from .models import InventoryItem, PurchaseOrderItem
from business.models import Business, Branch
from django.utils import timezone
from decimal import Decimal, InvalidOperation


def _parse_decimal(value, field_name, default=Decimal('0')):
    """Parse a non-negative finite Decimal from sync payload."""
    if value in (None, '', 'null', 'undefined'):
        return default
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        print(f"[Sync] Warning: Invalid decimal for {field_name}: {value}")
        return default
    if parsed.is_nan() or parsed.is_infinite():
        print(f"[Sync] Warning: Non-finite decimal for {field_name}: {value}")
        return default
    if parsed < 0:
        print(f"[Sync] Warning: Negative decimal for {field_name}: {value}")
        return default
    return parsed


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


def _parse_optional_decimal(value, field_name):
    """Parse an optional non-negative Decimal from sync payload."""
    if value in (None, '', 'null', 'undefined'):
        return None
    return _parse_decimal(value, field_name, None)


def _apply_inventory_purchase_update(inventory_item, stock_delta=Decimal('0'), cost_per_unit=None, selling_price=None):
    """Apply purchase-driven stock/cost updates to an inventory row."""
    old_stock = _parse_decimal(
        inventory_item.stock_units,
        f'inventory_item.stock_units:{inventory_item.id}',
        Decimal('0')
    )
    next_stock = max(Decimal('0'), old_stock + (stock_delta or Decimal('0')))

    if cost_per_unit is not None:
        inventory_item.cost = cost_per_unit

    if selling_price is not None and not inventory_item.price_locked:
        inventory_item.price = selling_price

    inventory_item.stock_units = next_stock
    inventory_item.value = next_stock * (inventory_item.cost or Decimal('0'))

    if next_stock > inventory_item.reorder_level:
        inventory_item.status = 'In Stock'
    elif next_stock > 0:
        inventory_item.status = 'Low Stock'
    else:
        inventory_item.status = 'Out of Stock'

    inventory_item.save()
    return old_stock, next_stock


def handle_create_purchase_record(record_id, data, business, branch_id):
    """
    Handle creation of purchase record (stock receipt) from frontend
    
    This creates a PurchaseOrderItem batch record and updates inventory stock
    Implements FIFO batch tracking for proper stock management
    """
    try:
        print(f"[Sync] Creating purchase record {record_id} with data keys: {list(data.keys())}")
        
        # Validate branch exists (accept legacy/alias formats)
        branch = _resolve_branch_for_business(business, branch_id)
        if not branch:
            return {
                'success': False,
                'error': f'Branch {branch_id} not found for this business'
            }
        
        # Check if purchase record already exists
        existing = PurchaseOrderItem.objects.filter(
            id=record_id,
            purchase_order__business=business
        ).first()
        
        if existing:
            print(f"[Sync] Purchase record {record_id} already exists, updating instead")
            return handle_update_purchase_record(record_id, data, business, branch_id)
        
        # Get the inventory item
        product_id = data.get('productId') or data.get('product_id')
        if not product_id:
            return {
                'success': False,
                'error': 'productId is required'
            }
        
        try:
            inventory_item = InventoryItem.objects.get(
                id=product_id,
                business=business,
                branch=branch
            )
        except InventoryItem.DoesNotExist:
            return {
                'success': False,
                'error': f'Inventory item {product_id} not found'
            }
        
        # Parse quantity and cost - use Decimal for proper arithmetic with Django DecimalField
        quantity_received = _parse_decimal(
            data.get('quantityReceived') or data.get('quantity_received', 0),
            'quantity_received',
            Decimal('0')
        )
        cost_per_unit = _parse_decimal(
            data.get('costPerUnit') or data.get('cost_per_unit', 0),
            'cost_per_unit',
            Decimal('0')
        )
        quantity_remaining_raw = data.get('quantityRemaining')
        if quantity_remaining_raw is None:
            quantity_remaining_raw = data.get('quantity_remaining')
        quantity_remaining = (
            _parse_decimal(
                quantity_remaining_raw,
                'quantity_remaining',
                quantity_received
            )
            if quantity_remaining_raw is not None
            else quantity_received
        )
        quantity_remaining = min(quantity_received, quantity_remaining)
        tax_rate = _parse_decimal(
            data.get('taxRate') or data.get('tax_rate', 0),
            'tax_rate',
            Decimal('0')
        )
        tax_amount = _parse_decimal(
            data.get('taxAmount') if data.get('taxAmount') is not None else data.get('tax_amount', 0),
            'tax_amount',
            Decimal('0')
        )
        selling_price = _parse_optional_decimal(
            data.get('sellingPrice') if data.get('sellingPrice') is not None else data.get('selling_price'),
            'selling_price'
        )
        tax_calc_method = data.get('taxCalculationMethod') or data.get('tax_calculation_method') or 'exclusive'
        if tax_calc_method not in {'inclusive', 'exclusive'}:
            tax_calc_method = 'exclusive'
        
        if quantity_received <= 0:
            return {
                'success': False,
                'error': 'Quantity received must be greater than 0'
            }
        
        print(f"[Sync] Purchase record: product={product_id}, quantity={quantity_received}, cost={cost_per_unit}")
        
        # Get or reuse existing purchase order
        # The PurchaseOrder should already exist from the frontend sync
        from .models import PurchaseOrder
        from uuid import uuid4
        
        po_id = data.get('purchaseOrderId') or data.get('purchase_order_id')
        
        if not po_id:
            # If no PO ID provided, this is a direct receipt without a PO
            # Create a minimal PO just to hold this item
            po_id = str(uuid4())
            reference_number = data.get('referenceNumber') or data.get('reference_number')
            vat_amount = data.get('vatAmount')
            if vat_amount is None:
                vat_amount = data.get('vat_amount')
            try:
                vat_amount_value = float(vat_amount) if vat_amount not in ('', None) else None
            except (TypeError, ValueError):
                vat_amount_value = None
            purchase_order = PurchaseOrder.objects.create(
                id=po_id,
                business=business,
                branch=branch,
                supplier=None,
                order_number=po_id,
                status='Received',
                total_items=1,
                total_cost=quantity_received * cost_per_unit,
                payment_status='Paid',
                reference_number=reference_number if reference_number not in ('', None) else None,
                vat_amount=vat_amount_value,
                created_by='System',
                received_date=timezone.now()
            )
            print(f"[Sync] Created minimal purchase order {po_id} for direct receipt")
        else:
            try:
                purchase_order = PurchaseOrder.objects.get(id=po_id, business=business)
                print(f"[Sync] Reusing existing purchase order {po_id}")
            except PurchaseOrder.DoesNotExist:
                # PO doesn't exist yet - this shouldn't happen if frontend synced it first
                # Create it now as a fallback
                raw_vat_amount = data.get('vatAmount')
                if raw_vat_amount is None:
                    raw_vat_amount = data.get('vat_amount')
                try:
                    vat_amount_value = float(raw_vat_amount) if raw_vat_amount not in ('', None) else None
                except (TypeError, ValueError):
                    vat_amount_value = None
                purchase_order = PurchaseOrder.objects.create(
                    id=po_id,
                    business=business,
                    branch=branch,
                    supplier=None,
                    order_number=po_id,
                    status='Received',
                    total_items=1,
                    total_cost=quantity_received * cost_per_unit,
                    payment_status='Paid',
                    reference_number=(data.get('referenceNumber') or data.get('reference_number')) or None,
                    vat_amount=vat_amount_value,
                    created_by='System',
                    received_date=timezone.now()
                )
                print(f"[Sync] Created fallback purchase order {po_id}")
        
        # Create purchase order item (batch record)
        purchase_item = PurchaseOrderItem.objects.create(
            id=record_id,
            purchase_order=purchase_order,
            inventory_item=inventory_item,
            session_id=data.get('sessionId') or data.get('session_id'),  # NEW: Link to session
            quantity_ordered=quantity_received,
            quantity_received=quantity_received,
            quantity_remaining=quantity_remaining,
            cost_per_unit=cost_per_unit,
            total_cost=quantity_received * cost_per_unit,
            tax_rate=tax_rate,
            tax_calculation_method=tax_calc_method,
            tax_amount=tax_amount,
            batch_number=data.get('batchNumber') or data.get('batch_number') or '',
            expiry_date=data.get('expiryDate') or data.get('expiry_date')
        )
        
        print(f"[Sync] Created purchase order item {record_id}")
        
        # Update inventory item stock
        old_stock, new_stock = _apply_inventory_purchase_update(
            inventory_item,
            stock_delta=quantity_remaining,
            cost_per_unit=cost_per_unit,
            selling_price=selling_price,
        )
        
        print(f"[Sync] Updated inventory item {product_id}: stock {old_stock} -> {new_stock}")
        
        return {
            'success': True,
            'server_id': str(purchase_item.id)
        }
        
    except Exception as e:
        print(f"[Sync] Error creating purchase record: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


def handle_update_purchase_record(record_id, data, business, branch_id):
    """
    Handle update of purchase record from frontend
    
    This handles changes to batch records (e.g., quantity adjustments)
    """
    try:
        print(f"[Sync] Updating purchase record {record_id} with data keys: {list(data.keys())}")
        
        # Get the purchase order item
        purchase_item = PurchaseOrderItem.objects.get(
            id=record_id,
            purchase_order__business=business
        )
        
        # Get the inventory item
        inventory_item = purchase_item.inventory_item
        
        # Calculate quantity change - convert to Decimal for proper arithmetic
        old_quantity_received = _parse_decimal(
            purchase_item.quantity_received,
            f'purchase_item.quantity_received:{record_id}',
            Decimal('0')
        )
        old_quantity_remaining = _parse_decimal(
            purchase_item.quantity_remaining,
            f'purchase_item.quantity_remaining:{record_id}',
            Decimal('0')
        )
        new_quantity_received_raw = data.get('quantityReceived')
        if new_quantity_received_raw is None:
            new_quantity_received_raw = data.get('quantity_received')
        new_quantity_received = (
            _parse_decimal(
                new_quantity_received_raw,
                f'quantity_received:{record_id}',
                old_quantity_received
            )
            if new_quantity_received_raw is not None
            else old_quantity_received
        )
        consumed_quantity = max(Decimal('0'), old_quantity_received - old_quantity_remaining)
        if new_quantity_received < consumed_quantity:
            return {
                'success': False,
                'error': 'Quantity received cannot be less than the quantity already consumed'
            }
        new_quantity_remaining_raw = data.get('quantityRemaining')
        if new_quantity_remaining_raw is None:
            new_quantity_remaining_raw = data.get('quantity_remaining')
        new_quantity_remaining = (
            _parse_decimal(
                new_quantity_remaining_raw,
                f'quantity_remaining:{record_id}',
                max(Decimal('0'), new_quantity_received - consumed_quantity)
            )
            if new_quantity_remaining_raw is not None
            else max(Decimal('0'), new_quantity_received - consumed_quantity)
        )
        new_quantity_remaining = min(new_quantity_received, new_quantity_remaining)
        allow_quantity_decrease = bool(
            data.get('allow_quantity_decrease')
            or data.get('allowQuantityDecrease')
        )
        # Consumption decrements must come from backend stock movement handlers.
        # Prevent duplicate decrements from generic sync updates.
        if new_quantity_remaining < old_quantity_remaining and not allow_quantity_decrease:
            print(
                f"[Sync] Ignoring quantity_remaining decrease for purchase record {record_id}: "
                f"{old_quantity_remaining} -> {new_quantity_remaining}. "
                "Use POS/waste stock movement endpoints for decrements."
            )
            new_quantity_remaining = old_quantity_remaining
        quantity_change = new_quantity_remaining - old_quantity_remaining

        cost_per_unit_raw = data.get('costPerUnit')
        if cost_per_unit_raw is None:
            cost_per_unit_raw = data.get('cost_per_unit')
        new_cost_per_unit = (
            _parse_decimal(
                cost_per_unit_raw,
                f'cost_per_unit:{record_id}',
                purchase_item.cost_per_unit or Decimal('0')
            )
            if cost_per_unit_raw is not None
            else purchase_item.cost_per_unit
        )
        selling_price = _parse_optional_decimal(
            data.get('sellingPrice') if data.get('sellingPrice') is not None else data.get('selling_price'),
            f'selling_price:{record_id}'
        )
        
        print(f"[Sync] Purchase record quantity change: {old_quantity_remaining} -> {new_quantity_remaining} (change: {quantity_change})")
        
        # Update purchase item
        if 'quantityReceived' in data or 'quantity_received' in data:
            purchase_item.quantity_ordered = new_quantity_received
            purchase_item.quantity_received = new_quantity_received

        if 'quantityRemaining' in data or 'quantity_remaining' in data:
            purchase_item.quantity_remaining = new_quantity_remaining

        if 'costPerUnit' in data or 'cost_per_unit' in data:
            purchase_item.cost_per_unit = new_cost_per_unit
            purchase_item.total_cost = new_quantity_received * new_cost_per_unit

        if 'sessionId' in data or 'session_id' in data:
            purchase_item.session_id = data.get('sessionId') or data.get('session_id') or None
        
        if 'batchNumber' in data or 'batch_number' in data:
            batch_num = data.get('batchNumber') or data.get('batch_number')
            # Ensure batch_number is never None - use empty string as default
            purchase_item.batch_number = batch_num if batch_num is not None else ''
        
        if 'expiryDate' in data or 'expiry_date' in data:
            purchase_item.expiry_date = data.get('expiryDate') or data.get('expiry_date')

        if 'taxRate' in data or 'tax_rate' in data:
            purchase_item.tax_rate = _parse_decimal(
                data.get('taxRate') or data.get('tax_rate', 0),
                f'tax_rate:{record_id}',
                purchase_item.tax_rate or Decimal('0')
            )

        if 'taxCalculationMethod' in data or 'tax_calculation_method' in data:
            tax_calc_method = data.get('taxCalculationMethod') or data.get('tax_calculation_method')
            if tax_calc_method in {'inclusive', 'exclusive'}:
                purchase_item.tax_calculation_method = tax_calc_method

        if 'taxAmount' in data or 'tax_amount' in data:
            purchase_item.tax_amount = _parse_decimal(
                data.get('taxAmount') or data.get('tax_amount', 0),
                f'tax_amount:{record_id}',
                purchase_item.tax_amount or Decimal('0')
            )
        
        purchase_item.save()
        
        # Update inventory stock/cost if purchase values changed
        if quantity_change != 0 or cost_per_unit_raw is not None or selling_price is not None:
            old_stock, new_stock = _apply_inventory_purchase_update(
                inventory_item,
                stock_delta=quantity_change,
                cost_per_unit=new_cost_per_unit if cost_per_unit_raw is not None else None,
                selling_price=selling_price,
            )
            print(f"[Sync] Updated inventory item {inventory_item.id}: stock {old_stock} -> {new_stock}")
        
        return {
            'success': True,
            'server_id': str(purchase_item.id)
        }
        
    except PurchaseOrderItem.DoesNotExist:
        print(f"[Sync] Purchase record {record_id} not found, creating instead")
        return handle_create_purchase_record(record_id, data, business, branch_id)
    except Exception as e:
        print(f"[Sync] Error updating purchase record: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


def handle_delete_purchase_record(record_id, business, branch_id):
    """
    Handle deletion of purchase record from frontend
    
    This removes a batch record and adjusts inventory stock accordingly
    """
    try:
        print(f"[Sync] Deleting purchase record {record_id}")
        
        # Get the purchase order item
        purchase_item = PurchaseOrderItem.objects.get(
            id=record_id,
            purchase_order__business=business
        )
        
        # Get the inventory item before deletion
        inventory_item = purchase_item.inventory_item
        quantity_to_remove = purchase_item.quantity_remaining
        
        # Delete the purchase item
        purchase_item.delete()
        
        print(f"[Sync] Deleted purchase record {record_id}")
        
        # Update inventory stock
        if quantity_to_remove > 0:
            old_stock, new_stock = _apply_inventory_purchase_update(
                inventory_item,
                stock_delta=-quantity_to_remove,
            )
            
            print(f"[Sync] Updated inventory item {inventory_item.id}: stock {old_stock} -> {new_stock}")
        
        return {
            'success': True,
            'server_id': record_id
        }
        
    except PurchaseOrderItem.DoesNotExist:
        print(f"[Sync] Purchase record {record_id} not found for deletion")
        return {
            'success': True,
            'server_id': record_id
        }
    except Exception as e:
        print(f"[Sync] Error deleting purchase record: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }
