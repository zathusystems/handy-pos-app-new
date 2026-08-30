from django.db import migrations, models
import django.db.models.deletion
import uuid


def create_existing_group_assignments(apps, schema_editor):
    MenuOptionGroup = apps.get_model('digitalmenu', 'MenuOptionGroup')
    MenuOptionGroupMenu = apps.get_model('digitalmenu', 'MenuOptionGroupMenu')

    assignments = [
        MenuOptionGroupMenu(group_id=group.id, menu_id=group.menu_id)
        for group in MenuOptionGroup.objects.exclude(menu_id__isnull=True).iterator()
    ]
    if assignments:
        MenuOptionGroupMenu.objects.bulk_create(assignments, ignore_conflicts=True)


class Migration(migrations.Migration):

    dependencies = [
        ('digitalmenu', '0010_menuconfig_takeaway'),
    ]

    operations = [
        migrations.AddField(
            model_name='menuoptiongroup',
            name='is_shared',
            field=models.BooleanField(
                default=False,
                help_text='Make this choice set available on multiple menu items.',
            ),
        ),
        migrations.CreateModel(
            name='MenuOptionGroupMenu',
            fields=[
                (
                    'id',
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                (
                    'group',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='menu_assignments',
                        to='digitalmenu.menuoptiongroup',
                    ),
                ),
                (
                    'menu',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='option_group_assignments',
                        to='digitalmenu.menu',
                    ),
                ),
            ],
            options={
                'constraints': [
                    models.UniqueConstraint(
                        fields=('group', 'menu'),
                        name='unique_menu_option_group_menu',
                    ),
                ],
                'indexes': [
                    models.Index(fields=['menu', 'group'], name='digitalmenu_menu_id_7e7bbc_idx'),
                ],
            },
        ),
        migrations.AddIndex(
            model_name='menuoptiongroup',
            index=models.Index(fields=['menu', 'is_shared'], name='digitalmenu_menu_id_34e895_idx'),
        ),
        migrations.RunPython(create_existing_group_assignments, migrations.RunPython.noop),
    ]
