"""
Mark Dirty on Update - Inventory Signals

Automatically marks inventory records as dirty when they are updated,
ensuring all changes are tracked for syncing to cloud backend
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from inventory.models import (
    Supplier, InventoryItem, PurchaseOrder, PurchaseOrderItem,
    StockTransfer, WasteRecord, StockAudit,
    StockAuditItem, AuditLog
)


@receiver(post_save, sender=Supplier)
def mark_supplier_dirty_on_update(sender, instance, created, **kwargs):
    """Mark Supplier dirty on update"""
    if not created and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=InventoryItem)
def mark_inventoryitem_dirty_on_update(sender, instance, created, **kwargs):
    """Mark InventoryItem dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=PurchaseOrder)
def mark_purchaseorder_dirty_on_update(sender, instance, created, **kwargs):
    """Mark PurchaseOrder dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=PurchaseOrderItem)
def mark_purchaseorderitem_dirty_on_update(sender, instance, created, **kwargs):
    """Mark PurchaseOrderItem dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=StockTransfer)
def mark_stocktransfer_dirty_on_update(sender, instance, created, **kwargs):
    """Mark StockTransfer dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=WasteRecord)
def mark_wasterecord_dirty_on_update(sender, instance, created, **kwargs):
    """Mark WasteRecord dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=StockAudit)
def mark_stockaudit_dirty_on_update(sender, instance, created, **kwargs):
    """Mark StockAudit dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=StockAuditItem)
def mark_stockaudititem_dirty_on_update(sender, instance, created, **kwargs):
    """Mark StockAuditItem dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])


@receiver(post_save, sender=AuditLog)
def mark_auditlog_dirty_on_update(sender, instance, created, **kwargs):
    """Mark AuditLog dirty on update"""
    if not created and hasattr(instance, 'is_dirty') and instance.is_dirty is False:
        instance.is_dirty = True
        instance.save(update_fields=['is_dirty'])
