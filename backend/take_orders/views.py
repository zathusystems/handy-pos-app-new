from rest_framework import viewsets, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, AllowAny
import re
from datetime import timedelta

from django.utils import timezone
from django.core.exceptions import ValidationError as DjangoValidationError
from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
from django.views.decorators.http import require_GET
from .models import TakeOrder, TakeOrderItem
from .serializers import TakeOrderSerializer, TakeOrderCreateSerializer, TakeOrderItemSerializer
from business.models import Branch
from inventory.models import InventoryItem
from pos_sessions.stock_validation import validate_stock_available_for_order_lines


KITCHEN_BUSINESS_TYPES = {'restaurant', 'bar_liquor'}
PUBLIC_ORDER_LOOKUP_DAYS = 30
PUBLIC_ORDER_LOOKUP_LIMIT = 25


def _business_supports_kitchen(business):
    return str(getattr(business, 'business_type', '') or '').strip().lower() in KITCHEN_BUSINESS_TYPES


def _take_order_has_kitchen_items(take_order):
    """Kitchen tickets should contain prepared/recipe-backed sellable items only."""
    if not _business_supports_kitchen(take_order.business):
        return False

    if any(
        bool(item.is_prepared_menu_item) or bool(item.recipe)
        for item in take_order.items.all()
    ):
        return True

    item_ids = [
        str(item.inventory_item_id).strip()
        for item in take_order.items.all()
        if str(item.inventory_item_id or '').strip()
    ]
    if not item_ids:
        return False

    try:
        inventory_items = list(InventoryItem.objects.filter(
            id__in=item_ids,
            business=take_order.business,
            branch=take_order.branch,
            item_type='sellable',
        ))
    except (ValueError, TypeError):
        return False

    inventory_by_id = {str(item.id): item for item in inventory_items}
    for order_item in take_order.items.all():
        inventory_item = inventory_by_id.get(str(order_item.inventory_item_id).strip())
        if inventory_item and (inventory_item.is_produced or bool(inventory_item.recipe)):
            return True

    return False


def _resolve_take_order_status(take_order, requested_status):
    if requested_status in {'Sent to Kitchen', 'Preparing'} and not _business_supports_kitchen(take_order.business):
        return 'Ready'

    if requested_status == 'Sent to Kitchen' and not _take_order_has_kitchen_items(take_order):
        return 'Ready'

    return requested_status


def _django_validation_payload(exc):
    if hasattr(exc, 'message_dict'):
        return exc.message_dict
    if hasattr(exc, 'messages'):
        return {'error': ' '.join(str(message) for message in exc.messages)}
    return {'error': str(exc)}


def _user_can_cancel_take_order(user, take_order):
    if not user or not user.is_authenticated:
        return False
    if getattr(user, 'is_superuser', False):
        return True
    if take_order.business.owner_id == user.id:
        return True
    try:
        from staff.models import Staff, StaffRole
        return Staff.objects.filter(
            user=user,
            business=take_order.business,
            is_active=True,
            role=StaffRole.ADMIN,
        ).exists()
    except Exception:
        return False


def _normalize_phone_lookup(value):
    digits = re.sub(r'\D+', '', str(value or ''))
    return digits[-9:] if len(digits) >= 9 else digits


def _public_take_order_payload(take_order):
    items = list(take_order.items.all())
    total = sum((item.price or 0) * (item.quantity or 0) for item in items)
    try:
        currency = getattr(take_order.business.settings, 'currency', '') or 'MWK'
    except Exception:
        currency = 'MWK'

    return {
        'id': str(take_order.id),
        'business_id': str(take_order.business_id),
        'business_name': getattr(take_order.business, 'name', '') or '',
        'branch_id': str(take_order.branch_id),
        'branch_name': getattr(take_order.branch, 'name', '') or '',
        'currency': currency,
        'order_number': take_order.order_number,
        'status': take_order.status,
        'cancellation_reason': take_order.cancellation_reason,
        'order_type': take_order.order_type,
        'total': float(total),
        'items': [
            {
                'name': item.name,
                'quantity': float(item.quantity or 0),
                'recipe': item.recipe or [],
                'is_prepared_menu_item': item.is_prepared_menu_item,
                'selected_options': item.selected_options or [],
            }
            for item in items
        ],
        'created_at': take_order.created_at.isoformat() if take_order.created_at else None,
        'updated_at': take_order.updated_at.isoformat() if take_order.updated_at else None,
        'completed_at': take_order.completed_at.isoformat() if take_order.completed_at else None,
    }


class TakeOrderViewSet(viewsets.ModelViewSet):
    """ViewSet for managing take orders"""
    permission_classes = [IsAuthenticated]
    serializer_class = TakeOrderSerializer
    
    def get_permissions(self):
        """Override permissions for self_service action"""
        if self.action == 'self_service':
            return [AllowAny()]
        return super().get_permissions()
    
    def get_queryset(self):
        """Filter take orders by branch"""
        branch_id = self.request.query_params.get('branch_id')
        if branch_id:
            return TakeOrder.objects.filter(branch_id=branch_id).prefetch_related('items')
        return TakeOrder.objects.none()
    
    def get_serializer_class(self):
        if self.action == 'create':
            return TakeOrderCreateSerializer
        return TakeOrderSerializer
    
    def retrieve(self, request, *args, **kwargs):
        """Retrieve a single take order by ID"""
        try:
            # Get the take order by pk directly without filtering by branch_id
            take_order = TakeOrder.objects.get(pk=kwargs['pk'])
            serializer = self.get_serializer(take_order)
            return Response(serializer.data)
        except TakeOrder.DoesNotExist:
            return Response(
                {'error': 'Take order not found'},
                status=status.HTTP_404_NOT_FOUND
            )
    
    def create(self, request, *args, **kwargs):
        """Create a new take order"""
        branch_id = request.data.get('branch_id')
        
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return Response(
                {'error': 'Branch not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        serializer = self.get_serializer(
            data=request.data,
            context={'branch': branch, 'user': request.user}
        )
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        
        return Response(serializer.data, status=status.HTTP_201_CREATED)
    
    @action(detail=True, methods=['patch'])
    def update_status(self, request, pk=None):
        """Update take order status"""
        try:
            # Get the take order by pk directly without filtering by branch_id
            # This allows the endpoint to work without requiring branch_id query param
            take_order = TakeOrder.objects.get(pk=pk)
        except TakeOrder.DoesNotExist:
            return Response(
                {'error': 'Take order not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        new_status = request.data.get('status')
        
        if new_status not in dict(TakeOrder.STATUS_CHOICES):
            return Response(
                {'error': 'Invalid status'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        resolved_status = _resolve_take_order_status(take_order, new_status)
        cancellation_reason = str(
            request.data.get('cancellation_reason') or request.data.get('cancellationReason') or ''
        ).strip()
        if resolved_status == 'Cancelled' and not _user_can_cancel_take_order(request.user, take_order):
            return Response(
                {'error': 'Only admin users can cancel orders.'},
                status=status.HTTP_403_FORBIDDEN
            )
        if resolved_status == 'Cancelled' and not cancellation_reason:
            return Response(
                {'cancellation_reason': 'Cancellation reason is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if resolved_status in {'Sent to Kitchen', 'Preparing', 'Ready'}:
            order_lines = [
                {
                    'inventory_item_id': item.inventory_item_id,
                    'menu_item_id': item.menu_item_id,
                    'name': item.name,
                    'quantity': item.quantity,
                    'recipe': item.recipe or [],
                    'is_prepared_menu_item': item.is_prepared_menu_item,
                    'selected_options': item.selected_options or [],
                }
                for item in take_order.items.all()
            ]
            try:
                validate_stock_available_for_order_lines(order_lines, take_order.business, take_order.branch)
            except DjangoValidationError as exc:
                return Response(_django_validation_payload(exc), status=status.HTTP_400_BAD_REQUEST)

        take_order.status = resolved_status
        if resolved_status == 'Cancelled':
            take_order.cancellation_reason = cancellation_reason
        elif take_order.cancellation_reason and resolved_status != 'Cancelled':
            take_order.cancellation_reason = ''
        
        if resolved_status == 'Completed':
            take_order.completed_at = timezone.now()
            take_order.completed_by = request.user
        elif take_order.status != 'Completed':
            take_order.completed_at = None
            take_order.completed_by = None
        
        take_order.save()
        
        return Response(
            TakeOrderSerializer(take_order).data,
            status=status.HTTP_200_OK
        )

    @action(detail=True, methods=['post'])
    def add_items(self, request, pk=None):
        """Append items to an open take order before sale processing."""
        try:
            take_order = TakeOrder.objects.prefetch_related('items').get(pk=pk)
        except TakeOrder.DoesNotExist:
            return Response(
                {'error': 'Take order not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        if take_order.status in {'Completed', 'Cancelled'}:
            return Response(
                {'error': 'Items cannot be added to completed or cancelled orders.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        items_data = request.data.get('items', [])
        if not isinstance(items_data, list) or len(items_data) == 0:
            return Response(
                {'items': 'At least one item is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        item_serializer = TakeOrderItemSerializer(data=items_data, many=True)
        item_serializer.is_valid(raise_exception=True)
        validated_items = item_serializer.validated_data

        try:
            validate_stock_available_for_order_lines(validated_items, take_order.business, take_order.branch)
        except DjangoValidationError as exc:
            return Response(_django_validation_payload(exc), status=status.HTTP_400_BAD_REQUEST)

        for item_data in validated_items:
            TakeOrderItem.objects.create(take_order=take_order, **item_data)

        take_order.save(update_fields=['updated_at'])

        take_order.refresh_from_db()
        serializer = TakeOrderSerializer(take_order)
        return Response(serializer.data, status=status.HTTP_200_OK)
    
    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def pending(self, request):
        """Get all pending take orders for a branch"""
        branch_id = request.query_params.get('branch_id')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        pending_orders = self.get_queryset().filter(
            branch_id=branch_id,
            status__in=['Confirmed', 'Sent to Kitchen', 'Preparing']
        )
        
        serializer = self.get_serializer(pending_orders, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def today(self, request):
        """Get all take orders created today for a branch"""
        branch_id = request.query_params.get('branch_id')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        today_orders = self.get_queryset().filter(
            branch_id=branch_id,
            created_at__date=timezone.now().date()
        )
        
        serializer = self.get_serializer(today_orders, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['post'], permission_classes=[AllowAny])
    def self_service(self, request):
        """Create a self-service order from public menu - NO AUTHENTICATION REQUIRED"""
        branch_id = request.data.get('branch_id')
        customer_name = request.data.get('customer_name')
        customer_phone = request.data.get('customer_phone')
        table_number = request.data.get('table_number')
        items = request.data.get('items', [])
        special_instructions = request.data.get('special_instructions', '')
        
        # Validate required fields
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        if not customer_name:
            return Response(
                {'error': 'customer_name is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        if not items or len(items) == 0:
            return Response(
                {'error': 'At least one item is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return Response(
                {'error': 'Branch not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        next_order_number = TakeOrder.next_order_number_for_branch(branch)
        
        # Create the take order (self-service, so no created_by user)
        take_order = TakeOrder.objects.create(
            order_number=next_order_number,
            branch=branch,
            business=branch.business,
            customer_name=customer_name,
            customer_phone=customer_phone,
            customer_notes=customer_phone or None,  # Store phone in notes for reference
            table_number=table_number,  # Store table number in dedicated field
            special_instructions=special_instructions,
            created_by=None,  # Self-service order, no user
            order_type='self_service',  # Mark as self-service
            status='Pending'
        )
        
        # Create items
        for item_data in items:
            TakeOrderItem.objects.create(
                take_order=take_order,
                inventory_item_id=item_data.get('inventory_item_id') or item_data.get('inventoryItemId') or '',
                menu_item_id=item_data.get('menu_item_id') or item_data.get('menuItemId') or '',
                name=item_data.get('name'),
                quantity=item_data.get('quantity'),
                price=item_data.get('price'),
                recipe=item_data.get('recipe') or [],
                is_prepared_menu_item=bool(item_data.get('is_prepared_menu_item') or item_data.get('isPreparedMenuItem')),
                selected_options=item_data.get('selected_options') or item_data.get('selectedOptions') or [],
                notes=item_data.get('notes', '')
            )
        
        print(f"[TakeOrder] Self-service order created: #{take_order.order_number} for {customer_name}")
        return Response(_public_take_order_payload(take_order), status=status.HTTP_201_CREATED)


@csrf_exempt
def self_service_order(request):
    """Create a self-service order from public menu - NO AUTHENTICATION REQUIRED"""
    import json
    
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    
    print(f"[TakeOrder] self_service_order called")
    
    try:
        data = json.loads(request.body)
        branch_id = data.get('branch_id')
        customer_name = data.get('customer_name')
        customer_phone = data.get('customer_phone')
        table_number = data.get('table_number')
        items = data.get('items', [])
        special_instructions = data.get('special_instructions', '')
        
        # Validate required fields
        if not branch_id:
            return JsonResponse({'error': 'branch_id is required'}, status=400)
        
        if not customer_name:
            return JsonResponse({'error': 'customer_name is required'}, status=400)
        
        if not items or len(items) == 0:
            return JsonResponse({'error': 'At least one item is required'}, status=400)
        
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return JsonResponse({'error': 'Branch not found'}, status=404)

        next_order_number = TakeOrder.next_order_number_for_branch(branch)
        
        # Create the take order (self-service, so no created_by user)
        take_order = TakeOrder.objects.create(
            order_number=next_order_number,
            branch=branch,
            business=branch.business,
            customer_name=customer_name,
            customer_phone=customer_phone,
            customer_notes=customer_phone or None,  # Store phone in notes for reference
            table_number=table_number,  # Store table number in dedicated field
            special_instructions=special_instructions,
            created_by=None,  # Self-service order, no user
            order_type='self_service',  # Mark as self-service
            status='Pending'
        )
        
        # Create items
        for item_data in items:
            TakeOrderItem.objects.create(
                take_order=take_order,
                inventory_item_id=item_data.get('inventory_item_id') or item_data.get('inventoryItemId') or '',
                menu_item_id=item_data.get('menu_item_id') or item_data.get('menuItemId') or '',
                name=item_data.get('name'),
                quantity=item_data.get('quantity'),
                price=item_data.get('price'),
                recipe=item_data.get('recipe') or [],
                is_prepared_menu_item=bool(item_data.get('is_prepared_menu_item') or item_data.get('isPreparedMenuItem')),
                selected_options=item_data.get('selected_options') or item_data.get('selectedOptions') or [],
                notes=item_data.get('notes', '')
            )
        
        print(f"[TakeOrder] Self-service order created: #{take_order.order_number} for {customer_name}")
        return JsonResponse(_public_take_order_payload(take_order), status=201)
    
    except Exception as e:
        print(f"[TakeOrder] Error creating self-service order: {str(e)}")
        import traceback
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=400)


@require_GET
def public_order_status(request, order_id):
    """Return a minimal public order status for same-device customer tracking."""
    branch_id = request.GET.get('branch_id')
    if not branch_id:
        return JsonResponse({'error': 'branch_id is required'}, status=400)

    try:
        take_order = TakeOrder.objects.prefetch_related('items').get(
            id=order_id,
            branch_id=branch_id,
            order_type='self_service',
        )
    except (TakeOrder.DoesNotExist, ValueError, TypeError):
        return JsonResponse({'error': 'Order not found'}, status=404)

    return JsonResponse(_public_take_order_payload(take_order))


@require_GET
def public_order_phone_lookup(request):
    """Find recent self-service orders by phone across Handy POS businesses."""
    phone = request.GET.get('phone')
    normalized_phone = _normalize_phone_lookup(phone)
    if len(normalized_phone) < 7:
        return JsonResponse({'error': 'Enter a valid phone number.'}, status=400)

    since = timezone.now() - timedelta(days=PUBLIC_ORDER_LOOKUP_DAYS)
    candidates = TakeOrder.objects.select_related('business', 'branch').prefetch_related('items').filter(
        order_type='self_service',
        created_at__gte=since,
    ).exclude(customer_phone__isnull=True).exclude(customer_phone='')

    matched_orders = []
    for order in candidates.iterator(chunk_size=200):
        if _normalize_phone_lookup(order.customer_phone) != normalized_phone:
            continue
        matched_orders.append(order)
        if len(matched_orders) >= PUBLIC_ORDER_LOOKUP_LIMIT:
            break

    return JsonResponse({
        'orders': [_public_take_order_payload(order) for order in matched_orders],
        'count': len(matched_orders),
    })
