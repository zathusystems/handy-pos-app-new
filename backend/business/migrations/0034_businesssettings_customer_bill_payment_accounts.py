# Generated manually for the customer bill payment instructions feature.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0033_businesscharge_application_rule'),
    ]

    operations = [
        migrations.AddField(
            model_name='businesssettings',
            name='customer_bill_payment_accounts',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text=(
                    'Payment instructions shown on customer bills before payment, '
                    'such as mobile money numbers or bank account details.'
                ),
            ),
        ),
    ]
