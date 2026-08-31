DEFAULT_MENU_CURRENCY = 'MWK'


OPTION_OVERRIDE_FIELDS = (
    'name',
    'description',
    'price_mode',
    'price_delta',
    'price_override',
    'recipe',
    'linked_inventory_item',
    'linked_inventory_quantity',
    'is_default',
    'is_visible',
    'sort_order',
)


def option_assignment_for_menu(group, menu, create=False):
    """Return the assignment that applies a choice group to one menu item."""
    if not group or not menu:
        return None

    from .models import MenuOptionGroupMenu

    assignment = MenuOptionGroupMenu.objects.filter(
        group=group,
        menu=menu,
    ).first()
    if assignment or not create:
        return assignment

    assignment, _ = MenuOptionGroupMenu.objects.get_or_create(
        group=group,
        menu=menu,
    )
    return assignment


def option_snapshot(option):
    """Convert a source option to JSON-safe values for an item override."""
    return {
        'name': option.name,
        'description': option.description,
        'price_mode': option.price_mode,
        'price_delta': str(option.price_delta or 0),
        'price_override': str(option.price_override) if option.price_override is not None else None,
        'recipe': option.recipe if isinstance(option.recipe, list) else [],
        'linked_inventory_item': str(option.linked_inventory_item_id) if option.linked_inventory_item_id else None,
        'linked_inventory_quantity': str(option.linked_inventory_quantity or 0),
        'is_default': bool(option.is_default),
        'is_visible': bool(option.is_visible),
        'sort_order': int(option.sort_order or 0),
    }


def resolve_menu_option(option, menu, include_excluded=False, assignment=None):
    """Return one option as seen by a particular menu item.

    An option-specific override is a complete snapshot. That means an item
    customized locally stays stable when the shared source is edited later.
    Items without an override continue to follow the shared source.
    """
    source_id = str(option.id)
    if assignment is None:
        assignment = option_assignment_for_menu(option.group, menu)
    excluded_ids = set()
    overrides = {}
    if assignment:
        raw_excluded = assignment.excluded_option_ids
        if isinstance(raw_excluded, list):
            excluded_ids = {str(value) for value in raw_excluded}
        if isinstance(assignment.option_overrides, dict):
            overrides = assignment.option_overrides

    if source_id in excluded_ids and not include_excluded:
        return None

    values = option_snapshot(option)
    override = overrides.get(source_id)
    is_overridden = isinstance(override, dict)
    if is_overridden:
        values.update({
            field: override[field]
            for field in OPTION_OVERRIDE_FIELDS
            if field in override
        })

    linked_inventory_item = option.linked_inventory_item
    linked_inventory_item_id = values.get('linked_inventory_item')
    if str(linked_inventory_item_id or '') != str(option.linked_inventory_item_id or ''):
        linked_inventory_item = None
        if linked_inventory_item_id:
            from inventory.models import InventoryItem
            linked_inventory_item = InventoryItem.objects.filter(
                id=linked_inventory_item_id,
                business_id=option.group.menu.business_id,
            ).first()

    return {
        'source': option,
        'values': values,
        'is_overridden': is_overridden,
        'linked_inventory_item': linked_inventory_item,
    }


def resolve_menu_options(group, menu, visible_only=False):
    """Return options for a group as seen by one menu item."""
    assignment = option_assignment_for_menu(group, menu)
    return [
        resolved
        for option in group.options.all()
        if (resolved := resolve_menu_option(option, menu, assignment=assignment)) is not None
        and (not visible_only or resolved['values'].get('is_visible', True))
    ]


def get_takeaway_packaging_price(menu_config):
    """Return the current selling price of the configured packaging item.

    The MenuConfig price is retained as a legacy fallback for configurations
    created before packaging prices were sourced from Inventory.
    """
    packaging_item = getattr(menu_config, 'takeaway_packaging_item', None)
    inventory_price = getattr(packaging_item, 'price', None) if packaging_item else None
    if inventory_price is not None:
        return inventory_price

    return getattr(menu_config, 'takeaway_packaging_price', None) or 0


def get_business_currency(business, fallback=None):
    """Resolve the currency configured for the business."""
    currency = ''

    try:
        settings = getattr(business, 'settings', None)
        currency = getattr(settings, 'currency', '') or ''
    except Exception:
        currency = ''

    normalized = str(currency or fallback or DEFAULT_MENU_CURRENCY).strip().upper()
    return normalized or DEFAULT_MENU_CURRENCY


def sync_menu_config_currency(menu_config, save=True):
    """Keep a menu config aligned with the owning business currency."""
    currency = get_business_currency(
        getattr(menu_config, 'business', None),
        getattr(menu_config, 'currency', None),
    )

    if getattr(menu_config, 'currency', None) != currency:
        menu_config.currency = currency
        if save and getattr(menu_config, 'pk', None):
            menu_config.save(update_fields=['currency', 'updated_at'])

    return currency
