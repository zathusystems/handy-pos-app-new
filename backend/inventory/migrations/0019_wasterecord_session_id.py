# Generated migration for adding session_id to WasteRecord

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0018_purchaseorderitem_session_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='wasterecord',
            name='session_id',
            field=models.CharField(
                blank=True,
                help_text='Session ID when waste was recorded',
                max_length=255,
                null=True
            ),
        ),
        migrations.AddIndex(
            model_name='wasterecord',
            index=models.Index(fields=['session_id'], name='inventory_w_session_idx'),
        ),
    ]
