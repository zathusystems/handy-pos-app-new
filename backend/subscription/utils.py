"""
Subscription utility functions for invoice generation and payment processing
"""
from django.utils import timezone
from django.db import transaction
from datetime import datetime, timedelta
from decimal import Decimal
from .models import Subscription, Invoice, UsageCharge, SubscriptionStatus
import uuid

SUBSCRIPTION_INVOICING_ENABLED = False


def generate_invoice_number(subscription_id, year, month):
    """Generate a unique invoice number"""
    return f"INV-{subscription_id}-{year}{month:02d}-{uuid.uuid4().hex[:8].upper()}"


def get_billing_period(month=None, year=None):
    """
    Get the start and end datetime for a billing period
    
    Args:
        month: Month number (1-12), defaults to current month
        year: Year, defaults to current year
    
    Returns:
        tuple: (billing_period_start, billing_period_end)
    """
    now = timezone.now()
    month = month or now.month
    year = year or now.year
    
    # Get first day of the month
    billing_period_start = datetime(year, month, 1, tzinfo=timezone.utc)
    
    # Get last day of the month
    if month == 12:
        billing_period_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc) - timedelta(seconds=1)
    else:
        billing_period_end = datetime(year, month + 1, 1, tzinfo=timezone.utc) - timedelta(seconds=1)
    
    return billing_period_start, billing_period_end


def create_invoice(subscription, billing_period_start, billing_period_end, auto_pay=True):
    """
    Create an invoice for a subscription for a given billing period
    
    Args:
        subscription: Subscription instance
        billing_period_start: Start datetime of billing period
        billing_period_end: End datetime of billing period
        auto_pay: Whether to attempt auto-payment with available balance
    
    Returns:
        tuple: (invoice, paid) - invoice instance and whether it was paid
    """
    if not SUBSCRIPTION_INVOICING_ENABLED:
        return None, False

    # Check if invoice already exists for this period
    existing_invoice = Invoice.objects.filter(
        subscription=subscription,
        billing_period_start__year=billing_period_start.year,
        billing_period_start__month=billing_period_start.month
    ).exists()
    
    if existing_invoice:
        return None, False
    
    # Calculate charges
    monthly_amount = subscription.calculate_monthly_charges(days=30)
    
    # Generate invoice number
    invoice_number = generate_invoice_number(
        subscription.business.id,
        billing_period_start.year,
        billing_period_start.month
    )
    
    # Set due date (7 days after billing period end)
    due_date = billing_period_end + timedelta(days=7)
    
    # Create invoice
    invoice = Invoice.objects.create(
        subscription=subscription,
        invoice_number=invoice_number,
        amount=monthly_amount,
        billing_period_start=billing_period_start,
        billing_period_end=billing_period_end,
        due_date=due_date,
        status='sent'
    )
    
    paid = False
    
    # Try to auto-pay if enabled
    if auto_pay and subscription.is_active():
        paid = process_invoice_payment(invoice)
    
    return invoice, paid


def process_invoice_payment(invoice):
    """
    Process payment for an invoice using available balance
    
    Args:
        invoice: Invoice instance
    
    Returns:
        bool: True if payment was successful, False otherwise
    """
    if not SUBSCRIPTION_INVOICING_ENABLED:
        return False

    with transaction.atomic():
        locked_invoice = Invoice.objects.select_for_update().select_related('subscription').get(pk=invoice.pk)

        # Idempotent success for already paid invoices.
        if locked_invoice.status == 'paid':
            invoice.status = locked_invoice.status
            invoice.paid_date = locked_invoice.paid_date
            return True

        locked_subscription = Subscription.objects.select_for_update().get(pk=locked_invoice.subscription_id)

        # Check if sufficient balance
        if locked_subscription.account_balance < locked_invoice.amount:
            return False

        locked_subscription.account_balance -= locked_invoice.amount
        locked_subscription.save(update_fields=['account_balance', 'updated_at'])

        # Mark invoice as paid
        locked_invoice.status = 'paid'
        locked_invoice.paid_date = timezone.now()
        locked_invoice.save(update_fields=['status', 'paid_date', 'updated_at'])

        # Record the charge
        UsageCharge.objects.create(
            subscription=locked_subscription,
            charge_type='base_daily',
            description=f'Monthly invoice {locked_invoice.invoice_number}',
            amount=locked_invoice.amount
        )

        invoice.status = locked_invoice.status
        invoice.paid_date = locked_invoice.paid_date
        return True


def get_subscription_summary(subscription):
    """
    Get a summary of subscription charges and balance
    
    Args:
        subscription: Subscription instance
    
    Returns:
        dict: Summary information
    """
    daily_charge = subscription.calculate_daily_charges()
    monthly_charge = subscription.calculate_monthly_charges(days=30)
    
    pending_invoices_count = 0
    pending_amount = Decimal('0.00')

    if SUBSCRIPTION_INVOICING_ENABLED:
        pending_invoices = Invoice.objects.filter(
            subscription=subscription,
            status__in=['sent', 'draft']
        )
        pending_invoices_count = pending_invoices.count()
        pending_amount = sum(inv.amount for inv in pending_invoices)
    
    return {
        'daily_charge': daily_charge,
        'monthly_charge': monthly_charge,
        'account_balance': subscription.account_balance,
        'total_spent': subscription.total_spent,
        'pending_invoices_count': pending_invoices_count,
        'pending_amount': pending_amount,
        'days_until_insufficient_balance': int(subscription.account_balance / daily_charge) if daily_charge > 0 else None,
    }
