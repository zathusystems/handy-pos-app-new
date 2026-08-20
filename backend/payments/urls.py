from django.urls import path

from .views import (
    PayChanguWebhookView,
    PaymentGatewayConfigurationView,
    PaymentWebhookEventListView,
    SubscriptionFundingPricingView,
    StartSubscriptionCheckoutView,
    SubscriptionCheckoutReturnView,
    SubscriptionPaymentAttemptDetailView,
    SubscriptionPaymentAttemptListView,
    VerifySubscriptionCheckoutView,
)


urlpatterns = [
    path('gateway/configuration/', PaymentGatewayConfigurationView.as_view(), name='payment-gateway-configuration'),
    path('subscription/pricing/', SubscriptionFundingPricingView.as_view(), name='subscription-pricing'),
    path('subscription/checkout/start/', StartSubscriptionCheckoutView.as_view(), name='subscription-checkout-start'),
    path('subscription/checkout/verify/', VerifySubscriptionCheckoutView.as_view(), name='subscription-checkout-verify'),
    path('subscription/checkout/return/<str:deposit_id>/', SubscriptionCheckoutReturnView.as_view(), name='subscription-checkout-return'),
    path('subscription-attempts/', SubscriptionPaymentAttemptListView.as_view(), name='subscription-payment-attempt-list'),
    path('subscription-attempts/<int:pk>/', SubscriptionPaymentAttemptDetailView.as_view(), name='subscription-payment-attempt-detail'),
    path('webhooks/events/', PaymentWebhookEventListView.as_view(), name='payment-webhook-event-list'),
    path('webhooks/paychangu/', PayChanguWebhookView.as_view(), name='paychangu-webhook'),
]
