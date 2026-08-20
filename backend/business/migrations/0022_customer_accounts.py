# Generated for customer account management phase one

import decimal
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('business', '0021_add_clothing_hardware_business_types'),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name='customer',
            unique_together=set(),
        ),
        migrations.AddField(
            model_name='customer',
            name='account_enabled',
            field=models.BooleanField(default=True, help_text='Allow this customer to buy on account/credit.'),
        ),
        migrations.AddField(
            model_name='customer',
            name='credit_limit',
            field=models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), help_text='Maximum allowed unpaid account balance. 0 means no limit.', max_digits=12),
        ),
        migrations.AddField(
            model_name='customer',
            name='current_balance',
            field=models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), help_text='Current amount the customer owes. Negative values mean prepaid credit.', max_digits=12),
        ),
        migrations.AddField(
            model_name='customer',
            name='is_active',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='customer',
            name='notes',
            field=models.TextField(blank=True),
        ),
        migrations.CreateModel(
            name='CustomerAccountTransaction',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('entry_type', models.CharField(choices=[('credit_sale', 'Credit Sale'), ('payment', 'Payment'), ('adjustment', 'Adjustment'), ('refund', 'Refund')], max_length=30)),
                ('direction', models.CharField(choices=[('debit', 'Debit'), ('credit', 'Credit')], max_length=10)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=12)),
                ('balance_after', models.DecimalField(decimal_places=2, max_digits=12)),
                ('order_id', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('invoice_id', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('payment_method', models.CharField(blank=True, max_length=50)),
                ('reference', models.CharField(blank=True, max_length=120)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('is_dirty', models.BooleanField(default=True, help_text='Marks record as dirty (needs syncing). Set to False after successful sync.')),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_account_transactions', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='customer_account_transactions', to='business.business')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_account_transactions_created', to=settings.AUTH_USER_MODEL)),
                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='account_transactions', to='business.customer')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='customer',
            index=models.Index(fields=['business', 'is_active'], name='business_cu_busines_c7d193_idx'),
        ),
        migrations.AddIndex(
            model_name='customer',
            index=models.Index(fields=['business', 'current_balance'], name='business_cu_busines_f2a1f5_idx'),
        ),
        migrations.AddIndex(
            model_name='customer',
            index=models.Index(fields=['business', 'account_enabled'], name='business_cu_busines_0fea9c_idx'),
        ),
        migrations.AddIndex(
            model_name='customer',
            index=models.Index(fields=['phone'], name='business_cu_phone_cae8e5_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccounttransaction',
            index=models.Index(fields=['business', 'created_at'], name='business_cu_busines_0a0584_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccounttransaction',
            index=models.Index(fields=['customer', 'created_at'], name='business_cu_custome_7b1e65_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccounttransaction',
            index=models.Index(fields=['entry_type'], name='business_cu_entry_t_447bf2_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccounttransaction',
            index=models.Index(fields=['direction'], name='business_cu_directi_bbf28a_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccounttransaction',
            index=models.Index(fields=['is_dirty'], name='business_cu_is_dirt_07948e_idx'),
        ),
    ]
