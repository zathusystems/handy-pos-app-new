from django.db import models
from django.contrib.auth import get_user_model
from business.models import Business
from subscription.models import Subscription
from django.utils import timezone
import uuid

User = get_user_model()

class AffiliateStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    ACTIVE = 'active', 'Active'
    SUSPENDED = 'suspended', 'Suspended'
    INACTIVE = 'inactive', 'Inactive'

class CommissionStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    APPROVED = 'approved', 'Approved'
    PAID = 'paid', 'Paid'
    REJECTED = 'rejected', 'Rejected'

class Affiliate(models.Model):
    """Agent/Affiliate who refers businesses"""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='affiliate_profile')
    affiliate_code = models.CharField(max_length=50, unique=True)
    status = models.CharField(max_length=20, choices=AffiliateStatus.choices, default=AffiliateStatus.PENDING)
    
    # Commission settings
    commission_rate = models.DecimalField(max_digits=5, decimal_places=2, default=10.00)  # Percentage
    commission_type = models.CharField(max_length=20, choices=[
        ('percentage', 'Percentage'),
        ('fixed', 'Fixed Amount'),
    ], default='percentage')
    
    # Profile info
    company_name = models.CharField(max_length=255, blank=True, null=True)
    website = models.URLField(blank=True, null=True)
    phone = models.CharField(max_length=32, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    profile_picture = models.ImageField(upload_to='affiliate_profile_pictures/', blank=True, null=True)
    residence_region = models.CharField(max_length=100, blank=True, default='')
    residence_district = models.CharField(max_length=100, blank=True, default='')
    residence_area = models.CharField(max_length=120, blank=True, default='')
    
    # Payment info
    bank_account = models.CharField(max_length=255, blank=True, null=True)
    bank_name = models.CharField(max_length=255, blank=True, null=True)
    account_holder = models.CharField(max_length=255, blank=True, null=True)
    swift_code = models.CharField(max_length=20, blank=True, null=True)
    
    # Stats
    total_referred_businesses = models.IntegerField(default=0)
    total_active_referrals = models.IntegerField(default=0)
    total_commissions = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    total_paid = models.DecimalField(max_digits=12, decimal_places=2, default=0.00)
    
    # Dates
    joined_date = models.DateTimeField(auto_now_add=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-joined_date']

    def __str__(self):
        return f"{self.user.email} - {self.affiliate_code}"

    def save(self, *args, **kwargs):
        if not self.affiliate_code:
            self.affiliate_code = str(uuid.uuid4())[:8].upper()
        super().save(*args, **kwargs)


class BusinessReferral(models.Model):
    """Business referred by an affiliate/agent"""
    affiliate = models.ForeignKey(Affiliate, on_delete=models.CASCADE, related_name='business_referrals')
    business = models.OneToOneField(Business, on_delete=models.CASCADE, related_name='referral')
    
    referral_code = models.CharField(max_length=50, unique=True)
    referral_link = models.URLField(blank=True)
    
    # Status
    status = models.CharField(max_length=20, choices=[
        ('pending', 'Pending'),
        ('active', 'Active'),
        ('cancelled', 'Cancelled'),
    ], default='pending')
    
    # Dates
    created_at = models.DateTimeField(auto_now_add=True)
    activated_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.affiliate.user.email} -> {self.business.name}"


class RecurringCommission(models.Model):
    """Monthly recurring commission for active business referrals"""
    affiliate = models.ForeignKey(Affiliate, on_delete=models.CASCADE, related_name='recurring_commissions')
    business_referral = models.ForeignKey(BusinessReferral, on_delete=models.CASCADE, related_name='commissions')
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='affiliate_commissions')
    
    # Commission details
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=20, choices=CommissionStatus.choices, default=CommissionStatus.PENDING)
    
    # Commission rate used for calculation (snapshot at time of creation)
    commission_rate = models.DecimalField(max_digits=5, null=True, blank=True, decimal_places=2, help_text="Commission rate used for this calculation")
    commission_rate_type = models.CharField(max_length=20, null=True, blank=True, choices=[
        ('percentage', 'Percentage'),
        ('fixed', 'Fixed Amount'),
    ], help_text="Type of commission rate (percentage or fixed)")
    
    # Commission type
    commission_type = models.CharField(max_length=50, choices=[
        ('signup_bonus', 'Sign Up Bonus'),
        ('first_month', 'First Month'),
        ('monthly_recurring', 'Monthly Recurring'),
    ], default='monthly_recurring')
    
    # Payment info
    payment_method = models.CharField(max_length=50, blank=True)
    transaction_id = models.CharField(max_length=255, blank=True)
    
    # Billing period
    billing_month = models.DateField()  # First day of the month for which commission is earned
    
    # Dates
    earned_date = models.DateTimeField(auto_now_add=True)
    approved_date = models.DateTimeField(null=True, blank=True)
    paid_date = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-earned_date']
        unique_together = ('business_referral', 'billing_month')

    def __str__(self):
        return f"{self.affiliate.user.email} - {self.business_referral.business.name} - ${self.amount} ({self.status})"


class AffiliatePayment(models.Model):
    affiliate = models.ForeignKey(Affiliate, on_delete=models.CASCADE, related_name='payments')
    
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=20, choices=[
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ], default='pending')
    
    # Payment details
    payment_method = models.CharField(max_length=50)
    transaction_id = models.CharField(max_length=255, blank=True)
    notes = models.TextField(blank=True)
    
    # Dates
    requested_date = models.DateTimeField(auto_now_add=True)
    processed_date = models.DateTimeField(null=True, blank=True)
    completed_date = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-requested_date']

    def __str__(self):
        return f"{self.affiliate.user.email} - ${self.amount} ({self.status})"


class AffiliateSettings(models.Model):
    # Global affiliate settings
    enable_affiliate_program = models.BooleanField(default=True)
    whatsapp_group_link = models.URLField(blank=True)
    default_commission_rate = models.DecimalField(max_digits=5, decimal_places=2, default=10.00)
    default_commission_type = models.CharField(max_length=20, choices=[
        ('percentage', 'Percentage'),
        ('fixed', 'Fixed Amount'),
    ], default='percentage')
    
    # Referral settings
    referral_expiry_days = models.IntegerField(default=30)
    min_commission_for_payout = models.DecimalField(max_digits=12, decimal_places=2, default=50.00)
    
    # Commission triggers
    commission_on_signup = models.BooleanField(default=True)
    commission_on_first_purchase = models.BooleanField(default=True)
    commission_on_subscription = models.BooleanField(default=True)
    commission_on_monthly_recurring = models.BooleanField(default=False)
    
    # Payout settings
    auto_payout_enabled = models.BooleanField(default=False)
    auto_payout_day = models.IntegerField(default=1)  # Day of month
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = 'Affiliate Settings'

    @classmethod
    def get_current(cls):
        """
        Return the active global settings row.
        If multiple rows exist, prefer the most recently updated one.
        """
        settings = cls.objects.order_by('-updated_at', '-id').first()
        if settings:
            return settings
        return cls.objects.create()

    def __str__(self):
        return 'Affiliate Program Settings'
