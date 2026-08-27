from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('take_orders', '0010_rename_take_orders_complet_37165d_idx_take_orders_complet_559b59_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorder',
            name='is_takeaway',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='takeorderitem',
            name='is_takeaway_packaging',
            field=models.BooleanField(
                default=False,
                help_text='Marks this line as the configured takeaway packaging item.',
            ),
        ),
    ]
