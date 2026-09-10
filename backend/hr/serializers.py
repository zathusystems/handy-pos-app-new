from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers

from business.models import Branch
from staff.models import Staff

from .models import (
    AttendanceRecord,
    Employee,
    EmploymentTerm,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    OvertimeRequest,
    PayrollEntry,
    PayrollLine,
    PayrollRun,
    PayrollSettings,
    WorkShift,
)
from .services import leave_balance_summary, working_days


def _get_overlapping_terms(*, employee, effective_from, effective_to, instance=None):
    overlapping_terms = EmploymentTerm.objects.filter(
        employee=employee,
        effective_from__lte=effective_to or date.max,
    ).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gte=effective_from)
    )
    if instance:
        overlapping_terms = overlapping_terms.exclude(pk=instance.pk)
    return overlapping_terms


def _validate_term_dates_and_branch(*, employee, branch, effective_from, effective_to, instance=None):
    if branch.business_id != employee.business_id:
        raise serializers.ValidationError({
            'branch': 'The selected branch must belong to the employee business.',
        })
    if effective_to and effective_to < effective_from:
        raise serializers.ValidationError({
            'effective_to': 'End date cannot be before the effective date.',
        })

    if _get_overlapping_terms(
        employee=employee,
        effective_from=effective_from,
        effective_to=effective_to,
        instance=instance,
    ).exists():
        raise serializers.ValidationError({
            'effective_from': 'This employment term overlaps an existing employment term.',
        })


class EmploymentTermSerializer(serializers.ModelSerializer):
    branch_name = serializers.CharField(source='branch.name', read_only=True)

    class Meta:
        model = EmploymentTerm
        fields = [
            'id', 'employee', 'branch', 'branch_name', 'job_title', 'department',
            'employment_type', 'pay_frequency', 'base_salary', 'currency',
            'effective_from', 'effective_to', 'notes', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def validate(self, attrs):
        instance = getattr(self, 'instance', None)
        employee = attrs.get('employee') or getattr(instance, 'employee', None)
        branch = attrs.get('branch') or getattr(instance, 'branch', None)
        effective_from = attrs.get('effective_from') or getattr(instance, 'effective_from', None)
        effective_to = attrs.get('effective_to', getattr(instance, 'effective_to', None))

        if employee and branch and effective_from:
            if instance:
                _validate_term_dates_and_branch(
                    employee=employee,
                    branch=branch,
                    effective_from=effective_from,
                    effective_to=effective_to,
                    instance=instance,
                )
            else:
                if branch.business_id != employee.business_id:
                    raise serializers.ValidationError({
                        'branch': 'The selected branch must belong to the employee business.',
                    })
                if effective_to and effective_to < effective_from:
                    raise serializers.ValidationError({
                        'effective_to': 'End date cannot be before the effective date.',
                    })
                overlapping_terms = list(_get_overlapping_terms(
                    employee=employee,
                    effective_from=effective_from,
                    effective_to=effective_to,
                ))
                if overlapping_terms:
                    previous_open_term = (
                        len(overlapping_terms) == 1
                        and overlapping_terms[0].effective_to is None
                        and overlapping_terms[0].effective_from < effective_from
                    )
                    if not previous_open_term:
                        raise serializers.ValidationError({
                            'effective_from': 'This employment term overlaps an existing employment term.',
                        })
                    self._previous_open_term = overlapping_terms[0]
        return attrs

    def validate_base_salary(self, value):
        if value < 0:
            raise serializers.ValidationError('Base salary cannot be negative.')
        return value

    @transaction.atomic
    def create(self, validated_data):
        previous_open_term = getattr(self, '_previous_open_term', None)
        if previous_open_term:
            previous_open_term.effective_to = validated_data['effective_from'] - timedelta(days=1)
            previous_open_term.save(update_fields=['effective_to', 'updated_at'])
        return super().create(validated_data)


class InitialEmploymentTermSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmploymentTerm
        fields = [
            'branch', 'job_title', 'department', 'employment_type', 'pay_frequency',
            'base_salary', 'currency', 'effective_from', 'effective_to', 'notes',
        ]

    def validate(self, attrs):
        business = self.context.get('business')
        branch = attrs.get('branch')
        effective_from = attrs.get('effective_from')
        effective_to = attrs.get('effective_to')
        if business and branch and branch.business_id != business.id:
            raise serializers.ValidationError({
                'branch': 'The selected branch must belong to the employee business.',
            })
        if effective_to and effective_from and effective_to < effective_from:
            raise serializers.ValidationError({
                'effective_to': 'End date cannot be before the effective date.',
            })
        return attrs

    def validate_base_salary(self, value):
        if value < 0:
            raise serializers.ValidationError('Base salary cannot be negative.')
        return value


class EmployeeSerializer(serializers.ModelSerializer):
    full_name = serializers.CharField(read_only=True)
    employee_code = serializers.CharField(read_only=True)
    staff_name = serializers.CharField(source='staff.name', read_only=True, default=None)
    current_employment_term = serializers.SerializerMethodField()
    employment_terms = EmploymentTermSerializer(many=True, read_only=True)

    class Meta:
        model = Employee
        fields = [
            'id', 'business', 'staff', 'staff_name', 'employee_number', 'employee_code',
            'first_name', 'last_name', 'full_name', 'email', 'phone', 'address',
            'emergency_contact_name', 'emergency_contact_phone', 'employment_status',
            'started_on', 'ended_on', 'notes', 'current_employment_term',
            'employment_terms', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_current_employment_term(self, obj):
        terms = obj._prefetched_objects_cache.get('employment_terms') if hasattr(obj, '_prefetched_objects_cache') else None
        if terms is None:
            terms = list(obj.employment_terms.select_related('branch').all())
        if not terms:
            return None

        today = timezone.localdate()
        current_terms = [
            term for term in terms
            if term.effective_from <= today and (term.effective_to is None or term.effective_to >= today)
        ]
        selected = sorted(current_terms or terms, key=lambda term: term.effective_from, reverse=True)[0]
        return EmploymentTermSerializer(selected).data


class EmployeeWriteSerializer(serializers.ModelSerializer):
    staff = serializers.PrimaryKeyRelatedField(
        queryset=Staff.objects.all(),
        required=False,
        allow_null=True,
    )
    initial_employment_term = InitialEmploymentTermSerializer(required=False, write_only=True)

    class Meta:
        model = Employee
        fields = [
            'staff', 'first_name', 'last_name', 'email', 'phone', 'address',
            'emergency_contact_name', 'emergency_contact_phone', 'employment_status',
            'started_on', 'ended_on', 'notes', 'initial_employment_term',
        ]

    def validate(self, attrs):
        instance = getattr(self, 'instance', None)
        business = self.context.get('business') or getattr(instance, 'business', None)
        staff = attrs.get('staff', getattr(instance, 'staff', None))
        started_on = attrs.get('started_on', getattr(instance, 'started_on', None))
        ended_on = attrs.get('ended_on', getattr(instance, 'ended_on', None))

        if staff and business and staff.business_id != business.id:
            raise serializers.ValidationError({
                'staff': 'The selected staff account belongs to another business.',
            })
        if staff:
            linked_employee = getattr(staff, 'employee_profile', None)
            if linked_employee and (not instance or linked_employee.id != instance.id):
                raise serializers.ValidationError({
                    'staff': 'This staff account is already linked to another employee.',
                })
        if ended_on and started_on and ended_on < started_on:
            raise serializers.ValidationError({
                'ended_on': 'End date cannot be before the employment start date.',
            })
        if instance and 'initial_employment_term' in attrs:
            raise serializers.ValidationError({
                'initial_employment_term': 'Add changes through the employment terms history instead.',
            })
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        initial_term_data = validated_data.pop('initial_employment_term', None)
        employee = Employee.objects.create(**validated_data)
        if initial_term_data:
            EmploymentTerm.objects.create(employee=employee, **initial_term_data)
        return employee


class WorkShiftSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    scheduled_minutes = serializers.IntegerField(read_only=True)

    class Meta:
        model = WorkShift
        fields = [
            'id', 'employee', 'employee_name', 'employee_code', 'branch', 'branch_name',
            'work_date', 'starts_at', 'ends_at', 'break_minutes', 'scheduled_minutes',
            'status', 'notes', 'created_by', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at', 'updated_at']

    def validate(self, attrs):
        instance = getattr(self, 'instance', None)
        employee = attrs.get('employee', getattr(instance, 'employee', None))
        branch = attrs.get('branch', getattr(instance, 'branch', None))
        starts_at = attrs.get('starts_at', getattr(instance, 'starts_at', None))
        ends_at = attrs.get('ends_at', getattr(instance, 'ends_at', None))
        break_minutes = attrs.get('break_minutes', getattr(instance, 'break_minutes', 0))
        if employee and branch and branch.business_id != employee.business_id:
            raise serializers.ValidationError({'branch': 'The selected branch must belong to the employee business.'})
        if starts_at and ends_at and ends_at <= starts_at:
            raise serializers.ValidationError({'ends_at': 'Shift end time must be after the start time.'})
        if starts_at and ends_at and break_minutes >= (ends_at.hour * 60 + ends_at.minute - starts_at.hour * 60 - starts_at.minute):
            raise serializers.ValidationError({'break_minutes': 'Break time must be shorter than the shift.'})
        return attrs


class AttendanceRecordSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    worked_minutes = serializers.IntegerField(read_only=True)

    class Meta:
        model = AttendanceRecord
        fields = [
            'id', 'employee', 'employee_name', 'employee_code', 'branch', 'branch_name',
            'shift', 'work_date', 'clock_in', 'clock_out', 'break_minutes', 'worked_minutes',
            'status', 'source', 'notes', 'recorded_by', 'reviewed_by', 'reviewed_at',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'worked_minutes', 'recorded_by', 'reviewed_by', 'reviewed_at',
            'created_at', 'updated_at',
        ]


class ManualAttendanceSerializer(serializers.ModelSerializer):
    class Meta:
        model = AttendanceRecord
        fields = [
            'employee', 'branch', 'shift', 'work_date', 'clock_in', 'clock_out',
            'break_minutes', 'notes',
        ]

    def validate(self, attrs):
        employee = attrs['employee']
        branch = attrs['branch']
        if branch.business_id != employee.business_id:
            raise serializers.ValidationError({'branch': 'The selected branch must belong to the employee business.'})
        shift = attrs.get('shift')
        if shift and shift.employee_id != employee.id:
            raise serializers.ValidationError({'shift': 'The selected shift must belong to the employee.'})
        if not attrs.get('clock_out'):
            raise serializers.ValidationError({'clock_out': 'Manual attendance needs both clock-in and clock-out times.'})
        if attrs.get('clock_out') and attrs['clock_out'] < attrs['clock_in']:
            raise serializers.ValidationError({'clock_out': 'Clock-out cannot be before clock-in.'})
        return attrs


class LeaveTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = LeaveType
        fields = [
            'id', 'business', 'name', 'code', 'paid', 'annual_allowance_days',
            'requires_approval', 'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'business', 'created_at', 'updated_at']

    def validate_annual_allowance_days(self, value):
        if value < 0:
            raise serializers.ValidationError('Annual allowance cannot be negative.')
        return value


class LeaveBalanceSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    leave_type_name = serializers.CharField(source='leave_type.name', read_only=True)
    total_days = serializers.SerializerMethodField()
    approved_days = serializers.SerializerMethodField()
    available_days = serializers.SerializerMethodField()

    class Meta:
        model = LeaveBalance
        fields = [
            'id', 'employee', 'employee_name', 'employee_code', 'leave_type', 'leave_type_name',
            'year', 'entitlement_days', 'carried_over_days', 'adjustment_days',
            'total_days', 'approved_days', 'available_days', 'notes', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'total_days', 'approved_days', 'available_days', 'created_at', 'updated_at',
        ]

    def _summary(self, obj):
        return leave_balance_summary(obj)

    def get_total_days(self, obj):
        return self._summary(obj)['total_days']

    def get_approved_days(self, obj):
        return self._summary(obj)['approved_days']

    def get_available_days(self, obj):
        return self._summary(obj)['available_days']

    def validate(self, attrs):
        instance = getattr(self, 'instance', None)
        employee = attrs.get('employee', getattr(instance, 'employee', None))
        leave_type = attrs.get('leave_type', getattr(instance, 'leave_type', None))
        if employee and leave_type and leave_type.business_id != employee.business_id:
            raise serializers.ValidationError({'leave_type': 'The leave type must belong to the employee business.'})
        return attrs


class LeaveRequestSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    leave_type_name = serializers.CharField(source='leave_type.name', read_only=True)

    class Meta:
        model = LeaveRequest
        fields = [
            'id', 'employee', 'employee_name', 'employee_code', 'leave_type', 'leave_type_name',
            'start_date', 'end_date', 'requested_days', 'reason', 'status', 'submitted_by',
            'reviewed_by', 'review_note', 'submitted_at', 'reviewed_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'requested_days', 'status', 'submitted_by', 'reviewed_by', 'reviewed_at',
            'submitted_at', 'updated_at',
        ]


class LeaveRequestWriteSerializer(serializers.ModelSerializer):
    employee = serializers.PrimaryKeyRelatedField(queryset=Employee.objects.all(), required=False)

    class Meta:
        model = LeaveRequest
        fields = ['employee', 'leave_type', 'start_date', 'end_date', 'reason']

    def validate(self, attrs):
        start_date = attrs.get('start_date')
        end_date = attrs.get('end_date')
        leave_type = attrs.get('leave_type')
        employee = attrs.get('employee')
        if start_date and end_date:
            if end_date < start_date:
                raise serializers.ValidationError({'end_date': 'Leave end date cannot be before the start date.'})
            if start_date.year != end_date.year:
                raise serializers.ValidationError({'end_date': 'Submit separate requests for different calendar years.'})
            if working_days(start_date, end_date) <= 0:
                raise serializers.ValidationError({'start_date': 'Leave must include at least one weekday.'})
        if employee and leave_type and leave_type.business_id != employee.business_id:
            raise serializers.ValidationError({'leave_type': 'The leave type must belong to the employee business.'})
        return attrs

    def create(self, validated_data):
        validated_data['requested_days'] = working_days(
            validated_data['start_date'], validated_data['end_date'],
        )
        return super().create(validated_data)


class OvertimeRequestSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)

    class Meta:
        model = OvertimeRequest
        fields = [
            'id', 'employee', 'employee_name', 'employee_code', 'branch', 'branch_name',
            'attendance', 'work_date', 'requested_minutes', 'approved_minutes', 'reason',
            'status', 'submitted_by', 'reviewed_by', 'review_note', 'submitted_at',
            'reviewed_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'approved_minutes', 'status', 'submitted_by', 'reviewed_by', 'reviewed_at',
            'submitted_at', 'updated_at',
        ]


class OvertimeRequestWriteSerializer(serializers.ModelSerializer):
    employee = serializers.PrimaryKeyRelatedField(queryset=Employee.objects.all(), required=False)

    class Meta:
        model = OvertimeRequest
        fields = ['employee', 'branch', 'attendance', 'work_date', 'requested_minutes', 'reason']

    def validate(self, attrs):
        employee = attrs.get('employee')
        branch = attrs.get('branch')
        attendance = attrs.get('attendance')
        if employee and branch and branch.business_id != employee.business_id:
            raise serializers.ValidationError({'branch': 'The selected branch must belong to the employee business.'})
        if employee and attendance and attendance.employee_id != employee.id:
            raise serializers.ValidationError({'attendance': 'The attendance record must belong to the employee.'})
        if attrs.get('requested_minutes', 0) <= 0:
            raise serializers.ValidationError({'requested_minutes': 'Overtime must be greater than zero minutes.'})
        return attrs


class PayrollSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollSettings
        fields = [
            'id', 'business', 'standard_monthly_hours', 'overtime_multiplier',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'business', 'created_at', 'updated_at']

    def validate_standard_monthly_hours(self, value):
        if value <= 0:
            raise serializers.ValidationError('Standard monthly hours must be greater than zero.')
        return value

    def validate_overtime_multiplier(self, value):
        if value <= 0:
            raise serializers.ValidationError('Overtime multiplier must be greater than zero.')
        return value


class PayrollLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollLine
        fields = ['id', 'payroll_entry', 'kind', 'label', 'amount', 'notes', 'created_at', 'updated_at']
        read_only_fields = ['id', 'created_at', 'updated_at']

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError('Payroll line amounts must not be negative.')
        return value


class PayrollEntrySerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.full_name', read_only=True)
    employee_code = serializers.CharField(source='employee.employee_code', read_only=True)
    lines = PayrollLineSerializer(many=True, read_only=True)

    class Meta:
        model = PayrollEntry
        fields = [
            'id', 'payroll_run', 'employee', 'employee_name', 'employee_code',
            'employment_term', 'job_title_snapshot', 'pay_frequency_snapshot', 'currency',
            'base_pay', 'overtime_minutes', 'overtime_pay', 'gross_pay',
            'deductions_total', 'net_pay', 'notes', 'lines', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'employment_term', 'job_title_snapshot', 'pay_frequency_snapshot',
            'currency', 'base_pay', 'overtime_minutes', 'overtime_pay', 'gross_pay',
            'deductions_total', 'net_pay', 'lines', 'created_at', 'updated_at',
        ]


class PayrollRunSerializer(serializers.ModelSerializer):
    entries = PayrollEntrySerializer(many=True, read_only=True)

    class Meta:
        model = PayrollRun
        fields = [
            'id', 'business', 'period_start', 'period_end', 'pay_date', 'status', 'currency',
            'notes', 'total_gross', 'total_deductions', 'total_net', 'entries',
            'created_by', 'approved_by', 'approved_at', 'paid_by', 'paid_at',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'business', 'status', 'total_gross', 'total_deductions', 'total_net',
            'entries', 'created_by', 'approved_by', 'approved_at', 'paid_by', 'paid_at',
            'created_at', 'updated_at',
        ]


class PayrollRunWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollRun
        fields = ['period_start', 'period_end', 'pay_date', 'currency', 'notes']

    def validate(self, attrs):
        period_start = attrs.get('period_start')
        period_end = attrs.get('period_end')
        pay_date = attrs.get('pay_date')
        if period_start and period_end and period_end < period_start:
            raise serializers.ValidationError({'period_end': 'Payroll period end cannot be before the start.'})
        if pay_date and period_end and pay_date < period_end:
            raise serializers.ValidationError({'pay_date': 'Pay date cannot be before the payroll period ends.'})
        currency = str(attrs.get('currency') or '').strip().upper()
        if len(currency) != 3:
            raise serializers.ValidationError({'currency': 'Use a three-letter currency code.'})
        attrs['currency'] = currency
        return attrs


class PayrollLineWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollLine
        fields = ['payroll_entry', 'kind', 'label', 'amount', 'notes']

    def validate(self, attrs):
        entry = attrs.get('payroll_entry')
        if entry and entry.payroll_run.status not in {PayrollRun.Status.DRAFT, PayrollRun.Status.CALCULATED}:
            raise serializers.ValidationError('Pay lines cannot be changed after the payroll run is approved.')
        if attrs.get('amount', 0) < 0:
            raise serializers.ValidationError({'amount': 'Payroll line amounts must not be negative.'})
        return attrs
