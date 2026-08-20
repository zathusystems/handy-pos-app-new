"""
Management command to create a test Terminal Activation Code (TAC) for testing MRA EIS integration.

Usage:
    python manage.py create_test_tac --business-id <id> --tac-code <code>
    python manage.py create_test_tac  # Uses defaults
"""

from django.core.management.base import BaseCommand
from django.utils import timezone
from datetime import timedelta
from mra_eis.models import TerminalActivationCode
from business.models import Business


class Command(BaseCommand):
    help = 'Create a test Terminal Activation Code (TAC) for MRA EIS testing'

    def add_arguments(self, parser):
        parser.add_argument(
            '--business-id',
            type=int,
            help='Business ID to create TAC for',
        )
        parser.add_argument(
            '--tac-code',
            type=str,
            default='TAC-TEST-001',
            help='TAC code to create (default: TAC-TEST-001)',
        )
        parser.add_argument(
            '--days-valid',
            type=int,
            default=30,
            help='Number of days TAC is valid (default: 30)',
        )

    def handle(self, *args, **options):
        business_id = options.get('business_id')
        tac_code = options.get('tac_code')
        days_valid = options.get('days_valid')

        # If no business ID provided, use the first business
        if not business_id:
            business = Business.objects.first()
            if not business:
                self.stdout.write(
                    self.style.ERROR('No business found. Please create a business first.')
                )
                return
            self.stdout.write(
                self.style.WARNING(f'No business ID provided. Using first business: {business.id} ({business.name})')
            )
        else:
            try:
                business = Business.objects.get(id=business_id)
            except Business.DoesNotExist:
                self.stdout.write(
                    self.style.ERROR(f'Business with ID {business_id} not found.')
                )
                return

        # Check if TAC already exists
        if TerminalActivationCode.objects.filter(code=tac_code).exists():
            self.stdout.write(
                self.style.WARNING(f'TAC code "{tac_code}" already exists.')
            )
            existing_tac = TerminalActivationCode.objects.get(code=tac_code)
            self.stdout.write(f'  Business: {existing_tac.business.name}')
            self.stdout.write(f'  Status: {existing_tac.status}')
            self.stdout.write(f'  Expires: {existing_tac.expires_at}')
            return

        # Create TAC
        expires_at = timezone.now() + timedelta(days=days_valid)
        tac = TerminalActivationCode.objects.create(
            business=business,
            code=tac_code,
            status='unused',
            expires_at=expires_at,
        )

        self.stdout.write(
            self.style.SUCCESS(f'✓ TAC created successfully!')
        )
        self.stdout.write(f'  Code: {tac.code}')
        self.stdout.write(f'  Business: {business.name} (ID: {business.id})')
        self.stdout.write(f'  Status: {tac.status}')
        self.stdout.write(f'  Expires: {tac.expires_at}')
        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('You can now use this TAC to activate a terminal in the frontend.'))
