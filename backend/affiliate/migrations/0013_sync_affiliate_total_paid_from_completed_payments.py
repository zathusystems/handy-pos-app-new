from django.db import migrations
from django.db.models import Sum


def sync_affiliate_total_paid(apps, schema_editor):
    Affiliate = apps.get_model('affiliate', 'Affiliate')
    AffiliatePayment = apps.get_model('affiliate', 'AffiliatePayment')

    for affiliate in Affiliate.objects.all().iterator():
        total_paid = (
            AffiliatePayment.objects
            .filter(affiliate_id=affiliate.id, status='completed')
            .aggregate(total=Sum('amount'))
            .get('total')
            or 0
        )
        affiliate.total_paid = total_paid
        affiliate.save(update_fields=['total_paid'])


class Migration(migrations.Migration):

    dependencies = [
        ('affiliate', '0012_cleanup_affiliate_settings_duplicates'),
    ]

    operations = [
        migrations.RunPython(
            sync_affiliate_total_paid,
            migrations.RunPython.noop,
        ),
    ]
