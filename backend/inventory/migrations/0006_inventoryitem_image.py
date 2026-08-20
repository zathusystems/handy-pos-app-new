# Generated migration for adding image field to InventoryItem

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0005_supplier_total_amount_due_supplier_total_amount_paid'),
    ]

    operations = [
        migrations.AddField(
            model_name='inventoryitem',
            name='image',
            field=models.TextField(blank=True, null=True),
        ),
    ]
