import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0031_inventoryitem_reserved_stock_units'),
        ('business', '0024_customer_payment_sessions'),
    ]

    operations = [
        migrations.CreateModel(
            name='CustomerLaybuyReservation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('inventory_item_id_snapshot', models.CharField(blank=True, db_index=True, max_length=255)),
                ('order_item_id', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('item_name', models.CharField(blank=True, max_length=255)),
                ('quantity', models.DecimalField(decimal_places=3, max_digits=12)),
                ('status', models.CharField(choices=[('active', 'Active'), ('fulfilled', 'Fulfilled'), ('released', 'Released')], default='active', max_length=20)),
                ('fulfilled_at', models.DateTimeField(blank=True, null=True)),
                ('released_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('is_dirty', models.BooleanField(default=True, help_text='Marks record as dirty (needs syncing). Set to False after successful sync.')),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='customer_laybuy_reservations', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='customer_laybuy_reservations', to='business.business')),
                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='laybuy_reservations', to='business.customer')),
                ('inventory_item', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='laybuy_reservations', to='inventory.inventoryitem')),
                ('laybuy', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reservations', to='business.customerlaybuy')),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['business', 'status'], name='business_cu_busines_ea20f6_idx'),
                    models.Index(fields=['laybuy', 'status'], name='business_cu_laybuy__35f178_idx'),
                    models.Index(fields=['inventory_item', 'status'], name='business_cu_invento_96269b_idx'),
                    models.Index(fields=['is_dirty'], name='business_cu_is_dirt_0e9961_idx'),
                ],
            },
        ),
    ]
