from django.shortcuts import render, get_object_or_404
from django.views.decorators.http import require_http_methods
from business.models import Business, Branch
from .models import Menu, MenuConfig
from .utils import get_business_currency, get_takeaway_packaging_price, sync_menu_config_currency
from inventory.models import InventoryItem


@require_http_methods(["GET"])
def public_menu_view(request, business_slug, branch_slug):
    """
    Public menu view accessible at /{business_slug}/{branch_slug}
    """
    # Get business and branch
    business = get_object_or_404(Business, slug=business_slug)
    branch = get_object_or_404(Branch, slug=branch_slug, business=business)
    
    # Get menu config
    menu_config = MenuConfig.objects.filter(
        business=business,
        branch=branch
    ).first()
    
    if not menu_config:
        menu_config = MenuConfig.objects.create(
            business=business,
            branch=branch,
            currency=get_business_currency(business)
        )
    else:
        sync_menu_config_currency(menu_config)
    
    # Get menu items
    menu_items = Menu.objects.filter(
        business=business,
        branch=branch,
        is_visible=True
    ).select_related('inventory_item').prefetch_related('option_groups__options')

    menu_items_data = []
    for menu_item in menu_items:
        option_groups = []
        for group in menu_item.option_groups.filter(is_visible=True):
            options = []
            for option in group.options.filter(is_visible=True):
                options.append({
                    'id': str(option.id),
                    'name': option.name,
                    'description': option.description,
                    'price_mode': option.price_mode,
                    'price_delta': float(option.price_delta or 0),
                    'price_override': float(option.price_override) if option.price_override is not None else None,
                    'recipe': option.recipe or [],
                    'linked_inventory_item': str(option.linked_inventory_item_id) if option.linked_inventory_item_id else None,
                    'linked_inventory_item_name': option.linked_inventory_item.name if option.linked_inventory_item else '',
                    'linked_inventory_quantity': float(option.linked_inventory_quantity or 0),
                    'is_default': option.is_default,
                    'sort_order': option.sort_order,
                })
            option_groups.append({
                'id': str(group.id),
                'name': group.name,
                'group_type': group.group_type,
                'is_required': group.is_required,
                'min_select': group.min_select,
                'max_select': group.max_select,
                'sort_order': group.sort_order,
                'options': options,
                })
        option_names = [
            option['name']
            for group in option_groups
            for option in group['options']
            if option.get('name')
        ]
        # The template uses these lightweight attributes for a compact card preview;
        # the complete option data remains in the JSON payload for the detail modal.
        menu_item.option_preview = option_names[:3]
        menu_item.option_preview_count = len(option_names)
        menu_items_data.append({
            'id': str(menu_item.inventory_item_id or menu_item.id),
            'menu_id': str(menu_item.id),
            'inventory_item_id': str(menu_item.inventory_item_id) if menu_item.inventory_item_id else '',
            'is_prepared_menu_item': bool(menu_item.is_prepared_item or not menu_item.inventory_item_id),
            'name': menu_item.display_name,
            'category': menu_item.display_category or 'Uncategorized',
            'price': float(menu_item.display_price or 0),
            'image': menu_item.display_image or '',
            'description': menu_item.description or '',
            'recipe': menu_item.display_recipe,
            'unit_type': menu_item.inventory_item.unit_type if menu_item.inventory_item else '',
            'is_sold_in_portions': bool(
                menu_item.inventory_item
                and menu_item.inventory_item.is_sold_in_portions
                and menu_item.inventory_item.portions_per_unit
                and menu_item.inventory_item.portions_per_unit > 0
            ),
            'portion_name': menu_item.inventory_item.portion_name if menu_item.inventory_item else '',
            'portions_per_unit': float(menu_item.inventory_item.portions_per_unit or 0) if menu_item.inventory_item else 0,
            'portion_price': float(menu_item.inventory_item.portion_price or 0) if menu_item.inventory_item else 0,
            'option_groups': option_groups,
        })
    
    # Group by category
    categories = {}
    for menu_item in menu_items:
        category = menu_item.display_category or 'Uncategorized'
        if category not in categories:
            categories[category] = []
        categories[category].append(menu_item)
    
    context = {
        'business': business,
        'branch': branch,
        'menu_config': menu_config,
        'takeaway_config': {
            'enabled': bool(menu_config.takeaway_enabled and menu_config.takeaway_packaging_item_id),
            'packaging_item_id': str(menu_config.takeaway_packaging_item_id or ''),
            'packaging_name': menu_config.takeaway_packaging_item.name if menu_config.takeaway_packaging_item else '',
            'price': float(get_takeaway_packaging_price(menu_config)),
        },
        'categories': categories,
        'menu_items': menu_items,
        'menu_items_data': menu_items_data,
    }
    
    return render(request, 'digitalmenu/public_menu.html', context)
