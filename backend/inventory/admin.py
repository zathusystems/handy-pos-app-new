from django.contrib import admin
from django.utils.safestring import mark_safe
from .models import (
    Supplier, InventoryItem, PurchaseOrder, PurchaseOrderItem, StockTransfer,
    WasteRecord, StockAudit, StockAuditItem, MRAProductMapping
)


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'email', 'phone', 'is_active', 'created_at')
    list_filter = ('business', 'is_active', 'created_at')
    search_fields = ('name', 'email', 'phone')
    readonly_fields = ('created_at', 'updated_at')


class RecipeIngredientInline(admin.TabularInline):
    """Inline admin for recipe ingredients"""
    extra = 1
    fields = ('ingredientId', 'name', 'quantity', 'unit')
    
    def get_queryset(self, request):
        # This is a JSONField, so we don't have a queryset
        # The recipe is displayed as JSON in the main form
        return super().get_queryset(request)


@admin.register(InventoryItem)
class InventoryItemAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'branch', 'item_type', 'stock_units', 'status', 'price', 'is_produced', 'show_in_custom_sales_section', 'created_at')
    list_filter = ('business', 'branch', 'item_type', 'status', 'is_produced', 'is_sold_in_portions', 'show_in_custom_sales_section', 'created_at')
    search_fields = ('name', 'category', 'supplier')
    readonly_fields = ('created_at', 'updated_at', 'value', 'recipe_display')
    fieldsets = (
        ('Basic Information', {
            'fields': ('business', 'branch', 'name', 'category', 'item_type')
        }),
        ('Stock Information', {
            'fields': ('stock_units', 'unit_type', 'reorder_level', 'status')
        }),
        ('Pricing', {
            'fields': ('cost', 'price', 'value', 'is_variable_price')
        }),
        ('Supplier & Batch', {
            'fields': ('supplier', 'manufacturer', 'batch', 'expiry')
        }),
        ('Restaurant/Bar Fields', {
            'fields': ('is_recipe_ingredient', 'is_produced', 'on_menu'),
            'classes': ('collapse',)
        }),
        ('Recipe / Bill of Materials', {
            'fields': ('recipe_display', 'recipe'),
            'classes': ('collapse',),
            'description': 'View and edit the ingredients that make up this product'
        }),
        ('Bar & Liquor - Portions', {
            'fields': ('is_sold_in_portions', 'portion_name', 'portions_per_unit', 'portion_price'),
            'classes': ('collapse',)
        }),
        ('Internal Custom Section', {
            'fields': ('show_in_custom_sales_section',),
            'classes': ('collapse',)
        }),
        ('Business-Type Specific', {
            'fields': ('product_code', 'sku', 'barcode', 'brand'),
            'classes': ('collapse',)
        }),
        ('Metadata', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    
    def recipe_display(self, obj):
        """Display recipe ingredients in a formatted table"""
        if not obj.recipe or not isinstance(obj.recipe, list) or len(obj.recipe) == 0:
            return mark_safe('<p style="color: #999;">No ingredients defined</p>')
        
        html = '<table style="width: 100%; border-collapse: collapse; margin-top: 10px;">'
        html += '<thead><tr style="background-color: #f0f0f0; border-bottom: 2px solid #ddd;">'
        html += '<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">Ingredient</th>'
        html += '<th style="padding: 8px; text-align: center; border: 1px solid #ddd;">Quantity</th>'
        html += '<th style="padding: 8px; text-align: center; border: 1px solid #ddd;">Unit</th>'
        html += '</tr></thead><tbody>'
        
        for ingredient in obj.recipe:
            ingredient_name = ingredient.get('name', 'Unknown')
            quantity = ingredient.get('quantity', 0)
            unit = ingredient.get('unit', '')
            
            html += '<tr style="border-bottom: 1px solid #ddd;">'
            html += '<td style="padding: 8px; border: 1px solid #ddd;">' + str(ingredient_name) + '</td>'
            html += '<td style="padding: 8px; text-align: center; border: 1px solid #ddd;">' + str(quantity) + '</td>'
            html += '<td style="padding: 8px; text-align: center; border: 1px solid #ddd;">' + str(unit) + '</td>'
            html += '</tr>'
        
        html += '</tbody></table>'
        return mark_safe(html)
    
    recipe_display.short_description = 'Recipe Ingredients'


class PurchaseOrderItemInline(admin.TabularInline):
    model = PurchaseOrderItem
    extra = 1
    readonly_fields = ('total_cost',)
    fields = ('inventory_item', 'quantity_ordered', 'quantity_received', 'quantity_remaining', 'cost_per_unit', 'total_cost', 'batch_number', 'expiry_date')


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(admin.ModelAdmin):
    list_display = ('order_number', 'supplier', 'status', 'total_cost', 'payment_status', 'created_by', 'created_at')
    list_filter = ('business', 'branch', 'supplier', 'status', 'payment_status', 'created_at')
    search_fields = ('order_number', 'supplier__name')
    readonly_fields = ('created_at', 'updated_at', 'received_date')
    inlines = [PurchaseOrderItemInline]
    fieldsets = (
        ('Business & Branch', {
            'fields': ('business', 'branch', 'supplier')
        }),
        ('Order Information', {
            'fields': ('order_number', 'status', 'notes')
        }),
        ('Order Totals', {
            'fields': ('total_items', 'total_cost')
        }),
        ('Payment', {
            'fields': ('payment_status', 'amount_paid', 'amount_due')
        }),
        ('Audit Trail', {
            'fields': ('created_by', 'created_at', 'updated_at', 'received_date'),
            'classes': ('collapse',)
        }),
    )


@admin.register(PurchaseOrderItem)
class PurchaseOrderItemAdmin(admin.ModelAdmin):
    list_display = ('purchase_order', 'inventory_item', 'quantity_ordered', 'quantity_received', 'cost_per_unit', 'total_cost')
    list_filter = ('purchase_order__business', 'purchase_order', 'created_at')
    search_fields = ('inventory_item__name', 'purchase_order__order_number')
    readonly_fields = ('created_at', 'updated_at', 'total_cost')
    fieldsets = (
        ('Order & Item', {
            'fields': ('purchase_order', 'inventory_item')
        }),
        ('Quantities', {
            'fields': ('quantity_ordered', 'quantity_received', 'quantity_remaining')
        }),
        ('Cost', {
            'fields': ('cost_per_unit', 'total_cost')
        }),
        ('Batch & Expiry', {
            'fields': ('batch_number', 'expiry_date')
        }),
        ('Metadata', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(StockTransfer)
class StockTransferAdmin(admin.ModelAdmin):
    list_display = ('inventory_item', 'from_branch', 'to_branch', 'quantity', 'initiated_by', 'created_at')
    list_filter = ('business', 'from_branch', 'to_branch', 'created_at')
    search_fields = ('inventory_item__name', 'initiated_by')
    readonly_fields = ('created_at',)


@admin.register(WasteRecord)
class WasteRecordAdmin(admin.ModelAdmin):
    list_display = ('inventory_item', 'quantity', 'reason', 'cost', 'recorded_by', 'recorded_at')
    list_filter = ('business', 'branch', 'reason', 'recorded_at')
    search_fields = ('inventory_item__name', 'recorded_by', 'reason')
    readonly_fields = ('created_at',)


class StockAuditItemInline(admin.TabularInline):
    model = StockAuditItem
    extra = 0
    readonly_fields = ('inventory_item', 'system_stock', 'counted_stock', 'discrepancy')


@admin.register(StockAudit)
class StockAuditAdmin(admin.ModelAdmin):
    list_display = ('branch', 'status', 'total_discrepancy_value', 'created_by', 'created_at')
    list_filter = ('business', 'branch', 'status', 'created_at')
    search_fields = ('created_by', 'approved_by')
    readonly_fields = ('created_at', 'approved_at')
    inlines = [StockAuditItemInline]
    fieldsets = (
        ('Business & Branch', {
            'fields': ('business', 'branch')
        }),
        ('Status', {
            'fields': ('status', 'total_discrepancy_value')
        }),
        ('Created', {
            'fields': ('created_by', 'created_at')
        }),
        ('Approved', {
            'fields': ('approved_by', 'approved_at')
        }),
        ('Notes', {
            'fields': ('notes',),
            'classes': ('collapse',)
        }),
    )


@admin.register(MRAProductMapping)
class MRAProductMappingAdmin(admin.ModelAdmin):
    list_display = ('mra_product_name', 'mra_product_code', 'inventory_item', 'branch', 'mra_tax_type', 'mra_tax_rate', 'tax_calculation_method', 'is_approved', 'mra_synced', 'created_at')
    list_filter = ('branch', 'mra_tax_type', 'is_approved', 'mra_synced', 'tax_calculation_method', 'created_at')
    search_fields = ('mra_product_code', 'mra_product_name', 'inventory_item__name', 'branch__name')
    readonly_fields = ('created_at', 'updated_at', 'approved_at', 'last_synced_at')
    fieldsets = (
        ('Branch & Inventory', {
            'fields': ('branch', 'inventory_item')
        }),
        ('MRA Product Information', {
            'fields': ('mra_product_code', 'mra_product_name')
        }),
        ('Tax Configuration', {
            'fields': ('mra_tax_type', 'mra_tax_rate', 'tax_calculation_method')
        }),
        ('Unit of Measure', {
            'fields': ('mra_unit_measure',)
        }),
        ('Approval Status', {
            'fields': ('is_approved', 'approved_at')
        }),
        ('Sync Status', {
            'fields': ('mra_synced', 'last_synced_at')
        }),
        ('Audit Trail', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
