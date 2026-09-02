from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


MONEY = Decimal('0.01')


def _decimal(value: Any, default: Decimal = Decimal('0.00')) -> Decimal:
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() else default
    except (InvalidOperation, TypeError, ValueError):
        return default


def _money(value: Any) -> Decimal:
    return _decimal(value).quantize(MONEY, rounding=ROUND_HALF_UP)


def calculate_configured_business_charges(
    business,
    *,
    net_subtotal: Any,
    gross_total: Any,
    eis_enabled: bool = False,
) -> dict[str, Any]:
    """Resolve local charges from current backend configuration.

    When EIS is enabled, MRA is the source of levy charges. Local LEVY rows
    are therefore skipped to avoid charging the same levy twice. Service and
    other business charges remain available.
    """
    if not business:
        return {'amount': Decimal('0.00'), 'exclusive_amount': Decimal('0.00'), 'snapshot': []}

    from business.models import BusinessCharge

    today = date.today()
    charges = BusinessCharge.objects.filter(
        business=business,
        is_active=True,
        auto_apply=True,
    ).filter(
        effective_from__lte=today,
    ).filter(
        models_q_effective_to_is_null_or_after(today),
    )

    net_amount = _money(net_subtotal)
    gross_amount = _money(gross_total)
    snapshots: list[dict[str, Any]] = []
    total_amount = Decimal('0.00')
    exclusive_amount = Decimal('0.00')

    for charge in charges:
        if eis_enabled and charge.charge_type == 'LEVY':
            continue
        rate = _money(charge.rate)
        base_amount = gross_amount if charge.calculation_base == 'gross_total' else net_amount
        raw_amount = base_amount * rate / Decimal('100')
        amount = (
            base_amount * rate / (Decimal('100') + rate)
            if charge.calculation_method == 'inclusive' and rate > 0
            else raw_amount
        )
        amount = _money(amount)
        if amount <= 0:
            continue

        total_amount += amount
        if charge.calculation_method == 'exclusive':
            exclusive_amount += amount
        snapshots.append({
            'id': str(charge.id),
            'name': charge.name,
            'chargeType': charge.charge_type,
            'rate': float(rate),
            'calculationMethod': charge.calculation_method,
            'calculationBase': charge.calculation_base,
            'baseAmount': float(base_amount),
            'amount': float(amount),
            'source': 'business',
        })

    return {
        'amount': _money(total_amount),
        'exclusive_amount': _money(exclusive_amount),
        'snapshot': snapshots,
    }


def models_q_effective_to_is_null_or_after(today: date):
    from django.db.models import Q

    return Q(effective_to__isnull=True) | Q(effective_to__gte=today)
