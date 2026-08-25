from django.contrib import admin
from .models import (
    Business, Branch, BusinessSettings, TaxRate, BusinessCharge, Customer,
    CustomerAccountTransaction, CustomerLaybuy, CustomerLaybuyPayment,
    CustomerLaybuyReservation, Expense
)

@admin.register(Business)
class BusinessAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'tin', 'business_type', 'owner', 'is_active', 'created_at')
    search_fields = ('name', 'tin', 'owner__email')
    list_filter = ('business_type', 'is_active', 'created_at')
    ordering = ('-created_at',)

@admin.register(Branch)
class BranchAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'business', 'city', 'country', 'is_active', 'created_at')
    search_fields = ('name', 'business__name', 'city')
    list_filter = ('is_active', 'country', 'created_at')
    ordering = ('-created_at',)

@admin.register(TaxRate)
class TaxRateAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'rate', 'business', 'is_default', 'created_at')
    search_fields = ('name', 'business__name')
    list_filter = ('is_default', 'created_at')
    ordering = ('-is_default', '-created_at')


@admin.register(BusinessCharge)
class BusinessChargeAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'charge_type', 'rate', 'business', 'auto_apply', 'is_active', 'created_at')
    search_fields = ('name', 'business__name')
    list_filter = ('charge_type', 'auto_apply', 'is_active', 'created_at')
    ordering = ('name',)

@admin.register(BusinessSettings)
class BusinessSettingsAdmin(admin.ModelAdmin):
    list_display = ('id', 'business', 'currency', 'timezone', 'allow_negative_ingredient_stock')
    search_fields = ('business__name',)
    list_filter = ('currency', 'timezone', 'allow_negative_ingredient_stock')


@admin.register(Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'business', 'branch', 'phone', 'current_balance', 'credit_limit', 'account_enabled', 'is_active')
    search_fields = ('name', 'phone', 'email', 'customer_tin', 'business__name')
    list_filter = ('account_enabled', 'is_active', 'vat_registered', 'business')
    readonly_fields = ('current_balance', 'created_at', 'updated_at')
    ordering = ('-created_at',)


@admin.register(CustomerAccountTransaction)
class CustomerAccountTransactionAdmin(admin.ModelAdmin):
    list_display = ('id', 'customer', 'entry_type', 'direction', 'amount', 'balance_after', 'payment_method', 'session', 'created_at')
    search_fields = ('customer__name', 'reference', 'order_id', 'invoice_id', 'session__id')
    list_filter = ('entry_type', 'direction', 'payment_method', 'created_at', 'business', 'session')
    readonly_fields = ('id', 'balance_after', 'created_at', 'updated_at')
    ordering = ('-created_at',)


@admin.register(CustomerLaybuy)
class CustomerLaybuyAdmin(admin.ModelAdmin):
    list_display = ('laybuy_number', 'customer', 'status', 'total', 'paid_amount', 'balance_due', 'due_date', 'created_at')
    search_fields = ('laybuy_number', 'customer__name', 'order_id')
    list_filter = ('status', 'business', 'branch', 'created_at', 'due_date')
    readonly_fields = ('id', 'laybuy_number', 'balance_due', 'created_at', 'updated_at', 'completed_at', 'cancelled_at')
    ordering = ('-created_at',)


@admin.register(CustomerLaybuyPayment)
class CustomerLaybuyPaymentAdmin(admin.ModelAdmin):
    list_display = ('id', 'laybuy', 'customer', 'amount', 'payment_method', 'reference', 'session', 'created_at')
    search_fields = ('laybuy__laybuy_number', 'customer__name', 'reference', 'session__id')
    list_filter = ('payment_method', 'business', 'branch', 'session', 'created_at')
    readonly_fields = ('id', 'created_at', 'updated_at')
    ordering = ('-created_at',)


@admin.register(CustomerLaybuyReservation)
class CustomerLaybuyReservationAdmin(admin.ModelAdmin):
    list_display = ('id', 'laybuy', 'customer', 'inventory_item', 'quantity', 'status', 'created_at')
    search_fields = ('laybuy__laybuy_number', 'customer__name', 'inventory_item__name', 'inventory_item_id_snapshot', 'item_name')
    list_filter = ('status', 'business', 'branch', 'created_at')
    readonly_fields = ('id', 'created_at', 'updated_at', 'fulfilled_at', 'released_at')
    ordering = ('-created_at',)


@admin.register(Expense)
class ExpenseAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'business', 'branch', 'category', 'amount', 'status', 'created_by', 'created_at')
    search_fields = ('title', 'business__name', 'category', 'created_by')
    list_filter = ('status', 'category', 'created_at', 'business')
    readonly_fields = ('id', 'created_at', 'approved_at')
    fieldsets = (
        ('Basic Information', {
            'fields': ('id', 'title', 'category', 'amount', 'date', 'notes')
        }),
        ('Business & Branch', {
            'fields': ('business', 'branch')
        }),
        ('Status & Approval', {
            'fields': ('status', 'created_by', 'created_at', 'approved_by', 'approved_at')
        }),
        ('Sync Tracking', {
            'fields': ('is_dirty',),
            'classes': ('collapse',)
        }),
    )
    ordering = ('-created_at',)
