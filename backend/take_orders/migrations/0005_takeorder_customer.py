# Generated for customer account management phase one

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0022_customer_accounts'),
        ('take_orders', '0004_alter_takeorder_status'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorder',
            name='customer',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='take_orders', to='business.customer'),
        ),
    ]
