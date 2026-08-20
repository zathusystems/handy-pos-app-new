from django.contrib import admin
from .models import Menu, MenuConfig, MenuOption, MenuOptionGroup


@admin.register(Menu)
class MenuAdmin(admin.ModelAdmin):
    list_display = ('inventory_item', 'branch', 'business', 'added_at', 'updated_at')
    list_filter = ('business', 'branch', 'added_at')
    search_fields = ('inventory_item__name', 'branch__name', 'business__name')
    readonly_fields = ('id', 'added_at', 'updated_at')
    
    fieldsets = (
        ('Business & Branch', {
            'fields': ('business', 'branch')
        }),
        ('Menu Item', {
            'fields': ('inventory_item',)
        }),
        ('Metadata', {
            'fields': ('id', 'added_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(MenuConfig)
class MenuConfigAdmin(admin.ModelAdmin):
    list_display = ('branch', 'business', 'display_name', 'theme', 'show_prices', 'accept_orders', 'updated_at')
    list_filter = ('business', 'theme', 'show_prices', 'accept_orders', 'updated_at')
    search_fields = ('branch__name', 'business__name', 'display_name')
    readonly_fields = ('id', 'created_at', 'updated_at')
    
    fieldsets = (
        ('Basic Info', {
            'fields': ('id', 'business', 'branch')
        }),
        ('Branding', {
            'fields': ('display_name', 'description', 'tagline', 'footer_text', 'business_logo', 'business_banner')
        }),
        ('Colors', {
            'fields': ('primary_color', 'accent_color')
        }),
        ('Display Settings', {
            'fields': ('theme', 'items_per_row', 'currency')
        }),
        ('Display Options', {
            'fields': ('show_prices', 'show_categories', 'show_images', 'show_brand_info', 'show_contact_info')
        }),
        ('Features', {
            'fields': ('enable_search', 'enable_filters', 'enable_sorting')
        }),
        ('Order Management', {
            'fields': ('accept_orders',)
        }),
        ('Metadata', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(MenuOptionGroup)
class MenuOptionGroupAdmin(admin.ModelAdmin):
    list_display = ('name', 'menu', 'group_type', 'is_required', 'min_select', 'max_select', 'is_visible')
    list_filter = ('group_type', 'is_required', 'is_visible')
    search_fields = ('name', 'menu__inventory_item__name', 'menu__business__name')
    readonly_fields = ('id', 'created_at', 'updated_at')


@admin.register(MenuOption)
class MenuOptionAdmin(admin.ModelAdmin):
    list_display = ('name', 'group', 'price_mode', 'price_delta', 'price_override', 'is_default', 'is_visible')
    list_filter = ('price_mode', 'is_default', 'is_visible')
    search_fields = ('name', 'group__name', 'group__menu__inventory_item__name')
    readonly_fields = ('id', 'created_at', 'updated_at')
