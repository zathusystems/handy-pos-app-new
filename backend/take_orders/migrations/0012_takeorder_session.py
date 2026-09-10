from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0019_order_eis_special_sale_fields'),
        ('take_orders', '0011_takeaway_order_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorder',
            name='session',
            field=models.ForeignKey(
                blank=True,
                help_text='Active staff session that created this order. Self-service orders do not use a session.',
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name='take_orders',
                to='pos_sessions.session',
            ),
        ),
        migrations.AddIndex(
            model_name='takeorder',
            index=models.Index(fields=['session', 'status'], name='take_orders_session_5b0a6c_idx'),
        ),
    ]
