from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('mra_eis', '0006_fiscal_invoice_sequence_and_fiscal_identity'),
    ]

    operations = [
        migrations.AlterField(
            model_name='receipt',
            name='receipt_number',
            field=models.CharField(max_length=100),
        ),
    ]
