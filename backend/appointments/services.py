from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from business.customer_accounts import (
    CustomerAccountPaymentAllocation,
    Invoice,
    get_invoice_balance_due,
    record_credit_sale_for_order,
    record_customer_payment,
)
from business.models import CustomerAccountTransaction

from .models import Appointment


TAKE_ORDER_STATUS_TO_APPOINTMENT_STATUS = {
    'Sent to Kitchen': Appointment.STATUS_CHECKED_IN,
    'Preparing': Appointment.STATUS_IN_SERVICE,
    'Ready': Appointment.STATUS_READY_FOR_PAYMENT,
    'Completed': Appointment.STATUS_COMPLETED,
    'Cancelled': Appointment.STATUS_CANCELLED,
}

MONEY_QUANT = Decimal('0.01')
FINAL_PAYMENT_METHODS = {'Cash', 'Card', 'Mobile Money', 'Bank Transfer', 'Other'}


def _money(value):
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal('0.00')
    return amount.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def _text(value):
    return str(value or '').strip()


def _settlement_metadata(order):
    metadata = getattr(order, 'appointment_settlement', None)
    return metadata if isinstance(metadata, dict) else {}


def settle_appointment_order(order, *, created_by=None):
    """Settle an appointment sale and apply its deposit when one was recorded.

    Appointment deposits are deliberately excluded from the general prepaid-credit
    allocator. This keeps them reserved for the appointment they were recorded
    against, even when the same customer has other open account invoices.
    """
    if _text(getattr(order, 'payment_method', '')).lower() != 'appointment settlement':
        return None

    metadata = _settlement_metadata(order)
    appointment_id = _text(metadata.get('appointment_id') or metadata.get('appointmentId'))
    take_order_id = _text(metadata.get('take_order_id') or metadata.get('takeOrderId'))
    final_payment_method = _text(
        metadata.get('final_payment_method') or metadata.get('finalPaymentMethod')
    )
    if not appointment_id or not take_order_id:
        raise ValidationError('Appointment settlement details are incomplete.')
    if final_payment_method not in FINAL_PAYMENT_METHODS:
        raise ValidationError('Choose a valid final payment method for this appointment.')

    with transaction.atomic():
        appointment = (
            Appointment.objects.select_for_update()
            .select_related('business', 'branch', 'customer', 'take_order')
            .get(pk=appointment_id)
        )
        if appointment.business_id != order.business_id or appointment.branch_id != order.branch_id:
            raise ValidationError('The appointment does not belong to this sale branch.')
        if str(appointment.take_order_id or '') != take_order_id:
            raise ValidationError('This appointment is not linked to the selected service order.')
        if appointment.status in {Appointment.STATUS_CANCELLED, Appointment.STATUS_NO_SHOW}:
            raise ValidationError('Cancelled or no-show appointments cannot be settled.')
        if order.customer_id and order.customer_id != appointment.customer_id:
            raise ValidationError('The sale customer does not match the appointment customer.')
        if appointment.settled_order_id and appointment.settled_order_id != order.id:
            raise ValidationError('This appointment has already been settled by another sale.')

        deposits = list(
            appointment.deposits.select_for_update()
            .select_related('payment_transaction')
            .order_by('created_at', 'id')
        )
        deposit_total = sum((_money(deposit.amount) for deposit in deposits), Decimal('0.00'))

        if order.customer_id != appointment.customer_id:
            order.customer = appointment.customer
            order.customer_name = appointment.customer.name
            order.customer_phone = appointment.customer.phone
            order.customer_tin = appointment.customer.customer_tin
            order.is_dirty = True
            order.save(update_fields=[
                'customer', 'customer_name', 'customer_phone', 'customer_tin',
                'is_dirty', 'updated_at',
            ])

        account_tx = record_credit_sale_for_order(
            order,
            created_by=created_by,
            allow_appointment_settlement=True,
            apply_prepaid_credit=False,
        )
        order.refresh_from_db()
        invoice = Invoice.objects.select_for_update().filter(
            id=order.invoice_id,
            business=order.business,
            customer=appointment.customer,
            document_type='Invoice',
        ).first()
        if not invoice:
            raise ValidationError('The appointment settlement invoice could not be created.')

        deposit_transactions = [deposit.payment_transaction for deposit in deposits]
        existing_allocations = {
            allocation.payment_transaction_id: allocation
            for allocation in CustomerAccountPaymentAllocation.objects.select_for_update().filter(
                payment_transaction__in=deposit_transactions,
            )
        }

        allocations = []
        remaining_due = get_invoice_balance_due(invoice)
        for deposit in deposits:
            payment_transaction = deposit.payment_transaction
            existing = existing_allocations.get(payment_transaction.id)
            if existing:
                if existing.invoice_id != invoice.id:
                    raise ValidationError('An appointment deposit has already been used on another invoice.')
                allocations.append(existing)
                continue

            if remaining_due <= 0:
                break
            amount = min(_money(deposit.amount), remaining_due)
            if amount <= 0:
                continue
            allocation = CustomerAccountPaymentAllocation.objects.create(
                business=order.business,
                branch=order.branch,
                customer=appointment.customer,
                payment_transaction=payment_transaction,
                invoice=invoice,
                order_id=str(order.id),
                amount=amount,
                created_by=created_by if getattr(created_by, 'pk', None) else None,
            )
            allocations.append(allocation)
            remaining_due = _money(remaining_due - amount)

        invoice.refresh_from_db()
        remaining_due = get_invoice_balance_due(invoice)
        final_reference = f'Appointment {appointment.id} checkout'
        final_payment = CustomerAccountTransaction.objects.select_for_update().filter(
            business=order.business,
            customer=appointment.customer,
            entry_type='payment',
            direction='credit',
            order_id=str(order.id),
            invoice_id=str(invoice.id),
            reference=final_reference,
        ).first()
        if remaining_due > 0 and not final_payment:
            final_payment = record_customer_payment(
                customer=appointment.customer,
                amount=remaining_due,
                branch=order.branch,
                session=order.session,
                order_id=str(order.id),
                invoice_id=str(invoice.id),
                payment_method=final_payment_method,
                reference=final_reference,
                notes=f'Final payment for appointment service order #{appointment.take_order.order_number}',
                created_by=created_by,
            )

        invoice.refresh_from_db()
        if get_invoice_balance_due(invoice) <= 0 and invoice.status != 'Paid':
            invoice.status = 'Paid'
            invoice.is_dirty = True
            invoice.save(update_fields=['status', 'is_dirty', 'updated_at'])

        allocation_by_payment_id = {
            allocation.payment_transaction_id: allocation
            for allocation in CustomerAccountPaymentAllocation.objects.filter(
                invoice=invoice,
                payment_transaction__in=deposit_transactions,
            )
        }
        payment_breakdown = []
        for deposit in deposits:
            allocation = allocation_by_payment_id.get(deposit.payment_transaction_id)
            if not allocation:
                continue
            payment_breakdown.append({
                'source': 'appointment_deposit',
                'amount': str(_money(allocation.amount)),
                'payment_method': deposit.payment_method,
                'reference': deposit.reference,
                'deposit_id': str(deposit.id),
                'recorded_at': deposit.created_at.isoformat() if deposit.created_at else None,
            })
        if final_payment:
            payment_breakdown.append({
                'source': 'checkout',
                'amount': str(_money(final_payment.amount)),
                'payment_method': final_payment.payment_method,
                'reference': final_payment.reference,
                'recorded_at': final_payment.created_at.isoformat() if final_payment.created_at else None,
            })

        settled_at = timezone.now()
        settled_metadata = {
            'appointment_id': str(appointment.id),
            'take_order_id': str(appointment.take_order_id),
            'invoice_id': str(invoice.id),
            'deposit_total': str(_money(sum((allocation.amount for allocation in allocation_by_payment_id.values()), Decimal('0.00')))),
            'final_payment_amount': str(_money(final_payment.amount if final_payment else 0)),
            'final_payment_method': final_payment_method,
            'settled_at': settled_at.isoformat(),
        }
        type(order).objects.filter(pk=order.pk).update(
            payment_breakdown=payment_breakdown,
            appointment_settlement=settled_metadata,
            is_paid=True,
            is_dirty=True,
            updated_at=settled_at,
        )
        order.payment_breakdown = payment_breakdown
        order.appointment_settlement = settled_metadata
        order.is_paid = True
        order.is_dirty = True
        order.updated_at = settled_at

        appointment_update_fields = []
        if appointment.settled_order_id != order.id:
            appointment.settled_order = order
            appointment_update_fields.append('settled_order')
        if appointment.status != Appointment.STATUS_COMPLETED:
            appointment.status = Appointment.STATUS_COMPLETED
            appointment_update_fields.append('status')
        if not appointment.completed_at:
            appointment.completed_at = settled_at
            appointment_update_fields.append('completed_at')
        if appointment_update_fields:
            appointment_update_fields.append('updated_at')
            appointment.save(update_fields=appointment_update_fields)

        take_order = appointment.take_order
        if take_order and take_order.status != 'Completed':
            take_order.status = 'Completed'
            take_order.completed_at = settled_at
            update_fields = ['status', 'completed_at', 'updated_at']
            if getattr(created_by, 'pk', None):
                take_order.completed_by = created_by
                update_fields.append('completed_by')
            take_order.save(update_fields=update_fields)

        # The payment rows above are the accounting source of truth. Rebuild the
        # sale session now as a fully-paid appointment may not create a separate
        # checkout payment row (for example, when its deposit covers the total).
        if order.session_id:
            from pos_sessions.mark_dirty_on_update import recompute_session_totals

            recompute_session_totals(order.session)
        return {
            'appointment': appointment,
            'invoice': invoice,
            'account_transaction': account_tx,
            'payment_breakdown': payment_breakdown,
        }


def sync_appointment_from_take_order(take_order):
    """Keep an appointment lifecycle aligned with its normal service order."""
    try:
        appointment = take_order.appointment
    except Appointment.DoesNotExist:
        return None

    next_status = TAKE_ORDER_STATUS_TO_APPOINTMENT_STATUS.get(take_order.status)
    if not next_status or appointment.status in {
        Appointment.STATUS_CANCELLED,
        Appointment.STATUS_NO_SHOW,
    }:
        return appointment

    update_fields = []
    if appointment.status != next_status:
        appointment.status = next_status
        update_fields.append('status')
    if next_status == Appointment.STATUS_COMPLETED and not appointment.completed_at:
        appointment.completed_at = timezone.now()
        update_fields.append('completed_at')
    if next_status == Appointment.STATUS_CANCELLED:
        if appointment.cancellation_reason != (take_order.cancellation_reason or ''):
            appointment.cancellation_reason = take_order.cancellation_reason or ''
            update_fields.append('cancellation_reason')
        if appointment.cancelled_by_id != take_order.cancelled_by_id:
            appointment.cancelled_by = take_order.cancelled_by
            update_fields.append('cancelled_by')
        if appointment.cancelled_at != take_order.cancelled_at:
            appointment.cancelled_at = take_order.cancelled_at or timezone.now()
            update_fields.append('cancelled_at')
    if update_fields:
        update_fields.append('updated_at')
        appointment.save(update_fields=update_fields)
    return appointment
