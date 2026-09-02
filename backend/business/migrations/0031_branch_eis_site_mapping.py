from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0030_rename_business_in_busines_b4e52c_idx_business_in_busines_c8bfc2_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='branch',
            name='eis_mapping_source',
            field=models.CharField(blank=True, help_text='Where the current EIS branch mapping came from', max_length=50),
        ),
        migrations.AddField(
            model_name='branch',
            name='eis_mapping_updated_at',
            field=models.DateTimeField(blank=True, help_text="When this branch's EIS mapping was last updated", null=True),
        ),
        migrations.AddField(
            model_name='branch',
            name='is_eis_warehouse',
            field=models.BooleanField(default=False, help_text='Treat this branch as an EIS warehouse/location for stock transfers'),
        ),
        migrations.AddField(
            model_name='branch',
            name='mra_site_id',
            field=models.CharField(blank=True, help_text='MRA EIS terminal site ID mapped to this branch', max_length=100, null=True),
        ),
        migrations.AddField(
            model_name='branch',
            name='mra_site_name',
            field=models.CharField(blank=True, help_text='MRA EIS terminal site name mapped to this branch', max_length=255),
        ),
        migrations.AddField(
            model_name='branch',
            name='mra_terminal_id',
            field=models.CharField(blank=True, help_text='Last activated MRA terminal ID for this branch', max_length=100),
        ),
        migrations.AddField(
            model_name='branch',
            name='mra_terminal_position',
            field=models.PositiveIntegerField(blank=True, help_text='MRA terminal position returned during activation', null=True),
        ),
        migrations.AddIndex(
            model_name='branch',
            index=models.Index(fields=['mra_site_id'], name='business_br_mra_site_0e4e9a_idx'),
        ),
    ]
