from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('inventory', '0010_menuconfig'),
    ]

    operations = [
        migrations.AddField(
            model_name='inventoryitem',
            name='portion_price',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True),
        ),
    ]
