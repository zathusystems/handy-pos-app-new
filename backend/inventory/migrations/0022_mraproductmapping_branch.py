# Generated migration to add branch field to MRAProductMapping

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0001_initial'),
        ('inventory', '0021_remove_wasterecord_inventory_w_session_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='mraproductmapping',
            name='branch',
            field=models.ForeignKey(
                null=True,
                blank=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='mra_mappings',
                to='business.branch',
                help_text='Branch this mapping belongs to'
            ),
        ),
        migrations.AddIndex(
            model_name='mraproductmapping',
            index=models.Index(fields=['branch', 'is_approved'], name='inventory_m_branch_approved_idx'),
        ),
    ]
