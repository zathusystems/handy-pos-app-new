from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .models import (
    PaymentGatewayConfiguration,
    PaymentWebhookEvent,
    SubscriptionPaymentAttempt,
)
from .validators import validate_redirect_url


def mask_secret(value):
    secret = str(value or '').strip()
    if not secret:
        return ''
    if len(secret) <= 4:
        return '*' * len(secret)
    return f"{'*' * 8}{secret[-4:]}"


class PaymentGatewayConfigurationAdminSerializer(serializers.ModelSerializer):
    is_ready = serializers.BooleanField(read_only=True)
    has_secret_key = serializers.SerializerMethodField()
    has_webhook_secret = serializers.SerializerMethodField()
    secret_key_masked = serializers.SerializerMethodField()
    webhook_secret_masked = serializers.SerializerMethodField()

    class Meta:
        model = PaymentGatewayConfiguration
        fields = [
            'id',
            'provider',
            'display_name',
            'is_active',
            'environment',
            'checkout_flow',
            'public_key',
            'has_secret_key',
            'has_webhook_secret',
            'secret_key_masked',
            'webhook_secret_masked',
            'checkout_init_url',
            'verify_url_template',
            'callback_url',
            'return_url',
            'default_currency',
            'payment_title',
            'payment_description',
            'metadata',
            'is_ready',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'is_ready']

    def get_has_secret_key(self, obj):
        return bool(obj.secret_key)

    def get_has_webhook_secret(self, obj):
        return bool(obj.webhook_secret)

    def get_secret_key_masked(self, obj):
        return mask_secret(obj.secret_key)

    def get_webhook_secret_masked(self, obj):
        return mask_secret(obj.webhook_secret)


class PaymentGatewayConfigurationSerializer(serializers.ModelSerializer):
    secret_key = serializers.CharField(required=False, allow_blank=True, write_only=True)
    webhook_secret = serializers.CharField(required=False, allow_blank=True, write_only=True)
    callback_url = serializers.CharField(required=False, allow_blank=True)
    return_url = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = PaymentGatewayConfiguration
        fields = [
            'provider',
            'display_name',
            'is_active',
            'environment',
            'checkout_flow',
            'public_key',
            'secret_key',
            'webhook_secret',
            'checkout_init_url',
            'verify_url_template',
            'callback_url',
            'return_url',
            'default_currency',
            'payment_title',
            'payment_description',
            'metadata',
        ]

    def validate_default_currency(self, value):
        return str(value or '').upper()

    def _validate_redirect_url(self, value, field_name):
        try:
            return validate_redirect_url(value, field_name=field_name)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(str(exc))

    def validate_callback_url(self, value):
        return self._validate_redirect_url(value, 'callback_url')

    def validate_return_url(self, value):
        return self._validate_redirect_url(value, 'return_url')

    def update(self, instance, validated_data):
        secret_key = validated_data.pop('secret_key', None)
        webhook_secret = validated_data.pop('webhook_secret', None)

        for attribute, value in validated_data.items():
            setattr(instance, attribute, value)

        if secret_key is not None and str(secret_key).strip():
            instance.secret_key = str(secret_key).strip()
        if webhook_secret is not None and str(webhook_secret).strip():
            instance.webhook_secret = str(webhook_secret).strip()

        instance.save()
        return instance


class PaymentGatewayConfigurationPublicSerializer(serializers.ModelSerializer):
    is_ready = serializers.BooleanField(read_only=True)

    class Meta:
        model = PaymentGatewayConfiguration
        fields = [
            'provider',
            'display_name',
            'is_active',
            'environment',
            'checkout_flow',
            'default_currency',
            'payment_title',
            'payment_description',
            'is_ready',
        ]


class SubscriptionPaymentAttemptSerializer(serializers.ModelSerializer):
    deposit_reference = serializers.CharField(source='deposit.deposit_id', read_only=True)
    deposit_status = serializers.CharField(source='deposit.status', read_only=True)
    subscription = serializers.IntegerField(source='deposit.subscription_id', read_only=True)
    business = serializers.IntegerField(source='deposit.subscription.business_id', read_only=True)
    credited_amount = serializers.DecimalField(
        source='deposit.credited_amount',
        max_digits=10,
        decimal_places=2,
        read_only=True,
        allow_null=True,
    )
    funding_period = serializers.CharField(source='deposit.funding_period', read_only=True)

    class Meta:
        model = SubscriptionPaymentAttempt
        fields = [
            'id',
            'provider',
            'deposit',
            'deposit_reference',
            'subscription',
            'business',
            'tx_ref',
            'checkout_url',
            'amount',
            'credited_amount',
            'currency',
            'funding_period',
            'status',
            'provider_reference',
            'callback_status',
            'last_error',
            'paid_at',
            'verified_at',
            'deposit_status',
            'created_at',
            'updated_at',
        ]
        read_only_fields = fields


class PaymentWebhookEventSerializer(serializers.ModelSerializer):
    related_tx_ref = serializers.CharField(source='related_attempt.tx_ref', read_only=True)
    deposit_reference = serializers.CharField(source='related_attempt.deposit.deposit_id', read_only=True)

    class Meta:
        model = PaymentWebhookEvent
        fields = [
            'id',
            'provider',
            'related_attempt',
            'related_tx_ref',
            'deposit_reference',
            'event_type',
            'tx_ref',
            'is_valid_signature',
            'processed',
            'processing_notes',
            'processed_at',
            'created_at',
        ]
        read_only_fields = fields
