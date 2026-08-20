from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0015_branch_is_dirty_business_is_dirty_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='businesssettings',
            name='block_sales_if_tax_mapping_missing',
            field=models.BooleanField(
                default=False,
                help_text='Block POS sales if items lack approved+synced MRA mappings',
            ),
        ),
    ]
