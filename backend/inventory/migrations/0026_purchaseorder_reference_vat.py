from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0025_inventoryitem_is_fuel'),
    ]

    operations = [
        migrations.AddField(
            model_name='purchaseorder',
            name='reference_number',
            field=models.CharField(
                blank=True,
                help_text='Supplier invoice or reference number',
                max_length=100,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name='purchaseorder',
            name='vat_amount',
            field=models.DecimalField(
                blank=True,
                decimal_places=2,
                help_text='VAT amount for this purchase',
                max_digits=12,
                null=True,
            ),
        ),
    ]

