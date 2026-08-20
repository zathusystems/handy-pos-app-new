from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('staff', '0008_add_assigned_product_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='staff',
            name='is_fuel_attendant',
            field=models.BooleanField(default=False),
        ),
    ]
