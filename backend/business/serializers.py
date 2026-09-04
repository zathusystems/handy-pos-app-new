"""
MRA EIS-Compliant Business Serializers

Provides serialization for business models with MRA compliance:
- Taxpayer identity
- Branch tracking
- Tax immutability
- Invoice immutability
- Relational line items
"""

from rest_framework import serializers
from decimal import Decimal
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Sum

from .models import (
    Business, Branch, BusinessSettings, TaxRate, BusinessCharge, Invoice, InvoiceLine,
    Customer, CustomerAccountTransaction, CustomerAccountPaymentAllocation, CustomerLaybuy, CustomerLaybuyPayment,
    CustomerLaybuyReservation, Expense
)


# ============================================================================
# CUSTOMER SERIALIZERS
# ============================================================================

class CustomerSerializer(serializers.ModelSerializer):
    """Customer serializer with VAT tracking"""
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    available_credit = serializers.SerializerMethodField()
    has_credit_limit = serializers.SerializerMethodField()

    class Meta:
        model = Customer
        fields = [
            'id', 'business', 'branch', 'branch_name', 'name', 'email', 'phone', 'address',
            'notes', 'is_active', 'account_enabled', 'credit_limit', 'current_balance',
            'available_credit', 'has_credit_limit',
            'customer_tin', 'vat_registered', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'business', 'current_balance', 'available_credit', 'has_credit_limit',
            'created_at', 'updated_at'
        ]

    def get_available_credit(self, obj):
        available_credit = obj.available_credit
        return available_credit if available_credit is not None else None

    def get_has_credit_limit(self, obj):
        return obj.has_credit_limit


class CustomerCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating customers"""
    class Meta:
        model = Customer
        fields = [
            'branch', 'name', 'email', 'phone', 'address', 'notes',
            'is_active', 'account_enabled', 'credit_limit',
            'customer_tin', 'vat_registered'
        ]


class CustomerAccountTransactionSerializer(serializers.ModelSerializer):
    """Customer account ledger serializer"""
    customer_name = serializers.CharField(source='customer.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    created_by_name = serializers.SerializerMethodField()
    allocated_amount = serializers.SerializerMethodField()
    unallocated_amount = serializers.SerializerMethodField()

    class Meta:
        model = CustomerAccountTransaction
        fields = [
            'id', 'business', 'branch', 'branch_name', 'customer', 'customer_name',
            'entry_type', 'direction', 'amount', 'balance_after',
            'order_id', 'invoice_id', 'session', 'payment_method', 'reference', 'notes',
            'allocated_amount', 'unallocated_amount',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_created_by_name(self, obj):
        user = obj.created_by
        if not user:
            return None
        return getattr(user, 'full_name', None) or user.get_username()

    def get_allocated_amount(self, obj):
        if obj.entry_type != 'payment' or obj.direction != 'credit':
            return Decimal('0.00')
        return obj.allocations.aggregate(total=Sum('amount'))['total'] or Decimal('0.00')

    def get_unallocated_amount(self, obj):
        if obj.entry_type != 'payment' or obj.direction != 'credit':
            return Decimal('0.00')
        allocated = self.get_allocated_amount(obj)
        return max(Decimal('0.00'), Decimal(obj.amount or 0) - Decimal(allocated or 0))


class CustomerPaymentSerializer(serializers.Serializer):
    """Serializer for recording customer account payments"""
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    invoice = serializers.PrimaryKeyRelatedField(
        queryset=Invoice.objects.all(),
        required=False,
        allow_null=True,
    )
    payment_method = serializers.ChoiceField(
        choices=['Cash', 'Card', 'Mobile Money', 'Bank Transfer', 'Other'],
        default='Cash'
    )
    branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.all(),
        required=False,
        allow_null=True
    )
    session = serializers.UUIDField(required=False, allow_null=True)
    reference = serializers.CharField(max_length=120, required=False, allow_blank=True)
    notes = serializers.CharField(required=False, allow_blank=True)

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Payment amount must be greater than zero.")
        return value


class CustomerLaybuyPaymentSerializer(serializers.ModelSerializer):
    """Serializer for laybuy deposits and installments"""
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = CustomerLaybuyPayment
        fields = [
            'id', 'business', 'branch', 'customer', 'laybuy',
            'session', 'amount', 'payment_method', 'reference', 'notes',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_created_by_name(self, obj):
        user = obj.created_by
        if not user:
            return None
        return getattr(user, 'full_name', None) or user.get_username()


class CustomerLaybuyReservationSerializer(serializers.ModelSerializer):
    """Serializer for stock held by laybuy orders"""
    item_name_display = serializers.SerializerMethodField()

    class Meta:
        model = CustomerLaybuyReservation
        fields = [
            'id', 'business', 'branch', 'customer', 'laybuy',
            'inventory_item', 'inventory_item_id_snapshot', 'order_item_id',
            'item_name', 'item_name_display', 'quantity', 'status',
            'fulfilled_at', 'released_at', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_item_name_display(self, obj):
        if obj.item_name:
            return obj.item_name
        if obj.inventory_item:
            return obj.inventory_item.name
        return obj.inventory_item_id_snapshot


class CustomerLaybuySerializer(serializers.ModelSerializer):
    """Serializer for customer laybuy/reserved sales"""
    customer_name = serializers.CharField(source='customer.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    payments = CustomerLaybuyPaymentSerializer(many=True, read_only=True)
    reservations = CustomerLaybuyReservationSerializer(many=True, read_only=True)

    class Meta:
        model = CustomerLaybuy
        fields = [
            'id', 'business', 'branch', 'branch_name', 'customer', 'customer_name',
            'order_id', 'laybuy_number', 'status', 'subtotal', 'total',
            'deposit_amount', 'paid_amount', 'balance_due', 'due_date',
            'notes', 'created_by', 'completed_at', 'cancelled_at',
            'created_at', 'updated_at', 'payments', 'reservations',
        ]
        read_only_fields = fields


class LaybuyCreateSerializer(serializers.Serializer):
    """Serializer for creating a manual customer laybuy"""
    total = serializers.DecimalField(max_digits=12, decimal_places=2)
    deposit_amount = serializers.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))
    payment_method = serializers.ChoiceField(
        choices=['Cash', 'Card', 'Mobile Money', 'Bank Transfer', 'Other'],
        default='Cash'
    )
    branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.all(),
        required=False,
        allow_null=True
    )
    session = serializers.UUIDField(required=False, allow_null=True)
    due_date = serializers.DateField(required=False, allow_null=True)
    reference = serializers.CharField(max_length=120, required=False, allow_blank=True)
    notes = serializers.CharField(required=False, allow_blank=True)

    def validate_total(self, value):
        if value <= 0:
            raise serializers.ValidationError("Laybuy total must be greater than zero.")
        return value

    def validate_deposit_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("Deposit cannot be negative.")
        return value

    def validate(self, attrs):
        deposit = attrs.get('deposit_amount') or Decimal('0.00')
        total = attrs.get('total') or Decimal('0.00')
        if deposit > total:
            raise serializers.ValidationError({'deposit_amount': 'Deposit cannot exceed the laybuy total.'})
        return attrs


class LaybuyPaymentSerializer(serializers.Serializer):
    """Serializer for adding an installment to a laybuy"""
    laybuy_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    payment_method = serializers.ChoiceField(
        choices=['Cash', 'Card', 'Mobile Money', 'Bank Transfer', 'Other'],
        default='Cash'
    )
    branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.all(),
        required=False,
        allow_null=True
    )
    session = serializers.UUIDField(required=False, allow_null=True)
    reference = serializers.CharField(max_length=120, required=False, allow_blank=True)
    notes = serializers.CharField(required=False, allow_blank=True)

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Payment amount must be greater than zero.")
        return value


# ============================================================================
# INVOICE LINE SERIALIZERS (NEW - CRITICAL)
# ============================================================================

class InvoiceLineSerializer(serializers.ModelSerializer):
    """Serializer for invoice line items (relational storage)"""
    class Meta:
        model = InvoiceLine
        fields = [
            'id', 'product_code', 'product_name', 'quantity', 'unit_price',
            'tax_rate', 'tax_amount', 'total_amount', 'mra_product_code',
            'created_at'
        ]
        read_only_fields = ['id', 'created_at']


class InvoiceLineCreateSerializer(serializers.Serializer):
    """Serializer for creating invoice line items"""
    product_code = serializers.CharField(max_length=100)
    product_name = serializers.CharField(max_length=255)
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    unit_price = serializers.DecimalField(max_digits=12, decimal_places=2)
    tax_rate = serializers.DecimalField(max_digits=5, decimal_places=2)
    tax_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    total_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    mra_product_code = serializers.CharField(max_length=100, required=False, allow_blank=True)

    def validate_quantity(self, value):
        if value <= 0:
            raise serializers.ValidationError("Quantity must be positive")
        return value

    def validate_unit_price(self, value):
        if value < 0:
            raise serializers.ValidationError("Unit price cannot be negative")
        return value

    def validate_tax_rate(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Tax rate must be between 0 and 100")
        return value


# ============================================================================
# INVOICE SERIALIZERS (Enhanced for MRA EIS)
# ============================================================================

class InvoiceSerializer(serializers.ModelSerializer):
    """Invoice serializer with MRA EIS fields"""
    lines = InvoiceLineSerializer(many=True, read_only=True)
    customer_name_display = serializers.CharField(source='customer.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    paid_amount = serializers.SerializerMethodField()
    balance_due = serializers.SerializerMethodField()
    customer_current_balance = serializers.SerializerMethodField()
    customer_available_credit = serializers.SerializerMethodField()
    prepaid_amount = serializers.SerializerMethodField()

    class Meta:
        model = Invoice
        fields = [
            'id', 'business', 'branch', 'branch_name', 'customer', 'customer_name_display',
            'invoice_number', 'document_type', 'customer_name', 'status', 'approval_status', 'lines',
            'subtotal', 'tax', 'total', 'paid_amount', 'prepaid_amount', 'balance_due',
            'customer_current_balance', 'customer_available_credit',
            'issue_date', 'due_date', 'notes',
            'related_order_id', 'approved_by', 'approved_at',
            # MRA EIS fields
            'mra_invoice_number', 'mra_status', 'mra_receipt_signature',
            'mra_qr_code', 'mra_submitted_at', 'is_locked',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'business', 'created_at', 'updated_at', 'is_locked',
            'mra_invoice_number', 'mra_receipt_signature', 'mra_qr_code',
            'mra_submitted_at', 'paid_amount', 'prepaid_amount', 'balance_due',
            'customer_current_balance', 'customer_available_credit',
        ]

    def get_paid_amount(self, obj):
        from .customer_accounts import get_invoice_paid_amount

        return get_invoice_paid_amount(obj)

    def get_prepaid_amount(self, obj):
        if obj.document_type != 'Invoice' or obj.status == 'Void':
            return Decimal('0.00')
        return CustomerAccountPaymentAllocation.objects.filter(
            invoice=obj,
            business=obj.business,
        ).aggregate(total=Sum('amount'))['total'] or Decimal('0.00')

    def get_balance_due(self, obj):
        from .customer_accounts import get_invoice_balance_due

        return get_invoice_balance_due(obj)

    def _fresh_customer(self, obj):
        if not obj.customer_id:
            return None
        return Customer.objects.filter(pk=obj.customer_id).first()

    def get_customer_current_balance(self, obj):
        customer = self._fresh_customer(obj)
        return customer.current_balance if customer else None

    def get_customer_available_credit(self, obj):
        customer = self._fresh_customer(obj)
        return customer.available_credit if customer else None


class InvoiceDetailSerializer(InvoiceSerializer):
    """Detailed invoice serializer with all fields"""
    pass


class InvoiceCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating invoices with line items"""
    invoice_number = serializers.IntegerField(required=False)
    lines = InvoiceLineCreateSerializer(many=True, write_only=True)

    class Meta:
        model = Invoice
        fields = [
            'invoice_number', 'document_type', 'branch', 'customer', 'customer_name', 'status',
            'lines', 'subtotal', 'tax', 'total', 'issue_date', 'due_date', 'notes'
        ]

    def validate_lines(self, value):
        """Validate line items"""
        if not value:
            raise serializers.ValidationError("Invoice must have at least one line item")
        return value

    def create(self, validated_data):
        """Create invoice with line items"""
        # The view supplies the business after checking the owner's or Admin
        # staff member's scope. Keep a guarded fallback for direct serializer
        # use in tests and management code.
        business = validated_data.pop('business', None)
        if business is None:
            from .access import get_accessible_business

            business = get_accessible_business(
                self.context['request'].user,
                admin_staff_only=True,
            )
        if not business:
            raise serializers.ValidationError('User must have an accessible business')

        # Extract lines
        lines_data = validated_data.pop('lines', [])

        # Create invoice
        validated_data['business'] = business
        if not validated_data.get('invoice_number'):
            last_invoice = Invoice.objects.filter(business=business).order_by('-invoice_number').first()
            validated_data['invoice_number'] = (last_invoice.invoice_number + 1) if last_invoice else 1

        branch = validated_data.get('branch')
        if branch and branch.business_id != business.id:
            raise serializers.ValidationError({'branch': 'Branch does not belong to this business.'})

        customer = validated_data.get('customer')
        if customer and customer.business_id != business.id:
            raise serializers.ValidationError({'customer': 'Customer does not belong to this business.'})

        invoice = super().create(validated_data)

        # Create line items
        total_tax = Decimal('0')
        total_amount = Decimal('0')

        for line_data in lines_data:
            InvoiceLine.objects.create(
                invoice=invoice,
                product_code=line_data['product_code'],
                product_name=line_data['product_name'],
                quantity=line_data['quantity'],
                unit_price=line_data['unit_price'],
                tax_rate=line_data['tax_rate'],
                tax_amount=line_data['tax_amount'],
                total_amount=line_data['total_amount'],
                mra_product_code=line_data.get('mra_product_code', ''),
            )
            total_tax += line_data['tax_amount']
            total_amount += line_data['total_amount']

        # Update invoice totals
        invoice.subtotal = total_amount - total_tax
        invoice.tax = total_tax
        invoice.total = total_amount
        invoice.save()

        return invoice


class InvoiceUpdateSerializer(serializers.ModelSerializer):
    """Serializer for updating invoices (with immutability check)"""
    class Meta:
        model = Invoice
        fields = [
            'document_type', 'customer', 'customer_name', 'status', 'approval_status',
            'subtotal', 'tax', 'total', 'issue_date', 'due_date', 'notes'
        ]

    def update(self, instance, validated_data):
        """Update invoice with immutability check"""
        if instance.is_locked:
            raise serializers.ValidationError(
                "Cannot modify a locked invoice. This invoice has been paid or submitted to MRA."
            )
        return super().update(instance, validated_data)


# ============================================================================
# TAX RATE SERIALIZERS (Enhanced for MRA EIS)
# ============================================================================

class TaxRateSerializer(serializers.ModelSerializer):
    """Tax rate serializer with immutability tracking"""
    created_by_name = serializers.CharField(
        source='created_by.get_full_name',
        read_only=True,
        allow_null=True
    )

    class Meta:
        model = TaxRate
        fields = [
            'id', 'business', 'name', 'rate', 'tax_type', 'is_default',
            'effective_from', 'effective_to', 'mra_tax_code', 'locked',
            'is_active', 'created_by', 'created_by_name', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'created_by', 'created_by_name', 'locked'
        ]


class TaxRateCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating tax rates"""
    class Meta:
        model = TaxRate
        fields = [
            'name', 'rate', 'tax_type', 'is_default', 'effective_from',
            'effective_to', 'mra_tax_code'
        ]

    def validate_rate(self, value):
        """Validate tax rate"""
        if value < 0 or value > 100:
            raise serializers.ValidationError("Tax rate must be between 0 and 100")
        return value


class TaxRateUpdateSerializer(serializers.ModelSerializer):
    """Serializer for updating tax rates (with immutability check)"""
    class Meta:
        model = TaxRate
        fields = [
            'name', 'is_default', 'effective_to', 'is_active'
        ]

    def update(self, instance, validated_data):
        """Update tax rate with immutability check"""
        if instance.locked:
            raise serializers.ValidationError(
                "Cannot modify a locked tax rate. Create a new tax rate instead."
            )
        return super().update(instance, validated_data)


class BusinessChargeSerializer(serializers.ModelSerializer):
    """Serializer for additional charges such as levies and service charges."""
    created_by_name = serializers.CharField(
        source='created_by.get_full_name',
        read_only=True,
        allow_null=True
    )

    class Meta:
        model = BusinessCharge
        fields = [
            'id', 'business', 'name', 'charge_type', 'rate',
            'calculation_method', 'calculation_base', 'auto_apply',
            'is_active', 'effective_from', 'effective_to',
            'created_by', 'created_by_name', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'business', 'created_by', 'created_by_name',
            'created_at', 'updated_at'
        ]

    def validate_rate(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Charge rate must be between 0 and 100")
        return value


class BusinessChargeCreateUpdateSerializer(serializers.ModelSerializer):
    """Create/update serializer for business charges."""

    class Meta:
        model = BusinessCharge
        fields = [
            'name', 'charge_type', 'rate', 'calculation_method',
            'calculation_base', 'auto_apply', 'is_active',
            'effective_from', 'effective_to'
        ]

    def validate_rate(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Charge rate must be between 0 and 100")
        return value


# ============================================================================
# BUSINESS SETTINGS SERIALIZERS (Enhanced for MRA EIS)
# ============================================================================

class BusinessSettingsSerializer(serializers.ModelSerializer):
    """Business settings serializer with EIS controls"""
    allow_negative_stock = serializers.BooleanField(
        source='allow_negative_ingredient_stock',
        required=False
    )

    class Meta:
        model = BusinessSettings
        fields = [
            'id', 'currency', 'timezone', 'enable_inventory', 'enable_invoicing',
            'enable_pos', 'enable_kitchen', 'enable_delivery', 'fuel_pumps',
            # MRA EIS fields
            'enable_eis', 'eis_environment', 'block_sales_if_eis_down',
            'block_sales_if_tax_mapping_missing', 'allow_negative_ingredient_stock',
            'allow_negative_stock', 'enable_custom_sales_section',
            'custom_sales_section_name',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


# ============================================================================
# BRANCH SERIALIZERS (Enhanced for MRA EIS)
# ============================================================================

class BranchSerializer(serializers.ModelSerializer):
    """Branch serializer with MRA tracking"""
    class Meta:
        model = Branch
        fields = [
            'id', 'business', 'name', 'slug', 'address', 'city', 'state',
            'postal_code', 'country', 'phone', 'email', 'latitude', 'longitude',
            'is_active', 'mra_branch_code', 'mra_device_location',
            'mra_site_id', 'mra_site_name', 'mra_terminal_id',
            'mra_terminal_position', 'is_eis_warehouse', 'eis_mapping_source',
            'eis_mapping_updated_at',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'business', 'slug', 'eis_mapping_updated_at', 'created_at', 'updated_at'
        ]


class BranchCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating branches"""
    class Meta:
        model = Branch
        fields = [
            'name', 'address', 'city', 'state', 'postal_code', 'country',
            'phone', 'email', 'latitude', 'longitude', 'mra_branch_code',
            'mra_device_location', 'mra_site_id', 'mra_site_name',
            'mra_terminal_id', 'mra_terminal_position', 'is_eis_warehouse',
            'eis_mapping_source',
        ]


# ============================================================================
# BUSINESS SERIALIZERS (Enhanced for MRA EIS)
# ============================================================================

class BusinessTinAliasSerializerMixin:
    """
    Compatibility mixin for legacy payloads that send business TIN as
    `tax_pin` or `taxPin` instead of `tin`.
    """
    tax_pin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )
    taxPin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )

    @staticmethod
    def _normalize_tin(raw_value):
        if raw_value is None:
            return None
        normalized = str(raw_value).strip()
        return normalized or None

    def validate(self, attrs):
        attrs = super().validate(attrs)
        legacy_tax_pin = attrs.pop('tax_pin', serializers.empty)
        legacy_tax_pin_camel = attrs.pop('taxPin', serializers.empty)

        if 'tin' in attrs:
            attrs['tin'] = self._normalize_tin(attrs.get('tin'))
            return attrs

        for candidate in (legacy_tax_pin, legacy_tax_pin_camel):
            if candidate is serializers.empty:
                continue
            attrs['tin'] = self._normalize_tin(candidate)
            break

        return attrs

class BusinessSerializer(serializers.ModelSerializer):
    """Business serializer with MRA identity"""
    branches = BranchSerializer(many=True, read_only=True)
    settings = BusinessSettingsSerializer(read_only=True)
    tax_rates = TaxRateSerializer(many=True, read_only=True)
    tax_pin = serializers.SerializerMethodField()
    taxPin = serializers.SerializerMethodField()
    # EIS settings fields for easy access
    enable_eis = serializers.SerializerMethodField()
    eis_environment = serializers.SerializerMethodField()
    block_sales_if_eis_down = serializers.SerializerMethodField()
    block_sales_if_tax_mapping_missing = serializers.SerializerMethodField()
    allow_negative_ingredient_stock = serializers.SerializerMethodField()
    allow_negative_stock = serializers.SerializerMethodField()
    enable_custom_sales_section = serializers.SerializerMethodField()
    custom_sales_section_name = serializers.SerializerMethodField()

    class Meta:
        model = Business
        fields = [
            'id', 'owner', 'name', 'slug', 'business_type', 'description',
            'email', 'phone', 'address', 'country', 'website', 'logo',
            'is_active',
            # MRA EIS identity
            'tin', 'tax_pin', 'taxPin', 'vat_registration_number', 'vat_registered',
            'mra_taxpayer_type', 'mra_enrolled', 'mra_enrolled_at',
            # EIS settings
            'enable_eis', 'eis_environment', 'block_sales_if_eis_down',
            'block_sales_if_tax_mapping_missing', 'allow_negative_ingredient_stock',
            'allow_negative_stock', 'enable_custom_sales_section',
            'custom_sales_section_name',
            # Relations
            'branches', 'settings', 'tax_rates',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'owner', 'slug', 'created_at', 'updated_at', 'mra_enrolled_at'
        ]

    def get_enable_eis(self, obj):
        """Get enable_eis from related BusinessSettings"""
        return obj.settings.enable_eis if hasattr(obj, 'settings') else False

    def get_eis_environment(self, obj):
        """Get eis_environment from related BusinessSettings"""
        return obj.settings.eis_environment if hasattr(obj, 'settings') else 'TEST'

    def get_block_sales_if_eis_down(self, obj):
        """Get block_sales_if_eis_down from related BusinessSettings"""
        return obj.settings.block_sales_if_eis_down if hasattr(obj, 'settings') else True

    def get_block_sales_if_tax_mapping_missing(self, obj):
        """Get block_sales_if_tax_mapping_missing from related BusinessSettings"""
        return obj.settings.block_sales_if_tax_mapping_missing if hasattr(obj, 'settings') else False

    def get_allow_negative_ingredient_stock(self, obj):
        """Get allow_negative_ingredient_stock from related BusinessSettings"""
        return obj.settings.allow_negative_ingredient_stock if hasattr(obj, 'settings') else False

    def get_allow_negative_stock(self, obj):
        """Clear API alias for allow_negative_ingredient_stock."""
        return self.get_allow_negative_ingredient_stock(obj)

    def get_enable_custom_sales_section(self, obj):
        return obj.settings.enable_custom_sales_section if hasattr(obj, 'settings') else False

    def get_custom_sales_section_name(self, obj):
        return obj.settings.custom_sales_section_name if hasattr(obj, 'settings') else ''

    def get_tax_pin(self, obj):
        return obj.tin

    def get_taxPin(self, obj):
        return obj.tin


class BusinessDetailSerializer(BusinessSerializer):
    """Detailed business serializer"""
    pass


class BusinessCreateSerializer(BusinessTinAliasSerializerMixin, serializers.ModelSerializer):
    """Serializer for creating businesses"""
    # Explicitly declare legacy alias inputs so DRF treats them as serializer
    # fields (not model fields) when present in Meta.fields.
    tax_pin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )
    taxPin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )
    referral_code = serializers.CharField(
        required=False,
        allow_blank=True,
        write_only=True
    )
    currency = serializers.CharField(
        required=False,
        allow_blank=False,
        write_only=True
    )
    referral_status = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Business
        fields = [
            'id', 'name', 'business_type', 'description', 'email', 'phone',
            'address', 'country', 'website', 'logo',
            # MRA EIS identity
            'tin', 'tax_pin', 'taxPin', 'vat_registration_number', 'vat_registered',
            'mra_taxpayer_type',
            # Initial business settings
            'currency',
            # Referral
            'referral_code', 'referral_status'
        ]
        read_only_fields = ['id']

    def get_referral_status(self, obj):
        return getattr(self, '_referral_status', None)

    def _process_referral_code(self, business, referral_code):
        """Helper method to process referral code"""
        if referral_code:
            from affiliate.models import Affiliate, BusinessReferral
            try:
                affiliate = Affiliate.objects.get(affiliate_code=referral_code)

                # Check if referral already exists
                existing_referral = BusinessReferral.objects.filter(business=business).first()
                if existing_referral:
                    self._referral_status = {
                        'valid': False,
                        'message': 'Business is already associated with an affiliate'
                    }
                    return

                # Create new referral
                BusinessReferral.objects.create(
                    affiliate=affiliate,
                    business=business,
                    referral_code=f"{affiliate.affiliate_code}-{business.id}",
                    status='active'
                )

                # Update affiliate stats
                affiliate.total_referred_businesses += 1
                affiliate.total_active_referrals += 1
                affiliate.save()

                full_name = f"{affiliate.user.first_name} {affiliate.user.last_name}".strip()
                affiliate_name = full_name or affiliate.user.email

                self._referral_status = {
                    'valid': True,
                    'message': f'Referral code applied successfully. You will earn commissions through {affiliate.user.email}',
                    'affiliate_name': affiliate_name
                }
            except Affiliate.DoesNotExist:
                self._referral_status = {
                    'valid': False,
                    'message': f'Referral code "{referral_code}" is invalid or does not exist'
                }
        else:
            self._referral_status = {
                'valid': True,
                'message': None
            }

    def create(self, validated_data):
        requested_currency = validated_data.pop('currency', None)
        self._requested_currency = requested_currency
        referral_code = validated_data.pop('referral_code', None)
        business = super().create(validated_data)
        self._process_referral_code(business, referral_code)
        return business

    def update(self, instance, validated_data):
        validated_data.pop('currency', None)
        referral_code = validated_data.pop('referral_code', None)
        business = super().update(instance, validated_data)
        if referral_code:
            self._process_referral_code(business, referral_code)
        return business

    def to_representation(self, instance):
        """Override to include referral_status in response"""
        data = super().to_representation(instance)
        if hasattr(self, '_referral_status'):
            data['referral_status'] = self._referral_status
        return data


class BusinessUpdateSerializer(BusinessTinAliasSerializerMixin, serializers.ModelSerializer):
    """Serializer for updating businesses"""
    tax_pin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )
    taxPin = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        write_only=True
    )
    # EIS settings fields (from BusinessSettings model) - writable
    enable_eis = serializers.BooleanField(required=False, allow_null=True)
    eis_environment = serializers.CharField(required=False, allow_blank=True)
    block_sales_if_eis_down = serializers.BooleanField(required=False, allow_null=True)
    block_sales_if_tax_mapping_missing = serializers.BooleanField(required=False, allow_null=True)
    allow_negative_ingredient_stock = serializers.BooleanField(required=False, allow_null=True)
    allow_negative_stock = serializers.BooleanField(required=False, allow_null=True)
    enable_custom_sales_section = serializers.BooleanField(required=False, allow_null=True)
    custom_sales_section_name = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    fuel_pumps = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        allow_null=True
    )

    class Meta:
        model = Business
        fields = [
            'id', 'name', 'business_type', 'description', 'email', 'phone',
            'address', 'country', 'website', 'logo', 'is_active',
            'tin', 'tax_pin', 'taxPin', 'vat_registration_number', 'vat_registered',
            'mra_taxpayer_type', 'mra_enrolled',
            # EIS settings
            'enable_eis', 'eis_environment', 'block_sales_if_eis_down',
            'block_sales_if_tax_mapping_missing', 'allow_negative_ingredient_stock',
            'allow_negative_stock', 'enable_custom_sales_section',
            'custom_sales_section_name', 'fuel_pumps',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def to_representation(self, instance):
        """Override to include EIS settings in response"""
        data = super().to_representation(instance)
        # Always include EIS settings from BusinessSettings
        if hasattr(instance, 'settings'):
            data['enable_eis'] = instance.settings.enable_eis
            data['eis_environment'] = instance.settings.eis_environment
            data['block_sales_if_eis_down'] = instance.settings.block_sales_if_eis_down
            data['block_sales_if_tax_mapping_missing'] = instance.settings.block_sales_if_tax_mapping_missing
            data['allow_negative_ingredient_stock'] = instance.settings.allow_negative_ingredient_stock
            data['allow_negative_stock'] = instance.settings.allow_negative_ingredient_stock
            data['enable_custom_sales_section'] = instance.settings.enable_custom_sales_section
            data['custom_sales_section_name'] = instance.settings.custom_sales_section_name
            data['fuel_pumps'] = instance.settings.fuel_pumps
        else:
            data['enable_eis'] = False
            data['eis_environment'] = 'TEST'
            data['block_sales_if_eis_down'] = True
            data['block_sales_if_tax_mapping_missing'] = False
            data['allow_negative_ingredient_stock'] = False
            data['allow_negative_stock'] = False
            data['enable_custom_sales_section'] = False
            data['custom_sales_section_name'] = ''
            data['fuel_pumps'] = []
        return data

    def update(self, instance, validated_data):
        """Update business and related settings"""
        # Extract EIS settings before calling super
        enable_eis = validated_data.pop('enable_eis', None)
        eis_environment = validated_data.pop('eis_environment', None)
        block_sales_if_eis_down = validated_data.pop('block_sales_if_eis_down', None)
        block_sales_if_tax_mapping_missing = validated_data.pop('block_sales_if_tax_mapping_missing', None)
        allow_negative_ingredient_stock = validated_data.pop('allow_negative_ingredient_stock', None)
        allow_negative_stock = validated_data.pop('allow_negative_stock', None)
        enable_custom_sales_section = validated_data.pop('enable_custom_sales_section', None)
        custom_sales_section_name = validated_data.pop('custom_sales_section_name', None)
        fuel_pumps = validated_data.pop('fuel_pumps', None)
        if allow_negative_stock is not None:
            allow_negative_ingredient_stock = allow_negative_stock

        # Update business fields
        instance = super().update(instance, validated_data)

        # Update BusinessSettings if provided
        if any(v is not None for v in [enable_eis, eis_environment, block_sales_if_eis_down, block_sales_if_tax_mapping_missing, allow_negative_ingredient_stock, enable_custom_sales_section, custom_sales_section_name, fuel_pumps]):
            settings = instance.settings
            if enable_eis is not None:
                settings.enable_eis = enable_eis
            if eis_environment is not None:
                settings.eis_environment = eis_environment
            if block_sales_if_eis_down is not None:
                settings.block_sales_if_eis_down = block_sales_if_eis_down
            if block_sales_if_tax_mapping_missing is not None:
                settings.block_sales_if_tax_mapping_missing = block_sales_if_tax_mapping_missing
            if allow_negative_ingredient_stock is not None:
                settings.allow_negative_ingredient_stock = allow_negative_ingredient_stock
            if enable_custom_sales_section is not None:
                settings.enable_custom_sales_section = enable_custom_sales_section
            if custom_sales_section_name is not None:
                settings.custom_sales_section_name = str(custom_sales_section_name or '').strip()
            if fuel_pumps is not None:
                normalized_pumps = []
                for pump in fuel_pumps or []:
                    pump_value = str(pump or '').strip()
                    if not pump_value or pump_value in normalized_pumps:
                        continue
                    normalized_pumps.append(pump_value)
                settings.fuel_pumps = normalized_pumps
            settings.save()

        return instance


# ============================================================================
# EXPENSE SERIALIZERS
# ============================================================================

class ExpenseSerializer(serializers.ModelSerializer):
    """Expense serializer"""
    class Meta:
        model = Expense
        fields = [
            'id', 'business', 'branch', 'title', 'category', 'amount', 'date',
            'notes', 'status', 'created_by', 'created_at', 'updated_at',
            'approved_by', 'approved_at'
        ]
        read_only_fields = ['id', 'business', 'created_at', 'updated_at']


class ExpenseCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating expenses"""
    class Meta:
        model = Expense
        fields = [
            'title', 'category', 'amount', 'date', 'notes', 'branch'
        ]
    
    def create(self, validated_data):
        """Create expense with auto-generated ID"""
        import uuid
        # Generate unique ID for expense
        expense_id = f"EXP-{uuid.uuid4().hex[:12]}"
        validated_data['id'] = expense_id
        return super().create(validated_data)
