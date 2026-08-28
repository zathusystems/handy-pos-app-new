DEFAULT_MENU_CURRENCY = 'MWK'


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
