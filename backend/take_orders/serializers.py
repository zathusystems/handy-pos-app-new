from rest_framework import serializers
from .models import TakeOrder, TakeOrderItem
from business.customer_accounts import resolve_customer_for_account_payload
from inventory.models import InventoryItem
from django.core.exceptions import ValidationError as DjangoValidationError
from pos_sessions.stock_validation import validate_stock_available_for_order_lines


KITCHEN_BUSINESS_TYPES = {'restaurant', 'bar_liquor'}

def _business_supports_kitchen(business):
    return str(getattr(business, 'business_type', '') or '').strip().lower() in KITCHEN_BUSINESS_TYPES


class TakeOrderItemSerializer(serializers.ModelSerializer):
    item_type = serializers.SerializerMethodField()
    is_produced = serializers.SerializerMethodField()
    recipe = serializers.JSONField(required=False)
    is_kitchen_item = serializers.SerializerMethodField()

    class Meta:
        model = TakeOrderItem
        fields = [
            'id', 'inventory_item_id', 'menu_item_id', 'name', 'quantity', 'price', 'notes',
            'recipe', 'is_prepared_menu_item',
            'selected_options', 'item_type', 'is_produced', 'is_kitchen_item',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted_data = data.copy()
            if 'selectedOptions' in converted_data and 'selected_options' not in converted_data:
                converted_data['selected_options'] = converted_data.pop('selectedOptions')
            if 'menuItemId' in converted_data and 'menu_item_id' not in converted_data:
                converted_data['menu_item_id'] = converted_data.pop('menuItemId')
            if 'isPreparedMenuItem' in converted_data and 'is_prepared_menu_item' not in converted_data:
                converted_data['is_prepared_menu_item'] = converted_data.pop('isPreparedMenuItem')
            return super().to_internal_value(converted_data)
        return super().to_internal_value(data)

    def _get_inventory_item(self, obj):
        inventory_item_id = str(getattr(obj, 'inventory_item_id', '') or '').strip()
        if not inventory_item_id:
            return None

        try:
            return InventoryItem.objects.filter(
                id=inventory_item_id,
                business=obj.take_order.business,
                branch=obj.take_order.branch,
            ).first()
        except (ValueError, TypeError):
            return None

    def get_item_type(self, obj):
        inventory_item = self._get_inventory_item(obj)
        return inventory_item.item_type if inventory_item else None

    def get_is_produced(self, obj):
        inventory_item = self._get_inventory_item(obj)
        return bool(inventory_item.is_produced) if inventory_item else False

    def to_representation(self, instance):
        representation = super().to_representation(instance)
        recipe = representation.get('recipe') if isinstance(representation.get('recipe'), list) else []
        if recipe:
            return representation

        inventory_item = self._get_inventory_item(instance)
        representation['recipe'] = inventory_item.recipe if inventory_item and isinstance(inventory_item.recipe, list) else []
        return representation

    def get_is_kitchen_item(self, obj):
        if not _business_supports_kitchen(obj.take_order.business):
            return False

        if bool(getattr(obj, 'is_prepared_menu_item', False)) or bool(getattr(obj, 'recipe', None)):
            return True

        inventory_item = self._get_inventory_item(obj)
        if not inventory_item:
            return False
        return (
            inventory_item.item_type == 'sellable' and
            (bool(inventory_item.is_produced) or bool(inventory_item.recipe))
        )


class TakeOrderSerializer(serializers.ModelSerializer):
    items = TakeOrderItemSerializer(many=True, read_only=True)
    created_by_name = serializers.SerializerMethodField()
    completed_by_name = serializers.SerializerMethodField()
    order_type_display = serializers.CharField(source='get_order_type_display', read_only=True)
    
    class Meta:
        model = TakeOrder
        fields = [
            'id', 'order_number', 'status', 'order_type', 'order_type_display',
            'customer',
            'customer_name', 'customer_phone', 'customer_notes', 'table_number',
            'special_instructions', 'cancellation_reason', 'items', 'created_by', 'created_by_name',
            'completed_by', 'completed_by_name',
            'created_at', 'updated_at', 'completed_at'
        ]
        read_only_fields = [
            'id', 'order_number', 'created_by', 'created_by_name',
            'completed_by', 'completed_by_name', 'created_at', 'updated_at',
        ]
    
    def get_created_by_name(self, obj):
        """Get the name of the user who created the order"""
        if obj.created_by:
            return getattr(obj.created_by, 'full_name', None) or obj.created_by.get_username()
        return None

    def get_completed_by_name(self, obj):
        """Get the name of the user who collected/completed the order."""
        if obj.completed_by:
            return getattr(obj.completed_by, 'full_name', None) or obj.completed_by.get_username()
        return None


class TakeOrderCreateSerializer(serializers.ModelSerializer):
    items = TakeOrderItemSerializer(many=True, write_only=True)
    
    # Read-only fields for response
    id = serializers.CharField(read_only=True)
    order_number = serializers.IntegerField(read_only=True)
    status = serializers.ChoiceField(choices=TakeOrder.STATUS_CHOICES, required=False)
    order_type = serializers.CharField(read_only=True)
    order_type_display = serializers.CharField(source='get_order_type_display', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    completed_by_name = serializers.SerializerMethodField()
    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
    completed_at = serializers.DateTimeField(read_only=True, allow_null=True)
    items_response = TakeOrderItemSerializer(source='items', many=True, read_only=True)
    
    class Meta:
        model = TakeOrder
        fields = [
            'id', 'order_number', 'status', 'order_type', 'order_type_display',
            'customer',
            'customer_name', 'customer_phone', 'customer_notes', 'table_number',
            'special_instructions', 'cancellation_reason', 'items', 'items_response',
            'created_by', 'created_by_name', 'completed_by', 'completed_by_name',
            'created_at', 'updated_at', 'completed_at'
        ]
        read_only_fields = [
            'id', 'order_number', 'order_type', 'order_type_display',
            'created_by', 'created_by_name', 'completed_by', 'completed_by_name',
            'created_at', 'updated_at', 'completed_at',
        ]
    
    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted_data = data.copy()
            if 'customerId' in converted_data and 'customer' not in converted_data:
                converted_data['customer'] = converted_data['customerId']
            return super().to_internal_value(converted_data)
        return super().to_internal_value(data)

    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        status = validated_data.pop('status', 'Pending')
        
        # Get the next order number
        branch = self.context['branch']
        last_order = TakeOrder.objects.filter(branch=branch).order_by('-order_number').first()
        next_order_number = (last_order.order_number + 1) if last_order else 1001
        
        customer = validated_data.get('customer')
        if customer and customer.business_id != branch.business_id:
            raise serializers.ValidationError({
                'customer': 'Selected customer does not belong to this business.'
            })
        if not customer:
            customer = resolve_customer_for_account_payload(
                branch.business,
                branch,
                validated_data,
                create_if_missing=False,
            )
            if customer:
                validated_data['customer'] = customer

        try:
            validate_stock_available_for_order_lines(items_data, branch.business, branch)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict if hasattr(exc, 'message_dict') else str(exc))

        # Create the take order
        take_order = TakeOrder.objects.create(
            order_number=next_order_number,
            branch=branch,
            business=branch.business,
            created_by=self.context['user'],
            status=status,
            **validated_data
        )
        
        # Create items
        for item_data in items_data:
            TakeOrderItem.objects.create(take_order=take_order, **item_data)

        if status in {'Sent to Kitchen', 'Preparing'}:
            has_kitchen_items = any(
                TakeOrderItemSerializer().get_is_kitchen_item(item)
                for item in take_order.items.all()
            )
            if not _business_supports_kitchen(branch.business) or not has_kitchen_items:
                take_order.status = 'Ready'
                take_order.save(update_fields=['status', 'updated_at'])
        
        return take_order

    def get_completed_by_name(self, obj):
        if obj.completed_by:
            return getattr(obj.completed_by, 'full_name', None) or obj.completed_by.get_username()
        return None
    
    def to_representation(self, instance):
        """Return full order data including items"""
        created_by_name = None
        if instance.created_by:
            # Try to get full name, fallback to username
            created_by_name = getattr(instance.created_by, 'full_name', None) or instance.created_by.get_username()
        completed_by_name = None
        if instance.completed_by:
            completed_by_name = getattr(instance.completed_by, 'full_name', None) or instance.completed_by.get_username()
        
        return {
            'id': str(instance.id),
            'order_number': instance.order_number,
            'status': instance.status,
            'order_type': instance.order_type,
            'order_type_display': instance.get_order_type_display(),
            'customer': str(instance.customer_id) if instance.customer_id else None,
            'customer_name': instance.customer_name,
            'customer_phone': instance.customer_phone,
            'customer_notes': instance.customer_notes,
            'table_number': instance.table_number,
            'special_instructions': instance.special_instructions,
            'cancellation_reason': instance.cancellation_reason,
            'items': TakeOrderItemSerializer(instance.items.all(), many=True).data,
            'created_by': str(instance.created_by.id) if instance.created_by else None,
            'created_by_name': created_by_name,
            'completed_by': str(instance.completed_by.id) if instance.completed_by else None,
            'completed_by_name': completed_by_name,
            'created_at': instance.created_at.isoformat(),
            'updated_at': instance.updated_at.isoformat(),
            'completed_at': instance.completed_at.isoformat() if instance.completed_at else None,
        }
