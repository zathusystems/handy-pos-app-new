# Generated migration for removing enable_delivery field

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('subscription', '0013_subscription_enable_multi_branch'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='subscription',
            name='enable_delivery',
        ),
    ]
