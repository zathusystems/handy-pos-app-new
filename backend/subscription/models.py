from decimal import Decimal

from django.db import models, transaction
from django.db.models import F
from django.contrib.auth import get_user_model
from business.models import Business
from django.utils import timezone
from datetime import timedelta, date
from system_config.models import SystemConfig
import logging

User = get_user_model()
logger = logging.getLogger(__name__)


def get_default_free_trial_days():
    """
    Resolve the current default free-trial duration from SystemConfig.
    Falls back to the system default when config lookup is unavailable.
    """
    try:
        return int(getattr(SystemConfig.get_config(), 'trial_days', 14) or 0)
    except Exception:
        return 14

class SubscriptionStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    PAUSED = 'paused', 'Paused'
    CANCELLED = 'cancelled', 'Cancelled'

class Subscription(models.Model):
    """
    Pay-as-you-go subscription model.
    Users pay based on actual usage (transactions, features used, etc.)
    """
    business = models.OneToOneField(Business, on_delete=models.CASCADE, related_name='subscription')
    status = models.CharField(max_length=20, choices=SubscriptionStatus.choices, default=SubscriptionStatus.ACTIVE)
    
    # Account balance and credits
    account_balance = models.DecimalField(max_digits=10, decimal_places=2, default=0.00, help_text="Current account balance/credits")
    total_spent = models.DecimalField(max_digits=10, decimal_places=2, default=0.00, help_text="Total amount spent")
    
    # Pricing (persisted snapshot; default pulled from SystemConfig)
    base_price_per_day = models.DecimalField(max_digits=10, decimal_places=2, default=5.00, help_text="Base daily subscription price")
    
    # Payment info
    stripe_customer_id = models.CharField(max_length=255, blank=True)
    
    # Subscription dates
    start_date = models.DateTimeField(auto_now_add=True)
    last_payment_date = models.DateTimeField(null=True, blank=True)
    last_billing_date = models.DateTimeField(null=True, blank=True)
    last_charge_date = models.DateTimeField(null=True, blank=True, help_text="Last date daily charges were applied")
    
    # Free trial/credits for first-time subscribers
    free_trial_days = models.IntegerField(
        default=get_default_free_trial_days,
        help_text="Number of days of free trial credits",
    )
    free_trial_credits_applied = models.BooleanField(default=False, help_text="Whether free trial credits have been applied")
    free_trial_credits_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0.00, help_text="Amount of free trial credits given")
    free_trial_end_date = models.DateTimeField(null=True, blank=True, help_text="Date when free trial credits expire")
    
    # Usage limits per feature
    enable_usage_limits = models.BooleanField(default=True, help_text="Enable usage limits for features")
    
    # Low balance threshold for notifications
    low_balance_threshold = models.DecimalField(max_digits=10, decimal_places=2, default=10.00, help_text="Alert when balance falls below this")
    low_balance_notified = models.BooleanField(default=False, help_text="Whether low balance notification has been sent")
    low_balance_notified_date = models.DateTimeField(null=True, blank=True, help_text="When low balance notification was sent")
    
    # All features enabled by default for pay-as-you-go
    enable_pos = models.BooleanField(default=True)
    enable_inventory = models.BooleanField(default=True)
    enable_invoicing = models.BooleanField(default=True)
    enable_online_menu = models.BooleanField(default=True)
    enable_online_ordering = models.BooleanField(default=True)
    enable_kitchen = models.BooleanField(default=True)
    enable_expense_management = models.BooleanField(default=True)
    enable_supplier_management = models.BooleanField(default=True)
    enable_purchases = models.BooleanField(default=True)
    enable_low_stock_alerts = models.BooleanField(default=True)
    enable_expiry_alerts = models.BooleanField(default=True)
    enable_customer_management = models.BooleanField(default=True)
    enable_reports = models.BooleanField(default=True)
    enable_analytics = models.BooleanField(default=True)
    enable_take_orders = models.BooleanField(default=True)
    enable_staff_management = models.BooleanField(default=True)
    enable_waste_management = models.BooleanField(default=True)
    enable_stock_transfers = models.BooleanField(default=True)
    enable_stock_audits = models.BooleanField(default=True)
    enable_tax_management = models.BooleanField(default=True)
    enable_multi_branch = models.BooleanField(default=True, help_text="Allow managing multiple branches")
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.business.name} - Pay-as-you-go ({self.status})"

    FEATURE_FLAG_FIELDS = {
        'pos': 'enable_pos',
        'inventory': 'enable_inventory',
        'invoicing': 'enable_invoicing',
        'online_menu': 'enable_online_menu',
        'online_ordering': 'enable_online_ordering',
        'kitchen': 'enable_kitchen',
        'expense_management': 'enable_expense_management',
        'supplier_management': 'enable_supplier_management',
        'purchases': 'enable_purchases',
        'low_stock_alerts': 'enable_low_stock_alerts',
        'expiry_alerts': 'enable_expiry_alerts',
        'customer_management': 'enable_customer_management',
        'reports': 'enable_reports',
        'analytics': 'enable_analytics',
        'take_orders': 'enable_take_orders',
        'staff_management': 'enable_staff_management',
        'waste_management': 'enable_waste_management',
        'stock_transfers': 'enable_stock_transfers',
        'stock_audits': 'enable_stock_audits',
        'tax_management': 'enable_tax_management',
        'multi_branch': 'enable_multi_branch',
    }

    def is_active(self):
        """Check if subscription is active"""
        return self.status == SubscriptionStatus.ACTIVE

    def add_charge(self, amount, description=""):
        """Add a charge to the subscription"""
        if self.is_active():
            self.total_spent += amount
            self.save()
            return True
        return False

    def add_credit(self, amount):
        """Add credit to account balance"""
        self.account_balance += amount
        self.last_payment_date = timezone.now()
        self.save(update_fields=['account_balance', 'last_payment_date', 'updated_at'])

    def maybe_auto_resume(self):
        """
        Resume a paused subscription when the available balance can cover
        the next daily charge. Paused time is not billed retroactively.
        """
        if self.status != SubscriptionStatus.PAUSED:
            return False

        daily_charge = self.calculate_daily_charges()
        if daily_charge > 0 and self.account_balance < daily_charge:
            return False

        self.status = SubscriptionStatus.ACTIVE
        self.last_charge_date = timezone.now()
        return True

    def get_currency_code(self):
        """Return configured currency code for this business (MWK for Malawi, USD otherwise)."""
        config = SystemConfig.get_config()
        # Check business-level country first
        biz_country = (getattr(self.business, 'country', '') or '').strip().lower()
        if biz_country in {'malawi', 'mw', 'mwi'} or 'malawi' in biz_country:
            return config.malawi_currency_code
        # Fallback to branches
        for br in self.business.branches.all():
            country = (br.country or '').strip().lower()
            if country in {'malawi', 'mw', 'mwi'} or 'malawi' in country:
                return config.malawi_currency_code
        return config.international_currency_code

    def deduct_credit(self, amount):
        """Deduct credit from account balance atomically."""
        if amount is None or amount <= 0:
            return False

        updated = Subscription.objects.filter(
            pk=self.pk,
            account_balance__gte=amount,
        ).update(
            account_balance=F('account_balance') - amount,
            updated_at=timezone.now(),
        )

        if not updated:
            return False

        self.refresh_from_db(fields=['account_balance', 'updated_at'])
        return True

    def is_free_trial_active(self):
        """Check if free trial credits are still valid"""
        if not self.free_trial_credits_applied or not self.free_trial_end_date:
            return False
        return timezone.now() <= self.free_trial_end_date

    def get_free_trial_days_remaining(self):
        """Get number of days remaining in free trial"""
        if not self.is_free_trial_active():
            return 0
        
        days_remaining = (self.free_trial_end_date - timezone.now()).days
        return max(0, days_remaining)

    def expire_free_trial(self):
        """Manually expire the free trial credits"""
        if self.free_trial_credits_applied:
            self.account_balance = 0
            self.free_trial_end_date = timezone.now()
            self.save()
            return True
        return False

    def calculate_daily_charges(self):
        """Calculate total daily charges (base + enabled features) with MWK/USD-specific pricing from SystemConfig"""
        config = SystemConfig.get_config()
        currency = self.get_currency_code()
        # Always use currency-specific system config base prices
        base_price = (
            config.base_subscription_price_per_day_mwk
            if currency == config.malawi_currency_code
            else config.base_subscription_price_per_day_usd
        )
        daily_charge = base_price
        
        if config.enable_feature_pricing:
            # Canonical path: SubscriptionFeature rows.
            enabled_features = list(
                self.enabled_features.filter(enabled=True).select_related('feature')
            )
            if enabled_features:
                for sub_feature in enabled_features:
                    feature_price = sub_feature.feature.price_per_day
                    if feature_price is None or feature_price == 0:
                        feature_price = 0
                    daily_charge += feature_price
            else:
                # Backward-compatible fallback for older subscriptions without SubscriptionFeature rows.
                feature_pricings = FeaturePricing.objects.filter(is_active=True)
                for feature_pricing in feature_pricings:
                    flag_field = self.FEATURE_FLAG_FIELDS.get(feature_pricing.feature)
                    if flag_field and getattr(self, flag_field, False):
                        daily_charge += feature_pricing.price_per_day or 0
        
        return daily_charge

    def calculate_monthly_charges(self, days=30):
        """Calculate total charges for a month"""
        daily_charge = self.calculate_daily_charges()
        return daily_charge * days

    def apply_daily_charges(self):
        """Apply daily charges to subscription account."""
        with transaction.atomic():
            subscription = Subscription.objects.select_for_update().select_related('business').get(pk=self.pk)

            today = timezone.now().date()
            if subscription.last_charge_date and subscription.last_charge_date.date() == today:
                logger.info(f"[SUBSCRIPTION] {subscription.business.name}: Already charged today")
                return False, "Already charged today"

            if not subscription.is_active():
                logger.warning(
                    f"[SUBSCRIPTION] {subscription.business.name}: "
                    f"Subscription is not active (status: {subscription.status})"
                )
                return False, "Subscription is not active"

            daily_charge = subscription.calculate_daily_charges()
            logger.info(f"[SUBSCRIPTION] {subscription.business.name}: Calculated daily charge: {daily_charge}")

            config = SystemConfig.get_config()
            currency = subscription.get_currency_code()
            base_price = (
                config.base_subscription_price_per_day_mwk
                if currency == config.malawi_currency_code
                else config.base_subscription_price_per_day_usd
            )
            logger.info(f"[SUBSCRIPTION] {subscription.business.name}: Base price: {base_price}, Currency: {currency}")

            if subscription.account_balance < daily_charge:
                logger.warning(
                    f"[SUBSCRIPTION] {subscription.business.name}: Insufficient balance. "
                    f"Current: {subscription.account_balance}, Required: {daily_charge}"
                )
                subscription.status = SubscriptionStatus.PAUSED
                subscription.last_charge_date = timezone.now()
                subscription.save(update_fields=['status', 'last_charge_date', 'updated_at'])
                self.status = subscription.status
                self.account_balance = subscription.account_balance
                self.last_charge_date = subscription.last_charge_date
                logger.warning(f"[SUBSCRIPTION] {subscription.business.name}: Subscription paused due to insufficient balance")
                return False, (
                    f"Insufficient balance. Subscription paused. "
                    f"Balance: {subscription.account_balance}, Charge: {daily_charge}"
                )

            charge_time = timezone.now()
            subscription.account_balance -= daily_charge
            subscription.total_spent += daily_charge
            subscription.last_charge_date = charge_time
            subscription.save(update_fields=['account_balance', 'total_spent', 'last_charge_date', 'updated_at'])

            usage_charge = UsageCharge.objects.create(
                subscription=subscription,
                charge_type='base_daily',
                description=f'Daily subscription charge (Base: {base_price} + Features)',
                amount=daily_charge,
            )
            logger.info(f"[SUBSCRIPTION] {subscription.business.name}: UsageCharge record created (ID: {usage_charge.id})")

            self.account_balance = subscription.account_balance
            self.total_spent = subscription.total_spent
            self.last_charge_date = subscription.last_charge_date
            self.status = subscription.status

            logger.info(
                f"[SUBSCRIPTION] {subscription.business.name}: Daily charge applied successfully. "
                f"New balance: {subscription.account_balance}, Total spent: {subscription.total_spent}"
            )
            return True, f"Daily charge of {daily_charge} applied successfully"

    def get_pending_daily_charge_days(self, as_of_date: date | None = None) -> int:
        """
        Return how many daily charges are pending.

        Billing rule:
        - If `last_charge_date` exists, charge for each whole calendar day since that date.
        - If never charged, start counting from `start_date` day boundary.
        """
        effective_today = as_of_date or timezone.localdate()

        if self.last_charge_date:
            last_charged_day = timezone.localtime(self.last_charge_date).date()
        else:
            # `start_date` uses auto_now_add and should always be set, but keep a safe fallback.
            start_reference = self.start_date or self.created_at or timezone.now()
            last_charged_day = timezone.localtime(start_reference).date()

        pending_days = (effective_today - last_charged_day).days
        return max(0, pending_days)

    def apply_pending_daily_charges(self, as_of_date: date | None = None):
        """
        Apply all missed daily charges up to today in one atomic operation.

        Returns:
            (success: bool, message: str, charged_days: int, charged_amount: Decimal)
        """
        with transaction.atomic():
            subscription = Subscription.objects.select_for_update().select_related('business').get(pk=self.pk)

            if not subscription.is_active():
                logger.warning(
                    f"[SUBSCRIPTION] {subscription.business.name}: "
                    f"Skipped catch-up (status: {subscription.status})"
                )
                return False, "Subscription is not active", 0, 0

            pending_days = subscription.get_pending_daily_charge_days(as_of_date=as_of_date)
            if pending_days <= 0:
                logger.info(f"[SUBSCRIPTION] {subscription.business.name}: No pending daily charges")
                return False, "No pending daily charges", 0, 0

            daily_charge = subscription.calculate_daily_charges()
            if daily_charge <= 0:
                logger.warning(
                    f"[SUBSCRIPTION] {subscription.business.name}: "
                    "Daily charge is zero, skipping catch-up"
                )
                return False, "Daily charge is zero", 0, 0

            charged_days = 0
            charged_amount = 0
            for _ in range(pending_days):
                if subscription.account_balance < daily_charge:
                    pause_time = timezone.now()
                    subscription.status = SubscriptionStatus.PAUSED
                    # Once access is paused, do not retry the same historical
                    # days after a later top-up.
                    subscription.last_charge_date = pause_time
                    subscription.save(
                        update_fields=[
                            'status',
                            'account_balance',
                            'total_spent',
                            'last_charge_date',
                            'updated_at',
                        ]
                    )
                    if charged_days > 0:
                        UsageCharge.objects.create(
                            subscription=subscription,
                            charge_type='base_daily',
                            description=f'Catch-up daily subscription charge for {charged_days} day(s)',
                            amount=charged_amount,
                        )
                    self.status = subscription.status
                    self.account_balance = subscription.account_balance
                    self.total_spent = subscription.total_spent
                    self.last_charge_date = subscription.last_charge_date
                    logger.warning(
                        f"[SUBSCRIPTION] {subscription.business.name}: "
                        f"Paused during catch-up due to insufficient balance after {charged_days} day(s)"
                    )
                    if charged_days > 0:
                        return (
                            True,
                            f"Applied {charged_days} day(s) then paused for insufficient balance",
                            charged_days,
                            charged_amount,
                        )
                    return False, "Insufficient balance. Subscription paused.", 0, 0

                subscription.account_balance -= daily_charge
                subscription.total_spent += daily_charge
                charged_days += 1
                charged_amount += daily_charge

            charge_time = timezone.now()
            subscription.last_charge_date = charge_time
            subscription.save(update_fields=['account_balance', 'total_spent', 'last_charge_date', 'updated_at'])

            UsageCharge.objects.create(
                subscription=subscription,
                charge_type='base_daily',
                description=f'Catch-up daily subscription charge for {charged_days} day(s)',
                amount=charged_amount,
            )

            self.account_balance = subscription.account_balance
            self.total_spent = subscription.total_spent
            self.last_charge_date = subscription.last_charge_date
            self.status = subscription.status

            logger.info(
                f"[SUBSCRIPTION] {subscription.business.name}: "
                f"Catch-up daily charges applied ({charged_days} day(s), amount: {charged_amount})"
            )
            return True, f"Applied {charged_days} day(s) of pending charges", charged_days, charged_amount

    def check_low_balance(self):
        """Check if balance is low and send notification if needed"""
        if self.account_balance < self.low_balance_threshold:
            if not self.low_balance_notified or (self.low_balance_notified_date and 
                (timezone.now() - self.low_balance_notified_date).days >= 7):
                # Send notification (implement email/notification logic)
                self.low_balance_notified = True
                self.low_balance_notified_date = timezone.now()
                self.save()
                return True, f"Low balance notification sent. Current balance: {self.account_balance}"
        else:
            # Reset notification flag if balance is above threshold
            if self.low_balance_notified:
                self.low_balance_notified = False
                self.save()
        
        return False, "Balance is sufficient"

    def check_trial_expiry(self):
        """Check if free trial has expired and take action"""
        if self.is_free_trial_active():
            return False, "Free trial is still active"
        
        if self.free_trial_credits_applied and not self.is_free_trial_active():
            # Trial has expired
            if self.account_balance <= 0:
                # No balance left - pause subscription
                self.status = SubscriptionStatus.PAUSED
                self.save()
                return True, "Free trial expired and balance is zero. Subscription paused."
            else:
                return True, "Free trial expired. Using paid credits."
        
        return False, "No active trial"

    def can_use_feature(self, feature_name):
        """Check if a feature is enabled via SubscriptionFeature and usage limits not exceeded"""
        normalized_feature_name = feature_name.replace('enable_', '', 1) if feature_name.startswith('enable_') else feature_name

        # Check if subscription is active
        if not self.is_active():
            return False, "Subscription is not active"
        
        # Check if feature is enabled via SubscriptionFeature, fallback to legacy enable_* flags.
        try:
            feature_pricing = FeaturePricing.objects.get(feature=normalized_feature_name)
            subscription_feature = SubscriptionFeature.objects.filter(
                subscription=self,
                feature=feature_pricing,
                enabled=True
            ).exists()
            
            if not subscription_feature:
                legacy_flag_field = self.FEATURE_FLAG_FIELDS.get(normalized_feature_name)
                if legacy_flag_field:
                    subscription_feature = bool(getattr(self, legacy_flag_field, False))

            if not subscription_feature:
                return False, f"Feature {normalized_feature_name} is not enabled"
        except FeaturePricing.DoesNotExist:
            return False, f"Feature {normalized_feature_name} not found"
        
        # Check if balance is sufficient for next charge
        daily_charge = self.calculate_daily_charges()
        if self.account_balance < daily_charge:
            return False, "Insufficient balance for feature usage"
        
        return True, "Feature is available"

    def deactivate_non_owner_staff(self):
        """
        Disable all non-owner staff accounts for this business.
        Records are preserved so they can be reactivated later if the feature
        is enabled again.
        """
        try:
            from staff.models import Staff
        except Exception:
            return 0

        timestamp = timezone.now()
        staff_queryset = Staff.objects.filter(
            business=self.business,
            is_active=True,
        ).exclude(user_id=self.business.owner_id)

        user_ids = list(
            staff_queryset.exclude(user_id__isnull=True).values_list('user_id', flat=True)
        )
        deactivated_count = staff_queryset.update(
            is_active=False,
            disabled_by_feature='staff_management',
            disabled_by_feature_at=timestamp,
            updated_at=timestamp,
        )

        if user_ids:
            User.objects.filter(
                id__in=user_ids,
                is_active=True,
            ).update(is_active=False)

        return deactivated_count

    def reactivate_staff_disabled_by_feature(self, feature_name):
        """
        Reactivate staff previously auto-disabled when a feature was removed.
        Only staff explicitly marked with the matching feature name are restored.
        """
        try:
            from staff.models import Staff
        except Exception:
            return 0

        timestamp = timezone.now()
        staff_queryset = Staff.objects.filter(
            business=self.business,
            is_active=False,
            disabled_by_feature=feature_name,
        ).exclude(user_id=self.business.owner_id)

        user_ids = list(
            staff_queryset.exclude(user_id__isnull=True).values_list('user_id', flat=True)
        )
        reactivated_count = staff_queryset.update(
            is_active=True,
            disabled_by_feature='',
            disabled_by_feature_at=None,
            updated_at=timestamp,
        )

        if user_ids:
            User.objects.filter(
                id__in=user_ids,
                is_active=False,
            ).update(is_active=True)

        return reactivated_count

    def handle_disabled_feature_side_effects(self, feature_name):
        normalized_feature_name = (
            feature_name.replace('enable_', '', 1)
            if feature_name.startswith('enable_')
            else feature_name
        )

        if normalized_feature_name == 'staff_management':
            return self.deactivate_non_owner_staff()

        return 0

    def handle_enabled_feature_side_effects(self, feature_name):
        normalized_feature_name = (
            feature_name.replace('enable_', '', 1)
            if feature_name.startswith('enable_')
            else feature_name
        )

        if normalized_feature_name == 'staff_management':
            return self.reactivate_staff_disabled_by_feature(normalized_feature_name)

        return 0

    def sync_feature_assignments_from_flags(self):
        """
        Keep SubscriptionFeature rows aligned with legacy enable_* flags.
        This preserves compatibility between old feature-flag checks and feature-based billing.
        """
        feature_pricings = FeaturePricing.objects.filter(feature__in=self.FEATURE_FLAG_FIELDS.keys())
        feature_map = {fp.feature: fp for fp in feature_pricings}

        for feature_name, flag_field in self.FEATURE_FLAG_FIELDS.items():
            feature_pricing = feature_map.get(feature_name)
            if not feature_pricing:
                continue

            is_included_feature = bool((feature_pricing.price_per_day or 0) <= 0)
            enabled = is_included_feature or bool(getattr(self, flag_field, False))

            if is_included_feature and not getattr(self, flag_field, False):
                setattr(self, flag_field, True)
                self.save(update_fields=[flag_field, 'updated_at'])

            if enabled:
                sub_feature, created = SubscriptionFeature.objects.get_or_create(
                    subscription=self,
                    feature=feature_pricing,
                    defaults={'enabled': True},
                )
                # Avoid unnecessary UPDATEs on every call to reduce write-lock contention on SQLite.
                if not created and not sub_feature.enabled:
                    sub_feature.enabled = True
                    sub_feature.save(update_fields=['enabled'])
            else:
                SubscriptionFeature.objects.filter(
                    subscription=self,
                    feature=feature_pricing,
                    enabled=True,
                ).delete()

    def get_subscription_summary(self):
        """Get a summary of subscription status and charges"""
        daily_charge = self.calculate_daily_charges()
        monthly_charge = self.calculate_monthly_charges()
        
        days_until_insufficient = None
        if daily_charge > 0:
            days_until_insufficient = int(self.account_balance / daily_charge)
        
        return {
            'status': self.status,
            'account_balance': float(self.account_balance),
            'total_spent': float(self.total_spent),
            'daily_charge': float(daily_charge),
            'monthly_charge': float(monthly_charge),
            'free_trial_active': self.is_free_trial_active(),
            'free_trial_days_remaining': self.get_free_trial_days_remaining(),
            'low_balance': self.account_balance < self.low_balance_threshold,
            'days_until_insufficient_balance': days_until_insufficient,
            'currency': self.get_currency_code(),
        }


class FeaturePricing(models.Model):
    """
    Define pricing for individual features
    """
    FEATURE_CHOICES = [
        ('pos', 'POS System'),
        ('inventory', 'Inventory Management'),
        ('invoicing', 'Invoices & Quotations'),
        ('online_menu', 'Online Menu'),
        ('online_ordering', 'Online Ordering'),
        ('kitchen', 'Kitchen Display System'),
        ('expense_management', 'Expense Management'),
        ('supplier_management', 'Supplier Management'),
        ('purchases', 'Purchase Orders'),
        ('low_stock_alerts', 'Low Stock Alerts'),
        ('expiry_alerts', 'Expiry Alerts'),
        ('customer_management', 'Customer Management'),
        ('reports', 'Reports'),
        ('analytics', 'Analytics'),
        ('take_orders', 'Take Orders'),
        ('staff_management', 'Multi-User Access'),
        ('waste_management', 'Waste Management'),
        ('stock_transfers', 'Stock Transfers'),
        ('stock_audits', 'Stock Audits'),
        ('tax_management', 'Tax Management'),
        ('multi_branch', 'Multi-Branch Management'),
    ]
    
    feature = models.CharField(max_length=50, choices=FEATURE_CHOICES, unique=True)
    price_per_day = models.DecimalField(max_digits=10, decimal_places=2, default=0.00, help_text="Daily price for this feature")
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['feature']

    def __str__(self):
        currency = SystemConfig.get_config().default_currency
        return f"{self.get_feature_display()} - {currency} {self.price_per_day}/day"


class SubscriptionFeature(models.Model):
    """
    Track which features are enabled for each subscription
    """
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='enabled_features')
    feature = models.ForeignKey(FeaturePricing, on_delete=models.CASCADE)
    enabled = models.BooleanField(default=True)
    enabled_date = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        unique_together = ('subscription', 'feature')
        ordering = ['feature']

    def __str__(self):
        return f"{self.subscription.business.name} - {self.feature.get_feature_display()}"


class UsageCharge(models.Model):
    """
    Track individual charges for pay-as-you-go usage
    """
    CHARGE_TYPES = [
        ('base_daily', 'Base Daily Fee'),
        ('feature', 'Feature Usage'),
        ('transaction', 'Transaction'),
        ('storage', 'Storage'),
        ('api_call', 'API Call'),
        ('other', 'Other'),
    ]
    
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='usage_charges')
    charge_type = models.CharField(max_length=20, choices=CHARGE_TYPES)
    description = models.CharField(max_length=255)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        currency = self.subscription.get_currency_code()
        return f"{self.subscription.business.name} - {self.charge_type} - {currency} {self.amount}"


class Invoice(models.Model):
    """
    Monthly invoices for pay-as-you-go charges
    """
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='invoices')
    invoice_number = models.CharField(max_length=50, unique=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2, default=0.00)
    status = models.CharField(max_length=20, choices=[
        ('draft', 'Draft'),
        ('sent', 'Sent'),
        ('paid', 'Paid'),
        ('failed', 'Failed'),
    ], default='draft')
    
    billing_period_start = models.DateTimeField(default=timezone.now)
    billing_period_end = models.DateTimeField(default=timezone.now)
    issue_date = models.DateTimeField(auto_now_add=True)
    due_date = models.DateTimeField(default=timezone.now)
    paid_date = models.DateTimeField(null=True, blank=True)
    
    stripe_invoice_id = models.CharField(max_length=255, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-issue_date']

    def __str__(self):
        return f"Invoice {self.invoice_number}"


class DepositStatus(models.TextChoices):
    PENDING = 'pending', 'Pending'
    COMPLETED = 'completed', 'Completed'
    FAILED = 'failed', 'Failed'
    CANCELLED = 'cancelled', 'Cancelled'


class Deposit(models.Model):
    """
    Track deposits/credits added to subscription account
    """
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='deposits')
    deposit_id = models.CharField(max_length=50, unique=True, db_index=True, help_text="Unique deposit identifier")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    credited_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Credits to add on completion. Defaults to the paid amount when blank.",
    )
    funding_period = models.CharField(
        max_length=20,
        blank=True,
        default='',
        help_text="Optional credit bundle type used to calculate bonus credits.",
    )
    status = models.CharField(max_length=20, choices=DepositStatus.choices, default=DepositStatus.PENDING)
    
    # Payment method
    payment_method = models.CharField(max_length=50, choices=[
        ('stripe', 'Stripe'),
        ('paypal', 'PayPal'),
        ('bank_transfer', 'Bank Transfer'),
        ('mobile_money', 'Mobile Money'),
        ('manual', 'Manual (Admin)'),
    ], default='stripe')
    
    # Transaction details
    transaction_id = models.CharField(max_length=255, blank=True, null=True, unique=True)
    stripe_payment_intent_id = models.CharField(max_length=255, blank=True)
    
    # Payment Proof
    payment_proof = models.TextField(blank=True, help_text="Transaction ID, reference number, or payment confirmation details provided by user")
    
    # Dates
    requested_date = models.DateTimeField(auto_now_add=True)
    completed_date = models.DateTimeField(null=True, blank=True)
    
    # Notes
    notes = models.TextField(blank=True, help_text="Internal notes (admin use)")
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-requested_date']

    def __str__(self):
        currency = self.subscription.get_currency_code()
        return f"Deposit {self.deposit_id} - {self.subscription.business.name} - {currency} {self.amount} ({self.status})"

    def save(self, *args, **kwargs):
        # Generate unique deposit_id if not set
        if not self.deposit_id:
            import uuid
            self.deposit_id = f"DEP-{self.subscription.business.id}-{uuid.uuid4().hex[:12].upper()}"
        super().save(*args, **kwargs)

    def get_credit_amount(self):
        credited_amount = self.credited_amount
        if credited_amount is None or credited_amount <= 0:
            return self.amount
        return credited_amount

    def get_bonus_credit_amount(self):
        return max(self.get_credit_amount() - (self.amount or Decimal('0.00')), Decimal('0.00'))

    def complete_deposit(self):
        """Mark deposit as completed and add credits to subscription"""
        with transaction.atomic():
            deposit = Deposit.objects.select_for_update().select_related('subscription').get(pk=self.pk)
            if deposit.status != DepositStatus.PENDING:
                return False

            subscription = Subscription.objects.select_for_update().get(pk=deposit.subscription_id)
            completed_at = timezone.now()
            credit_amount = deposit.get_credit_amount()

            subscription.account_balance += credit_amount
            subscription.last_payment_date = completed_at
            subscription_update_fields = ['account_balance', 'last_payment_date', 'updated_at']
            if subscription.maybe_auto_resume():
                subscription_update_fields.extend(['status', 'last_charge_date'])
            subscription.save(update_fields=subscription_update_fields)

            deposit.status = DepositStatus.COMPLETED
            deposit.completed_date = completed_at
            deposit.save(update_fields=['status', 'completed_date', 'updated_at'])

            self.status = deposit.status
            self.completed_date = deposit.completed_date
            self.subscription = subscription

        # Process affiliate commission if applicable
        commission_success, commission_message, commission_amount = self._process_affiliate_commission()
        # Expose commission result to callers (admin/views) for accurate user feedback.
        self._affiliate_commission_success = commission_success
        self._affiliate_commission_message = commission_message
        self._affiliate_commission_amount = commission_amount
        return True

    def _process_affiliate_commission(self):
        """Process affiliate commission for this deposit"""
        try:
            from affiliate.commission_service import affiliate_commission_service
            success, message, amount = affiliate_commission_service.process_deposit_commission(self)
            if success:
                logger.info(f"Affiliate commission processed: {message}")
            else:
                logger.debug(f"No affiliate commission: {message}")
            return success, message, amount
        except Exception as e:
            logger.error(f"Error processing affiliate commission: {str(e)}")
            return False, f"Error processing affiliate commission: {str(e)}", 0

    def cancel_deposit(self):
        """Cancel a pending deposit"""
        with transaction.atomic():
            deposit = Deposit.objects.select_for_update().get(pk=self.pk)
            if deposit.status != DepositStatus.PENDING:
                return False

            deposit.status = DepositStatus.CANCELLED
            deposit.save(update_fields=['status', 'updated_at'])
            self.status = deposit.status
            return True


class Refund(models.Model):
    """
    Track refunds for deposits and credits
    """
    REFUND_STATUS = [
        ('pending', 'Pending'),
        ('approved', 'Approved'),
        ('processed', 'Processed'),
        ('rejected', 'Rejected'),
    ]
    
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name='refunds')
    deposit = models.ForeignKey(Deposit, on_delete=models.SET_NULL, null=True, blank=True, related_name='refunds')
    refund_id = models.CharField(max_length=50, unique=True, db_index=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    reason = models.TextField(help_text="Reason for refund")
    status = models.CharField(max_length=20, choices=REFUND_STATUS, default='pending')
    
    # Refund details
    requested_by = models.CharField(max_length=255, help_text="User who requested refund")
    requested_date = models.DateTimeField(auto_now_add=True)
    approved_by = models.CharField(max_length=255, blank=True, help_text="Admin who approved refund")
    approved_date = models.DateTimeField(null=True, blank=True)
    processed_date = models.DateTimeField(null=True, blank=True)
    
    # Refund method
    refund_method = models.CharField(max_length=50, choices=[
        ('credit', 'Account Credit'),
        ('bank_transfer', 'Bank Transfer'),
        ('mobile_money', 'Mobile Money'),
        ('original_method', 'Original Payment Method'),
    ], default='credit')
    
    # Notes
    notes = models.TextField(blank=True, help_text="Internal notes")
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-requested_date']

    def __str__(self):
        currency = self.subscription.get_currency_code()
        return f"Refund {self.refund_id} - {self.subscription.business.name} - {currency} {self.amount} ({self.status})"

    def save(self, *args, **kwargs):
        if not self.refund_id:
            import uuid
            self.refund_id = f"REF-{self.subscription.business.id}-{uuid.uuid4().hex[:12].upper()}"
        super().save(*args, **kwargs)

    def approve_refund(self, approved_by):
        """Approve a pending refund"""
        if self.status == 'pending':
            self.status = 'approved'
            self.approved_by = approved_by
            self.approved_date = timezone.now()
            self.save()
            return True
        return False

    def process_refund(self):
        """Process an approved refund"""
        if self.status == 'approved':
            # Add credit back to subscription if refund method is 'credit'
            if self.refund_method == 'credit':
                self.subscription.add_credit(self.amount)
            
            self.status = 'processed'
            self.processed_date = timezone.now()
            self.save()
            return True
        return False

    def reject_refund(self, approved_by):
        """Reject a pending refund"""
        if self.status == 'pending':
            self.status = 'rejected'
            self.approved_by = approved_by
            self.approved_date = timezone.now()
            self.save()
            return True
        return False
