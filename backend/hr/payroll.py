from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Q, Sum

from .models import (
    AttendanceRecord,
    Employee,
    OvertimeRequest,
    PayrollEntry,
    PayrollLine,
    PayrollRule,
    PayrollRun,
    PayrollSettings,
)


MONEY = Decimal('0.01')
HOURS = Decimal('60')


def money(value):
    return Decimal(value or 0).quantize(MONEY, rounding=ROUND_HALF_UP)


def get_payroll_settings(business):
    settings, _ = PayrollSettings.objects.get_or_create(business=business)
    return settings


def applicable_term(employee, period_start, period_end):
    return employee.employment_terms.filter(
        effective_from__lte=period_end,
    ).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gte=period_start),
    ).select_related('branch').order_by('-effective_from').first()


def approved_attendance_minutes(employee, period_start, period_end):
    total = 0
    records = AttendanceRecord.objects.filter(
        employee=employee,
        work_date__gte=period_start,
        work_date__lte=period_end,
        status=AttendanceRecord.Status.APPROVED,
        clock_out__isnull=False,
    )
    for record in records:
        if record.worked_minutes is not None:
            total += record.worked_minutes
    return total


def approved_overtime_minutes(employee, period_start, period_end):
    return OvertimeRequest.objects.filter(
        employee=employee,
        work_date__gte=period_start,
        work_date__lte=period_end,
        status=OvertimeRequest.Status.APPROVED,
    ).aggregate(total=Sum('approved_minutes'))['total'] or 0


def calculate_entry(*, payroll_run, employee, term, payroll_settings):
    salary = money(term.base_salary)
    attendance_minutes = approved_attendance_minutes(
        employee, payroll_run.period_start, payroll_run.period_end,
    )
    overtime_minutes = approved_overtime_minutes(
        employee, payroll_run.period_start, payroll_run.period_end,
    )
    if term.pay_frequency == 'hourly':
        base_pay = money((Decimal(attendance_minutes) / HOURS) * salary)
        hourly_rate = salary
    else:
        # Salary terms are configured per payroll period. A monthly run uses
        # the monthly salary; fortnightly and weekly terms use their configured
        # period amount without guessing a calendar conversion.
        base_pay = salary
        hourly_rate = money(salary / payroll_settings.standard_monthly_hours)

    overtime_pay = money(
        (Decimal(overtime_minutes) / HOURS)
        * hourly_rate
        * payroll_settings.overtime_multiplier,
    )
    return {
        'employment_term': term,
        'job_title_snapshot': term.job_title,
        'pay_frequency_snapshot': term.pay_frequency,
        'currency': term.currency.upper(),
        'base_pay': base_pay,
        'overtime_minutes': overtime_minutes,
        'overtime_pay': overtime_pay,
        'gross_pay': money(base_pay + overtime_pay),
        'deductions_total': money(0),
        'net_pay': money(base_pay + overtime_pay),
    }


def recalculate_entry(entry):
    earning_total = entry.lines.filter(kind=PayrollLine.Kind.EARNING).aggregate(total=Sum('amount'))['total'] or 0
    deduction_total = entry.lines.filter(kind=PayrollLine.Kind.DEDUCTION).aggregate(total=Sum('amount'))['total'] or 0
    entry.gross_pay = money(entry.base_pay + entry.overtime_pay + earning_total)
    entry.deductions_total = money(deduction_total)
    entry.net_pay = money(entry.gross_pay - entry.deductions_total)
    entry.save(update_fields=['gross_pay', 'deductions_total', 'net_pay', 'updated_at'])
    return entry


def recalculate_run(payroll_run):
    entries = payroll_run.entries.all()
    for entry in entries:
        recalculate_entry(entry)
    totals = entries.aggregate(
        gross=Sum('gross_pay'),
        deductions=Sum('deductions_total'),
        net=Sum('net_pay'),
    )
    payroll_run.total_gross = money(totals['gross'])
    payroll_run.total_deductions = money(totals['deductions'])
    payroll_run.total_net = money(totals['net'])
    payroll_run.save(update_fields=['total_gross', 'total_deductions', 'total_net', 'updated_at'])
    return payroll_run


def applicable_payroll_rules(payroll_run):
    return PayrollRule.objects.filter(
        business=payroll_run.business,
        is_active=True,
    ).filter(
        Q(effective_from__isnull=True) | Q(effective_from__lte=payroll_run.period_end),
    ).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gte=payroll_run.period_start),
    ).order_by('kind', 'name')


def payroll_rule_amount(rule, entry):
    if rule.calculation_method == PayrollRule.CalculationMethod.FIXED:
        return money(rule.fixed_amount)
    if rule.calculation_method == PayrollRule.CalculationMethod.BASE_PERCENTAGE:
        return money(entry.base_pay * rule.percentage_rate / Decimal('100'))
    return money(entry.gross_pay * rule.percentage_rate / Decimal('100'))


def apply_payroll_rules(entry, payroll_rules):
    """Snapshot active rules into the generated payslip so later changes are safe."""
    earnings = [rule for rule in payroll_rules if rule.kind == PayrollRule.Kind.EARNING]
    deductions = [rule for rule in payroll_rules if rule.kind == PayrollRule.Kind.DEDUCTION]

    for rule in earnings:
        PayrollLine.objects.create(
            payroll_entry=entry,
            kind=PayrollLine.Kind.EARNING,
            label=rule.name,
            amount=payroll_rule_amount(rule, entry),
            notes=rule.code or rule.notes,
        )
    recalculate_entry(entry)

    for rule in deductions:
        PayrollLine.objects.create(
            payroll_entry=entry,
            kind=PayrollLine.Kind.DEDUCTION,
            label=rule.name,
            amount=payroll_rule_amount(rule, entry),
            notes=rule.code or rule.notes,
        )
    return recalculate_entry(entry)


@transaction.atomic
def generate_payroll_run(payroll_run):
    if payroll_run.status != PayrollRun.Status.DRAFT:
        raise ValueError('Only draft payroll runs can be generated.')

    payroll_settings = get_payroll_settings(payroll_run.business)
    payroll_rules = list(applicable_payroll_rules(payroll_run))
    payroll_run.entries.all().delete()
    employees = Employee.objects.filter(
        business=payroll_run.business,
        employment_status=Employee.Status.ACTIVE,
    ).prefetch_related('employment_terms')
    generated_entries = 0
    for employee in employees:
        if employee.started_on and employee.started_on > payroll_run.period_end:
            continue
        if employee.ended_on and employee.ended_on < payroll_run.period_start:
            continue
        term = applicable_term(employee, payroll_run.period_start, payroll_run.period_end)
        if not term:
            continue
        if term.currency.upper() != payroll_run.currency.upper():
            raise ValueError(
                f'{employee.full_name} has a {term.currency.upper()} employment term, '
                f'but this run is in {payroll_run.currency.upper()}.',
            )
        entry = PayrollEntry.objects.create(
            payroll_run=payroll_run,
            employee=employee,
            **calculate_entry(
                payroll_run=payroll_run,
                employee=employee,
                term=term,
                payroll_settings=payroll_settings,
            ),
        )
        apply_payroll_rules(entry, payroll_rules)
        generated_entries += 1

    if generated_entries == 0:
        raise ValueError(
            'No active employees with an employment term in this period are available for payroll.'
        )

    payroll_run.status = PayrollRun.Status.CALCULATED
    payroll_run.save(update_fields=['status', 'updated_at'])
    return recalculate_run(payroll_run)
