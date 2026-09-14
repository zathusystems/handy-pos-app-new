from datetime import date
from decimal import Decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from business.access import get_accessible_business_ids
from business.customer_accounts import record_customer_payment
from inventory.models import InventoryItem
from pos_sessions.stock_validation import validate_stock_available_for_order_lines
from take_orders.models import TakeOrder, TakeOrderItem
from take_orders.session_access import get_active_staff_session

from .models import Appointment, AppointmentDeposit
from .service_labels import format_appointment_service_label
from .serializers import (
    AppointmentDepositWriteSerializer,
    AppointmentSerializer,
    AppointmentWriteSerializer,
)


SALON_BUSINESS_TYPE = 'beauty_salon'
OPEN_STATUSES = {
    Appointment.STATUS_BOOKED,
    Appointment.STATUS_CHECKED_IN,
    Appointment.STATUS_IN_SERVICE,
    Appointment.STATUS_READY_FOR_PAYMENT,
}


def _user_can_manage_appointment_outcome(user, appointment):
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False) or appointment.business.owner_id == user.id:
        return True
    try:
        from staff.models import Staff, StaffRole

        return Staff.objects.filter(
            user=user,
            business=appointment.business,
            is_active=True,
            role=StaffRole.ADMIN,
        ).exists()
    except Exception:
        return False


def _user_can_handle_appointment_cashier_work(user, appointment):
    """Check-in and deposits create financial activity for the cashier's session."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False) or appointment.business.owner_id == user.id:
        return True
    try:
        from staff.models import Staff, StaffRole

        return Staff.objects.filter(
            user=user,
            business=appointment.business,
            is_active=True,
            role__in=[StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.CASHIER],
        ).exists()
    except Exception:
        return False


def _money(value):
    return Decimal(str(value or 0)).quantize(Decimal('0.01'))


def _validation_payload(exc):
    if hasattr(exc, 'message_dict'):
        return exc.message_dict
    if hasattr(exc, 'messages'):
        return {'detail': ' '.join(str(message) for message in exc.messages)}
    return {'detail': str(exc)}


class AppointmentViewSet(viewsets.ModelViewSet):
    """Schedule salon services, then check them into the normal order flow."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = AppointmentSerializer
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = Appointment.objects.filter(
            business_id__in=get_accessible_business_ids(self.request.user)
        ).select_related(
            'business', 'branch', 'customer', 'take_order', 'settled_order', 'created_by', 'checked_in_by',
            'cancelled_by', 'no_show_by',
        ).prefetch_related('deposits__payment_transaction', 'deposits__recorded_by')
        branch_id = self.request.query_params.get('branch') or self.request.query_params.get('branch_id')
        if branch_id:
            queryset = queryset.filter(branch_id=branch_id)
        appointment_date = self.request.query_params.get('date')
        if appointment_date:
            queryset = queryset.filter(scheduled_start__date=appointment_date)
        status_values = self.request.query_params.getlist('status') or self.request.query_params.getlist('status[]')
        if not status_values:
            raw_statuses = str(self.request.query_params.get('statuses') or '').strip()
            status_values = [value.strip() for value in raw_statuses.split(',') if value.strip()]
        if status_values:
            queryset = queryset.filter(status__in=status_values)
        return queryset

    def _require_salon_business(self, business):
        if str(getattr(business, 'business_type', '') or '').strip().lower() != SALON_BUSINESS_TYPE:
            raise PermissionDenied('Appointments are available for Beauty Salon and Spa businesses only.')

    def _get_business_for_write(self, request):
        business_id = request.data.get('business') or request.data.get('business_id') or request.query_params.get('business_id')
        accessible_ids = get_accessible_business_ids(request.user)
        if business_id:
            business_id = str(business_id)
            if business_id not in {str(value) for value in accessible_ids}:
                raise PermissionDenied('You do not have access to this business.')
            from business.models import Business
            business = Business.objects.filter(id=business_id).first()
        else:
            from business.models import Business
            business = Business.objects.filter(id__in=accessible_ids).first()
        if not business:
            raise PermissionDenied('An accessible business is required.')
        self._require_salon_business(business)
        return business

    def get_serializer_class(self):
        if self.action in {'create', 'update', 'partial_update'}:
            return AppointmentWriteSerializer
        return AppointmentSerializer

    def create(self, request, *args, **kwargs):
        business = self._get_business_for_write(request)
        serializer = AppointmentWriteSerializer(data=request.data, context={'business': business})
        serializer.is_valid(raise_exception=True)
        appointment = Appointment.objects.create(
            business=business,
            branch=serializer.validated_data['branch'],
            customer=serializer.validated_data['customer'],
            scheduled_start=serializer.validated_data['scheduled_start'],
            scheduled_end=serializer.validated_data['scheduled_end'],
            services=serializer.validated_data['service_snapshots'],
            total=serializer.validated_data['computed_total'],
            notes=serializer.validated_data.get('notes', ''),
            created_by=request.user,
        )
        appointment.full_clean()
        return Response(AppointmentSerializer(appointment).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        appointment = self.get_object()
        if appointment.status != Appointment.STATUS_BOOKED:
            return Response(
                {'detail': 'Only a booked appointment can be changed. Update the linked service order after check-in.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        data = request.data.copy()
        data.setdefault('business_id', str(appointment.business_id))
        if 'branch' not in data and 'branchId' not in data:
            data['branch'] = str(appointment.branch_id)
        if 'customer' not in data and 'customerId' not in data:
            data['customer'] = str(appointment.customer_id)
        if 'scheduled_start' not in data and 'scheduledStart' not in data:
            data['scheduled_start'] = appointment.scheduled_start.isoformat()
        if 'scheduled_end' not in data and 'scheduledEnd' not in data:
            data['scheduled_end'] = appointment.scheduled_end.isoformat()
        if 'services' not in data:
            data['services'] = [
                {
                    **(
                        {'menu_item_id': entry['menu_item_id']}
                        if entry.get('menu_item_id') else
                        {'inventory_item_id': entry['inventory_item_id']}
                    ),
                    'quantity': entry['quantity'],
                    'selected_option_ids': {
                        str(option.get('group_id')): [
                            str(candidate.get('id'))
                            for candidate in entry.get('selected_options', [])
                            if str(candidate.get('group_id') or '') == str(option.get('group_id') or '')
                        ]
                        for option in entry.get('selected_options', [])
                        if option.get('group_id')
                    },
                }
                for entry in appointment.services
            ]
        business = appointment.business
        self._require_salon_business(business)
        serializer = AppointmentWriteSerializer(data=data, context={'business': business})
        serializer.is_valid(raise_exception=True)
        appointment.branch = serializer.validated_data['branch']
        appointment.customer = serializer.validated_data['customer']
        appointment.scheduled_start = serializer.validated_data['scheduled_start']
        appointment.scheduled_end = serializer.validated_data['scheduled_end']
        appointment.services = serializer.validated_data['service_snapshots']
        appointment.total = serializer.validated_data['computed_total']
        appointment.notes = serializer.validated_data.get('notes', '')
        appointment.full_clean()
        appointment.save()
        return Response(AppointmentSerializer(appointment).data)

    @action(detail=True, methods=['post'], url_path='check-in')
    @transaction.atomic
    def check_in(self, request, pk=None):
        appointment = self.get_queryset().select_for_update().get(pk=pk)
        self._require_salon_business(appointment.business)
        if appointment.status != Appointment.STATUS_BOOKED or appointment.take_order_id:
            return Response(
                {'detail': 'This appointment has already been checked in or is no longer available for check-in.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not _user_can_handle_appointment_cashier_work(request.user, appointment):
            raise PermissionDenied('Only a cashier, manager, or admin user can check in an appointment.')

        active_session = get_active_staff_session(
            user=request.user,
            business=appointment.business,
            branch=appointment.branch,
        )
        if not active_session:
            return Response(
                {'detail': 'Start an active session before checking in an appointment for this branch.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        service_lines = [
            {
                'inventory_item_id': entry.get('inventory_item_id'),
                'name': entry.get('name'),
                'quantity': entry.get('quantity'),
                'price': entry.get('price'),
                'recipe': entry.get('recipe') or [],
                'is_prepared_menu_item': entry.get('is_prepared_menu_item', False),
                'selected_options': entry.get('selected_options') or [],
            }
            for entry in appointment.services
        ]
        if not service_lines:
            return Response({'detail': 'This appointment has no services to check in.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            validate_stock_available_for_order_lines(service_lines, appointment.business, appointment.branch)
        except DjangoValidationError as exc:
            return Response(_validation_payload(exc), status=status.HTTP_400_BAD_REQUEST)

        # Locking the branch prevents duplicate branch order numbers during simultaneous check-ins.
        from business.models import Branch
        branch = Branch.objects.select_for_update().get(pk=appointment.branch_id)
        order = TakeOrder.objects.create(
            business=appointment.business,
            branch=branch,
            session=active_session,
            created_by=request.user,
            customer=appointment.customer,
            customer_name=appointment.customer.name,
            customer_phone=appointment.customer.phone,
            customer_notes=appointment.customer.notes,
            order_number=TakeOrder.next_order_number_for_branch(branch),
            status='Sent to Kitchen',
            special_instructions=appointment.notes,
        )
        TakeOrderItem.objects.bulk_create([
            TakeOrderItem(
                take_order=order,
                inventory_item_id=str(entry.get('inventory_item_id') or ''),
                menu_item_id=str(entry.get('menu_item_id') or ''),
                name=str(entry.get('name') or ''),
                quantity=Decimal(str(entry.get('quantity') or 0)),
                price=Decimal(str(entry.get('price') or 0)),
                recipe=entry.get('recipe') or [],
                is_prepared_menu_item=bool(entry.get('is_prepared_menu_item', False)),
                selected_options=entry.get('selected_options') or [],
            )
            for entry in appointment.services
        ])
        now = timezone.now()
        appointment.take_order = order
        appointment.checked_in_by = request.user
        appointment.checked_in_at = now
        appointment.status = Appointment.STATUS_CHECKED_IN
        appointment.save(update_fields=[
            'take_order', 'checked_in_by', 'checked_in_at', 'status', 'updated_at',
        ])
        appointment.refresh_from_db()
        return Response(AppointmentSerializer(appointment).data, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='record-deposit')
    @transaction.atomic
    def record_deposit(self, request, pk=None):
        appointment = self.get_queryset().select_for_update().get(pk=pk)
        self._require_salon_business(appointment.business)
        if appointment.status not in OPEN_STATUSES:
            return Response(
                {'detail': 'Deposits can only be recorded for an open appointment.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not _user_can_handle_appointment_cashier_work(request.user, appointment):
            raise PermissionDenied('Only a cashier, manager, or admin user can record an appointment deposit.')

        active_session = get_active_staff_session(
            user=request.user,
            business=appointment.business,
            branch=appointment.branch,
        )
        if not active_session:
            return Response(
                {'detail': 'Start an active session before recording an appointment deposit.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = AppointmentDepositWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        existing_deposits = AppointmentDeposit.objects.filter(appointment=appointment).aggregate(
            total=Sum('amount')
        )['total'] or Decimal('0.00')
        amount = _money(serializer.validated_data['amount'])
        remaining = max(Decimal('0.00'), _money(appointment.total) - _money(existing_deposits))
        if amount > remaining:
            return Response(
                {'amount': f'The appointment has {remaining:.2f} remaining for deposits.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        reference = serializer.validated_data.get('reference', '').strip()
        if not reference:
            reference = f'Appointment {appointment.id} deposit'
        payment_transaction = record_customer_payment(
            customer=appointment.customer,
            amount=amount,
            branch=appointment.branch,
            session=active_session,
            payment_method=serializer.validated_data['payment_method'],
            reference=reference,
            notes=serializer.validated_data.get('notes', ''),
            created_by=request.user,
        )
        AppointmentDeposit.objects.create(
            appointment=appointment,
            payment_transaction=payment_transaction,
            amount=amount,
            payment_method=serializer.validated_data['payment_method'],
            reference=reference,
            notes=serializer.validated_data.get('notes', ''),
            recorded_by=request.user,
        )
        appointment.refresh_from_db()
        return Response(AppointmentSerializer(appointment).data, status=status.HTTP_201_CREATED)

    def _record_booked_outcome(self, request, appointment, *, outcome):
        if not _user_can_manage_appointment_outcome(request.user, appointment):
            raise PermissionDenied('Only the business owner or an admin user can record this appointment outcome.')
        if appointment.status != Appointment.STATUS_BOOKED or appointment.take_order_id:
            return Response(
                {'detail': 'Only a booked appointment without a service order can be updated this way.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        reason = str(request.data.get('reason') or '').strip()
        if not reason:
            return Response({'reason': 'A reason is required.'}, status=status.HTTP_400_BAD_REQUEST)

        now = timezone.now()
        if outcome == Appointment.STATUS_CANCELLED:
            appointment.status = Appointment.STATUS_CANCELLED
            appointment.cancellation_reason = reason
            appointment.cancelled_at = now
            appointment.cancelled_by = request.user
            update_fields = ['status', 'cancellation_reason', 'cancelled_at', 'cancelled_by', 'updated_at']
        else:
            appointment.status = Appointment.STATUS_NO_SHOW
            appointment.no_show_reason = reason
            appointment.no_show_at = now
            appointment.no_show_by = request.user
            update_fields = ['status', 'no_show_reason', 'no_show_at', 'no_show_by', 'updated_at']
        appointment.save(update_fields=update_fields)
        return Response(AppointmentSerializer(appointment).data)

    @action(detail=True, methods=['post'], url_path='cancel')
    @transaction.atomic
    def cancel(self, request, pk=None):
        appointment = self.get_queryset().select_for_update().get(pk=pk)
        self._require_salon_business(appointment.business)
        return self._record_booked_outcome(request, appointment, outcome=Appointment.STATUS_CANCELLED)

    @action(detail=True, methods=['post'], url_path='mark-no-show')
    @transaction.atomic
    def mark_no_show(self, request, pk=None):
        appointment = self.get_queryset().select_for_update().get(pk=pk)
        self._require_salon_business(appointment.business)
        return self._record_booked_outcome(request, appointment, outcome=Appointment.STATUS_NO_SHOW)

    @action(detail=False, methods=['get'], url_path='summary')
    def summary(self, request):
        branch_id = request.query_params.get('branch') or request.query_params.get('branch_id')
        accessible_ids = get_accessible_business_ids(request.user)
        appointments = Appointment.objects.filter(business_id__in=accessible_ids).prefetch_related('deposits')
        if branch_id:
            from business.models import Branch

            branch = Branch.objects.select_related('business').filter(
                id=branch_id,
                business_id__in=accessible_ids,
            ).first()
            if not branch:
                raise PermissionDenied('You do not have access to this branch.')
            self._require_salon_business(branch.business)
            appointments = appointments.filter(branch=branch)

        try:
            from_date = date.fromisoformat(request.query_params.get('from_date') or request.query_params.get('from') or '')
        except (TypeError, ValueError):
            from_date = timezone.localdate()
        try:
            to_date = date.fromisoformat(request.query_params.get('to_date') or request.query_params.get('to') or '')
        except (TypeError, ValueError):
            to_date = from_date
        if to_date < from_date:
            return Response({'detail': 'The end date must not be before the start date.'}, status=status.HTTP_400_BAD_REQUEST)

        appointments = list(appointments.filter(scheduled_start__date__gte=from_date, scheduled_start__date__lte=to_date))
        counts = {status_name: 0 for status_name, _label in Appointment.STATUS_CHOICES}
        scheduled_value = Decimal('0.00')
        completed_value = Decimal('0.00')
        outstanding_open_value = Decimal('0.00')
        service_totals = {}
        for appointment in appointments:
            counts[appointment.status] = counts.get(appointment.status, 0) + 1
            total = _money(appointment.total)
            scheduled_value += total
            if appointment.status == Appointment.STATUS_COMPLETED:
                completed_value += total
            if appointment.status in OPEN_STATUSES:
                deposit_total = sum((_money(deposit.amount) for deposit in appointment.deposits.all()), Decimal('0.00'))
                outstanding_open_value += max(Decimal('0.00'), total - deposit_total)

            if appointment.status in {Appointment.STATUS_CANCELLED, Appointment.STATUS_NO_SHOW}:
                continue
            for service in (appointment.services if isinstance(appointment.services, list) else []):
                if not isinstance(service, dict):
                    continue
                service_name = format_appointment_service_label(service)
                if not service_name:
                    continue
                service_total = _money(service.get('total'))
                service_data = service_totals.setdefault(
                    service_name,
                    {
                        'appointment_ids': set(),
                        'quantity': Decimal('0.00'),
                        'scheduled_value': Decimal('0.00'),
                        'completed_value': Decimal('0.00'),
                    },
                )
                service_data['appointment_ids'].add(appointment.id)
                service_data['quantity'] += Decimal(str(service.get('quantity') or 0))
                service_data['scheduled_value'] += service_total
                if appointment.status == Appointment.STATUS_COMPLETED:
                    service_data['completed_value'] += service_total

        deposit_query = AppointmentDeposit.objects.filter(
            appointment__business_id__in=accessible_ids,
            created_at__date__gte=from_date,
            created_at__date__lte=to_date,
        )
        if branch_id:
            deposit_query = deposit_query.filter(appointment__branch_id=branch_id)
        deposits_received = deposit_query.aggregate(total=Sum('amount'))['total'] or Decimal('0.00')
        service_breakdown = [
            {
                'name': name,
                'appointments': len(values['appointment_ids']),
                'quantity': values['quantity'].quantize(Decimal('0.001')),
                'scheduled_value': _money(values['scheduled_value']),
                'completed_value': _money(values['completed_value']),
            }
            for name, values in sorted(
                service_totals.items(),
                key=lambda entry: (entry[1]['scheduled_value'], entry[1]['quantity']),
                reverse=True,
            )
        ]
        return Response({
            'range': {'from_date': from_date.isoformat(), 'to_date': to_date.isoformat()},
            'totals': {
                'appointments': len(appointments),
                **counts,
                'scheduled_value': _money(scheduled_value),
                'completed_service_value': _money(completed_value),
                'deposits_received': _money(deposits_received),
                'outstanding_scheduled_value': _money(outstanding_open_value),
            },
            'services': service_breakdown,
        })
