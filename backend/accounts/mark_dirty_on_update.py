"""
Mark Dirty on Update - Accounts Signals

Automatically marks user records as dirty when they are updated,
ensuring all changes are tracked for syncing to cloud backend
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from accounts.models import User


@receiver(post_save, sender=User)
def mark_user_dirty_on_update(sender, instance, created, **kwargs):
    """Mark User dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])
