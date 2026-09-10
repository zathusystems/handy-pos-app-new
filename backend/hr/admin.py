from django.contrib import admin

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


class EmploymentTermInline(admin.TabularInline):
    model = EmploymentTerm
    extra = 0
    ordering = ('-effective_from',)


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = (
        'employee_code', 'full_name', 'business', 'employment_status',
        'staff', 'started_on', 'updated_at',
    )
    search_fields = ('first_name', 'last_name', 'email', 'phone', 'staff__email', 'business__name')
    list_filter = ('employment_status', 'business')
    readonly_fields = ('id', 'employee_number', 'created_at', 'updated_at')
    inlines = [EmploymentTermInline]
    ordering = ('business', 'last_name', 'first_name')


@admin.register(EmploymentTerm)
class EmploymentTermAdmin(admin.ModelAdmin):
    list_display = (
        'employee', 'job_title', 'branch', 'pay_frequency', 'base_salary',
        'currency', 'effective_from', 'effective_to',
    )
    search_fields = ('employee__first_name', 'employee__last_name', 'job_title', 'department')
    list_filter = ('employment_type', 'pay_frequency', 'currency', 'branch')
    ordering = ('-effective_from',)


@admin.register(WorkShift)
class WorkShiftAdmin(admin.ModelAdmin):
    list_display = ('work_date', 'employee', 'branch', 'starts_at', 'ends_at', 'status')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email', 'notes')
    list_filter = ('status', 'work_date', 'branch')
    readonly_fields = ('id', 'created_at', 'updated_at')
    ordering = ('-work_date', 'starts_at')


@admin.register(AttendanceRecord)
class AttendanceRecordAdmin(admin.ModelAdmin):
    list_display = ('work_date', 'employee', 'branch', 'clock_in', 'clock_out', 'worked_minutes', 'status', 'source')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email', 'notes')
    list_filter = ('status', 'source', 'work_date', 'branch')
    readonly_fields = ('id', 'worked_minutes', 'created_at', 'updated_at')
    ordering = ('-work_date', '-clock_in')


@admin.register(LeaveType)
class LeaveTypeAdmin(admin.ModelAdmin):
    list_display = ('name', 'code', 'business', 'paid', 'annual_allowance_days', 'requires_approval', 'is_active')
    search_fields = ('name', 'code', 'business__name')
    list_filter = ('paid', 'requires_approval', 'is_active', 'business')
    readonly_fields = ('id', 'created_at', 'updated_at')


@admin.register(LeaveBalance)
class LeaveBalanceAdmin(admin.ModelAdmin):
    list_display = ('employee', 'leave_type', 'year', 'entitlement_days', 'carried_over_days', 'adjustment_days')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email', 'leave_type__name')
    list_filter = ('year', 'leave_type')
    readonly_fields = ('id', 'created_at', 'updated_at')


@admin.register(LeaveRequest)
class LeaveRequestAdmin(admin.ModelAdmin):
    list_display = ('employee', 'leave_type', 'start_date', 'end_date', 'requested_days', 'status', 'submitted_at')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email', 'reason', 'review_note')
    list_filter = ('status', 'leave_type', 'start_date')
    readonly_fields = ('id', 'submitted_at', 'updated_at')
    ordering = ('-submitted_at',)


@admin.register(OvertimeRequest)
class OvertimeRequestAdmin(admin.ModelAdmin):
    list_display = ('employee', 'branch', 'work_date', 'requested_minutes', 'approved_minutes', 'status', 'submitted_at')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email', 'reason', 'review_note')
    list_filter = ('status', 'work_date', 'branch')
    readonly_fields = ('id', 'submitted_at', 'updated_at')
    ordering = ('-work_date', '-submitted_at')


@admin.register(PayrollSettings)
class PayrollSettingsAdmin(admin.ModelAdmin):
    list_display = ('business', 'standard_monthly_hours', 'overtime_multiplier', 'updated_at')
    search_fields = ('business__name',)
    readonly_fields = ('created_at', 'updated_at')


@admin.register(PayrollRun)
class PayrollRunAdmin(admin.ModelAdmin):
    list_display = ('business', 'period_start', 'period_end', 'pay_date', 'status', 'total_net')
    search_fields = ('business__name', 'notes')
    list_filter = ('status', 'currency', 'business')
    readonly_fields = ('id', 'total_gross', 'total_deductions', 'total_net', 'created_at', 'updated_at')
    ordering = ('-period_end', '-created_at')


@admin.register(PayrollEntry)
class PayrollEntryAdmin(admin.ModelAdmin):
    list_display = ('employee', 'payroll_run', 'base_pay', 'overtime_pay', 'deductions_total', 'net_pay')
    search_fields = ('employee__first_name', 'employee__last_name', 'employee__email')
    list_filter = ('payroll_run__status', 'currency', 'payroll_run__business')
    readonly_fields = ('id', 'created_at', 'updated_at')


@admin.register(PayrollLine)
class PayrollLineAdmin(admin.ModelAdmin):
    list_display = ('payroll_entry', 'kind', 'label', 'amount', 'created_at')
    search_fields = ('label', 'notes', 'payroll_entry__employee__first_name', 'payroll_entry__employee__last_name')
    list_filter = ('kind', 'payroll_entry__payroll_run__business')
    readonly_fields = ('id', 'created_at', 'updated_at')
