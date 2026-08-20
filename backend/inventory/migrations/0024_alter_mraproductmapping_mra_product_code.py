from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0023_remove_mraproductmapping_inventory_m_branch_approved_idx'),
    ]

    operations = [
        migrations.AlterField(
            model_name='mraproductmapping',
            name='mra_product_code',
            field=models.CharField(
                help_text='MRA-assigned product code',
                max_length=100,
            ),
        ),
    ]

