from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0020_merge_0002_add_fuel_pumps_0019_expense_updated_at'),
    ]

    operations = [
        migrations.AlterField(
            model_name='business',
            name='business_type',
            field=models.CharField(
                choices=[
                    ('restaurant', 'Restaurant'),
                    ('grocery', 'Grocery'),
                    ('pharmacy', 'Pharmacy'),
                    ('supermarket', 'Supermarket'),
                    ('bar_liquor', 'Bar & Liquor'),
                    ('beauty_salon', 'Beauty Salon and Spa'),
                    ('clothing', 'Clothing & Fashion'),
                    ('hardware', 'Hardware'),
                    ('generic', 'Generic'),
                ],
                default='generic',
                max_length=50,
            ),
        ),
    ]
