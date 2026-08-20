from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('take_orders', '0005_takeorder_customer'),
    ]

    operations = [
        migrations.AddField(
            model_name='takeorder',
            name='completed_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='take_orders_completed', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddIndex(
            model_name='takeorder',
            index=models.Index(fields=['completed_by'], name='take_orders_complet_37165d_idx'),
        ),
    ]
