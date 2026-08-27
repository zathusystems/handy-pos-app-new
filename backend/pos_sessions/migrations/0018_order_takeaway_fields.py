from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0017_session_total_bank_transfer_sales_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='order',
            name='is_takeaway',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='orderitem',
            name='is_takeaway_packaging',
            field=models.BooleanField(
                default=False,
                help_text='Marks this line as takeaway packaging and forces direct stock deduction.',
            ),
        ),
    ]
