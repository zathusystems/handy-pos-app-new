from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    SystemConfigViewSet,
    FeaturePricingConfigViewSet, PaymentGatewayConfigViewSet,
    PaymentMethodConfigViewSet, BankTransferConfigViewSet,
    MobileMoneyConfigViewSet
)

router = DefaultRouter()
router.register(r'system-config', SystemConfigViewSet, basename='system-config')
router.register(r'feature-pricing', FeaturePricingConfigViewSet, basename='feature-pricing')
router.register(r'payment-gateways', PaymentGatewayConfigViewSet, basename='payment-gateway')
router.register(r'payment-methods', PaymentMethodConfigViewSet, basename='payment-method')
router.register(r'bank-transfers', BankTransferConfigViewSet, basename='bank-transfer')
router.register(r'mobile-money', MobileMoneyConfigViewSet, basename='mobile-money')

urlpatterns = [
    path('', include(router.urls)),
]
