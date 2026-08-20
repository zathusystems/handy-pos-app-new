from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0026_purchaseorder_reference_vat'),
    ]

    operations = [
        migrations.AddField(
            model_name='purchaseorderitem',
            name='tax_rate',
            field=models.DecimalField(default=Decimal('0'), decimal_places=2, max_digits=5),
        ),
        migrations.AddField(
            model_name='purchaseorderitem',
            name='tax_calculation_method',
            field=models.CharField(
                choices=[('inclusive', 'Inclusive'), ('exclusive', 'Exclusive')],
                default='exclusive',
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name='purchaseorderitem',
            name='tax_amount',
            field=models.DecimalField(default=Decimal('0'), decimal_places=2, max_digits=12),
        ),
    ]
