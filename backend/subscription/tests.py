from decimal import Decimal
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase, APIRequestFactory, force_authenticate

from accounts.models import User
from business.models import Branch, Business
from staff.models import Staff, StaffRole
from system_config.models import SystemConfig
from payments.models import SubscriptionPaymentAttempt
from subscription.models import (
    Deposit,
    DepositStatus,
    FeaturePricing,
    Invoice,
    Subscription,
    SubscriptionFeature,
)
from subscription.utils import process_invoice_payment
from subscription.views import SubscriptionFeatureViewSet, SubscriptionViewSet


class SubscriptionModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email='owner@example.com', password='testpass123')
        self.business = Business.objects.create(owner=self.user, name='Model Biz', country='USA')
        self.subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('100.00'),
            free_trial_credits_applied=True,
            free_trial_end_date=timezone.now() - timedelta(days=1),
        )
        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('5.00')
        config.enable_feature_pricing = True
        config.trial_days = 21
        config.save()

    def test_deduct_credit_allows_paid_balance_after_trial_expiry(self):
        deducted = self.subscription.deduct_credit(Decimal('10.00'))
        self.subscription.refresh_from_db()

        self.assertTrue(deducted)
        self.assertEqual(self.subscription.account_balance, Decimal('90.00'))

    def test_apply_daily_charges_works_after_trial_expiry(self):
        success, message = self.subscription.apply_daily_charges()
        self.subscription.refresh_from_db()

        self.assertTrue(success, message)
        self.assertEqual(self.subscription.account_balance, Decimal('95.00'))
        self.assertEqual(self.subscription.total_spent, Decimal('5.00'))
        self.assertIsNotNone(self.subscription.last_charge_date)

    def test_complete_deposit_uses_credited_amount_when_present(self):
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('85.50'),
            credited_amount=Decimal('90.00'),
            funding_period='quarterly',
            payment_method='manual',
            transaction_id='BUNDLE-001',
            payment_proof='BUNDLE-001',
        )

        completed = deposit.complete_deposit()
        self.subscription.refresh_from_db()
        deposit.refresh_from_db()

        self.assertTrue(completed)
        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertEqual(self.subscription.account_balance, Decimal('190.00'))

    def test_complete_deposit_during_trial_keeps_trial_end_date(self):
        trial_end_date = timezone.now() + timedelta(days=7)
        self.subscription.free_trial_end_date = trial_end_date
        self.subscription.account_balance = Decimal('100.00')
        self.subscription.save(update_fields=['free_trial_end_date', 'account_balance', 'updated_at'])
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('50.00'),
            payment_method='manual',
            transaction_id='TRIAL-TOPUP-001',
            payment_proof='TRIAL-TOPUP-001',
        )

        completed = deposit.complete_deposit()
        self.subscription.refresh_from_db()

        self.assertTrue(completed)
        self.assertTrue(self.subscription.is_free_trial_active())
        self.assertEqual(self.subscription.free_trial_end_date, trial_end_date)
        self.assertEqual(self.subscription.account_balance, Decimal('150.00'))

    def test_add_credit_does_not_auto_resume_paused_subscription(self):
        self.subscription.status = 'paused'
        self.subscription.account_balance = Decimal('0.00')
        self.subscription.save(update_fields=['status', 'account_balance', 'updated_at'])

        self.subscription.add_credit(Decimal('5.00'))
        self.subscription.refresh_from_db()

        self.assertEqual(self.subscription.status, 'paused')
        self.assertEqual(self.subscription.account_balance, Decimal('5.00'))
        self.assertIsNotNone(self.subscription.last_payment_date)

    def test_complete_deposit_auto_resumes_paused_subscription_when_credit_is_sufficient(self):
        self.subscription.status = 'paused'
        self.subscription.account_balance = Decimal('0.00')
        self.subscription.save(update_fields=['status', 'account_balance', 'updated_at'])

        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('10.00'),
            payment_method='manual',
            transaction_id='AUTO-RESUME-001',
            payment_proof='AUTO-RESUME-001',
        )

        completed = deposit.complete_deposit()
        self.subscription.refresh_from_db()
        deposit.refresh_from_db()

        self.assertTrue(completed)
        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertEqual(self.subscription.status, 'active')
        self.assertEqual(self.subscription.account_balance, Decimal('10.00'))

    def test_complete_deposit_keeps_subscription_paused_when_credit_is_insufficient(self):
        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('15.00')
        config.save()

        self.subscription.status = 'paused'
        self.subscription.account_balance = Decimal('0.00')
        self.subscription.save(update_fields=['status', 'account_balance', 'updated_at'])

        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('10.00'),
            payment_method='manual',
            transaction_id='AUTO-RESUME-002',
            payment_proof='AUTO-RESUME-002',
        )

        completed = deposit.complete_deposit()
        self.subscription.refresh_from_db()
        deposit.refresh_from_db()

        self.assertTrue(completed)
        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertEqual(self.subscription.status, 'paused')
        self.assertEqual(self.subscription.account_balance, Decimal('10.00'))

    def test_process_invoice_payment_returns_false_when_invoicing_disabled(self):
        invoice = Invoice.objects.create(
            subscription=self.subscription,
            invoice_number='INV-IDEMPOTENT-1',
            amount=Decimal('20.00'),
            status='sent',
            billing_period_start=timezone.now() - timedelta(days=30),
            billing_period_end=timezone.now(),
            due_date=timezone.now() + timedelta(days=7),
        )

        first = process_invoice_payment(invoice)
        self.subscription.refresh_from_db()
        invoice.refresh_from_db()

        self.assertFalse(first)
        self.assertEqual(self.subscription.account_balance, Decimal('100.00'))
        self.assertEqual(invoice.status, 'sent')
        self.assertEqual(self.subscription.usage_charges.count(), 0)

    def test_deactivate_non_owner_staff_disables_staff_records_and_user_accounts(self):
        owner_staff = Staff.objects.create(
            business=self.business,
            user=self.user,
            name='Owner Admin',
            email='owner@example.com',
            role=StaffRole.ADMIN,
            is_active=True,
        )
        staff_user = User.objects.create_user(
            email='cashier-disable@example.com',
            password='testpass123',
        )
        staff_member = Staff.objects.create(
            business=self.business,
            user=staff_user,
            name='Cashier To Disable',
            email='cashier-disable@example.com',
            role=StaffRole.CASHIER,
            is_active=True,
        )

        deactivated_count = self.subscription.deactivate_non_owner_staff()

        owner_staff.refresh_from_db()
        staff_member.refresh_from_db()
        staff_user.refresh_from_db()
        self.user.refresh_from_db()

        self.assertEqual(deactivated_count, 1)
        self.assertTrue(owner_staff.is_active)
        self.assertTrue(self.user.is_active)
        self.assertFalse(staff_member.is_active)
        self.assertFalse(staff_user.is_active)

    def test_reactivate_staff_management_restores_only_feature_disabled_staff(self):
        auto_disabled_user = User.objects.create_user(
            email='cashier-reactivate@example.com',
            password='testpass123',
            is_active=False,
        )
        auto_disabled_staff = Staff.objects.create(
            business=self.business,
            user=auto_disabled_user,
            name='Cashier To Restore',
            email='cashier-reactivate@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
            disabled_by_feature='staff_management',
            disabled_by_feature_at=timezone.now(),
        )
        manually_disabled_user = User.objects.create_user(
            email='cashier-manual@example.com',
            password='testpass123',
            is_active=False,
        )
        manually_disabled_staff = Staff.objects.create(
            business=self.business,
            user=manually_disabled_user,
            name='Cashier Stay Disabled',
            email='cashier-manual@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
        )

        reactivated_count = self.subscription.handle_enabled_feature_side_effects('staff_management')

        auto_disabled_staff.refresh_from_db()
        auto_disabled_user.refresh_from_db()
        manually_disabled_staff.refresh_from_db()
        manually_disabled_user.refresh_from_db()

        self.assertEqual(reactivated_count, 1)
        self.assertTrue(auto_disabled_staff.is_active)
        self.assertTrue(auto_disabled_user.is_active)
        self.assertEqual(auto_disabled_staff.disabled_by_feature, '')
        self.assertIsNone(auto_disabled_staff.disabled_by_feature_at)
        self.assertFalse(manually_disabled_staff.is_active)
        self.assertFalse(manually_disabled_user.is_active)


class SubscriptionAdminTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(
            email='admin@example.com',
            password='testpass123',
        )
        owner = User.objects.create_user(email='admin-owner@example.com', password='testpass123')
        business = Business.objects.create(owner=owner, name='Admin Test Biz', country='USA')
        self.subscription = Subscription.objects.create(
            business=business,
            status='active',
            account_balance=Decimal('25.00'),
        )

    def test_subscription_changelist_renders(self):
        self.client.force_login(self.admin_user)
        response = self.client.get('/admin/subscription/subscription/')
        self.assertEqual(response.status_code, 200)

    def test_admin_can_add_subscription_credits_immediately(self):
        self.client.force_login(self.admin_user)

        response = self.client.post(
            '/admin/subscription/deposit/add/',
            {
                'subscription': self.subscription.id,
                'amount': '70.00',
                'credited_amount': '75.00',
                'funding_period': '',
                'apply_immediately': 'on',
                'payment_method': 'manual',
                'transaction_id': 'SUPPORT-CREDIT-001',
                'payment_proof': 'Support fallback credit',
                'notes': 'Self credit top-up failed.',
            },
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        deposit = Deposit.objects.get(transaction_id='SUPPORT-CREDIT-001')
        self.subscription.refresh_from_db()

        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertIsNotNone(deposit.completed_date)
        self.assertEqual(deposit.amount, Decimal('70.00'))
        self.assertEqual(deposit.credited_amount, Decimal('75.00'))
        self.assertEqual(self.subscription.account_balance, Decimal('100.00'))

    def test_admin_can_save_manual_credit_as_pending(self):
        self.client.force_login(self.admin_user)

        response = self.client.post(
            '/admin/subscription/deposit/add/',
            {
                'subscription': self.subscription.id,
                'amount': '40.00',
                'credited_amount': '',
                'funding_period': '',
                'payment_method': 'manual',
                'transaction_id': 'SUPPORT-CREDIT-PENDING',
                'payment_proof': 'Waiting for confirmation',
                'notes': 'Do not apply yet.',
            },
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        deposit = Deposit.objects.get(transaction_id='SUPPORT-CREDIT-PENDING')
        self.subscription.refresh_from_db()

        self.assertEqual(deposit.status, DepositStatus.PENDING)
        self.assertIsNone(deposit.completed_date)
        self.assertEqual(self.subscription.account_balance, Decimal('25.00'))


class SubscriptionApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='api-owner@example.com', password='testpass123')
        self.other_user = User.objects.create_user(email='other@example.com', password='testpass123')
        self.business = Business.objects.create(owner=self.owner, name='Owner Biz', country='USA')
        self.business_two = Business.objects.create(owner=self.owner, name='Owner Biz Two', country='USA')
        self.other_business = Business.objects.create(owner=self.other_user, name='Other Biz', country='USA')
        self.client.force_authenticate(user=self.owner)
        self.factory = APIRequestFactory()

        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('5.00')
        config.enable_feature_pricing = True
        config.trial_days = 21
        config.save()

    def test_create_subscription_rejects_business_not_owned_by_user(self):
        response = self.client.post(
            '/api/subscription/subscriptions/',
            {'business': self.other_business.id},
            format='json',
        )
        self.assertEqual(response.status_code, 403)

    def test_create_subscription_seeds_subscription_features_from_flags(self):
        feature_pos = FeaturePricing.objects.create(feature='pos', price_per_day=Decimal('1.00'), is_active=True)
        feature_inventory = FeaturePricing.objects.create(
            feature='inventory',
            price_per_day=Decimal('2.00'),
            is_active=True,
        )

        response = self.client.post(
            '/api/subscription/subscriptions/',
            {'business': self.business.id},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.data)

        subscription = Subscription.objects.get(business=self.business)
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription, feature=feature_pos, enabled=True
            ).exists()
        )
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription, feature=feature_inventory, enabled=True
            ).exists()
        )

    def test_trial_preview_matches_created_subscription_credits(self):
        FeaturePricing.objects.create(feature='pos', price_per_day=Decimal('1.00'), is_active=True)
        FeaturePricing.objects.create(feature='inventory', price_per_day=Decimal('2.00'), is_active=True)
        expected_credits = Decimal('168.00')  # (base 5 + features 3) * 21 days

        preview_response = self.client.get(
            '/api/subscription/subscriptions/trial-preview/',
            {'business': self.business.id},
        )
        self.assertEqual(preview_response.status_code, 200, preview_response.data)
        self.assertEqual(preview_response.data['free_trial_days'], 21)
        self.assertEqual(
            Decimal(str(preview_response.data['free_trial_credits_amount'])),
            expected_credits,
        )

        create_response = self.client.post(
            '/api/subscription/subscriptions/',
            {'business': self.business.id},
            format='json',
        )
        self.assertEqual(create_response.status_code, 201, create_response.data)
        self.assertEqual(
            Decimal(str(create_response.data['free_trial_credits_amount'])),
            expected_credits,
        )
        self.assertEqual(
            Decimal(str(create_response.data['account_balance'])),
            expected_credits,
        )

    def test_trial_credits_use_selected_feature_flags(self):
        self.business.business_type = 'restaurant'
        self.business.save(update_fields=['business_type'])
        feature_pos = FeaturePricing.objects.create(
            feature='pos',
            price_per_day=Decimal('1.00'),
            is_active=True,
        )
        feature_inventory = FeaturePricing.objects.create(
            feature='inventory',
            price_per_day=Decimal('2.00'),
            is_active=True,
        )
        feature_kitchen = FeaturePricing.objects.create(
            feature='kitchen',
            price_per_day=Decimal('4.00'),
            is_active=True,
        )
        expected_credits = Decimal('210.00')  # (base 5 + selected features 5) * 21 days

        preview_response = self.client.get(
            '/api/subscription/subscriptions/trial-preview/',
            {
                'business': self.business.id,
                'enable_pos': 'true',
                'enable_inventory': 'false',
                'enable_kitchen': 'true',
            },
        )
        self.assertEqual(preview_response.status_code, 200, preview_response.data)
        self.assertEqual(
            Decimal(str(preview_response.data['free_trial_credits_amount'])),
            expected_credits,
        )
        self.assertEqual(preview_response.data['active_feature_count'], 2)

        create_response = self.client.post(
            '/api/subscription/subscriptions/',
            {
                'business': self.business.id,
                'enable_pos': True,
                'enable_inventory': False,
                'enable_kitchen': True,
            },
            format='json',
        )
        self.assertEqual(create_response.status_code, 201, create_response.data)
        self.assertEqual(
            Decimal(str(create_response.data['account_balance'])),
            expected_credits,
        )

        subscription = Subscription.objects.get(business=self.business)
        self.assertTrue(subscription.enable_pos)
        self.assertFalse(subscription.enable_inventory)
        self.assertTrue(subscription.enable_kitchen)
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature=feature_pos,
                enabled=True,
            ).exists()
        )
        self.assertFalse(
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature=feature_inventory,
                enabled=True,
            ).exists()
        )
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature=feature_kitchen,
                enabled=True,
            ).exists()
        )

    def test_trial_creation_keeps_kitchen_off_for_non_restaurant_business(self):
        FeaturePricing.objects.create(feature='kitchen', price_per_day=Decimal('4.00'), is_active=True)
        expected_credits = Decimal('105.00')  # base 5 * 21 days

        response = self.client.post(
            '/api/subscription/subscriptions/',
            {
                'business': self.business.id,
                'enable_kitchen': True,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        self.assertFalse(response.data['enable_kitchen'])
        self.assertEqual(Decimal(str(response.data['account_balance'])), expected_credits)

    def test_subscription_model_default_trial_days_uses_system_config(self):
        business = Business.objects.create(owner=self.owner, name='Config Trial Biz', country='USA')

        subscription = Subscription.objects.create(
            business=business,
            status='active',
            account_balance=Decimal('0.00'),
        )

        self.assertEqual(subscription.free_trial_days, 21)

    def test_invoice_api_returns_empty_when_invoicing_disabled(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('100.00'),
        )
        Invoice.objects.create(
            subscription=subscription,
            invoice_number='INV-BILLING-1',
            amount=Decimal('15.00'),
            status='sent',
            billing_period_start=timezone.now() - timedelta(days=30),
            billing_period_end=timezone.now(),
            due_date=timezone.now() + timedelta(days=7),
        )

        response = self.client.get('/api/subscription/invoices/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['results'], [])

    def test_subscription_features_list_bootstraps_from_legacy_flags(self):
        FeaturePricing.objects.create(feature='pos', price_per_day=Decimal('1.00'), is_active=True)
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
            enable_pos=True,
        )
        self.assertEqual(subscription.enabled_features.count(), 0)

        response = self.client.get('/api/subscription/subscription-features/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertGreaterEqual(len(response.data['results']), 1)
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature__feature='pos',
                enabled=True,
            ).exists()
        )

    def test_pause_and_deposit_work_with_multiple_subscriptions(self):
        sub_one = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
        )
        sub_two = Subscription.objects.create(
            business=self.business_two,
            status='active',
            account_balance=Decimal('75.00'),
        )

        pause_response = self.client.post(
            '/api/subscription/subscriptions/pause/',
            {'business': self.business_two.id},
            format='json',
        )
        self.assertEqual(pause_response.status_code, 200, pause_response.data)
        sub_one.refresh_from_db()
        sub_two.refresh_from_db()
        self.assertEqual(sub_one.status, 'active')
        self.assertEqual(sub_two.status, 'paused')

        deposit_response = self.client.post(
            '/api/subscription/deposits/',
            {
                'business': self.business_two.id,
                'amount': '10.00',
                'payment_method': 'manual',
                'transaction_id': 'MANUAL-TOPUP-001',
                'payment_proof': 'manual-topup',
            },
            format='json',
        )
        self.assertEqual(deposit_response.status_code, 201, deposit_response.data)
        deposit = Deposit.objects.get(id=deposit_response.data['id'])
        self.assertEqual(deposit.subscription_id, sub_two.id)

    def test_current_endpoint_applies_pending_daily_charges(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('100.00'),
        )

        # Simulate a subscription that started in the past but has never been charged.
        past_start = timezone.now() - timedelta(days=3, hours=1)
        Subscription.objects.filter(pk=subscription.pk).update(
            start_date=past_start,
            last_charge_date=None,
            total_spent=Decimal('0.00'),
        )
        subscription.refresh_from_db()

        pending_days = subscription.get_pending_daily_charge_days()
        self.assertGreaterEqual(pending_days, 1)
        expected_daily = subscription.calculate_daily_charges()
        expected_total_spent = expected_daily * pending_days

        response = self.client.get(
            '/api/subscription/subscriptions/current/',
            {'business': self.business.id},
        )
        self.assertEqual(response.status_code, 200, response.data)

        subscription.refresh_from_db()
        self.assertEqual(subscription.total_spent, expected_total_spent)
        self.assertEqual(subscription.account_balance, Decimal('100.00') - expected_total_spent)
        self.assertIsNotNone(subscription.last_charge_date)

    def test_current_endpoint_returns_subscription_for_active_staff_business(self):
        staff_user = User.objects.create_user(
            email='staff@example.com',
            password='testpass123',
        )
        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('42.00'),
        )
        Staff.objects.create(
            business=self.business,
            user=staff_user,
            name='Staff Member',
            email='staff@example.com',
            role=StaffRole.CASHIER,
            is_active=True,
        )

        self.client.force_authenticate(user=staff_user)
        response = self.client.get('/api/subscription/subscriptions/current/')

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(str(response.data['business']), str(self.business.id))
        self.assertEqual(Decimal(str(response.data['account_balance'])), Decimal('42.00'))

    def test_current_endpoint_returns_404_for_staff_when_business_has_no_subscription(self):
        staff_user = User.objects.create_user(
            email='staff-no-sub@example.com',
            password='testpass123',
        )
        Staff.objects.create(
            business=self.business,
            user=staff_user,
            name='Staff Without Subscription',
            email='staff-no-sub@example.com',
            role=StaffRole.MANAGER,
            is_active=True,
        )

        self.client.force_authenticate(user=staff_user)
        response = self.client.get(
            '/api/subscription/subscriptions/current/',
            {'business': self.business.id},
        )

        self.assertEqual(response.status_code, 404, response.data)

    def test_removing_staff_management_feature_deactivates_existing_staff_and_blocks_login(self):
        feature = FeaturePricing.objects.create(
            feature='staff_management',
            price_per_day=Decimal('1.00'),
            is_active=True,
        )
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            enable_staff_management=True,
        )
        subscription_feature = SubscriptionFeature.objects.create(
            subscription=subscription,
            feature=feature,
            enabled=True,
        )
        owner_staff = Staff.objects.create(
            business=self.business,
            user=self.owner,
            name='Owner Admin',
            email='api-owner@example.com',
            role=StaffRole.ADMIN,
            is_active=True,
        )
        staff_user = User.objects.create_user(
            email='staff-feature-off@example.com',
            password='testpass123',
        )
        staff_member = Staff.objects.create(
            business=self.business,
            user=staff_user,
            name='Feature Off Cashier',
            email='staff-feature-off@example.com',
            role=StaffRole.CASHIER,
            is_active=True,
        )

        response = self.client.delete(
            f'/api/subscription/subscription-features/{subscription_feature.id}/'
        )

        self.assertEqual(response.status_code, 204, response.data)

        subscription.refresh_from_db()
        owner_staff.refresh_from_db()
        staff_member.refresh_from_db()
        staff_user.refresh_from_db()

        self.assertFalse(subscription.enable_staff_management)
        self.assertTrue(owner_staff.is_active)
        self.assertFalse(staff_member.is_active)
        self.assertFalse(staff_user.is_active)

        self.client.force_authenticate(user=None)
        login_response = self.client.post(
            '/api/accounts/login/',
            {
                'email': 'staff-feature-off@example.com',
                'password': 'testpass123',
            },
            format='json',
        )

        self.assertEqual(login_response.status_code, 403, login_response.data)
        self.assertEqual(login_response.data['error'], 'This account is inactive')

    def test_reenabling_staff_management_reactivates_only_feature_disabled_staff(self):
        feature = FeaturePricing.objects.create(
            feature='staff_management',
            price_per_day=Decimal('1.00'),
            is_active=True,
        )
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            enable_staff_management=False,
        )
        auto_disabled_user = User.objects.create_user(
            email='staff-restore@example.com',
            password='testpass123',
            is_active=False,
        )
        auto_disabled_staff = Staff.objects.create(
            business=self.business,
            user=auto_disabled_user,
            name='Feature Disabled Cashier',
            email='staff-restore@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
            disabled_by_feature='staff_management',
            disabled_by_feature_at=timezone.now(),
        )
        manually_disabled_user = User.objects.create_user(
            email='staff-stay-off@example.com',
            password='testpass123',
            is_active=False,
        )
        manually_disabled_staff = Staff.objects.create(
            business=self.business,
            user=manually_disabled_user,
            name='Manual Disable Cashier',
            email='staff-stay-off@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
        )

        request = self.factory.post(
            '/api/subscription/subscription-features/toggle_feature/',
            {
                'business': self.business.id,
                'feature': feature.id,
                'enabled': True,
            },
            format='json',
        )
        force_authenticate(request, user=self.owner)
        response = SubscriptionFeatureViewSet.as_view({'post': 'toggle_feature'})(request)

        self.assertEqual(response.status_code, 200, response.data)

        subscription.refresh_from_db()
        auto_disabled_staff.refresh_from_db()
        auto_disabled_user.refresh_from_db()
        manually_disabled_staff.refresh_from_db()
        manually_disabled_user.refresh_from_db()

        self.assertTrue(subscription.enable_staff_management)
        self.assertTrue(auto_disabled_staff.is_active)
        self.assertTrue(auto_disabled_user.is_active)
        self.assertEqual(auto_disabled_staff.disabled_by_feature, '')
        self.assertIsNone(auto_disabled_staff.disabled_by_feature_at)
        self.assertFalse(manually_disabled_staff.is_active)
        self.assertFalse(manually_disabled_user.is_active)

    def test_subscription_update_reenables_staff_management_and_restores_feature_disabled_staff(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            enable_staff_management=False,
        )
        auto_disabled_user = User.objects.create_user(
            email='staff-update-restore@example.com',
            password='testpass123',
            is_active=False,
        )
        auto_disabled_staff = Staff.objects.create(
            business=self.business,
            user=auto_disabled_user,
            name='Update Restore Cashier',
            email='staff-update-restore@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
            disabled_by_feature='staff_management',
            disabled_by_feature_at=timezone.now(),
        )
        manually_disabled_user = User.objects.create_user(
            email='staff-update-stay-off@example.com',
            password='testpass123',
            is_active=False,
        )
        manually_disabled_staff = Staff.objects.create(
            business=self.business,
            user=manually_disabled_user,
            name='Update Manual Disable',
            email='staff-update-stay-off@example.com',
            role=StaffRole.CASHIER,
            is_active=False,
        )

        request = self.factory.patch(
            f'/api/subscription/subscriptions/{subscription.id}/',
            {
                'enable_staff_management': True,
            },
            format='json',
        )
        force_authenticate(request, user=self.owner)
        response = SubscriptionViewSet.as_view({'patch': 'partial_update'})(request, pk=subscription.id)

        self.assertEqual(response.status_code, 200, response.data)

        subscription.refresh_from_db()
        auto_disabled_staff.refresh_from_db()
        auto_disabled_user.refresh_from_db()
        manually_disabled_staff.refresh_from_db()
        manually_disabled_user.refresh_from_db()

        self.assertTrue(subscription.enable_staff_management)
        self.assertTrue(auto_disabled_staff.is_active)
        self.assertTrue(auto_disabled_user.is_active)
        self.assertEqual(auto_disabled_staff.disabled_by_feature, '')
        self.assertIsNone(auto_disabled_staff.disabled_by_feature_at)
        self.assertFalse(manually_disabled_staff.is_active)
        self.assertFalse(manually_disabled_user.is_active)

    def test_toggle_feature_rejects_disabling_included_feature(self):
        feature = FeaturePricing.objects.create(
            feature='reports',
            price_per_day=Decimal('0.00'),
            is_active=True,
        )
        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            enable_reports=True,
        )

        request = self.factory.post(
            '/api/subscription/subscription-features/toggle_feature/',
            {
                'business': self.business.id,
                'feature': feature.id,
                'enabled': False,
            },
            format='json',
        )
        force_authenticate(request, user=self.owner)
        response = SubscriptionFeatureViewSet.as_view({'post': 'toggle_feature'})(request)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(
            response.data['detail'],
            'Included features are always enabled and cannot be disabled.'
        )

    def test_toggle_feature_rejects_disabling_during_active_trial(self):
        feature = FeaturePricing.objects.create(
            feature='staff_management',
            price_per_day=Decimal('1.00'),
            is_active=True,
        )
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            free_trial_credits_applied=True,
            free_trial_end_date=timezone.now() + timedelta(days=5),
            enable_staff_management=True,
        )
        SubscriptionFeature.objects.create(subscription=subscription, feature=feature, enabled=True)

        request = self.factory.post(
            '/api/subscription/subscription-features/toggle_feature/',
            {
                'business': self.business.id,
                'feature': feature.id,
                'enabled': False,
            },
            format='json',
        )
        force_authenticate(request, user=self.owner)
        response = SubscriptionFeatureViewSet.as_view({'post': 'toggle_feature'})(request)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('free trial credits are active', response.data['detail'])
        subscription.refresh_from_db()
        self.assertTrue(subscription.enable_staff_management)
        self.assertTrue(
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature=feature,
                enabled=True,
            ).exists()
        )

    def test_subscription_update_rejects_disabling_feature_during_active_trial(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('50.00'),
            free_trial_credits_applied=True,
            free_trial_end_date=timezone.now() + timedelta(days=5),
            enable_staff_management=True,
        )

        request = self.factory.patch(
            f'/api/subscription/subscriptions/{subscription.id}/',
            {
                'enable_staff_management': False,
            },
            format='json',
        )
        force_authenticate(request, user=self.owner)
        response = SubscriptionViewSet.as_view({'patch': 'partial_update'})(request, pk=subscription.id)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('free trial credits are active', str(response.data))
        subscription.refresh_from_db()
        self.assertTrue(subscription.enable_staff_management)

    def test_staff_cannot_pause_subscription(self):
        staff_user = User.objects.create_user(
            email='staff-pause@example.com',
            password='testpass123',
        )
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('25.00'),
        )
        Staff.objects.create(
            business=self.business,
            user=staff_user,
            name='Staff No Pause',
            email='staff-pause@example.com',
            role=StaffRole.ADMIN,
            is_active=True,
        )

        self.client.force_authenticate(user=staff_user)
        response = self.client.post(
            '/api/subscription/subscriptions/pause/',
            {'business': self.business.id},
            format='json',
        )

        self.assertEqual(response.status_code, 404, response.data)
        subscription.refresh_from_db()
        self.assertEqual(subscription.status, 'active')

    def test_dashboard_summary_applies_daily_charge_only_once_per_day(self):
        dashboard_business = self.business_two
        initial_balance = Decimal('500000.00')
        branch = Branch.objects.create(
            business=dashboard_business,
            name='Main Branch',
            address='Default Address',
            city='Blantyre',
            country='Malawi',
        )
        subscription = Subscription.objects.create(
            business=dashboard_business,
            status='active',
            account_balance=initial_balance,
        )

        # Simulate multiple missed days so first dashboard load performs catch-up.
        past_start = timezone.now() - timedelta(days=2, hours=1)
        Subscription.objects.filter(pk=subscription.pk).update(
            start_date=past_start,
            last_charge_date=None,
            total_spent=Decimal('0.00'),
        )
        subscription.refresh_from_db()

        pending_days = subscription.get_pending_daily_charge_days()
        self.assertGreaterEqual(pending_days, 1)
        expected_daily = subscription.calculate_daily_charges()
        expected_total_spent = expected_daily * pending_days

        first_response = self.client.get(
            '/api/business/dashboard/summary/',
            {'branch_id': branch.id},
        )
        self.assertEqual(first_response.status_code, 200, first_response.data)

        subscription.refresh_from_db()
        self.assertEqual(subscription.total_spent, expected_total_spent)
        self.assertEqual(subscription.account_balance, initial_balance - expected_total_spent)
        self.assertEqual(subscription.usage_charges.count(), 1)

        # A second dashboard load on the same day must not deduct again.
        second_response = self.client.get(
            '/api/business/dashboard/summary/',
            {'branch_id': branch.id},
        )
        self.assertEqual(second_response.status_code, 200, second_response.data)

        subscription.refresh_from_db()
        self.assertEqual(subscription.total_spent, expected_total_spent)
        self.assertEqual(subscription.account_balance, initial_balance - expected_total_spent)
        self.assertEqual(subscription.usage_charges.count(), 1)

    def test_deposit_creation_requires_transaction_id(self):
        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )

        response = self.client.post(
            '/api/subscription/deposits/',
            {
                'business': self.business.id,
                'amount': '10.00',
                'payment_method': 'manual',
                'payment_proof': 'manual-topup',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('transaction_id', response.data)

    def test_deposit_creation_defaults_payment_proof_to_transaction_id(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )

        response = self.client.post(
            '/api/subscription/deposits/',
            {
                'business': self.business.id,
                'amount': '10.00',
                'payment_method': 'manual',
                'transaction_id': 'MANUAL-TOPUP-002',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        deposit = Deposit.objects.get(id=response.data['id'])
        self.assertEqual(deposit.subscription_id, subscription.id)
        self.assertEqual(deposit.payment_proof, 'MANUAL-TOPUP-002')

    def test_deposit_creation_respects_configured_minimum_amount(self):
        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('1.00')
        config.minimum_deposit_amount = Decimal('100.00')
        config.save()

        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )

        response = self.client.post(
            '/api/subscription/deposits/',
            {
                'business': self.business.id,
                'amount': '50.00',
                'payment_method': 'manual',
                'transaction_id': 'MANUAL-TOPUP-LOW',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('amount', response.data)
        self.assertIn('configured minimum deposit amount', str(response.data['amount']).lower())

    def test_deposit_list_is_paginated_for_billing_table(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )

        for index in range(12):
            Deposit.objects.create(
                subscription=subscription,
                amount=Decimal('50.00') + Decimal(index),
                payment_method='manual',
                transaction_id=f'MANUAL-PAGE-{index:02d}',
                payment_proof=f'MANUAL-PAGE-{index:02d}',
            )

        response = self.client.get(
            '/api/subscription/deposits/',
            {'business': self.business.id},
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 12)
        self.assertEqual(len(response.data['results']), 10)
        self.assertIsNotNone(response.data['next'])
        self.assertIsNone(response.data['previous'])

    def test_pending_deposit_can_be_deleted_safely(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )
        deposit = Deposit.objects.create(
            subscription=subscription,
            amount=Decimal('150.00'),
            payment_method='paychangu',
            payment_proof='',
        )
        SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.owner,
            tx_ref='delete-pending-attempt',
            checkout_url='https://pay.example/checkout',
            amount=Decimal('150.00'),
            currency='USD',
            status='pending',
        )

        response = self.client.delete(
            f'/api/subscription/deposits/{deposit.id}/',
            {'business': self.business.id},
        )

        self.assertEqual(response.status_code, 204, response.data)
        self.assertFalse(Deposit.objects.filter(pk=deposit.pk).exists())
        self.assertFalse(SubscriptionPaymentAttempt.objects.filter(tx_ref='delete-pending-attempt').exists())

    def test_completed_deposit_cannot_be_deleted(self):
        subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )
        deposit = Deposit.objects.create(
            subscription=subscription,
            amount=Decimal('150.00'),
            payment_method='manual',
            transaction_id='COMPLETE-001',
            payment_proof='COMPLETE-001',
            status=DepositStatus.COMPLETED,
        )

        response = self.client.delete(
            f'/api/subscription/deposits/{deposit.id}/',
            {'business': self.business.id},
        )

        self.assertEqual(response.status_code, 400, response.data)
        self.assertTrue(Deposit.objects.filter(pk=deposit.pk).exists())

    def test_discounted_credit_bundle_manual_deposit_stores_full_credit_amount(self):
        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('20.00'),
        )

        response = self.client.post(
            '/api/subscription/deposits/',
            {
                'business': self.business.id,
                'amount': '427.50',
                'funding_period': 'quarterly',
                'payment_method': 'manual',
                'transaction_id': 'MANUAL-BUNDLE-003',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        deposit = Deposit.objects.get(id=response.data['id'])
        self.assertEqual(deposit.amount, Decimal('427.50'))
        self.assertEqual(deposit.credited_amount, Decimal('450.00'))
        self.assertEqual(deposit.funding_period, 'quarterly')
