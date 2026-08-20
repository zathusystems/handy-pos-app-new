from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Subscription invoice generation is disabled. Billing uses daily charges only.'

    def add_arguments(self, parser):
        parser.add_argument('--month', type=int, required=False)
        parser.add_argument('--year', type=int, required=False)
        parser.add_argument('--dry-run', action='store_true')

    def handle(self, *args, **options):
        self.stdout.write(
            self.style.WARNING(
                'Subscription invoice generation is disabled. No invoices were created.'
            )
        )
