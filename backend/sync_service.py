"""
Standalone Cloud Sync Service

Independent sync manager for all system operations
Not tied to any specific app - can be used across the entire project
"""

import logging
from typing import Dict, Any, List
from django.utils import timezone
from django.conf import settings

logger = logging.getLogger(__name__)


class CloudSyncManager:
    """
    Standalone manager for syncing all dirty records to cloud backend
    Handles all models from all apps in one centralized place
    """
    
    def __init__(self, cloud_url: str = None):
        """Initialize sync manager"""
        self.cloud_url = cloud_url or getattr(settings, 'CLOUD_BACKEND_URL', 'http://localhost:8001')
        self.cloud_url = self.cloud_url.rstrip('/')
        self.timeout = 10
        self.models_registry = {}
        self._register_all_models()
    
    def _register_all_models(self):
        """Register all models from all apps that have is_dirty field"""
        try:
            from business.models import (
                Business, Branch, TaxRate, BusinessSettings,
                Customer, InvoiceLine, Invoice, Expense
            )
            self.models_registry['business'] = [
                Business, Branch, TaxRate, BusinessSettings,
                Customer, InvoiceLine, Invoice, Expense
            ]
        except ImportError as e:
            logger.warning(f"Could not import business models: {e}")
        
        try:
            from inventory.models import (
                Supplier, InventoryItem, PurchaseOrder, PurchaseOrderItem,
                StockTransfer, WasteRecord, StockAudit, StockAuditItem,
                AuditLog
            )
            self.models_registry['inventory'] = [
                Supplier, InventoryItem, PurchaseOrder, PurchaseOrderItem,
                StockTransfer, WasteRecord, StockAudit, StockAuditItem,
                AuditLog
            ]
        except ImportError as e:
            logger.warning(f"Could not import inventory models: {e}")
        
        try:
            from accounts.models import User
            self.models_registry['accounts'] = [User]
        except ImportError as e:
            logger.warning(f"Could not import accounts models: {e}")
        
        try:
            from staff.models import Staff
            self.models_registry['staff'] = [Staff]
        except ImportError as e:
            logger.warning(f"Could not import staff models: {e}")
        
        try:
            from subscription.models import Subscription
            self.models_registry['subscription'] = [Subscription]
        except ImportError as e:
            logger.warning(f"Could not import subscription models: {e}")
        
        try:
            from pos_sessions.models import Session, Order, OrderItem
            self.models_registry['pos_sessions'] = [Session, Order, OrderItem]
        except ImportError as e:
            logger.warning(f"Could not import pos_sessions models: {e}")
    
    def get_all_dirty_records(self) -> Dict[str, List[Any]]:
        """Get all dirty records from all registered models"""
        dirty_records = {}
        
        for app_name, models in self.models_registry.items():
            for model_class in models:
                try:
                    dirty = model_class.objects.filter(is_dirty=True)
                    if dirty.exists():
                        dirty_records[model_class.__name__] = list(dirty)
                except Exception as e:
                    logger.warning(f"Error fetching dirty records for {model_class.__name__}: {e}")
        
        return dirty_records
    
    def serialize_record(self, instance) -> Dict[str, Any]:
        """Serialize model instance to dict"""
        data = {}
        
        for field in instance._meta.get_fields():
            if field.name.startswith('_'):
                continue
            
            if hasattr(field, 'many_to_one') or hasattr(field, 'one_to_one'):
                value = getattr(instance, f"{field.name}_id", None)
            elif hasattr(field, 'many_to_many'):
                continue
            else:
                value = getattr(instance, field.name, None)
            
            if isinstance(value, timezone.datetime):
                value = value.isoformat()
            
            data[field.name] = value
        
        return data
    
    def sync_record(self, instance) -> tuple:
        """
        Sync single record to cloud
        
        Returns:
            (success: bool, message: str)
        """
        import requests
        
        try:
            model_name = instance.__class__.__name__.lower()
            data = self.serialize_record(instance)
            
            url = f"{self.cloud_url}/api/sync/{model_name}/"
            
            response = requests.post(
                url,
                json=data,
                timeout=self.timeout,
                headers={'Content-Type': 'application/json'}
            )
            
            if response.status_code in [200, 201]:
                instance.is_dirty = False
                instance.save(update_fields=['is_dirty'])
                logger.info(f"✓ Synced {model_name}#{instance.pk}")
                return True, "Synced"
            else:
                logger.warning(f"✗ Sync failed for {model_name}#{instance.pk}: {response.status_code}")
                return False, f"Status {response.status_code}"
        
        except Exception as e:
            logger.error(f"✗ Sync error for {instance.__class__.__name__}#{instance.pk}: {str(e)}")
            return False, str(e)
    
    def sync_all(self) -> Dict[str, Any]:
        """
        Sync all dirty records from all apps to cloud
        
        Returns:
            Comprehensive sync report
        """
        dirty_records = self.get_all_dirty_records()
        
        report = {
            'timestamp': timezone.now().isoformat(),
            'cloud_url': self.cloud_url,
            'total_models': len(dirty_records),
            'total_records': sum(len(records) for records in dirty_records.values()),
            'total_synced': 0,
            'total_failed': 0,
            'models': {}
        }
        
        logger.info(f"Starting sync to {self.cloud_url}")
        logger.info(f"Found {report['total_records']} dirty records across {report['total_models']} models")
        
        for model_name, records in dirty_records.items():
            model_stats = {
                'total': len(records),
                'synced': 0,
                'failed': 0,
                'records': []
            }
            
            for record in records:
                success, message = self.sync_record(record)
                
                if success:
                    model_stats['synced'] += 1
                    report['total_synced'] += 1
                else:
                    model_stats['failed'] += 1
                    report['total_failed'] += 1
                
                model_stats['records'].append({
                    'id': record.pk,
                    'success': success,
                    'message': message
                })
            
            report['models'][model_name] = model_stats
            logger.info(f"{model_name}: {model_stats['synced']}/{model_stats['total']} synced")
        
        logger.info(f"Sync complete: {report['total_synced']} synced, {report['total_failed']} failed")
        
        return report
    
    def get_status(self) -> Dict[str, Any]:
        """Get current sync status across all models"""
        dirty_records = self.get_all_dirty_records()
        
        status = {
            'timestamp': timezone.now().isoformat(),
            'cloud_url': self.cloud_url,
            'total_dirty': sum(len(records) for records in dirty_records.values()),
            'models': {}
        }
        
        for model_name, records in dirty_records.items():
            status['models'][model_name] = {
                'dirty_count': len(records),
                'record_ids': [r.pk for r in records]
            }
        
        return status


# Singleton instance
_sync_manager = None


def get_sync_manager(cloud_url: str = None) -> CloudSyncManager:
    """Get or create sync manager instance"""
    global _sync_manager
    if _sync_manager is None:
        _sync_manager = CloudSyncManager(cloud_url)
    return _sync_manager


def sync_all_to_cloud(cloud_url: str = None) -> Dict[str, Any]:
    """
    Centralized function to sync all dirty records to cloud
    
    Args:
        cloud_url: Cloud backend URL (uses settings if not provided)
        
    Returns:
        Sync report
    """
    manager = CloudSyncManager(cloud_url)
    return manager.sync_all()


def get_sync_status(cloud_url: str = None) -> Dict[str, Any]:
    """Get current sync status across all models"""
    manager = CloudSyncManager(cloud_url)
    return manager.get_status()
