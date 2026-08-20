# Generated migration for adding related_order_id field to Invoice model

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0001_initial'),  # Adjust this to match your latest migration
    ]

    operations = [
        migrations.AddField(
            model_name='invoice',
            name='related_order_id',
            field=models.CharField(blank=True, help_text='UUID of related POS Order when invoice is marked as Paid', max_length=255, null=True),
        ),
    ]
