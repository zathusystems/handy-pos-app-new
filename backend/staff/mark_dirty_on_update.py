"""
Mark Dirty on Update - Staff Signals

Automatically marks staff records as dirty when they are updated,
ensuring all changes are tracked for syncing to cloud backend
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from staff.models import Staff


@receiver(post_save, sender=Staff)
def mark_staff_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Staff dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])
