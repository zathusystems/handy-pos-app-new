from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0017_add_product_types'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='businesssettings',
            name='product_types',
        ),
    ]
