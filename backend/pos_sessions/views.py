from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.exceptions import ValidationError
from .models import Session, Order, OrderItem
from .serializers import SessionSerializer, OrderSerializer, OrderItemSerializer
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
import re
from decimal import Decimal, InvalidOperation
from business.access import get_accessible_business_ids

NON_BLOCKING_OFFLINE_DRY_RUN_REASONS = {
    'submission_call_failed',
    'connection_error',
    'timeout',
    'network_error',
    'eis_unreachable',
}


def _normalize_branch_reference(raw_reference):
    """
    Normalize branch references from client query params.
    Supports integer IDs, BRN-<id>, and string aliases.
    """
    if raw_reference is None:
        return None

    value = str(raw_reference).strip()
    if not value:
        return None

    lowered = value.lower()
    if lowered in {'nan', 'null', 'none', 'undefined'}:
        return None

    legacy_match = re.match(r'^BRN-(\d+)$', value, flags=re.IGNORECASE)
    if legacy_match:
        return int(legacy_match.group(1))

    if value.isdigit():
        return int(value)

    return value


def _apply_branch_filter(queryset, branch_reference, field_name='branch'):
    """
    Apply branch filter safely without raising ValueError on non-numeric values.
    Supports numeric IDs, BRN-<id>, "main", slug, and branch name.
    """
    lookup = _normalize_branch_reference(branch_reference)
    if lookup is None:
        return queryset

    if isinstance(lookup, int):
        return queryset.filter(**{f'{field_name}_id': lookup})

    normalized = lookup.lower()
    if normalized in {'main', 'main-branch', 'main_branch'}:
        return queryset.filter(**{f'{field_name}__name__iendswith': 'Main Branch'})

    return queryset.filter(
        Q(**{f'{field_name}__slug': lookup}) |
        Q(**{f'{field_name}__name__iexact': lookup})
    )


def _enforce_mra_submission_policy(order, business_settings, mra_result):
    """
    Enforce MRA live-mode blocking rule when EIS is unreachable.

    If block_sales_if_eis_down is enabled, a sale must not complete unless
    MRA submission is confirmed in live mode.
    """
    if not getattr(settings, 'MRA_EIS_IS_LIVE', False):
        return
    if not business_settings:
        return
    if not bool(getattr(business_settings, 'enable_eis', False)):
        return
    if not bool(getattr(business_settings, 'block_sales_if_eis_down', True)):
        return

    if not isinstance(mra_result, dict):
        raise ValidationError(
            {'error': 'MRA EIS submission did not return a valid response. Sale blocked by compliance policy.'}
        )

    endpoint_key = str(mra_result.get('endpoint') or '').strip().lower()

    response_payload = mra_result.get('response')
    reason = 'eis_unreachable'
    if isinstance(response_payload, dict):
        reason = str(response_payload.get('reason') or reason).strip().lower()

    # Allow offline dry-run only for genuine connectivity issues.
    if (
        endpoint_key == 'report_sale_offline'
        and mra_result.get('dry_run')
        and reason in NON_BLOCKING_OFFLINE_DRY_RUN_REASONS
    ):
        return

    if mra_result.get('dry_run'):
        raise ValidationError(
            {
                'error': 'MRA EIS unavailable. Sale blocked by compliance policy (block_sales_if_eis_down).',
                'reason': reason,
                'order_id': str(order.id),
            }
        )

    eis_status = str(mra_result.get('eis_status') or '').upper()
    if eis_status != 'SUBMITTED':
        raise ValidationError(
            {
                'error': 'MRA EIS did not confirm submission. Sale blocked by compliance policy (block_sales_if_eis_down).',
                'eis_status': eis_status or 'UNKNOWN',
                'order_id': str(order.id),
            }
        )


def _django_validation_message(exc):
    if hasattr(exc, 'message_dict'):
        return exc.message_dict
    if hasattr(exc, 'messages'):
        return ' '.join(str(message) for message in exc.messages)
    if hasattr(exc, 'message'):
        return exc.message
    return str(exc)


def _decimal_from_request(value, default='0'):
    if value is None or value == '':
        value = default
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(default)


def _money_close_payload(value):
    if value in (None, ''):
        return value
    try:
        return Decimal(str(value)).quantize(Decimal('0.01'))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError({'error': f'Invalid money amount: {value}'})


class OrderItemViewSet(viewsets.ModelViewSet):
    """ViewSet for managing order items"""
    queryset = OrderItem.objects.all()
    serializer_class = OrderItemSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """Filter order items by order"""
        order_id = self.request.query_params.get('order_id')
        
        queryset = OrderItem.objects.filter(
            order__business_id__in=get_accessible_business_ids(self.request.user)
        )
        
        if order_id:
            queryset = queryset.filter(order_id=order_id)
        
        return queryset


class OrderViewSet(viewsets.ModelViewSet):
    """ViewSet for managing POS orders"""
    queryset = Order.objects.all()
    serializer_class = OrderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """Filter orders by session and branch"""
        session_id = self.request.query_params.get('session_id')
        branch_id = self.request.query_params.get('branch_id')
        
        queryset = Order.objects.filter(
            business_id__in=get_accessible_business_ids(self.request.user)
        )
        
        if session_id:
            queryset = queryset.filter(session_id=session_id)
        
        if branch_id:
            queryset = _apply_branch_filter(queryset, branch_id)
        
        return queryset

    def create(self, request, *args, **kwargs):
        """
        Create order and apply backend stock movement using FIFO.
        This keeps backend inventory + purchase batches authoritative and aligned
        with expiry-aware stock consumption.
        """
        from business.models import Branch
        from .sync_views import decrement_inventory_for_order
        
        # Prepare data for serializer
        data = request.data.copy()
        
        branch_obj = None
        # Resolve branch ID to branch object if needed
        if 'branch' in data and isinstance(data['branch'], str):
            try:
                branch_obj = Branch.objects.get(
                    id=data['branch'],
                    business_id__in=get_accessible_business_ids(request.user),
                )
                data['branch'] = branch_obj.id
            except Branch.DoesNotExist:
                return Response(
                    {'error': f'Branch {data["branch"]} not found'},
                    status=status.HTTP_400_BAD_REQUEST
                )
        elif 'branch' in data:
            try:
                branch_obj = Branch.objects.get(
                    id=data['branch'],
                    business_id__in=get_accessible_business_ids(request.user),
                )
            except Branch.DoesNotExist:
                return Response(
                    {'error': f'Branch {data["branch"]} not found'},
                    status=status.HTTP_400_BAD_REQUEST
                )
        
        # Enforce current-user active session (only one active session per user).
        active_session_qs = Session.objects.filter(user=request.user, status='active')
        if branch_obj:
            active_session_qs = active_session_qs.filter(branch=branch_obj)
            if getattr(branch_obj, 'business', None):
                active_session_qs = active_session_qs.filter(business=branch_obj.business)

        active_session = active_session_qs.order_by('-started_at').first()
        if not active_session:
            return Response(
                {'error': 'No active session found for current user in this branch. Please start a session.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if 'session' in data and data.get('session') and str(data.get('session')) != str(active_session.id):
            print(
                f"[Order] Overriding session {data.get('session')} with current user active session {active_session.id}"
            )

        data['session'] = active_session.id
        if str(data.get('payment_method') or data.get('paymentMethod') or '').strip().lower() == 'laybuy':
            data['cogs'] = 0
        
        serializer = self.get_serializer(data=data)
        if not serializer.is_valid():
            print(f"[Order Create Error] Validation failed: {serializer.errors}")
            print(f"[Order Create Error] Request data: {request.data}")
        serializer.is_valid(raise_exception=True)

        if str(data.get('payment_method') or data.get('paymentMethod') or '').strip().lower() == 'laybuy':
            deposit_amount = _decimal_from_request(
                data.get('deposit_amount')
                or data.get('depositAmount')
                or data.get('laybuy_deposit')
                or data.get('laybuyDeposit')
                or 0
            )
            sale_total = _decimal_from_request(serializer.validated_data.get('total'))
            if deposit_amount > sale_total:
                raise ValidationError({'error': 'Laybuy deposit cannot exceed the sale total.'})
        
        try:
            with transaction.atomic():
                # Create the order
                order = serializer.save()
                
                print(f"[Order] Order created: {order.id} with {order.items.count()} items")

                if str(order.payment_method or '').strip().lower() == 'on account':
                    try:
                        from business.customer_accounts import record_credit_sale_for_order

                        account_tx = record_credit_sale_for_order(order, created_by=request.user)
                        order.refresh_from_db()
                        print(
                            f"[Order] Customer account debit created for order {order.id}: "
                            f"{account_tx.amount if account_tx else 'n/a'}"
                        )
                    except DjangoValidationError as account_err:
                        raise ValidationError({'error': _django_validation_message(account_err)})

                if str(order.payment_method or '').strip().lower() == 'laybuy':
                    try:
                        from business.customer_accounts import create_laybuy_for_order

                        deposit_amount = (
                            data.get('deposit_amount')
                            or data.get('depositAmount')
                            or data.get('laybuy_deposit')
                            or data.get('laybuyDeposit')
                            or 0
                        )
                        laybuy = create_laybuy_for_order(
                            order,
                            deposit_amount=deposit_amount,
                            payment_method=data.get('laybuy_payment_method') or data.get('laybuyPaymentMethod') or 'Cash',
                            reference=data.get('laybuy_reference') or data.get('laybuyReference') or '',
                            notes=data.get('laybuy_notes') or data.get('laybuyNotes') or '',
                            created_by=request.user,
                        )
                        print(
                            f"[Order] Laybuy created for order {order.id}: "
                            f"{laybuy.laybuy_number if laybuy else 'n/a'}"
                        )
                    except DjangoValidationError as laybuy_err:
                        raise ValidationError({'error': _django_validation_message(laybuy_err)})

                # Apply backend FIFO decrement for completed sales. Laybuy keeps stock reserved
                # until customer collection, when the reservation is fulfilled and consumed.
                try:
                    if str(order.payment_method or '').strip().lower() == 'laybuy':
                        print(f"[Order] Skipping immediate stock decrement for laybuy order {order.id}; stock is reserved until collection")
                    else:
                        decrement_inventory_for_order(order, order.branch, order.business)
                except Exception as stock_err:
                    print(f"[Order] Error applying FIFO stock decrement: {stock_err}")
                    # Keep behavior non-blocking for sale creation, but make failure visible.
                    # Local sync retries can re-apply stock movement once the issue is resolved.

                # Prepare order for MRA EIS pipeline.
                # In live mode with block_sales_if_eis_down enabled, this is blocking.
                business_settings = None
                try:
                    try:
                        business_settings = order.business.settings
                    except Exception:
                        business_settings = None

                    if bool(getattr(business_settings, 'enable_eis', False)):
                        from mra_eis.services import POSOrderSubmissionService, TerminalService

                        mra_result = POSOrderSubmissionService.prepare_pos_order_submission(
                            order,
                            request_device_serial=TerminalService.extract_request_device_serial(request),
                            enforce_device_binding=bool(
                                getattr(settings, 'MRA_EIS_ENFORCE_TERMINAL_DEVICE_BINDING', False)
                            ),
                        )
                        print(
                            f"[Order] Prepared MRA payload for order {order.id}: "
                            f"fiscal={mra_result.get('fiscal_invoice_number')} "
                            f"dry_run={mra_result.get('dry_run')}"
                        )
                        _enforce_mra_submission_policy(order, business_settings, mra_result)
                except ValidationError:
                    raise
                except Exception as mra_exc:
                    print(f"[Order] Warning: MRA preparation failed for order {order.id}: {str(mra_exc)}")
                    try:
                        from mra_eis.services import MRAIntegrationError
                    except Exception:
                        MRAIntegrationError = Exception

                    if isinstance(mra_exc, MRAIntegrationError):
                        raise ValidationError(
                            {
                                'error': str(mra_exc),
                                'order_id': str(order.id),
                            }
                        )

                    if (
                        getattr(settings, 'MRA_EIS_IS_LIVE', False)
                        and bool(getattr(business_settings, 'enable_eis', False))
                        and bool(getattr(business_settings, 'block_sales_if_eis_down', True))
                    ):
                        raise ValidationError(
                            {
                                'error': 'MRA EIS unavailable. Sale blocked by compliance policy (block_sales_if_eis_down).',
                                'details': str(mra_exc),
                                'order_id': str(order.id),
                            }
                        )
                
                print(f"[Order] Order {order.id} completed")
        
        except Exception as e:
            print(f"[Order Create Error] Exception during order creation: {str(e)}")
            import traceback
            traceback.print_exc()
            raise
        
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    @action(detail=False, methods=['get'])
    def by_session(self, request):
        """Get all orders for a session"""
        session_id = request.query_params.get('session_id')
        
        if not session_id:
            return Response(
                {'error': 'session_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        orders = self.get_queryset().filter(session_id=session_id)
        serializer = self.get_serializer(orders, many=True)
        return Response(serializer.data)

    

class SessionViewSet(viewsets.ModelViewSet):
    """ViewSet for managing POS sessions"""
    queryset = Session.objects.all()
    serializer_class = SessionSerializer
    permission_classes = [IsAuthenticated]

    def _get_scoped_queryset(
        self,
        include_user_filter=True,
        branch_reference=None,
        include_manager_full_scope=False,
    ):
        """
        Resolve session visibility scope by role:
        - Owner / Admin staff: all sessions in their business scope
        - Non-admin staff: only their own sessions
        """
        from business.models import Business
        from staff.models import Staff, StaffRole

        user = self.request.user
        requested_business_id = self.request.query_params.get('business_id')
        branch_id = (
            branch_reference
            if branch_reference is not None
            else self.request.query_params.get('branch_id')
        )

        accessible_business_ids = get_accessible_business_ids(user)
        owned_business_ids = list(
            Business.objects.filter(owner=user).values_list('id', flat=True)
        )
        staff_profile = Staff.objects.select_related('business').filter(
            user=user,
            is_active=True
        ).first()

        is_owner = len(owned_business_ids) > 0
        full_scope_staff_roles = {StaffRole.ADMIN}
        if include_manager_full_scope:
            full_scope_staff_roles.add(StaffRole.MANAGER)
        is_full_scope_staff = bool(staff_profile and staff_profile.role in full_scope_staff_roles)
        is_global_admin = bool(getattr(user, 'is_superuser', False))
        can_view_all_sessions = is_owner or is_full_scope_staff or is_global_admin

        if is_global_admin:
            queryset = Session.objects.all()
        else:
            queryset = Session.objects.filter(business_id__in=accessible_business_ids)

        if include_user_filter and not can_view_all_sessions:
            queryset = queryset.filter(user=user)

        if requested_business_id:
            queryset = queryset.filter(business_id=requested_business_id)

        if branch_id:
            queryset = _apply_branch_filter(queryset, branch_id)

        return queryset

    def get_queryset(self):
        """Filter sessions by business scope, role, and optional branch."""
        return self._get_scoped_queryset()

    def perform_create(self, serializer):
        """
        Create session with per-user active session guard.
        Each user can only have one active session at a time.
        """
        branch = serializer.validated_data.get('branch')
        business = serializer.validated_data.get('business')

        if not branch:
            raise ValidationError({'branch': 'branch is required'})

        if not business and getattr(branch, 'business', None):
            business = branch.business

        accessible_business_ids = get_accessible_business_ids(self.request.user)
        if not business or business.id not in accessible_business_ids:
            raise ValidationError({'business': 'Business is not available for this account'})
        if branch.business_id != business.id:
            raise ValidationError({'branch': 'Branch does not belong to the selected business'})

        existing_active = Session.objects.filter(
            user=self.request.user,
            status='active',
            business=business,
        ).select_related('branch').order_by('-started_at').first()

        if existing_active:
            branch_name = getattr(existing_active.branch, 'name', '') or str(existing_active.branch_id)
            raise ValidationError({
                'detail': (
                    'You already have an active session. '
                    f'Close it before starting a new one (branch: {branch_name}).'
                )
            })

        serializer.save(user=self.request.user, business=business)

    @action(detail=False, methods=['get'])
    def active(self, request):
        """
        Get active session for the requesting user in the requested branch.
        Branch filter is required and user scope is preserved.
        """
        branch_ref = _normalize_branch_reference(request.query_params.get('branch_id'))

        if branch_ref is None:
            return Response(
                {'error': 'branch_id is required and must be valid'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        session = self._get_scoped_queryset(
            include_user_filter=True,
            branch_reference=branch_ref,
        ).filter(status='active').order_by('-started_at').first()
        
        if not session:
            return Response(
                {'error': 'No active session found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        serializer = self.get_serializer(session)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def active_list(self, request):
        """
        Get active sessions in current visibility scope.
        Non-admin users see their own sessions; admins/owners can see all in scope.

        Query params:
        - branch_id (optional): if provided, limit to one branch.
        """
        queryset = self.get_queryset().filter(status='active').order_by('-started_at')
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def closed_list(self, request):
        """
        Get closed sessions in current visibility scope for history/reprint workflows.
        Cashiers see only their own closed sessions; admins, managers, and owners can see all in scope.

        Query params:
        - branch_id (optional): if provided, limit to one branch.
        - business_id (optional): if provided, limit to one business.
        """
        queryset = self._get_scoped_queryset(
            include_user_filter=True,
            include_manager_full_scope=True,
        ).filter(status='closed').order_by('-started_at')
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def close(self, request, pk=None):
        """Close a session"""
        session = self.get_object()
        
        if session.status == 'closed':
            return Response(
                {'error': 'Session is already closed'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Log incoming data
        print(f'[Sessions] Close action received data: {request.data}')
        
        # Prepare data for serializer
        data = request.data.copy()
        data['status'] = 'closed'
        for money_field in ('actual_cash', 'closing_float', 'difference'):
            if money_field in data:
                data[money_field] = _money_close_payload(data.get(money_field))
        
        # Ensure closing_stock is properly formatted
        if 'closing_stock' in data:
            print(f'[Sessions] Closing stock data: {data["closing_stock"]}')
        
        serializer = self.get_serializer(session, data=data, partial=True)
        if serializer.is_valid():
            print(f'[Sessions] Serializer valid, saving session')
            saved_session = serializer.save()
            print(f'[Sessions] Session saved. Closing stock: {saved_session.closing_stock}')
            return Response(serializer.data)
        
        print(f'[Sessions] Serializer errors: {serializer.errors}')
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
