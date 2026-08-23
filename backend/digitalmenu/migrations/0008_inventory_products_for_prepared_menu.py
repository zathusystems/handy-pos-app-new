from decimal import Decimal

from django.db import migrations


def create_inventory_products_for_prepared_items(apps, schema_editor):
    Menu = apps.get_model('digitalmenu', 'Menu')
    InventoryItem = apps.get_model('inventory', 'InventoryItem')

    prepared_items = Menu.objects.filter(
        inventory_item__isnull=True,
        is_prepared_item=True,
    )
    for menu_item in prepared_items.iterator():
        base_name = (menu_item.name or '').strip() or 'Prepared menu item'
        name = base_name
        suffix = 2
        while InventoryItem.objects.filter(
            business_id=menu_item.business_id,
            branch_id=menu_item.branch_id,
            name=name,
        ).exists():
            name = f'{base_name} {suffix}'
            suffix += 1

        inventory_item = InventoryItem.objects.create(
            business_id=menu_item.business_id,
            branch_id=menu_item.branch_id,
            name=name,
            category=menu_item.category or '',
            item_type='sellable',
            stock_units=Decimal('0.000'),
            unit_type='unit',
            reorder_level=Decimal('0.000'),
            cost=Decimal('0.00'),
            price=menu_item.price or Decimal('0.00'),
            is_recipe_ingredient=False,
            is_produced=True,
            recipe=menu_item.recipe or [],
            image=menu_item.image or None,
            on_menu=True,
        )
        menu_item.inventory_item_id = inventory_item.id
        menu_item.is_prepared_item = False
        menu_item.save(update_fields=['inventory_item', 'is_prepared_item', 'updated_at'])


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0031_inventoryitem_reserved_stock_units'),
        ('digitalmenu', '0007_prepared_menu_items'),
    ]

    operations = [
        migrations.RunPython(create_inventory_products_for_prepared_items, migrations.RunPython.noop),
    ]
