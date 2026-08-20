# Generated migration for free trial credits fields

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('subscription', '0009_alter_deposit_payment_method_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='subscription',
            name='free_trial_days',
            field=models.IntegerField(default=30, help_text='Number of days of free trial credits'),
        ),
        migrations.AddField(
            model_name='subscription',
            name='free_trial_credits_applied',
            field=models.BooleanField(default=False, help_text='Whether free trial credits have been applied'),
        ),
        migrations.AddField(
            model_name='subscription',
            name='free_trial_credits_amount',
            field=models.DecimalField(decimal_places=2, default=0.0, help_text='Amount of free trial credits given', max_digits=10),
        ),
        migrations.AddField(
            model_name='subscription',
            name='free_trial_end_date',
            field=models.DateTimeField(blank=True, help_text='Date when free trial credits expire', null=True),
        ),
    ]
