"""
MRA EIS-Compliant Inventory Serializers

Provides serialization for inventory operations with MRA compliance.
Maintains backward compatibility with existing serializers.
"""

from rest_framework import serializers
from decimal import Decimal
from django.utils import timezone

from .models import (
    Supplier, InventoryItem, MRAProductMapping, PurchaseOrder,
    PurchaseOrderItem, StockTransfer, WasteRecord, StockAudit,
    StockAuditItem, InventorySnapshot, AuditLog
)


# ============================================================================
# SUPPLIER SERIALIZERS
# ============================================================================

class SupplierSerializer(serializers.ModelSerializer):
    """Basic supplier serializer"""
    balance_due = serializers.SerializerMethodField()
    
    class Meta:
        model = Supplier
        fields = [
            'id', 'name', 'email', 'phone', 'address', 'city', 'country',
            'is_active', 'total_amount_due', 'total_amount_paid', 'balance_due',
            'supplier_tin', 'vat_registered',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def get_balance_due(self, obj):
        return obj.get_balance_due()


class SupplierDetailSerializer(SupplierSerializer):
    """Detailed supplier serializer with MRA fields"""
    pass


class SupplierCreateUpdateSerializer(serializers.ModelSerializer):
    """Serializer for creating/updating suppliers"""
    class Meta:
        model = Supplier
        fields = [
            'name', 'email', 'phone', 'address', 'city', 'country',
            'is_active', 'supplier_tin', 'vat_registered'
        ]


# ============================================================================
# MRA PRODUCT MAPPING SERIALIZERS
# ============================================================================

class MRAProductMappingSerializer(serializers.ModelSerializer):
    """MRA product mapping serializer"""
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    branch_name = serializers.SerializerMethodField()
    
    class Meta:
        model = MRAProductMapping
        fields = [
            'id', 'inventory_item', 'inventory_item_name', 'branch', 'branch_name',
            'mra_product_code', 'mra_product_name', 'mra_tax_type',
            'mra_tax_rate', 'mra_unit_measure', 'tax_calculation_method',
            'mra_levies',
            'is_approved', 'approved_at', 'mra_synced', 'last_synced_at', 'created_at'
        ]
        read_only_fields = [
            'id', 'inventory_item', 'branch', 'is_approved', 'approved_at',
            'mra_synced', 'last_synced_at', 'created_at', 'mra_levies'
        ]

    def get_branch_name(self, obj):
        """Safely derive branch name even when mapping has no branch."""
        branch = getattr(obj, 'branch', None)
        return branch.name if branch else None


class MRAProductMappingCreateSerializer(serializers.Serializer):
    """Serializer for creating MRA product mappings"""
    inventory_item_id = serializers.UUIDField(required=True)
    mra_product_code = serializers.CharField(
        max_length=100,
        required=False,
        allow_blank=True,
        allow_null=True
    )
    mra_product_name = serializers.CharField(
        max_length=255,
        required=False,
        allow_blank=True,
        allow_null=True
    )
    mra_tax_type = serializers.ChoiceField(
        choices=['standard', 'zero', 'exempt'],
        required=True
    )
    mra_tax_rate = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        required=True
    )
    mra_unit_measure = serializers.ChoiceField(
        choices=['unit', 'kg', 'liter', 'meter', 'box', 'pack', 'bottle', 'can', 'carton'],
        required=True
    )
    tax_calculation_method = serializers.ChoiceField(
        choices=['inclusive', 'exclusive'],
        required=False,
        default='inclusive'
    )

    def validate_mra_tax_rate(self, value):
        """Validate tax rate is between 0 and 100"""
        if value < 0 or value > 100:
            raise serializers.ValidationError(
                "Tax rate must be between 0 and 100"
            )
        return value
    
    def validate_inventory_item_id(self, value):
        """Validate inventory item exists"""
        try:
            InventoryItem.objects.get(id=value)
        except InventoryItem.DoesNotExist:
            raise serializers.ValidationError(
                f"Inventory item with ID {value} does not exist"
            )
        return value

    def validate(self, attrs):
        """
        Normalize MRA tax payload so zero-rated/exempt mappings are always
        stored with 0% tax and inclusive calculation method.
        """
        tax_type = attrs.get('mra_tax_type')
        tax_rate = attrs.get('mra_tax_rate')

        if tax_type in {'zero', 'exempt'}:
            attrs['mra_tax_rate'] = Decimal('0.00')
            attrs['tax_calculation_method'] = 'inclusive'
            return attrs

        # Standard-rated products must carry a positive tax rate.
        if tax_rate is None or tax_rate <= 0:
            raise serializers.ValidationError({
                'mra_tax_rate': 'Standard tax type must have a rate greater than 0.'
            })

        return attrs


class MRAProductMappingBulkCreateSerializer(serializers.Serializer):
    """Serializer for bulk creation of MRA product mappings"""
    mappings = MRAProductMappingCreateSerializer(many=True, allow_empty=False)

    def validate_mappings(self, value):
        """Prevent duplicate inventory items in one bulk request"""
        inventory_item_ids = [str(item['inventory_item_id']) for item in value]
        duplicate_ids = sorted({
            item_id for item_id in inventory_item_ids
            if inventory_item_ids.count(item_id) > 1
        })
        if duplicate_ids:
            raise serializers.ValidationError(
                f"Duplicate inventory_item_id values in request: {', '.join(duplicate_ids)}"
            )
        return value


class MRAProductMappingApproveSerializer(serializers.Serializer):
    """Serializer for approving MRA product mappings"""
    is_approved = serializers.BooleanField()
    mra_synced = serializers.BooleanField(required=False, default=False)

# ============================================================================
# INVENTORY ITEM SERIALIZERS
# ============================================================================

class InventoryItemSerializer(serializers.ModelSerializer):
    """Basic inventory item serializer"""
    mra_mapping = MRAProductMappingSerializer(read_only=True)
    is_mra_ready = serializers.SerializerMethodField()
    available_stock_units = serializers.SerializerMethodField()
    
    class Meta:
        model = InventoryItem
        fields = [
            'id', 'name', 'category', 'item_type', 'stock_units',
            'reserved_stock_units', 'available_stock_units',
            'unit_type', 'reorder_level', 'status', 'cost', 'price',
            'value', 'is_variable_price', 'is_fuel', 'sku', 'barcode', 'product_code',
            'expiry', 'on_menu', 'supplier', 'manufacturer', 'batch',
            'brand', 'is_recipe_ingredient', 'is_produced',
            'is_sold_in_portions', 'portion_name', 'portions_per_unit', 'portion_price',
            'show_in_custom_sales_section', 'recipe', 'image', 'mra_mapping', 'is_mra_ready',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'value', 'status', 'reserved_stock_units', 'available_stock_units',
            'mra_mapping', 'is_mra_ready',
            'created_at', 'updated_at'
        ]

    def get_is_mra_ready(self, obj):
        """Check if item is MRA-ready"""
        return obj.is_mra_ready()

    def get_available_stock_units(self, obj):
        """Expose available stock after laybuy reservations."""
        return obj.available_stock_units

    def validate(self, attrs):
        item_type = attrs.get('item_type')
        if item_type is None and self.instance is not None:
            item_type = self.instance.item_type

        is_produced = attrs.get('is_produced')
        if is_produced is None and self.instance is not None:
            is_produced = self.instance.is_produced

        if item_type != 'sellable':
            attrs['is_produced'] = False
            attrs['is_variable_price'] = False
            attrs['is_sold_in_portions'] = False
            attrs['portion_name'] = None
            attrs['portions_per_unit'] = None
            attrs['portion_price'] = None
            attrs['show_in_custom_sales_section'] = False
        elif is_produced:
            attrs['is_variable_price'] = False
            attrs['is_sold_in_portions'] = False
            attrs['portion_name'] = None
            attrs['portions_per_unit'] = None
            attrs['portion_price'] = None

        return attrs


class InventoryItemDetailSerializer(InventoryItemSerializer):
    """Detailed inventory item serializer"""
    class Meta(InventoryItemSerializer.Meta):
        fields = InventoryItemSerializer.Meta.fields + [
            'price_locked', 'tax_locked'
        ]


class InventoryItemCreateUpdateSerializer(serializers.ModelSerializer):
    """Serializer for creating/updating inventory items"""
    category = serializers.CharField(required=False, allow_blank=True, default='')

    class Meta:
        model = InventoryItem
        fields = [
            'name', 'category', 'item_type', 'stock_units', 'unit_type',
            'reorder_level', 'cost', 'price', 'is_variable_price', 'is_fuel',
            'sku', 'barcode', 'product_code', 'expiry', 'on_menu', 'supplier',
            'manufacturer', 'batch', 'brand', 'is_recipe_ingredient',
            'is_produced', 'is_sold_in_portions', 'portion_name',
            'portions_per_unit', 'portion_price', 'show_in_custom_sales_section',
            'recipe', 'image'
        ]

    def validate_price(self, value):
        """Validate price is not negative"""
        if value is not None and value < 0:
            raise serializers.ValidationError("Price cannot be negative")
        return value

    def validate_cost(self, value):
        """Validate cost is not negative"""
        if value is not None and value < 0:
            raise serializers.ValidationError("Cost cannot be negative")
        return value

    def validate_portion_price(self, value):
        """Validate portion price is not negative"""
        if value is not None and value < 0:
            raise serializers.ValidationError("Portion price cannot be negative")
        return value

    def validate_stock_units(self, value):
        """Validate stock is not negative"""
        if value < 0:
            raise serializers.ValidationError("Stock cannot be negative")
        return value

    def validate_unit_type(self, value):
        """Ensure unit_type has a default value"""
        if not value or value.strip() == '':
            return 'unit'
        return value


class InventoryItemLockSerializer(serializers.Serializer):
    """Serializer for locking price/tax"""
    price_locked = serializers.BooleanField(required=False)
    tax_locked = serializers.BooleanField(required=False)


# ============================================================================
# INVENTORY SNAPSHOT SERIALIZERS
# ============================================================================

class InventorySnapshotSerializer(serializers.ModelSerializer):
    """Inventory snapshot serializer"""
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    branch_name = serializers.CharField(
        source='branch.name',
        read_only=True
    )
    
    class Meta:
        model = InventorySnapshot
        fields = [
            'id', 'inventory_item', 'inventory_item_name', 'branch',
            'branch_name', 'quantity_before_sale', 'quantity_sold',
            'quantity_after_sale', 'related_invoice_number',
            'related_order_id', 'product_price', 'product_tax_rate',
            'product_tax_type', 'created_at'
        ]
        read_only_fields = [
            'id', 'quantity_after_sale', 'created_at'
        ]


# ============================================================================
# PURCHASE ORDER SERIALIZERS
# ============================================================================

class PurchaseOrderItemSerializer(serializers.ModelSerializer):
    """Purchase order item serializer"""
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    
    class Meta:
        model = PurchaseOrderItem
        fields = [
            'id', 'inventory_item', 'inventory_item_name',
            'quantity_ordered', 'quantity_received', 'quantity_remaining',
            'cost_per_unit', 'total_cost', 'batch_number', 'expiry_date',
            'tax_rate', 'tax_calculation_method', 'tax_amount',
            'session_id',  # NEW: Session tracking
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'total_cost', 'tax_amount', 'created_at', 'updated_at'
        ]


class PurchaseOrderSerializer(serializers.ModelSerializer):
    """Purchase order serializer"""
    supplier_name = serializers.CharField(
        source='supplier.name',
        read_only=True
    )
    items = PurchaseOrderItemSerializer(many=True, read_only=True)
    
    class Meta:
        model = PurchaseOrder
        fields = [
            'id', 'order_number', 'supplier', 'supplier_name', 'status',
            'total_items', 'total_cost', 'payment_status', 'amount_paid',
            'amount_due', 'reference_number', 'vat_amount', 'items',
            'received_date', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'order_number', 'total_items', 'total_cost',
            'amount_due', 'items', 'received_date', 'created_at', 'updated_at'
        ]


class PurchaseOrderDetailSerializer(PurchaseOrderSerializer):
    """Detailed purchase order serializer with MRA fields"""
    class Meta(PurchaseOrderSerializer.Meta):
        fields = PurchaseOrderSerializer.Meta.fields + [
            'supplier_tin', 'supplier_vat_registered', 'notes',
            'created_by'
        ]


class PurchaseOrderCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating purchase orders"""
    items = PurchaseOrderItemSerializer(many=True, required=False)
    
    class Meta:
        model = PurchaseOrder
        fields = [
            'supplier', 'notes', 'supplier_tin', 'supplier_vat_registered',
            'reference_number', 'vat_amount'
        ]


# ============================================================================
# STOCK TRANSFER SERIALIZERS
# ============================================================================

class StockTransferSerializer(serializers.ModelSerializer):
    """Stock transfer serializer"""
    from_branch_name = serializers.CharField(
        source='from_branch.name',
        read_only=True
    )
    to_branch_name = serializers.CharField(
        source='to_branch.name',
        read_only=True
    )
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    
    class Meta:
        model = StockTransfer
        fields = [
            'id', 'from_branch', 'from_branch_name', 'to_branch',
            'to_branch_name', 'inventory_item', 'inventory_item_name',
            'quantity', 'transfer_reference', 'mra_notified',
            'initiated_by', 'created_at'
        ]
        read_only_fields = [
            'id', 'transfer_reference', 'mra_notified', 'created_at'
        ]


class StockTransferCreateSerializer(serializers.Serializer):
    """Serializer for creating stock transfers"""
    from_branch_id = serializers.UUIDField()
    to_branch_id = serializers.UUIDField()
    inventory_item_id = serializers.UUIDField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)

    def validate_quantity(self, value):
        """Validate quantity is positive"""
        if value <= 0:
            raise serializers.ValidationError("Quantity must be positive")
        return value


# ============================================================================
# WASTE RECORD SERIALIZERS
# ============================================================================

class WasteRecordSerializer(serializers.ModelSerializer):
    """Waste record serializer"""
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    branch_name = serializers.CharField(
        source='branch.name',
        read_only=True
    )
    
    class Meta:
        model = WasteRecord
        fields = [
            'id', 'inventory_item', 'inventory_item_name', 'branch',
            'branch_name', 'quantity', 'unit', 'cost', 'reason', 'notes',
            'affects_tax', 'approved_by', 'recorded_by', 'recorded_at',
            'session_id',  # NEW: Session tracking
            'created_at'
        ]
        read_only_fields = [
            'id', 'recorded_at', 'created_at'
        ]


class WasteRecordCreateSerializer(serializers.Serializer):
    """Serializer for creating waste records"""
    inventory_item_id = serializers.UUIDField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    unit = serializers.CharField(max_length=50, required=False)
    cost = serializers.DecimalField(max_digits=12, decimal_places=2)
    reason = serializers.ChoiceField(
        choices=['Expired', 'Damaged', 'Spoilage', 'Error', 'Other']
    )
    notes = serializers.CharField(required=False, allow_blank=True)
    approved_by = serializers.CharField(max_length=255, required=False)

    def validate_quantity(self, value):
        """Validate quantity is positive"""
        if value <= 0:
            raise serializers.ValidationError("Quantity must be positive")
        return value

    def validate_cost(self, value):
        """Validate cost is not negative"""
        if value < 0:
            raise serializers.ValidationError("Cost cannot be negative")
        return value


# ============================================================================
# STOCK AUDIT SERIALIZERS
# ============================================================================

class StockAuditItemSerializer(serializers.ModelSerializer):
    """Stock audit item serializer"""
    inventory_item_name = serializers.CharField(
        source='inventory_item.name',
        read_only=True
    )
    
    class Meta:
        model = StockAuditItem
        fields = [
            'id', 'inventory_item', 'inventory_item_name',
            'system_stock', 'counted_stock', 'discrepancy'
        ]
        read_only_fields = ['id', 'discrepancy']


class StockAuditSerializer(serializers.ModelSerializer):
    """Stock audit serializer"""
    branch_name = serializers.CharField(
        source='branch.name',
        read_only=True
    )
    items = StockAuditItemSerializer(many=True, read_only=True)
    
    class Meta:
        model = StockAudit
        fields = [
            'id', 'branch', 'branch_name', 'status', 'total_discrepancy_value',
            'approval_role', 'mra_visible', 'inventory_locked', 'items',
            'created_by', 'created_at', 'approved_by', 'approved_at', 'notes'
        ]
        read_only_fields = [
            'id', 'total_discrepancy_value', 'items', 'created_at',
            'approved_at'
        ]


class StockAuditCreateSerializer(serializers.Serializer):
    """Serializer for creating stock audits"""
    branch_id = serializers.CharField(required=True)  # Accept string or UUID
    items = StockAuditItemSerializer(many=True, required=False)
    notes = serializers.CharField(required=False, allow_blank=True)
    
    def validate_branch_id(self, value):
        """Validate and convert branch_id to UUID or int"""
        try:
            # Try to parse as UUID first
            from uuid import UUID
            return UUID(value)
        except (ValueError, TypeError):
            try:
                # Try to parse as integer
                return int(value)
            except (ValueError, TypeError):
                raise serializers.ValidationError(
                    "branch_id must be a valid UUID or integer"
                )


class StockAuditApproveSerializer(serializers.Serializer):
    """Serializer for approving stock audits"""
    status = serializers.ChoiceField(choices=['Approved', 'Rejected'])
    approval_role = serializers.ChoiceField(
        choices=['Manager', 'Auditor', 'MRA']
    )
    notes = serializers.CharField(required=False, allow_blank=True)


# ============================================================================
# AUDIT LOG SERIALIZERS
# ============================================================================

class AuditLogSerializer(serializers.ModelSerializer):
    """Audit log serializer"""
    user_email = serializers.CharField(
        source='user.email',
        read_only=True
    )
    
    class Meta:
        model = AuditLog
        fields = [
            'id', 'action_type', 'entity_type', 'entity_id', 'user_email',
            'details', 'mra_related', 'mra_reference', 'created_at'
        ]
        read_only_fields = ['id', 'created_at']


# ============================================================================
# BULK OPERATION SERIALIZERS
# ============================================================================

class BulkStockUpdateSerializer(serializers.Serializer):
    """Serializer for bulk stock updates"""
    items = serializers.ListField(
        child=serializers.DictField(
            child=serializers.CharField()
        )
    )

    def validate_items(self, value):
        """Validate items list"""
        if not value:
            raise serializers.ValidationError("Items list cannot be empty")
        return value


class InventoryReportSerializer(serializers.Serializer):
    """Serializer for inventory reports"""
    start_date = serializers.DateTimeField(required=False)
    end_date = serializers.DateTimeField(required=False)
    branch_id = serializers.UUIDField(required=False)
    item_type = serializers.ChoiceField(
        choices=['ingredient', 'sellable'],
        required=False
    )
    status = serializers.ChoiceField(
        choices=['In Stock', 'Low Stock', 'Out of Stock'],
        required=False
    )


# ============================================================================
# RESPONSE SERIALIZERS
# ============================================================================

class SuccessResponseSerializer(serializers.Serializer):
    """Generic success response"""
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = serializers.JSONField(required=False)


class ErrorResponseSerializer(serializers.Serializer):
    """Generic error response"""
    error = serializers.BooleanField()
    message = serializers.CharField()
    details = serializers.JSONField(required=False)


class PaginatedResponseSerializer(serializers.Serializer):
    """Paginated response"""
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = serializers.ListField()
