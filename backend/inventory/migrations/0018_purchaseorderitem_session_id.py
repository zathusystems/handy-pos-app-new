# Generated migration for adding session_id to PurchaseOrderItem

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0017_alter_mraproductmapping_mra_tax_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='purchaseorderitem',
            name='session_id',
            field=models.CharField(
                blank=True,
                help_text='Session ID when stock was received',
                max_length=255,
                null=True
            ),
        ),
        migrations.AddIndex(
            model_name='purchaseorderitem',
            index=models.Index(fields=['session_id'], name='inventory_p_session_idx'),
        ),
    ]
