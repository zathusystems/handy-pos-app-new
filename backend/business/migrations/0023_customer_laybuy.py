# Generated for customer laybuy support

import decimal
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('business', '0022_customer_accounts'),
    ]

    operations = [
        migrations.CreateModel(
            name='CustomerLaybuy',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('order_id', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('laybuy_number', models.CharField(blank=True, db_index=True, max_length=40)),
                ('status', models.CharField(choices=[('active', 'Active'), ('ready_for_collection', 'Ready for Collection'), ('completed', 'Completed'), ('cancelled', 'Cancelled')], default='active', max_length=30)),
                ('subtotal', models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), max_digits=12)),
                ('total', models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), max_digits=12)),
                ('deposit_amount', models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), max_digits=12)),
                ('paid_amount', models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), max_digits=12)),
                ('balance_due', models.DecimalField(decimal_places=2, default=decimal.Decimal('0.00'), max_digits=12)),
                ('due_date', models.DateField(blank=True, null=True)),
                ('notes', models.TextField(blank=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('cancelled_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('is_dirty', models.BooleanField(default=True, help_text='Marks record as dirty (needs syncing). Set to False after successful sync.')),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuys', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='customer_laybuys', to='business.business')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuys_created', to=settings.AUTH_USER_MODEL)),
                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='laybuys', to='business.customer')),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['business', 'status'], name='business_cu_busines_8f24db_idx'),
                    models.Index(fields=['customer', 'status'], name='business_cu_custome_a96ec9_idx'),
                    models.Index(fields=['order_id'], name='business_cu_order_i_e573e7_idx'),
                    models.Index(fields=['is_dirty'], name='business_cu_is_dirt_25b0c3_idx'),
                ],
                'constraints': [
                    models.UniqueConstraint(fields=('business', 'laybuy_number'), name='unique_laybuy_number_per_business'),
                ],
            },
        ),
        migrations.CreateModel(
            name='CustomerLaybuyPayment',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=12)),
                ('payment_method', models.CharField(default='Cash', max_length=50)),
                ('reference', models.CharField(blank=True, max_length=120)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('is_dirty', models.BooleanField(default=True, help_text='Marks record as dirty (needs syncing). Set to False after successful sync.')),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuy_payments', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='customer_laybuy_payments', to='business.business')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuy_payments_created', to=settings.AUTH_USER_MODEL)),
                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='laybuy_payments', to='business.customer')),
                ('laybuy', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='payments', to='business.customerlaybuy')),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['laybuy', 'created_at'], name='business_cu_laybuy__4ea533_idx'),
                    models.Index(fields=['customer', 'created_at'], name='business_cu_custome_5610a1_idx'),
                    models.Index(fields=['is_dirty'], name='business_cu_is_dirt_e4587f_idx'),
                ],
            },
        ),
    ]
