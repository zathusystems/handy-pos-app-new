from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0010_order_buyer_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='session',
            name='pump_name',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
        migrations.AddField(
            model_name='order',
            name='pump_name',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
    ]
