from rest_framework import serializers
from django.conf import settings
from .models import Menu, MenuConfig, MenuOption, MenuOptionGroup
from .utils import get_business_currency, get_takeaway_packaging_price
from inventory.serializers import InventoryItemSerializer


class MenuSerializer(serializers.ModelSerializer):
    item_name = serializers.SerializerMethodField()
    item_details = InventoryItemSerializer(source='inventory_item', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    option_groups = serializers.SerializerMethodField()

    class Meta:
        model = Menu
        fields = [
            'id', 'business', 'branch', 'branch_name', 'inventory_item', 
            'item_name', 'item_details', 'name', 'category', 'description',
            'price', 'image', 'recipe', 'is_prepared_item',
            'is_visible', 'option_groups', 'added_at', 'updated_at'
        ]
        read_only_fields = ['added_at', 'updated_at', 'item_name', 'item_details', 'branch_name', 'option_groups']

    def validate(self, attrs):
        inventory_item = attrs.get('inventory_item', getattr(self.instance, 'inventory_item', None))
        is_prepared_item = attrs.get('is_prepared_item', getattr(self.instance, 'is_prepared_item', False))
        name = str(attrs.get('name', getattr(self.instance, 'name', '')) or '').strip()

        if inventory_item and is_prepared_item:
            raise serializers.ValidationError({
                'inventory_item': 'Prepared menu items should not also be linked to an inventory product.'
            })
        if not inventory_item and not name:
            raise serializers.ValidationError({'name': 'Prepared menu items require a name.'})
        return attrs

    def get_item_name(self, obj):
        return obj.display_name

    def get_option_groups(self, obj):
        groups = obj.option_groups.filter(is_visible=True).prefetch_related('options')
        return MenuOptionGroupSerializer(groups, many=True).data


class MenuOptionSerializer(serializers.ModelSerializer):
    linked_inventory_item_name = serializers.CharField(source='linked_inventory_item.name', read_only=True)

    class Meta:
        model = MenuOption
        fields = [
            'id', 'group', 'name', 'description', 'price_mode', 'price_delta',
            'price_override', 'recipe', 'linked_inventory_item',
            'linked_inventory_item_name', 'linked_inventory_quantity',
            'is_default', 'is_visible', 'sort_order', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at', 'linked_inventory_item_name']


class MenuOptionGroupSerializer(serializers.ModelSerializer):
    options = MenuOptionSerializer(many=True, read_only=True)
    menu_item_name = serializers.SerializerMethodField()

    class Meta:
        model = MenuOptionGroup
        fields = [
            'id', 'menu', 'menu_item_name', 'name', 'group_type', 'is_required',
            'min_select', 'max_select', 'sort_order', 'is_visible', 'options',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at', 'menu_item_name', 'options']

    def get_menu_item_name(self, obj):
        return obj.menu.display_name

    def validate(self, attrs):
        is_required = attrs.get('is_required', getattr(self.instance, 'is_required', False))
        min_select = attrs.get('min_select', getattr(self.instance, 'min_select', 0))
        max_select = attrs.get('max_select', getattr(self.instance, 'max_select', 1))

        if is_required and min_select < 1:
            attrs['min_select'] = 1
            min_select = 1

        if max_select < 1:
            raise serializers.ValidationError({'max_select': 'Maximum choices must be at least 1.'})

        if min_select > max_select:
            raise serializers.ValidationError({'min_select': 'Minimum choices cannot be greater than maximum choices.'})

        return attrs


class MenuConfigSerializer(serializers.ModelSerializer):
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    business_name = serializers.CharField(source='business.name', read_only=True)
    public_menu_url = serializers.SerializerMethodField(read_only=True)
    currency = serializers.SerializerMethodField(read_only=True)
    takeaway_packaging_item_name = serializers.SerializerMethodField()
    takeaway_packaging_price = serializers.SerializerMethodField()

    class Meta:
        model = MenuConfig
        fields = [
            'id', 'business', 'business_name', 'branch', 'branch_name',
            'display_name', 'description', 'tagline', 'footer_text',
            'business_logo', 'business_banner',
            'primary_color', 'accent_color',
            'theme', 'items_per_row', 'currency',
            'show_prices', 'show_categories', 'show_images',
            'show_brand_info', 'show_contact_info',
            'enable_search', 'enable_filters', 'enable_sorting',
            'accept_orders', 'takeaway_enabled', 'takeaway_packaging_item',
            'takeaway_packaging_item_name', 'takeaway_packaging_price',
            'public_menu_url',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at', 'business_name', 'branch_name', 'public_menu_url']

    def get_public_menu_url(self, obj):
        """Generate the public menu URL from business and branch slugs"""
        business_slug = obj.business.slug
        branch_slug = obj.branch.slug
        public_menu_base_url = str(
            getattr(settings, 'PUBLIC_MENU_BASE_URL', '') or ''
        ).strip().rstrip('/')

        if public_menu_base_url:
            return f"{public_menu_base_url}/{business_slug}/{branch_slug}/"

        request = self.context.get('request')
        if request:
            # Get the host from the request
            host = request.get_host()
            protocol = 'https' if request.is_secure() else 'http'
        else:
            # Fallback if no request context
            protocol = 'https'
            host = 'localhost:9002'

        return f"{protocol}://{host}/{business_slug}/{branch_slug}/"

    def get_currency(self, obj):
        return get_business_currency(obj.business, getattr(obj, 'currency', None))

    def get_takeaway_packaging_item_name(self, obj):
        item = getattr(obj, 'takeaway_packaging_item', None)
        return item.name if item else ''

    def get_takeaway_packaging_price(self, obj):
        return get_takeaway_packaging_price(obj)

    def validate(self, attrs):
        takeaway_enabled = attrs.get('takeaway_enabled', getattr(self.instance, 'takeaway_enabled', False))
        packaging_item = attrs.get(
            'takeaway_packaging_item',
            getattr(self.instance, 'takeaway_packaging_item', None),
        )
        if takeaway_enabled and not packaging_item:
            raise serializers.ValidationError({
                'takeaway_packaging_item': 'Choose an inventory packaging item before enabling takeaway.'
            })

        if packaging_item:
            branch = getattr(self.instance, 'branch', None)
            business = getattr(self.instance, 'business', None)
            if branch and packaging_item.branch_id != branch.id:
                raise serializers.ValidationError({
                    'takeaway_packaging_item': 'Packaging item must belong to this branch.'
                })
            if business and packaging_item.business_id != business.id:
                raise serializers.ValidationError({
                    'takeaway_packaging_item': 'Packaging item must belong to this business.'
                })
            if takeaway_enabled and packaging_item.price is None:
                raise serializers.ValidationError({
                    'takeaway_packaging_item': 'Set a selling price for this packaging item in Inventory before enabling takeaway.'
                })

        return attrs
