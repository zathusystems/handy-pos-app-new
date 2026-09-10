from datetime import timedelta
from decimal import Decimal

from django.db.models import Sum

from .models import LeaveBalance, LeaveRequest


def working_days(start_date, end_date):
    """Count weekdays inclusively; public holidays can be added in a later phase."""
    if not start_date or not end_date or end_date < start_date:
        return Decimal('0.00')
    days = 0
    current = start_date
    while current <= end_date:
        if current.weekday() < 5:
            days += 1
        current += timedelta(days=1)
    return Decimal(days).quantize(Decimal('0.01'))


def leave_balance_summary(balance):
    approved = LeaveRequest.objects.filter(
        employee=balance.employee,
        leave_type=balance.leave_type,
        start_date__year=balance.year,
        status=LeaveRequest.Status.APPROVED,
    ).aggregate(total=Sum('requested_days'))['total'] or Decimal('0.00')
    total = balance.entitlement_days + balance.carried_over_days + balance.adjustment_days
    return {
        'total_days': total,
        'approved_days': approved,
        'available_days': total - approved,
    }
