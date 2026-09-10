import uuid
from datetime import datetime
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import Max

from business.models import Branch, Business
from staff.models import Staff


class EmployeeSequence(models.Model):
    """Per-business employee number allocator kept separate from employee data."""

    business = models.OneToOneField(
        Business,
        on_delete=models.CASCADE,
        related_name='employee_sequence',
    )
    last_number = models.PositiveIntegerField(default=0)


class Employee(models.Model):
    class Status(models.TextChoices):
        ACTIVE = 'active', 'Active'
        ON_LEAVE = 'on_leave', 'On leave'
        TERMINATED = 'terminated', 'Terminated'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(
        Business,
        on_delete=models.CASCADE,
        related_name='employees',
    )
    staff = models.OneToOneField(
        Staff,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='employee_profile',
        help_text='Optional Handy POS login linked to this employee.',
    )
    employee_number = models.PositiveIntegerField(editable=False)
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=32, blank=True)
    address = models.TextField(blank=True)
    emergency_contact_name = models.CharField(max_length=255, blank=True)
    emergency_contact_phone = models.CharField(max_length=32, blank=True)
    employment_status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    started_on = models.DateField(null=True, blank=True)
    ended_on = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['last_name', 'first_name', 'employee_number']
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'employee_number'],
                name='hr_unique_employee_number_per_business',
            ),
        ]
        indexes = [
            models.Index(fields=['business', 'employment_status']),
            models.Index(fields=['business', 'last_name', 'first_name']),
        ]

    def __str__(self):
        return f'{self.employee_code} {self.full_name}'

    @property
    def employee_code(self):
        return f'EMP-{self.employee_number:04d}'

    @property
    def full_name(self):
        return ' '.join(part for part in [self.first_name, self.last_name] if part).strip()

    def clean(self):
        if self.staff_id and self.business_id and self.staff.business_id != self.business_id:
            raise ValidationError({'staff': 'The linked staff account must belong to the same business.'})
        if self.ended_on and self.started_on and self.ended_on < self.started_on:
            raise ValidationError({'ended_on': 'End date cannot be before the employment start date.'})

    def save(self, *args, **kwargs):
        if not self.employee_number and self.business_id:
            with transaction.atomic():
                sequence, _ = EmployeeSequence.objects.select_for_update().get_or_create(
                    business_id=self.business_id,
                    defaults={'last_number': 0},
                )
                if sequence.last_number <= 0:
                    latest_number = Employee.objects.filter(
                        business_id=self.business_id,
                    ).aggregate(latest=Max('employee_number'))['latest'] or 0
                    sequence.last_number = latest_number
                sequence.last_number += 1
                sequence.save(update_fields=['last_number'])
                self.employee_number = sequence.last_number
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class EmploymentTerm(models.Model):
    class EmploymentType(models.TextChoices):
        FULL_TIME = 'full_time', 'Full time'
        PART_TIME = 'part_time', 'Part time'
        CONTRACT = 'contract', 'Contract'
        CASUAL = 'casual', 'Casual'

    class PayFrequency(models.TextChoices):
        MONTHLY = 'monthly', 'Monthly'
        FORTNIGHTLY = 'fortnightly', 'Fortnightly'
        WEEKLY = 'weekly', 'Weekly'
        HOURLY = 'hourly', 'Hourly'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.CASCADE,
        related_name='employment_terms',
    )
    branch = models.ForeignKey(
        Branch,
        on_delete=models.PROTECT,
        related_name='employment_terms',
    )
    job_title = models.CharField(max_length=150)
    department = models.CharField(max_length=150, blank=True)
    employment_type = models.CharField(
        max_length=20,
        choices=EmploymentType.choices,
        default=EmploymentType.FULL_TIME,
    )
    pay_frequency = models.CharField(
        max_length=20,
        choices=PayFrequency.choices,
        default=PayFrequency.MONTHLY,
    )
    base_salary = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3, default='MWK')
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-effective_from', '-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'effective_from'],
                name='hr_unique_employee_term_effective_date',
            ),
            models.CheckConstraint(
                condition=models.Q(effective_to__isnull=True) | models.Q(effective_to__gte=models.F('effective_from')),
                name='hr_term_end_not_before_start',
            ),
        ]
        indexes = [
            models.Index(fields=['employee', 'effective_from']),
            models.Index(fields=['branch', 'effective_from']),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.job_title} ({self.effective_from})'

    def clean(self):
        if self.branch_id and self.employee_id and self.branch.business_id != self.employee.business_id:
            raise ValidationError({'branch': 'The employment branch must belong to the employee business.'})
        if self.effective_to and self.effective_to < self.effective_from:
            raise ValidationError({'effective_to': 'End date cannot be before the effective date.'})


class WorkShift(models.Model):
    class Status(models.TextChoices):
        SCHEDULED = 'scheduled', 'Scheduled'
        CANCELLED = 'cancelled', 'Cancelled'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='work_shifts')
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name='work_shifts')
    work_date = models.DateField()
    starts_at = models.TimeField()
    ends_at = models.TimeField()
    break_minutes = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.SCHEDULED)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_hr_shifts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['work_date', 'starts_at', 'employee__last_name', 'employee__first_name']
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'work_date', 'starts_at'],
                name='hr_unique_employee_shift_start',
            ),
            models.CheckConstraint(
                condition=models.Q(ends_at__gt=models.F('starts_at')),
                name='hr_shift_end_after_start',
            ),
        ]
        indexes = [
            models.Index(fields=['branch', 'work_date', 'status']),
            models.Index(fields=['employee', 'work_date']),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.work_date}'

    @property
    def scheduled_minutes(self):
        minutes = int((datetime.combine(self.work_date, self.ends_at) - datetime.combine(self.work_date, self.starts_at)).total_seconds() / 60)
        return max(0, minutes - self.break_minutes)

    def clean(self):
        if self.branch_id and self.employee_id and self.branch.business_id != self.employee.business_id:
            raise ValidationError({'branch': 'The shift branch must belong to the employee business.'})
        if self.ends_at and self.starts_at and self.ends_at <= self.starts_at:
            raise ValidationError({'ends_at': 'Shift end time must be after the start time.'})
        if self.break_minutes and self.starts_at and self.ends_at:
            total_minutes = int((datetime.combine(self.work_date, self.ends_at) - datetime.combine(self.work_date, self.starts_at)).total_seconds() / 60)
            if self.break_minutes >= total_minutes:
                raise ValidationError({'break_minutes': 'Break time must be shorter than the shift.'})


class AttendanceRecord(models.Model):
    class Status(models.TextChoices):
        OPEN = 'open', 'Clocked in'
        SUBMITTED = 'submitted', 'Awaiting approval'
        APPROVED = 'approved', 'Approved'
        REJECTED = 'rejected', 'Rejected'

    class Source(models.TextChoices):
        CLOCK = 'clock', 'Employee clock'
        MANUAL = 'manual', 'Manual entry'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='attendance_records')
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name='attendance_records')
    shift = models.ForeignKey(
        WorkShift,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='attendance_records',
    )
    work_date = models.DateField()
    clock_in = models.DateTimeField()
    clock_out = models.DateTimeField(null=True, blank=True)
    break_minutes = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.CLOCK)
    notes = models.TextField(blank=True)
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='recorded_hr_attendance',
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='reviewed_hr_attendance',
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-work_date', '-clock_in']
        indexes = [
            models.Index(fields=['employee', 'work_date']),
            models.Index(fields=['branch', 'status', 'work_date']),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['employee'],
                condition=models.Q(status='open', clock_out__isnull=True),
                name='hr_one_open_attendance_per_employee',
            ),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.work_date}'

    @property
    def worked_minutes(self):
        if not self.clock_out:
            return None
        minutes = int((self.clock_out - self.clock_in).total_seconds() / 60)
        return max(0, minutes - self.break_minutes)

    def clean(self):
        if self.branch_id and self.employee_id and self.branch.business_id != self.employee.business_id:
            raise ValidationError({'branch': 'The attendance branch must belong to the employee business.'})
        if self.shift_id and self.shift.employee_id != self.employee_id:
            raise ValidationError({'shift': 'The selected shift must belong to the employee.'})
        if self.clock_out and self.clock_out < self.clock_in:
            raise ValidationError({'clock_out': 'Clock-out cannot be before clock-in.'})


class LeaveType(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='leave_types')
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=30)
    paid = models.BooleanField(default=True)
    annual_allowance_days = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    requires_approval = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['business', 'code'], name='hr_unique_leave_type_code'),
            models.CheckConstraint(condition=models.Q(annual_allowance_days__gte=0), name='hr_leave_allowance_non_negative'),
        ]

    def __str__(self):
        return f'{self.business.name} - {self.name}'


class LeaveBalance(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='leave_balances')
    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name='balances')
    year = models.PositiveSmallIntegerField()
    entitlement_days = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    carried_over_days = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    adjustment_days = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-year', 'employee__last_name', 'leave_type__name']
        constraints = [
            models.UniqueConstraint(fields=['employee', 'leave_type', 'year'], name='hr_unique_leave_balance_year'),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.leave_type.name} ({self.year})'

    def clean(self):
        if self.employee_id and self.leave_type_id and self.leave_type.business_id != self.employee.business_id:
            raise ValidationError({'leave_type': 'The leave type must belong to the employee business.'})


class LeaveRequest(models.Model):
    class Status(models.TextChoices):
        PENDING = 'pending', 'Pending'
        APPROVED = 'approved', 'Approved'
        REJECTED = 'rejected', 'Rejected'
        CANCELLED = 'cancelled', 'Cancelled'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='leave_requests')
    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name='requests')
    start_date = models.DateField()
    end_date = models.DateField()
    requested_days = models.DecimalField(max_digits=6, decimal_places=2)
    reason = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='submitted_hr_leave_requests',
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='reviewed_hr_leave_requests',
    )
    review_note = models.TextField(blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-submitted_at']
        indexes = [
            models.Index(fields=['employee', 'status', 'start_date']),
            models.Index(fields=['leave_type', 'status', 'start_date']),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.start_date} to {self.end_date}'

    def clean(self):
        if self.leave_type_id and self.employee_id and self.leave_type.business_id != self.employee.business_id:
            raise ValidationError({'leave_type': 'The leave type must belong to the employee business.'})
        if self.end_date < self.start_date:
            raise ValidationError({'end_date': 'Leave end date cannot be before the start date.'})
        if self.start_date.year != self.end_date.year:
            raise ValidationError({'end_date': 'Submit separate requests for different calendar years.'})
        if self.requested_days is not None and self.requested_days <= 0:
            raise ValidationError({'requested_days': 'Leave days must be greater than zero.'})


class OvertimeRequest(models.Model):
    class Status(models.TextChoices):
        PENDING = 'pending', 'Pending'
        APPROVED = 'approved', 'Approved'
        REJECTED = 'rejected', 'Rejected'
        CANCELLED = 'cancelled', 'Cancelled'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='overtime_requests')
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name='overtime_requests')
    attendance = models.ForeignKey(
        AttendanceRecord,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='overtime_requests',
    )
    work_date = models.DateField()
    requested_minutes = models.PositiveIntegerField()
    approved_minutes = models.PositiveIntegerField(null=True, blank=True)
    reason = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='submitted_hr_overtime_requests',
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='reviewed_hr_overtime_requests',
    )
    review_note = models.TextField(blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-work_date', '-submitted_at']
        indexes = [
            models.Index(fields=['employee', 'status', 'work_date']),
            models.Index(fields=['branch', 'status', 'work_date']),
        ]

    def __str__(self):
        return f'{self.employee.full_name} - {self.requested_minutes} minutes'

    def clean(self):
        if self.branch_id and self.employee_id and self.branch.business_id != self.employee.business_id:
            raise ValidationError({'branch': 'The overtime branch must belong to the employee business.'})
        if self.attendance_id and self.attendance.employee_id != self.employee_id:
            raise ValidationError({'attendance': 'The attendance record must belong to the employee.'})
        if self.requested_minutes <= 0:
            raise ValidationError({'requested_minutes': 'Overtime must be greater than zero minutes.'})
        if self.approved_minutes is not None and self.approved_minutes > self.requested_minutes:
            raise ValidationError({'approved_minutes': 'Approved overtime cannot exceed requested overtime.'})


class PayrollSettings(models.Model):
    business = models.OneToOneField(Business, on_delete=models.CASCADE, related_name='payroll_settings')
    standard_monthly_hours = models.DecimalField(max_digits=7, decimal_places=2, default=208)
    overtime_multiplier = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('1.50'))
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Payroll settings'
        verbose_name_plural = 'Payroll settings'

    def __str__(self):
        return f'Payroll settings for {self.business.name}'

    def clean(self):
        if self.standard_monthly_hours <= 0:
            raise ValidationError({'standard_monthly_hours': 'Standard monthly hours must be greater than zero.'})
        if self.overtime_multiplier <= 0:
            raise ValidationError({'overtime_multiplier': 'Overtime multiplier must be greater than zero.'})


class PayrollRun(models.Model):
    class Status(models.TextChoices):
        DRAFT = 'draft', 'Draft'
        CALCULATED = 'calculated', 'Calculated'
        APPROVED = 'approved', 'Approved'
        PAID = 'paid', 'Paid'
        VOID = 'void', 'Void'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='payroll_runs')
    period_start = models.DateField()
    period_end = models.DateField()
    pay_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    currency = models.CharField(max_length=3, default='MWK')
    notes = models.TextField(blank=True)
    total_gross = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    total_deductions = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    total_net = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_payroll_runs',
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='approved_payroll_runs',
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='paid_payroll_runs',
    )
    paid_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-period_end', '-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'period_start', 'period_end'],
                name='hr_unique_payroll_period_per_business',
            ),
            models.CheckConstraint(
                condition=models.Q(period_end__gte=models.F('period_start')),
                name='hr_payroll_end_not_before_start',
            ),
        ]
        indexes = [
            models.Index(fields=['business', 'status', 'period_end']),
        ]

    def __str__(self):
        return f'{self.business.name} - {self.period_start} to {self.period_end}'

    def clean(self):
        if self.period_end < self.period_start:
            raise ValidationError({'period_end': 'Payroll period end cannot be before the start.'})
        if self.pay_date and self.pay_date < self.period_end:
            raise ValidationError({'pay_date': 'Pay date cannot be before the payroll period ends.'})


class PayrollEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payroll_run = models.ForeignKey(PayrollRun, on_delete=models.CASCADE, related_name='entries')
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name='payroll_entries')
    employment_term = models.ForeignKey(
        EmploymentTerm,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='payroll_entries',
    )
    job_title_snapshot = models.CharField(max_length=150, blank=True)
    pay_frequency_snapshot = models.CharField(max_length=20, blank=True)
    currency = models.CharField(max_length=3, default='MWK')
    base_pay = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    overtime_minutes = models.PositiveIntegerField(default=0)
    overtime_pay = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    gross_pay = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    deductions_total = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    net_pay = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['employee__last_name', 'employee__first_name']
        constraints = [
            models.UniqueConstraint(fields=['payroll_run', 'employee'], name='hr_unique_payroll_entry_employee'),
        ]
        indexes = [
            models.Index(fields=['payroll_run', 'employee']),
        ]

    def __str__(self):
        return f'{self.payroll_run} - {self.employee.full_name}'


class PayrollLine(models.Model):
    class Kind(models.TextChoices):
        EARNING = 'earning', 'Earning'
        DEDUCTION = 'deduction', 'Deduction'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payroll_entry = models.ForeignKey(PayrollEntry, on_delete=models.CASCADE, related_name='lines')
    kind = models.CharField(max_length=20, choices=Kind.choices)
    label = models.CharField(max_length=150)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['kind', 'label']
        indexes = [
            models.Index(fields=['payroll_entry', 'kind']),
        ]

    def __str__(self):
        return f'{self.label} - {self.amount}'

    def clean(self):
        if self.amount < 0:
            raise ValidationError({'amount': 'Payroll line amounts must not be negative.'})
