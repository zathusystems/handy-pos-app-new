# Generated migration for inventory models with separated PurchaseOrder and PurchaseOrderItem

import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('business', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Supplier',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=255)),
                ('email', models.EmailField(blank=True, max_length=254)),
                ('phone', models.CharField(blank=True, max_length=32)),
                ('address', models.TextField(blank=True)),
                ('city', models.CharField(blank=True, max_length=100)),
                ('country', models.CharField(blank=True, max_length=100)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='suppliers', to='business.business')),
            ],
            options={
                'ordering': ['-created_at'],
                'unique_together': {('business', 'name')},
            },
        ),
        migrations.CreateModel(
            name='InventoryItem',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=255)),
                ('category', models.CharField(max_length=100)),
                ('item_type', models.CharField(choices=[('ingredient', 'Ingredient'), ('sellable', 'Sellable Product')], max_length=20)),
                ('stock_units', models.DecimalField(decimal_places=3, default=0, max_digits=12)),
                ('unit_type', models.CharField(blank=True, max_length=50)),
                ('reorder_level', models.DecimalField(decimal_places=3, default=0, max_digits=12)),
                ('status', models.CharField(choices=[('In Stock', 'In Stock'), ('Low Stock', 'Low Stock'), ('Out of Stock', 'Out of Stock')], default='In Stock', max_length=20)),
                ('cost', models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True)),
                ('price', models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True)),
                ('value', models.DecimalField(decimal_places=2, default=0, max_digits=12)),
                ('is_variable_price', models.BooleanField(default=False)),
                ('supplier', models.CharField(blank=True, max_length=255)),
                ('manufacturer', models.CharField(blank=True, max_length=255)),
                ('batch', models.CharField(blank=True, max_length=100)),
                ('expiry', models.DateField(blank=True, null=True)),
                ('sku', models.CharField(blank=True, max_length=100)),
                ('barcode', models.CharField(blank=True, max_length=100)),
                ('is_recipe_ingredient', models.BooleanField(default=False)),
                ('brand', models.CharField(blank=True, max_length=255)),
                ('recipe', models.JSONField(blank=True, default=list)),
                ('on_menu', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='inventory_items', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='inventory_items', to='business.business')),
            ],
            options={
                'ordering': ['-created_at'],
                'unique_together': {('business', 'branch', 'name')},
            },
        ),
        migrations.CreateModel(
            name='PurchaseOrder',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('order_number', models.CharField(max_length=100, unique=True)),
                ('status', models.CharField(choices=[('Draft', 'Draft'), ('Pending', 'Pending Approval'), ('Approved', 'Approved'), ('Received', 'Partially/Fully Received'), ('Completed', 'Completed'), ('Cancelled', 'Cancelled')], default='Draft', max_length=20)),
                ('total_items', models.IntegerField(default=0)),
                ('total_cost', models.DecimalField(decimal_places=2, default=0, max_digits=12)),
                ('payment_status', models.CharField(choices=[('Unpaid', 'Unpaid'), ('Partial', 'Partially Paid'), ('Paid', 'Paid')], default='Unpaid', max_length=20)),
                ('amount_paid', models.DecimalField(decimal_places=2, default=0, max_digits=12)),
                ('amount_due', models.DecimalField(decimal_places=2, default=0, max_digits=12)),
                ('notes', models.TextField(blank=True)),
                ('created_by', models.CharField(max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('received_date', models.DateTimeField(blank=True, null=True)),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='purchase_orders', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='purchase_orders', to='business.business')),
                ('supplier', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='purchase_orders', to='inventory.supplier')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='PurchaseOrderItem',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('quantity_ordered', models.DecimalField(decimal_places=3, max_digits=12)),
                ('quantity_received', models.DecimalField(decimal_places=3, default=0, max_digits=12)),
                ('quantity_remaining', models.DecimalField(decimal_places=3, default=0, max_digits=12)),
                ('cost_per_unit', models.DecimalField(decimal_places=2, max_digits=10)),
                ('total_cost', models.DecimalField(decimal_places=2, max_digits=12)),
                ('batch_number', models.CharField(blank=True, max_length=100)),
                ('expiry_date', models.DateField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('inventory_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='purchase_order_items', to='inventory.inventoryitem')),
                ('purchase_order', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='items', to='inventory.purchaseorder')),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
        migrations.CreateModel(
            name='StockTransfer',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('quantity', models.DecimalField(decimal_places=3, max_digits=12)),
                ('initiated_by', models.CharField(max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='stock_transfers', to='business.business')),
                ('from_branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='transfers_out', to='business.branch')),
                ('inventory_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='transfers', to='inventory.inventoryitem')),
                ('to_branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='transfers_in', to='business.branch')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='WasteRecord',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('quantity', models.DecimalField(decimal_places=3, max_digits=12)),
                ('unit', models.CharField(blank=True, max_length=50)),
                ('cost', models.DecimalField(decimal_places=2, max_digits=12)),
                ('reason', models.CharField(choices=[('Expired', 'Expired'), ('Damaged', 'Damaged'), ('Spoilage', 'Spoilage'), ('Error', 'Error'), ('Other', 'Other')], max_length=20)),
                ('notes', models.TextField(blank=True)),
                ('recorded_by', models.CharField(max_length=255)),
                ('recorded_at', models.DateTimeField(auto_now_add=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='waste_records', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='waste_records', to='business.business')),
                ('inventory_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='waste_records', to='inventory.inventoryitem')),
                ('purchase_order_item', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='waste_records', to='inventory.purchaseorderitem')),
            ],
            options={
                'ordering': ['-recorded_at'],
            },
        ),
        migrations.CreateModel(
            name='StockAudit',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('status', models.CharField(choices=[('Pending', 'Pending Approval'), ('Approved', 'Approved'), ('Rejected', 'Rejected')], default='Pending', max_length=20)),
                ('total_discrepancy_value', models.DecimalField(decimal_places=2, default=0, max_digits=12)),
                ('created_by', models.CharField(max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('approved_by', models.CharField(blank=True, max_length=255)),
                ('approved_at', models.DateTimeField(blank=True, null=True)),
                ('notes', models.TextField(blank=True)),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='stock_audits', to='business.branch')),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='stock_audits', to='business.business')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='StockAuditItem',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('system_stock', models.DecimalField(decimal_places=3, max_digits=12)),
                ('counted_stock', models.DecimalField(decimal_places=3, max_digits=12)),
                ('discrepancy', models.DecimalField(decimal_places=3, max_digits=12)),
                ('audit', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='items', to='inventory.stockaudit')),
                ('inventory_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='inventory.inventoryitem')),
            ],
            options={
                'ordering': ['inventory_item__name'],
            },
        ),
        migrations.AddIndex(
            model_name='inventoryitem',
            index=models.Index(fields=['business', 'branch'], name='inventory_i_busines_idx'),
        ),
        migrations.AddIndex(
            model_name='inventoryitem',
            index=models.Index(fields=['status'], name='inventory_i_status_idx'),
        ),
        migrations.AddIndex(
            model_name='inventoryitem',
            index=models.Index(fields=['item_type'], name='inventory_i_item_ty_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseorder',
            index=models.Index(fields=['business', 'branch'], name='inventory_p_busines_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseorder',
            index=models.Index(fields=['supplier'], name='inventory_p_supplie_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseorder',
            index=models.Index(fields=['status'], name='inventory_p_status_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseorderitem',
            index=models.Index(fields=['purchase_order'], name='inventory_p_purchas_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseorderitem',
            index=models.Index(fields=['inventory_item'], name='inventory_p_invento_idx'),
        ),
        migrations.AddIndex(
            model_name='stocktransfer',
            index=models.Index(fields=['from_branch', 'created_at'], name='inventory_s_from_br_idx'),
        ),
        migrations.AddIndex(
            model_name='stocktransfer',
            index=models.Index(fields=['to_branch', 'created_at'], name='inventory_s_to_bran_idx'),
        ),
        migrations.AddIndex(
            model_name='wasterecord',
            index=models.Index(fields=['branch', 'recorded_at'], name='inventory_w_branch__idx'),
        ),
        migrations.AddIndex(
            model_name='wasterecord',
            index=models.Index(fields=['reason'], name='inventory_w_reason_idx'),
        ),
        migrations.AddIndex(
            model_name='stockaudit',
            index=models.Index(fields=['branch', 'status'], name='inventory_s_branch__idx'),
        ),
    ]
