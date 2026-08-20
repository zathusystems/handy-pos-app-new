from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator
from django.utils import timezone

class SystemConfig(models.Model):
    """
    Global system configuration settings
    Singleton pattern - only one instance should exist
    """
    # Subscription Pricing
    base_subscription_price_per_day = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=5.00,
        validators=[MinValueValidator(0)],
        help_text="Default base subscription price per day"
    )
    base_subscription_price_per_day_mwk = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=5000.00,
        validators=[MinValueValidator(0)],
        help_text="Base subscription price per day for Malawi (MWK)"
    )
    base_subscription_price_per_day_usd = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=5.00,
        validators=[MinValueValidator(0)],
        help_text="Base subscription price per day for International (USD)"
    )
    
    # Currency Settings
    default_currency = models.CharField(
        max_length=3,
        default='MWK',
        help_text="Default currency code (ISO 4217)"
    )
    malawi_currency_code = models.CharField(
        max_length=3,
        default='MWK',
        help_text="Currency code for Malawian businesses"
    )
    international_currency_code = models.CharField(
        max_length=3,
        default='USD',
        help_text="Currency code for international businesses"
    )
    
    # Trial Settings
    trial_days = models.IntegerField(
        default=14,
        validators=[MinValueValidator(0), MaxValueValidator(365)],
        help_text="Number of days for free trial"
    )
    
    # Feature Pricing Defaults
    enable_feature_pricing = models.BooleanField(
        default=True,
        help_text="Enable per-feature pricing"
    )
    
    # Invoice Settings
    invoice_due_days = models.IntegerField(
        default=7,
        validators=[MinValueValidator(1), MaxValueValidator(90)],
        help_text="Number of days until invoice is due"
    )
    
    # Payment Settings
    minimum_deposit_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=10.00,
        validators=[MinValueValidator(0)],
        help_text="Minimum deposit amount allowed"
    )
    
    maximum_deposit_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=100000.00,
        validators=[MinValueValidator(0)],
        help_text="Maximum deposit amount allowed"
    )
    
    # Low Balance Alert
    low_balance_threshold_days = models.IntegerField(
        default=7,
        validators=[MinValueValidator(1), MaxValueValidator(90)],
        help_text="Days of service remaining before low balance alert"
    )
    
    # System Settings
    system_name = models.CharField(
        max_length=255,
        default='Handy POS',
        help_text="System/Company name"
    )
    
    system_email = models.EmailField(
        default='support@handypos.com',
        help_text="System support email"
    )
    
    system_phone = models.CharField(
        max_length=20,
        blank=True,
        help_text="System support phone number"
    )
    
    # Maintenance Mode
    maintenance_mode = models.BooleanField(
        default=False,
        help_text="Enable maintenance mode"
    )
    
    maintenance_message = models.TextField(
        blank=True,
        help_text="Message to display during maintenance"
    )
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "System Configuration"
        verbose_name_plural = "System Configuration"

    def __str__(self):
        return f"System Config - {self.system_name}"

    def save(self, *args, **kwargs):
        # Ensure only one instance exists
        if not self.pk and SystemConfig.objects.exists():
            self.pk = SystemConfig.objects.first().pk
        super().save(*args, **kwargs)

    @classmethod
    def get_config(cls):
        """Get or create the singleton config instance"""
        config, created = cls.objects.get_or_create(pk=1)
        return config




class FeaturePricingConfig(models.Model):
    """
    Default pricing configuration for features
    """
    FEATURE_CHOICES = [
        ('pos', 'POS System'),
        ('inventory', 'Inventory Management'),
        ('invoicing', 'Invoicing'),
        ('online_menu', 'Online Menu'),
        ('online_ordering', 'Online Ordering'),
        ('delivery', 'Delivery Management'),
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
        ('staff_management', 'Staff Management'),
        ('waste_management', 'Waste Management'),
        ('stock_transfers', 'Stock Transfers'),
        ('stock_audits', 'Stock Audits'),
        ('tax_management', 'Tax Management'),
    ]
    
    feature = models.CharField(
        max_length=50,
        choices=FEATURE_CHOICES,
        unique=True,
        help_text="Feature identifier"
    )
    
    default_price_per_day = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0.00,
        validators=[MinValueValidator(0)],
        help_text="Default daily price for this feature"
    )
    default_price_per_day_mwk = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0.00,
        validators=[MinValueValidator(0)],
        help_text="Default daily price (MWK) for this feature for Malawi"
    )
    default_price_per_day_usd = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0.00,
        validators=[MinValueValidator(0)],
        help_text="Default daily price (USD) for this feature for International"
    )
    
    description = models.TextField(
        blank=True,
        help_text="Feature description"
    )
    
    is_active = models.BooleanField(
        default=True,
        help_text="Whether this feature is available"
    )
    
    is_premium = models.BooleanField(
        default=False,
        help_text="Whether this is a premium feature"
    )
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['feature']
        verbose_name_plural = "Feature Pricing Configurations"

    def __str__(self):
        return f"{self.get_feature_display()} - ${self.default_price_per_day}/day"


class PaymentGatewayConfig(models.Model):
    """
    Configuration for payment gateways
    """
    GATEWAY_CHOICES = [
        ('stripe', 'Stripe'),
        ('paypal', 'PayPal'),
        ('bank_transfer', 'Bank Transfer'),
    ]
    
    gateway = models.CharField(
        max_length=50,
        choices=GATEWAY_CHOICES,
        unique=True,
        help_text="Payment gateway identifier"
    )
    
    is_enabled = models.BooleanField(
        default=False,
        help_text="Whether this payment gateway is enabled"
    )
    
    api_key = models.CharField(
        max_length=500,
        blank=True,
        help_text="API key for the payment gateway"
    )
    
    api_secret = models.CharField(
        max_length=500,
        blank=True,
        help_text="API secret for the payment gateway"
    )
    
    webhook_url = models.URLField(
        blank=True,
        help_text="Webhook URL for payment notifications"
    )
    
    webhook_secret = models.CharField(
        max_length=500,
        blank=True,
        help_text="Webhook secret for verification"
    )
    
    transaction_fee_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0.00,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text="Transaction fee as percentage"
    )
    
    minimum_transaction_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0.00,
        validators=[MinValueValidator(0)],
        help_text="Minimum transaction amount"
    )
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['gateway']
        verbose_name_plural = "Payment Gateway Configurations"

    def __str__(self):
        return f"{self.get_gateway_display()} - {'Enabled' if self.is_enabled else 'Disabled'}"


class PaymentMethodConfig(models.Model):
    """
    Configuration for payment methods per currency
    """
    CURRENCY_CHOICES = [
        ('MWK', 'Malawi Kwacha'),
        ('USD', 'US Dollar'),
    ]
    
    PAYMENT_METHOD_CHOICES = [
        ('stripe', 'Stripe'),
        ('paypal', 'PayPal'),
        ('bank_transfer', 'Bank Transfer'),
        ('mobile_money', 'Mobile Money'),
    ]
    
    currency = models.CharField(
        max_length=3,
        choices=CURRENCY_CHOICES,
        help_text="Currency for this payment method"
    )
    
    payment_method = models.CharField(
        max_length=50,
        choices=PAYMENT_METHOD_CHOICES,
        help_text="Payment method type"
    )
    
    is_enabled = models.BooleanField(
        default=False,
        help_text="Whether this payment method is enabled for this currency"
    )
    
    display_order = models.IntegerField(
        default=0,
        help_text="Order in which to display this payment method"
    )
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['currency', 'display_order']
        unique_together = ('currency', 'payment_method')
        verbose_name_plural = "Payment Method Configurations"

    def __str__(self):
        return f"{self.get_currency_display()} - {self.get_payment_method_display()}"


class BankTransferConfig(models.Model):
    """
    Bank transfer details per currency
    """
    CURRENCY_CHOICES = [
        ('MWK', 'Malawi Kwacha'),
        ('USD', 'US Dollar'),
    ]
    
    currency = models.CharField(
        max_length=3,
        choices=CURRENCY_CHOICES,
        unique=True,
        help_text="Currency for this bank account"
    )
    
    account_holder = models.CharField(
        max_length=255,
        help_text="Bank account holder name"
    )
    
    bank_name = models.CharField(
        max_length=255,
        help_text="Bank name"
    )
    
    account_number = models.CharField(
        max_length=255,
        help_text="Bank account number"
    )
    
    routing_number = models.CharField(
        max_length=255,
        blank=True,
        help_text="Bank routing number (optional)"
    )
    
    swift_code = models.CharField(
        max_length=20,
        blank=True,
        help_text="SWIFT code (optional)"
    )
    
    iban = models.CharField(
        max_length=50,
        blank=True,
        help_text="IBAN (optional)"
    )
    
    instructions = models.TextField(
        blank=True,
        help_text="Additional transfer instructions"
    )
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['currency']
        verbose_name_plural = "Bank Transfer Configurations"

    def __str__(self):
        return f"{self.get_currency_display()} - {self.bank_name}"


class MobileMoneyConfig(models.Model):
    """
    Mobile money payment details for MWK
    """
    provider = models.CharField(
        max_length=255,
        unique=True,
        help_text="Mobile money provider name (e.g., Airtel Money, TNM Mpamba)"
    )
    
    is_enabled = models.BooleanField(
        default=False,
        help_text="Whether this mobile money provider is enabled"
    )
    
    account_number = models.CharField(
        max_length=255,
        help_text="Mobile money account number or phone number"
    )
    
    account_name = models.CharField(
        max_length=255,
        blank=True,
        help_text="Account holder name"
    )
    
    instructions = models.TextField(
        blank=True,
        help_text="Payment instructions for customers"
    )
    
    display_order = models.IntegerField(
        default=0,
        help_text="Order in which to display this provider"
    )
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['display_order']
        verbose_name_plural = "Mobile Money Configurations"

    def __str__(self):
        return f"{self.provider} - {self.account_number}"
