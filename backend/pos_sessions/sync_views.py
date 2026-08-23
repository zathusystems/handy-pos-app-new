"""
Sync endpoints for POS Sessions and Orders
Implements the recommended sync flow:
1. Frontend PUSHES local changes
2. Backend validates and resolves conflicts
3. Frontend PULLS server changes
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from datetime import datetime
from django.db import transaction
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from .models import Session, Order, OrderItem
from .serializers import SessionSerializer, OrderSerializer
from .tax_utils import lock_tax_rate_on_use
from business.customer_accounts import (
    create_laybuy_for_order,
    record_credit_sale_for_order,
    resolve_customer_for_account_payload,
)
from business.models import Business, Branch, CustomerLaybuy, TaxRate
from .stock_validation import (
    _business_allows_negative_stock,
    _modifier_quantity,
    _recipe_entries_for_modifier,
    validate_stock_available_for_order_lines,
)

NON_BLOCKING_OFFLINE_DRY_RUN_REASONS = {
    'submission_call_failed',
    'connection_error',
    'timeout',
    'network_error',
    'eis_unreachable',
}

def _to_optional_decimal(value):
    """Parse optional numeric payload values safely."""
    if value in (None, ''):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _to_decimal(value, default=Decimal('0')):
    """Parse numeric payload values safely."""
    parsed = _to_optional_decimal(value)
    return parsed if parsed is not None else default


def _extract_laybuy_deposit(data):
    for key in ('deposit_amount', 'depositAmount', 'laybuy_deposit', 'laybuyDeposit'):
        if key in data and data.get(key) not in (None, ''):
            return _to_decimal(data.get(key), Decimal('0'))
    return Decimal('0')


def _resolve_line_base_amount(item_data, tax_calculation_method='inclusive'):
    """
    Resolve the pre-tax line amount basis from mixed client payloads.

    Supports both:
    - unit pricing payloads (price x quantity)
    - legacy variable-price payloads (price sent as line total)
    """
    quantity = _to_decimal(item_data.get('quantity'), Decimal('0'))
    price = _to_decimal(item_data.get('price'), Decimal('0'))

    explicit_subtotal = _to_optional_decimal(item_data.get('subtotal'))
    explicit_tax = _to_optional_decimal(item_data.get('taxAmount'))
    if explicit_tax is None:
        explicit_tax = _to_optional_decimal(item_data.get('tax_amount'))
    explicit_total = _to_optional_decimal(item_data.get('total'))

    method = str(tax_calculation_method or 'inclusive').strip().lower()
    line_base = None

    if method == 'exclusive':
        # For exclusive tax, base is net/subtotal before tax.
        if explicit_subtotal is not None and explicit_subtotal >= 0:
            line_base = explicit_subtotal
        elif explicit_total is not None and explicit_tax is not None:
            line_base = explicit_total - explicit_tax
        elif explicit_total is not None and explicit_total >= 0:
            line_base = explicit_total
    else:
        # For inclusive tax, base is gross/total (price already includes tax).
        if explicit_total is not None and explicit_total >= 0:
            line_base = explicit_total
        elif explicit_subtotal is not None and explicit_tax is not None:
            line_base = explicit_subtotal + explicit_tax
        elif explicit_subtotal is not None and explicit_subtotal >= 0:
            line_base = explicit_subtotal

    if line_base is None:
        line_base = quantity * price

    return max(Decimal('0'), line_base)


def _normalize_tax_type(value):
    normalized = str(value or '').strip().lower()
    if normalized in {'zero', 'zero_rated', 'zero-rated', 'vat_zero'}:
        return 'zero'
    if normalized in {'exempt', 'vat_exempt'}:
        return 'exempt'
    return 'standard'


def _quantize_money(value):
    return Decimal(str(value or 0)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def _calculate_item_tax_values(line_base_amount, tax_type='standard', tax_rate=Decimal('0'), tax_calculation_method='inclusive'):
    """
    Return normalized per-line tax values.
    line_base_amount semantics:
    - inclusive: gross value (tax included)
    - exclusive: subtotal/net value (tax excluded)
    """
    base = max(Decimal('0'), Decimal(str(line_base_amount or 0)))
    normalized_tax_type = _normalize_tax_type(tax_type)
    method = str(tax_calculation_method or 'inclusive').strip().lower()
    rate = max(Decimal('0'), Decimal(str(tax_rate or 0)))

    if normalized_tax_type in {'zero', 'exempt'} or rate <= 0:
        return {
            'subtotal': _quantize_money(base),
            'tax_amount': Decimal('0.00'),
            'total': _quantize_money(base),
            'tax_type': normalized_tax_type,
            'tax_method': 'inclusive' if method != 'exclusive' else 'exclusive',
            'rate_percent': _quantize_money(rate),
        }

    effective_rate = rate / Decimal('100')
    if method == 'exclusive':
        subtotal = base
        tax_amount = subtotal * effective_rate
        total = subtotal + tax_amount
    else:
        total = base
        tax_amount = total * effective_rate / (Decimal('1') + effective_rate)
        subtotal = total - tax_amount

    return {
        'subtotal': _quantize_money(subtotal),
        'tax_amount': _quantize_money(tax_amount),
        'total': _quantize_money(total),
        'tax_type': normalized_tax_type,
        'tax_method': 'exclusive' if method == 'exclusive' else 'inclusive',
        'rate_percent': _quantize_money(rate),
    }


def _resolve_user_business(user):
    """
    Resolve business for both owners and staff users.
    """
    business = Business.objects.filter(owner=user).first()
    if business:
        return business

    try:
        from staff.models import Staff
        staff = Staff.objects.select_related('business').filter(user=user, is_active=True).first()
        return staff.business if staff and staff.business else None
    except Exception:
        return None


def _build_order_sync_payload(order):
    """Return normalized order fields used by frontend sync acknowledgements."""
    if not order:
        return {}

    payload = {
        'server_id': str(order.id),
        'customer': str(order.customer_id) if order.customer_id else None,
        'customer_id': str(order.customer_id) if order.customer_id else None,
        'order_number': order.order_number,
        'customer_name': order.customer_name,
        'customer_phone': order.customer_phone,
        'customer_tin': order.customer_tin,
        'customer_email': order.customer_email,
        'customer_address': order.customer_address,
        'customer_notes': order.customer_notes,
        'buyer_name': order.buyer_name,
        'buyer_tin': order.buyer_tin,
        'is_invoice_sale': order.is_invoice_sale,
        'invoice_id': order.invoice_id,
        'is_paid': order.is_paid,
        'fiscal_invoice_number': order.fiscal_invoice_number,
        'eis_status': order.eis_status,
        'eis_uuid': order.eis_uuid,
        'eis_submitted_at': order.eis_submitted_at.isoformat() if order.eis_submitted_at else None,
        'qr_code_payload': order.qr_code_payload,
        'digital_signature': order.digital_signature,
        'net_amount': float(order.net_amount) if order.net_amount is not None else None,
        'vat_amount': float(order.vat_amount) if order.vat_amount is not None else None,
        'gross_amount': float(order.gross_amount) if order.gross_amount is not None else None,
        'updated_at': order.updated_at.isoformat() if order.updated_at else None,
    }

    if str(order.payment_method or '').strip().lower() == 'laybuy':
        laybuy = CustomerLaybuy.objects.filter(
            business=order.business,
            order_id=str(order.id),
        ).prefetch_related('payments').first()
        if laybuy:
            first_payment = laybuy.payments.order_by('created_at').first()
            payload.update({
                'laybuy_deposit': float(laybuy.deposit_amount or 0),
                'laybuy_payment_method': first_payment.payment_method if first_payment else '',
            })

    return payload


def _should_block_sales_if_eis_down(business_settings):
    """Whether live-mode compliance requires blocking sales when EIS is down."""
    if not getattr(settings, 'MRA_EIS_IS_LIVE', False):
        return False
    if not business_settings:
        return False
    return bool(getattr(business_settings, 'enable_eis', False)) and bool(
        getattr(business_settings, 'block_sales_if_eis_down', True)
    )


def _get_mra_submission_block_reason(mra_result):
    """Return compliance block reason when MRA submission was not confirmed."""
    if not isinstance(mra_result, dict):
        return 'MRA EIS submission did not return a valid response.'

    endpoint_key = str(mra_result.get('endpoint') or '').strip().lower()

    response_payload = mra_result.get('response')
    reason = 'eis_unreachable'
    if isinstance(response_payload, dict):
        reason = str(response_payload.get('reason') or reason).strip().lower()

    # MRA allows offline issuance only for genuine connectivity failures.
    if (
        endpoint_key == 'report_sale_offline'
        and mra_result.get('dry_run')
        and reason in NON_BLOCKING_OFFLINE_DRY_RUN_REASONS
    ):
        return None

    if mra_result.get('dry_run'):
        return f'MRA EIS unavailable ({reason}).'

    eis_status = str(mra_result.get('eis_status') or '').upper()
    if eis_status != 'SUBMITTED':
        return f'MRA EIS did not confirm submission (status: {eis_status or "UNKNOWN"}).'

    return None


def _validation_error_message(exc):
    if hasattr(exc, 'message_dict'):
        return exc.message_dict
    if hasattr(exc, 'messages'):
        return ' '.join(str(message) for message in exc.messages)
    if hasattr(exc, 'message'):
        return exc.message
    return str(exc)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Receive local changes from frontend and apply them to backend
    
    Expected request body:
    {
        "last_synced_at": "2026-01-09T10:00:00Z",
        "branch_id": "branch-uuid",
        "changes": [
            {
                "id": "session-uuid",
                "entity_type": "Session",
                "op": "create|update|delete",
                "data": {...},
                "timestamp": "2026-01-09T10:05:00Z"
            }
        ]
    }
    """
    try:
        last_synced_at = request.data.get('last_synced_at')
        branch_id = request.data.get('branch_id')
        changes = request.data.get('changes', [])
        
        print(f"[Sync Push Sessions] Received {len(changes)} changes from frontend")
        print(f"[Sync Push Sessions] Last synced: {last_synced_at}, Branch: {branch_id}")
        
        # Get user's business (owner or assigned staff business)
        business = _resolve_user_business(request.user)
        if not business:
            return Response(
                {'error': 'User does not have an associated business'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        results = {
            'acknowledged': [],
            'conflicts': [],
            'errors': []
        }
        
        with transaction.atomic():
            for change in changes:
                try:
                    entity_type = change.get('entity_type')
                    operation = change.get('op')
                    data = change.get('data')
                    entity_id = change.get('id')
                    
                    print(f"[Sync Push Sessions] Processing {operation} for {entity_type} {entity_id}")
                    
                    if entity_type == 'Session':
                        if operation == 'create':
                            result = handle_create_session(entity_id, data, business, branch_id, request.user)
                        elif operation == 'update':
                            result = handle_update_session(entity_id, data, business, branch_id)
                        elif operation == 'delete':
                            result = handle_delete_session(entity_id, business, branch_id)
                        else:
                            results['errors'].append({
                                'id': entity_id,
                                'error': f'Unknown operation: {operation}'
                            })
                            continue
                    elif entity_type == 'Order':
                        if operation == 'create':
                            result = handle_create_order(entity_id, data, business, branch_id, request.user)
                        elif operation == 'update':
                            result = handle_update_order(entity_id, data, business, branch_id, request.user)
                        elif operation == 'delete':
                            result = handle_delete_order(entity_id, business, branch_id)
                        else:
                            results['errors'].append({
                                'id': entity_id,
                                'error': f'Unknown operation: {operation}'
                            })
                            continue
                    else:
                        results['errors'].append({
                            'id': entity_id,
                            'error': f'Unknown entity type: {entity_type}'
                        })
                        continue
                    
                    if result['success']:
                        ack_payload = {
                            'id': entity_id,
                            'status': 'success',
                            'server_id': result.get('server_id', entity_id)
                        }

                        for key in [
                            'order_number',
                            'customer_name',
                            'customer_phone',
                            'customer_tin',
                            'customer_email',
                            'customer_address',
                            'customer_notes',
                            'buyer_name',
                            'buyer_tin',
                            'is_invoice_sale',
                            'invoice_id',
                            'is_paid',
                            'fiscal_invoice_number',
                            'eis_status',
                            'eis_uuid',
                            'eis_submitted_at',
                            'qr_code_payload',
                            'digital_signature',
                            'net_amount',
                            'vat_amount',
                            'gross_amount',
                            'updated_at',
                        ]:
                            if key in result:
                                ack_payload[key] = result.get(key)

                        results['acknowledged'].append(ack_payload)
                        print(f"[Sync Push Sessions] Successfully processed {operation} for {entity_id}")
                    else:
                        results['errors'].append({
                            'id': entity_id,
                            'error': result.get('error', 'Unknown error')
                        })
                        print(f"[Sync Push Sessions] Error processing {operation} for {entity_id}: {result.get('error')}")
                        
                except Exception as e:
                    print(f"[Sync Push Sessions] Exception processing change: {str(e)}")
                    results['errors'].append({
                        'id': change.get('id'),
                        'error': str(e)
                    })
        
        return Response({
            'synced_at': timezone.now().isoformat(),
            'results': results
        }, status=status.HTTP_200_OK)
        
    except Exception as e:
        print(f"[Sync Push Sessions] Fatal error: {str(e)}")
        import traceback
        traceback.print_exc()
        return Response(
            {'error': str(e)},
            status=status.HTTP_400_BAD_REQUEST
        )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Return server changes since last sync
    
    Query parameters:
    - since: ISO datetime string (e.g., "2026-01-09T10:00:00Z")
    - branch_id: Branch UUID
    
    Returns:
    {
        "pulled_at": "2026-01-09T10:10:00Z",
        "changes": {
            "sessions": [...],
            "orders": [...]
        }
    }
    """
    try:
        since_str = request.query_params.get('since')
        branch_id = request.query_params.get('branch_id')
        
        if not since_str:
            return Response(
                {'error': 'since parameter is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        if not branch_id:
            return Response(
                {'error': 'branch_id parameter is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Parse since datetime
        try:
            since_dt = datetime.fromisoformat(since_str.replace('Z', '+00:00'))
        except ValueError:
            return Response(
                {'error': 'Invalid datetime format for since parameter'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        print(f"[Sync Pull Sessions] Pulling changes since {since_dt} for branch {branch_id}")
        
        # Get user's business (owner or assigned staff business)
        business = _resolve_user_business(request.user)
        if not business:
            return Response(
                {'error': 'User does not have an associated business'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Resolve branch identifier: support 'BRN-<number>' and numeric ids, fallback to name
        from business.models import Branch
        resolved_branch = None
        if isinstance(branch_id, str):
            import re
            m = re.match(r"^BRN-(\d+)$", branch_id)
            if m:
                try:
                    resolved_branch = Branch.objects.get(pk=int(m.group(1)), business=business)
                except Branch.DoesNotExist:
                    pass
            elif branch_id.isdigit():
                try:
                    resolved_branch = Branch.objects.get(pk=int(branch_id), business=business)
                except Branch.DoesNotExist:
                    pass
        if resolved_branch is None:
            try:
                resolved_branch = Branch.objects.get(pk=branch_id, business=business)
            except Exception:
                try:
                    resolved_branch = Branch.objects.get(name=branch_id, business=business)
                except Branch.DoesNotExist:
                    return Response(
                        {'error': f"Branch '{branch_id}' not found for this business"},
                        status=status.HTTP_400_BAD_REQUEST
                    )
        
        # Fetch updated sessions
        sessions = Session.objects.filter(
            business=business,
            branch=resolved_branch,
            updated_at__gte=since_dt
        ).order_by('updated_at')
        
        # Fetch updated orders
        orders = Order.objects.filter(
            business=business,
            branch=resolved_branch,
            updated_at__gte=since_dt
        ).order_by('updated_at')
        
        print(f"[Sync Pull Sessions] Found {sessions.count()} updated sessions and {orders.count()} updated orders")
        
        sessions_serializer = SessionSerializer(sessions, many=True)
        orders_serializer = OrderSerializer(orders, many=True)
        
        return Response({
            'pulled_at': timezone.now().isoformat(),
            'changes': {
                'sessions': sessions_serializer.data,
                'orders': orders_serializer.data
            }
        }, status=status.HTTP_200_OK)
        
    except Exception as e:
        print(f"[Sync Pull Sessions] Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return Response(
            {'error': str(e)},
            status=status.HTTP_400_BAD_REQUEST
        )


def handle_create_session(session_id, data, business, branch_id, user):
    """Handle creation of session from frontend"""
    try:
        from business.models import Branch
        
        # Validate branch exists
        try:
            branch = Branch.objects.get(id=branch_id, business=business)
        except Branch.DoesNotExist:
            return {
                'success': False,
                'error': f'Branch {branch_id} not found for this business'
            }
        
        # Check if session already exists
        existing = Session.objects.filter(id=session_id, business=business).first()
        if existing:
            print(f"[Sync Sessions] Session {session_id} already exists, updating instead")
            return handle_update_session(session_id, data, business, branch_id)

        # Enforce one active session per user (across branches).
        existing_active = Session.objects.filter(
            user=user,
            business=business,
            status='active'
        ).select_related('branch').order_by('-started_at').first()
        if existing_active:
            branch_name = getattr(existing_active.branch, 'name', '') or str(existing_active.branch_id)
            return {
                'success': False,
                'error': (
                    'You already have an active session. '
                    f'Close it before starting a new one (branch: {branch_name}).'
                )
            }

        # Create new session
        # Note: Frontend sends camelCase, but sync service converts to snake_case
        # So we need to check both formats for compatibility
        session_data = {
            'id': session_id,
            'business': business,
            'branch': branch,
            'user': user,  # Always include user
            'status': data.get('status', 'active'),
            'pump_name': data.get('pump_name') or data.get('pumpName'),
            'opening_float': float(data.get('opening_float') or data.get('openingFloat', 0)) or 0,
            'expected_cash': float(data.get('expected_cash') or data.get('expectedCash', 0)) or 0,
            'actual_cash': float(data.get('actual_cash') or data.get('actualCash')) if (data.get('actual_cash') or data.get('actualCash')) else None,
            'closing_float': float(data.get('closing_float') or data.get('closingFloat')) if (data.get('closing_float') or data.get('closingFloat')) else None,
            'difference': float(data.get('difference')) if data.get('difference') else None,
            'total_sales': float(data.get('total_sales') or data.get('totalSales', 0)) or 0,
            'total_cash_sales': float(data.get('total_cash_sales') or data.get('totalCashSales', 0)) or 0,
            'total_card_sales': float(data.get('total_card_sales') or data.get('totalCardSales', 0)) or 0,
            'total_mobile_money_sales': float(data.get('total_mobile_money_sales') or data.get('totalMobileMoneySales', 0)) or 0,
            'total_on_account_sales': float(data.get('total_on_account_sales') or data.get('totalOnAccountSales', 0)) or 0,
            'total_other_sales': float(data.get('total_other_sales') or data.get('totalOtherSales', 0)) or 0,
            'total_tips': float(data.get('total_tips') or data.get('totalTips', 0)) or 0,
            'opening_stock': data.get('opening_stock') or data.get('openingStock', []),
            'closing_stock': data.get('closing_stock') or data.get('closingStock', []),
            'started_at': data.get('started_at') or data.get('startedAt'),
            'closed_at': data.get('closed_at') or data.get('closedAt'),
        }
        
        # Validate that started_at is present for new sessions
        if not session_data.get('started_at'):
            return {
                'success': False,
                'error': 'started_at is required for new sessions'
            }
        
        # Remove None values
        session_data = {k: v for k, v in session_data.items() if v is not None}
        
        session = Session.objects.create(**session_data)
        print(f"[Sync Sessions] Created session {session_id}")
        
        return {
            'success': True,
            'server_id': str(session.id)
        }
        
    except Exception as e:
        print(f"[Sync Sessions] Error creating session: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


def handle_update_session(session_id, data, business, branch_id):
    """Handle update of session from frontend"""
    try:
        session = Session.objects.get(id=session_id, business=business, branch_id=branch_id)
        
        # Update fields
        if 'status' in data:
            session.status = data['status']
        if 'pumpName' in data or 'pump_name' in data:
            session.pump_name = data.get('pump_name') or data.get('pumpName')
        if 'openingFloat' in data:
            session.opening_float = data['openingFloat']
        if 'expectedCash' in data:
            session.expected_cash = data['expectedCash']
        if 'actualCash' in data:
            session.actual_cash = data['actualCash']
        if 'closingFloat' in data:
            session.closing_float = data['closingFloat']
        if 'difference' in data:
            session.difference = data['difference']
        if 'totalSales' in data:
            session.total_sales = data['totalSales']
        if 'totalCashSales' in data:
            session.total_cash_sales = data['totalCashSales']
        if 'totalCardSales' in data:
            session.total_card_sales = data['totalCardSales']
        if 'totalMobileMoneySales' in data:
            session.total_mobile_money_sales = data['totalMobileMoneySales']
        if 'totalOnAccountSales' in data:
            session.total_on_account_sales = data['totalOnAccountSales']
        if 'totalOtherSales' in data:
            session.total_other_sales = data['totalOtherSales']
        if 'totalTips' in data:
            session.total_tips = data['totalTips']
        if 'openingStock' in data:
            session.opening_stock = data['openingStock']
        if 'closingStock' in data:
            session.closing_stock = data['closingStock']
        if 'closedAt' in data:
            session.closed_at = data['closedAt']
        
        session.save()
        print(f"[Sync Sessions] Updated session {session_id}")
        
        return {
            'success': True,
            'server_id': str(session.id)
        }
        
    except Session.DoesNotExist:
        print(f"[Sync Sessions] Session {session_id} not found, creating instead")
        return handle_create_session(session_id, data, business, branch_id, None)
    except Exception as e:
        print(f"[Sync Sessions] Error updating session: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }


def handle_delete_session(session_id, business, branch_id):
    """Handle deletion of session from frontend"""
    try:
        session = Session.objects.get(id=session_id, business=business, branch_id=branch_id)
        session.delete()
        print(f"[Sync Sessions] Deleted session {session_id}")
        
        return {
            'success': True,
            'server_id': session_id
        }
        
    except Session.DoesNotExist:
        print(f"[Sync Sessions] Session {session_id} not found for deletion")
        return {
            'success': True,
            'server_id': session_id
        }
    except Exception as e:
        print(f"[Sync Sessions] Error deleting session: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }


def handle_create_order(order_id, data, business, branch_id, user):
    """Handle creation of order from frontend"""
    from business.models import Branch
    from django.db import IntegrityError
    from inventory.models import InventoryItem, PurchaseOrderItem, MRAProductMapping
    from decimal import Decimal
    
    try:
        # Validate branch exists
        try:
            branch = Branch.objects.get(id=branch_id, business=business)
        except Branch.DoesNotExist:
            return {
                'success': False,
                'error': f'Branch {branch_id} not found for this business'
            }
        
        # Check if order already exists by ID
        existing = Order.objects.filter(id=order_id, business=business).first()
        if existing:
            print(f"[Sync Sessions] Order {order_id} already exists - returning success without creating duplicate")
            if str(existing.payment_method or '').strip().lower() == 'on account':
                try:
                    record_credit_sale_for_order(existing, created_by=user)
                except Exception as account_exc:
                    print(
                        f"[Sync Sessions] Warning: could not ensure customer account entry "
                        f"for existing order {order_id}: {account_exc}"
                    )
            if str(existing.payment_method or '').strip().lower() == 'laybuy':
                try:
                    laybuy_deposit = _extract_laybuy_deposit(data)
                    laybuy_deposit_method = data.get('laybuy_payment_method') or data.get('laybuyPaymentMethod') or 'Cash'
                    laybuy_already_exists = CustomerLaybuy.objects.filter(
                        business=existing.business,
                        order_id=str(existing.id),
                    ).exists()
                    create_laybuy_for_order(
                        existing,
                        deposit_amount=laybuy_deposit,
                        payment_method=laybuy_deposit_method,
                        reference=data.get('laybuy_reference') or data.get('laybuyReference') or '',
                        notes=data.get('laybuy_notes') or data.get('laybuyNotes') or '',
                        created_by=user,
                    )
                except Exception as laybuy_exc:
                    print(
                        f"[Sync Sessions] Warning: could not ensure laybuy "
                        f"for existing order {order_id}: {laybuy_exc}"
                    )
            return {
                'success': True,
                **_build_order_sync_payload(existing)
            }
        
        business_settings = getattr(business, 'settings', None)
        block_sales_if_tax_mapping_missing = bool(
            getattr(business_settings, 'block_sales_if_tax_mapping_missing', False)
        )

        # CRITICAL: Validate that ALL products have approved+synced MRA mappings
        # Only enforce when block_sales_if_tax_mapping_missing is enabled.
        print(f"[Sync Sessions] Validating MRA mappings for order {order_id}")
        if block_sales_if_tax_mapping_missing and data.get('items'):
            unmapped_products = []
            unapproved_products = []
            unsynced_products = []
            
            for item_data in data['items']:
                # The item_data contains 'inventoryItemId' which is the actual inventory item ID
                # NOT the order item ID (which is in 'id')
                item_id = item_data.get('inventoryItemId') or item_data.get('inventory_item_id') or item_data.get('id', '')
                item_name = item_data.get('name', 'Unknown')
                item_recipe = item_data.get('recipe') if isinstance(item_data.get('recipe'), list) else []
                is_prepared_menu_item = bool(item_data.get('is_prepared_menu_item') or item_data.get('isPreparedMenuItem'))
                if is_prepared_menu_item or (not str(item_id or '').strip() and item_recipe):
                    print(f"[Sync Sessions] Skipping inventory MRA mapping check for prepared menu item: {item_name}")
                    continue
                
                print(f"[Sync Sessions] Checking MRA mapping for item: id={item_id}, name={item_name}, full_data={item_data}")
                
                try:
                    # Check if MRA mapping exists and is approved
                    all_mappings = list(MRAProductMapping.objects.filter(inventory_item_id=item_id))
                    approved_and_synced = next(
                        (m for m in all_mappings if m.is_approved and m.mra_synced),
                        None
                    )
                    approved_but_unsynced = next(
                        (m for m in all_mappings if m.is_approved and not m.mra_synced),
                        None
                    )
                    any_mapping = all_mappings[0] if all_mappings else None

                    if approved_and_synced:
                        print(f"[Sync Sessions] ✓ Product {item_name} ({item_id}) has approved+synced MRA mapping")
                    elif approved_but_unsynced:
                        print(f"[Sync Sessions] ⚠ Product {item_name} ({item_id}) mapping is approved but NOT synced")
                        unsynced_products.append(item_name)
                    elif any_mapping:
                        print(f"[Sync Sessions] ⚠ Product {item_name} ({item_id}) has unapproved MRA mapping")
                        unapproved_products.append(item_name)
                    else:
                        print(f"[Sync Sessions] ✗ Product {item_name} ({item_id}) has NO MRA mapping")
                        unmapped_products.append(item_name)
                        
                except Exception as e:
                    print(f"[Sync Sessions] Error checking MRA mapping for {item_name}: {str(e)}")
                    import traceback
                    traceback.print_exc()
                    unmapped_products.append(item_name)
            
            # Block order if any products are unmapped or unapproved
            if unmapped_products:
                error_msg = f"Cannot create order: Products without MRA mappings: {', '.join(unmapped_products)}"
                print(f"[Sync Sessions] ✗ BLOCKED order creation - {error_msg}")
                return {
                    'success': False,
                    'error': error_msg
                }
            
            if unapproved_products:
                error_msg = f"Cannot create order: Products with unapproved MRA mappings: {', '.join(unapproved_products)}"
                print(f"[Sync Sessions] ✗ BLOCKED order creation - {error_msg}")
                return {
                    'success': False,
                    'error': error_msg
                }

            if unsynced_products:
                error_msg = f"Cannot create order: Products with unsynced MRA mappings: {', '.join(unsynced_products)}"
                print(f"[Sync Sessions] ✗ BLOCKED order creation - {error_msg}")
                return {
                    'success': False,
                    'error': error_msg
                }

        if block_sales_if_tax_mapping_missing:
            print(f"[Sync Sessions] ✓ All products have approved+synced MRA mappings - proceeding with order creation")
        else:
            print(f"[Sync Sessions] MRA mapping enforcement disabled - proceeding with order creation")
        
        def _next_order_number_for_branch(target_branch):
            last_order = Order.objects.filter(branch=target_branch).order_by('-order_number').first()
            return (last_order.order_number if last_order else 100) + 1

        # Get or generate order number.
        # IMPORTANT: Never map a different local order to an existing remote order number.
        # If the requested number already exists for another order, allocate the next available number.
        requested_order_number = int(data.get('orderNumber', 0))
        if requested_order_number <= 0:
            order_number = _next_order_number_for_branch(branch)
            print(f"[Sync Sessions] Generated order number {order_number} for order {order_id}")
        else:
            existing_by_number = Order.objects.filter(
                branch=branch,
                order_number=requested_order_number
            ).first()
            if existing_by_number:
                if str(existing_by_number.id) == str(order_id):
                    print(
                        f"[Sync Sessions] Order number {requested_order_number} belongs to the same "
                        f"order {order_id}; treating as idempotent retry"
                    )
                    return {
                        'success': True,
                        **_build_order_sync_payload(existing_by_number)
                    }

                order_number = _next_order_number_for_branch(branch)
                print(
                    f"[Sync Sessions] Order number collision for branch {branch.id}: "
                    f"requested={requested_order_number}, existing_order={existing_by_number.id}. "
                    f"Reassigned to {order_number} for order {order_id}"
                )
            else:
                order_number = requested_order_number
        
        # Create new order
        payment_method = data.get('paymentMethod') or data.get('payment_method') or 'Cash'
        print(f"[Sync Sessions] Order payment method - paymentMethod: {data.get('paymentMethod')}, payment_method: {data.get('payment_method')}, final: {payment_method}")
        print(f"[Sync Sessions] Full order data: {data}")
        
        # Calculate tax based on product-specific MRA mappings (inclusive/exclusive)
        # Each product has its own tax calculation method in its MRA mapping
        # CRITICAL: ALWAYS recalculate from items - NEVER trust frontend totals for tax
        # This ensures accurate tax when items have different tax rates (mixed tax scenario)
        
        print(f"[Sync Sessions] Frontend sent - subtotal: {data.get('subtotal')}, total: {data.get('total')}, vat: {data.get('vat_amount')}")
        
        # Initialize totals - will be recalculated from items
        subtotal = 0
        total = 0
        vat_amount = 0
        
        # Recalculate tax based on product-specific MRA mappings
        # CRITICAL: Always recalculate from items to ensure accuracy
        # This ensures order totals match the sum of item totals
        items_have_complete_price_data = False
        if data.get('items'):
            items_have_complete_price_data = all(
                (item.get('price') is not None and item.get('price') != '') or
                (item.get('total') is not None and item.get('total') != '')
                for item in data['items']
            )
            print(f"[Sync Sessions] Items have complete price data: {items_have_complete_price_data}")
        
        default_tax_rate = None
        if not block_sales_if_tax_mapping_missing:
            default_tax_rate = TaxRate.objects.filter(
                business=business,
                is_active=True,
                is_default=True,
            ).order_by('-effective_from').first()
            if not default_tax_rate:
                default_tax_rate = TaxRate.objects.filter(
                    business=business,
                    is_active=True,
                ).order_by('-effective_from').first()

        if data.get('items') and items_have_complete_price_data:
            total_vat = Decimal('0')
            total_subtotal = Decimal('0')
            total_gross = Decimal('0')
            
            for item_data in data['items']:
                # CRITICAL: Use inventoryItemId (the actual product ID), NOT id (which is the order item ID)
                item_recipe = item_data.get('recipe') if isinstance(item_data.get('recipe'), list) else []
                is_prepared_menu_item = bool(item_data.get('is_prepared_menu_item') or item_data.get('isPreparedMenuItem'))
                item_id = item_data.get('inventoryItemId') or item_data.get('inventory_item_id') or (
                    '' if (is_prepared_menu_item or item_recipe) else item_data.get('id', '')
                )
                item_quantity = _to_decimal(item_data.get('quantity'), Decimal('0'))
                item_price = _to_decimal(item_data.get('price'), Decimal('0'))
                
                print(f"[Sync Sessions] Processing item {item_id}: qty={item_quantity}, price={item_price}")
                
                try:
                    # Get MRA mapping for this product
                    mra_mapping = None
                    if str(item_id or '').strip():
                        mra_mapping = MRAProductMapping.objects.filter(
                            inventory_item_id=item_id,
                            is_approved=True,
                            mra_synced=True
                        ).first()
                    
                    if mra_mapping:
                        tax_calculation_method = mra_mapping.tax_calculation_method
                        tax_rate = _to_decimal(mra_mapping.mra_tax_rate, Decimal('0'))
                        tax_type = _normalize_tax_type(mra_mapping.mra_tax_type)
                        line_base_amount = _resolve_line_base_amount(item_data, tax_calculation_method)
                        tax_values = _calculate_item_tax_values(
                            line_base_amount=line_base_amount,
                            tax_type=tax_type,
                            tax_rate=tax_rate,
                            tax_calculation_method=tax_calculation_method,
                        )

                        print(
                            f"[Sync Sessions] Found MRA mapping for {item_id}: "
                            f"method={tax_calculation_method}, rate={tax_rate}%, tax_type={tax_type}, base={line_base_amount}"
                        )

                        total_vat += tax_values['tax_amount']
                        total_subtotal += tax_values['subtotal']
                        total_gross += tax_values['total']
                    else:
                        # No mapping found.
                        fallback_method = str(
                            item_data.get('taxCalculationMethod')
                            or item_data.get('tax_calculation_method')
                            or 'inclusive'
                        ).strip().lower()
                        fallback_tax_rate = _to_decimal(
                            item_data.get('taxRate') or item_data.get('tax_rate'),
                            Decimal('0')
                        )
                        fallback_tax_type = _normalize_tax_type(
                            item_data.get('taxType') or item_data.get('tax_type') or 'standard'
                        )

                        if not block_sales_if_tax_mapping_missing and fallback_tax_rate <= 0 and fallback_tax_type == 'standard' and default_tax_rate:
                            fallback_tax_rate = _to_decimal(default_tax_rate.rate, Decimal('0'))
                            fallback_tax_type = _normalize_tax_type(default_tax_rate.tax_type)

                        line_base_amount = _resolve_line_base_amount(item_data, fallback_method)
                        print(
                            f"[Sync Sessions] No MRA mapping found for {item_id}, "
                            f"using fallback tax: type={fallback_tax_type}, rate={fallback_tax_rate}%, method={fallback_method}, "
                            f"base={line_base_amount}"
                        )
                        fallback_values = _calculate_item_tax_values(
                            line_base_amount=line_base_amount,
                            tax_type=fallback_tax_type,
                            tax_rate=fallback_tax_rate,
                            tax_calculation_method=fallback_method,
                        )
                        total_vat += fallback_values['tax_amount']
                        total_subtotal += fallback_values['subtotal']
                        total_gross += fallback_values['total']
                        
                except Exception as e:
                    print(f"[Sync Sessions] Error processing MRA mapping for {item_id}: {str(e)}")
                    # Fallback to item totals/tax payloads if available.
                    fallback_method = str(
                        item_data.get('taxCalculationMethod')
                        or item_data.get('tax_calculation_method')
                        or 'inclusive'
                    ).strip().lower()
                    fallback_tax_rate = _to_decimal(
                        item_data.get('taxRate') or item_data.get('tax_rate'),
                        Decimal('0')
                    )
                    fallback_tax_type = _normalize_tax_type(
                        item_data.get('taxType') or item_data.get('tax_type') or 'standard'
                    )
                    if not block_sales_if_tax_mapping_missing and fallback_tax_rate <= 0 and fallback_tax_type == 'standard' and default_tax_rate:
                        fallback_tax_rate = _to_decimal(default_tax_rate.rate, Decimal('0'))
                        fallback_tax_type = _normalize_tax_type(default_tax_rate.tax_type)

                    fallback_line_amount = _resolve_line_base_amount(item_data, fallback_method)
                    fallback_values = _calculate_item_tax_values(
                        line_base_amount=fallback_line_amount,
                        tax_type=fallback_tax_type,
                        tax_rate=fallback_tax_rate,
                        tax_calculation_method=fallback_method,
                    )
                    total_vat += fallback_values['tax_amount']
                    total_subtotal += fallback_values['subtotal']
                    total_gross += fallback_values['total']
            
            # Update order totals based on product-specific calculations
            subtotal = float(_quantize_money(total_subtotal))
            total = float(_quantize_money(total_gross))
            vat_amount = float(_quantize_money(total_vat))
            
            print(f"[Sync Sessions] Final calculated totals - subtotal: {subtotal}, vat: {vat_amount}, total: {total}")
        else:
            print(f"[Sync Sessions] No items in order, using provided totals")
        
        normalized_payment_method = str(payment_method or '').strip().lower()
        payment_method_is_credit = normalized_payment_method == 'on account'
        payment_method_is_laybuy = normalized_payment_method == 'laybuy'
        customer_required_payment = payment_method_is_credit or payment_method_is_laybuy
        has_customer_details = any(
            str(data.get(field) or '').strip()
            for field in (
                'customer',
                'customer_id',
                'customerId',
                'customer_name',
                'customerName',
                'customer_phone',
                'customerPhone',
                'customer_tin',
                'customerTin',
                'customer_email',
                'customerEmail',
                'customer_address',
                'customerAddress',
                'buyer_name',
                'buyerName',
                'buyer_tin',
                'buyerTin',
            )
        )
        customer_for_order = None
        if customer_required_payment or has_customer_details:
            try:
                customer_for_order = resolve_customer_for_account_payload(
                    business,
                    branch,
                    data,
                    create_if_missing=True,
                )
            except Exception as account_exc:
                return {
                    'success': False,
                    'error': _validation_error_message(account_exc),
                }

            if customer_required_payment and not customer_for_order:
                required_label = 'On Account' if payment_method_is_credit else 'Laybuy'
                return {
                    'success': False,
                    'error': f'{required_label} sales require a customer account or customer name/phone.',
                }

            if customer_for_order and payment_method_is_credit and not customer_for_order.account_enabled:
                return {
                    'success': False,
                    'error': 'This customer account is not enabled for credit sales.',
                }

            if customer_for_order and payment_method_is_credit:
                credit_limit = _quantize_money(customer_for_order.credit_limit)
                projected_balance = _quantize_money(customer_for_order.current_balance) + _quantize_money(total)
                if credit_limit > 0 and projected_balance > credit_limit:
                    available_credit = credit_limit - _quantize_money(customer_for_order.current_balance)
                    return {
                        'success': False,
                        'error': f'Credit limit exceeded. Available credit is {available_credit}.',
                    }

            if payment_method_is_laybuy and _extract_laybuy_deposit(data) > _quantize_money(total):
                return {
                    'success': False,
                    'error': 'Laybuy deposit cannot exceed the sale total.',
                }

        order_data = {
            'id': order_id,
            'business': business,
            'branch': branch,
            'customer': customer_for_order,
            'order_number': order_number,
            'order_type': data.get('orderType', 'sale'),
            'status': data.get('status', 'New'),
            'payment_method': payment_method,
            'pump_name': data.get('pump_name') or data.get('pumpName'),
            'customer_name': data.get('customer_name') or data.get('customerName') or getattr(customer_for_order, 'name', None),
            'customer_phone': data.get('customer_phone') or data.get('customerPhone') or getattr(customer_for_order, 'phone', None),
            'customer_tin': data.get('customer_tin') or data.get('customerTin') or getattr(customer_for_order, 'customer_tin', None),
            'customer_email': data.get('customer_email') or data.get('customerEmail') or getattr(customer_for_order, 'email', None),
            'customer_address': data.get('customer_address') or data.get('customerAddress') or getattr(customer_for_order, 'address', None),
            'customer_notes': data.get('customer_notes') or data.get('customerNotes'),
            'buyer_name': data.get('buyer_name') or data.get('buyerName'),
            'buyer_tin': data.get('buyer_tin') or data.get('buyerTin'),
            'subtotal': _quantize_money(subtotal),
            'total': _quantize_money(total),
            'cogs': Decimal('0.00') if payment_method_is_laybuy else _quantize_money(_to_decimal(data.get('cogs'), Decimal('0'))),
            'created_at': data.get('createdAt'),
            'updated_at': data.get('updatedAt'),
        }
        
        # Handle tax fields if provided
        if data.get('tax_rate_name'):
            order_data['tax_rate_name'] = data.get('tax_rate_name')
        if data.get('tax_rate_value'):
            order_data['tax_rate_value'] = float(data.get('tax_rate_value'))
        if data.get('tax_type'):
            order_data['tax_type'] = data.get('tax_type')
        
        # Set calculated VAT amount - CRITICAL: Use sum of item taxes, not calculated from subtotal
        # This ensures accurate tax when items have different tax rates (mixed tax scenario)
        order_data['vat_amount'] = _quantize_money(vat_amount)
        order_data['net_amount'] = _quantize_money(subtotal)
        order_data['gross_amount'] = _quantize_money(total)
        
        print(f"[Sync Sessions] Order totals - subtotal: {subtotal}, vat_amount: {vat_amount}, total: {total}")
        
        # Enforce current-user active session (only one active session per user).
        session_id = data.get('sessionId') or data.get('session_id') or data.get('session')
        print(f"[Sync Sessions] Order data keys: {data.keys()}")
        print(f"[Sync Sessions] Looking for session_id - sessionId: {data.get('sessionId')}, session_id: {data.get('session_id')}, session: {data.get('session')}")
        print(f"[Sync Sessions] Final session_id: {session_id}")

        active_session = Session.objects.filter(
            user=user,
            business=business,
            branch=branch,
            status='active'
        ).order_by('-started_at').first()

        if not active_session:
            return {
                'success': False,
                'error': 'No active session found for current user in this branch. Please start a session.'
            }

        if session_id and str(session_id) != str(active_session.id):
            print(
                f"[Sync Sessions] Overriding session {session_id} with current user active session {active_session.id}"
            )

        order_data['session'] = active_session

        try:
            validate_stock_available_for_order_lines(data.get('items') or [], business, branch)
        except DjangoValidationError as stock_exc:
            return {
                'success': False,
                'error': _validation_error_message(stock_exc),
            }
        
        # Remove None values
        order_data = {k: v for k, v in order_data.items() if v is not None}
        print(f"[Sync Sessions] Final order_data: {order_data}")
        
        create_attempts = 0
        order = None
        while create_attempts < 3:
            try:
                order = Order.objects.create(**order_data)
                break
            except IntegrityError as ie:
                if 'order_number' not in str(ie):
                    raise

                existing_by_number = Order.objects.filter(
                    branch=branch,
                    order_number=order_number
                ).first()
                if existing_by_number and str(existing_by_number.id) == str(order_id):
                    print(
                        f"[Sync Sessions] Integrity retry resolved for existing order {order_id} "
                        f"with order_number {order_number}"
                    )
                    return {
                        'success': True,
                        **_build_order_sync_payload(existing_by_number)
                    }

                previous_order_number = order_number
                order_number = _next_order_number_for_branch(branch)
                order_data['order_number'] = order_number
                create_attempts += 1
                print(
                    f"[Sync Sessions] UNIQUE order_number conflict (attempt {create_attempts}) "
                    f"for order {order_id}: {previous_order_number} -> {order_number}"
                )

        if order is None:
            return {
                'success': False,
                'error': 'Failed to allocate a unique order number for this sale.'
            }
        
        # Create order items if provided
        if data.get('items'):
            for item_data in data['items']:
                # CRITICAL: Use inventoryItemId (the actual product ID), NOT id (which is the order item ID)
                item_recipe = item_data.get('recipe') if isinstance(item_data.get('recipe'), list) else []
                is_prepared_menu_item = bool(item_data.get('is_prepared_menu_item') or item_data.get('isPreparedMenuItem'))
                inventory_ref = item_data.get('inventoryItemId') or item_data.get('inventory_item_id') or (
                    '' if (is_prepared_menu_item or item_recipe) else item_data.get('id', '')
                )
                inventory_item_id = str(inventory_ref or '').strip()
                menu_item_id = str(item_data.get('menuItemId') or item_data.get('menu_item_id') or '').strip()
                item_name = str(item_data.get('name', '') or '').strip()

                # Normalize legacy payloads where `id` may be an order-item UUID.
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
                        inventory_match = name_matches[0]
                        inventory_item_id = str(inventory_match.id)
                        print(
                            f"[Sync Sessions] Normalized order item reference by name: "
                            f"{item_name} -> {inventory_item_id}"
                        )

                print(f"[Sync Sessions] Creating OrderItem - inventoryItemId: {inventory_item_id}, name: {item_name}")
                
                # Extract per-item tax information (MRA compliance - Immutable snapshot)
                tax_rate = _to_decimal(item_data.get('taxRate') or item_data.get('tax_rate', 0), Decimal('0'))
                tax_type = _normalize_tax_type(item_data.get('taxType') or item_data.get('tax_type', 'standard'))
                tax_calculation_method = str(
                    item_data.get('taxCalculationMethod') or item_data.get('tax_calculation_method', 'inclusive')
                ).strip().lower()
                
                # Extract calculated tax amounts
                item_price = _to_decimal(item_data.get('price'), Decimal('0'))
                item_quantity = _to_decimal(item_data.get('quantity'), Decimal('0'))

                line_base_amount = _resolve_line_base_amount(item_data, tax_calculation_method)

                mapping_for_item = None
                if inventory_item_id:
                    mapping_for_item = MRAProductMapping.objects.filter(
                        inventory_item_id=inventory_item_id,
                        is_approved=True,
                        mra_synced=True,
                    ).first()
                if mapping_for_item:
                    tax_rate = _to_decimal(mapping_for_item.mra_tax_rate, Decimal('0'))
                    tax_type = _normalize_tax_type(mapping_for_item.mra_tax_type)
                    tax_calculation_method = str(mapping_for_item.tax_calculation_method or 'inclusive').strip().lower()
                elif not block_sales_if_tax_mapping_missing and default_tax_rate:
                    if tax_type == 'standard' and tax_rate <= 0:
                        tax_rate = _to_decimal(default_tax_rate.rate, Decimal('0'))
                        tax_type = _normalize_tax_type(default_tax_rate.tax_type)

                tax_values = _calculate_item_tax_values(
                    line_base_amount=line_base_amount,
                    tax_type=tax_type,
                    tax_rate=tax_rate,
                    tax_calculation_method=tax_calculation_method,
                )

                normalized_unit_price = item_price
                if item_quantity > 0:
                    recalculated_line = item_price * item_quantity
                    if abs(recalculated_line - line_base_amount) > Decimal('0.01'):
                        # Legacy payloads can send line total in `price`.
                        normalized_unit_price = (line_base_amount / item_quantity).quantize(Decimal('0.01'))
                elif line_base_amount > 0:
                    # Preserve stored totals even if quantity was omitted/invalid.
                    item_quantity = Decimal('1')
                    normalized_unit_price = line_base_amount.quantize(Decimal('0.01'))

                item_subtotal = tax_values['subtotal']
                item_tax_amount = tax_values['tax_amount']
                item_total = tax_values['total']
                tax_calculation_method = tax_values['tax_method']
                tax_type = tax_values['tax_type']
                tax_rate = tax_values['rate_percent']
                
                print(
                    f"[Sync Sessions] OrderItem tax info - rate: {tax_rate}%, type: {tax_type}, "
                    f"method: {tax_calculation_method}, subtotal: {item_subtotal}, "
                    f"tax: {item_tax_amount}, total: {item_total}, unit_price: {normalized_unit_price}"
                )
                
                OrderItem.objects.create(
                    order=order,
                    inventory_item_id=inventory_item_id,
                    menu_item_id=menu_item_id,
                    name=item_name,
                    quantity=item_quantity.quantize(Decimal('0.001'), rounding=ROUND_HALF_UP),
                    price=normalized_unit_price.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP),
                    notes=item_data.get('notes', ''),
                    recipe=item_data.get('recipe') or [],
                    is_prepared_menu_item=is_prepared_menu_item,
                    selected_options=item_data.get('selected_options') or item_data.get('selectedOptions') or [],
                    # Per-item tax information (MRA compliance - Immutable snapshot)
                    tax_rate=tax_rate.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP),
                    tax_type=tax_type,
                    tax_calculation_method=tax_calculation_method,
                    # Calculated tax amounts (Immutable snapshot for audit trail)
                    subtotal=item_subtotal,
                    tax_amount=item_tax_amount,
                    total=item_total
                )

        # Lock the matched tax rate after first use (MRA immutability requirement).
        # We match by snapshot values saved on the order.
        try:
            tax_rate_name = str(order.tax_rate_name or '').strip()
            tax_rate_value = order.tax_rate_value
            if tax_rate_name or tax_rate_value:
                normalized_tax_rate_value = None
                if tax_rate_value:
                    try:
                        normalized_tax_rate_value = Decimal(str(tax_rate_value))
                    except (InvalidOperation, TypeError, ValueError):
                        normalized_tax_rate_value = None

                tax_rate_query = TaxRate.objects.filter(
                    business=business,
                    is_active=True,
                )
                if tax_rate_name:
                    tax_rate_query = tax_rate_query.filter(name=tax_rate_name)
                if normalized_tax_rate_value is not None:
                    tax_rate_query = tax_rate_query.filter(rate=normalized_tax_rate_value)
                matched_tax_rate = tax_rate_query.order_by('-is_default', '-effective_from').first()
                lock_tax_rate_on_use(matched_tax_rate)
        except Exception as lock_exc:
            print(f"[Sync Sessions] Warning: tax lock update failed for order {order_id}: {lock_exc}")

        # Prepare order for MRA EIS pipeline.
        # In live mode with block_sales_if_eis_down enabled, this becomes blocking.
        business_settings = None
        try:
            try:
                business_settings = order.business.settings
            except Exception:
                business_settings = None
            eis_enabled = bool(getattr(business_settings, 'enable_eis', False))
            if eis_enabled:
                from mra_eis.services import POSOrderSubmissionService

                mra_result = POSOrderSubmissionService.prepare_pos_order_submission(order)
                print(
                    f"[Sync Sessions] Prepared MRA payload for order {order.id}: "
                    f"fiscal={mra_result.get('fiscal_invoice_number')} dry_run={mra_result.get('dry_run')}"
                )
                if _should_block_sales_if_eis_down(business_settings):
                    block_reason = _get_mra_submission_block_reason(mra_result)
                    if block_reason:
                        print(
                            f"[Sync Sessions] ✗ BLOCKED order {order_id}: "
                            f"{block_reason} block_sales_if_eis_down is enabled."
                        )
                        order.delete()
                        return {
                            'success': False,
                            'error': (
                                f"{block_reason} "
                                "Sale blocked by compliance policy (block_sales_if_eis_down)."
                            ),
                        }
        except Exception as mra_exc:
            print(f"[Sync Sessions] Warning: MRA preparation failed for order {order.id}: {str(mra_exc)}")
            try:
                from mra_eis.services import MRAIntegrationError
            except Exception:
                MRAIntegrationError = Exception

            if isinstance(mra_exc, MRAIntegrationError):
                order.delete()
                return {
                    'success': False,
                    'error': str(mra_exc),
                }

            if _should_block_sales_if_eis_down(business_settings):
                print(
                    f"[Sync Sessions] ✗ BLOCKED order {order_id}: "
                    "MRA submission unavailable and block_sales_if_eis_down is enabled."
                )
                order.delete()
                return {
                    'success': False,
                    'error': (
                        "MRA EIS unavailable. Sale blocked by compliance policy "
                        f"(block_sales_if_eis_down). Details: {str(mra_exc)}"
                    ),
                }

        if str(order.payment_method or '').strip().lower() == 'on account':
            try:
                account_tx = record_credit_sale_for_order(order, created_by=user)
                order.refresh_from_db()
                print(
                    f"[Sync Sessions] Customer account debit created for order {order.id}: "
                    f"{account_tx.amount if account_tx else 'n/a'}"
                )
            except Exception as account_exc:
                print(f"[Sync Sessions] ✗ Customer account debit failed for order {order_id}: {account_exc}")
                order.delete()
                return {
                    'success': False,
                    'error': _validation_error_message(account_exc),
                }

        if str(order.payment_method or '').strip().lower() == 'laybuy':
            try:
                laybuy_deposit = _extract_laybuy_deposit(data)
                laybuy_deposit_method = data.get('laybuy_payment_method') or data.get('laybuyPaymentMethod') or 'Cash'
                laybuy = create_laybuy_for_order(
                    order,
                    deposit_amount=laybuy_deposit,
                    payment_method=laybuy_deposit_method,
                    reference=data.get('laybuy_reference') or data.get('laybuyReference') or '',
                    notes=data.get('laybuy_notes') or data.get('laybuyNotes') or '',
                    created_by=user,
                )
                print(
                    f"[Sync Sessions] Laybuy created for order {order.id}: "
                    f"{laybuy.laybuy_number if laybuy else 'n/a'}"
                )
            except Exception as laybuy_exc:
                print(f"[Sync Sessions] ✗ Laybuy creation failed for order {order_id}: {laybuy_exc}")
                order.delete()
                return {
                    'success': False,
                    'error': _validation_error_message(laybuy_exc),
                }

        tip_amount = _quantize_money(_to_decimal(data.get('tip'), Decimal('0')))
        if tip_amount > 0 and order.session_id:
            order.session.total_tips = (order.session.total_tips or Decimal('0.00')) + tip_amount
            if str(order.payment_method or '').strip().lower() == 'cash':
                order.session.expected_cash = (order.session.expected_cash or Decimal('0.00')) + tip_amount
                order.session.save(update_fields=['total_tips', 'expected_cash', 'updated_at'])
            else:
                order.session.save(update_fields=['total_tips', 'updated_at'])

        # Decrement inventory stock for completed sales using FIFO. Laybuy is
        # reserved now and consumed when the customer collects the goods.
        try:
            if str(order.payment_method or '').strip().lower() == 'laybuy':
                print(f"[Sync Sessions] Skipping immediate stock decrement for laybuy order {order_id}; stock is reserved until collection")
            else:
                print(f"[Sync Sessions] Decrementing inventory stock for order {order_id}")
                decrement_inventory_for_order(order, branch, business)
        except Exception as e:
            print(f"[Sync Sessions] Warning: Failed to decrement inventory: {str(e)}")
            # Don't fail the order creation if inventory decrement fails
            # The frontend already decremented it locally
        
        print(f"[Sync Sessions] Created order {order_id}")
        
        return {
            'success': True,
            **_build_order_sync_payload(order)
        }
        
    except IntegrityError as ie:
        print(f"[Sync Sessions] IntegrityError creating order: {str(ie)}")
        return {
            'success': False,
            'error': f'Integrity error: {str(ie)}'
        }
    except Exception as e:
        print(f"[Sync Sessions] Error creating order: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


def handle_update_order(order_id, data, business, branch_id, user):
    """Handle update of order from frontend"""
    try:
        order = Order.objects.get(id=order_id, business=business, branch_id=branch_id)
        
        # Update fields
        if 'status' in data:
            order.status = data['status']
        if 'paymentMethod' in data:
            order.payment_method = data['paymentMethod']
        if 'pumpName' in data or 'pump_name' in data:
            order.pump_name = data.get('pump_name') or data.get('pumpName')
        if 'subtotal' in data:
            order.subtotal = data['subtotal']
        if 'total' in data:
            order.total = data['total']
        if 'cogs' in data:
            order.cogs = data['cogs']
        if 'customerName' in data or 'customer_name' in data:
            order.customer_name = data.get('customer_name') or data.get('customerName')
        if 'customerPhone' in data or 'customer_phone' in data:
            order.customer_phone = data.get('customer_phone') or data.get('customerPhone')
        if 'customerTin' in data or 'customer_tin' in data:
            order.customer_tin = data.get('customer_tin') or data.get('customerTin')
        if 'customerEmail' in data or 'customer_email' in data:
            order.customer_email = data.get('customer_email') or data.get('customerEmail')
        if 'customerAddress' in data or 'customer_address' in data:
            order.customer_address = data.get('customer_address') or data.get('customerAddress')
        if 'customerNotes' in data or 'customer_notes' in data:
            order.customer_notes = data.get('customer_notes') or data.get('customerNotes')
        if 'buyerName' in data or 'buyer_name' in data:
            order.buyer_name = data.get('buyer_name') or data.get('buyerName')
        if 'buyerTin' in data or 'buyer_tin' in data:
            order.buyer_tin = data.get('buyer_tin') or data.get('buyerTin')
        if 'customer' in data or 'customer_id' in data or 'customerId' in data:
            customer = resolve_customer_for_account_payload(
                business,
                order.branch,
                data,
                create_if_missing=False,
            )
            if customer:
                order.customer = customer
        
        # Handle tax fields if provided
        if 'tax_rate_name' in data:
            order.tax_rate_name = data['tax_rate_name']
        if 'tax_rate_value' in data:
            order.tax_rate_value = float(data['tax_rate_value'])
        if 'tax_type' in data:
            order.tax_type = data['tax_type']
        if 'vat_amount' in data:
            order.vat_amount = float(data['vat_amount'])
        if 'net_amount' in data:
            order.net_amount = float(data['net_amount'])
        if 'gross_amount' in data:
            order.gross_amount = float(data['gross_amount'])
        
        order.save()

        if str(order.payment_method or '').strip().lower() == 'on account':
            try:
                record_credit_sale_for_order(order, created_by=user)
            except Exception as account_exc:
                return {
                    'success': False,
                    'error': _validation_error_message(account_exc),
                }

        if str(order.payment_method or '').strip().lower() == 'laybuy':
            try:
                laybuy_deposit = _extract_laybuy_deposit(data)
                laybuy_deposit_method = data.get('laybuy_payment_method') or data.get('laybuyPaymentMethod') or 'Cash'
                create_laybuy_for_order(
                    order,
                    deposit_amount=laybuy_deposit,
                    payment_method=laybuy_deposit_method,
                    reference=data.get('laybuy_reference') or data.get('laybuyReference') or '',
                    notes=data.get('laybuy_notes') or data.get('laybuyNotes') or '',
                    created_by=user,
                )
            except Exception as laybuy_exc:
                return {
                    'success': False,
                    'error': _validation_error_message(laybuy_exc),
                }

        # Keep lock behavior consistent for orders updated via sync.
        try:
            tax_rate_name = str(order.tax_rate_name or '').strip()
            tax_rate_value = order.tax_rate_value
            if tax_rate_name or tax_rate_value:
                normalized_tax_rate_value = None
                if tax_rate_value:
                    try:
                        normalized_tax_rate_value = Decimal(str(tax_rate_value))
                    except (InvalidOperation, TypeError, ValueError):
                        normalized_tax_rate_value = None

                tax_rate_query = TaxRate.objects.filter(
                    business=business,
                    is_active=True,
                )
                if tax_rate_name:
                    tax_rate_query = tax_rate_query.filter(name=tax_rate_name)
                if normalized_tax_rate_value is not None:
                    tax_rate_query = tax_rate_query.filter(rate=normalized_tax_rate_value)
                matched_tax_rate = tax_rate_query.order_by('-is_default', '-effective_from').first()
                lock_tax_rate_on_use(matched_tax_rate)
        except Exception as lock_exc:
            print(f"[Sync Sessions] Warning: tax lock update failed for order {order_id}: {lock_exc}")

        print(f"[Sync Sessions] Updated order {order_id}")
        
        return {
            'success': True,
            **_build_order_sync_payload(order)
        }
        
    except Order.DoesNotExist:
        print(f"[Sync Sessions] Order {order_id} not found, creating instead")
        return handle_create_order(order_id, data, business, branch_id, user)
    except Exception as e:
        print(f"[Sync Sessions] Error updating order: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }


def handle_delete_order(order_id, business, branch_id):
    """Handle deletion of order from frontend"""
    try:
        order = Order.objects.get(id=order_id, business=business, branch_id=branch_id)
        order.delete()
        print(f"[Sync Sessions] Deleted order {order_id}")
        
        return {
            'success': True,
            'server_id': order_id
        }
        
    except Order.DoesNotExist:
        print(f"[Sync Sessions] Order {order_id} not found for deletion")
        return {
            'success': True,
            'server_id': order_id
        }
    except Exception as e:
        print(f"[Sync Sessions] Error deleting order: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }


def decrement_inventory_for_order(order, branch, business):
    """
    Decrement inventory stock for all items in an order using FIFO method.
    This ensures backend stock is synchronized with frontend stock decrements.
    
    FIFO Process:
    1. Get all purchase history batches for the item ordered by received_date
    2. Decrement quantity_remaining from oldest batches first
    3. Update main inventory item stock
    4. Track which batches were used for audit trail
    
    CRITICAL FIX: Always update inventory stock, even when it reaches exactly 0
    """
    from collections import defaultdict
    from decimal import Decimal, InvalidOperation
    from django.db.models import Sum
    from inventory.models import InventoryItem, PurchaseOrderItem

    def parse_positive_decimal(value, label):
        try:
            parsed = Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError):
            print(f"[Sync Sessions] Warning: Invalid decimal for {label}: {value}")
            return Decimal('0')
        if parsed.is_nan() or parsed.is_infinite():
            print(f"[Sync Sessions] Warning: Non-finite decimal for {label}: {value}")
            return Decimal('0')
        return parsed if parsed > 0 else Decimal('0')

    def parse_non_negative_decimal(value, label):
        try:
            parsed = Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError):
            print(f"[Sync Sessions] Warning: Invalid decimal for {label}: {value}")
            return Decimal('0')
        if parsed.is_nan() or parsed.is_infinite():
            print(f"[Sync Sessions] Warning: Non-finite decimal for {label}: {value}")
            return Decimal('0')
        return parsed if parsed >= 0 else Decimal('0')

    def parse_decimal(value, label):
        try:
            parsed = Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError):
            print(f"[Sync Sessions] Warning: Invalid decimal for {label}: {value}")
            return Decimal('0')
        if parsed.is_nan() or parsed.is_infinite():
            print(f"[Sync Sessions] Warning: Non-finite decimal for {label}: {value}")
            return Decimal('0')
        return parsed

    def decimal_to_quantity_string(value):
        normalized = parse_non_negative_decimal(value, "trace.quantity")
        return format(normalized.quantize(Decimal('0.001')), 'f')

    def resolve_inventory_item(reference, item_name=''):
        """Resolve inventory item robustly from id/sku/barcode/name."""
        ref = str(reference or '').strip()
        if ref:
            by_id = InventoryItem.objects.filter(
                id=ref,
                business=business,
                branch=branch,
            ).first()
            if by_id:
                return by_id

            by_sku = InventoryItem.objects.filter(
                sku__iexact=ref,
                business=business,
                branch=branch,
            ).first()
            if by_sku:
                return by_sku

            by_barcode = InventoryItem.objects.filter(
                barcode__iexact=ref,
                business=business,
                branch=branch,
            ).first()
            if by_barcode:
                return by_barcode

        normalized_name = str(item_name or '').strip()
        if normalized_name:
            name_matches = list(
                InventoryItem.objects.filter(
                    name__iexact=normalized_name,
                    business=business,
                    branch=branch,
                )[:2]
            )
            if len(name_matches) == 1:
                return name_matches[0]

        return None

    def normalize_trace_entries(trace_entries):
        """Collapse duplicate trace rows per (inventory item, batch, unassigned flag)."""
        aggregated = defaultdict(lambda: Decimal('0'))
        for entry in trace_entries:
            if not isinstance(entry, dict):
                continue
            inventory_item_id = str(entry.get('inventory_item_id') or '').strip()
            raw_batch_id = entry.get('batch_id')
            batch_id = str(raw_batch_id).strip() if raw_batch_id else ''
            is_unassigned = bool(entry.get('unassigned'))
            quantity = parse_positive_decimal(
                entry.get('quantity'),
                f"trace.entry.quantity:{inventory_item_id}:{batch_id or 'none'}"
            )
            if not inventory_item_id or quantity <= 0:
                continue
            key = (inventory_item_id, batch_id, is_unassigned)
            aggregated[key] += quantity

        normalized = []
        for (inventory_item_id, batch_id, is_unassigned), quantity in aggregated.items():
            row = {
                'inventory_item_id': inventory_item_id,
                'batch_id': batch_id or None,
                'quantity': decimal_to_quantity_string(quantity),
            }
            if is_unassigned:
                row['unassigned'] = True
            normalized.append(row)
        return normalized

    def register_target(target_reference, target_name, quantity, order_item_id, context='direct'):
        if quantity <= 0:
            return
        target_ref = str(target_reference or '').strip()
        if not target_ref:
            return
        resolved_target = resolve_inventory_item(target_ref, target_name)
        target_id = str(resolved_target.id) if resolved_target else target_ref

        decrement_targets[target_id] += quantity
        contributors_by_target[target_id].append({
            'order_item_id': order_item_id,
            'quantity': quantity,
            'context': context,
        })

    print(f"[Sync Sessions] Starting inventory decrement for order {order.id}")

    order_items = list(order.items.all().order_by('created_at', 'id'))
    allow_negative_stock = _business_allows_negative_stock(business)
    decrement_targets = defaultdict(lambda: Decimal('0'))
    contributors_by_target = defaultdict(list)
    per_order_item_usage = defaultdict(list)
    total_cogs_applied = Decimal('0.00')

    for order_item in order_items:
        sold_item_id = str(order_item.inventory_item_id or '').strip()
        sold_quantity = parse_positive_decimal(order_item.quantity, f"order_item.quantity:{sold_item_id}")
        if sold_quantity <= 0:
            continue

        print(f"[Sync Sessions] Processing order line: {sold_item_id}, sold quantity: {sold_quantity}")

        line_recipe_entries = order_item.recipe if isinstance(getattr(order_item, 'recipe', None), list) else []
        is_prepared_menu_item = bool(getattr(order_item, 'is_prepared_menu_item', False))
        sold_inventory_item = None if (is_prepared_menu_item and not sold_item_id) else resolve_inventory_item(sold_item_id, order_item.name)

        if not sold_inventory_item and not line_recipe_entries:
            print(f"[Sync Sessions] Warning: Sold inventory item {sold_item_id} not found in branch {branch.id}")
            continue

        resolved_sold_item_id = str(sold_inventory_item.id) if sold_inventory_item else sold_item_id
        if sold_inventory_item and resolved_sold_item_id != sold_item_id:
            print(
                f"[Sync Sessions] Normalized sold item reference {sold_item_id} -> {resolved_sold_item_id} "
                f"({sold_inventory_item.name})"
            )
            sold_item_id = resolved_sold_item_id
            if str(order_item.inventory_item_id) != resolved_sold_item_id:
                order_item.inventory_item_id = resolved_sold_item_id
                order_item.save(update_fields=['inventory_item_id', 'updated_at'])

        recipe_entries = (
            line_recipe_entries
            if line_recipe_entries
            else (sold_inventory_item.recipe if sold_inventory_item and isinstance(sold_inventory_item.recipe, list) else [])
        )
        if recipe_entries and (is_prepared_menu_item or not sold_inventory_item or sold_inventory_item.item_type == 'sellable'):
            print(f"[Sync Sessions] Item {order_item.name} has a recipe; decrementing recipe ingredients")

            for recipe_item in recipe_entries:
                ingredient_id = (
                    recipe_item.get('ingredientId')
                    or recipe_item.get('ingredient_id')
                    or recipe_item.get('inventoryItemId')
                    or recipe_item.get('inventory_item_id')
                    or recipe_item.get('id')
                )
                ingredient_name = str(recipe_item.get('name') or '').strip()
                ingredient_per_unit = parse_positive_decimal(
                    recipe_item.get('quantity'),
                    f"recipe.quantity:{ingredient_id}"
                )
                if not ingredient_id or ingredient_per_unit <= 0:
                    continue

                decrement_amount = sold_quantity * ingredient_per_unit
                register_target(
                    target_reference=ingredient_id,
                    target_name=ingredient_name,
                    quantity=decrement_amount,
                    order_item_id=order_item.id,
                    context=f"recipe:{ingredient_id}",
                )
                print(
                    f"[Sync Sessions] Recipe target {ingredient_id}: +{decrement_amount} "
                    f"(sold {sold_quantity} x {ingredient_per_unit})"
                )
        else:
            register_target(
                target_reference=sold_item_id,
                target_name=order_item.name,
                quantity=sold_quantity,
                order_item_id=order_item.id,
                context='direct',
            )
            print(f"[Sync Sessions] Direct stock target {sold_item_id}: +{sold_quantity}")

        selected_options = order_item.selected_options if isinstance(order_item.selected_options, list) else []
        for option in selected_options:
            if not isinstance(option, dict):
                continue

            option_multiplier = sold_quantity * _modifier_quantity(option)
            option_name = str(option.get('name') or option.get('label') or 'Selected option').strip()
            for recipe_item in _recipe_entries_for_modifier(option):
                modifier_target_id = (
                    recipe_item.get('ingredientId')
                    or recipe_item.get('ingredient_id')
                    or recipe_item.get('inventoryItemId')
                    or recipe_item.get('inventory_item_id')
                    or recipe_item.get('linkedInventoryItemId')
                    or recipe_item.get('linked_inventory_item_id')
                    or recipe_item.get('id')
                )
                modifier_target_name = str(recipe_item.get('name') or option_name).strip()
                modifier_per_unit = parse_positive_decimal(
                    recipe_item.get('quantity'),
                    f"modifier.recipe.quantity:{modifier_target_id}"
                )
                if not modifier_target_id or modifier_per_unit <= 0 or option_multiplier <= 0:
                    continue

                decrement_amount = option_multiplier * modifier_per_unit
                register_target(
                    target_reference=modifier_target_id,
                    target_name=modifier_target_name,
                    quantity=decrement_amount,
                    order_item_id=order_item.id,
                    context=f"modifier:{option.get('id') or option_name}",
                )
                print(
                    f"[Sync Sessions] Modifier target {modifier_target_id}: +{decrement_amount} "
                    f"({option_name}, sold {sold_quantity} x option {option_multiplier / sold_quantity} "
                    f"x {modifier_per_unit})"
                )

    for target_item_id, quantity_to_decrement in decrement_targets.items():
        if quantity_to_decrement <= 0:
            continue

        try:
            inventory_item = resolve_inventory_item(target_item_id)
            if not inventory_item:
                raise InventoryItem.DoesNotExist()

            item_id = str(inventory_item.id)
            if item_id != str(target_item_id):
                print(
                    f"[Sync Sessions] Normalized decrement target {target_item_id} -> {item_id} "
                    f"({inventory_item.name})"
                )

            print(
                f"[Sync Sessions] Applying decrement for {inventory_item.name} ({item_id}): "
                f"{quantity_to_decrement}, current stock: {inventory_item.stock_units}"
            )

            remaining_to_decrement = quantity_to_decrement
            batches_used = []

            batches_qs = PurchaseOrderItem.objects.filter(
                inventory_item_id=item_id,
                purchase_order__branch=branch,
                quantity_remaining__gt=0
            ).select_related('purchase_order')

            batches = list(batches_qs)
            batches.sort(
                key=lambda batch: (
                    batch.expiry_date is None,
                    batch.expiry_date or datetime.max.date(),
                    batch.purchase_order.received_date or batch.created_at,
                    batch.created_at,
                )
            )

            print(f"[Sync Sessions] Found {len(batches)} available batches for FIFO decrement")

            for batch in batches:
                if remaining_to_decrement <= 0:
                    break

                batch_remaining = parse_non_negative_decimal(
                    batch.quantity_remaining,
                    f"batch.quantity_remaining:{batch.id}"
                )
                decrement_amount = min(remaining_to_decrement, batch_remaining)
                if decrement_amount <= 0:
                    continue

                old_remaining = batch.quantity_remaining
                batch.quantity_remaining = batch_remaining - decrement_amount
                batch.save()
                batch_cost = parse_non_negative_decimal(
                    batch.cost_per_unit,
                    f"batch.cost_per_unit:{batch.id}"
                )
                total_cogs_applied += decrement_amount * batch_cost

                batches_used.append({
                    'batch_id': str(batch.id),
                    'received_date': batch.purchase_order.received_date.isoformat() if batch.purchase_order.received_date else None,
                    'decremented': decrement_amount,
                    'remaining_before': parse_non_negative_decimal(old_remaining, f"batch.old_remaining:{batch.id}"),
                    'remaining_after': parse_non_negative_decimal(batch.quantity_remaining, f"batch.new_remaining:{batch.id}"),
                })

                print(
                    f"[Sync Sessions] FIFO Batch {batch.id}: decremented {decrement_amount}, "
                    f"remaining {old_remaining} -> {batch.quantity_remaining}"
                )

                remaining_to_decrement -= decrement_amount

            contributors = contributors_by_target.get(target_item_id, [])
            if not contributors and item_id != target_item_id:
                contributors = contributors_by_target.get(item_id, [])

            if contributors:
                allocation_batches = [
                    {
                        'batch_id': batch_info['batch_id'],
                        'remaining': parse_positive_decimal(
                            batch_info.get('decremented'),
                            f"allocation.remaining:{batch_info.get('batch_id')}"
                        ),
                    }
                    for batch_info in batches_used
                ]
                batch_cursor = 0

                for contributor in contributors:
                    contributor_remaining = parse_positive_decimal(
                        contributor.get('quantity'),
                        f"contributor.quantity:{contributor.get('order_item_id')}"
                    )
                    order_item_id = contributor.get('order_item_id')
                    if not order_item_id or contributor_remaining <= 0:
                        continue

                    while contributor_remaining > 0 and batch_cursor < len(allocation_batches):
                        allocation_batch = allocation_batches[batch_cursor]
                        allocatable = allocation_batch.get('remaining', Decimal('0'))
                        if allocatable <= 0:
                            batch_cursor += 1
                            continue

                        allocation_amount = min(contributor_remaining, allocatable)
                        if allocation_amount <= 0:
                            break

                        per_order_item_usage[order_item_id].append({
                            'inventory_item_id': item_id,
                            'batch_id': allocation_batch['batch_id'],
                            'quantity': decimal_to_quantity_string(allocation_amount),
                        })

                        allocation_batch['remaining'] = allocatable - allocation_amount
                        contributor_remaining -= allocation_amount

                        if allocation_batch['remaining'] <= 0:
                            batch_cursor += 1

                    if contributor_remaining > 0:
                        # Decrement happened without an attributable batch (or insufficient batch trail).
                        # Persist as unassigned so void can fallback safely for legacy/no-batch scenarios.
                        per_order_item_usage[order_item_id].append({
                            'inventory_item_id': item_id,
                            'batch_id': None,
                            'quantity': decimal_to_quantity_string(contributor_remaining),
                            'unassigned': True,
                        })

            if remaining_to_decrement > 0:
                print(
                    f"[Sync Sessions] Warning: Could not fully decrement item {item_id}. "
                    f"Remaining: {remaining_to_decrement}"
                )

            old_stock = parse_decimal(inventory_item.stock_units, f"inventory.stock_units:{item_id}")
            can_go_negative = allow_negative_stock
            if batches:
                batch_total = (
                    PurchaseOrderItem.objects.filter(
                        inventory_item_id=item_id,
                        purchase_order__branch=branch,
                    )
                    .aggregate(total=Sum('quantity_remaining'))
                    .get('total')
                )
                final_stock = parse_non_negative_decimal(batch_total, f"inventory.batch_total:{item_id}")
                if remaining_to_decrement > 0 and can_go_negative:
                    final_stock -= remaining_to_decrement
                    item_cost = parse_non_negative_decimal(inventory_item.cost, f"inventory.cost:{item_id}")
                    total_cogs_applied += remaining_to_decrement * item_cost
            else:
                new_stock = old_stock - quantity_to_decrement
                final_stock = new_stock if can_go_negative else max(Decimal('0'), new_stock)
                stock_decrement_amount = quantity_to_decrement if can_go_negative else min(quantity_to_decrement, max(Decimal('0'), old_stock))
                item_cost = parse_non_negative_decimal(inventory_item.cost, f"inventory.cost:{item_id}")
                total_cogs_applied += stock_decrement_amount * item_cost

            inventory_item.stock_units = final_stock
            inventory_item.value = final_stock * (inventory_item.cost or Decimal('0'))
            inventory_item.update_status()

            print(
                f"[Sync Sessions] Updated inventory item {item_id}: stock {old_stock} -> {final_stock} "
                f"(quantity_to_decrement: {quantity_to_decrement})"
            )
            print(f"[Sync Sessions] FIFO batches used: {len(batches_used)}")
            for batch_info in batches_used:
                print(
                    f"  - Batch {batch_info['batch_id']} (received: {batch_info['received_date']}): "
                    f"{batch_info['remaining_before']} -> {batch_info['remaining_after']} "
                    f"(decremented: {batch_info['decremented']})"
                )

        except InventoryItem.DoesNotExist:
            print(f"[Sync Sessions] Warning: Inventory item {target_item_id} not found in branch {branch.id}")
            continue
        except Exception as e:
            print(f"[Sync Sessions] Error decrementing inventory for item {target_item_id}: {str(e)}")
            import traceback
            traceback.print_exc()
            continue

    for order_item in order_items:
        normalized_trace = normalize_trace_entries(per_order_item_usage.get(order_item.id, []))
        if order_item.batch_consumption != normalized_trace:
            order_item.batch_consumption = normalized_trace
            order_item.save(update_fields=['batch_consumption', 'updated_at'])

    print(f"[Sync Sessions] Completed inventory decrement for order {order.id}")
    return total_cogs_applied.quantize(Decimal('0.01'))
