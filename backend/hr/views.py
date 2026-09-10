from django.db import transaction
from django.db.models import Prefetch, Q
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from business.access import get_accessible_business, get_accessible_business_ids
from business.models import Branch

from .models import (
    AttendanceRecord,
    Employee,
    EmploymentTerm,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    OvertimeRequest,
    WorkShift,
)
from .serializers import (
    AttendanceRecordSerializer,
    EmployeeSerializer,
    EmployeeWriteSerializer,
    EmploymentTermSerializer,
    LeaveBalanceSerializer,
    LeaveRequestSerializer,
    LeaveRequestWriteSerializer,
    LeaveTypeSerializer,
    ManualAttendanceSerializer,
    OvertimeRequestSerializer,
    OvertimeRequestWriteSerializer,
    WorkShiftSerializer,
)
from .services import leave_balance_summary


class HRBusinessAccessMixin:
    """Restrict People data to a business owner or its active Administrator staff."""

    def get_accessible_business_ids(self):
        return get_accessible_business_ids(self.request.user, admin_staff_only=True)

    def get_requested_business(self):
        requested_business_id = (
            self.request.data.get('business_id')
            or self.request.query_params.get('business_id')
        )
        business = get_accessible_business(
            self.request.user,
            requested_business_id,
            admin_staff_only=True,
        )
        if not business:
            raise PermissionDenied('Only the business owner or an Administrator can manage employee records.')
        return business

    def is_admin_for_business(self, business_id):
        return str(business_id) in {str(value) for value in self.get_accessible_business_ids()}

    def get_owned_employee(self):
        return Employee.objects.filter(
            staff__user=self.request.user,
            staff__is_active=True,
        ).select_related('business', 'staff').first()

    def require_owned_employee(self):
        employee = self.get_owned_employee()
        if not employee:
            raise PermissionDenied('Your user account is not linked to an active employee profile.')
        return employee

    def require_admin_for_employee(self, employee):
        if not employee or not self.is_admin_for_business(employee.business_id):
            raise PermissionDenied('Only the business owner or an Administrator can manage this record.')
        return employee

    def filter_business_queryset(self, queryset, field='business_id'):
        """Give administrators business-wide data and linked employees only their own data."""
        business_ids = self.get_accessible_business_ids()
        requested_business_id = self.request.query_params.get('business_id')
        if business_ids:
            if requested_business_id:
                if not self.is_admin_for_business(requested_business_id):
                    raise PermissionDenied('You do not have access to this business.')
                return queryset.filter(**{field: requested_business_id})
            return queryset.filter(**{f'{field}__in': business_ids})
        return queryset.none()


class EmployeeViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'put', 'patch', 'head', 'options']

    def get_queryset(self):
        business_ids = self.get_accessible_business_ids()
        requested_business_id = self.request.query_params.get('business_id')
        queryset = Employee.objects.filter(business_id__in=business_ids)
        if requested_business_id:
            if str(requested_business_id) not in {str(value) for value in business_ids}:
                raise PermissionDenied('You do not have access to this business.')
            queryset = queryset.filter(business_id=requested_business_id)
        return queryset.select_related('business', 'staff').prefetch_related(
            Prefetch('employment_terms', queryset=EmploymentTerm.objects.select_related('branch')),
        )

    def get_serializer_class(self):
        if self.action in {'create', 'update', 'partial_update'}:
            return EmployeeWriteSerializer
        return EmployeeSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        if self.action == 'create':
            context['business'] = self.get_requested_business()
        return context

    def perform_create(self, serializer):
        serializer.save(business=self.get_requested_business())

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        employee = Employee.objects.select_related('business', 'staff').prefetch_related(
            Prefetch('employment_terms', queryset=EmploymentTerm.objects.select_related('branch')),
        ).get(pk=serializer.instance.pk)
        return Response(
            EmployeeSerializer(employee, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )


class EmploymentTermViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    serializer_class = EmploymentTermSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        business_ids = self.get_accessible_business_ids()
        queryset = EmploymentTerm.objects.filter(employee__business_id__in=business_ids)
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        return queryset.select_related('employee', 'branch', 'employee__business')

    def perform_create(self, serializer):
        employee = serializer.validated_data['employee']
        if employee.business_id not in self.get_accessible_business_ids():
            raise PermissionDenied('You do not have access to this employee.')
        serializer.save()


class WorkShiftViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    serializer_class = WorkShiftSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = WorkShift.objects.select_related('employee', 'branch', 'created_by')
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            queryset = self.filter_business_queryset(queryset, 'employee__business_id')
        else:
            employee = self.require_owned_employee()
            queryset = queryset.filter(employee=employee)
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        start_date = self.request.query_params.get('start_date')
        if start_date:
            queryset = queryset.filter(work_date__gte=start_date)
        end_date = self.request.query_params.get('end_date')
        if end_date:
            queryset = queryset.filter(work_date__lte=end_date)
        return queryset

    def perform_create(self, serializer):
        employee = serializer.validated_data['employee']
        self.require_admin_for_employee(employee)
        serializer.save(created_by=self.request.user)

    def perform_update(self, serializer):
        self.require_admin_for_employee(serializer.instance.employee)
        employee = serializer.validated_data.get('employee', serializer.instance.employee)
        self.require_admin_for_employee(employee)
        serializer.save()

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        shift = self.get_object()
        self.require_admin_for_employee(shift.employee)
        if shift.status == WorkShift.Status.CANCELLED:
            return Response(self.get_serializer(shift).data)
        shift.status = WorkShift.Status.CANCELLED
        shift.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(shift).data)


class AttendanceRecordViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'head', 'options']

    def get_serializer_class(self):
        if self.action == 'create':
            return ManualAttendanceSerializer
        return AttendanceRecordSerializer

    def get_queryset(self):
        queryset = AttendanceRecord.objects.select_related(
            'employee', 'branch', 'shift', 'recorded_by', 'reviewed_by',
        )
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            queryset = self.filter_business_queryset(queryset, 'employee__business_id')
        else:
            queryset = queryset.filter(employee=self.require_owned_employee())
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        status_filter = self.request.query_params.get('status')
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        return queryset

    def perform_create(self, serializer):
        employee = serializer.validated_data['employee']
        self.require_admin_for_employee(employee)
        serializer.save(recorded_by=self.request.user, source=AttendanceRecord.Source.MANUAL, status=AttendanceRecord.Status.SUBMITTED)

    @action(detail=False, methods=['post'], url_path='clock-in')
    def clock_in(self, request):
        employee = self.require_owned_employee()
        if employee.employment_status != Employee.Status.ACTIVE:
            return Response({'detail': 'Only active employees can clock in.'}, status=status.HTTP_400_BAD_REQUEST)
        if AttendanceRecord.objects.filter(
            employee=employee,
            clock_out__isnull=True,
            status=AttendanceRecord.Status.OPEN,
        ).exists():
            return Response({'detail': 'You are already clocked in.'}, status=status.HTTP_400_BAD_REQUEST)

        today = timezone.localdate()
        shift = WorkShift.objects.filter(
            employee=employee,
            work_date=today,
            status=WorkShift.Status.SCHEDULED,
        ).select_related('branch').order_by('starts_at').first()
        branch_id = request.data.get('branch') or request.data.get('branch_id')
        branch = shift.branch if shift else None
        if branch_id:
            branch = Branch.objects.filter(pk=branch_id, business_id=employee.business_id).first()
            if not branch:
                return Response({'detail': 'The selected branch does not belong to your business.'}, status=status.HTTP_400_BAD_REQUEST)
        if not branch:
            branch = getattr(employee.staff, 'branch', None)
        if not branch:
            current_term = employee.employment_terms.filter(
                effective_from__lte=today,
            ).filter(
                Q(effective_to__isnull=True) | Q(effective_to__gte=today),
            ).select_related('branch').order_by('-effective_from').first()
            branch = current_term.branch if current_term else None
        if not branch:
            return Response({'detail': 'Ask an Administrator to assign your branch before clocking in.'}, status=status.HTTP_400_BAD_REQUEST)

        record = AttendanceRecord.objects.create(
            employee=employee,
            branch=branch,
            shift=shift,
            work_date=today,
            clock_in=timezone.now(),
            status=AttendanceRecord.Status.OPEN,
            source=AttendanceRecord.Source.CLOCK,
            notes=str(request.data.get('notes') or '')[:2000],
            recorded_by=request.user,
        )
        return Response(AttendanceRecordSerializer(record).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'], url_path='clock-out')
    def clock_out(self, request):
        employee = self.require_owned_employee()
        with transaction.atomic():
            record = AttendanceRecord.objects.select_for_update().filter(
                employee=employee,
                clock_out__isnull=True,
                status=AttendanceRecord.Status.OPEN,
            ).order_by('-clock_in').first()
            if not record:
                return Response({'detail': 'You are not currently clocked in.'}, status=status.HTTP_400_BAD_REQUEST)
            record.clock_out = timezone.now()
            record.status = AttendanceRecord.Status.SUBMITTED
            record.save(update_fields=['clock_out', 'status', 'updated_at'])
        return Response(AttendanceRecordSerializer(record).data)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        record = self.get_object()
        self.require_admin_for_employee(record.employee)
        if record.status != AttendanceRecord.Status.SUBMITTED:
            return Response({'detail': 'Only submitted attendance can be approved.'}, status=status.HTTP_400_BAD_REQUEST)
        record.status = AttendanceRecord.Status.APPROVED
        record.reviewed_by = request.user
        record.reviewed_at = timezone.now()
        record.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'updated_at'])
        return Response(AttendanceRecordSerializer(record).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        record = self.get_object()
        self.require_admin_for_employee(record.employee)
        if record.status != AttendanceRecord.Status.SUBMITTED:
            return Response({'detail': 'Only submitted attendance can be rejected.'}, status=status.HTTP_400_BAD_REQUEST)
        record.status = AttendanceRecord.Status.REJECTED
        record.notes = str(request.data.get('review_note') or record.notes)[:2000]
        record.reviewed_by = request.user
        record.reviewed_at = timezone.now()
        record.save(update_fields=['status', 'notes', 'reviewed_by', 'reviewed_at', 'updated_at'])
        return Response(AttendanceRecordSerializer(record).data)


class LeaveTypeViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    serializer_class = LeaveTypeSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = LeaveType.objects.all()
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            return self.filter_business_queryset(queryset)
        employee = self.get_owned_employee()
        return queryset.filter(business_id=employee.business_id) if employee else queryset.none()

    def perform_create(self, serializer):
        serializer.save(business=self.get_requested_business())

    def perform_update(self, serializer):
        self.get_requested_business_for_object(serializer.instance.business_id)
        serializer.save()

    def get_requested_business_for_object(self, business_id):
        if not self.is_admin_for_business(business_id):
            raise PermissionDenied('Only the business owner or an Administrator can manage leave types.')
        return business_id


class LeaveBalanceViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    serializer_class = LeaveBalanceSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = LeaveBalance.objects.select_related('employee', 'leave_type')
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            queryset = self.filter_business_queryset(queryset, 'employee__business_id')
        else:
            queryset = queryset.filter(employee=self.require_owned_employee())
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        year = self.request.query_params.get('year')
        if year:
            queryset = queryset.filter(year=year)
        return queryset

    def perform_create(self, serializer):
        employee = serializer.validated_data['employee']
        self.require_admin_for_employee(employee)
        serializer.save()

    def perform_update(self, serializer):
        self.require_admin_for_employee(serializer.instance.employee)
        employee = serializer.validated_data.get('employee', serializer.instance.employee)
        self.require_admin_for_employee(employee)
        serializer.save()


class LeaveRequestViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'head', 'options']

    def get_serializer_class(self):
        return LeaveRequestWriteSerializer if self.action == 'create' else LeaveRequestSerializer

    def get_queryset(self):
        queryset = LeaveRequest.objects.select_related(
            'employee', 'leave_type', 'submitted_by', 'reviewed_by',
        )
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            queryset = self.filter_business_queryset(queryset, 'employee__business_id')
        else:
            queryset = queryset.filter(employee=self.require_owned_employee())
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        request_status = self.request.query_params.get('status')
        if request_status:
            queryset = queryset.filter(status=request_status)
        return queryset

    def perform_create(self, serializer):
        employee = serializer.validated_data.get('employee')
        own_employee = self.get_owned_employee()
        if employee:
            if not self.is_admin_for_business(employee.business_id) and employee != own_employee:
                raise PermissionDenied('You can only submit leave for your own employee profile.')
        else:
            employee = self.require_owned_employee()
        if self.is_admin_for_business(employee.business_id):
            # Administrators can submit for a selected employee; ordinary staff can only submit for themselves.
            pass
        elif employee != own_employee:
            raise PermissionDenied('You can only submit leave for your own employee profile.')
        leave_type = serializer.validated_data['leave_type']
        if leave_type.business_id != employee.business_id:
            raise PermissionDenied('The leave type does not belong to this employee business.')
        serializer.save(employee=employee, submitted_by=self.request.user)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            LeaveRequestSerializer(serializer.instance, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        leave_request = self.get_object()
        self.require_admin_for_employee(leave_request.employee)
        if leave_request.status != LeaveRequest.Status.PENDING:
            return Response({'detail': 'Only pending leave requests can be approved.'}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            overlap = LeaveRequest.objects.filter(
                employee=leave_request.employee,
                status=LeaveRequest.Status.APPROVED,
                start_date__lte=leave_request.end_date,
                end_date__gte=leave_request.start_date,
            ).exclude(pk=leave_request.pk).exists()
            if overlap:
                return Response({'detail': 'This leave overlaps an already approved request.'}, status=status.HTTP_400_BAD_REQUEST)
            balance = LeaveBalance.objects.select_for_update().filter(
                employee=leave_request.employee,
                leave_type=leave_request.leave_type,
                year=leave_request.start_date.year,
            ).first()
            if not balance:
                return Response({'detail': 'Allocate a leave balance for this employee and year first.'}, status=status.HTTP_400_BAD_REQUEST)
            if leave_balance_summary(balance)['available_days'] < leave_request.requested_days:
                return Response({'detail': 'This approval would exceed the employee leave balance.'}, status=status.HTTP_400_BAD_REQUEST)
            leave_request.status = LeaveRequest.Status.APPROVED
            leave_request.reviewed_by = request.user
            leave_request.reviewed_at = timezone.now()
            leave_request.review_note = str(request.data.get('review_note') or '')[:2000]
            leave_request.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
        return Response(LeaveRequestSerializer(leave_request).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        leave_request = self.get_object()
        self.require_admin_for_employee(leave_request.employee)
        if leave_request.status != LeaveRequest.Status.PENDING:
            return Response({'detail': 'Only pending leave requests can be rejected.'}, status=status.HTTP_400_BAD_REQUEST)
        leave_request.status = LeaveRequest.Status.REJECTED
        leave_request.reviewed_by = request.user
        leave_request.reviewed_at = timezone.now()
        leave_request.review_note = str(request.data.get('review_note') or '')[:2000]
        leave_request.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
        return Response(LeaveRequestSerializer(leave_request).data)

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        leave_request = self.get_object()
        own_employee = self.get_owned_employee()
        if not self.is_admin_for_business(leave_request.employee.business_id) and leave_request.employee != own_employee:
            raise PermissionDenied('You can only cancel your own leave requests.')
        if leave_request.status != LeaveRequest.Status.PENDING:
            return Response({'detail': 'Only pending leave requests can be cancelled.'}, status=status.HTTP_400_BAD_REQUEST)
        leave_request.status = LeaveRequest.Status.CANCELLED
        leave_request.save(update_fields=['status', 'updated_at'])
        return Response(LeaveRequestSerializer(leave_request).data)


class OvertimeRequestViewSet(HRBusinessAccessMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'post', 'head', 'options']

    def get_serializer_class(self):
        return OvertimeRequestWriteSerializer if self.action == 'create' else OvertimeRequestSerializer

    def get_queryset(self):
        queryset = OvertimeRequest.objects.select_related(
            'employee', 'branch', 'attendance', 'submitted_by', 'reviewed_by',
        )
        business_ids = self.get_accessible_business_ids()
        if business_ids:
            queryset = self.filter_business_queryset(queryset, 'employee__business_id')
        else:
            queryset = queryset.filter(employee=self.require_owned_employee())
        employee_id = self.request.query_params.get('employee_id')
        if employee_id:
            queryset = queryset.filter(employee_id=employee_id)
        request_status = self.request.query_params.get('status')
        if request_status:
            queryset = queryset.filter(status=request_status)
        return queryset

    def perform_create(self, serializer):
        employee = serializer.validated_data.get('employee')
        own_employee = self.get_owned_employee()
        if not employee:
            employee = self.require_owned_employee()
        elif not self.is_admin_for_business(employee.business_id) and employee != own_employee:
            raise PermissionDenied('You can only submit overtime for your own employee profile.')
        if employee.business_id != serializer.validated_data['branch'].business_id:
            raise PermissionDenied('The overtime branch does not belong to this employee business.')
        if self.is_admin_for_business(employee.business_id):
            pass
        elif employee != own_employee:
            raise PermissionDenied('You can only submit overtime for your own employee profile.')
        serializer.save(employee=employee, submitted_by=self.request.user)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            OvertimeRequestSerializer(serializer.instance, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        overtime = self.get_object()
        self.require_admin_for_employee(overtime.employee)
        if overtime.status != OvertimeRequest.Status.PENDING:
            return Response({'detail': 'Only pending overtime can be approved.'}, status=status.HTTP_400_BAD_REQUEST)
        approved_minutes = request.data.get('approved_minutes', overtime.requested_minutes)
        try:
            approved_minutes = int(approved_minutes)
        except (TypeError, ValueError):
            return Response({'detail': 'Approved overtime must be a whole number of minutes.'}, status=status.HTTP_400_BAD_REQUEST)
        if approved_minutes <= 0 or approved_minutes > overtime.requested_minutes:
            return Response({'detail': 'Approved overtime must be between 1 and the requested minutes.'}, status=status.HTTP_400_BAD_REQUEST)
        overtime.status = OvertimeRequest.Status.APPROVED
        overtime.approved_minutes = approved_minutes
        overtime.reviewed_by = request.user
        overtime.reviewed_at = timezone.now()
        overtime.review_note = str(request.data.get('review_note') or '')[:2000]
        overtime.save(update_fields=['status', 'approved_minutes', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
        return Response(OvertimeRequestSerializer(overtime).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        overtime = self.get_object()
        self.require_admin_for_employee(overtime.employee)
        if overtime.status != OvertimeRequest.Status.PENDING:
            return Response({'detail': 'Only pending overtime can be rejected.'}, status=status.HTTP_400_BAD_REQUEST)
        overtime.status = OvertimeRequest.Status.REJECTED
        overtime.reviewed_by = request.user
        overtime.reviewed_at = timezone.now()
        overtime.review_note = str(request.data.get('review_note') or '')[:2000]
        overtime.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
        return Response(OvertimeRequestSerializer(overtime).data)

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        overtime = self.get_object()
        own_employee = self.get_owned_employee()
        if not self.is_admin_for_business(overtime.employee.business_id) and overtime.employee != own_employee:
            raise PermissionDenied('You can only cancel your own overtime requests.')
        if overtime.status != OvertimeRequest.Status.PENDING:
            return Response({'detail': 'Only pending overtime can be cancelled.'}, status=status.HTTP_400_BAD_REQUEST)
        overtime.status = OvertimeRequest.Status.CANCELLED
        overtime.save(update_fields=['status', 'updated_at'])
        return Response(OvertimeRequestSerializer(overtime).data)

    def perform_update(self, serializer):
        employee = serializer.validated_data.get('employee', serializer.instance.employee)
        if employee.business_id not in self.get_accessible_business_ids():
            raise PermissionDenied('You do not have access to this employee.')
        serializer.save()
