from django.contrib import admin
from .models import TakeOrder, TakeOrderItem


class TakeOrderItemInline(admin.TabularInline):
    model = TakeOrderItem
    extra = 1
    fields = ['name', 'quantity', 'notes']


@admin.register(TakeOrder)
class TakeOrderAdmin(admin.ModelAdmin):
    list_display = ['order_number', 'status', 'customer_name', 'branch', 'created_by', 'completed_by', 'created_at']
    list_filter = ['status', 'branch', 'created_by', 'completed_by', 'created_at']
    search_fields = ['order_number', 'customer_name', 'customer_phone']
    readonly_fields = ['id', 'order_number', 'created_at', 'updated_at', 'completed_at']
    inlines = [TakeOrderItemInline]
    
    fieldsets = (
        ('Order Info', {
            'fields': ('id', 'order_number', 'status', 'branch', 'business', 'created_by', 'completed_by')
        }),
        ('Customer Info', {
            'fields': ('customer_name', 'customer_phone', 'customer_notes')
        }),
        ('Order Details', {
            'fields': ('special_instructions',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at', 'completed_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(TakeOrderItem)
class TakeOrderItemAdmin(admin.ModelAdmin):
    list_display = ['name', 'quantity', 'take_order', 'created_at']
    list_filter = ['created_at']
    search_fields = ['name', 'take_order__order_number']
    readonly_fields = ['id', 'created_at', 'updated_at']
