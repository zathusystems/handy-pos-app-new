from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('take_orders', '0008_prepared_menu_item_snapshot'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorder',
            name='cancellation_reason',
            field=models.TextField(blank=True, null=True),
        ),
    ]
