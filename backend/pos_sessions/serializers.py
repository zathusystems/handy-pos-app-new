from rest_framework import serializers
from django.db import transaction
from .models import Session, Order, OrderItem
from .tax_utils import (
    calculate_tax_snapshot,
    get_default_tax_rate,
    lock_tax_rate_on_use,
)
from decimal import Decimal
from django.core.exceptions import ValidationError as DjangoValidationError

from business.customer_accounts import resolve_customer_for_account_payload
from .stock_validation import validate_stock_available_for_order_lines


class OrderItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrderItem
        fields = [
            'id',
            'order',
            'inventory_item_id',
            'menu_item_id',
            'name',
            'quantity',
            'price',
            'notes',
            'recipe',
            'is_prepared_menu_item',
            'selected_options',
            # MRA PRODUCT MAPPING
            'mra_product_code',
            'vat_category',
            # TAX INFORMATION (MRA Compliance - Immutable snapshot)
            'tax_rate',
            'tax_type',
            'tax_calculation_method',
            # CALCULATED TAX AMOUNTS (Immutable snapshot for audit trail)
            'subtotal',
            'tax_amount',
            'total',
            'batch_consumption',
            'created_at',
            'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at', 'order', 'batch_consumption']
    
    def to_internal_value(self, data):
        """Convert camelCase from frontend to snake_case for backend"""
        # Prefer explicit inventoryItemId when present.
        # Some clients also send `id` as an order-item UUID, which must not
        # override inventory reference and break stock decrements.
        item_recipe = data.get('recipe') if isinstance(data.get('recipe'), list) else []
        is_prepared_menu_item = bool(data.get('isPreparedMenuItem') or data.get('is_prepared_menu_item'))
        inventory_item_id = (
            data.get('inventoryItemId')
            or data.get('inventory_item_id')
            or (None if (is_prepared_menu_item or item_recipe) else data.get('id'))
        )

        field_mapping = {
            'createdAt': 'created_at',
            'updatedAt': 'updated_at',
            'mraProductCode': 'mra_product_code',
            'vatCategory': 'vat_category',
            'taxRate': 'tax_rate',
            'taxType': 'tax_type',
            'taxCalculationMethod': 'tax_calculation_method',
            'taxAmount': 'tax_amount',
            'selectedOptions': 'selected_options',
            'menuItemId': 'menu_item_id',
            'isPreparedMenuItem': 'is_prepared_menu_item',
        }

        converted_data = {}
        for key, value in data.items():
            # Avoid mapping `id` directly; we normalize inventory_item_id above.
            if key in {'id', 'inventoryItemId', 'inventory_item_id'}:
                continue
            converted_data[field_mapping.get(key, key)] = value

        converted_data['inventory_item_id'] = inventory_item_id
        return super().to_internal_value(converted_data)


class OrderSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(required=False)
    items = OrderItemSerializer(many=True, required=False)
    eis_sync_state = serializers.SerializerMethodField()
    tip = serializers.DecimalField(max_digits=12, decimal_places=2, required=False, write_only=True)

    class Meta:
        model = Order
        fields = [
            'id',
            'business',
            'branch',
            'session',
            'customer',
            'order_number',
            'order_type',
            'status',
            'payment_method',
            'pump_name',
            'is_invoice_sale',
            'invoice_id',
            'is_paid',
            'customer_name',
            'customer_phone',
            'customer_tin',
            'customer_email',
            'customer_address',
            'customer_notes',
            'buyer_name',
            'buyer_tin',
            'subtotal',
            'total',
            'tip',
            'cogs',
            # Tax snapshot fields (MRA compliance)
            'tax_rate_name',
            'tax_rate_value',
            'tax_type',
            'vat_amount',
            'net_amount',
            'gross_amount',
            # MRA EIS fields (NEW)
            'fiscal_invoice_number',
            'eis_uuid',
            'eis_status',
            'eis_sync_state',
            'eis_submitted_at',
            'qr_code_payload',
            'digital_signature',
            'is_fiscal_locked',
            'created_at',
            'updated_at',
            'items'
        ]
        read_only_fields = ['created_at', 'updated_at', 'business', 'is_invoice_sale', 'invoice_id', 'is_paid', 'fiscal_invoice_number', 'eis_uuid', 'eis_submitted_at', 'qr_code_payload', 'digital_signature', 'is_fiscal_locked']

    def get_eis_sync_state(self, obj):
        status = str(getattr(obj, 'eis_status', '') or '').upper()
        return {
            'PENDING': 'PENDING',
            'SUBMITTED': 'SENDING',
            'ACCEPTED': 'SUCCESS',
            'REJECTED': 'FAILED',
        }.get(status, 'PENDING')
    
    def to_internal_value(self, data):
        """Convert camelCase from frontend to snake_case for backend"""
        # Map camelCase to snake_case
        field_mapping = {
            'orderNumber': 'order_number',
            'branchId': 'branch',
            'sessionId': 'session',
            'customerId': 'customer',
            'customer_id': 'customer',
            'orderType': 'order_type',
            'paymentMethod': 'payment_method',
            'pumpName': 'pump_name',
            'isInvoiceSale': 'is_invoice_sale',
            'invoiceId': 'invoice_id',
            'isPaid': 'is_paid',
            'customerName': 'customer_name',
            'customerPhone': 'customer_phone',
            'customerTin': 'customer_tin',
            'customerEmail': 'customer_email',
            'customerAddress': 'customer_address',
            'customerNotes': 'customer_notes',
            'buyerName': 'buyer_name',
            'buyerTin': 'buyer_tin',
            'createdAt': 'created_at',
            'updatedAt': 'updated_at',
        }
        ignored_extra_fields = {
            'depositAmount',
            'deposit_amount',
            'laybuyDeposit',
            'laybuy_deposit',
            'laybuyPaymentMethod',
            'laybuy_payment_method',
            'laybuyReference',
            'laybuy_reference',
            'laybuyNotes',
            'laybuy_notes',
        }
        
        # Convert camelCase keys to snake_case
        converted_data = {}
        for key, value in data.items():
            if key in ignored_extra_fields:
                continue
            new_key = field_mapping.get(key, key)
            converted_data[new_key] = value
        
        return super().to_internal_value(converted_data)
    
    def create(self, validated_data):
        """Create order with UUID from frontend and calculate tax snapshot"""
        with transaction.atomic():
            from inventory.models import InventoryItem

            # Allow frontend to provide the UUID
            order_id = validated_data.pop('id', None)

            # Extract items before creating order
            items_data = validated_data.pop('items', [])
            tip_amount = Decimal(str(validated_data.pop('tip', 0) or 0))
            if tip_amount < 0:
                tip_amount = Decimal('0.00')

            # Get business from branch if not provided
            branch = validated_data.get('branch')
            if branch and 'business' not in validated_data:
                validated_data['business'] = branch.business

            business = validated_data.get('business')

            provided_customer = validated_data.get('customer')
            if provided_customer and business and provided_customer.business_id != business.id:
                raise serializers.ValidationError({
                    'customer': 'Selected customer does not belong to this business.'
                })

            payment_method = str(validated_data.get('payment_method') or '').strip().lower()
            has_customer_details = any(
                str(validated_data.get(field) or '').strip()
                for field in (
                    'customer_name',
                    'customer_phone',
                    'customer_tin',
                    'customer_email',
                    'customer_address',
                    'buyer_name',
                    'buyer_tin',
                )
            )
            customer_required_payment = payment_method in {'on account', 'laybuy'}
            customer_required_label = 'On Account' if payment_method == 'on account' else 'Laybuy'
            should_resolve_customer = bool(business and (provided_customer or has_customer_details or customer_required_payment))
            if should_resolve_customer:
                try:
                    customer = resolve_customer_for_account_payload(
                        business,
                        branch,
                        validated_data,
                        create_if_missing=True,
                    )
                except DjangoValidationError as exc:
                    raise serializers.ValidationError({'customer': exc.message if hasattr(exc, 'message') else str(exc)})

                if not customer:
                    if customer_required_payment:
                        raise serializers.ValidationError({
                            'customer': f'{customer_required_label} sales require a customer account or customer name/phone.'
                        })
                else:
                    validated_data['customer'] = customer
                    if not validated_data.get('customer_name'):
                        validated_data['customer_name'] = customer.name
                    if not validated_data.get('customer_phone'):
                        validated_data['customer_phone'] = customer.phone
                    if not validated_data.get('customer_tin'):
                        validated_data['customer_tin'] = customer.customer_tin
                    if not validated_data.get('customer_email'):
                        validated_data['customer_email'] = customer.email
                    if not validated_data.get('customer_address'):
                        validated_data['customer_address'] = customer.address

            if customer_required_payment and not validated_data.get('customer'):
                raise serializers.ValidationError({
                    'customer': f'{customer_required_label} sales require a customer account or customer name/phone.'
                })

            if payment_method == 'on account':
                customer = validated_data.get('customer')
                if not customer.account_enabled:
                    raise serializers.ValidationError({
                        'customer': 'This customer account is not enabled for credit sales.'
                    })

                credit_limit = Decimal(str(customer.credit_limit or 0))
                current_balance = Decimal(str(customer.current_balance or 0))
                sale_total = Decimal(str(validated_data.get('total') or 0))
                if credit_limit > 0 and current_balance + sale_total > credit_limit:
                    available_credit = credit_limit - current_balance
                    raise serializers.ValidationError({
                        'customer': f'Credit limit exceeded. Available credit is {available_credit}.'
                    })

            try:
                validate_stock_available_for_order_lines(items_data, business, branch)
            except DjangoValidationError as exc:
                raise serializers.ValidationError(exc.message_dict if hasattr(exc, 'message_dict') else str(exc))

            # Calculate tax snapshot BEFORE creating the order.
            # This captures exact tax values at the moment of sale.
            subtotal = Decimal(str(validated_data.get('subtotal', 0)))
            applied_tax_rate = get_default_tax_rate(business) if business else None
            tax_snapshot = calculate_tax_snapshot(subtotal, business, applied_tax_rate)

            # Apply tax snapshot to validated data
            validated_data['tax_rate_name'] = tax_snapshot['tax_rate_name']
            validated_data['tax_rate_value'] = tax_snapshot['tax_rate_value']
            validated_data['tax_type'] = tax_snapshot['tax_type']
            validated_data['vat_amount'] = tax_snapshot['vat_amount']
            validated_data['net_amount'] = tax_snapshot['net_amount']
            validated_data['gross_amount'] = tax_snapshot['gross_amount']

            # Create the order with tax snapshot fields
            order = Order.objects.create(id=order_id, **validated_data)

            # Create order items
            for item_data in items_data:
                inventory_item_id = str(item_data.get('inventory_item_id') or '').strip()
                item_name = str(item_data.get('name', '') or '').strip()
                item_recipe = item_data.get('recipe') if isinstance(item_data.get('recipe'), list) else []
                is_prepared_menu_item = bool(item_data.get('is_prepared_menu_item'))

                if inventory_item_id:
                    inventory_match = InventoryItem.objects.filter(
                        id=inventory_item_id,
                        business=business,
                        branch=branch,
                    ).first()
                else:
                    inventory_match = None

                if not inventory_match and item_name and not (is_prepared_menu_item or item_recipe):
                    name_matches = list(
                        InventoryItem.objects.filter(
                            name__iexact=item_name,
                            business=business,
                            branch=branch,
                        )[:2]
                    )
                    if len(name_matches) == 1:
                        inventory_item_id = str(name_matches[0].id)

                if inventory_item_id:
                    item_data['inventory_item_id'] = inventory_item_id

                OrderItem.objects.create(order=order, **item_data)

            # Once used in a transaction, lock the tax rate for fiscal immutability.
            lock_tax_rate_on_use(applied_tax_rate)

            if tip_amount > 0 and order.session_id:
                order.session.total_tips = (order.session.total_tips or Decimal('0.00')) + tip_amount
                if str(order.payment_method or '').strip().lower() == 'cash':
                    order.session.expected_cash = (order.session.expected_cash or Decimal('0.00')) + tip_amount
                    order.session.save(update_fields=['total_tips', 'expected_cash', 'updated_at'])
                else:
                    order.session.save(update_fields=['total_tips', 'updated_at'])

            return order


class SessionSerializer(serializers.ModelSerializer):
    orders = OrderSerializer(many=True, read_only=True)
    user_name = serializers.SerializerMethodField()
    user_email = serializers.SerializerMethodField()
    total_sales = serializers.SerializerMethodField()
    total_cash_sales = serializers.SerializerMethodField()
    total_card_sales = serializers.SerializerMethodField()
    total_mobile_money_sales = serializers.SerializerMethodField()
    total_on_account_sales = serializers.SerializerMethodField()
    total_other_sales = serializers.SerializerMethodField()
    total_tips = serializers.SerializerMethodField()
    expected_cash = serializers.SerializerMethodField()

    class Meta:
        model = Session
        fields = [
            'id',
            'business',
            'branch',
            'user',
            'user_name',
            'user_email',
            'status',
            'pump_name',
            'opening_float',
            'expected_cash',
            'actual_cash',
            'closing_float',
            'difference',
            'total_sales',
            'total_cash_sales',
            'total_card_sales',
            'total_mobile_money_sales',
            'total_on_account_sales',
            'total_other_sales',
            'total_tips',
            'opening_stock',
            'closing_stock',
            'started_at',
            'closed_at',
            'created_at',
            'updated_at',
            'orders',
        ]
        read_only_fields = ['id', 'business', 'user', 'user_name', 'created_at', 'updated_at']

    def to_internal_value(self, data):
        """Accept pumpName in camelCase payloads."""
        if isinstance(data, dict) and 'pumpName' in data and 'pump_name' not in data:
            data = {**data, 'pump_name': data.get('pumpName')}
        return super().to_internal_value(data)
    
    def get_user_name(self, obj):
        """Get the user's display name"""
        if obj.user:
            # Try first_name + last_name, then first_name, then email, then phone
            if obj.user.first_name and obj.user.last_name:
                return f"{obj.user.first_name} {obj.user.last_name}"
            elif obj.user.first_name:
                return obj.user.first_name
            elif obj.user.email:
                return obj.user.email
            elif obj.user.phone:
                return obj.user.phone
        return 'Unknown User'
    
    def get_user_email(self, obj):
        """Get the user's email"""
        if obj.user:
            return obj.user.email or ''
        return ''
    
    def get_total_sales(self, obj):
        """Calculate total sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('subtotal'))['subtotal__sum'] or Decimal('0')
        return float(total)
    
    def get_total_cash_sales(self, obj):
        """Calculate cash sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            payment_method='Cash',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        return float(total)
    
    def get_total_card_sales(self, obj):
        """Calculate card sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            payment_method='Card',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        return float(total)
    
    def get_total_mobile_money_sales(self, obj):
        """Calculate mobile money sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            payment_method='Mobile Money',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        return float(total)
    
    def get_total_on_account_sales(self, obj):
        """Calculate on account sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            payment_method='On Account',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        return float(total)
    
    def get_total_other_sales(self, obj):
        """Calculate other sales excluding voided and cancelled orders"""
        from django.db.models import Sum
        total = Order.objects.filter(
            session=obj,
            payment_method='Other',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        return float(total)
    
    def get_total_tips(self, obj):
        """Return the session's synced tip total.

        Tips are tracked on the session aggregate because the backend Order model
        no longer stores a per-order tip field.
        """
        return float(obj.total_tips or 0)
    
    def get_expected_cash(self, obj):
        """Calculate expected cash (opening float + cash sales) excluding voided orders"""
        from django.db.models import Sum
        cash_sales = Order.objects.filter(
            session=obj,
            payment_method='Cash',
            status__in=['New', 'Preparing', 'Ready', 'Completed']
        ).aggregate(Sum('total'))['total__sum'] or Decimal('0')
        expected = (obj.opening_float or 0) + cash_sales
        return float(expected)
    
    def to_internal_value(self, data):
        """Convert camelCase from frontend to snake_case for backend"""
        print('[SessionSerializer] Raw data received:', data)
        
        # Map camelCase to snake_case
        field_mapping = {
            'openingFloat': 'opening_float',
            'expectedCash': 'expected_cash',
            'actualCash': 'actual_cash',
            'closingFloat': 'closing_float',
            'totalSales': 'total_sales',
            'totalCashSales': 'total_cash_sales',
            'totalCardSales': 'total_card_sales',
            'totalMobileMoneySales': 'total_mobile_money_sales',
            'totalOnAccountSales': 'total_on_account_sales',
            'totalOtherSales': 'total_other_sales',
            'totalTips': 'total_tips',
            'openingStock': 'opening_stock',
            'closingStock': 'closing_stock',
            'startedAt': 'started_at',
            'closedAt': 'closed_at',
            'createdAt': 'created_at',
            'updatedAt': 'updated_at',
        }
        
        # Convert camelCase keys to snake_case
        converted_data = {}
        for key, value in data.items():
            new_key = field_mapping.get(key, key)
            converted_data[new_key] = value
        
        print('[SessionSerializer] Converted data:', converted_data)
        print('[SessionSerializer] Closing stock in converted data:', converted_data.get('closing_stock'))
        
        try:
            result = super().to_internal_value(converted_data)
            print('[SessionSerializer] Validation result:', result)
            print('[SessionSerializer] Closing stock in validation result:', result.get('closing_stock'))
            return result
        except serializers.ValidationError as e:
            print('[SessionSerializer] Validation error:', e.detail)
            raise
    
    def create(self, validated_data):
        """Create session with UUID from frontend"""
        print('[SessionSerializer] Creating session with validated_data:', validated_data)
        
        # Allow frontend to provide the UUID
        session_id = validated_data.pop('id', None)
        print('[SessionSerializer] Session ID:', session_id)
        
        # expected_cash is a required DB column but exposed as a computed field in the API.
        # Ensure it is always populated on create to prevent NOT NULL integrity failures.
        opening_float = Decimal(str(validated_data.get('opening_float') or 0))
        expected_cash = validated_data.get('expected_cash')
        if expected_cash is None:
            validated_data['expected_cash'] = opening_float
        else:
            validated_data['expected_cash'] = Decimal(str(expected_cash))
        
        # Get user from request context
        request = self.context.get('request')
        if request and request.user:
            validated_data['user'] = request.user
            print('[SessionSerializer] User from request:', request.user)
        else:
            print('[SessionSerializer] WARNING: No user in request context')
        
        print('[SessionSerializer] Remaining validated_data:', validated_data)
        
        # Create the session with the provided UUID
        try:
            if session_id:
                session = Session.objects.create(id=session_id, **validated_data)
            else:
                session = Session.objects.create(**validated_data)
            print('[SessionSerializer] Session created successfully:', session.id)
            return session
        except Exception as e:
            print('[SessionSerializer] Error creating session:', str(e))
            raise
