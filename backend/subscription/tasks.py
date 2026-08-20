"""
Celery tasks for subscription management
"""
from celery import shared_task
from .models import Subscription, SubscriptionStatus


@shared_task
def generate_monthly_invoices():
    """Invoicing is disabled for subscription billing."""
    return {
        'invoices_created': 0,
        'invoices_paid': 0,
        'invoicing_enabled': False,
    }


@shared_task
def retry_failed_invoices():
    """Invoicing is disabled for subscription billing."""
    return {
        'retried': 0,
        'paid': 0,
        'invoicing_enabled': False,
    }


@shared_task
def check_low_balance_subscriptions():
    """
    Check for subscriptions with low balance and send notifications
    This task can be scheduled to run daily
    """
    from .models import Subscription
    
    # Get subscriptions with balance less than 2 days of charges
    subscriptions = Subscription.objects.filter(status=SubscriptionStatus.ACTIVE)
    
    low_balance_count = 0
    
    for subscription in subscriptions:
        daily_charge = subscription.calculate_daily_charges()
        
        # If balance is less than 2 days of charges
        if daily_charge > 0 and subscription.account_balance < (daily_charge * 2):
            low_balance_count += 1
            # TODO: Send notification to user
            # send_low_balance_notification(subscription)
    
    return {
        'low_balance_subscriptions': low_balance_count,
    }
