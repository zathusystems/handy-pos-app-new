from __future__ import annotations

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


def _line_net_amount(line: dict[str, Any]) -> Decimal:
    explicit_subtotal = _decimal(line.get('subtotal'), Decimal('-1.00'))
    if explicit_subtotal >= 0:
        return _money(explicit_subtotal)

    explicit_total = _decimal(line.get('total'), Decimal('-1.00'))
    explicit_tax = _decimal(
        line.get('taxAmount') if line.get('taxAmount') not in (None, '') else line.get('tax_amount'),
        Decimal('0.00'),
    )
    if explicit_total >= 0 and explicit_tax >= 0:
        return _money(max(explicit_total - explicit_tax, Decimal('0.00')))

    quantity = _decimal(line.get('quantity'), Decimal('0.00'))
    price = _decimal(line.get('price'), Decimal('0.00'))
    return _money(price if line.get('isVariablePrice') or line.get('is_variable_price') else price * quantity)


def calculate_mra_levy_charges(business, item_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Calculate MRA product levies from approved, synced mappings.

    MRA levies are not BusinessCharge records. They are attached to the
    product mapping returned by MRA and are applied to each product line's
    net amount. Businesses without EIS receive no MRA levy rows.
    """
    if not business:
        return []

    try:
        from mra_eis.services import is_business_eis_enabled

        if not is_business_eis_enabled(business):
            return []
    except Exception:
        return []

    from inventory.models import MRAProductMapping

    inventory_ids = {
        str(
            line.get('inventoryItemId')
            or line.get('inventory_item_id')
            or ''
        ).strip()
        for line in item_lines
    }
    inventory_ids.discard('')
    if not inventory_ids:
        return []

    mappings = MRAProductMapping.objects.filter(
        inventory_item_id__in=inventory_ids,
        inventory_item__business=business,
        is_approved=True,
        mra_synced=True,
    ).values('inventory_item_id', 'mra_levies')
    mapping_by_item = {str(row['inventory_item_id']): row.get('mra_levies') or [] for row in mappings}

    charges: list[dict[str, Any]] = []
    for line in item_lines:
        inventory_item_id = str(
            line.get('inventoryItemId')
            or line.get('inventory_item_id')
            or ''
        ).strip()
        base_amount = _line_net_amount(line)
        if not inventory_item_id or base_amount <= 0:
            continue

        raw_levies = mapping_by_item.get(inventory_item_id, [])
        if not isinstance(raw_levies, list):
            continue
        for levy in raw_levies:
            if not isinstance(levy, dict):
                continue
            levy_type_id = str(
                levy.get('levyTypeId')
                or levy.get('levy_type_id')
                or levy.get('levyId')
                or levy.get('levy_id')
                or levy.get('code')
                or ''
            ).strip()
            rate = _decimal(
                levy.get('levyRate')
                if levy.get('levyRate') is not None
                else levy.get('levy_rate'),
            )
            if not levy_type_id or rate <= 0:
                continue

            amount = _money(base_amount * rate / Decimal('100'))
            if amount <= 0:
                continue
            charges.append({
                'id': f'mra:{levy_type_id}:{inventory_item_id}',
                'name': f'MRA Levy {levy_type_id}',
                'chargeType': 'LEVY',
                'rate': float(rate.quantize(MONEY, rounding=ROUND_HALF_UP)),
                'calculationMethod': 'exclusive',
                'calculationBase': 'net_subtotal',
                'baseAmount': float(base_amount),
                'amount': float(amount),
                'source': 'mra',
                'levyTypeId': levy_type_id,
                'inventoryItemId': inventory_item_id,
            })

    return charges
