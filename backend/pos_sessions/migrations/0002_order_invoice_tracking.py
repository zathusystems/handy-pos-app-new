# Generated migration for adding invoice tracking fields to Order model

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0001_initial'),  # Adjust this to match your latest migration
    ]

    operations = [
        migrations.AddField(
            model_name='order',
            name='is_invoice_sale',
            field=models.BooleanField(default=False, help_text='Whether this order was created from an invoice'),
        ),
        migrations.AddField(
            model_name='order',
            name='invoice_id',
            field=models.CharField(blank=True, help_text='ID of the related invoice', max_length=255, null=True),
        ),
        migrations.AddField(
            model_name='order',
            name='is_paid',
            field=models.BooleanField(default=False, help_text='Whether the invoice sale has been paid'),
        ),
        migrations.AlterField(
            model_name='order',
            name='order_type',
            field=models.CharField(
                choices=[('sale', 'POS Sale'), ('kitchen', 'Kitchen Preparation'), ('invoice', 'Invoice Sale')],
                default='sale',
                help_text='Distinguish POS sales from kitchen orders and invoice sales',
                max_length=20,
            ),
        ),
    ]
