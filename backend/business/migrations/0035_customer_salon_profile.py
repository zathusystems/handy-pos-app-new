from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0034_businesssettings_customer_bill_payment_accounts'),
    ]

    operations = [
        migrations.AddField(
            model_name='customer',
            name='salon_care_notes',
            field=models.TextField(
                blank=True,
                help_text='Private salon care notes, including reported sensitivities or products to avoid.',
            ),
        ),
        migrations.AddField(
            model_name='customer',
            name='salon_preferences',
            field=models.TextField(
                blank=True,
                help_text='Salon service preferences, such as preferred treatments, colours, or products.',
            ),
        ),
    ]
