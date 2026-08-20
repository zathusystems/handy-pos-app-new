from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone
from datetime import timedelta
from business.models import Business
from .models import Subscription
from system_config.models import SystemConfig


@receiver(post_save, sender=Business)
def create_subscription_with_free_credits(sender, instance, created, **kwargs):
    """
    Signal handler disabled: Subscription creation is now handled exclusively by the frontend
    during the setup wizard flow. This prevents duplicate subscriptions from being created.
    
    The frontend explicitly requests subscription creation via the API endpoint when the user
    completes the setup wizard and selects a plan.
    """
    # Subscription creation is now handled by frontend only
    pass
