from django.contrib import admin
from django.conf import settings
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.html import format_html

from .forms import PaymentGatewayConfigurationAdminForm, build_payment_webhook_url
from .models import PaymentGatewayConfiguration, PaymentWebhookEvent, SubscriptionPaymentAttempt


def mask_credential(value):
    credential = str(value or '').strip()
    if not credential:
        return 'Not set'
    if len(credential) <= 4:
        return '*' * len(credential)
    return f"{'*' * 8}{credential[-4:]}"


@admin.register(PaymentGatewayConfiguration)
class PaymentGatewayConfigurationAdmin(admin.ModelAdmin):
    form = PaymentGatewayConfigurationAdminForm
    save_on_top = True
    list_display = [
        'display_name',
        'provider',
        'environment',
        'default_currency',
        'is_active',
        'is_ready',
    ]
    readonly_fields = [
        'gateway_status_summary',
        'is_ready',
        'public_key_preview',
        'secret_key_preview',
        'webhook_secret_preview',
        'payment_public_base_url',
        'paychangu_webhook_url',
        'created_at',
        'updated_at',
    ]
    fieldsets = (
        ('Gateway', {
            'fields': (
                'provider',
                'display_name',
                'environment',
                'checkout_flow',
                'is_active',
                'gateway_status_summary',
                'is_ready',
            ),
        }),
        ('Credentials', {
            'description': (
                'Manage the payment gateway keys here. Leave the secret fields blank when editing '
                'if you want to keep the saved values unchanged.'
            ),
            'fields': (
                'public_key_preview',
                'public_key',
                'secret_key_preview',
                'secret_key',
                'webhook_secret_preview',
                'webhook_secret',
            ),
        }),
        ('Public Endpoints', {
            'description': (
                'Use the webhook URL below in PayChangu. Set PAYMENT_PUBLIC_BASE_URL in production '
                'so the generated webhook URL points to the public API domain.'
            ),
            'fields': (
                'payment_public_base_url',
                'paychangu_webhook_url',
            ),
        }),
        ('Checkout', {
            'description': (
                'For the Tauri and Android deep-link flow, set callback_url and return_url to '
                'handypos://subscription-payment/{deposit_id}. The backend will send PayChangu '
                'public HTTPS bridge URLs built from PAYMENT_PUBLIC_BASE_URL.'
            ),
            'fields': (
                'checkout_init_url',
                'verify_url_template',
                'callback_url',
                'return_url',
                'default_currency',
                'payment_title',
                'payment_description',
                'metadata',
            ),
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',),
        }),
    )

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def changelist_view(self, request, extra_context=None):
        config = PaymentGatewayConfiguration.get_settings()
        return redirect(reverse('admin:payments_paymentgatewayconfiguration_change', args=[config.pk]))

    @admin.display(description='Gateway Setup')
    def gateway_status_summary(self, obj):
        if not obj.is_active:
            return format_html(
                '<span style="color:#856404;">{}</span>',
                'Hosted checkout is turned off. The billing page can use manual proof instead.',
            )

        issues = []
        if not obj.secret_key:
            issues.append('secret key')
        if not obj.webhook_secret:
            issues.append('webhook secret')

        public_base_url = str(getattr(settings, 'PAYMENT_PUBLIC_BASE_URL', '') or '').strip()
        if obj.environment == 'live':
            callback_url = str(obj.callback_url or '').strip()
            return_url = str(obj.return_url or '').strip()
            has_https_public_base = public_base_url.lower().startswith('https://')
            has_https_redirects = callback_url.lower().startswith('https://') and return_url.lower().startswith('https://')
            if not (has_https_public_base or has_https_redirects):
                issues.append('public HTTPS callback/return URL')

        if issues:
            return format_html(
                '<span style="color:#b45309;">Missing or incomplete: {}</span>',
                ', '.join(issues),
            )

        return format_html(
            '<span style="color:#15803d;">{}</span>',
            'Ready to accept hosted subscription payments.',
        )

    @admin.display(description='Saved Public Key')
    def public_key_preview(self, obj):
        return mask_credential(obj.public_key)

    @admin.display(description='Saved Secret Key')
    def secret_key_preview(self, obj):
        return mask_credential(obj.secret_key)

    @admin.display(description='Saved Webhook Secret')
    def webhook_secret_preview(self, obj):
        return mask_credential(obj.webhook_secret)

    @admin.display(description='PAYMENT_PUBLIC_BASE_URL')
    def payment_public_base_url(self, obj):
        return str(getattr(settings, 'PAYMENT_PUBLIC_BASE_URL', '') or '').strip() or 'Not set'

    @admin.display(description='PayChangu Webhook URL')
    def paychangu_webhook_url(self, obj):
        return build_payment_webhook_url()


@admin.register(SubscriptionPaymentAttempt)
class SubscriptionPaymentAttemptAdmin(admin.ModelAdmin):
    list_display = [
        'tx_ref',
        'deposit',
        'provider',
        'amount',
        'credited_amount',
        'funding_period',
        'currency',
        'status',
        'paid_at',
        'verified_at',
        'created_at',
    ]
    list_select_related = ['deposit', 'deposit__subscription', 'deposit__subscription__business', 'initiated_by']
    list_filter = ['provider', 'status', 'currency', 'created_at']
    search_fields = ['tx_ref', 'provider_reference', 'deposit__deposit_id', 'deposit__subscription__business__name']
    readonly_fields = [
        'provider',
        'deposit',
        'initiated_by',
        'tx_ref',
        'checkout_url',
        'amount',
        'credited_amount',
        'funding_period',
        'currency',
        'status',
        'provider_reference',
        'callback_status',
        'request_payload',
        'response_payload',
        'verification_payload',
        'webhook_payload',
        'last_error',
        'paid_at',
        'verified_at',
        'created_at',
        'updated_at',
    ]
    ordering = ['-created_at']

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description='Credits')
    def credited_amount(self, obj):
        return obj.deposit.get_credit_amount()

    @admin.display(description='Bundle')
    def funding_period(self, obj):
        return obj.deposit.funding_period or '-'


@admin.register(PaymentWebhookEvent)
class PaymentWebhookEventAdmin(admin.ModelAdmin):
    list_display = [
        'event_type',
        'tx_ref',
        'provider',
        'is_valid_signature',
        'processed',
        'processed_at',
        'created_at',
    ]
    list_select_related = ['related_attempt']
    list_filter = ['provider', 'is_valid_signature', 'processed', 'created_at']
    search_fields = ['event_type', 'tx_ref', 'signature']
    readonly_fields = [
        'provider',
        'related_attempt',
        'signature',
        'event_type',
        'tx_ref',
        'is_valid_signature',
        'payload',
        'processed',
        'processing_notes',
        'processed_at',
        'created_at',
    ]
    ordering = ['-created_at']

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
