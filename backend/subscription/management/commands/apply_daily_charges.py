"""
Management command to apply daily charges to all active subscriptions
Run this daily via cron or Celery task
"""
from django.core.management.base import BaseCommand
from django.utils import timezone
from subscription.models import Subscription, SubscriptionStatus
from datetime import datetime


class Command(BaseCommand):
    help = 'Apply daily charges to all active subscriptions'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Run without making changes',
        )

    def handle(self, *args, **options):
        dry_run = options.get('dry_run', False)
        
        # Get all active subscriptions
        subscriptions = Subscription.objects.filter(
            status=SubscriptionStatus.ACTIVE
        )
        
        self.stdout.write(
            self.style.SUCCESS(f'Processing {subscriptions.count()} active subscriptions...')
        )
        
        charged_count = 0
        paused_count = 0
        skipped_count = 0
        errors = []
        
        for subscription in subscriptions:
            try:
                if dry_run:
                    # Dry run - just check what would happen
                    daily_charge = subscription.calculate_daily_charges()
                    
                    # Check if already charged today
                    today = timezone.now().date()
                    if subscription.last_charge_date and subscription.last_charge_date.date() == today:
                        self.stdout.write(
                            self.style.WARNING(
                                f'[DRY RUN] {subscription.business.name}: Already charged today'
                            )
                        )
                        skipped_count += 1
                        continue
                    
                    # Check balance
                    if subscription.account_balance < daily_charge:
                        self.stdout.write(
                            self.style.WARNING(
                                f'[DRY RUN] {subscription.business.name}: Would pause (insufficient balance: {subscription.account_balance} < {daily_charge})'
                            )
                        )
                        paused_count += 1
                    else:
                        self.stdout.write(
                            self.style.SUCCESS(
                                f'[DRY RUN] {subscription.business.name}: Would charge {daily_charge}'
                            )
                        )
                        charged_count += 1
                else:
                    # Actually apply charges
                    success, message = subscription.apply_daily_charges()
                    
                    if success:
                        self.stdout.write(
                            self.style.SUCCESS(f'✓ {subscription.business.name}: {message}')
                        )
                        charged_count += 1
                    else:
                        if 'paused' in message.lower():
                            self.stdout.write(
                                self.style.WARNING(f'⚠ {subscription.business.name}: {message}')
                            )
                            paused_count += 1
                        else:
                            self.stdout.write(
                                self.style.WARNING(f'⚠ {subscription.business.name}: {message}')
                            )
                            skipped_count += 1
                    
                    # Check low balance
                    low_balance, lb_message = subscription.check_low_balance()
                    if low_balance:
                        self.stdout.write(
                            self.style.WARNING(f'  → {lb_message}')
                        )
                    
                    # Check trial expiry
                    trial_expired, te_message = subscription.check_trial_expiry()
                    if trial_expired:
                        self.stdout.write(
                            self.style.WARNING(f'  → {te_message}')
                        )
                        
            except Exception as e:
                error_msg = f'{subscription.business.name}: {str(e)}'
                errors.append(error_msg)
                self.stdout.write(
                    self.style.ERROR(f'✗ {error_msg}')
                )
        
        # Summary
        self.stdout.write(self.style.SUCCESS('\n=== SUMMARY ==='))
        self.stdout.write(f'Charged: {charged_count}')
        self.stdout.write(f'Paused: {paused_count}')
        self.stdout.write(f'Skipped: {skipped_count}')
        
        if errors:
            self.stdout.write(self.style.ERROR(f'Errors: {len(errors)}'))
            for error in errors:
                self.stdout.write(self.style.ERROR(f'  - {error}'))
        
        if dry_run:
            self.stdout.write(self.style.WARNING('\n[DRY RUN MODE] - No changes were made'))
