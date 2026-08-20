# Generated for session-aware customer collections

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0013_order_payment_method_laybuy'),
        ('business', '0023_customer_laybuy'),
    ]

    operations = [
        migrations.AddField(
            model_name='customeraccounttransaction',
            name='session',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_account_transactions', to='pos_sessions.session'),
        ),
        migrations.AddField(
            model_name='customerlaybuypayment',
            name='session',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuy_payments', to='pos_sessions.session'),
        ),
    ]
