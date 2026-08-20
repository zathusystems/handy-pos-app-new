from urllib.parse import parse_qs, urlparse
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from business.models import Business
from system_config.models import SystemConfig
from subscription.models import Deposit, DepositStatus, Subscription

from .forms import PaymentGatewayConfigurationAdminForm
from .models import PaymentGatewayConfiguration, SubscriptionPaymentAttempt
from .pricing import (
    build_subscription_funding_quote,
    get_custom_monthly_minimum,
    get_effective_custom_payment_minimum,
    validate_subscription_payment_amount,
)
from .serializers import (
    PaymentGatewayConfigurationAdminSerializer,
    PaymentGatewayConfigurationSerializer,
)
from .views import (
    StartSubscriptionCheckoutView,
    SubscriptionFundingPricingView,
    SubscriptionCheckoutReturnView,
    append_redirect_query_params,
    build_subscription_billing_redirect_path,
    build_checkout_redirect_bridge_url,
    finalize_verified_subscription_payment,
)

User = get_user_model()


class PaymentGatewayConfigurationSerializerTests(TestCase):
    def setUp(self):
        self.config = PaymentGatewayConfiguration.get_settings()
        self.config.display_name = 'PayChangu'
        self.config.secret_key = 'sk_test_1234567890'
        self.config.webhook_secret = 'whsec_test_0987654321'
        self.config.save()

    def test_admin_serializer_masks_secret_fields(self):
        data = PaymentGatewayConfigurationAdminSerializer(self.config).data

        self.assertNotIn('secret_key', data)
        self.assertNotIn('webhook_secret', data)
        self.assertTrue(data['has_secret_key'])
        self.assertTrue(data['has_webhook_secret'])
        self.assertTrue(data['secret_key_masked'].endswith('7890'))
        self.assertTrue(data['webhook_secret_masked'].endswith('4321'))

    def test_update_serializer_keeps_existing_secrets_when_blank(self):
        serializer = PaymentGatewayConfigurationSerializer(
            self.config,
            data={
                'display_name': 'Updated Gateway',
                'secret_key': '',
                'webhook_secret': '',
            },
            partial=True,
        )

        self.assertTrue(serializer.is_valid(), serializer.errors)
        updated = serializer.save()

        self.assertEqual(updated.display_name, 'Updated Gateway')
        self.assertEqual(updated.secret_key, 'sk_test_1234567890')
        self.assertEqual(updated.webhook_secret, 'whsec_test_0987654321')

    def test_update_serializer_allows_handypos_callback_and_return_urls(self):
        serializer = PaymentGatewayConfigurationSerializer(
            self.config,
            data={
                'callback_url': 'handypos://subscription-payment/{deposit_id}',
                'return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            partial=True,
        )

        self.assertTrue(serializer.is_valid(), serializer.errors)
        updated = serializer.save()

        self.assertEqual(updated.callback_url, 'handypos://subscription-payment/{deposit_id}')
        self.assertEqual(updated.return_url, 'handypos://subscription-payment/{deposit_id}')

    def test_model_full_clean_allows_handypos_callback_and_return_urls(self):
        self.config.callback_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.return_url = 'handypos://subscription-payment/{deposit_id}'

        self.config.full_clean()

    @override_settings(PAYMENT_PUBLIC_BASE_URL='')
    def test_live_gateway_is_not_ready_without_https_public_base_or_https_redirects(self):
        self.config.environment = 'live'
        self.config.is_active = True
        self.config.callback_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.return_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.save()

        self.assertFalse(self.config.is_ready)

    @override_settings(PAYMENT_PUBLIC_BASE_URL='https://payments.handypos.example')
    def test_live_gateway_is_ready_with_https_public_base(self):
        self.config.environment = 'live'
        self.config.is_active = True
        self.config.callback_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.return_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.save()

        self.assertTrue(self.config.is_ready)


class PaymentGatewayConfigurationAdminFormTests(TestCase):
    def setUp(self):
        self.config = PaymentGatewayConfiguration.get_settings()
        self.config.display_name = 'PayChangu'
        self.config.secret_key = 'sk_test_1234567890'
        self.config.webhook_secret = 'whsec_test_0987654321'
        self.config.save()

    def build_form(self, **overrides):
        data = {
            'provider': 'paychangu',
            'display_name': 'PayChangu',
            'is_active': 'on',
            'environment': 'sandbox',
            'checkout_flow': 'hosted_checkout',
            'public_key': '',
            'secret_key': '',
            'webhook_secret': '',
            'checkout_init_url': 'https://api.paychangu.com/payment',
            'verify_url_template': 'https://api.paychangu.com/verify-payment/{tx_ref}',
            'callback_url': 'handypos://subscription-payment/{deposit_id}',
            'return_url': 'handypos://subscription-payment/{deposit_id}',
            'default_currency': 'mwk',
            'payment_title': 'HandyPOS Subscription Top-up',
            'payment_description': 'Add credits to your HandyPOS subscription',
            'metadata': '{}',
        }
        data.update(overrides)
        return PaymentGatewayConfigurationAdminForm(data=data, instance=self.config)

    def test_admin_form_accepts_handypos_redirect_urls(self):
        form = self.build_form()

        self.assertTrue(form.is_valid(), form.errors)
        config = form.save()

        self.assertEqual(config.callback_url, 'handypos://subscription-payment/{deposit_id}')
        self.assertEqual(config.return_url, 'handypos://subscription-payment/{deposit_id}')
        self.assertEqual(config.default_currency, 'MWK')

    def test_admin_form_preserves_existing_secret_fields_when_left_blank(self):
        form = self.build_form(secret_key='', webhook_secret='')

        self.assertTrue(form.is_valid(), form.errors)
        config = form.save()

        self.assertEqual(config.secret_key, 'sk_test_1234567890')
        self.assertEqual(config.webhook_secret, 'whsec_test_0987654321')


class PaymentCheckoutRedirectHelperTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @override_settings(PAYMENT_PUBLIC_BASE_URL='https://payments.handypos.example')
    def test_build_checkout_redirect_bridge_url_uses_public_base_url(self):
        request = self.factory.post('/api/payments/subscription/checkout/start/')

        bridge_url = build_checkout_redirect_bridge_url(
            request,
            'DEP-41-ABC',
            'handypos://subscription-payment/DEP-41-ABC',
            target='callback',
        )

        self.assertTrue(
            bridge_url.startswith(
                'https://payments.handypos.example/api/payments/subscription/checkout/return/DEP-41-ABC/'
            )
        )
        self.assertIn('app_redirect=handypos%3A%2F%2Fsubscription-payment%2FDEP-41-ABC', bridge_url)

    @override_settings(PAYMENT_PUBLIC_BASE_URL='')
    def test_build_checkout_redirect_bridge_url_falls_back_to_gateway_redirect_origin(self):
        request = self.factory.post('/api/payments/subscription/checkout/start/')
        config = PaymentGatewayConfiguration.get_settings()
        config.callback_url = 'https://api.handypos.example/payments/callback/{deposit_id}/'
        config.return_url = 'https://api.handypos.example/payments/return/{deposit_id}/'
        config.save()

        bridge_url = build_checkout_redirect_bridge_url(
            request,
            'DEP-41-ABC',
            'handypos://subscription-payment/DEP-41-ABC',
            target='callback',
            config=config,
        )

        self.assertTrue(
            bridge_url.startswith(
                'https://api.handypos.example/api/payments/subscription/checkout/return/DEP-41-ABC/'
            )
        )
        self.assertIn('app_redirect=handypos%3A%2F%2Fsubscription-payment%2FDEP-41-ABC', bridge_url)

    def test_append_redirect_query_params_preserves_existing_values(self):
        redirect_url = append_redirect_query_params(
            'handypos://subscription-payment/DEP-41-ABC?status=pending',
            {
                'status': 'success',
                'tx_ref': 'subcredit-DEP-41-ABC-abc123',
            },
        )

        self.assertIn('status=pending', redirect_url)
        self.assertIn('tx_ref=subcredit-DEP-41-ABC-abc123', redirect_url)

    def test_checkout_return_view_allows_handypos_redirect_scheme(self):
        request = self.factory.get(
            '/api/payments/subscription/checkout/return/DEP-41-ABC/',
            {
                'target': 'callback',
                'app_redirect': 'handypos://subscription-payment/{deposit_id}',
                'tx_ref': 'subcredit-DEP-41-ABC-abc123',
                'status': 'success',
            },
        )

        response = SubscriptionCheckoutReturnView.as_view()(request, deposit_id='DEP-41-ABC')

        self.assertEqual(response.status_code, 200)
        self.assertIn('Returning to HandyPOS', response.content.decode())
        self.assertIn('Opening HandyPOS automatically...', response.content.decode())
        self.assertIn(
            'handypos://subscription-payment/DEP-41-ABC?deposit_id=DEP-41-ABC&tx_ref=subcredit-DEP-41-ABC-abc123&status=success&gatewayReturn=callback',
            response.content.decode(),
        )
        self.assertIn(
            'http://tauri.localhost/dashboard/settings/billing/?openAddCredit=1&gatewayReturn=callback&deposit_id=DEP-41-ABC&tx_ref=subcredit-DEP-41-ABC-abc123&status=success',
            response.content.decode(),
        )
        self.assertIn(
            'tauri://localhost/dashboard/settings/billing/?openAddCredit=1&gatewayReturn=callback&deposit_id=DEP-41-ABC&tx_ref=subcredit-DEP-41-ABC-abc123&status=success',
            response.content.decode(),
        )
        self.assertNotIn('https://tauri.localhost', response.content.decode())
        self.assertIn(
            'window.location.replace(targetUrl);',
            response.content.decode(),
        )
        self.assertIn(
            "'Returning to billing inside HandyPOS...'",
            response.content.decode(),
        )
        self.assertIn(
            "'Retrying the in-app HandyPOS return route...'",
            response.content.decode(),
        )
        self.assertIn(
            'var mobilePreferred = [billingTargets[0], billingTargets[1]];',
            response.content.decode(),
        )
        self.assertNotIn('Return to Billing', response.content.decode())
        self.assertNotIn('Open HandyPOS', response.content.decode())
        self.assertNotIn('Try Alternate App Route', response.content.decode())

    def test_checkout_return_view_preserves_return_target_in_deep_link_fallback(self):
        request = self.factory.get(
            '/api/payments/subscription/checkout/return/DEP-41-ABC/',
            {
                'target': 'return',
                'app_redirect': 'handypos://subscription-payment/{deposit_id}',
                'tx_ref': 'subcredit-DEP-41-ABC-abc123',
                'status': 'cancelled',
            },
        )

        response = SubscriptionCheckoutReturnView.as_view()(request, deposit_id='DEP-41-ABC')

        self.assertEqual(response.status_code, 200)
        self.assertIn(
            'handypos://subscription-payment/DEP-41-ABC?deposit_id=DEP-41-ABC&tx_ref=subcredit-DEP-41-ABC-abc123&status=cancelled&gatewayReturn=return',
            response.content.decode(),
        )

    def test_build_subscription_billing_redirect_path_preserves_payment_details(self):
        redirect_path = build_subscription_billing_redirect_path(
            'DEP-41-ABC',
            tx_ref='subcredit-DEP-41-ABC-abc123',
            status='cancelled',
            gateway_return='return',
        )

        self.assertEqual(
            redirect_path,
            '/dashboard/settings/billing/?openAddCredit=1&gatewayReturn=return&deposit_id=DEP-41-ABC&tx_ref=subcredit-DEP-41-ABC-abc123&status=cancelled',
        )


class SubscriptionPaymentFlowTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='owner@example.com',
            password='password123',
            first_name='Handy',
            last_name='Owner',
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Handy Test Shop',
            business_type='generic',
        )
        self.subscription = Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('0.00'),
        )
        self.config = PaymentGatewayConfiguration.get_settings()
        self.config.is_active = True
        self.config.secret_key = 'sk_test_1234567890'
        self.config.webhook_secret = 'whsec_test_0987654321'
        self.config.callback_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.return_url = 'handypos://subscription-payment/{deposit_id}'
        self.config.save()
        self.api_factory = APIRequestFactory()

    def test_subscription_pricing_view_returns_backend_minimum_and_quotes(self):
        request = self.api_factory.get(
            '/api/payments/subscription/pricing/',
            {'business': self.business.id},
        )
        force_authenticate(request, user=self.user)

        response = SubscriptionFundingPricingView.as_view()(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            Decimal(str(response.data['minimum_custom_amount'])),
            get_effective_custom_payment_minimum(self.subscription),
        )
        quote_periods = {quote['funding_period'] for quote in response.data['quotes']}
        self.assertEqual(quote_periods, {'monthly', 'quarterly', 'semiannual', 'yearly'})

    def test_subscription_pricing_view_uses_configured_minimum_when_higher(self):
        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('1.00')
        config.minimum_deposit_amount = Decimal('100.00')
        config.save()

        request = self.api_factory.get(
            '/api/payments/subscription/pricing/',
            {'business': self.business.id},
        )
        force_authenticate(request, user=self.user)

        response = SubscriptionFundingPricingView.as_view()(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(str(response.data['minimum_custom_amount'])), Decimal('100.00'))

    def test_custom_payment_validation_uses_configured_minimum_instead_of_monthly_charge(self):
        monthly_minimum = get_custom_monthly_minimum(self.subscription)
        custom_amount = monthly_minimum - Decimal('0.01')

        validation = validate_subscription_payment_amount(
            self.subscription,
            custom_amount,
            funding_period='custom',
        )

        self.assertTrue(validation['is_valid'], validation)
        self.assertEqual(validation['normalized_amount'], custom_amount)
        self.assertEqual(
            Decimal(str(validation['quote']['minimum_custom_amount'])),
            get_effective_custom_payment_minimum(self.subscription),
        )

    def test_finalize_verified_subscription_payment_completes_deposit_and_adds_credit(self):
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('100.00'),
            payment_method='paychangu',
            payment_proof='',
        )
        attempt = SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.user,
            tx_ref='subcredit-DEP-100-abc123',
            checkout_url='https://paychangu.example/checkout',
            amount=Decimal('100.00'),
            currency='MWK',
            status='pending',
        )
        verification_payload = {
            'status': 'success',
            'tx_ref': attempt.tx_ref,
            'reference': 'paychangu-ref-123',
            'amount': '100.00',
            'currency': 'MWK',
            'data': {
                'authorization': {
                    'completed_at': '2026-04-06T10:00:00Z',
                }
            },
        }

        verified, detail_message, _ = finalize_verified_subscription_payment(
            attempt,
            verification_payload,
            source='test',
        )

        attempt.refresh_from_db()
        deposit.refresh_from_db()
        self.subscription.refresh_from_db()

        self.assertTrue(verified)
        self.assertIn('credits added', detail_message)
        self.assertEqual(attempt.status, 'successful')
        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertEqual(deposit.transaction_id, 'paychangu-ref-123')
        self.assertEqual(self.subscription.account_balance, Decimal('100.00'))

    def test_finalize_verified_subscription_payment_rejects_mismatched_amount(self):
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('100.00'),
            payment_method='paychangu',
            payment_proof='',
        )
        attempt = SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.user,
            tx_ref='subcredit-DEP-200-abc123',
            checkout_url='https://paychangu.example/checkout',
            amount=Decimal('100.00'),
            currency='MWK',
            status='pending',
        )
        verification_payload = {
            'status': 'success',
            'tx_ref': attempt.tx_ref,
            'reference': 'paychangu-ref-456',
            'amount': '50.00',
            'currency': 'MWK',
        }

        verified, detail_message, _ = finalize_verified_subscription_payment(
            attempt,
            verification_payload,
            source='test',
        )

        attempt.refresh_from_db()
        deposit.refresh_from_db()
        self.subscription.refresh_from_db()

        self.assertFalse(verified)
        self.assertIn('lower than the requested credit amount', detail_message)
        self.assertEqual(attempt.status, 'awaiting_verification')
        self.assertEqual(deposit.status, DepositStatus.PENDING)
        self.assertEqual(self.subscription.account_balance, Decimal('0.00'))

    def test_finalize_verified_discounted_bundle_adds_full_credit_amount(self):
        quote = build_subscription_funding_quote(self.subscription, 'quarterly')
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=quote['final_amount'],
            credited_amount=quote['credit_amount'],
            funding_period='quarterly',
            payment_method='paychangu',
            payment_proof='',
        )
        attempt = SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.user,
            tx_ref='subcredit-DEP-250-abc123',
            checkout_url='https://paychangu.example/checkout',
            amount=quote['final_amount'],
            currency='MWK',
            status='pending',
        )
        verification_payload = {
            'status': 'success',
            'tx_ref': attempt.tx_ref,
            'reference': 'paychangu-ref-789',
            'amount': str(quote['final_amount']),
            'currency': 'MWK',
        }

        verified, detail_message, _ = finalize_verified_subscription_payment(
            attempt,
            verification_payload,
            source='test',
        )

        attempt.refresh_from_db()
        deposit.refresh_from_db()
        self.subscription.refresh_from_db()

        self.assertTrue(verified)
        self.assertIn('credits added', detail_message)
        self.assertEqual(deposit.status, DepositStatus.COMPLETED)
        self.assertEqual(self.subscription.account_balance, quote['credit_amount'])

    def test_finalize_verified_subscription_payment_uses_nested_failed_status_from_verify_response(self):
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('100.00'),
            payment_method='paychangu',
            payment_proof='',
        )
        attempt = SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.user,
            tx_ref='subcredit-DEP-225-abc123',
            checkout_url='https://paychangu.example/checkout',
            amount=Decimal('100.00'),
            currency='MWK',
            status='pending',
        )
        verification_payload = {
            'status': 'success',
            'message': 'Verification request completed.',
            'data': {
                'status': 'cancelled',
                'tx_ref': attempt.tx_ref,
                'reference': 'paychangu-ref-cancelled',
                'amount': '100.00',
                'currency': 'MWK',
            },
        }

        verified, detail_message, _ = finalize_verified_subscription_payment(
            attempt,
            verification_payload,
            source='test',
        )

        attempt.refresh_from_db()
        deposit.refresh_from_db()
        self.subscription.refresh_from_db()

        self.assertFalse(verified)
        self.assertIn("payment status 'cancelled'", detail_message.lower())
        self.assertEqual(attempt.status, 'cancelled')
        self.assertEqual(deposit.status, DepositStatus.PENDING)
        self.assertEqual(self.subscription.account_balance, Decimal('0.00'))

    @patch('payments.views.initiate_checkout')
    def test_start_checkout_creates_gateway_deposit_and_attempt(self, mock_initiate_checkout):
        mock_initiate_checkout.return_value = {
            'request_payload': {
                'tx_ref': 'subcredit-DEP-300-abc123',
                'meta': {'payment_category': 'subscription_credit'},
            },
            'response_payload': {
                'data': {'checkout_url': 'https://paychangu.example/checkout'},
            },
            'checkout_url': 'https://paychangu.example/checkout',
            'tx_ref': 'subcredit-DEP-300-abc123',
            'callback_status': 'pending',
        }

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': '75.00',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['checkout_url'], 'https://paychangu.example/checkout')
        self.assertEqual(Deposit.objects.count(), 1)
        self.assertEqual(SubscriptionPaymentAttempt.objects.count(), 1)

        deposit = Deposit.objects.get()
        attempt = SubscriptionPaymentAttempt.objects.get()

        self.assertEqual(deposit.payment_method, 'paychangu')
        self.assertEqual(deposit.amount, Decimal('75.00'))
        self.assertEqual(attempt.deposit, deposit)
        self.assertEqual(attempt.tx_ref, 'subcredit-DEP-300-abc123')

    @override_settings(PAYMENT_PUBLIC_BASE_URL='https://payments.handypos.example')
    @patch('payments.views.initiate_checkout')
    def test_start_checkout_reuses_existing_active_attempt_for_subscription(self, mock_initiate_checkout):
        deposit = Deposit.objects.create(
            subscription=self.subscription,
            amount=Decimal('75.00'),
            payment_method='paychangu',
            payment_proof='',
        )
        attempt = SubscriptionPaymentAttempt.objects.create(
            provider='paychangu',
            deposit=deposit,
            initiated_by=self.user,
            tx_ref='subcredit-DEP-301-abc123',
            checkout_url='https://paychangu.example/existing-checkout',
            amount=Decimal('75.00'),
            currency='MWK',
            status='pending',
        )

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': '120.00',
                'funding_period': 'monthly',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 200)
        self.assertIn('already in progress', response.data['detail'].lower())
        self.assertEqual(response.data['checkout_url'], attempt.checkout_url)
        self.assertEqual(response.data['tx_ref'], attempt.tx_ref)
        self.assertEqual(response.data['attempt']['id'], attempt.id)
        self.assertEqual(response.data['deposit']['id'], deposit.id)
        self.assertEqual(Deposit.objects.count(), 1)
        self.assertEqual(SubscriptionPaymentAttempt.objects.count(), 1)
        mock_initiate_checkout.assert_not_called()

    @override_settings(PAYMENT_PUBLIC_BASE_URL='https://payments.handypos.example')
    @patch('payments.views.initiate_checkout')
    def test_start_checkout_builds_public_https_bridge_urls_for_app_redirects(self, mock_initiate_checkout):
        mock_initiate_checkout.return_value = {
            'request_payload': {
                'tx_ref': 'subcredit-DEP-350-abc123',
                'meta': {'payment_category': 'subscription_credit'},
            },
            'response_payload': {
                'data': {'checkout_url': 'https://paychangu.example/checkout'},
            },
            'checkout_url': 'https://paychangu.example/checkout',
            'tx_ref': 'subcredit-DEP-350-abc123',
            'callback_status': 'pending',
        }

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': '75.00',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 201)

        deposit = Deposit.objects.get()
        call_kwargs = mock_initiate_checkout.call_args.kwargs
        callback_url = call_kwargs['callback_url']
        return_url = call_kwargs['return_url']

        expected_app_redirect = f'handypos://subscription-payment/{deposit.deposit_id}'

        parsed_callback = urlparse(callback_url)
        parsed_return = urlparse(return_url)
        callback_query = parse_qs(parsed_callback.query)
        return_query = parse_qs(parsed_return.query)

        self.assertEqual(parsed_callback.scheme, 'https')
        self.assertEqual(parsed_callback.netloc, 'payments.handypos.example')
        self.assertEqual(
            parsed_callback.path,
            f'/api/payments/subscription/checkout/return/{deposit.deposit_id}/',
        )
        self.assertEqual(callback_query['target'], ['callback'])
        self.assertEqual(callback_query['app_redirect'], [expected_app_redirect])

        self.assertEqual(parsed_return.scheme, 'https')
        self.assertEqual(parsed_return.netloc, 'payments.handypos.example')
        self.assertEqual(
            parsed_return.path,
            f'/api/payments/subscription/checkout/return/{deposit.deposit_id}/',
        )
        self.assertEqual(return_query['target'], ['return'])
        self.assertEqual(return_query['app_redirect'], [expected_app_redirect])

    @patch('payments.views.initiate_checkout')
    def test_start_checkout_accepts_discounted_quarterly_amount(self, mock_initiate_checkout):
        quote = build_subscription_funding_quote(self.subscription, 'quarterly')
        mock_initiate_checkout.return_value = {
            'request_payload': {
                'tx_ref': 'subcredit-DEP-400-abc123',
                'meta': {
                    'payment_category': 'subscription_credit',
                    'funding_period': 'quarterly',
                },
            },
            'response_payload': {
                'data': {'checkout_url': 'https://paychangu.example/checkout-quarterly'},
            },
            'checkout_url': 'https://paychangu.example/checkout-quarterly',
            'tx_ref': 'subcredit-DEP-400-abc123',
            'callback_status': 'pending',
        }

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': str(quote['final_amount']),
                'funding_period': 'quarterly',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['pricing']['funding_period'], 'quarterly')
        self.assertEqual(Decimal(str(response.data['pricing']['final_amount'])), quote['final_amount'])

        deposit = Deposit.objects.get()
        attempt = SubscriptionPaymentAttempt.objects.get()

        self.assertEqual(deposit.amount, quote['final_amount'])
        self.assertEqual(deposit.credited_amount, quote['credit_amount'])
        self.assertEqual(deposit.funding_period, 'quarterly')
        self.assertEqual(attempt.amount, quote['final_amount'])
        self.assertEqual(Decimal(str(response.data['deposit']['credited_amount'])), quote['credit_amount'])

    @patch('payments.views.initiate_checkout')
    def test_start_checkout_allows_custom_amount_below_monthly_charge_when_above_configured_minimum(self, mock_initiate_checkout):
        monthly_minimum = get_custom_monthly_minimum(self.subscription)
        invalid_amount = monthly_minimum - Decimal('0.01')
        mock_initiate_checkout.return_value = {
            'request_payload': {
                'tx_ref': 'subcredit-DEP-450-abc123',
                'meta': {
                    'payment_category': 'subscription_credit',
                    'funding_period': 'custom',
                },
            },
            'response_payload': {
                'data': {'checkout_url': 'https://paychangu.example/checkout-custom'},
            },
            'checkout_url': 'https://paychangu.example/checkout-custom',
            'tx_ref': 'subcredit-DEP-450-abc123',
            'callback_status': 'pending',
        }

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': str(invalid_amount),
                'funding_period': 'custom',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Deposit.objects.count(), 1)
        self.assertEqual(SubscriptionPaymentAttempt.objects.count(), 1)

        deposit = Deposit.objects.get()
        attempt = SubscriptionPaymentAttempt.objects.get()

        self.assertEqual(deposit.amount, invalid_amount)
        self.assertEqual(deposit.credited_amount, invalid_amount)
        self.assertEqual(deposit.funding_period, 'custom')
        self.assertEqual(attempt.amount, invalid_amount)
        self.assertEqual(attempt.tx_ref, 'subcredit-DEP-450-abc123')

    def test_start_checkout_rejects_custom_amount_below_configured_minimum(self):
        config = SystemConfig.get_config()
        config.base_subscription_price_per_day_usd = Decimal('1.00')
        config.minimum_deposit_amount = Decimal('100.00')
        config.save()

        request = self.api_factory.post(
            '/api/payments/subscription/checkout/start/',
            {
                'business': self.business.id,
                'amount': '50.00',
                'funding_period': 'custom',
                'app_callback_url': 'handypos://subscription-payment/{deposit_id}',
                'app_return_url': 'handypos://subscription-payment/{deposit_id}',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)

        response = StartSubscriptionCheckoutView.as_view()(request)

        self.assertEqual(response.status_code, 400)
        self.assertIn('configured minimum deposit amount', response.data['detail'].lower())
        self.assertEqual(Deposit.objects.count(), 0)
        self.assertEqual(SubscriptionPaymentAttempt.objects.count(), 0)
