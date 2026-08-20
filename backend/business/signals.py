from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone
from django.core.exceptions import ValidationError
from decimal import Decimal
import uuid
from .models import Invoice, CustomerAccountTransaction
from .customer_accounts import create_customer_account_transaction, record_credit_sale_for_order
from pos_sessions.models import Order, OrderItem
from inventory.models import InventoryItem

# Note: Slug generation for Business and Branch is now handled in model save() methods


@receiver(post_save, sender=Invoice)
def handle_invoice_status_change(sender, instance, created, update_fields, **kwargs):
    """
    Handle invoice creation and status changes:
    - When invoice is created: Create a POS Order and deduct stock immediately
      (because customer has taken products on credit)
    - When marked as 'Void': Delete related Order and restore stock
    """
    
    if instance.document_type == 'Quotation':
        return

    if created:
        return
    
    # Only process status updates if not a new creation
    if update_fields and 'status' not in update_fields:
        return
    
    current_status = instance.status
    
    if current_status == 'Sent':
        if not instance.related_order_id:
            _create_order_from_invoice(instance, mark_paid=False)

    # Handle transition to 'Paid' status
    elif current_status == 'Paid':
        if instance.related_order_id:
            _mark_invoice_order_as_paid(instance)
        else:
            _create_order_from_invoice(instance, mark_paid=True)
    
    # Handle transition to 'Void' status
    elif current_status == 'Void':
        # Only void if there's a related order
        if instance.related_order_id:
            _delete_order_from_invoice(instance)


def _create_order_from_invoice(invoice, mark_paid=False):
    """Create a POS Order from a paid invoice and deduct stock"""
    try:
        if invoice.document_type == 'Quotation':
            return

        # Check if order already exists
        if invoice.related_order_id:
            print(f"[INVOICE] Order already exists for invoice #{invoice.invoice_number}")
            return
        
        # Get the next order number for this branch
        last_order = Order.objects.filter(branch=invoice.branch).order_by('order_number').last()
        next_order_number = (last_order.order_number if last_order else 0) + 1
        
        # Create the Order
        order = Order.objects.create(
            id=uuid.uuid4(),
            business=invoice.business,
            branch=invoice.branch,
            order_number=next_order_number,
            order_type='invoice',  # Mark as invoice sale
            status='Completed',
            payment_method='On Account',  # Invoices are typically on-account sales
            customer=invoice.customer,
            customer_name=invoice.customer_name,
            customer_phone=getattr(invoice.customer, 'phone', None) if invoice.customer else None,
            customer_tin=getattr(invoice.customer, 'customer_tin', None) if invoice.customer else None,
            subtotal=invoice.subtotal,
            total=invoice.total,
            vat_amount=invoice.tax,
            net_amount=invoice.subtotal,
            gross_amount=invoice.total,
            cogs=Decimal('0.00'),
            created_at=invoice.issue_date,
            is_invoice_sale=True,  # Mark as invoice sale
            invoice_id=str(invoice.id),  # Link to invoice
            is_paid=mark_paid,
        )
        
        # Create OrderItems and deduct stock
        total_cogs = Decimal('0.00')
        for line in invoice.lines.all():
            inventory_item_id = str(line.product_code or '')
            quantity_to_deduct = Decimal(str(line.quantity or 0))

            # Create OrderItem
            OrderItem.objects.create(
                id=uuid.uuid4(),
                order=order,
                inventory_item_id=inventory_item_id,
                name=line.product_name,
                quantity=quantity_to_deduct,
                price=line.unit_price,
                tax_rate=line.tax_rate,
                tax_amount=line.tax_amount,
                subtotal=line.total_amount - line.tax_amount,
                total=line.total_amount,
                mra_product_code=line.mra_product_code,
            )
            
            # Deduct stock from inventory
            try:
                inventory_item = InventoryItem.objects.get(id=inventory_item_id)
                
                # Calculate COGS
                if inventory_item.cost:
                    total_cogs += inventory_item.cost * quantity_to_deduct
                
                # Deduct stock
                inventory_item.stock_units -= quantity_to_deduct
                inventory_item.value = inventory_item.stock_units * (inventory_item.cost or Decimal('0.00'))
                inventory_item.update_status()
                inventory_item.save()
                
                print(f"[INVOICE] Deducted {quantity_to_deduct} units of {inventory_item.name} for invoice #{invoice.invoice_number}")
            except InventoryItem.DoesNotExist:
                print(f"[INVOICE WARNING] Inventory item {inventory_item_id} not found for invoice #{invoice.invoice_number}")
        
        # Update order COGS
        order.cogs = total_cogs
        order.save()
        
        # Link the order to the invoice
        Invoice.objects.filter(pk=invoice.pk).update(related_order_id=str(order.id))
        invoice.related_order_id = str(order.id)

        if not mark_paid:
            account_tx = record_credit_sale_for_order(order)
            if account_tx and not account_tx.invoice_id:
                account_tx.invoice_id = str(invoice.id)
                account_tx.save(update_fields=['invoice_id', 'updated_at'])
        
        print(f"[INVOICE] Created Order #{order.order_number} from Invoice #{invoice.invoice_number}")
        
    except Exception as e:
        if isinstance(e, ValidationError):
            raise
        print(f"[INVOICE ERROR] Failed to create order from invoice #{invoice.invoice_number}: {str(e)}")
        import traceback
        traceback.print_exc()


def _mark_invoice_order_as_paid(invoice):
    """Mark the related invoice order as paid"""
    try:
        if not invoice.related_order_id:
            print(f"[INVOICE] No related order found for invoice #{invoice.invoice_number}")
            return
        
        # Get the order
        try:
            order = Order.objects.get(id=invoice.related_order_id)
        except Order.DoesNotExist:
            print(f"[INVOICE WARNING] Related order {invoice.related_order_id} not found for invoice #{invoice.invoice_number}")
            return
        
        # Mark order as paid
        order.is_paid = True
        order.save(update_fields=['is_paid'])

        customer = getattr(order, 'customer', None) or invoice.customer
        if customer:
            credit_sale = CustomerAccountTransaction.objects.filter(
                business=invoice.business,
                order_id=str(order.id),
                entry_type='credit_sale',
            ).first()
            existing_payment = CustomerAccountTransaction.objects.filter(
                business=invoice.business,
                invoice_id=str(invoice.id),
                entry_type='payment',
            ).first()
            if credit_sale and not existing_payment:
                create_customer_account_transaction(
                    customer=customer,
                    entry_type='payment',
                    direction='credit',
                    amount=invoice.total,
                    branch=invoice.branch,
                    order_id=str(order.id),
                    invoice_id=str(invoice.id),
                    payment_method='Cash',
                    reference=f"Invoice #{invoice.invoice_number}",
                    notes=f"Payment for invoice #{invoice.invoice_number}",
                )
        
        print(f"[INVOICE] Marked Order #{order.order_number} as paid for Invoice #{invoice.invoice_number}")
        
    except Exception as e:
        if isinstance(e, ValidationError):
            raise
        print(f"[INVOICE ERROR] Failed to mark order as paid for invoice #{invoice.invoice_number}: {str(e)}")
        import traceback
        traceback.print_exc()


def _delete_order_from_invoice(invoice):
    """Delete the related POS Order and restore stock when invoice is voided"""
    try:
        if not invoice.related_order_id:
            print(f"[INVOICE] No related order found for invoice #{invoice.invoice_number}")
            return
        
        # Get the order
        try:
            order = Order.objects.get(id=invoice.related_order_id)
        except Order.DoesNotExist:
            print(f"[INVOICE WARNING] Related order {invoice.related_order_id} not found for invoice #{invoice.invoice_number}")
            return

        customer = getattr(order, 'customer', None) or invoice.customer
        credit_sale = CustomerAccountTransaction.objects.filter(
            business=invoice.business,
            order_id=str(order.id),
            entry_type='credit_sale',
        ).first()
        existing_refund = CustomerAccountTransaction.objects.filter(
            business=invoice.business,
            invoice_id=str(invoice.id),
            entry_type='refund',
        ).first()
        if customer and credit_sale and not existing_refund:
            create_customer_account_transaction(
                customer=customer,
                entry_type='refund',
                direction='credit',
                amount=credit_sale.amount,
                branch=invoice.branch,
                order_id=str(order.id),
                invoice_id=str(invoice.id),
                payment_method='Account Adjustment',
                reference=f"Voided invoice #{invoice.invoice_number}",
                notes=f"Reversal for voided invoice #{invoice.invoice_number}",
            )
        
        # Restore stock for each item
        for line in invoice.lines.all():
            inventory_item_id = str(line.product_code or '')
            try:
                inventory_item = InventoryItem.objects.get(id=inventory_item_id)
                quantity_to_restore = Decimal(str(line.quantity or 0))
                
                # Restore stock
                inventory_item.stock_units += quantity_to_restore
                inventory_item.value = inventory_item.stock_units * (inventory_item.cost or Decimal('0.00'))
                inventory_item.update_status()
                inventory_item.save()
                
                print(f"[INVOICE] Restored {quantity_to_restore} units of {inventory_item.name} for voided invoice #{invoice.invoice_number}")
            except InventoryItem.DoesNotExist:
                print(f"[INVOICE WARNING] Inventory item {inventory_item_id} not found when voiding invoice #{invoice.invoice_number}")
        
        # Delete the order
        order.delete()
        
        # Clear the related order ID
        Invoice.objects.filter(pk=invoice.pk).update(related_order_id=None)
        invoice.related_order_id = None
        
        print(f"[INVOICE] Deleted Order #{order.order_number} and restored stock for voided Invoice #{invoice.invoice_number}")
        
    except Exception as e:
        if isinstance(e, ValidationError):
            raise
        print(f"[INVOICE ERROR] Failed to void order from invoice #{invoice.invoice_number}: {str(e)}")
        import traceback
        traceback.print_exc()
