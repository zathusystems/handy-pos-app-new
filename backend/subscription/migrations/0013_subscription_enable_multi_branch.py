# Generated migration for adding enable_multi_branch field

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('subscription', '0012_subscription_enable_usage_limits_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='subscription',
            name='enable_multi_branch',
            field=models.BooleanField(default=True, help_text='Allow managing multiple branches'),
        ),
    ]
