from rest_framework import serializers
from .models import (
    SystemConfig, FeaturePricingConfig, PaymentGatewayConfig,
    PaymentMethodConfig, BankTransferConfig, MobileMoneyConfig
)


class SystemConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = SystemConfig
        fields = [
            'id', 'base_subscription_price_per_day', 'base_subscription_price_per_day_mwk',
            'base_subscription_price_per_day_usd', 'trial_days', 'default_currency',
            'malawi_currency_code', 'international_currency_code',
            'enable_feature_pricing', 'invoice_due_days', 'minimum_deposit_amount',
            'maximum_deposit_amount', 'low_balance_threshold_days', 'system_name',
            'system_email', 'system_phone',
            'maintenance_mode', 'maintenance_message',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class FeaturePricingConfigSerializer(serializers.ModelSerializer):
    feature_display = serializers.CharField(source='get_feature_display', read_only=True)

    class Meta:
        model = FeaturePricingConfig
        fields = [
            'id', 'feature', 'feature_display', 'default_price_per_day', 'description',
            'is_active', 'is_premium', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class PaymentGatewayConfigSerializer(serializers.ModelSerializer):
    gateway_display = serializers.CharField(source='get_gateway_display', read_only=True)

    class Meta:
        model = PaymentGatewayConfig
        fields = [
            'id', 'gateway', 'gateway_display', 'is_enabled', 'transaction_fee_percentage',
            'minimum_transaction_amount', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'api_key', 'api_secret', 'webhook_url', 'webhook_secret', 'created_at', 'updated_at']


class PaymentMethodConfigSerializer(serializers.ModelSerializer):
    currency_display = serializers.CharField(source='get_currency_display', read_only=True)
    payment_method_display = serializers.CharField(source='get_payment_method_display', read_only=True)

    class Meta:
        model = PaymentMethodConfig
        fields = [
            'id', 'currency', 'currency_display', 'payment_method', 'payment_method_display',
            'is_enabled', 'display_order', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class BankTransferConfigSerializer(serializers.ModelSerializer):
    currency_display = serializers.CharField(source='get_currency_display', read_only=True)

    class Meta:
        model = BankTransferConfig
        fields = [
            'id', 'currency', 'currency_display', 'account_holder', 'bank_name',
            'account_number', 'routing_number', 'swift_code', 'iban', 'instructions',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class MobileMoneyConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = MobileMoneyConfig
        fields = [
            'id', 'provider', 'is_enabled', 'account_number', 'account_name',
            'instructions', 'display_order', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
