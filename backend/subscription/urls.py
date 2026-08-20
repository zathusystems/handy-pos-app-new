from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import SubscriptionViewSet, InvoiceViewSet, DepositViewSet, SubscriptionFeatureViewSet, FeaturePricingViewSet

router = DefaultRouter()
router.register(r'subscriptions', SubscriptionViewSet, basename='subscription')
router.register(r'invoices', InvoiceViewSet, basename='invoice')
router.register(r'deposits', DepositViewSet, basename='deposit')
router.register(r'subscription-features', SubscriptionFeatureViewSet, basename='subscription-feature')
router.register(r'feature-pricing', FeaturePricingViewSet, basename='feature-pricing')

urlpatterns = [
    path('', include(router.urls)),
]
