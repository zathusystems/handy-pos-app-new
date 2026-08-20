# Generated migration for Order model - MRA tax compliance snapshot fields

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='order',
            name='tax_rate_name',
            field=models.CharField(
                blank=True,
                help_text="Name of the tax rate applied (e.g., 'Standard VAT')",
                max_length=100,
            ),
        ),
        migrations.AddField(
            model_name='order',
            name='tax_rate_value',
            field=models.DecimalField(
                decimal_places=2,
                default=0,
                help_text='VAT percentage at time of sale (e.g., 16.50)',
                max_digits=5,
            ),
        ),
        migrations.AddField(
            model_name='order',
            name='tax_type',
            field=models.CharField(
                blank=True,
                choices=[
                    ('VAT_STANDARD', 'VAT Standard Rated'),
                    ('VAT_ZERO', 'VAT Zero Rated'),
                    ('VAT_EXEMPT', 'VAT Exempt'),
                ],
                help_text='VAT classification at time of sale',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='order',
            name='vat_amount',
            field=models.DecimalField(
                decimal_places=2,
                default=0,
                help_text='Calculated VAT amount (for audit verification)',
                max_digits=12,
            ),
        ),
        migrations.AddField(
            model_name='order',
            name='net_amount',
            field=models.DecimalField(
                decimal_places=2,
                default=0,
                help_text='Amount before VAT',
                max_digits=12,
            ),
        ),
        migrations.AddField(
            model_name='order',
            name='gross_amount',
            field=models.DecimalField(
                decimal_places=2,
                default=0,
                help_text='Amount including VAT',
                max_digits=12,
            ),
        ),
    ]
