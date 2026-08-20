import decimal

from django.core.validators import MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0030_inventoryitem_category_optional'),
    ]

    operations = [
        migrations.AddField(
            model_name='inventoryitem',
            name='reserved_stock_units',
            field=models.DecimalField(
                decimal_places=3,
                default=decimal.Decimal('0.000'),
                help_text='Stock currently reserved for laybuy/customer collection orders.',
                max_digits=12,
                validators=[MinValueValidator(decimal.Decimal('0'))],
            ),
        ),
    ]
