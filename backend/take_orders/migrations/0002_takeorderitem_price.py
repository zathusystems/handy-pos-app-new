# Generated migration for adding price field to TakeOrderItem

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('take_orders', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorderitem',
            name='price',
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
    ]
