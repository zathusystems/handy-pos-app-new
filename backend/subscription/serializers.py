from rest_framework import serializers
from .models import (
    Subscription, Invoice, FeaturePricing, SubscriptionFeature, 
    UsageCharge, Deposit, DepositStatus, Refund
)

TRIAL_FEATURE_LOCK_MESSAGE = (
    'Features cannot be disabled while free trial credits are active. '
    'Added credits stay on your balance and you can remove features after the trial ends.'
)


class SubscriptionSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    is_active = serializers.SerializerMethodField()
    is_free_trial_active = serializers.SerializerMethodField()
    free_trial_days_remaining = serializers.SerializerMethodField()
    daily_charge = serializers.SerializerMethodField()
    monthly_charge = serializers.SerializerMethodField()
    currency_code = serializers.SerializerMethodField()
    low_balance = serializers.SerializerMethodField()
    days_until_insufficient_balance = serializers.SerializerMethodField()
    subscription_summary = serializers.SerializerMethodField()
    enabled_features = serializers.SerializerMethodField()

    class Meta:
        model = Subscription
        fields = [
            'id', 'business', 'status', 'status_display',
            'account_balance', 'total_spent', 'base_price_per_day',
            'daily_charge', 'monthly_charge', 'currency_code',
            'last_payment_date', 'last_billing_date', 'last_charge_date',
            'start_date',
            'free_trial_days', 'free_trial_credits_applied', 'free_trial_credits_amount', 'free_trial_end_date',
            'is_free_trial_active', 'free_trial_days_remaining',
            'low_balance_threshold', 'low_balance', 'low_balance_notified', 'low_balance_notified_date',
            'enable_usage_limits',
            # Core Features
            'enable_pos', 'enable_inventory',
            # Sales & Ordering
            'enable_invoicing', 'enable_online_menu', 'enable_online_ordering',
            # Kitchen & Operations
            'enable_kitchen', 'enable_expense_management',
            # Supplier & Purchases
            'enable_supplier_management', 'enable_purchases',
            # Alerts & Monitoring
            'enable_low_stock_alerts', 'enable_expiry_alerts',
            # Customer Management
            'enable_customer_management',
            # Reporting & Analytics
            'enable_reports', 'enable_analytics',
            # Take Orders
            'enable_take_orders',
            # Staff Management
            'enable_staff_management',
            # Inventory Management
            'enable_waste_management', 'enable_stock_transfers', 'enable_stock_audits',
            # Tax Management
            'enable_tax_management',
            # Multi-branch
            'enable_multi_branch',
            'days_until_insufficient_balance',
            'subscription_summary',
            'enabled_features',
            'is_active',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'total_spent', 'currency_code', 'last_charge_date']

    def get_is_active(self, obj):
        return obj.is_active()

    def get_is_free_trial_active(self, obj):
        return obj.is_free_trial_active()

    def get_free_trial_days_remaining(self, obj):
        return obj.get_free_trial_days_remaining()

    def get_daily_charge(self, obj):
        return float(obj.calculate_daily_charges())

    def get_monthly_charge(self, obj):
        return float(obj.calculate_monthly_charges())

    def get_currency_code(self, obj):
        return obj.get_currency_code()

    def get_low_balance(self, obj):
        return obj.account_balance < obj.low_balance_threshold

    def get_days_until_insufficient_balance(self, obj):
        daily_charge = obj.calculate_daily_charges()
        if daily_charge > 0:
            return int(obj.account_balance / daily_charge)
        return None

    def get_subscription_summary(self, obj):
        return obj.get_subscription_summary()

    def get_enabled_features(self, obj):
        features_by_key = {}

        for subscription_feature in obj.enabled_features.select_related('feature').all():
            feature = subscription_feature.feature
            included = (feature.price_per_day or 0) <= 0
            features_by_key[feature.feature] = {
                'id': subscription_feature.id,
                'feature': feature.feature,
                'feature_id': feature.id,
                'feature_name': feature.get_feature_display(),
                'enabled': True if included else subscription_feature.enabled,
                'included': included,
            }

        included_features = FeaturePricing.objects.filter(is_active=True, price_per_day__lte=0)
        for feature in included_features:
            features_by_key.setdefault(
                feature.feature,
                {
                    'id': None,
                    'feature': feature.feature,
                    'feature_id': feature.id,
                    'feature_name': feature.get_feature_display(),
                    'enabled': True,
                    'included': True,
                },
            )

        return list(features_by_key.values())


class SubscriptionUpdateSerializer(serializers.ModelSerializer):
    def validate(self, attrs):
        attrs = super().validate(attrs)
        subscription = self.instance
        if not subscription or not subscription.is_free_trial_active():
            return attrs

        disabled_fields = [
            field_name
            for field_name in Subscription.FEATURE_FLAG_FIELDS.values()
            if field_name in attrs and getattr(subscription, field_name, False) and attrs[field_name] is False
        ]
        if disabled_fields:
            raise serializers.ValidationError({'detail': TRIAL_FEATURE_LOCK_MESSAGE})

        return attrs

    class Meta:
        model = Subscription
        fields = [
            'status', 'base_price_per_day',
            'enable_pos', 'enable_inventory',
            'enable_invoicing', 'enable_online_menu', 'enable_online_ordering',
            'enable_kitchen', 'enable_expense_management',
            'enable_supplier_management', 'enable_purchases',
            'enable_low_stock_alerts', 'enable_expiry_alerts',
            'enable_customer_management',
            'enable_reports', 'enable_analytics',
            'enable_take_orders',
            'enable_staff_management',
            'enable_waste_management', 'enable_stock_transfers', 'enable_stock_audits',
            'enable_tax_management',
            'enable_multi_branch'
        ]


class InvoiceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Invoice
        fields = [
            'id', 'subscription', 'invoice_number', 'amount', 'status',
            'billing_period_start', 'billing_period_end',
            'issue_date', 'due_date', 'paid_date', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class DepositSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    payment_method_display = serializers.CharField(source='get_payment_method_display', read_only=True)
    bonus_credit_amount = serializers.SerializerMethodField()

    class Meta:
        model = Deposit
        fields = [
            'id', 'deposit_id', 'subscription', 'amount', 'credited_amount', 'bonus_credit_amount',
            'funding_period', 'status', 'status_display',
            'payment_method', 'payment_method_display',
            'transaction_id', 'stripe_payment_intent_id', 'payment_proof',
            'requested_date', 'completed_date', 'notes',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'deposit_id', 'created_at', 'updated_at', 'transaction_id',
            'stripe_payment_intent_id', 'completed_date'
        ]

    def get_bonus_credit_amount(self, obj):
        return obj.get_bonus_credit_amount()



class DepositCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating new deposits"""

    class Meta:
        model = Deposit
        fields = ['amount', 'payment_method', 'transaction_id', 'payment_proof', 'funding_period']
        extra_kwargs = {
            'transaction_id': {'required': True},
            'payment_proof': {'required': False, 'allow_blank': True},
            'funding_period': {'required': False, 'allow_blank': True},
        }

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Deposit amount must be greater than 0")
        if value > 100000:
            raise serializers.ValidationError("Deposit amount cannot exceed 100,000")
        return value

    def validate_transaction_id(self, value):
        transaction_id = str(value or '').strip()
        if not transaction_id:
            raise serializers.ValidationError("Transaction ID is required")
        if len(transaction_id) < 3:
            raise serializers.ValidationError("Transaction ID is too short")
        return transaction_id

    def validate(self, attrs):
        attrs = super().validate(attrs)

        subscription = self.context['subscription']
        funding_period = str(attrs.get('funding_period') or '').strip()

        from payments.pricing import validate_subscription_payment_amount

        pricing_validation = validate_subscription_payment_amount(
            subscription,
            attrs.get('amount'),
            funding_period=funding_period,
        )
        if not pricing_validation['is_valid']:
            raise serializers.ValidationError({'amount': pricing_validation['detail']})

        attrs['_pricing_validation'] = pricing_validation
        return attrs

    def create(self, validated_data):
        pricing_validation = validated_data.pop('_pricing_validation', None)
        subscription = self.context['subscription']
        transaction_id = validated_data.get('transaction_id')
        payment_proof = (validated_data.get('payment_proof') or '').strip()
        if not payment_proof:
            validated_data['payment_proof'] = transaction_id

        if pricing_validation and pricing_validation.get('quote'):
            quote = pricing_validation['quote']
            validated_data['funding_period'] = pricing_validation.get('funding_period') or ''
            validated_data['credited_amount'] = quote.get('credit_amount') or quote.get('base_amount')

        deposit = Deposit.objects.create(
            subscription=subscription,
            **validated_data
        )
        return deposit


class FeaturePricingSerializer(serializers.ModelSerializer):
    feature_display = serializers.CharField(source='get_feature_display', read_only=True)

    class Meta:
        model = FeaturePricing
        fields = [
            'id', 'feature', 'feature_display', 'price_per_day',
            'description', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class SubscriptionFeatureSerializer(serializers.ModelSerializer):
    feature_name = serializers.CharField(source='feature.get_feature_display', read_only=True)
    feature_price = serializers.DecimalField(
        source='feature.price_per_day', 
        max_digits=10, 
        decimal_places=2, 
        read_only=True
    )
    feature_description = serializers.CharField(
        source='feature.description',
        read_only=True,
        allow_blank=True
    )
    feature_id = serializers.IntegerField(source='feature.id', read_only=True)
    feature = serializers.IntegerField(write_only=True)

    class Meta:
        model = SubscriptionFeature
        fields = [
            'id', 'subscription', 'feature', 'feature_id', 'feature_name', 
            'feature_price', 'feature_description', 'enabled', 'enabled_date'
        ]
        read_only_fields = ['id', 'enabled_date', 'subscription', 'feature_id', 'feature_name', 'feature_price', 'feature_description']

    def validate(self, attrs):
        attrs = super().validate(attrs)
        subscription = self.context.get('subscription') or getattr(self.instance, 'subscription', None)
        if (
            subscription
            and subscription.is_free_trial_active()
            and 'enabled' in attrs
            and attrs['enabled'] is False
        ):
            raise serializers.ValidationError({'detail': TRIAL_FEATURE_LOCK_MESSAGE})
        return attrs

    def create(self, validated_data):
        subscription = self.context.get('subscription')
        if not subscription:
            raise serializers.ValidationError({'subscription': 'Subscription not found'})
        
        # Get feature ID from validated data
        feature_id = validated_data.get('feature')
        if not feature_id:
            raise serializers.ValidationError({'feature': 'Feature ID is required'})
        
        try:
            # Get FeaturePricing by ID (frontend sends FeaturePricing ID, not FeaturePricingConfig ID)
            feature_pricing = FeaturePricing.objects.get(id=feature_id)
            
            # Get enabled status from validated data, default to True
            enabled = validated_data.get('enabled', True)
            
            # Get or create subscription feature (handles duplicate attempts)
            sub_feature, created = SubscriptionFeature.objects.get_or_create(
                subscription=subscription,
                feature=feature_pricing,
                defaults={'enabled': enabled}
            )
            
            # If it already existed, update enabled status
            if not created:
                sub_feature.enabled = enabled
                sub_feature.save()
            
            print(f"[SUBSCRIPTION_FEATURE] Created/Updated feature {feature_id} for subscription {subscription.id}, enabled={enabled}")
            return sub_feature
        except FeaturePricing.DoesNotExist:
            print(f"[SUBSCRIPTION_FEATURE] Feature with ID {feature_id} not found")
            raise serializers.ValidationError({'feature': f'Feature with ID {feature_id} not found'})
        except Exception as e:
            print(f"[SUBSCRIPTION_FEATURE] Error creating subscription feature: {str(e)}")
            raise serializers.ValidationError({'detail': f'Error creating subscription feature: {str(e)}'})

    def update(self, instance, validated_data):
        # Don't allow updating subscription
        validated_data.pop('subscription', None)
        return super().update(instance, validated_data)


class UsageChargeSerializer(serializers.ModelSerializer):
    charge_type_display = serializers.CharField(source='get_charge_type_display', read_only=True)

    class Meta:
        model = UsageCharge
        fields = [
            'id', 'subscription', 'charge_type', 'charge_type_display',
            'description', 'amount', 'created_at'
        ]
        read_only_fields = ['id', 'created_at']


class RefundSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    refund_method_display = serializers.CharField(source='get_refund_method_display', read_only=True)
    currency_code = serializers.SerializerMethodField()

    class Meta:
        model = Refund
        fields = [
            'id', 'refund_id', 'subscription', 'deposit', 'amount', 'reason',
            'status', 'status_display', 'refund_method', 'refund_method_display',
            'requested_by', 'requested_date', 'approved_by', 'approved_date',
            'processed_date', 'notes', 'currency_code',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'refund_id', 'created_at', 'updated_at', 'requested_date',
            'approved_date', 'processed_date', 'currency_code'
        ]

    def get_currency_code(self, obj):
        return obj.subscription.get_currency_code()


class RefundCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating new refunds"""
    
    class Meta:
        model = Refund
        fields = ['amount', 'reason', 'refund_method', 'deposit']

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Refund amount must be greater than 0")
        if value > 100000:
            raise serializers.ValidationError("Refund amount cannot exceed 100,000")
        return value

    def create(self, validated_data):
        subscription = self.context['subscription']
        refund = Refund.objects.create(
            subscription=subscription,
            requested_by=self.context['request'].user.username,
            **validated_data
        )
        return refund
