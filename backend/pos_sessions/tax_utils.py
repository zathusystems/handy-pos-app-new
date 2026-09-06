"""
Tax calculation utilities for MRA compliance

Handles accurate calculation and snapshotting of tax values at the time of sale.
These values are NEVER recalculated - they are immutable for audit purposes.
"""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Optional, Tuple
from django.core.exceptions import ValidationError
from django.utils import timezone
from business.models import TaxRate, Business


MONEY = Decimal('0.01')

def _decimal(value: Any, default: Decimal = Decimal('0.00')) -> Decimal:
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() else default
    except (InvalidOperation, TypeError, ValueError):
        return default


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ''):
        return None
    return _decimal(value, Decimal('0.00'))


def _money(value: Any) -> Decimal:
    return _decimal(value).quantize(MONEY, rounding=ROUND_HALF_UP)


def _normalize_mra_tax_type(value: Any) -> str:
    normalized = str(value or '').strip().lower()
    if normalized in {'zero', 'zero_rated', 'zero-rated', 'vat_zero'}:
        return 'zero'
    if normalized in {'exempt', 'vat_exempt'}:
        return 'exempt'
    return 'standard'


def _resolve_eis_line_base_amount(line: dict[str, Any], method: str) -> Decimal:
    quantity = _decimal(line.get('quantity'), Decimal('0.00'))
    price = _decimal(line.get('price'), Decimal('0.00'))
    subtotal = _optional_decimal(line.get('subtotal'))
    tax_amount = _optional_decimal(line.get('tax_amount'))
    if tax_amount is None:
        tax_amount = _optional_decimal(line.get('taxAmount'))
    total = _optional_decimal(line.get('total'))

    if method == 'exclusive':
        if subtotal is not None and subtotal >= 0:
            return subtotal
        if total is not None and tax_amount is not None:
            return max(total - tax_amount, Decimal('0.00'))
        if total is not None and total >= 0:
            return total
    else:
        if total is not None and total >= 0:
            return total
        if subtotal is not None and tax_amount is not None:
            return max(subtotal + tax_amount, Decimal('0.00'))
        if subtotal is not None and subtotal >= 0:
            return subtotal

    return max(quantity * price, Decimal('0.00'))


def _calculate_eis_line_tax_values(
    line_base_amount: Decimal,
    tax_type: str,
    tax_rate: Decimal,
    tax_calculation_method: str,
) -> dict[str, Decimal | str]:
    base = max(Decimal('0.00'), _decimal(line_base_amount))
    normalized_type = _normalize_mra_tax_type(tax_type)
    method = 'exclusive' if str(tax_calculation_method or '').strip().lower() == 'exclusive' else 'inclusive'
    rate = max(Decimal('0.00'), _decimal(tax_rate))

    if normalized_type in {'zero', 'exempt'} or rate <= 0:
        return {
            'subtotal': _money(base),
            'tax_amount': Decimal('0.00'),
            'total': _money(base),
            'tax_type': normalized_type,
            'tax_calculation_method': method,
            'tax_rate': _money(rate),
        }

    rate_fraction = rate / Decimal('100')
    if method == 'exclusive':
        subtotal = base
        tax_amount = subtotal * rate_fraction
        total = subtotal + tax_amount
    else:
        total = base
        tax_amount = total * rate_fraction / (Decimal('1') + rate_fraction)
        subtotal = total - tax_amount

    return {
        'subtotal': _money(subtotal),
        'tax_amount': _money(tax_amount),
        'total': _money(total),
        'tax_type': normalized_type,
        'tax_calculation_method': method,
        'tax_rate': _money(rate),
    }


def _resolve_eis_inventory_item(business: Business, branch, line: dict[str, Any]):
    from inventory.models import InventoryItem

    inventory_item_id = str(
        line.get('inventory_item_id')
        or line.get('inventoryItemId')
        or line.get('inventory_item')
        or ''
    ).strip()
    if inventory_item_id:
        item = InventoryItem.objects.filter(
            id=inventory_item_id,
            business=business,
            branch=branch,
        ).first()
        if item:
            return item

    item_name = str(line.get('name') or '').strip()
    if not item_name:
        return None
    matches = list(InventoryItem.objects.filter(
        business=business,
        branch=branch,
        name__iexact=item_name,
    )[:2])
    return matches[0] if len(matches) == 1 else None


def calculate_eis_tax_snapshot_for_order_lines(
    business: Business,
    branch,
    order_lines: list[dict[str, Any]],
) -> dict[str, Any]:
    """Calculate a fiscal tax snapshot from approved MRA product mappings only.

    The result contains an immutable value for each order line as well as the
    aggregate order snapshot. It deliberately does not consult local TaxRate
    records, because an EIS sale must use MRA configuration as its authority.
    """
    from inventory.models import MRAProductMapping

    line_snapshots: list[dict[str, Any]] = []
    total_net = Decimal('0.00')
    total_tax = Decimal('0.00')
    total_gross = Decimal('0.00')

    for index, line in enumerate(order_lines or []):
        inventory_item = _resolve_eis_inventory_item(business, branch, line)
        label = str(line.get('name') or '').strip() or 'Unknown item'
        if not inventory_item:
            raise ValidationError({
                'items': [f'{label} cannot be matched to an MRA-approved inventory product.']
            })

        mapping = MRAProductMapping.objects.filter(
            inventory_item=inventory_item,
            branch=branch,
            is_approved=True,
            mra_synced=True,
        ).first()
        if not mapping:
            raise ValidationError({
                'items': [f'{inventory_item.name} has no approved, synced MRA product mapping.']
            })

        method = 'exclusive' if str(
            mapping.tax_calculation_method or ''
        ).strip().lower() == 'exclusive' else 'inclusive'
        tax_values = _calculate_eis_line_tax_values(
            _resolve_eis_line_base_amount(line, method),
            mapping.mra_tax_type,
            mapping.mra_tax_rate,
            method,
        )
        tax_values.update({
            'index': index,
            'inventory_item_id': str(inventory_item.id),
            'mra_product_code': mapping.mra_product_code,
            'vat_category': str(mapping.mra_tax_type or '').upper(),
        })
        line_snapshots.append(tax_values)
        total_net += tax_values['subtotal']
        total_tax += tax_values['tax_amount']
        total_gross += tax_values['total']

    types = {str(line['tax_type']) for line in line_snapshots}
    rates = {Decimal(str(line['tax_rate'])) for line in line_snapshots}
    if types == {'zero'}:
        order_tax_type = 'VAT_ZERO'
    elif types == {'exempt'}:
        order_tax_type = 'VAT_EXEMPT'
    else:
        order_tax_type = 'VAT_STANDARD'

    if len(line_snapshots) == 1:
        single_line = line_snapshots[0]
        tax_rate_name = f"MRA {str(single_line['tax_type']).title()} VAT"
        tax_rate_value = single_line['tax_rate']
    else:
        tax_rate_name = 'MRA product tax rules'
        tax_rate_value = next(iter(rates)) if len(rates) == 1 else Decimal('0.00')

    return {
        'tax_rate_name': tax_rate_name,
        'tax_rate_value': _money(tax_rate_value),
        'tax_type': order_tax_type,
        'vat_amount': _money(total_tax),
        'net_amount': _money(total_net),
        'gross_amount': _money(total_gross),
        'line_snapshots': line_snapshots,
    }


def get_default_tax_rate(business: Business) -> Optional[TaxRate]:
    """
    Get the active default tax rate for a business.
    
    Args:
        business: The Business instance
        
    Returns:
        TaxRate instance or None if no default tax rate is set
    """
    return TaxRate.objects.filter(
        business=business,
        is_default=True,
        is_active=True
    ).first()


def calculate_tax_snapshot(
    subtotal: Decimal,
    business: Business,
    tax_rate: Optional[TaxRate] = None
) -> Dict[str, any]:
    """
    Calculate tax snapshot fields for an order.
    
    This function captures the exact tax rules at the time of sale.
    These values are IMMUTABLE and used for audit purposes.
    
    Args:
        subtotal: The order subtotal (before tax)
        business: The Business instance
        tax_rate: Optional TaxRate instance. If None, uses default.
        
    Returns:
        Dictionary with tax snapshot fields:
        {
            'tax_rate_name': str,
            'tax_rate_value': Decimal,
            'tax_type': str,
            'vat_amount': Decimal,
            'net_amount': Decimal,
            'gross_amount': Decimal,
        }
    """
    # If no tax rate provided, get the default
    if tax_rate is None:
        tax_rate = get_default_tax_rate(business)
    
    # Initialize with defaults (no tax)
    tax_snapshot = {
        'tax_rate_name': '',
        'tax_rate_value': Decimal('0.00'),
        'tax_type': 'VAT_EXEMPT',
        'vat_amount': Decimal('0.00'),
        'net_amount': subtotal,
        'gross_amount': subtotal,
    }
    
    # If a tax rate exists, calculate with it
    if tax_rate:
        # Ensure subtotal is Decimal
        subtotal = Decimal(str(subtotal))
        tax_rate_value = Decimal(str(tax_rate.rate))
        
        # Calculate VAT amount
        # VAT = subtotal * (rate / 100)
        vat_amount = subtotal * (tax_rate_value / Decimal('100'))
        
        # Round to 2 decimal places
        vat_amount = vat_amount.quantize(Decimal('0.01'))
        
        # Calculate gross amount
        gross_amount = subtotal + vat_amount
        
        # Update snapshot with actual values
        tax_snapshot = {
            'tax_rate_name': tax_rate.name,
            'tax_rate_value': tax_rate_value,
            'tax_type': tax_rate.tax_type,
            'vat_amount': vat_amount,
            'net_amount': subtotal,
            'gross_amount': gross_amount,
        }
    
    return tax_snapshot


def lock_tax_rate_on_use(tax_rate: Optional[TaxRate]) -> None:
    """
    Lock a tax rate after first use to preserve fiscal immutability.

    Args:
        tax_rate: TaxRate that was used to compute order tax snapshot.
    """
    if not tax_rate or tax_rate.locked:
        return

    TaxRate.objects.filter(pk=tax_rate.pk, locked=False).update(
        locked=True,
        is_dirty=True,
        updated_at=timezone.now(),
    )


def apply_tax_snapshot_to_order(order, tax_snapshot: Dict[str, any]) -> None:
    """
    Apply tax snapshot fields to an Order instance.
    
    Args:
        order: Order instance to update
        tax_snapshot: Dictionary from calculate_tax_snapshot()
    """
    order.tax_rate_name = tax_snapshot['tax_rate_name']
    order.tax_rate_value = tax_snapshot['tax_rate_value']
    order.tax_type = tax_snapshot['tax_type']
    order.vat_amount = tax_snapshot['vat_amount']
    order.net_amount = tax_snapshot['net_amount']
    order.gross_amount = tax_snapshot['gross_amount']


def verify_tax_calculation(
    subtotal: Decimal,
    vat_amount: Decimal,
    gross_amount: Decimal,
    tax_rate_value: Decimal
) -> Tuple[bool, str]:
    """
    Verify that tax calculations are correct.
    
    Used for audit verification to ensure no manipulation occurred.
    
    Args:
        subtotal: Net amount (before tax)
        vat_amount: Calculated VAT amount
        gross_amount: Total amount (including tax)
        tax_rate_value: Tax rate percentage
        
    Returns:
        Tuple of (is_valid: bool, message: str)
    """
    # Convert to Decimal for precision
    subtotal = Decimal(str(subtotal))
    vat_amount = Decimal(str(vat_amount))
    gross_amount = Decimal(str(gross_amount))
    tax_rate_value = Decimal(str(tax_rate_value))
    
    # Check 1: gross_amount = subtotal + vat_amount
    expected_gross = subtotal + vat_amount
    if abs(gross_amount - expected_gross) > Decimal('0.01'):
        return False, f"Gross amount mismatch: {gross_amount} != {expected_gross}"
    
    # Check 2: vat_amount = subtotal * (tax_rate_value / 100)
    expected_vat = (subtotal * (tax_rate_value / Decimal('100'))).quantize(Decimal('0.01'))
    if abs(vat_amount - expected_vat) > Decimal('0.01'):
        return False, f"VAT amount mismatch: {vat_amount} != {expected_vat}"
    
    # Check 3: All amounts are non-negative
    if subtotal < 0 or vat_amount < 0 or gross_amount < 0:
        return False, "Negative amounts detected"
    
    return True, "Tax calculation verified"


def get_tax_summary_for_session(session) -> Dict[str, Decimal]:
    """
    Get tax summary for a session (for reporting).
    
    Args:
        session: Session instance
        
    Returns:
        Dictionary with tax totals:
        {
            'total_net': Decimal,
            'total_vat': Decimal,
            'total_gross': Decimal,
            'by_tax_type': {
                'VAT_STANDARD': {...},
                'VAT_ZERO': {...},
                'VAT_EXEMPT': {...},
            }
        }
    """
    orders = session.orders.all()
    
    total_net = Decimal('0.00')
    total_vat = Decimal('0.00')
    total_gross = Decimal('0.00')
    
    by_tax_type = {
        'VAT_STANDARD': {'net': Decimal('0.00'), 'vat': Decimal('0.00'), 'gross': Decimal('0.00')},
        'VAT_ZERO': {'net': Decimal('0.00'), 'vat': Decimal('0.00'), 'gross': Decimal('0.00')},
        'VAT_EXEMPT': {'net': Decimal('0.00'), 'vat': Decimal('0.00'), 'gross': Decimal('0.00')},
    }
    
    for order in orders:
        net = Decimal(str(order.net_amount or 0))
        vat = Decimal(str(order.vat_amount or 0))
        gross = Decimal(str(order.gross_amount or 0))
        tax_type = order.tax_type or 'VAT_EXEMPT'
        
        total_net += net
        total_vat += vat
        total_gross += gross
        
        if tax_type in by_tax_type:
            by_tax_type[tax_type]['net'] += net
            by_tax_type[tax_type]['vat'] += vat
            by_tax_type[tax_type]['gross'] += gross
    
    return {
        'total_net': total_net,
        'total_vat': total_vat,
        'total_gross': total_gross,
        'by_tax_type': by_tax_type,
    }
