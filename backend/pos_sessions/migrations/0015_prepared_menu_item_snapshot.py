from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0014_orderitem_selected_options'),
    ]

    operations = [
        migrations.AlterField(
            model_name='orderitem',
            name='inventory_item_id',
            field=models.CharField(blank=True, max_length=255),
        ),
        migrations.AddField(
            model_name='orderitem',
            name='menu_item_id',
            field=models.CharField(blank=True, default='', max_length=255),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='orderitem',
            name='recipe',
            field=models.JSONField(blank=True, default=list, help_text='Snapshot of menu item recipe for prepared menu-only items.'),
        ),
        migrations.AddField(
            model_name='orderitem',
            name='is_prepared_menu_item',
            field=models.BooleanField(default=False),
        ),
    ]
