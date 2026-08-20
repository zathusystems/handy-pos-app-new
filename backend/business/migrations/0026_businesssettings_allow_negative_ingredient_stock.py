from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0025_customer_laybuy_reservations'),
    ]

    operations = [
        migrations.AddField(
            model_name='businesssettings',
            name='allow_negative_ingredient_stock',
            field=models.BooleanField(
                default=False,
                help_text='Allow stock to go below zero when selling products or prepared items.',
            ),
        ),
    ]
