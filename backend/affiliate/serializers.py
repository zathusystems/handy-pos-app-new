from rest_framework import serializers
from .models import Affiliate, BusinessReferral, RecurringCommission, AffiliatePayment, AffiliateSettings

class AffiliateSerializer(serializers.ModelSerializer):
    user_email = serializers.CharField(source='user.email', read_only=True)
    user_name = serializers.CharField(source='user.get_full_name', read_only=True)
    residence_location = serializers.SerializerMethodField()

    def get_residence_location(self, obj: Affiliate) -> str:
        region = (obj.residence_region or '').strip()
        district = (obj.residence_district or '').strip()
        area = (obj.residence_area or '').strip()
        if region and district and area:
            return f"{area}, {district}, {region}"
        return (obj.address or '').strip()

    class Meta:
        model = Affiliate
        fields = [
            'id', 'user', 'user_email', 'user_name', 'affiliate_code', 'status',
            'commission_rate', 'commission_type',
            'company_name', 'website', 'phone', 'address', 'profile_picture',
            'residence_region', 'residence_district', 'residence_area', 'residence_location',
            'bank_account', 'bank_name', 'account_holder', 'swift_code',
            'total_referred_businesses', 'total_active_referrals', 'total_commissions', 'total_paid',
            'joined_date', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'affiliate_code',
            'total_referred_businesses', 'total_active_referrals',
            'total_commissions', 'total_paid',
            'residence_location',
            'created_at', 'updated_at',
        ]


class BusinessReferralSerializer(serializers.ModelSerializer):
    affiliate_email = serializers.CharField(source='affiliate.user.email', read_only=True)
    business_name = serializers.CharField(source='business.name', read_only=True)

    class Meta:
        model = BusinessReferral
        fields = [
            'id', 'affiliate', 'affiliate_email', 'business', 'business_name', 'referral_code',
            'referral_link', 'status', 'created_at', 'activated_at', 'cancelled_at', 'updated_at'
        ]
        read_only_fields = ['id', 'referral_code', 'created_at', 'updated_at']


class RecurringCommissionSerializer(serializers.ModelSerializer):
    affiliate_email = serializers.CharField(source='affiliate.user.email', read_only=True)
    business_name = serializers.CharField(source='business_referral.business.name', read_only=True)
    subscription_plan = serializers.CharField(source='subscription.plan', read_only=True)

    class Meta:
        model = RecurringCommission
        fields = [
            'id', 'affiliate', 'affiliate_email', 'business_referral', 'business_name',
            'subscription', 'subscription_plan', 'amount', 'status', 'commission_type',
            'payment_method', 'transaction_id', 'billing_month',
            'earned_date', 'approved_date', 'paid_date', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class AffiliatePaymentSerializer(serializers.ModelSerializer):
    affiliate_email = serializers.CharField(source='affiliate.user.email', read_only=True)

    class Meta:
        model = AffiliatePayment
        fields = [
            'id', 'affiliate', 'affiliate_email', 'amount', 'status',
            'payment_method', 'transaction_id', 'notes',
            'requested_date', 'processed_date', 'completed_date', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class AffiliateSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = AffiliateSettings
        fields = [
            'id', 'enable_affiliate_program', 'whatsapp_group_link', 'default_commission_rate', 'default_commission_type',
            'referral_expiry_days', 'min_commission_for_payout',
            'commission_on_signup', 'commission_on_first_purchase', 'commission_on_subscription',
            'commission_on_monthly_recurring', 'auto_payout_enabled', 'auto_payout_day',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class AffiliateDashboardSerializer(serializers.Serializer):
    """Dashboard stats for affiliate"""
    total_referred_businesses = serializers.IntegerField()
    total_active_referrals = serializers.IntegerField()
    total_commissions = serializers.DecimalField(max_digits=12, decimal_places=2)
    total_paid = serializers.DecimalField(max_digits=12, decimal_places=2)
    pending_commissions = serializers.DecimalField(max_digits=12, decimal_places=2)
    available_for_payout = serializers.DecimalField(max_digits=12, decimal_places=2)
    active_referral_rate = serializers.FloatField()
    recent_referrals = BusinessReferralSerializer(many=True)
    recent_commissions = RecurringCommissionSerializer(many=True)
