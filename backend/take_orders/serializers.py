from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from rest_framework import serializers
from .models import TakeOrder, TakeOrderItem
from business.customer_accounts import resolve_customer_for_account_payload
from inventory.models import InventoryItem
from django.core.exceptions import ValidationError as DjangoValidationError
from pos_sessions.stock_validation import validate_stock_available_for_order_lines
from .takeaway import normalise_takeaway_items
from .session_access import get_active_staff_session



ORDER_FULFILLMENT_BUSINESS_TYPES = {'restaurant', 'bar_liquor', 'beauty_salon'}
SALON_SERVICE_BUSINESS_TYPES = {'beauty_salon'}

def _business_supports_order_fulfillment(business):
    return (
        str(getattr(business, 'business_type', '') or '').strip().lower()
        in ORDER_FULFILLMENT_BUSINESS_TYPES
    )


def _business_uses_service_dockets(business):
    return (
        str(getattr(business, 'business_type', '') or '').strip().lower()
        in SALON_SERVICE_BUSINESS_TYPES
    )


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
            'selected_options', 'is_takeaway_packaging', 'item_type', 'is_produced', 'is_kitchen_item',
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
            if 'isTakeawayPackaging' in converted_data and 'is_takeaway_packaging' not in converted_data:
                converted_data['is_takeaway_packaging'] = converted_data.pop('isTakeawayPackaging')
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
        if getattr(instance, 'is_takeaway_packaging', False):
            representation['recipe'] = []
            return representation
        recipe = representation.get('recipe') if isinstance(representation.get('recipe'), list) else []
        if recipe:
            return representation

        inventory_item = self._get_inventory_item(instance)
        representation['recipe'] = inventory_item.recipe if inventory_item and isinstance(inventory_item.recipe, list) else []
        return representation

    def get_is_kitchen_item(self, obj):
        if getattr(obj, 'is_takeaway_packaging', False):
            return False
        if not _business_supports_order_fulfillment(obj.take_order.business):
            return False

        # A salon service docket intentionally includes every service line.
        # The client-side label is changed to "Service"; this field name stays
        # stable for existing sync clients and historical orders.
        if _business_uses_service_dockets(obj.take_order.business):
            return True

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
    cancelled_by_name = serializers.SerializerMethodField()
    order_type_display = serializers.CharField(source='get_order_type_display', read_only=True)
    appointment_settlement = serializers.SerializerMethodField()
    
    class Meta:
        model = TakeOrder
        fields = [
            'id', 'order_number', 'status', 'order_type', 'order_type_display',
            'session',
            'customer',
            'customer_name', 'customer_phone', 'customer_notes', 'table_number',
            'special_instructions', 'cancellation_reason', 'is_takeaway', 'items', 'created_by', 'created_by_name',
            'completed_by', 'completed_by_name',
            'cancelled_by', 'cancelled_by_name', 'created_at', 'updated_at', 'completed_at', 'cancelled_at',
            'kitchen_ticket_printed', 'kitchen_ticket_printed_at',
            'appointment_settlement',
        ]
        read_only_fields = [
            'id', 'order_number', 'created_by', 'created_by_name',
            'session',
            'completed_by', 'completed_by_name', 'cancelled_by', 'cancelled_by_name', 'created_at', 'updated_at',
            'kitchen_ticket_printed', 'kitchen_ticket_printed_at',
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

    def get_cancelled_by_name(self, obj):
        if obj.cancelled_by:
            return getattr(obj.cancelled_by, 'full_name', None) or obj.cancelled_by.get_username()
        return None

    def get_appointment_settlement(self, obj):
        try:
            appointment = obj.appointment
        except Exception:
            return None
        if not appointment or not appointment.customer_id:
            return None

        deposits = list(appointment.deposits.all())
        try:
            deposit_total = sum((Decimal(str(deposit.amount or 0)) for deposit in deposits), Decimal('0.00'))
        except (InvalidOperation, TypeError, ValueError):
            deposit_total = Decimal('0.00')
        deposit_total = deposit_total.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        return {
            'appointment_id': str(appointment.id),
            'take_order_id': str(obj.id),
            'customer_id': str(appointment.customer_id),
            'customer_name': appointment.customer.name,
            'customer_phone': appointment.customer.phone,
            'deposit_total': str(deposit_total),
        }


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
    cancelled_by_name = serializers.SerializerMethodField()
    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
    completed_at = serializers.DateTimeField(read_only=True, allow_null=True)
    items_response = TakeOrderItemSerializer(source='items', many=True, read_only=True)
    
    class Meta:
        model = TakeOrder
        fields = [
            'id', 'order_number', 'status', 'order_type', 'order_type_display',
            'session',
            'customer',
            'customer_name', 'customer_phone', 'customer_notes', 'table_number',
            'special_instructions', 'cancellation_reason', 'is_takeaway', 'items', 'items_response',
            'created_by', 'created_by_name', 'completed_by', 'completed_by_name',
            'cancelled_by', 'cancelled_by_name', 'created_at', 'updated_at', 'completed_at', 'cancelled_at',
            'kitchen_ticket_printed', 'kitchen_ticket_printed_at',
        ]
        read_only_fields = [
            'id', 'order_number', 'order_type', 'order_type_display',
            'session',
            'created_by', 'created_by_name', 'completed_by', 'completed_by_name', 'cancelled_by', 'cancelled_by_name',
            'created_at', 'updated_at', 'completed_at',
            'kitchen_ticket_printed', 'kitchen_ticket_printed_at',
        ]
    
    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted_data = data.copy()
            if 'customerId' in converted_data and 'customer' not in converted_data:
                converted_data['customer'] = converted_data['customerId']
            if 'isTakeaway' in converted_data and 'is_takeaway' not in converted_data:
                converted_data['is_takeaway'] = converted_data['isTakeaway']
            return super().to_internal_value(converted_data)
        return super().to_internal_value(data)

    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        status = validated_data.pop('status', 'Pending')
        
        branch = self.context['branch']
        active_session = get_active_staff_session(
            user=self.context['user'],
            business=branch.business,
            branch=branch,
        )
        if not active_session:
            raise serializers.ValidationError({
                'detail': 'Start an active session before taking orders for this branch.'
            })

        try:
            items_data, is_takeaway = normalise_takeaway_items(
                items_data,
                branch,
                validated_data.get('is_takeaway', False),
            )
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict if hasattr(exc, 'message_dict') else str(exc))
        validated_data['is_takeaway'] = is_takeaway
        next_order_number = TakeOrder.next_order_number_for_branch(branch)
        
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
            session=active_session,
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
            if not _business_supports_order_fulfillment(branch.business) or not has_kitchen_items:
                take_order.status = 'Ready'
                take_order.save(update_fields=['status', 'updated_at'])
        
        return take_order

    def get_completed_by_name(self, obj):
        if obj.completed_by:
            return getattr(obj.completed_by, 'full_name', None) or obj.completed_by.get_username()
        return None

    def get_cancelled_by_name(self, obj):
        if obj.cancelled_by:
            return getattr(obj.cancelled_by, 'full_name', None) or obj.cancelled_by.get_username()
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
        cancelled_by_name = None
        if instance.cancelled_by:
            cancelled_by_name = getattr(instance.cancelled_by, 'full_name', None) or instance.cancelled_by.get_username()
        
        return {
            'id': str(instance.id),
            'order_number': instance.order_number,
            'status': instance.status,
            'order_type': instance.order_type,
            'order_type_display': instance.get_order_type_display(),
            'session': str(instance.session_id) if instance.session_id else None,
            'customer': str(instance.customer_id) if instance.customer_id else None,
            'customer_name': instance.customer_name,
            'customer_phone': instance.customer_phone,
            'customer_notes': instance.customer_notes,
            'table_number': instance.table_number,
            'is_takeaway': instance.is_takeaway,
            'special_instructions': instance.special_instructions,
            'cancellation_reason': instance.cancellation_reason,
            'items': TakeOrderItemSerializer(instance.items.all(), many=True).data,
            'created_by': str(instance.created_by.id) if instance.created_by else None,
            'created_by_name': created_by_name,
            'completed_by': str(instance.completed_by.id) if instance.completed_by else None,
            'completed_by_name': completed_by_name,
            'cancelled_by': str(instance.cancelled_by.id) if instance.cancelled_by else None,
            'cancelled_by_name': cancelled_by_name,
            'created_at': instance.created_at.isoformat(),
            'updated_at': instance.updated_at.isoformat(),
            'completed_at': instance.completed_at.isoformat() if instance.completed_at else None,
            'cancelled_at': instance.cancelled_at.isoformat() if instance.cancelled_at else None,
            'kitchen_ticket_printed': instance.kitchen_ticket_printed,
            'kitchen_ticket_printed_at': instance.kitchen_ticket_printed_at.isoformat() if instance.kitchen_ticket_printed_at else None,
        }
