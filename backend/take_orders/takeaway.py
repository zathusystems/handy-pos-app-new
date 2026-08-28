from decimal import Decimal

from django.core.exceptions import ValidationError

from digitalmenu.models import MenuConfig
from digitalmenu.utils import get_takeaway_packaging_price


def get_takeaway_config(branch):
    """Return the enabled takeaway setup for a branch, if one is configured."""
    return MenuConfig.objects.select_related('takeaway_packaging_item').filter(
        business_id=branch.business_id,
        branch_id=branch.id,
        takeaway_enabled=True,
    ).first()


def _is_truthy(value):
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'on'}
    return bool(value)


def normalise_takeaway_items(items, branch, requested=False, package_already_added=False):
    """Add or normalize the single packaging line used by a takeaway order.

    The packaging item is deliberately kept as a separate line. This lets the
    existing POS stock and FIFO code deduct the packaging item directly even
    when the selected inventory item has a recipe of its own.
    """
    normalized_items = [dict(item) for item in (items or [])]
    is_takeaway = _is_truthy(requested) or any(
        _is_truthy(item.get('is_takeaway_packaging') or item.get('isTakeawayPackaging'))
        for item in normalized_items
    )
    if not is_takeaway:
        return normalized_items, False

    config = get_takeaway_config(branch)
    packaging_item = config.takeaway_packaging_item if config else None
    if not config or not packaging_item:
        raise ValidationError({
            'is_takeaway': 'Takeaway is not configured for this branch. Choose a packaging item in Menu settings first.'
        })

    if package_already_added:
        return [
            item for item in normalized_items
            if not _is_truthy(item.get('is_takeaway_packaging') or item.get('isTakeawayPackaging'))
        ], True

    package_line = {
        'inventory_item_id': str(packaging_item.id),
        'menu_item_id': '',
        'name': packaging_item.name,
        'quantity': Decimal('1'),
        'price': get_takeaway_packaging_price(config),
        'notes': '',
        'recipe': [],
        'is_prepared_menu_item': False,
        'selected_options': [],
        'is_takeaway_packaging': True,
    }

    result = []
    package_added = False
    for item in normalized_items:
        if _is_truthy(item.get('is_takeaway_packaging') or item.get('isTakeawayPackaging')):
            if not package_added:
                result.append(package_line)
                package_added = True
            continue
        result.append(item)

    if not package_added:
        result.append(package_line)

    return result, True
