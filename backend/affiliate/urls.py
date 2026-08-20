from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    AffiliateViewSet, BusinessReferralViewSet, RecurringCommissionViewSet,
    AffiliatePaymentViewSet, AffiliateSettingsViewSet
)

router = DefaultRouter()
router.register(r'affiliates', AffiliateViewSet, basename='affiliate')
router.register(r'business-referrals', BusinessReferralViewSet, basename='business-referral')
router.register(r'recurring-commissions', RecurringCommissionViewSet, basename='recurring-commission')
router.register(r'payments', AffiliatePaymentViewSet, basename='payment')
router.register(r'settings', AffiliateSettingsViewSet, basename='settings')

urlpatterns = [
    path('', include(router.urls)),
]
