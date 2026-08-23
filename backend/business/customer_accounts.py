from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import (
    Customer,
    CustomerAccountTransaction,
    CustomerLaybuy,
    CustomerLaybuyPayment,
    CustomerLaybuyReservation,
    Invoice,
    InvoiceLine,
)


MONEY_QUANT = Decimal('0.01')
QUANTITY_QUANT = Decimal('0.001')


def _money(value):
    try:
        return Decimal(str(value or 0)).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError("Amount must be a valid number.")


def _quantity(value):
    try:
        parsed = Decimal(str(value or 0)).quantize(QUANTITY_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError("Quantity must be a valid number.")
    return parsed if parsed > 0 else Decimal('0.000')


def _clean_text(value):
    return str(value or '').strip()


def _first_non_empty(*values):
    for value in values:
        cleaned = _clean_text(value)
        if cleaned:
            return cleaned
    return ''


def resolve_customer_for_account_payload(business, branch=None, data=None, create_if_missing=True):
    """
    Resolve an account customer from mixed frontend/backend payload fields.
    Creates a customer when a credit sale has useful customer details but no id.
    """
    data = data or {}
    raw_customer = data.get('customer') or data.get('customer_id') or data.get('customerId')
    if isinstance(raw_customer, Customer):
        if raw_customer.business_id != business.id:
            raise ValidationError("Selected customer account does not belong to this business.")
        return raw_customer

    customer_id = _first_non_empty(
        raw_customer,
    )

    if customer_id:
        customer = Customer.objects.filter(id=customer_id, business=business).first()
        if not customer:
            raise ValidationError("Selected customer account was not found.")
        return customer

    name = _first_non_empty(
        data.get('customer_name'),
        data.get('customerName'),
        data.get('buyer_name'),
        data.get('buyerName'),
    )
    phone = _first_non_empty(data.get('customer_phone'), data.get('customerPhone'))
    email = _first_non_empty(data.get('customer_email'), data.get('customerEmail'))
    tin = _first_non_empty(
        data.get('customer_tin'),
        data.get('customerTin'),
        data.get('buyer_tin'),
        data.get('buyerTin'),
    )
    address = _first_non_empty(data.get('customer_address'), data.get('customerAddress'))
    notes = _first_non_empty(data.get('customer_notes'), data.get('customerNotes'))

    customer = None
    if email:
        customer = Customer.objects.filter(business=business, email__iexact=email).first()
    if not customer and phone:
        customer = Customer.objects.filter(business=business, phone=phone).first()
    if not customer and tin:
        customer = Customer.objects.filter(business=business, customer_tin=tin).first()
    if not customer and name and phone:
        customer = Customer.objects.filter(business=business, name__iexact=name, phone=phone).first()

    if customer:
        update_fields = []
        if branch and not customer.branch_id:
            customer.branch = branch
            update_fields.append('branch')
        for field_name, value in {
            'email': email,
            'phone': phone,
            'customer_tin': tin,
            'address': address,
            'notes': notes,
        }.items():
            if value and not getattr(customer, field_name, None):
                setattr(customer, field_name, value)
                update_fields.append(field_name)
        if update_fields:
            update_fields.extend(['is_dirty', 'updated_at'])
            customer.is_dirty = True
            customer.save(update_fields=update_fields)
        return customer

    if not create_if_missing:
        return None

    if not any([name, phone, email, tin]):
        return None

    return Customer.objects.create(
        business=business,
        branch=branch,
        name=name or phone or email or tin,
        email=email,
        phone=phone,
        address=address,
        customer_tin=tin or None,
        notes=notes,
        account_enabled=True,
    )


def _assert_customer_can_take_debit(customer, amount):
    if not customer.account_enabled:
        raise ValidationError("This customer account is not enabled for credit sales.")

    credit_limit = _money(customer.credit_limit)
    if credit_limit <= 0:
        return

    projected_balance = _money(customer.current_balance) + amount
    if projected_balance > credit_limit:
        raise ValidationError(
            f"Credit limit exceeded. Available credit is {credit_limit - _money(customer.current_balance)}."
        )


def create_customer_account_transaction(
    *,
    customer,
    entry_type,
    direction,
    amount,
    branch=None,
    session=None,
    order_id=None,
    invoice_id=None,
    payment_method='',
    reference='',
    notes='',
    created_by=None,
):
    amount = _money(amount)
    if amount <= 0:
        raise ValidationError("Amount must be greater than zero.")

    normalized_direction = _clean_text(direction).lower()
    if normalized_direction not in {'debit', 'credit'}:
        raise ValidationError("Transaction direction must be debit or credit.")

    with transaction.atomic():
        locked_customer = Customer.objects.select_for_update().get(pk=customer.pk)

        if normalized_direction == 'debit':
            _assert_customer_can_take_debit(locked_customer, amount)
            new_balance = _money(locked_customer.current_balance) + amount
        else:
            new_balance = _money(locked_customer.current_balance) - amount

        tx = CustomerAccountTransaction.objects.create(
            business=locked_customer.business,
            branch=branch or locked_customer.branch,
            customer=locked_customer,
            session=session,
            entry_type=entry_type,
            direction=normalized_direction,
            amount=amount,
            balance_after=new_balance,
            order_id=_clean_text(order_id) or None,
            invoice_id=_clean_text(invoice_id) or None,
            payment_method=_clean_text(payment_method),
            reference=_clean_text(reference),
            notes=_clean_text(notes),
            created_by=created_by if getattr(created_by, 'pk', None) else None,
        )

        locked_customer.current_balance = new_balance
        locked_customer.is_dirty = True
        locked_customer.save(update_fields=['current_balance', 'is_dirty', 'updated_at'])

        tx.customer = locked_customer
        return tx


def record_customer_payment(
    *,
    customer,
    amount,
    branch=None,
    session=None,
    order_id=None,
    invoice_id=None,
    payment_method='Cash',
    reference='',
    notes='',
    created_by=None,
):
    return create_customer_account_transaction(
        customer=customer,
        entry_type='payment',
        direction='credit',
        amount=amount,
        branch=branch,
        session=session,
        order_id=order_id,
        invoice_id=invoice_id,
        payment_method=payment_method,
        reference=reference,
        notes=notes,
        created_by=created_by,
    )


def _next_invoice_number(business):
    last_invoice = (
        Invoice.objects.select_for_update()
        .filter(business=business)
        .order_by('-invoice_number')
        .first()
    )
    return (last_invoice.invoice_number + 1) if last_invoice else 1


def _update_order_invoice_link(order, invoice):
    invoice_id = str(invoice.id)
    update_data = {}

    if getattr(order, 'invoice_id', None) != invoice_id:
        order.invoice_id = invoice_id
        update_data['invoice_id'] = invoice_id
    if not getattr(order, 'is_invoice_sale', False):
        order.is_invoice_sale = True
        update_data['is_invoice_sale'] = True

    if update_data:
        order.is_dirty = True
        update_data['is_dirty'] = True
        type(order).objects.filter(pk=order.pk).update(**update_data)


def _update_account_invoice_link(order, invoice, account_tx=None):
    account_tx = account_tx or CustomerAccountTransaction.objects.filter(
        business=order.business,
        order_id=str(order.id),
        entry_type='credit_sale',
    ).first()

    if account_tx and account_tx.invoice_id != str(invoice.id):
        account_tx.invoice_id = str(invoice.id)
        account_tx.save(update_fields=['invoice_id', 'updated_at'])


def ensure_invoice_for_account_order(order, account_tx=None, created_by=None):
    """
    Ensure an on-account POS order has a matching customer invoice.
    Idempotent across live saves, offline sync retries, and invoice-origin orders.
    """
    if _clean_text(getattr(order, 'payment_method', '')).lower() != 'on account':
        return None

    existing_invoice = None
    existing_invoice_id = _clean_text(getattr(order, 'invoice_id', ''))
    if existing_invoice_id:
        existing_invoice = Invoice.objects.filter(
            id=existing_invoice_id,
            business=order.business,
            document_type='Invoice',
        ).first()

    if not existing_invoice:
        existing_invoice = Invoice.objects.filter(
            business=order.business,
            related_order_id=str(order.id),
            document_type='Invoice',
        ).first()

    if existing_invoice:
        _update_order_invoice_link(order, existing_invoice)
        _update_account_invoice_link(order, existing_invoice, account_tx)
        return existing_invoice

    customer = getattr(order, 'customer', None)
    if not customer:
        customer = resolve_customer_for_account_payload(
            order.business,
            order.branch,
            {
                'customer_name': order.customer_name,
                'customer_phone': order.customer_phone,
                'customer_tin': order.customer_tin,
                'customer_email': order.customer_email,
                'customer_address': order.customer_address,
                'customer_notes': order.customer_notes,
                'buyer_name': order.buyer_name,
                'buyer_tin': order.buyer_tin,
            },
            create_if_missing=True,
        )

    if not customer:
        raise ValidationError("On Account sales require a customer account or customer name/phone.")

    issue_date = getattr(order, 'created_at', None) or timezone.now()
    due_date = issue_date + timedelta(days=30)
    customer_name = _first_non_empty(
        getattr(order, 'customer_name', ''),
        getattr(customer, 'name', ''),
        getattr(order, 'buyer_name', ''),
        'Customer',
    )

    with transaction.atomic():
        invoice = Invoice.objects.create(
            business=order.business,
            branch=order.branch,
            customer=customer,
            invoice_number=_next_invoice_number(order.business),
            document_type='Invoice',
            customer_name=customer_name,
            status='Sent',
            subtotal=_money(getattr(order, 'subtotal', None) or getattr(order, 'net_amount', None)),
            tax=_money(getattr(order, 'vat_amount', None)),
            total=_money(getattr(order, 'total', None) or getattr(order, 'gross_amount', None)),
            issue_date=issue_date,
            due_date=due_date,
            notes=f"POS on-account sale for order #{order.order_number}",
            related_order_id=str(order.id),
        )

        order_items = list(order.items.all())
        for item in order_items:
            quantity = _quantity(getattr(item, 'quantity', None))
            unit_price = _money(getattr(item, 'price', None))
            tax_amount = _money(getattr(item, 'tax_amount', None))
            stored_subtotal = _money(getattr(item, 'subtotal', None))
            line_subtotal = stored_subtotal if stored_subtotal > 0 else _money(unit_price * quantity)
            stored_total = _money(getattr(item, 'total', None))
            total_amount = stored_total if stored_total > 0 else _money(line_subtotal + tax_amount)

            InvoiceLine.objects.create(
                invoice=invoice,
                product_code=_clean_text(getattr(item, 'inventory_item_id', '')),
                product_name=_clean_text(getattr(item, 'name', '')) or 'Item',
                quantity=quantity,
                unit_price=unit_price,
                tax_rate=_money(getattr(item, 'tax_rate', None)),
                tax_amount=tax_amount,
                total_amount=total_amount,
                mra_product_code=_clean_text(getattr(item, 'mra_product_code', '')),
            )

        if order_items:
            subtotal = sum(
                (
                    _money(getattr(item, 'subtotal', None))
                    if _money(getattr(item, 'subtotal', None)) > 0
                    else _money(_money(getattr(item, 'price', None)) * _quantity(getattr(item, 'quantity', None)))
                )
                for item in order_items
            )
            tax = sum(
                _money(getattr(item, 'tax_amount', None))
                for item in order_items
            )
            total = sum(
                (
                    _money(getattr(item, 'total', None))
                    if _money(getattr(item, 'total', None)) > 0
                    else _money(
                        (
                            _money(getattr(item, 'subtotal', None))
                            if _money(getattr(item, 'subtotal', None)) > 0
                            else _money(_money(getattr(item, 'price', None)) * _quantity(getattr(item, 'quantity', None)))
                        )
                        + _money(getattr(item, 'tax_amount', None))
                    )
                )
                for item in order_items
            )
            invoice.subtotal = subtotal
            invoice.tax = tax
            invoice.total = total
            Invoice.objects.filter(pk=invoice.pk).update(
                subtotal=invoice.subtotal,
                tax=invoice.tax,
                total=invoice.total,
                is_dirty=True,
            )

        _update_order_invoice_link(order, invoice)
        _update_account_invoice_link(order, invoice, account_tx)

    return invoice


def record_credit_sale_for_order(order, created_by=None):
    payment_method = _clean_text(getattr(order, 'payment_method', ''))
    if payment_method.lower() != 'on account':
        return None

    existing = CustomerAccountTransaction.objects.filter(
        business=order.business,
        order_id=str(order.id),
        entry_type='credit_sale',
    ).first()
    if existing:
        ensure_invoice_for_account_order(order, account_tx=existing, created_by=created_by)
        return existing

    customer = getattr(order, 'customer', None)
    if not customer:
        customer = resolve_customer_for_account_payload(
            order.business,
            order.branch,
            {
                'customer_name': order.customer_name,
                'customer_phone': order.customer_phone,
                'customer_tin': order.customer_tin,
                'customer_email': order.customer_email,
                'customer_address': order.customer_address,
                'customer_notes': order.customer_notes,
                'buyer_name': order.buyer_name,
                'buyer_tin': order.buyer_tin,
            },
            create_if_missing=True,
        )

    if not customer:
        raise ValidationError("On Account sales require a customer account or customer name/phone.")

    update_fields = []
    if not getattr(order, 'customer_id', None):
        order.customer = customer
        update_fields.append('customer')
    for order_field, customer_field in {
        'customer_name': 'name',
        'customer_phone': 'phone',
        'customer_tin': 'customer_tin',
        'customer_email': 'email',
        'customer_address': 'address',
    }.items():
        if not getattr(order, order_field, None):
            setattr(order, order_field, getattr(customer, customer_field, None))
            update_fields.append(order_field)
    if update_fields:
        update_fields.extend(['is_dirty', 'updated_at'])
        order.is_dirty = True
        order.save(update_fields=update_fields)

    account_tx = create_customer_account_transaction(
        customer=customer,
        entry_type='credit_sale',
        direction='debit',
        amount=order.total,
        branch=order.branch,
        session=order.session,
        order_id=str(order.id),
        payment_method='On Account',
        notes=f"Credit sale for order #{order.order_number}",
        created_by=created_by,
    )

    ensure_invoice_for_account_order(order, account_tx=account_tx, created_by=created_by)
    return account_tx


def _resolve_order_customer(order, required_message):
    customer = getattr(order, 'customer', None)
    if customer:
        return customer

    customer = resolve_customer_for_account_payload(
        order.business,
        order.branch,
        {
            'customer_name': order.customer_name,
            'customer_phone': order.customer_phone,
            'customer_tin': order.customer_tin,
            'customer_email': order.customer_email,
            'customer_address': order.customer_address,
            'customer_notes': order.customer_notes,
            'buyer_name': order.buyer_name,
            'buyer_tin': order.buyer_tin,
        },
        create_if_missing=True,
    )

    if not customer:
        raise ValidationError(required_message)

    update_fields = []
    if not getattr(order, 'customer_id', None):
        order.customer = customer
        update_fields.append('customer')
    for order_field, customer_field in {
        'customer_name': 'name',
        'customer_phone': 'phone',
        'customer_tin': 'customer_tin',
        'customer_email': 'email',
        'customer_address': 'address',
    }.items():
        if not getattr(order, order_field, None):
            setattr(order, order_field, getattr(customer, customer_field, None))
            update_fields.append(order_field)
    if update_fields:
        update_fields.extend(['is_dirty', 'updated_at'])
        order.is_dirty = True
        order.save(update_fields=update_fields)

    return customer


def _inventory_queryset(business, branch=None):
    from inventory.models import InventoryItem

    queryset = InventoryItem.objects.filter(business=business)
    if branch:
        queryset = queryset.filter(branch=branch)
    return queryset


def _resolve_inventory_item(business, branch, reference, item_name=''):
    queryset = _inventory_queryset(business, branch)
    ref = _clean_text(reference)

    if ref:
        try:
            item = queryset.filter(id=ref).first()
        except (ValidationError, ValueError, TypeError):
            item = None
        if item:
            return item

        item = queryset.filter(sku__iexact=ref).first()
        if item:
            return item

        item = queryset.filter(barcode__iexact=ref).first()
        if item:
            return item

    name = _clean_text(item_name)
    if name:
        matches = list(queryset.filter(name__iexact=name)[:2])
        if len(matches) == 1:
            return matches[0]

    return None


def _stock_available_for_reservation(inventory_item):
    stock = _quantity(getattr(inventory_item, 'stock_units', Decimal('0.000')))
    reserved = _quantity(getattr(inventory_item, 'reserved_stock_units', Decimal('0.000')))
    return max(Decimal('0.000'), stock - reserved)


def _business_allows_negative_stock(business):
    try:
        return bool(getattr(business.settings, 'allow_negative_ingredient_stock', False))
    except Exception:
        return False


def _change_reserved_stock(inventory_item, delta):
    if not inventory_item:
        return None

    from inventory.models import InventoryItem

    delta = Decimal(str(delta or 0)).quantize(QUANTITY_QUANT, rounding=ROUND_HALF_UP)
    locked_item = InventoryItem.objects.select_for_update().get(pk=inventory_item.pk)
    current_reserved = _quantity(getattr(locked_item, 'reserved_stock_units', Decimal('0.000')))

    if delta > 0 and not _business_allows_negative_stock(getattr(locked_item, 'business', None)):
        available = _stock_available_for_reservation(locked_item)
        if delta > available:
            raise ValidationError(
                f"Only {available} {locked_item.unit_type or 'units'} available for {locked_item.name} after existing laybuy reservations."
            )

    next_reserved = max(Decimal('0.000'), current_reserved + delta)
    locked_item.reserved_stock_units = next_reserved
    locked_item.is_dirty = True
    locked_item.save(update_fields=['reserved_stock_units', 'is_dirty', 'updated_at'])
    locked_item.update_status()
    return locked_item


def _create_laybuy_reservation(laybuy, *, inventory_item, item_reference, item_name, quantity, order_item_id=None):
    quantity = _quantity(quantity)
    if quantity <= 0:
        return None

    if inventory_item:
        _change_reserved_stock(inventory_item, quantity)

    return CustomerLaybuyReservation.objects.create(
        business=laybuy.business,
        branch=laybuy.branch,
        customer=laybuy.customer,
        laybuy=laybuy,
        inventory_item=inventory_item,
        inventory_item_id_snapshot=_clean_text(getattr(inventory_item, 'id', None) or item_reference),
        order_item_id=_clean_text(order_item_id) or None,
        item_name=_clean_text(item_name or getattr(inventory_item, 'name', '')),
        quantity=quantity,
    )


def reserve_stock_for_laybuy(laybuy, order):
    """
    Reserve physical stock for a laybuy order without consuming stock yet.

    Recipe-backed items reserve their ingredients, matching the eventual FIFO
    decrement path used when the customer collects the laybuy.
    """
    if not laybuy or not order:
        return []

    with transaction.atomic():
        locked_laybuy = CustomerLaybuy.objects.select_for_update().select_related(
            'business',
            'branch',
            'customer',
        ).get(pk=laybuy.pk)

        if CustomerLaybuyReservation.objects.filter(laybuy=locked_laybuy).exists():
            return list(locked_laybuy.reservations.all())

        reservations = []
        for order_item in order.items.all().order_by('created_at', 'id'):
            sold_quantity = _quantity(getattr(order_item, 'quantity', Decimal('0.000')))
            if sold_quantity <= 0:
                continue

            sold_reference = _clean_text(getattr(order_item, 'inventory_item_id', ''))
            sold_inventory_item = _resolve_inventory_item(
                order.business,
                order.branch,
                sold_reference,
                getattr(order_item, 'name', ''),
            )

            if sold_inventory_item and sold_inventory_item.item_type == 'sellable' and sold_inventory_item.recipe:
                recipe_entries = sold_inventory_item.recipe if isinstance(sold_inventory_item.recipe, list) else []
                for recipe_item in recipe_entries:
                    ingredient_reference = _first_non_empty(
                        recipe_item.get('ingredientId'),
                        recipe_item.get('ingredient_id'),
                        recipe_item.get('inventoryItemId'),
                        recipe_item.get('inventory_item_id'),
                        recipe_item.get('id'),
                    )
                    ingredient_name = _clean_text(recipe_item.get('name'))
                    ingredient_quantity = _quantity(recipe_item.get('quantity'))
                    if not ingredient_reference or ingredient_quantity <= 0:
                        continue

                    reserved_quantity = sold_quantity * ingredient_quantity
                    ingredient_item = _resolve_inventory_item(
                        order.business,
                        order.branch,
                        ingredient_reference,
                        ingredient_name,
                    )
                    reservation = _create_laybuy_reservation(
                        locked_laybuy,
                        inventory_item=ingredient_item,
                        item_reference=ingredient_reference,
                        item_name=ingredient_name,
                        quantity=reserved_quantity,
                        order_item_id=order_item.id,
                    )
                    if reservation:
                        reservations.append(reservation)
            else:
                reservation = _create_laybuy_reservation(
                    locked_laybuy,
                    inventory_item=sold_inventory_item,
                    item_reference=sold_reference,
                    item_name=getattr(order_item, 'name', ''),
                    quantity=sold_quantity,
                    order_item_id=order_item.id,
                )
                if reservation:
                    reservations.append(reservation)

        return reservations


def _transition_laybuy_reservations(laybuy, target_status):
    if target_status not in {'fulfilled', 'released'}:
        raise ValidationError("Invalid laybuy reservation status.")

    timestamp_field = 'fulfilled_at' if target_status == 'fulfilled' else 'released_at'
    timestamp = timezone.now()

    with transaction.atomic():
        reservations = list(
            CustomerLaybuyReservation.objects.select_for_update().select_related('inventory_item').filter(
                laybuy=laybuy,
                status='active',
            )
        )

        for reservation in reservations:
            if reservation.inventory_item_id:
                _change_reserved_stock(reservation.inventory_item, -reservation.quantity)
            reservation.status = target_status
            setattr(reservation, timestamp_field, timestamp)
            reservation.is_dirty = True
            reservation.save(update_fields=['status', timestamp_field, 'is_dirty', 'updated_at'])

        return reservations


def fulfill_laybuy_reservations(laybuy):
    return _transition_laybuy_reservations(laybuy, 'fulfilled')


def release_laybuy_reservations(laybuy):
    return _transition_laybuy_reservations(laybuy, 'released')


def collect_laybuy(laybuy, created_by=None):
    """
    Complete a fully paid laybuy and consume the reserved stock.

    This does not create a new sale. The original laybuy order remains the sale
    record; collection only converts the reservation into FIFO stock movement.
    """
    with transaction.atomic():
        locked_laybuy = CustomerLaybuy.objects.select_for_update().select_related(
            'business',
            'branch',
            'customer',
        ).get(pk=laybuy.pk)

        if locked_laybuy.status == 'cancelled':
            raise ValidationError("Cannot collect a cancelled laybuy.")
        if locked_laybuy.status == 'completed':
            return locked_laybuy
        if _money(locked_laybuy.balance_due) > 0:
            raise ValidationError("Laybuy must be fully paid before collection.")

        active_reservations_exist = CustomerLaybuyReservation.objects.filter(
            laybuy=locked_laybuy,
            status='active',
        ).exists()

        if active_reservations_exist and locked_laybuy.order_id:
            from pos_sessions.models import Order
            from pos_sessions.sync_views import decrement_inventory_for_order

            order = Order.objects.select_for_update().filter(
                id=locked_laybuy.order_id,
                business=locked_laybuy.business,
            ).first()
            if not order:
                raise ValidationError("Original laybuy order was not found.")

            applied_cogs = decrement_inventory_for_order(order, order.branch, order.business) or Decimal('0.00')
            applied_cogs = _money(applied_cogs)
            if applied_cogs > 0:
                order.cogs = applied_cogs
                order.is_dirty = True
                order.save(update_fields=['cogs', 'is_dirty', 'updated_at'])

        fulfill_laybuy_reservations(locked_laybuy)

        locked_laybuy.status = 'completed'
        locked_laybuy.completed_at = timezone.now()
        locked_laybuy.is_dirty = True
        locked_laybuy.save(update_fields=['status', 'completed_at', 'is_dirty', 'updated_at'])
        return locked_laybuy


def record_laybuy_payment(
    *,
    laybuy,
    amount,
    branch=None,
    session=None,
    payment_method='Cash',
    reference='',
    notes='',
    created_by=None,
):
    amount = _money(amount)
    if amount <= 0:
        raise ValidationError("Laybuy payment amount must be greater than zero.")

    with transaction.atomic():
        locked_laybuy = CustomerLaybuy.objects.select_for_update().select_related('customer').get(pk=laybuy.pk)
        if locked_laybuy.status == 'cancelled':
            raise ValidationError("Cannot record payments on a cancelled laybuy.")

        balance_due = _money(locked_laybuy.total) - _money(locked_laybuy.paid_amount)
        if amount > balance_due:
            raise ValidationError(f"Payment exceeds remaining laybuy balance of {balance_due}.")

        payment = CustomerLaybuyPayment.objects.create(
            business=locked_laybuy.business,
            branch=branch or locked_laybuy.branch,
            customer=locked_laybuy.customer,
            laybuy=locked_laybuy,
            session=session,
            amount=amount,
            payment_method=_clean_text(payment_method) or 'Cash',
            reference=_clean_text(reference),
            notes=_clean_text(notes),
            created_by=created_by if getattr(created_by, 'pk', None) else None,
        )

        prior_payments = CustomerLaybuyPayment.objects.filter(laybuy=locked_laybuy).exclude(pk=payment.pk).exists()
        locked_laybuy.paid_amount = _money(locked_laybuy.paid_amount) + amount
        if not prior_payments:
            locked_laybuy.deposit_amount = amount
        locked_laybuy.is_dirty = True
        locked_laybuy.save()

        payment.laybuy = locked_laybuy
        return payment


def create_laybuy_for_order(
    order,
    *,
    deposit_amount=0,
    payment_method='Cash',
    reference='',
    notes='',
    due_date=None,
    created_by=None,
):
    order_payment_method = _clean_text(getattr(order, 'payment_method', ''))
    if order_payment_method.lower() != 'laybuy':
        return None

    existing = CustomerLaybuy.objects.filter(
        business=order.business,
        order_id=str(order.id),
    ).first()
    if existing:
        return existing

    customer = _resolve_order_customer(
        order,
        "Laybuy sales require a customer account or customer name/phone.",
    )

    total = _money(order.total)
    subtotal = _money(getattr(order, 'subtotal', total))
    deposit = _money(deposit_amount)
    if deposit > total:
        raise ValidationError("Laybuy deposit cannot exceed the sale total.")

    with transaction.atomic():
        laybuy = CustomerLaybuy.objects.create(
            business=order.business,
            branch=order.branch,
            customer=customer,
            order_id=str(order.id),
            subtotal=subtotal,
            total=total,
            paid_amount=Decimal('0.00'),
            balance_due=total,
            due_date=due_date,
            notes=_clean_text(notes) or f"Laybuy for order #{order.order_number}",
            created_by=created_by if getattr(created_by, 'pk', None) else None,
        )

        if deposit > 0:
            record_laybuy_payment(
                laybuy=laybuy,
                amount=deposit,
                branch=order.branch,
                session=order.session,
                payment_method=payment_method,
                reference=reference,
                notes='Initial laybuy deposit',
                created_by=created_by,
            )
            laybuy.refresh_from_db()

        reserve_stock_for_laybuy(laybuy, order)
        laybuy.refresh_from_db()

        return laybuy
