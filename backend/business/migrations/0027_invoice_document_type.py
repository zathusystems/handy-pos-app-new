from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0026_businesssettings_allow_negative_ingredient_stock'),
    ]

    operations = [
        migrations.AddField(
            model_name='invoice',
            name='document_type',
            field=models.CharField(
                choices=[('Invoice', 'Invoice'), ('Quotation', 'Quotation')],
                default='Invoice',
                max_length=20,
            ),
        ),
        migrations.AddIndex(
            model_name='invoice',
            index=models.Index(fields=['business', 'document_type'], name='business_in_busines_b4e52c_idx'),
        ),
    ]
