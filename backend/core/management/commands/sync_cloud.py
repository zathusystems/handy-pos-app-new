"""
Standalone management command for cloud sync

Can be run from anywhere in the project
"""

from django.core.management.base import BaseCommand
from django.conf import settings
from sync_service import sync_all_to_cloud, get_sync_status


class Command(BaseCommand):
    help = 'Sync all dirty records from all apps to cloud backend'

    def add_arguments(self, parser):
        parser.add_argument(
            '--cloud-url',
            type=str,
            help='Cloud backend URL',
        )
        parser.add_argument(
            '--status',
            action='store_true',
            help='Show sync status without syncing',
        )

    def handle(self, *args, **options):
        cloud_url = options.get('cloud_url') or getattr(settings, 'CLOUD_BACKEND_URL', None)
        
        if not cloud_url:
            self.stdout.write(
                self.style.ERROR('Cloud URL not provided. Set CLOUD_BACKEND_URL in settings or use --cloud-url')
            )
            return
        
        # Show status only
        if options.get('status'):
            status = get_sync_status(cloud_url)
            self.stdout.write(self.style.SUCCESS(f"\n=== Sync Status ==="))
            self.stdout.write(f"Cloud URL: {status['cloud_url']}")
            self.stdout.write(f"Total dirty records: {status['total_dirty']}")
            self.stdout.write(self.style.SUCCESS(f"\n=== Per Model ==="))
            for model_name, model_status in status['models'].items():
                self.stdout.write(f"\n{model_name}:")
                self.stdout.write(f"  Dirty: {model_status['dirty_count']}")
                self.stdout.write(f"  IDs: {model_status['record_ids']}")
            return
        
        # Perform sync
        self.stdout.write(f"Syncing to cloud: {cloud_url}")
        self.stdout.write(self.style.WARNING("\nThis will sync all dirty records from all apps...\n"))
        
        results = sync_all_to_cloud(cloud_url)
        
        self.stdout.write(self.style.SUCCESS(f"\n=== Sync Complete ==="))
        self.stdout.write(f"Total synced: {results['total_synced']}")
        self.stdout.write(f"Total failed: {results['total_failed']}")
        self.stdout.write(f"Total models: {results['total_models']}")
        
        self.stdout.write(self.style.SUCCESS(f"\n=== Per Model ==="))
        for model_name, stats in results['models'].items():
            self.stdout.write(f"\n{model_name}:")
            self.stdout.write(f"  Total: {stats['total']}")
            self.stdout.write(f"  Synced: {stats['synced']}")
            self.stdout.write(f"  Failed: {stats['failed']}")
