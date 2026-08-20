# Generated migration for Menu model

from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ('digitalmenu', '0001_initial'),
        ('inventory', '0011_remove_menuconfig'),
        ('business', '0011_add_slugs'),
    ]

    operations = [
        migrations.CreateModel(
            name='Menu',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('added_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='menus', to='business.business')),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='menus', to='business.branch')),
                ('inventory_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='menu_entries', to='inventory.inventoryitem')),
            ],
            options={
                'ordering': ['added_at'],
            },
        ),
        migrations.AddConstraint(
            model_name='menu',
            constraint=models.UniqueConstraint(fields=['branch', 'inventory_item'], name='unique_menu_item_per_branch'),
        ),
        migrations.AddIndex(
            model_name='menu',
            index=models.Index(fields=['business', 'branch'], name='digitalmenu_menu_business_branch_idx'),
        ),
        migrations.AddIndex(
            model_name='menu',
            index=models.Index(fields=['branch', 'inventory_item'], name='digitalmenu_menu_branch_item_idx'),
        ),
    ]
