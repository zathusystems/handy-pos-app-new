from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0027_purchaseorderitem_tax_fields'),
    ]

    operations = [
        migrations.AlterField(
            model_name='mraproductmapping',
            name='mra_product_code',
            field=models.CharField(
                help_text='MRA-assigned product code',
                max_length=100,
                null=True,
                blank=True,
            ),
        ),
        migrations.AlterField(
            model_name='mraproductmapping',
            name='mra_product_name',
            field=models.CharField(
                help_text='MRA-approved product name',
                max_length=255,
                null=True,
                blank=True,
            ),
        ),
    ]
