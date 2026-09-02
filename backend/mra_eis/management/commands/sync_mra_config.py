"""
Management command to sync MRA configurations periodically
"""
from django.core.management.base import BaseCommand
from django.utils import timezone
from business.models import Business
from mra_eis.services import ConfigurationService, is_business_eis_enabled


class Command(BaseCommand):
    help = 'Fetch and sync MRA configurations for all businesses'

    def add_arguments(self, parser):
        parser.add_argument(
            '--business-id',
            type=str,
            help='Sync configuration for specific business ID'
        )

    def handle(self, *args, **options):
        business_id = options.get('business_id')

        if business_id:
            businesses = Business.objects.filter(id=business_id)
        else:
            businesses = Business.objects.filter(is_active=True)

        for business in businesses:
            if not is_business_eis_enabled(business):
                self.stdout.write(
                    self.style.WARNING(
                        f'- Skipping {business.name}: MRA EIS is disabled.'
                    )
                )
                continue
            try:
                self.stdout.write(f"Syncing configuration for {business.name}...")
                sync_log = ConfigurationService.fetch_and_store_configuration(business)
                self.stdout.write(
                    self.style.SUCCESS(
                        f"✓ Configuration synced for {business.name} - Status: {sync_log.status}"
                    )
                )
            except Exception as e:
                self.stdout.write(
                    self.style.ERROR(
                        f"✗ Failed to sync configuration for {business.name}: {str(e)}"
                    )
                )
