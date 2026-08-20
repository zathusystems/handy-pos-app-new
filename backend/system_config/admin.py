from django.contrib import admin
from .models import (
    SystemConfig, FeaturePricingConfig, PaymentGatewayConfig,
    PaymentMethodConfig, BankTransferConfig, MobileMoneyConfig
)


@admin.register(SystemConfig)
class SystemConfigAdmin(admin.ModelAdmin):
    list_display = ('system_name', 'default_currency', 'base_subscription_price_per_day', 'trial_days', 'maintenance_mode')
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('System Information', {
            'fields': ('system_name', 'system_email', 'system_phone')
        }),
        ('Subscription Pricing', {
            'fields': ('base_subscription_price_per_day', 'base_subscription_price_per_day_mwk', 'base_subscription_price_per_day_usd', 'trial_days', 'enable_feature_pricing')
        }),
        ('Currency Settings', {
            'fields': ('default_currency', 'malawi_currency_code', 'international_currency_code')
        }),
        ('Invoice Settings', {
            'fields': ('invoice_due_days',)
        }),
        ('Payment Settings - General', {
            'fields': ('minimum_deposit_amount', 'maximum_deposit_amount', 'low_balance_threshold_days')
        }),
        ('Maintenance', {
            'fields': ('maintenance_mode', 'maintenance_message'),
            'classes': ('collapse',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def has_add_permission(self, request):
        # Only allow one instance
        return not SystemConfig.objects.exists()

    def has_delete_permission(self, request, obj=None):
        # Prevent deletion of the singleton
        return False




@admin.register(FeaturePricingConfig)
class FeaturePricingConfigAdmin(admin.ModelAdmin):
    list_display = ('feature', 'default_price_per_day', 'is_premium', 'is_active')
    search_fields = ('feature',)
    list_filter = ('is_active', 'is_premium', 'created_at')
    ordering = ['feature']
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('Feature Information', {
            'fields': ('feature', 'description')
        }),
        ('Pricing', {
            'fields': ('default_price_per_day',)
        }),
        ('Status', {
            'fields': ('is_active', 'is_premium')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(PaymentGatewayConfig)
class PaymentGatewayConfigAdmin(admin.ModelAdmin):
    list_display = ('gateway', 'is_enabled', 'transaction_fee_percentage', 'minimum_transaction_amount')
    list_filter = ('is_enabled', 'gateway', 'created_at')
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('Gateway Information', {
            'fields': ('gateway', 'is_enabled')
        }),
        ('API Configuration', {
            'fields': ('api_key', 'api_secret'),
            'classes': ('collapse',)
        }),
        ('Webhook Configuration', {
            'fields': ('webhook_url', 'webhook_secret'),
            'classes': ('collapse',)
        }),
        ('Transaction Settings', {
            'fields': ('transaction_fee_percentage', 'minimum_transaction_amount')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(PaymentMethodConfig)
class PaymentMethodConfigAdmin(admin.ModelAdmin):
    list_display = ('currency', 'payment_method', 'is_enabled', 'display_order')
    list_filter = ('currency', 'is_enabled', 'payment_method')
    ordering = ['currency', 'display_order']
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('Payment Method', {
            'fields': ('currency', 'payment_method', 'is_enabled', 'display_order')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(BankTransferConfig)
class BankTransferConfigAdmin(admin.ModelAdmin):
    list_display = ('currency', 'bank_name', 'account_holder')
    list_filter = ('currency',)
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('Bank Information', {
            'fields': ('currency', 'bank_name', 'account_holder')
        }),
        ('Account Details', {
            'fields': ('account_number', 'routing_number', 'swift_code', 'iban')
        }),
        ('Instructions', {
            'fields': ('instructions',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(MobileMoneyConfig)
class MobileMoneyConfigAdmin(admin.ModelAdmin):
    list_display = ('provider', 'account_number', 'is_enabled', 'display_order')
    list_filter = ('is_enabled',)
    ordering = ['display_order']
    readonly_fields = ('created_at', 'updated_at')
    
    fieldsets = (
        ('Provider Information', {
            'fields': ('provider', 'is_enabled', 'display_order')
        }),
        ('Account Details', {
            'fields': ('account_number', 'account_name')
        }),
        ('Instructions', {
            'fields': ('instructions',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
