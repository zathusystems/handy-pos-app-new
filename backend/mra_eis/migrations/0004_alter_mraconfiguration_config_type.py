from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('mra_eis', '0003_terminal_device_identity_and_multiple_per_branch'),
    ]

    operations = [
        migrations.AlterField(
            model_name='mraconfiguration',
            name='config_type',
            field=models.CharField(
                choices=[
                    ('global_configuration', 'MRA Global Configuration'),
                    ('terminal_configuration', 'MRA Terminal Configuration'),
                    ('taxpayer_configuration', 'MRA Taxpayer Configuration'),
                    ('tax_rules', 'Tax Rules'),
                    ('receipt_format', 'Receipt Format'),
                    ('product_codes', 'Product Codes'),
                    ('system_settings', 'System Settings'),
                    ('terminal_site_products', 'MRA Terminal Site Products'),
                ],
                max_length=50,
            ),
        ),
    ]
