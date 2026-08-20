from django.db import migrations, models

import subscription.models


class Migration(migrations.Migration):

    dependencies = [
        ('subscription', '0016_deposit_credit_bundle_fields'),
    ]

    operations = [
        migrations.AlterField(
            model_name='subscription',
            name='free_trial_days',
            field=models.IntegerField(
                default=subscription.models.get_default_free_trial_days,
                help_text='Number of days of free trial credits',
            ),
        ),
    ]
