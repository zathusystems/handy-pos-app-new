from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0016_businesssettings_block_sales_if_tax_mapping_missing'),
    ]

    operations = [
        migrations.AddField(
            model_name='businesssettings',
            name='product_types',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
