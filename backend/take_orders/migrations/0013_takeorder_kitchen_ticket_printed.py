from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('take_orders', '0012_takeorder_session')]

    operations = [
        migrations.AddField(model_name='takeorder', name='kitchen_ticket_printed', field=models.BooleanField(default=False)),
        migrations.AddField(model_name='takeorder', name='kitchen_ticket_printed_at', field=models.DateTimeField(blank=True, null=True)),
    ]
