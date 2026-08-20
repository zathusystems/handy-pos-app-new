"""
Tax calculation utilities for MRA compliance

Handles accurate calculation and snapshotting of tax values at the time of sale.
These values are NEVER recalculated - they are immutable for audit purposes.
"""

from decimal import Decimal
from typing import Dict, Optional, Tuple
from django.utils import timezone
from business.models import TaxRate, Business


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
