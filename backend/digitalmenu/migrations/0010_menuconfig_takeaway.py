from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('digitalmenu', '0009_rename_digitalmenu_branch__2ace7e_idx_digitalmenu_branch__7b6529_idx'),
        ('inventory', '0032_inventoryitem_custom_sales_section'),
    ]

    operations = [
        migrations.AddField(
            model_name='menuconfig',
            name='takeaway_enabled',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='menuconfig',
            name='takeaway_packaging_item',
            field=models.ForeignKey(
                blank=True,
                help_text='Inventory item used for takeaway packaging when takeaway is selected.',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='takeaway_menu_configs',
                to='inventory.inventoryitem',
            ),
        ),
        migrations.AddField(
            model_name='menuconfig',
            name='takeaway_packaging_price',
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
    ]
