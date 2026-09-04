import django.db.models.deletion
import uuid

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0031_branch_eis_site_mapping'),
    ]

    operations = [
        migrations.CreateModel(
            name='CustomerAccountPaymentAllocation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('order_id', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=12)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('is_dirty', models.BooleanField(default=True)),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_payment_allocations', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='customer_payment_allocations', to='business.business')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_payment_allocations_created', to=settings.AUTH_USER_MODEL)),
                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='payment_allocations', to='business.customer')),
                ('invoice', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='customer_payment_allocations', to='business.invoice')),
                ('payment_transaction', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='allocations', to='business.customeraccounttransaction')),
            ],
            options={'ordering': ['created_at']},
        ),
        migrations.AddConstraint(
            model_name='customeraccountpaymentallocation',
            constraint=models.UniqueConstraint(fields=('payment_transaction', 'invoice'), name='unique_customer_payment_invoice_allocation'),
        ),
        migrations.AddIndex(
            model_name='customeraccountpaymentallocation',
            index=models.Index(fields=['business', 'customer', 'created_at'], name='business_cu_busines_2eecad_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccountpaymentallocation',
            index=models.Index(fields=['invoice'], name='business_cu_invoice_f47953_idx'),
        ),
        migrations.AddIndex(
            model_name='customeraccountpaymentallocation',
            index=models.Index(fields=['is_dirty'], name='business_cu_is_dirt_8d4069_idx'),
        ),
    ]
