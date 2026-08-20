from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='businesssettings',
            name='fuel_pumps',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
