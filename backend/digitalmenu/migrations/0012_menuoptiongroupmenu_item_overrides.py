from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('digitalmenu', '0011_reusable_menu_option_groups'),
    ]

    operations = [
        migrations.AddField(
            model_name='menuoptiongroupmenu',
            name='excluded_option_ids',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Source option IDs hidden only for this menu item.',
            ),
        ),
        migrations.AddField(
            model_name='menuoptiongroupmenu',
            name='option_overrides',
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text='Item-specific snapshots for edited shared options, keyed by source option ID.',
            ),
        ),
    ]
