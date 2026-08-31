from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('mra_eis', '0002_alter_mrainvoice_unique_together_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='terminal',
            name='mra_taxpayer_id',
            field=models.BigIntegerField(
                blank=True,
                help_text='Numeric taxpayer ID returned by MRA during terminal activation',
                null=True,
            ),
        ),
        migrations.AddField(
            model_name='terminal',
            name='terminal_position',
            field=models.PositiveIntegerField(
                blank=True,
                help_text='Terminal position returned by MRA during terminal activation',
                null=True,
            ),
        ),
        migrations.AlterUniqueTogether(
            name='terminal',
            unique_together=set(),
        ),
        migrations.AddIndex(
            model_name='terminal',
            index=models.Index(
                fields=['business', 'branch', 'device_serial'],
                name='mra_eis_ter_busines_d1fdd0_idx',
            ),
        ),
    ]
