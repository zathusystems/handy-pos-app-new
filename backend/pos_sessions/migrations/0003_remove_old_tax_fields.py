# Generated migration for Order model - Remove old tax and tip fields

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0002_order_mra_tax_snapshot'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='order',
            name='tax',
        ),
        migrations.RemoveField(
            model_name='order',
            name='tip',
        ),
    ]
