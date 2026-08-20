from collections import defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.core.exceptions import ValidationError


QUANTITY_QUANT = Decimal('0.001')


def _quantity(value):
    try:
        parsed = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal('0.000')
    if parsed.is_nan() or parsed.is_infinite():
        return Decimal('0.000')
    return parsed.quantize(QUANTITY_QUANT, rounding=ROUND_HALF_UP)


def _clean_text(value):
    return str(value or '').strip()


def _first_non_empty(*values):
    for value in values:
        normalized = _clean_text(value)
        if normalized:
            return normalized
    return ''


def _business_allows_negative_stock(business):
    try:
        return bool(getattr(business.settings, 'allow_negative_ingredient_stock', False))
    except Exception:
        return False


_business_allows_negative_ingredient_stock = _business_allows_negative_stock


def _available_stock_units(inventory_item):
    stock = _quantity(getattr(inventory_item, 'stock_units', Decimal('0.000')))
    reserved = _quantity(getattr(inventory_item, 'reserved_stock_units', Decimal('0.000')))
    return stock - reserved


def _resolve_inventory_item(business, branch, reference, item_name=''):
    from inventory.models import InventoryItem

    ref = _clean_text(reference)
    queryset = InventoryItem.objects.filter(business=business, branch=branch)

    if ref:
        try:
            item = queryset.filter(id=ref).first()
        except (ValueError, TypeError, ValidationError):
            item = None
        if item:
            return item

        item = queryset.filter(sku__iexact=ref).first()
        if item:
            return item

        item = queryset.filter(barcode__iexact=ref).first()
        if item:
            return item

    name = _clean_text(item_name)
    if name:
        matches = list(queryset.filter(name__iexact=name)[:2])
        if len(matches) == 1:
            return matches[0]

    return None


def _line_value(line, *keys):
    if isinstance(line, dict):
        for key in keys:
            if key in line:
                return line.get(key)
        return None

    for key in keys:
        if hasattr(line, key):
            return getattr(line, key)
    return None


def _selected_options_for_line(line):
    selected = _line_value(line, 'selected_options', 'selectedOptions', 'options', 'modifiers')
    if selected is None:
        return []
    if isinstance(selected, dict):
        selected = selected.get('selected_options') or selected.get('selectedOptions') or selected.get('options') or []
    return selected if isinstance(selected, list) else []


def _recipe_entries_for_modifier(option):
    if not isinstance(option, dict):
        return []

    entries = []
    recipe = option.get('recipe') or option.get('stock_recipe') or option.get('stockRecipe') or []
    if isinstance(recipe, list):
        entries.extend(recipe)

    linked_reference = _first_non_empty(
        option.get('linked_inventory_item'),
        option.get('linkedInventoryItem'),
        option.get('linked_inventory_item_id'),
        option.get('linkedInventoryItemId'),
        option.get('inventory_item_id'),
        option.get('inventoryItemId'),
    )
    linked_quantity = _quantity(
        option.get('linked_inventory_quantity')
        or option.get('linkedInventoryQuantity')
        or option.get('stock_quantity')
        or option.get('stockQuantity')
    )
    if linked_reference and linked_quantity > 0:
        entries.append({
            'ingredient_id': linked_reference,
            'name': option.get('linked_inventory_item_name') or option.get('linkedInventoryItemName') or option.get('name'),
            'quantity': linked_quantity,
        })

    return entries


def _modifier_quantity(option):
    if not isinstance(option, dict):
        return Decimal('1.000')
    parsed = _quantity(option.get('quantity') or option.get('selected_quantity') or option.get('selectedQuantity') or 1)
    return parsed if parsed > 0 else Decimal('1.000')


def _register_recipe_entry(targets, missing, business, branch, recipe_item, multiplier, is_recipe_target=True):
    if not isinstance(recipe_item, dict):
        return

    ingredient_reference = _first_non_empty(
        recipe_item.get('ingredientId'),
        recipe_item.get('ingredient_id'),
        recipe_item.get('inventoryItemId'),
        recipe_item.get('inventory_item_id'),
        recipe_item.get('linkedInventoryItemId'),
        recipe_item.get('linked_inventory_item_id'),
        recipe_item.get('id'),
    )
    ingredient_name = _clean_text(recipe_item.get('name'))
    ingredient_quantity = _quantity(recipe_item.get('quantity'))
    if not ingredient_reference or ingredient_quantity <= 0 or multiplier <= 0:
        return

    ingredient_item = _resolve_inventory_item(
        business,
        branch,
        ingredient_reference,
        ingredient_name,
    )
    if not ingredient_item:
        missing.append(ingredient_name or ingredient_reference)
        return

    target = targets[str(ingredient_item.id)]
    target['quantity'] += multiplier * ingredient_quantity
    target['name'] = ingredient_item.name
    target['unit'] = ingredient_item.unit_type or 'units'
    target['is_recipe_target'] = is_recipe_target
    target['inventory_item'] = ingredient_item


def _build_stock_targets(order_lines, business, branch):
    targets = defaultdict(lambda: {
        'quantity': Decimal('0.000'),
        'name': '',
        'unit': '',
        'is_recipe_target': False,
        'inventory_item': None,
    })
    missing = []

    for line in order_lines or []:
        sold_quantity = _quantity(_line_value(line, 'quantity'))
        if sold_quantity <= 0:
            continue

        sold_reference = _first_non_empty(
            _line_value(line, 'inventory_item_id', 'inventoryItemId', 'inventory_item', 'id')
        )
        sold_name = _clean_text(_line_value(line, 'name'))
        line_recipe_entries = _line_value(line, 'recipe', 'stock_recipe', 'stockRecipe') or []
        if not isinstance(line_recipe_entries, list):
            line_recipe_entries = []
        is_prepared_menu_item = bool(_line_value(line, 'is_prepared_menu_item', 'isPreparedMenuItem'))
        sold_item = None if (is_prepared_menu_item and not sold_reference) else _resolve_inventory_item(
            business,
            branch,
            sold_reference,
            sold_name,
        )

        if not sold_item and not line_recipe_entries:
            missing.append(sold_name or sold_reference or 'Unknown item')
            continue

        recipe_entries = (
            line_recipe_entries
            if line_recipe_entries
            else (sold_item.recipe if sold_item and isinstance(sold_item.recipe, list) else [])
        )
        if recipe_entries and (is_prepared_menu_item or not sold_item or sold_item.item_type == 'sellable'):
            for recipe_item in recipe_entries:
                _register_recipe_entry(targets, missing, business, branch, recipe_item, sold_quantity)
        else:
            target = targets[str(sold_item.id)]
            target['quantity'] += sold_quantity
            target['name'] = sold_item.name
            target['unit'] = sold_item.unit_type or 'units'
            target['inventory_item'] = sold_item

        for option in _selected_options_for_line(line):
            option_multiplier = sold_quantity * _modifier_quantity(option)
            for recipe_item in _recipe_entries_for_modifier(option):
                _register_recipe_entry(targets, missing, business, branch, recipe_item, option_multiplier)

    return list(targets.values()), missing


def validate_stock_available_for_order_lines(order_lines, business, branch):
    """
    Validate stock before accepting a sale/order.

    By default, direct purchased/sellable products and recipe ingredients all
    require available stock. If the business allows negative stock, sale/order
    creation can proceed and the decrement path records the shortage as a
    negative stock balance.
    """
    if not business or not branch:
        return

    targets, missing = _build_stock_targets(order_lines, business, branch)
    shortages = []
    allow_negative_stock = _business_allows_negative_stock(business)
    if allow_negative_stock:
        return

    for target in targets:
        inventory_item = target.get('inventory_item')
        if not inventory_item:
            continue

        required = _quantity(target.get('quantity'))
        available = _available_stock_units(inventory_item)
        if required > available:
            shortages.append({
                'item': target.get('name') or getattr(inventory_item, 'name', 'Item'),
                'required': str(required),
                'available': str(max(Decimal('0.000'), available).quantize(QUANTITY_QUANT)),
                'unit': target.get('unit') or 'units',
                'is_recipe_target': bool(target.get('is_recipe_target')),
            })

    if missing or shortages:
        first_shortage = shortages[0] if shortages else None
        if first_shortage:
            message = (
                f"Not enough {first_shortage['item']}. "
                f"Available: {first_shortage['available']} {first_shortage['unit']}, "
                f"required: {first_shortage['required']} {first_shortage['unit']}."
            )
        else:
            message = f"Stock item not found: {missing[0]}."

        raise ValidationError({
            'error': message,
            'stock_shortages': shortages,
            'missing_items': missing,
        })
