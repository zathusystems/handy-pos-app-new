from decimal import Decimal, ROUND_HALF_UP

from rest_framework import serializers

from business.models import Branch, Customer
from inventory.models import InventoryItem

from .models import Appointment, AppointmentDeposit


MONEY_QUANT = Decimal('0.01')
QUANTITY_QUANT = Decimal('0.001')


class AppointmentServiceInputSerializer(serializers.Serializer):
    inventory_item_id = serializers.UUIDField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal('0.001'))

    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted = data.copy()
            if 'inventoryItemId' in converted and 'inventory_item_id' not in converted:
                converted['inventory_item_id'] = converted['inventoryItemId']
            return super().to_internal_value(converted)
        return super().to_internal_value(data)


class AppointmentWriteSerializer(serializers.Serializer):
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    customer = serializers.PrimaryKeyRelatedField(queryset=Customer.objects.all())
    scheduled_start = serializers.DateTimeField()
    scheduled_end = serializers.DateTimeField()
    services = AppointmentServiceInputSerializer(many=True, allow_empty=False)
    notes = serializers.CharField(required=False, allow_blank=True, max_length=5000)

    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted = data.copy()
            aliases = {
                'branchId': 'branch',
                'customerId': 'customer',
                'scheduledStart': 'scheduled_start',
                'scheduledEnd': 'scheduled_end',
            }
            for source, target in aliases.items():
                if source in converted and target not in converted:
                    converted[target] = converted[source]
            return super().to_internal_value(converted)
        return super().to_internal_value(data)

    def validate(self, attrs):
        business = self.context['business']
        branch = attrs['branch']
        customer = attrs['customer']
        if branch.business_id != business.id:
            raise serializers.ValidationError({'branch': 'The selected branch is not available for this business.'})
        if customer.business_id != business.id:
            raise serializers.ValidationError({'customer': 'The selected customer is not available for this business.'})
        if customer.branch_id and customer.branch_id != branch.id:
            raise serializers.ValidationError({'customer': 'The selected customer belongs to another branch.'})
        if not customer.is_active:
            raise serializers.ValidationError({'customer': 'The selected customer is inactive.'})
        if attrs['scheduled_end'] <= attrs['scheduled_start']:
            raise serializers.ValidationError({'scheduled_end': 'The end time must be after the start time.'})

        requested_services = attrs['services']
        service_ids = [entry['inventory_item_id'] for entry in requested_services]
        inventory_items = InventoryItem.objects.filter(
            id__in=service_ids,
            business=business,
            branch=branch,
            item_type='sellable',
            is_service=True,
        )
        by_id = {item.id: item for item in inventory_items}
        missing_ids = [str(service_id) for service_id in service_ids if service_id not in by_id]
        if missing_ids:
            raise serializers.ValidationError({
                'services': 'Each appointment service must be an active salon service from this branch.'
            })

        snapshots = []
        total = Decimal('0.00')
        for service in requested_services:
            item = by_id[service['inventory_item_id']]
            quantity = Decimal(service['quantity']).quantize(QUANTITY_QUANT, rounding=ROUND_HALF_UP)
            price = Decimal(item.price or 0).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            line_total = (price * quantity).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            total += line_total
            snapshots.append({
                'inventory_item_id': str(item.id),
                'name': item.name,
                'category': item.category or '',
                'quantity': str(quantity),
                'price': str(price),
                'total': str(line_total),
                'recipe': item.recipe if isinstance(item.recipe, list) else [],
            })

        attrs['service_snapshots'] = snapshots
        attrs['computed_total'] = total.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
        return attrs


class AppointmentSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source='customer.name', read_only=True)
    customer_phone = serializers.CharField(source='customer.phone', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    take_order_id = serializers.UUIDField(source='take_order.id', read_only=True, allow_null=True)
    take_order_number = serializers.IntegerField(source='take_order.order_number', read_only=True, allow_null=True)
    take_order_status = serializers.CharField(source='take_order.status', read_only=True, allow_null=True)
    created_by_name = serializers.SerializerMethodField()
    checked_in_by_name = serializers.SerializerMethodField()
    cancelled_by_name = serializers.SerializerMethodField()
    no_show_by_name = serializers.SerializerMethodField()
    deposits = serializers.SerializerMethodField()
    deposit_total = serializers.SerializerMethodField()
    balance_due = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = [
            'id', 'business', 'branch', 'branch_name', 'customer', 'customer_name', 'customer_phone',
            'take_order_id', 'take_order_number', 'take_order_status',
            'scheduled_start', 'scheduled_end', 'status', 'services', 'total', 'notes',
            'created_by', 'created_by_name', 'checked_in_by', 'checked_in_by_name',
            'cancelled_by', 'cancelled_by_name', 'cancelled_at', 'cancellation_reason',
            'no_show_by', 'no_show_by_name', 'no_show_at', 'no_show_reason',
            'deposits', 'deposit_total', 'balance_due',
            'checked_in_at', 'completed_at', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    @staticmethod
    def _user_name(user):
        if not user:
            return None
        return getattr(user, 'full_name', None) or user.get_username()

    def get_created_by_name(self, obj):
        return self._user_name(obj.created_by)

    def get_checked_in_by_name(self, obj):
        return self._user_name(obj.checked_in_by)

    def get_cancelled_by_name(self, obj):
        return self._user_name(obj.cancelled_by)

    def get_no_show_by_name(self, obj):
        return self._user_name(obj.no_show_by)

    def _deposits(self, obj):
        cache = getattr(obj, '_prefetched_objects_cache', {})
        return cache.get('deposits') if 'deposits' in cache else obj.deposits.all()

    def get_deposits(self, obj):
        return AppointmentDepositSerializer(self._deposits(obj), many=True).data

    def get_deposit_total(self, obj):
        total = sum((Decimal(str(deposit.amount or 0)) for deposit in self._deposits(obj)), Decimal('0.00'))
        return total.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

    def get_balance_due(self, obj):
        total = Decimal(str(obj.total or 0))
        deposit_total = sum((Decimal(str(deposit.amount or 0)) for deposit in self._deposits(obj)), Decimal('0.00'))
        return max(Decimal('0.00'), total - deposit_total).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


class AppointmentDepositSerializer(serializers.ModelSerializer):
    recorded_by_name = serializers.SerializerMethodField()
    payment_transaction_id = serializers.UUIDField(source='payment_transaction.id', read_only=True)

    class Meta:
        model = AppointmentDeposit
        fields = [
            'id', 'amount', 'payment_method', 'reference', 'notes',
            'recorded_by', 'recorded_by_name', 'payment_transaction_id', 'created_at',
        ]
        read_only_fields = fields

    def get_recorded_by_name(self, obj):
        user = obj.recorded_by
        if not user:
            return None
        return getattr(user, 'full_name', None) or user.get_username()


class AppointmentDepositWriteSerializer(serializers.Serializer):
    PAYMENT_METHODS = [
        ('Cash', 'Cash'),
        ('Card', 'Card'),
        ('Mobile Money', 'Mobile Money'),
        ('Bank Transfer', 'Bank Transfer'),
        ('Other', 'Other'),
    ]

    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal('0.01'))
    payment_method = serializers.ChoiceField(choices=PAYMENT_METHODS, default='Cash')
    reference = serializers.CharField(required=False, allow_blank=True, max_length=120)
    notes = serializers.CharField(required=False, allow_blank=True, max_length=5000)

    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted = data.copy()
            aliases = {
                'paymentMethod': 'payment_method',
                'paymentReference': 'reference',
            }
            for source, target in aliases.items():
                if source in converted and target not in converted:
                    converted[target] = converted[source]
            return super().to_internal_value(converted)
        return super().to_internal_value(data)
