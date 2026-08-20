"""
Mark Dirty on Update - POS Sessions Signals

Automatically marks POS session records as dirty when they are updated,
ensuring all changes are tracked for syncing to cloud backend
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from django.db.models import Sum, Q
from decimal import Decimal
from pos_sessions.models import Session, Order, OrderItem
from business.models import CustomerAccountTransaction, CustomerLaybuyPayment

ACTIVE_ORDER_STATUSES = ['New', 'Preparing', 'Ready', 'Completed']


def _add_payment_amount(totals, payment_method, amount):
    amount = amount or Decimal('0')
    if amount <= 0:
        return

    normalized_method = str(payment_method or '').strip().lower()
    if normalized_method == 'cash':
        totals['cash'] += amount
    elif normalized_method == 'card':
        totals['card'] += amount
    elif normalized_method == 'mobile money':
        totals['mobile_money'] += amount
    else:
        totals['other'] += amount


def recompute_session_totals(session):
    # Calculate totals from active orders in this session.
    orders = Order.objects.filter(
        session=session,
        status__in=ACTIVE_ORDER_STATUSES,
    )

    total_sales = orders.aggregate(Sum('subtotal'))['subtotal__sum'] or Decimal('0')
    non_laybuy_orders = orders.exclude(payment_method='Laybuy')

    totals = {
        'cash': non_laybuy_orders.filter(payment_method='Cash').aggregate(Sum('total'))['total__sum'] or Decimal('0'),
        'card': non_laybuy_orders.filter(payment_method='Card').aggregate(Sum('total'))['total__sum'] or Decimal('0'),
        'mobile_money': non_laybuy_orders.filter(payment_method='Mobile Money').aggregate(Sum('total'))['total__sum'] or Decimal('0'),
        'on_account': non_laybuy_orders.filter(payment_method='On Account').aggregate(Sum('total'))['total__sum'] or Decimal('0'),
        'other': non_laybuy_orders.filter(payment_method='Other').aggregate(Sum('total'))['total__sum'] or Decimal('0'),
    }

    laybuy_order_ids = [str(order_id) for order_id in orders.filter(payment_method='Laybuy').values_list('id', flat=True)]
    laybuy_payment_filter = Q(session=session)
    if laybuy_order_ids:
        # Preserve old laybuy deposits created before payment sessions existed.
        laybuy_payment_filter |= Q(session__isnull=True, laybuy__order_id__in=laybuy_order_ids)

    laybuy_payments = CustomerLaybuyPayment.objects.filter(laybuy_payment_filter)
    for payment_total in laybuy_payments.values('payment_method').annotate(total=Sum('amount')):
        _add_payment_amount(
            totals,
            payment_total.get('payment_method'),
            payment_total.get('total') or Decimal('0'),
        )

    account_payments = CustomerAccountTransaction.objects.filter(
        session=session,
        entry_type='payment',
        direction='credit',
    )
    for payment_total in account_payments.values('payment_method').annotate(total=Sum('amount')):
        _add_payment_amount(
            totals,
            payment_total.get('payment_method'),
            payment_total.get('total') or Decimal('0'),
        )

    total_tips = session.total_tips or Decimal('0')

    session.total_sales = total_sales
    session.total_cash_sales = totals['cash']
    session.total_card_sales = totals['card']
    session.total_mobile_money_sales = totals['mobile_money']
    session.total_on_account_sales = totals['on_account']
    session.total_other_sales = totals['other']
    session.total_tips = total_tips
    session.expected_cash = session.opening_float + totals['cash']

    session.save(update_fields=[
        'total_sales',
        'total_cash_sales',
        'total_card_sales',
        'total_mobile_money_sales',
        'total_on_account_sales',
        'total_other_sales',
        'total_tips',
        'expected_cash',
    ])


@receiver(post_save, sender=Session)
def mark_session_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Session dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=Order)
def update_session_totals_on_order(sender, instance, created, **kwargs):
    """Update session totals when an order is created or updated"""
    if instance.session:
        recompute_session_totals(instance.session)
    
    # Mark order as dirty if it's an update
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=OrderItem)
def mark_orderitem_dirty_on_update(sender, instance, created, **kwargs):
    """Mark OrderItem dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=CustomerAccountTransaction)
def update_session_totals_on_customer_payment(sender, instance, created, **kwargs):
    """Update collection totals when an account payment is linked to a session."""
    if instance.session_id and instance.entry_type == 'payment' and instance.direction == 'credit':
        recompute_session_totals(instance.session)


@receiver(post_save, sender=CustomerLaybuyPayment)
def update_session_totals_on_laybuy_payment(sender, instance, created, **kwargs):
    """Update collection totals when a laybuy payment is recorded."""
    if instance.session_id:
        recompute_session_totals(instance.session)
        return

    order_id = str(getattr(instance.laybuy, 'order_id', '') or '').strip()
    if order_id:
        order = Order.objects.filter(id=order_id, session__isnull=False).select_related('session').first()
        if order and order.session:
            recompute_session_totals(order.session)
