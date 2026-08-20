from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0018_remove_businesssettings_product_types'),
    ]

    operations = [
        migrations.AddField(
            model_name='expense',
            name='updated_at',
            field=models.DateTimeField(auto_now=True),
        ),
    ]
