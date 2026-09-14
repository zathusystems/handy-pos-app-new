from decimal import Decimal, ROUND_HALF_UP

from rest_framework import serializers
from django.db.models import Q

from business.models import Branch, Customer
from inventory.models import InventoryItem

from .models import Appointment, AppointmentDeposit

MONEY_QUANT = Decimal('0.01')
QUANTITY_QUANT = Decimal('0.001')


class AppointmentServiceInputSerializer(serializers.Serializer):
    # New appointments select the menu entry so its item-specific choices stay
    # available. inventory_item_id remains for appointments created by older
    # clients and existing saved bookings.
    inventory_item_id = serializers.UUIDField(required=False)
    menu_item_id = serializers.UUIDField(required=False)
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal('0.001'))
    selected_option_ids = serializers.DictField(
        child=serializers.ListField(child=serializers.UUIDField()),
        required=False,
        default=dict,
    )

    def to_internal_value(self, data):
        if isinstance(data, dict):
            converted = data.copy()
            if 'inventoryItemId' in converted and 'inventory_item_id' not in converted:
                converted['inventory_item_id'] = converted['inventoryItemId']
            if 'menuItemId' in converted and 'menu_item_id' not in converted:
                converted['menu_item_id'] = converted['menuItemId']
            if 'selectedOptionIds' in converted and 'selected_option_ids' not in converted:
                converted['selected_option_ids'] = converted['selectedOptionIds']
            return super().to_internal_value(converted)
        return super().to_internal_value(data)

    def validate(self, attrs):
        inventory_item_id = attrs.get('inventory_item_id')
        menu_item_id = attrs.get('menu_item_id')
        if not inventory_item_id and not menu_item_id:
            raise serializers.ValidationError('Choose a service from the menu.')
        if inventory_item_id and menu_item_id:
            raise serializers.ValidationError('Choose either a menu item or an inventory service, not both.')
        return attrs


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
        menu_ids = [entry['menu_item_id'] for entry in requested_services if entry.get('menu_item_id')]
        inventory_ids = [entry['inventory_item_id'] for entry in requested_services if entry.get('inventory_item_id')]

        from digitalmenu.models import Menu, MenuOptionGroup
        from digitalmenu.utils import resolve_menu_options

        menu_items = Menu.objects.filter(
            id__in=menu_ids,
            business=business,
            branch=branch,
            is_visible=True,
        ).select_related('inventory_item')
        menu_by_id = {menu.id: menu for menu in menu_items}
        missing_menu_ids = [str(menu_id) for menu_id in menu_ids if menu_id not in menu_by_id]
        if missing_menu_ids:
            raise serializers.ValidationError({
                'services': 'Each appointment service must be a visible menu item from this branch.'
            })

        # Legacy inventory-only requests remain supported for already-installed
        # desktop apps. New appointment screens send menu_item_id instead.
        inventory_items = InventoryItem.objects.filter(
            id__in=inventory_ids,
            business=business,
            branch=branch,
            item_type='sellable',
            is_service=True,
        )
        inventory_by_id = {item.id: item for item in inventory_items}
        missing_inventory_ids = [str(item_id) for item_id in inventory_ids if item_id not in inventory_by_id]
        if missing_inventory_ids:
            raise serializers.ValidationError({
                'services': 'Each inventory appointment service must be an active salon service from this branch.'
            })

        def option_snapshots(menu, selected_option_ids):
            groups = list(MenuOptionGroup.objects.filter(
                Q(menu=menu) | Q(menu_assignments__menu=menu),
                is_visible=True,
            ).distinct().prefetch_related('options__linked_inventory_item', 'menu_assignments').order_by('sort_order', 'created_at'))
            groups_by_id = {str(group.id): group for group in groups}
            requested_by_group = {
                str(group_id): [str(option_id) for option_id in option_ids]
                for group_id, option_ids in (selected_option_ids or {}).items()
            }
            unknown_group_ids = set(requested_by_group) - set(groups_by_id)
            if unknown_group_ids:
                raise serializers.ValidationError({
                    'services': 'One or more selected choices do not belong to this menu item.'
                })

            snapshots = []
            for group in groups:
                group_id = str(group.id)
                requested_ids = requested_by_group.get(group_id, [])
                if len(requested_ids) != len(set(requested_ids)):
                    raise serializers.ValidationError({
                        'services': f'{group.name} contains the same choice more than once.'
                    })

                available_options = {
                    str(resolved['source'].id): resolved
                    for resolved in resolve_menu_options(group, menu, visible_only=True)
                }
                unknown_option_ids = set(requested_ids) - set(available_options)
                if unknown_option_ids:
                    raise serializers.ValidationError({
                        'services': f'One or more selected choices are unavailable for {group.name}.'
                    })

                min_select = max(1, int(group.min_select or 0)) if group.is_required else int(group.min_select or 0)
                max_select = max(1, int(group.max_select or 1))
                if len(requested_ids) < min_select or len(requested_ids) > max_select:
                    raise serializers.ValidationError({
                        'services': f'{group.name} requires between {min_select} and {max_select} choice(s).'
                    })

                for option_id in requested_ids:
                    resolved = available_options[option_id]
                    option = resolved['source']
                    values = resolved['values']
                    linked_item = resolved.get('linked_inventory_item')
                    snapshots.append({
                        'id': str(option.id),
                        'group_id': group_id,
                        'group_name': group.name,
                        'group_type': group.group_type,
                        'name': values.get('name') or option.name,
                        'description': values.get('description') or '',
                        'quantity': 1,
                        'price_mode': values.get('price_mode') or 'delta',
                        'price_delta': str(values.get('price_delta') or 0),
                        'price_override': (
                            str(values.get('price_override'))
                            if values.get('price_override') is not None else None
                        ),
                        'recipe': values.get('recipe') if isinstance(values.get('recipe'), list) else [],
                        'linked_inventory_item': str(values.get('linked_inventory_item') or ''),
                        'linked_inventory_item_name': linked_item.name if linked_item else '',
                        'linked_inventory_quantity': str(values.get('linked_inventory_quantity') or 0),
                    })
            return snapshots

        def selected_price(base_price, selected_options):
            price = Decimal(str(base_price or 0)).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            for option in selected_options:
                if str(option.get('price_mode') or '').lower() == 'override' and option.get('price_override') is not None:
                    price = Decimal(str(option['price_override'])).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
                else:
                    price += Decimal(str(option.get('price_delta') or 0)).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            return max(Decimal('0.00'), price).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

        snapshots = []
        total = Decimal('0.00')
        for service in requested_services:
            quantity = Decimal(service['quantity']).quantize(QUANTITY_QUANT, rounding=ROUND_HALF_UP)
            menu = menu_by_id.get(service.get('menu_item_id'))
            if menu:
                item = menu.inventory_item
                if not item:
                    raise serializers.ValidationError({
                        'services': 'This menu item is not linked to a sellable product and cannot be used for an appointment.'
                    })
                selected_options = option_snapshots(menu, service.get('selected_option_ids'))
                price = selected_price(menu.display_price, selected_options)
                recipe = menu.display_recipe
                menu_item_id = str(menu.id)
                is_prepared_menu_item = bool(menu.is_prepared_item or not menu.inventory_item_id)
                name = menu.display_name
                category = menu.display_category
            else:
                item = inventory_by_id[service['inventory_item_id']]
                selected_options = []
                price = Decimal(item.price or 0).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
                recipe = item.recipe if isinstance(item.recipe, list) else []
                menu_item_id = ''
                is_prepared_menu_item = False
                name = item.name
                category = item.category or ''
            line_total = (price * quantity).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            total += line_total
            snapshots.append({
                'inventory_item_id': str(item.id),
                'menu_item_id': menu_item_id,
                'name': name,
                'category': category or '',
                'quantity': str(quantity),
                'price': str(price),
                'total': str(line_total),
                'recipe': recipe if isinstance(recipe, list) else [],
                'is_prepared_menu_item': is_prepared_menu_item,
                'selected_options': selected_options,
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
    settled_order_id = serializers.UUIDField(source='settled_order.id', read_only=True, allow_null=True)
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
            'take_order_id', 'take_order_number', 'take_order_status', 'settled_order_id',
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
        if obj.settled_order_id:
            return Decimal('0.00')
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
