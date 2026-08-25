from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import BusinessViewSet, BranchViewSet, TaxRateViewSet, BusinessChargeViewSet, CustomerViewSet, InvoiceViewSet, ExpenseViewSet
from .dashboard_views import DashboardViewSet
from .sync_views import sync_push, sync_pull

router = DefaultRouter()
router.register(r'businesses', BusinessViewSet, basename='business')
router.register(r'branches', BranchViewSet, basename='branch')
router.register(r'tax-rates', TaxRateViewSet, basename='tax-rate')
router.register(r'charges', BusinessChargeViewSet, basename='business-charge')
router.register(r'customers', CustomerViewSet, basename='customer')
router.register(r'invoices', InvoiceViewSet, basename='invoice')
router.register(r'expenses', ExpenseViewSet, basename='expense')
router.register(r'dashboard', DashboardViewSet, basename='dashboard')

urlpatterns = [
    path('', include(router.urls)),
    path('sync/push/', sync_push, name='sync-push'),
    path('sync/pull/', sync_pull, name='sync-pull'),
]
