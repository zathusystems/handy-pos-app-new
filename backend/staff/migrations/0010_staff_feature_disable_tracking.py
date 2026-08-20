from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('staff', '0009_add_is_fuel_attendant'),
    ]

    operations = [
        migrations.AddField(
            model_name='staff',
            name='disabled_by_feature',
            field=models.CharField(
                blank=True,
                default='',
                help_text='Subscription feature that auto-disabled this staff account, if any.',
                max_length=50,
            ),
        ),
        migrations.AddField(
            model_name='staff',
            name='disabled_by_feature_at',
            field=models.DateTimeField(
                blank=True,
                help_text='When this staff account was auto-disabled by a subscription feature.',
                null=True,
            ),
        ),
    ]
