# Migration to remove MenuConfig from inventory app

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0010_menuconfig'),
        ('digitalmenu', '0001_initial'),
    ]

    operations = [
        migrations.DeleteModel(
            name='MenuConfig',
        ),
    ]
