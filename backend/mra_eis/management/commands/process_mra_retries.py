"""
Management command to process retry queue
"""
from django.core.management.base import BaseCommand
from mra_eis.services import RetryService


class Command(BaseCommand):
    help = 'Process pending retries in the sync retry queue'

    def handle(self, *args, **options):
        self.stdout.write("Processing retry queue...")
        RetryService.process_retry_queue()
        self.stdout.write(self.style.SUCCESS("✓ Retry queue processed"))
