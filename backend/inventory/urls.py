"""
MRA EIS-Compliant Inventory URLs

API endpoints for inventory operations with MRA compliance.
"""

from django.urls import path, include
from rest_framework.routers import DefaultRouter

from .views import (
    SupplierViewSet, MRAProductMappingViewSet, InventoryItemViewSet,
    InventorySnapshotViewSet, PurchaseOrderViewSet, WasteRecordViewSet,
    StockTransferViewSet, StockAuditViewSet, AuditLogViewSet
)
from .sync_views import sync_push, sync_pull

# Create router
router = DefaultRouter()
router.register(r'suppliers', SupplierViewSet, basename='supplier')
router.register(r'mra-mappings', MRAProductMappingViewSet, basename='mra-mapping')
router.register(r'items', InventoryItemViewSet, basename='inventory-item')
router.register(r'products', InventoryItemViewSet, basename='product')
router.register(r'snapshots', InventorySnapshotViewSet, basename='inventory-snapshot')
router.register(r'purchase-orders', PurchaseOrderViewSet, basename='purchase-order')
router.register(r'waste', WasteRecordViewSet, basename='waste-record')
router.register(r'transfers', StockTransferViewSet, basename='stock-transfer')
router.register(r'stock-audits', StockAuditViewSet, basename='stock-audit')
router.register(r'audit-logs', AuditLogViewSet, basename='audit-log')

# URL patterns
urlpatterns = [
    path('', include(router.urls)),
    path('sync/push/', sync_push, name='sync-push'),
    path('sync/pull/', sync_pull, name='sync-pull'),
]
