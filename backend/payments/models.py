from decimal import Decimal
from urllib.parse import urlparse

from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models

from .validators import validate_redirect_url


class PaymentGatewayConfiguration(models.Model):
    PROVIDER_CHOICES = [
        ('paychangu', 'PayChangu'),
    ]

    ENVIRONMENT_CHOICES = [
        ('sandbox', 'Sandbox'),
        ('live', 'Live'),
    ]

    CHECKOUT_FLOW_CHOICES = [
        ('hosted_checkout', 'Hosted Checkout'),
    ]

    provider = models.CharField(max_length=50, choices=PROVIDER_CHOICES, default='paychangu')
    display_name = models.CharField(max_length=255, default='PayChangu')
    is_active = models.BooleanField(
        default=False,
        help_text='Enable this gateway for subscription credit payments.',
    )
    environment = models.CharField(
        max_length=20,
        choices=ENVIRONMENT_CHOICES,
        default='sandbox',
    )
    checkout_flow = models.CharField(
        max_length=50,
        choices=CHECKOUT_FLOW_CHOICES,
        default='hosted_checkout',
    )
    public_key = models.CharField(max_length=255, blank=True)
    secret_key = models.CharField(max_length=255, blank=True)
    webhook_secret = models.CharField(max_length=255, blank=True)
    checkout_init_url = models.URLField(default='https://api.paychangu.com/payment')
    verify_url_template = models.URLField(default='https://api.paychangu.com/verify-payment/{tx_ref}')
    callback_url = models.CharField(
        max_length=500,
        blank=True,
        validators=[validate_redirect_url],
        help_text='Success callback URL sent to PayChangu when generating hosted checkout.',
    )
    return_url = models.CharField(
        max_length=500,
        blank=True,
        validators=[validate_redirect_url],
        help_text='Return URL used when the customer cancels or payment ultimately fails.',
    )
    default_currency = models.CharField(max_length=3, default='MWK')
    payment_title = models.CharField(max_length=255, default='HandyPOS Subscription Top-up')
    payment_description = models.CharField(max_length=255, default='Add credits to your HandyPOS subscription')
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Payment Gateway Configuration'
        verbose_name_plural = 'Payment Gateway Configuration'

    def __str__(self):
        return f'{self.display_name} ({self.get_environment_display()})'

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        return None

    @property
    def is_ready(self):
        required_fields = [
            self.secret_key,
            self.webhook_secret,
        ]
        if not (self.is_active and all(required_fields)):
            return False

        if self.environment != 'live':
            return True

        public_base_url = str(getattr(settings, 'PAYMENT_PUBLIC_BASE_URL', '') or '').strip()
        if public_base_url:
            return urlparse(public_base_url).scheme.lower() == 'https'

        callback_url = str(self.callback_url or '').strip()
        return_url = str(self.return_url or '').strip()
        return (
            urlparse(callback_url).scheme.lower() == 'https' and
            urlparse(return_url).scheme.lower() == 'https'
        )

    @classmethod
    def get_settings(cls):
        return cls.objects.get_or_create(pk=1)[0]


class SubscriptionPaymentAttempt(models.Model):
    STATUS_CHOICES = [
        ('initiated', 'Initiated'),
        ('pending', 'Pending Checkout'),
        ('awaiting_verification', 'Awaiting Verification'),
        ('successful', 'Successful'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
        ('expired', 'Expired'),
    ]

    provider = models.CharField(
        max_length=50,
        choices=PaymentGatewayConfiguration.PROVIDER_CHOICES,
        default='paychangu',
    )
    deposit = models.ForeignKey(
        'subscription.Deposit',
        on_delete=models.CASCADE,
        related_name='payment_attempts',
    )
    initiated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='subscription_payment_attempts',
    )
    tx_ref = models.CharField(max_length=255, unique=True)
    checkout_url = models.URLField(blank=True)
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.01'))],
    )
    currency = models.CharField(max_length=3, default='MWK')
    status = models.CharField(max_length=32, choices=STATUS_CHOICES, default='initiated')
    provider_reference = models.CharField(max_length=255, blank=True)
    callback_status = models.CharField(max_length=50, blank=True)
    request_payload = models.JSONField(default=dict, blank=True)
    response_payload = models.JSONField(default=dict, blank=True)
    verification_payload = models.JSONField(default=dict, blank=True)
    webhook_payload = models.JSONField(default=dict, blank=True)
    last_error = models.TextField(blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Subscription Payment Attempt'
        verbose_name_plural = 'Subscription Payment Attempts'

    def __str__(self):
        return f'{self.deposit.deposit_id} - {self.tx_ref}'


class PaymentWebhookEvent(models.Model):
    provider = models.CharField(
        max_length=50,
        choices=PaymentGatewayConfiguration.PROVIDER_CHOICES,
        default='paychangu',
    )
    related_attempt = models.ForeignKey(
        SubscriptionPaymentAttempt,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='webhook_events',
    )
    signature = models.CharField(max_length=255, blank=True)
    event_type = models.CharField(max_length=100, blank=True)
    tx_ref = models.CharField(max_length=255, blank=True)
    is_valid_signature = models.BooleanField(default=False)
    payload = models.JSONField(default=dict, blank=True)
    processed = models.BooleanField(default=False)
    processing_notes = models.TextField(blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Payment Webhook Event'
        verbose_name_plural = 'Payment Webhook Events'

    def __str__(self):
        event_label = self.event_type or 'webhook'
        tx_ref = self.tx_ref or 'unknown-reference'
        return f'{event_label} - {tx_ref}'
