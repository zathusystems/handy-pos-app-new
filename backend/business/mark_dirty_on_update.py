"""
Mark Dirty on Update - Django Signals

Automatically marks records as dirty when they are updated,
ensuring all changes are tracked for syncing to cloud backend
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from business.models import (
    Business, Branch, TaxRate, BusinessCharge, BusinessSettings,
    Customer, InvoiceLine, Invoice, Expense
)


@receiver(post_save, sender=Business)
def mark_business_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Business dirty on update (not on create)"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=Branch)
def mark_branch_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Branch dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=TaxRate)
def mark_taxrate_dirty_on_update(sender, instance, created, **kwargs):
    """Mark TaxRate dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=BusinessCharge)
def mark_businesscharge_dirty_on_update(sender, instance, created, **kwargs):
    """Mark BusinessCharge dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=BusinessSettings)
def mark_businesssettings_dirty_on_update(sender, instance, created, **kwargs):
    """Mark BusinessSettings dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=Customer)
def mark_customer_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Customer dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=InvoiceLine)
def mark_invoiceline_dirty_on_update(sender, instance, created, **kwargs):
    """Mark InvoiceLine dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=Invoice)
def mark_invoice_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Invoice dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=Expense)
def mark_expense_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Expense dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])
