from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0024_alter_mraproductmapping_mra_product_code'),
    ]

    operations = [
        migrations.AddField(
            model_name='inventoryitem',
            name='is_fuel',
            field=models.BooleanField(default=False),
        ),
    ]
