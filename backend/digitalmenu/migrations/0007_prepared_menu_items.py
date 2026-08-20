from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('digitalmenu', '0006_menuoptiongroup_menuoption_and_more'),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name='menu',
            unique_together=set(),
        ),
        migrations.AlterField(
            model_name='menu',
            name='inventory_item',
            field=models.ForeignKey(blank=True, null=True, on_delete=models.deletion.CASCADE, related_name='menu_entries', to='inventory.inventoryitem'),
        ),
        migrations.AddField(
            model_name='menu',
            name='name',
            field=models.CharField(blank=True, default='', max_length=255),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='menu',
            name='category',
            field=models.CharField(blank=True, default='', max_length=120),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='menu',
            name='description',
            field=models.TextField(blank=True, default=''),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='menu',
            name='price',
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddField(
            model_name='menu',
            name='image',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='menu',
            name='recipe',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='menu',
            name='is_prepared_item',
            field=models.BooleanField(default=False),
        ),
        migrations.AddIndex(
            model_name='menu',
            index=models.Index(fields=['branch', 'is_prepared_item'], name='digitalmenu_branch__2ace7e_idx'),
        ),
    ]
