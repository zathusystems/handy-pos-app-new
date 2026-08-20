from django.db import migrations, models

import payments.validators


class Migration(migrations.Migration):

    dependencies = [
        ('payments', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='paymentgatewayconfiguration',
            name='callback_url',
            field=models.CharField(
                blank=True,
                help_text='Success callback URL sent to PayChangu when generating hosted checkout.',
                max_length=500,
                validators=[payments.validators.validate_redirect_url],
            ),
        ),
        migrations.AlterField(
            model_name='paymentgatewayconfiguration',
            name='return_url',
            field=models.CharField(
                blank=True,
                help_text='Return URL used when the customer cancels or payment ultimately fails.',
                max_length=500,
                validators=[payments.validators.validate_redirect_url],
            ),
        ),
    ]
