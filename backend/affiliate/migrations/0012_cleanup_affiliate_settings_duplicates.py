from django.db import migrations


def deduplicate_affiliate_settings(apps, schema_editor):
    AffiliateSettings = apps.get_model('affiliate', 'AffiliateSettings')
    queryset = AffiliateSettings.objects.order_by('-updated_at', '-id')
    keep = queryset.first()
    if keep:
        queryset.exclude(id=keep.id).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('affiliate', '0011_alter_affiliate_id_alter_affiliatepayment_id_and_more'),
    ]

    operations = [
        migrations.RunPython(
            deduplicate_affiliate_settings,
            migrations.RunPython.noop,
        ),
    ]
