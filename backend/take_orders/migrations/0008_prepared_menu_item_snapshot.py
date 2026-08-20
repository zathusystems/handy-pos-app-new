from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('take_orders', '0007_takeorderitem_selected_options'),
    ]

    operations = [
        migrations.AlterField(
            model_name='takeorderitem',
            name='inventory_item_id',
            field=models.CharField(blank=True, max_length=255),
        ),
        migrations.AddField(
            model_name='takeorderitem',
            name='menu_item_id',
            field=models.CharField(blank=True, default='', max_length=255),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='takeorderitem',
            name='recipe',
            field=models.JSONField(blank=True, default=list, help_text='Snapshot of menu item recipe for prepared menu-only items.'),
        ),
        migrations.AddField(
            model_name='takeorderitem',
            name='is_prepared_menu_item',
            field=models.BooleanField(default=False),
        ),
    ]
