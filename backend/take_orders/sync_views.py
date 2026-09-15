from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from .models import TakeOrder, TakeOrderItem
from .serializers import TakeOrderSerializer
from business.models import Branch
from business.access import user_can_access_business
from pos_sessions.stock_validation import validate_stock_available_for_order_lines
from .takeaway import normalise_takeaway_items
from .session_access import (
    get_active_staff_session,
    user_can_cancel_take_order,
    user_can_process_take_order_payment,
)


TAKE_ORDER_SYNC_ALIASES = {
    'orderNumber': 'order_number',
    'orderType': 'order_type',
    'customerName': 'customer_name',
    'customerPhone': 'customer_phone',
    'customerNotes': 'customer_notes',
    'tableNumber': 'table_number',
    'specialInstructions': 'special_instructions',
    'cancellationReason': 'cancellation_reason',
    'cancelledAt': 'cancelled_at',
    'isTakeaway': 'is_takeaway',
    'createdAt': 'created_at',
    'updatedAt': 'updated_at',
    'completedAt': 'completed_at',
    'kitchenTicketPrinted': 'kitchen_ticket_printed',
    'kitchenTicketPrintedAt': 'kitchen_ticket_printed_at',
}
TAKE_ORDER_SYNC_READ_ONLY_FIELDS = {
    'id',
    'branchId',
    'businessId',
    'createdBy',
    'createdByName',
    'created_by_name',
    'completedBy',
    'completedByName',
    'completed_by',
    'completed_by_name',
    'cancelledBy',
    'cancelledByName',
    'cancelled_by',
    'cancelled_by_name',
    'cancelledAt',
    'cancelled_at',
    'session',
    'sessionId',
    'session_id',
}

TAKE_ORDER_ITEM_SYNC_ALIASES = {
    'inventoryItemId': 'inventory_item_id',
    'menuItemId': 'menu_item_id',
    'isPreparedMenuItem': 'is_prepared_menu_item',
    'isTakeawayPackaging': 'is_takeaway_packaging',
    'selectedOptions': 'selected_options',
    'createdAt': 'created_at',
    'updatedAt': 'updated_at',
}
TAKE_ORDER_ITEM_SYNC_READ_ONLY_FIELDS = {
    'takeOrder',
    'take_order',
    'takeOrderId',
    'take_order_id',
}


def _clean_take_order_sync_data(change_data):
    cleaned = {}
    model_fields = {field.name for field in TakeOrder._meta.fields}

    for key, value in (change_data or {}).items():
        if key in TAKE_ORDER_SYNC_READ_ONLY_FIELDS:
            continue

        field_name = TAKE_ORDER_SYNC_ALIASES.get(key, key)
        if field_name == 'items' or field_name in model_fields:
            cleaned[field_name] = value

    return cleaned


def _clean_take_order_item_sync_data(item_data):
    cleaned = {}
    model_fields = {field.name for field in TakeOrderItem._meta.fields}

    for key, value in (item_data or {}).items():
        if key in TAKE_ORDER_ITEM_SYNC_READ_ONLY_FIELDS:
            continue

        field_name = TAKE_ORDER_ITEM_SYNC_ALIASES.get(key, key)
        if field_name in model_fields:
            cleaned[field_name] = value

    cleaned.setdefault('inventory_item_id', '')
    cleaned.setdefault('menu_item_id', '')
    cleaned.setdefault('recipe', [])
    cleaned.setdefault('selected_options', [])
    return cleaned


def _sync_validation_error_text(exc):
    """Return one useful message for the sync retry queue."""
    details = getattr(exc, 'message_dict', None)
    if isinstance(details, dict):
        message = details.get('error')
        if isinstance(message, (list, tuple)):
            return ' '.join(str(part) for part in message)
        if message:
            return str(message)
    messages = getattr(exc, 'messages', None)
    if messages:
        return ' '.join(str(message) for message in messages)
    return str(exc)


def _prepare_sync_items(items_data, branch, requested_takeaway=False):
    """Apply the same packaging and stock rules used by the online order API."""
    cleaned_items = [_clean_take_order_item_sync_data(item) for item in (items_data or [])]
    normalized_items, is_takeaway = normalise_takeaway_items(
        cleaned_items,
        branch,
        requested_takeaway,
    )
    normalized_items = [
        _clean_take_order_item_sync_data(item)
        for item in normalized_items
    ]
    validate_stock_available_for_order_lines(
        normalized_items,
        branch.business,
        branch,
    )
    return normalized_items, is_takeaway


def _apply_completion_audit(take_order, user):
    if take_order.status == 'Completed':
        take_order.completed_at = take_order.completed_at or timezone.now()
        take_order.completed_by = user
    else:
        take_order.completed_at = None
        take_order.completed_by = None


def _apply_cancellation_audit(take_order, user):
    if take_order.status == 'Cancelled':
        take_order.cancelled_at = take_order.cancelled_at or timezone.now()
        take_order.cancelled_by = user
    else:
        take_order.cancelled_at = None
        take_order.cancelled_by = None


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Receive local changes from frontend and apply them to backend
    Handles create, update, and delete operations for take orders
    """
    try:
        data = request.data
        branch_id = data.get('branch_id')
        changes = data.get('changes', [])
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Verify branch exists and user has access
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return Response(
                {'error': 'Branch not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        if not user_can_access_business(request.user, branch.business_id):
            return Response(
                {'error': 'You do not have access to this branch.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        
        acknowledged = []
        conflicts = []
        errors = []
        
        for change in changes:
            try:
                entity_type = change.get('entity_type')
                op = change.get('op')  # 'create', 'update', 'delete'
                change_id = change.get('id')
                change_data = _clean_take_order_sync_data(change.get('data', {}))
                
                if entity_type != 'TakeOrder':
                    continue
                
                if op == 'create':
                    # Create new take order
                    if change_data.get('status') == 'Cancelled':
                        errors.append({
                            'id': change_id,
                            'error': 'Orders cannot be created as cancelled. Cancel an existing order with an admin user.',
                        })
                        continue
                    try:
                        items_data, is_takeaway = _prepare_sync_items(
                            change_data.pop('items', []),
                            branch,
                            change_data.get('is_takeaway', False),
                        )
                    except DjangoValidationError as exc:
                        errors.append({
                            'id': change_id,
                            'error': _sync_validation_error_text(exc),
                        })
                        continue
                    take_order_data = {
                        'id': change_id,
                        'branch_id': branch_id,
                        'business_id': branch.business_id,
                        'created_by_id': request.user.id,
                        **change_data
                    }
                    take_order_data['is_takeaway'] = is_takeaway
                    
                    take_order_data['order_number'] = TakeOrder.next_order_number_for_branch(branch)
                    if take_order_data.get('order_type', 'staff') == 'staff':
                        active_session = get_active_staff_session(
                            user=request.user,
                            business=branch.business,
                            branch=branch,
                        )
                        if not active_session:
                            errors.append({
                                'id': change_id,
                                'error': 'Start an active session before taking orders for this branch.',
                            })
                            continue
                        take_order_data['session'] = active_session
                    
                    take_order_data.pop('completed_by', None)
                    take_order_data.pop('completedBy', None)
                    take_order = TakeOrder.objects.create(**take_order_data)
                    _apply_completion_audit(take_order, request.user)
                    _apply_cancellation_audit(take_order, request.user)
                    take_order.save(update_fields=['completed_at', 'completed_by', 'cancelled_at', 'cancelled_by', 'updated_at'])
                    
                    # Create items if provided
                    for item_data in items_data:
                        TakeOrderItem.objects.create(
                            take_order=take_order,
                            **item_data
                        )
                    
                    acknowledged.append({
                        'id': change_id,
                        'take_order': TakeOrderSerializer(take_order).data,
                        'branch_id': str(branch_id),
                    })
                
                elif op == 'update':
                    # Update existing take order, or create if it doesn't exist
                    try:
                        existing_take_order = TakeOrder.objects.filter(
                            id=change_id,
                            branch_id=branch_id,
                        ).first()
                        if change_data.get('status') == 'Cancelled' and not existing_take_order:
                            errors.append({
                                'id': change_id,
                                'error': 'Orders cannot be created as cancelled. Cancel an existing order with an admin user.',
                            })
                            continue
                        if (
                            'status' in change_data
                            and change_data['status'] not in dict(TakeOrder.STATUS_CHOICES)
                        ):
                            errors.append({
                                'id': change_id,
                                'error': 'Invalid order status.',
                            })
                            continue

                        existing_order_type = (
                            existing_take_order.order_type
                            if existing_take_order
                            else change_data.get('order_type', 'staff')
                        )
                        requires_active_session = existing_order_type == 'staff' and (
                            existing_take_order is None or 'items' in change_data
                        )
                        active_session = None
                        if requires_active_session:
                            active_session = get_active_staff_session(
                                user=request.user,
                                business=branch.business,
                                branch=branch,
                            )
                            if not active_session:
                                errors.append({
                                    'id': change_id,
                                    'error': 'Start an active session before taking orders for this branch.',
                                })
                                continue

                        if 'items' in change_data:
                            try:
                                items_data, is_takeaway = _prepare_sync_items(
                                    change_data['items'],
                                    branch,
                                    change_data.get(
                                        'is_takeaway',
                                        existing_take_order.is_takeaway if existing_take_order else False,
                                    ),
                                )
                            except DjangoValidationError as exc:
                                errors.append({
                                    'id': change_id,
                                    'error': _sync_validation_error_text(exc),
                                })
                                continue
                            change_data['items'] = items_data
                            change_data['is_takeaway'] = is_takeaway

                        take_order, created = TakeOrder.objects.get_or_create(
                            id=change_id,
                            defaults={
                                'branch_id': branch_id,
                                'business_id': branch.business_id,
                                'created_by_id': request.user.id,
                                'order_number': 1,  # Will be updated below if provided
                            }
                        )

                        if active_session and not take_order.session_id:
                            take_order.session = active_session
                        
                        requested_status = change_data.get('status', take_order.status)
                        if requested_status == 'Cancelled':
                            if not user_can_cancel_take_order(user=request.user, take_order=take_order):
                                errors.append({
                                    'id': change_id,
                                    'error': 'Only admin users can cancel orders.',
                                })
                                continue
                            if not str(change_data.get('cancellation_reason') or '').strip():
                                errors.append({
                                    'id': change_id,
                                    'error': 'Cancellation reason is required.',
                                })
                                continue

                        # Update fields
                        for field, value in change_data.items():
                            if field not in {'items', 'completed_by', 'completedBy', 'cancelled_by', 'cancelledBy'} and hasattr(take_order, field):
                                setattr(take_order, field, value)

                        if take_order.status != 'Cancelled':
                            take_order.cancellation_reason = ''
                        
                        # If order_number wasn't provided and this is a new order, generate it
                        if created and 'order_number' not in change_data:
                            last_order = TakeOrder.objects.filter(
                                branch_id=branch_id
                            ).exclude(id=change_id).order_by('-order_number').first()
                            take_order.order_number = (last_order.order_number + 1) if last_order else 1

                        if take_order.status == 'Completed' and not user_can_process_take_order_payment(
                            user=request.user,
                            take_order=take_order,
                        ):
                            errors.append({
                                'id': change_id,
                                'error': 'Only the staff member who took this order can process its payment.',
                            })
                            continue

                        if (
                            take_order.status in {'Sent to Kitchen', 'Preparing', 'Ready'}
                            and 'items' not in change_data
                        ):
                            existing_items = [
                                {
                                    'inventory_item_id': item.inventory_item_id,
                                    'menu_item_id': item.menu_item_id,
                                    'name': item.name,
                                    'quantity': item.quantity,
                                    'recipe': item.recipe or [],
                                    'is_prepared_menu_item': item.is_prepared_menu_item,
                                    'selected_options': item.selected_options or [],
                                    'is_takeaway_packaging': item.is_takeaway_packaging,
                                }
                                for item in take_order.items.all()
                            ]
                            try:
                                validate_stock_available_for_order_lines(
                                    existing_items,
                                    take_order.business,
                                    take_order.branch,
                                )
                            except DjangoValidationError as exc:
                                errors.append({
                                    'id': change_id,
                                    'error': _sync_validation_error_text(exc),
                                })
                                continue
                        
                        _apply_completion_audit(take_order, request.user)
                        _apply_cancellation_audit(take_order, request.user)
                        take_order.save()
                        from appointments.services import sync_appointment_from_take_order
                        sync_appointment_from_take_order(take_order)
                        
                        # Update items if provided
                        if 'items' in change_data:
                            TakeOrderItem.objects.filter(take_order=take_order).delete()
                            for item_data in change_data['items']:
                                TakeOrderItem.objects.create(
                                    take_order=take_order,
                                    **item_data
                                )
                        
                        acknowledged.append({
                            'id': change_id,
                            'take_order': TakeOrderSerializer(take_order).data,
                            'branch_id': str(branch_id),
                        })
                    
                    except Exception as e:
                        errors.append({
                            'id': change_id,
                            'error': str(e)
                        })
                
                elif op == 'delete':
                    # Delete take order
                    try:
                        take_order = TakeOrder.objects.get(id=change_id, branch_id=branch_id)
                        take_order.delete()
                        acknowledged.append({'id': change_id})
                    except TakeOrder.DoesNotExist:
                        errors.append({
                            'id': change_id,
                            'error': 'Take order not found'
                        })
            
            except Exception as e:
                errors.append({
                    'id': change.get('id'),
                    'error': str(e)
                })
        
        return Response({
            'results': {
                'acknowledged': acknowledged,
                'conflicts': conflicts,
                'errors': errors
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Send server changes to frontend
    Returns all take orders modified since the given timestamp
    """
    try:
        branch_id = request.query_params.get('branch_id')
        since = request.query_params.get('since', '2000-01-01T00:00:00Z')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Verify branch exists
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return Response(
                {'error': 'Branch not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        # Parse since timestamp
        try:
            since_dt = timezone.datetime.fromisoformat(since.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            since_dt = timezone.datetime(2000, 1, 1, tzinfo=timezone.utc)
        
        # Get take orders modified since timestamp
        take_orders = TakeOrder.objects.filter(
            branch_id=branch_id,
            updated_at__gte=since_dt
        ).prefetch_related('items')
        
        serializer = TakeOrderSerializer(take_orders, many=True)
        
        return Response({
            'changes': {
                'take_orders': serializer.data
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
