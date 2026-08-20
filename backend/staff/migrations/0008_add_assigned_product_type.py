from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('staff', '0007_staff_is_dirty_staff_staff_staff_busines_0b960e_idx_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='staff',
            name='assigned_product_type',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
    ]
