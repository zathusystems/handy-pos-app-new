"""
MRA EIS Integration Tests
"""
from django.test import TestCase, TransactionTestCase, override_settings
from django.db import connection
from django.utils import timezone
from django.contrib.auth import get_user_model
from datetime import timedelta
from decimal import Decimal
import json
from unittest.mock import Mock, patch

from business.models import Business, Branch, BusinessSettings
from inventory.models import InventoryItem, MRAProductMapping as InventoryMRAProductMapping
from mra_eis.models import (
    Terminal, TerminalActivationCode, MRAConfiguration, MRAProductMapping,
    MRAInvoice, OfflineInvoiceQueue, Receipt, InvoiceAuditLog,
    TerminalAuditLog, MRAAPIError, SyncRetryQueue, ConfigurationSyncLog,
)
from mra_eis.services import (
    TerminalService, ConfigurationService, ProductMappingService,
    InvoiceService, ReceiptService, RetryService,
    POSOrderSubmissionService, MRAIntegrationError, MRAResponseError,
    MRACallResult, MRAEISClient,
)

User = get_user_model()


class TerminalCredentialSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='eis-credential-security@example.com',
            password='test123',
        )
        self.business = Business.objects.create(owner=self.user, name='Credential Security Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )

    def test_terminal_credentials_are_encrypted_at_rest(self):
        terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-CREDENTIAL-001',
            device_serial='DEVICE-CREDENTIAL-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-CREDENTIAL-001',
            mra_api_key='terminal-api-secret',
            mra_token='terminal-jwt-token',
        )

        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT mra_api_key, mra_token FROM mra_eis_terminal WHERE terminal_id = %s',
                [terminal.terminal_id],
            )
            stored_api_key, stored_token = cursor.fetchone()

        self.assertNotIn('terminal-api-secret', stored_api_key)
        self.assertNotIn('terminal-jwt-token', stored_token)
        self.assertTrue(stored_api_key.startswith('mra-eis:v1:'))
        self.assertTrue(stored_token.startswith('mra-eis:v1:'))

        terminal.refresh_from_db()
        self.assertEqual(terminal.mra_api_key, 'terminal-api-secret')
        self.assertEqual(terminal.mra_token, 'terminal-jwt-token')

    def test_audits_and_api_errors_redact_credentials(self):
        terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-CREDENTIAL-002',
            device_serial='DEVICE-CREDENTIAL-002',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-CREDENTIAL-002',
            mra_api_key='terminal-api-secret',
        )
        audit = TerminalAuditLog.objects.create(
            terminal=terminal,
            action='activated',
            details={
                'response': {'jwtToken': 'jwt-secret', 'secretKey': 'api-secret'},
                'request_payload': {'tacCode': 'TAC-SECRET'},
            },
        )
        error = MRAAPIError.objects.create(
            terminal=terminal,
            error_type='invalid_request',
            error_message='authorization=Bearer super-secret token=jwt-secret',
        )

        self.assertEqual(audit.details['response']['jwtToken'], '[redacted]')
        self.assertEqual(audit.details['response']['secretKey'], '[redacted]')
        self.assertEqual(audit.details['request_payload']['tacCode'], '[redacted]')
        self.assertNotIn('super-secret', error.error_message)
        self.assertNotIn('jwt-secret', error.error_message)

    def test_fiscal_response_snapshots_redact_credentials(self):
        terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-CREDENTIAL-003',
            device_serial='DEVICE-CREDENTIAL-003',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-CREDENTIAL-003',
            mra_api_key='terminal-api-secret',
        )
        invoice = MRAInvoice.objects.create(
            business=self.business,
            branch=self.branch,
            terminal=terminal,
            invoice_number=1,
            seller_tin='1234567890',
            seller_name=self.business.name,
            items=[],
            net_amount=Decimal('0.00'),
            tax_amount=Decimal('0.00'),
            gross_amount=Decimal('0.00'),
            invoice_date=timezone.now(),
            mra_response={'response': {'accessToken': 'response-token'}},
        )

        self.assertEqual(invoice.mra_response['response']['accessToken'], '[redacted]')


class EISOptInSafetyTests(TransactionTestCase):
    """EIS activity must be explicitly enabled per business."""

    def setUp(self):
        self.user = User.objects.create_user(email='eis-disabled@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='EIS Disabled Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=False)
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-EIS-OFF-001',
            device_serial='DEVICE-EIS-OFF-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-EIS-OFF-001',
            status='active',
            is_online=True,
        )

    def test_disabled_business_cannot_create_mra_invoice(self):
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Soft Drink',
                'quantity': Decimal('1'),
                'unit_price': Decimal('1000.00'),
                'tax_rate': Decimal('0'),
                'tax_category': 'zero',
            }
        ]

        with self.assertRaises(MRAIntegrationError):
            InvoiceService.create_invoice(
                terminal=self.terminal,
                seller_tin='1234567890',
                seller_name=self.business.name,
                items=items,
                is_online=True,
            )

        self.assertFalse(MRAInvoice.objects.filter(business=self.business).exists())

    def test_retry_worker_leaves_disabled_business_job_pending(self):
        retry = SyncRetryQueue.objects.create(
            terminal=self.terminal,
            operation_type='submit_invoice',
            status='pending',
            payload={'invoice_id': 'not-used'},
            next_attempt_at=timezone.now(),
        )

        result = RetryService.process_retry_queue()

        retry.refresh_from_db()
        self.assertEqual(retry.status, 'pending')
        self.assertEqual(retry.attempt_count, 0)
        self.assertEqual(result['skipped'], 1)

    def test_reconnect_does_not_sync_disabled_business(self):
        self.terminal.is_online = False
        self.terminal.save(update_fields=['is_online'])

        with patch('mra_eis.services.InvoiceService.sync_offline_invoices') as sync:
            from mra_eis.services import TerminalService

            TerminalService.update_online_status(self.terminal, True)

        sync.assert_not_called()

    def test_offline_invoice_signal_does_not_sync_disabled_business(self):
        invoice = MRAInvoice.objects.create(
            business=self.business,
            branch=self.branch,
            terminal=self.terminal,
            invoice_number=1,
            seller_tin='1234567890',
            seller_name=self.business.name,
            items=[],
            net_amount=Decimal('0'),
            tax_amount=Decimal('0'),
            gross_amount=Decimal('0'),
            invoice_date=timezone.now(),
            status='draft',
        )

        with patch('mra_eis.services.InvoiceService.sync_offline_invoices') as sync:
            invoice.status = 'offline_queued'
            invoice.save(update_fields=['status', 'updated_at'])

        sync.assert_not_called()


class MRAResponseHandlingTests(TestCase):
    """MRA business rejections must not be mistaken for network failures."""

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_http_success_with_mra_rejection_raises_non_retryable_error(self):
        response = Mock()
        response.status_code = 200
        response.content = b'{"statusCode": -1, "remark": "Unknown product code"}'
        response.json.return_value = {
            'statusCode': -1,
            'remark': 'Unknown product code',
        }
        response.raise_for_status.return_value = None

        with patch('mra_eis.services.requests.request', return_value=response):
            with self.assertRaisesMessage(MRAResponseError, 'Unknown product code') as raised:
                MRAEISClient().call('report_sale', payload={'items': []})

        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.endpoint_key, 'report_sale')

    def test_dry_run_response_is_not_rejected(self):
        result = MRAEISClient().call('report_sale', payload={'items': []})

        self.assertTrue(result.ok)
        self.assertTrue(result.dry_run)

    @override_settings(
        MRA_EIS_IS_LIVE=True,
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_live_call_requires_terminal_credentials(self):
        with self.assertRaisesMessage(MRAIntegrationError, 'terminal Bearer authorization token'):
            MRAEISClient().call('report_sale', payload={'items': []})


class TerminalActivationTests(TestCase):
    """Test terminal activation flow"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(business=self.business, name='Main Branch', address='123 Main St', city='Lilongwe', country='Malawi')
        
        # Create TAC
        self.tac = TerminalActivationCode.objects.create(
            business=self.business,
            code='TAC-TEST-001',
            status='unused',
            expires_at=timezone.now() + timedelta(days=30)
        )

    def test_terminal_activation_success(self):
        """Test successful terminal activation"""
        terminal = TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code='TAC-TEST-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            device_serial='DEVICE-001',
            mac_address='00:1A:2B:3C:4D:5E'
        )

        self.assertIsNotNone(terminal)
        self.assertEqual(terminal.status, 'pending_activation')
        self.assertEqual(terminal.pos_name, 'Handy POS')
        self.assertEqual(terminal.os_type, 'Web')

    def test_activation_uses_official_mra_payload_shape(self):
        """Activation should send MRA's nested platform/POS payload."""
        prepared_result = MRACallResult(
            ok=True,
            dry_run=True,
            status_code=202,
            endpoint='https://dev-eis-api.mra.mw/api/v1/onboarding/activate-terminal',
            data={'status': 'prepared'},
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=prepared_result) as call:
            TerminalService.activate_terminal(
                business=self.business,
                branch=self.branch,
                tac_code='TAC-TEST-001',
                pos_name='Handy POS',
                pos_version='1.2.3',
                os_type='Windows',
                device_serial='DEVICE-001',
                mac_address='00-1A-2B-3C-4D-5E',
            )

        payload = call.call_args.kwargs['payload']
        self.assertEqual(payload['terminalActivationCode'], 'TAC-TEST-001')
        self.assertEqual(payload['environment']['platform']['osName'], 'Windows')
        self.assertEqual(payload['environment']['platform']['macAddress'], '00-1A-2B-3C-4D-5E')
        self.assertEqual(payload['environment']['pos']['productVersion'], '1.2.3')

    def test_branch_can_have_one_terminal_per_device(self):
        """A branch may onboard separate devices without replacing its first terminal."""
        second_tac = TerminalActivationCode.objects.create(
            business=self.business,
            code='TAC-TEST-002',
            status='unused',
            expires_at=timezone.now() + timedelta(days=30),
        )

        first = TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code='TAC-TEST-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            device_serial='DEVICE-001',
        )
        second = TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code=second_tac.code,
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Android',
            device_serial='DEVICE-002',
        )

        self.assertNotEqual(first.id, second.id)
        self.assertEqual(Terminal.objects.filter(business=self.business, branch=self.branch).count(), 2)
        first.refresh_from_db()
        self.assertEqual(first.device_serial, 'DEVICE-001')

    def test_device_cannot_be_assigned_to_another_branch(self):
        """A physical device must not be silently moved to another branch."""
        other_branch = Branch.objects.create(
            business=self.business,
            name='Second Branch',
            address='456 Main St',
            city='Blantyre',
            country='Malawi',
        )
        second_tac = TerminalActivationCode.objects.create(
            business=self.business,
            code='TAC-TEST-SECOND-BRANCH',
            status='unused',
            expires_at=timezone.now() + timedelta(days=30),
        )

        TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code=self.tac.code,
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Windows',
            device_serial='DEVICE-BOUND',
        )

        with self.assertRaisesMessage(ValueError, 'already assigned to Main Branch'):
            TerminalService.activate_terminal(
                business=self.business,
                branch=other_branch,
                tac_code=second_tac.code,
                pos_name='Handy POS',
                pos_version='1.0.0',
                os_type='Windows',
                device_serial=' device-bound ',
            )

        self.assertEqual(Terminal.objects.filter(business=self.business).count(), 1)
        second_tac.refresh_from_db()
        self.assertEqual(second_tac.status, 'unused')

    def test_live_activation_response_saves_mra_terminal_details(self):
        """Identifiers and credentials returned by MRA are stored locally."""
        live_result = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis-api.mra.mw/api/v1/onboarding/activate-terminal',
            data={
                'status': 'active',
                'data': {
                    'activatedTerminal': {
                        'terminalId': 'MRA-TERM-001',
                        'taxpayerId': 987654,
                        'terminalPosition': 3,
                        'terminalCredentials': {
                            'jwtToken': 'jwt-from-mra',
                            'secretKey': 'secret-from-mra',
                        },
                    }
                },
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=live_result):
            terminal = TerminalService.activate_terminal(
                business=self.business,
                branch=self.branch,
                tac_code=self.tac.code,
                pos_name='Handy POS',
                pos_version='1.0.0',
                os_type='Windows',
                device_serial='DEVICE-LIVE',
            )

        terminal.refresh_from_db()
        self.assertEqual(terminal.status, 'active')
        self.assertEqual(terminal.mra_terminal_id, 'MRA-TERM-001')
        self.assertEqual(terminal.mra_taxpayer_id, 987654)
        self.assertEqual(terminal.terminal_position, 3)
        self.assertEqual(terminal.mra_token, 'jwt-from-mra')
        self.assertEqual(terminal.mra_api_key, 'secret-from-mra')

    def test_live_activation_rejection_does_not_create_terminal(self):
        """A rejected MRA response must not consume the TAC or look successful."""
        rejected_result = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis-api.mra.mw/api/v1/onboarding/activate-terminal',
            data={'statusCode': -1, 'remark': 'Invalid terminal activation code'},
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=rejected_result):
            with self.assertRaisesMessage(MRAIntegrationError, 'Invalid terminal activation code'):
                TerminalService.activate_terminal(
                    business=self.business,
                    branch=self.branch,
                    tac_code=self.tac.code,
                    pos_name='Handy POS',
                    pos_version='1.0.0',
                    os_type='Windows',
                    device_serial='DEVICE-REJECTED',
                )

        self.assertFalse(Terminal.objects.filter(business=self.business).exists())
        self.tac.refresh_from_db()
        self.assertEqual(self.tac.status, 'unused')

    def test_tac_marked_as_used(self):
        """Test TAC is marked as used after activation"""
        terminal = TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code='TAC-TEST-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            device_serial='DEVICE-001'
        )

        self.tac.refresh_from_db()
        self.assertEqual(self.tac.status, 'used')
        self.assertEqual(self.tac.used_by_terminal, terminal)

    def test_tac_reuse_prevented(self):
        """Test TAC cannot be reused"""
        # First activation
        TerminalService.activate_terminal(
            business=self.business,
            branch=self.branch,
            tac_code='TAC-TEST-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            device_serial='DEVICE-001'
        )

        # Try to reuse TAC
        with self.assertRaises(ValueError):
            TerminalService.activate_terminal(
                business=self.business,
                branch=self.branch,
                tac_code='TAC-TEST-001',
                pos_name='Handy POS 2',
                pos_version='1.0.0',
                os_type='Web',
                device_serial='DEVICE-002'
            )

    def test_expired_tac_rejected(self):
        """Test expired TAC is rejected"""
        expired_tac = TerminalActivationCode.objects.create(
            business=self.business,
            code='TAC-EXPIRED',
            status='unused',
            expires_at=timezone.now() - timedelta(days=1)
        )

        with self.assertRaises(ValueError):
            TerminalService.activate_terminal(
                business=self.business,
                branch=self.branch,
                tac_code='TAC-EXPIRED',
                pos_name='Handy POS',
                pos_version='1.0.0',
                os_type='Web',
                device_serial='DEVICE-001'
            )


class ConfigurationTests(TestCase):
    """Test configuration management"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-CONFIG-001',
            device_serial='DEVICE-CONFIG-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-CONFIG-001',
            mra_api_key='test-key',
            mra_token='test-token',
            status='active',
            is_online=True,
        )

    def test_configuration_storage(self):
        """Test configuration is stored immutably"""
        config = MRAConfiguration.objects.create(
            business=self.business,
            config_type='tax_rules',
            config_version='1.0',
            config_data={'standard': 16.5, 'zero': 0, 'exempt': 0},
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True
        )

        self.assertIsNotNone(config)
        self.assertEqual(config.config_type, 'tax_rules')
        self.assertTrue(config.is_current())

    def test_configuration_versioning(self):
        """Test configuration versioning"""
        config1 = MRAConfiguration.objects.create(
            business=self.business,
            config_type='tax_rules',
            config_version='1.0',
            config_data={'standard': 16.5},
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True
        )

        config2 = MRAConfiguration.objects.create(
            business=self.business,
            config_type='tax_rules',
            config_version='2.0',
            config_data={'standard': 17.0},
            effective_from=timezone.now() + timedelta(days=1),
            fetched_from_mra_at=timezone.now(),
            is_active=True
        )

        current = ConfigurationService.get_active_configuration(
            self.business,
            'tax_rules'
        )
        self.assertEqual(current.config_version, '1.0')

    def test_store_configuration_response_supports_official_mra_shape(self):
        response = {
            'statusCode': 1,
            'data': {
                'globalConfiguration': {'versionNo': 4, 'taxRates': []},
                'terminalConfiguration': {'versionNo': 2, 'receiptFormat': 'compact'},
                'taxpayerConfiguration': {
                    'versionNo': 8,
                    'tin': 'TIN-001',
                    'isVATRegistered': True,
                    'vatRegistrationNumber': 'VAT-001',
                    'taxpayerType': 'VAT',
                },
                'terminalSiteProducts': [
                    {'productCode': 'FOOD-001', 'name': 'Prepared meal'},
                ],
            },
        }

        stored = ConfigurationService.store_configuration_response(
            self.business,
            response,
            config_types=[
                'global_configuration',
                'terminal_configuration',
                'taxpayer_configuration',
                'product_codes',
            ],
        )

        versions = {config.config_type: config.config_version for config in stored}
        self.assertEqual(versions['global_configuration'], '4')
        self.assertEqual(versions['terminal_configuration'], '2')
        self.assertEqual(versions['taxpayer_configuration'], '8')
        self.assertTrue(versions['product_codes'].startswith('sync-product_codes-'))
        self.business.refresh_from_db()
        self.assertEqual(self.business.tin, 'TIN-001')
        self.assertTrue(self.business.vat_registered)
        self.assertEqual(self.business.vat_registration_number, 'VAT-001')
        self.assertEqual(self.business.mra_taxpayer_type, 'VAT')
        self.assertEqual(stored[-1].config_data['items'][0]['productCode'], 'FOOD-001')

    def test_product_catalog_normalizes_official_terminal_site_products(self):
        config = MRAConfiguration.objects.create(
            business=self.business,
            config_type='product_codes',
            config_version='catalog-1',
            config_data={
                'items': [
                    {
                        'ProductCode': 'food-002',
                        'ProductName': 'Rice plate',
                        'TaxType': 'ZERO_RATED',
                        'TaxRate': 0,
                        'UnitMeasure': 'piece',
                        'ProductLevies': [
                            {'LevyTypeId': 'TOURISM', 'LevyRate': '2.50'},
                        ],
                    },
                ],
            },
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        products, snapshot = ConfigurationService.get_product_catalog(self.business)

        self.assertEqual(snapshot.id, config.id)
        self.assertEqual(products[0]['code'], 'FOOD-002')
        self.assertEqual(products[0]['name'], 'Rice plate')
        self.assertEqual(products[0]['default_tax_type'], 'zero')
        self.assertEqual(products[0]['default_tax_rate'], 0.0)
        self.assertEqual(products[0]['unit_measure'], 'unit')
        self.assertEqual(products[0]['levies'][0]['LevyTypeId'], 'TOURISM')


    def test_repeated_configuration_version_is_idempotent_and_keeps_snapshot(self):
        response = {
            'data': {
                'globalConfiguration': {
                    'versionNo': 7,
                    'taxRates': [{'rate': 16.5}],
                },
            },
        }
        first = ConfigurationService.store_configuration_response(
            self.business,
            response,
            config_types=['global_configuration'],
        )[0]
        response['data']['globalConfiguration']['changedAfterFetch'] = True
        second = ConfigurationService.store_configuration_response(
            self.business,
            response,
            config_types=['global_configuration'],
        )[0]

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            MRAConfiguration.objects.filter(
                business=self.business,
                config_type='global_configuration',
                config_version='7',
            ).count(),
            1,
        )
        second.refresh_from_db()
        self.assertNotIn('changedAfterFetch', second.config_data)

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_fetch_configuration_uses_active_terminal_and_records_sync(self):
        response = {
            'statusCode': 1,
            'data': {
                'globalConfiguration': {'versionNo': 5, 'taxRates': []},
                'taxpayerConfiguration': {'versionNo': 9, 'tin': 'TIN-FETCHED'},
            },
        }
        result = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='/api/v1/utilities/get-latest-config',
            data=response,
        )

        with patch.object(MRAEISClient, 'call', return_value=result) as mocked_call:
            sync_log = ConfigurationService.fetch_and_store_configuration(
                self.business,
                config_types=['global_configuration', 'taxpayer_configuration'],
            )

        self.assertEqual(sync_log.status, 'success')
        self.assertEqual(mocked_call.call_args.args[0], 'get_latest_config')
        self.assertEqual(
            MRAConfiguration.objects.filter(business=self.business, is_active=True).count(),
            2,
        )
        self.terminal.refresh_from_db()
        self.assertIsNotNone(self.terminal.last_sync_at)
        self.assertTrue(self.terminal.audit_logs.filter(action='configuration_updated').exists())
        self.business.refresh_from_db()
        self.assertEqual(self.business.tin, 'TIN-FETCHED')

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_failed_configuration_response_preserves_previous_active_version(self):
        previous = MRAConfiguration.objects.create(
            business=self.business,
            config_type='tax_rules',
            config_version='1',
            config_data={'standard': 16.5},
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )
        rejected = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='/api/v1/utilities/get-latest-config',
            data={'statusCode': -1, 'remark': 'Terminal configuration unavailable'},
        )

        with patch.object(MRAEISClient, 'call', return_value=rejected):
            with self.assertRaisesMessage(MRAIntegrationError, 'Terminal configuration unavailable'):
                ConfigurationService.fetch_and_store_configuration(
                    self.business,
                    config_types=['tax_rules'],
                    terminal=self.terminal,
                )

        previous.refresh_from_db()
        self.assertTrue(previous.is_active)
        self.assertIsNone(previous.effective_to)
        self.assertEqual(ConfigurationSyncLog.objects.latest('created_at').status, 'failed')

    def test_offline_limits_are_extracted_from_system_settings(self):
        """Offline policy should be parsed from MRA configuration payloads."""
        MRAConfiguration.objects.create(
            business=self.business,
            config_type='system_settings',
            config_version='2026.02',
            config_data={
                'offlineLimit': {
                    'maxTransactionAgeInHours': 72,
                    'maxCummulativeAmount': '2500000.00',
                }
            },
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        limits = ConfigurationService.get_offline_limits(self.business)
        self.assertEqual(limits.max_transaction_age_hours, 72)
        self.assertEqual(limits.max_cumulative_amount, Decimal('2500000.00'))
        self.assertIn('system_settings', str(limits.source))


class ProductMappingTests(TestCase):
    """Test product mapping"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)

    def test_product_mapping_creation(self):
        """Test product mapping creation"""
        mapping = ProductMappingService.create_product_mapping(
            business=self.business,
            inventory_item_id='item-001',
            product_name='Coca Cola 500ml',
            mra_product_code='BEVERAGE-001',
            mra_product_name='Soft Drink',
            tax_category='standard',
            approved_price=Decimal('2500.00'),
            tax_rate=Decimal('16.50')
        )

        self.assertIsNotNone(mapping)
        self.assertEqual(mapping.mra_product_code, 'BEVERAGE-001')
        self.assertTrue(mapping.is_approved)

    def test_product_validation_for_sale(self):
        """Test product validation for sale"""
        mapping = ProductMappingService.create_product_mapping(
            business=self.business,
            inventory_item_id='item-001',
            product_name='Coca Cola 500ml',
            mra_product_code='BEVERAGE-001',
            mra_product_name='Soft Drink',
            tax_category='standard',
            approved_price=Decimal('2500.00'),
            tax_rate=Decimal('16.50')
        )

        # Should validate successfully
        validated = ProductMappingService.validate_product_for_sale(
            self.business,
            'item-001'
        )
        self.assertEqual(validated.mra_product_code, 'BEVERAGE-001')

    def test_unapproved_product_rejected(self):
        """Test unapproved product is rejected"""
        with self.assertRaises(ValueError):
            ProductMappingService.validate_product_for_sale(
                self.business,
                'item-nonexistent'
            )

    @override_settings(MRA_EIS_STRICT_PRODUCT_CODES=True)
    def test_inventory_mapping_uses_synced_catalog_and_rejects_unknown_code(self):
        MRAConfiguration.objects.create(
            business=self.business,
            config_type='product_codes',
            config_version='catalog-1',
            config_data={
                'items': [
                    {
                        'productCode': 'FOOD-010',
                        'name': 'Prepared meal from MRA',
                        'taxType': 'standard',
                        'taxRate': '16.5',
                        'unitMeasure': 'unit',
                        'levies': [
                            {'levyTypeId': 'TOURISM', 'levyRate': '2.50'},
                        ],
                    },
                ],
            },
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        normalized = ProductMappingService.apply_catalog_defaults(
            self.business,
            {
                'mra_product_code': 'food-010',
                'mra_product_name': 'Stale local label',
                'mra_tax_type': 'zero',
                'mra_tax_rate': Decimal('0.00'),
                'mra_unit_measure': 'unit',
                'tax_calculation_method': 'inclusive',
            },
        )

        self.assertEqual(normalized['mra_product_code'], 'FOOD-010')
        self.assertEqual(normalized['mra_product_name'], 'Prepared meal from MRA')
        self.assertEqual(normalized['mra_tax_type'], 'standard')
        self.assertEqual(normalized['mra_tax_rate'], Decimal('16.50'))
        self.assertEqual(
            normalized['mra_levies'],
            [{'levyTypeId': 'TOURISM', 'levyRate': 2.5}],
        )

        with self.assertRaisesMessage(MRAIntegrationError, 'not present in the active terminal catalog'):
            ProductMappingService.apply_catalog_defaults(
                self.business,
                {
                    'mra_product_code': 'UNKNOWN-999',
                    'mra_product_name': 'Unknown',
                    'mra_tax_type': 'standard',
                    'mra_tax_rate': Decimal('16.50'),
                    'mra_unit_measure': 'unit',
                    'tax_calculation_method': 'inclusive',
                },
            )


class WarehouseInventoryTests(TransactionTestCase):
    """Warehouse stock must remain an EIS-only, portal-backed flow."""

    def setUp(self):
        self.user = User.objects.create_user(email='warehouse@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Warehouse Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
            mra_site_id='SITE-001',
        )
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-WAREHOUSE-001',
            device_serial='DEVICE-WAREHOUSE-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-WAREHOUSE-001',
            mra_api_key='test-key',
            mra_token='test-token',
            status='active',
        )

    def test_warehouse_rows_support_data_list_response(self):
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='/api/v1/stock/warehouse-inventory',
            data={
                'data': [
                    {
                        'productCode': 'P-001',
                        'productName': 'Portal Product',
                        'currentQuantity': '12',
                    },
                ],
            },
        )

        with patch.object(MRAEISClient, 'call', return_value=response) as call:
            result = ProductMappingService.fetch_warehouse_inventory(
                business=self.business,
                terminal=self.terminal,
                page_size=200,
                max_pages=25,
            )

        self.assertEqual(result['stock_count'], 1)
        self.assertEqual(result['stocks'][0]['productCode'], 'P-001')
        call.assert_called_once()

    def test_transfer_uses_branch_mra_site_id(self):
        destination = Branch.objects.create(
            business=self.business,
            name='Second Branch',
            address='456 Main St',
            city='Blantyre',
            country='Malawi',
            mra_site_id='SITE-002',
        )
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='/api/v1/stock/transfer-inventory',
            data={'statusCode': 0},
        )

        with patch.object(MRAEISClient, 'call', return_value=response) as call:
            result = ProductMappingService.transfer_inventory(
                business=self.business,
                terminal=self.terminal,
                to_branch=destination,
                items=[{'barcode': 'P-001', 'quantity': '2'}],
            )

        self.assertEqual(result['payload']['toSiteId'], 'SITE-002')
        self.assertEqual(result['payload']['items'], [{'barcode': 'P-001', 'quantity': 2.0}])
        call.assert_called_once()

    def test_reconcile_reports_quantity_mismatches_and_missing_mappings(self):
        matching_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Matching product',
            item_type='sellable',
            stock_units=10,
        )
        InventoryMRAProductMapping.objects.create(
            inventory_item=matching_item,
            branch=self.branch,
            mra_product_code='P-001',
            mra_product_name='Matching product',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            is_approved=True,
            mra_synced=True,
        )
        mismatch_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Mismatched product',
            item_type='sellable',
            stock_units=4,
        )
        InventoryMRAProductMapping.objects.create(
            inventory_item=mismatch_item,
            branch=self.branch,
            mra_product_code='P-002',
            mra_product_name='Mismatched product',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            is_approved=True,
            mra_synced=True,
        )

        with patch.object(
            ProductMappingService,
            'fetch_warehouse_inventory',
            return_value={
                'dry_run': False,
                'endpoint': '/api/v1/stock/warehouse-inventory',
                'stocks': [
                    {'productCode': 'P-001', 'productName': 'Matching product', 'currentQuantity': '10'},
                    {'productCode': 'P-002', 'productName': 'Mismatched product', 'currentQuantity': '7'},
                    {'productCode': 'P-003', 'productName': 'Not yet mapped', 'currentQuantity': '2'},
                ],
            },
        ):
            result = ProductMappingService.reconcile_inventory_with_eis(
                business=self.business,
                terminal=self.terminal,
                branch=self.branch,
            )

        self.assertEqual(result['matched_count'], 1)
        self.assertEqual(result['quantity_mismatch_count'], 1)
        self.assertEqual(result['missing_in_pos_count'], 1)
        self.assertEqual(result['missing_in_eis_count'], 0)
        self.assertEqual(result['quantity_mismatches'][0]['difference'], '-3.000')


class InvoiceTests(TransactionTestCase):
    """Test invoice creation and submission"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(business=self.business, name='Main', address='123 Main St', city='Lilongwe', country='Malawi')
        
        # Create terminal
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-001',
            device_serial='DEVICE-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-001',
            mra_api_key='test-key',
            status='active',
            is_online=True
        )

    def test_invoice_creation(self):
        """Test invoice creation"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('2'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        self.assertIsNotNone(invoice)
        self.assertEqual(invoice.status, 'draft')
        self.assertEqual(invoice.invoice_number, 1)
        self.assertEqual(invoice.net_amount, Decimal('5000.00'))
        self.assertEqual(invoice.tax_amount, Decimal('825.00'))
        self.assertEqual(invoice.gross_amount, Decimal('5825.00'))

    def test_invoice_signature_generation(self):
        """Test invoice signature is generated"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        self.assertIsNotNone(invoice.invoice_signature)
        self.assertEqual(len(invoice.invoice_signature), 64)  # SHA256 hex length

    def test_online_invoice_hash_validation_passes(self):
        """Online invoice hash validation should pass for untouched invoice."""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True,
        )

        self.assertTrue(InvoiceService.verify_invoice_hash(invoice))

    def test_online_invoice_hash_validation_detects_tamper(self):
        """Online invoice hash validation should fail if signed content is changed."""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True,
        )

        invoice.items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Tampered Item',
                'quantity': '1.000',
                'unit_price': '2500.00',
                'tax_rate': '16.50',
                'tax_category': 'standard',
            }
        ]
        invoice.save(update_fields=['items', 'updated_at'])

        self.assertFalse(InvoiceService.verify_invoice_hash(invoice))

    def test_offline_invoice_hash_validation_passes(self):
        """Offline invoice hash validation should pass for untouched invoice."""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False,
        )

        self.assertTrue(InvoiceService.verify_invoice_hash(invoice))

    def test_sequential_invoice_numbering(self):
        """Test invoices are numbered sequentially"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice1 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        invoice2 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        self.assertEqual(invoice1.invoice_number, 1)
        self.assertEqual(invoice2.invoice_number, 2)

    def test_tax_breakdown(self):
        """Test tax breakdown calculation"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            },
            {
                'mra_product_code': 'FOOD-001',
                'name': 'Bread',
                'quantity': Decimal('1'),
                'unit_price': Decimal('1000.00'),
                'tax_rate': Decimal('0'),
                'tax_category': 'zero',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        self.assertEqual(Decimal(str(invoice.tax_breakdown['standard'])), Decimal('412.50'))
        self.assertEqual(Decimal(str(invoice.tax_breakdown['zero'])), Decimal('0'))

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_blocked_terminal_cannot_create_standalone_online_invoice(self):
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/get-terminal-blocking-message',
            data={
                'statusCode': 1,
                'data': {'isBlocked': True, 'blockingReason': 'Terminal suspended by MRA'},
                'errors': [],
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=response) as call:
            with self.assertRaisesMessage(
                MRAIntegrationError,
                'MRA terminal is blocked: Terminal suspended by MRA',
            ):
                InvoiceService.create_invoice(
                    terminal=self.terminal,
                    seller_tin='1234567890',
                    seller_name='Test Business',
                    items=[
                        {
                            'mra_product_code': 'BEVERAGE-001',
                            'name': 'Coca Cola 500ml',
                            'quantity': Decimal('1'),
                            'unit_price': Decimal('2500.00'),
                            'tax_rate': Decimal('0'),
                            'tax_category': 'zero',
                        }
                    ],
                    is_online=True,
                )

        self.terminal.refresh_from_db()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(self.terminal.online_invoice_counter, 0)
        self.assertFalse(MRAInvoice.objects.filter(terminal=self.terminal).exists())

    def test_suspended_terminal_cannot_create_offline_invoice(self):
        self.terminal.status = 'suspended'
        self.terminal.save(update_fields=['status', 'updated_at'])

        with self.assertRaisesMessage(MRAIntegrationError, 'MRA terminal is blocked'):
            InvoiceService.create_invoice(
                terminal=self.terminal,
                seller_tin='1234567890',
                seller_name='Test Business',
                items=[
                    {
                        'mra_product_code': 'BEVERAGE-001',
                        'name': 'Coca Cola 500ml',
                        'quantity': Decimal('1'),
                        'unit_price': Decimal('2500.00'),
                        'tax_rate': Decimal('0'),
                        'tax_category': 'zero',
                    }
                ],
                is_online=False,
            )

        self.terminal.refresh_from_db()
        self.assertEqual(self.terminal.offline_invoice_counter, 0)
        self.assertFalse(MRAInvoice.objects.filter(terminal=self.terminal).exists())
    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_nested_accepted_invoice_response_saves_fiscal_evidence(self):
        with override_settings(MRA_EIS_DRY_RUN=True):
            invoice = InvoiceService.create_invoice(
                terminal=self.terminal,
                seller_tin='1234567890',
                seller_name='Test Business',
                items=[
                    {
                        'mra_product_code': 'BEVERAGE-001',
                        'name': 'Coca Cola 500ml',
                        'quantity': Decimal('1'),
                        'unit_price': Decimal('2500.00'),
                        'tax_rate': Decimal('0'),
                        'tax_category': 'zero',
                    }
                ],
                is_online=True,
            )

        accepted = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/report-sale',
            data={
                'statusCode': 1,
                'data': {
                    'invoiceId': 'MRA-INVOICE-001',
                    'eisUuid': 'EIS-INVOICE-001',
                    'qrCodePayload': 'QR-INVOICE-001',
                },
                'errors': [],
            },
        )

        with patch.object(TerminalService, 'ensure_terminal_ready_for_sale', return_value={}):
            with patch('mra_eis.services.MRAEISClient.call', return_value=accepted):
                InvoiceService.submit_invoice(invoice)

        invoice.refresh_from_db()
        self.assertEqual(invoice.status, 'submitted')
        self.assertEqual(invoice.mra_invoice_id, 'MRA-INVOICE-001')


class OfflineInvoiceTests(TransactionTestCase):
    """Test offline invoice queuing and sync"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(business=self.business, name='Main', address='123 Main St', city='Lilongwe', country='Malawi')
        
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-001',
            device_serial='DEVICE-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-001',
            mra_api_key='test-key',
            status='active',
            is_online=False
        )

    def test_offline_invoice_queuing(self):
        """Test offline invoice is queued"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False
        )

        queue_entry = InvoiceService.queue_offline_invoice(invoice)

        self.assertIsNotNone(queue_entry)
        self.assertEqual(queue_entry.status, 'queued')
        self.assertEqual(queue_entry.queue_position, 1)
        self.assertEqual(invoice.status, 'offline_queued')

    def test_offline_queue_ordering(self):
        """Test offline queue maintains order"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice1 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False
        )
        queue1 = InvoiceService.queue_offline_invoice(invoice1)

        invoice2 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False
        )
        queue2 = InvoiceService.queue_offline_invoice(invoice2)

        self.assertEqual(queue1.queue_position, 1)
        self.assertEqual(queue2.queue_position, 2)

    def test_sync_offline_invoices_rejects_expired_offline_transaction(self):
        """Queued offline invoices older than MRA limit should fail before submission."""
        MRAConfiguration.objects.create(
            business=self.business,
            config_type='system_settings',
            config_version='1.0',
            config_data={
                'offlineLimit': {
                    'maxTransactionAgeInHours': 1,
                    'maxCummulativeAmount': '9999999.00',
                }
            },
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]
        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False,
        )
        queue_entry = InvoiceService.queue_offline_invoice(invoice)
        invoice.invoice_date = timezone.now() - timedelta(hours=2)
        invoice.save(update_fields=['invoice_date'])

        self.terminal.is_online = True
        self.terminal.save(update_fields=['is_online'])
        result = InvoiceService.sync_offline_invoices(self.terminal)

        queue_entry.refresh_from_db()
        self.assertEqual(result['synced'], 0)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(queue_entry.status, 'failed')
        self.assertIn('age exceeds configured limit', queue_entry.last_sync_error.lower())

    def test_offline_sync_stops_at_first_failed_invoice(self):
        """A later offline invoice must wait behind an unresolved earlier one."""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('0'),
                'tax_category': 'zero',
            }
        ]
        invoice1 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False,
        )
        invoice2 = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=False,
        )
        queue1 = InvoiceService.queue_offline_invoice(invoice1)
        queue2 = InvoiceService.queue_offline_invoice(invoice2)

        with patch.object(
            InvoiceService,
            'submit_invoice',
            side_effect=MRAIntegrationError('temporary MRA outage'),
        ) as submit:
            result = InvoiceService.sync_offline_invoices(self.terminal)

        queue1.refresh_from_db()
        queue2.refresh_from_db()
        self.assertEqual(result, {'synced': 0, 'failed': 1})
        self.assertEqual(queue1.status, 'failed')
        self.assertEqual(queue2.status, 'queued')
        submit.assert_called_once_with(queue1.mra_invoice)

    def test_submitted_invoice_is_not_sent_again(self):
        """A replay after local success must not make a second MRA request."""
        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=[
                {
                    'mra_product_code': 'BEVERAGE-001',
                    'name': 'Coca Cola 500ml',
                    'quantity': Decimal('1'),
                    'unit_price': Decimal('2500.00'),
                    'tax_rate': Decimal('0'),
                    'tax_category': 'zero',
                }
            ],
            is_online=False,
        )
        invoice.status = 'offline_synced'
        invoice.save(update_fields=['status', 'updated_at'])

        with patch('mra_eis.services.MRAEISClient.call') as call:
            submitted = InvoiceService.submit_invoice(invoice)

        self.assertEqual(submitted.id, invoice.id)
        call.assert_not_called()

    @override_settings(
        MRA_EIS_DRY_RUN=True,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_dry_run_offline_sync_remains_queued(self):
        """A dry-run replay must remain queued until MRA accepts it for real."""
        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=[
                {
                    'mra_product_code': 'BEVERAGE-001',
                    'name': 'Coca Cola 500ml',
                    'quantity': Decimal('1'),
                    'unit_price': Decimal('2500.00'),
                    'tax_rate': Decimal('0'),
                    'tax_category': 'zero',
                }
            ],
            is_online=False,
        )
        queue_entry = InvoiceService.queue_offline_invoice(invoice)
        self.terminal.is_online = True
        self.terminal.save(update_fields=['is_online'])

        result = InvoiceService.sync_offline_invoices(self.terminal)

        queue_entry.refresh_from_db()
        invoice.refresh_from_db()
        self.assertEqual(result, {'synced': 0, 'failed': 0})
        self.assertEqual(queue_entry.status, 'queued')
        self.assertEqual(invoice.status, 'offline_queued')
        self.assertIn('dry-run mode', queue_entry.last_sync_error.lower())


class POSOfflineComplianceTests(TransactionTestCase):
    """Test MRA offline compliance rules on POS order submission flow."""

    def setUp(self):
        self.user = User.objects.create_user(email='pos@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='POS Compliance Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-POS-001',
            device_serial='DEVICE-POS-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-POS-001',
            mra_api_key='test-terminal-secret',
            status='active',
            is_online=False,
        )

    def _create_pos_order(self, *, order_number: int, amount: Decimal):
        from pos_sessions.models import Order, OrderItem

        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=order_number,
            status='Completed',
            payment_method='Cash',
            subtotal=amount,
            total=amount,
            net_amount=amount,
            vat_amount=Decimal('0'),
            gross_amount=amount,
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=f'ITEM-{order_number}',
            name='Test Item',
            quantity=Decimal('1'),
            price=amount,
            subtotal=amount,
            tax_amount=Decimal('0'),
            total=amount,
        )
        return order

    @override_settings(MRA_EIS_ENFORCE_TERMINAL_DEVICE_BINDING=True)
    def test_live_device_binding_rejects_wrong_device(self):
        with self.assertRaisesMessage(MRAIntegrationError, 'not the activated MRA EIS terminal'):
            TerminalService.enforce_terminal_device_binding(
                self.terminal,
                'DEVICE-POS-OTHER',
            )

    @override_settings(MRA_EIS_ENFORCE_TERMINAL_DEVICE_BINDING=True)
    def test_live_device_binding_accepts_activated_device(self):
        TerminalService.enforce_terminal_device_binding(
            self.terminal,
            ' device-pos-001 ',
        )
        self.terminal.refresh_from_db()
        self.assertEqual(self.terminal.device_serial, 'DEVICE-POS-001')

    @override_settings(MRA_EIS_REQUIRE_OFFLINE_REPLAY_SEQUENCE_GUARD=True)
    def test_empty_mra_offline_history_allows_first_replay(self):
        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='POS Compliance Business',
            items=[
                {
                    'mra_product_code': 'SKU-FIRST-REPLAY',
                    'name': 'First Replay Item',
                    'quantity': Decimal('1'),
                    'unit_price': Decimal('300.00'),
                    'tax_rate': Decimal('0'),
                    'tax_category': 'zero',
                }
            ],
            is_online=False,
        )
        queue_entry = InvoiceService.queue_offline_invoice(invoice)

        result = InvoiceService._validate_offline_replay_sequence_guard(
            self.terminal,
            queue_entry,
            {'statusCode': -1, 'remark': 'No transaction found'},
            queued_entries=[queue_entry],
        )

        self.assertTrue(result['checked'])
        self.assertEqual(result['remote_sequence'], 0)
        self.assertEqual(result['queue_sequence_plan'][0]['sequence'], 1)

    def test_offline_cumulative_limit_blocks_new_pos_submission(self):
        """POS offline submission should fail when queue exceeds configured cap."""
        MRAConfiguration.objects.create(
            business=self.business,
            config_type='system_settings',
            config_version='2.0',
            config_data={
                'offlineLimit': {
                    'maxTransactionAgeInHours': 72,
                    'maxCummulativeAmount': '1000.00',
                }
            },
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        # Existing queued offline invoice of 900.
        queued_invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='POS Compliance Business',
            items=[
                {
                    'mra_product_code': 'SKU-900',
                    'name': 'Queued Item',
                    'quantity': Decimal('1'),
                    'unit_price': Decimal('900.00'),
                    'tax_rate': Decimal('0'),
                    'tax_category': 'zero',
                }
            ],
            is_online=False,
        )
        InvoiceService.queue_offline_invoice(queued_invoice)

        # New order pushes projected total to 1100 > 1000 cap.
        order = self._create_pos_order(order_number=5001, amount=Decimal('200.00'))
        with self.assertRaises(MRAIntegrationError):
            POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=False)

    def test_offline_pos_submission_generates_signature_and_queues_invoice(self):
        """Offline POS prepare should attach offline signature and queue invoice for replay."""
        order = self._create_pos_order(order_number=5002, amount=Decimal('300.00'))

        with patch('mra_eis.services.MRAEISClient.call') as call:
            result = POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=False)
        order.refresh_from_db()

        call.assert_not_called()
        self.assertTrue(result.get('dry_run'))
        self.assertIsNotNone(result.get('offline_signature'))
        self.assertEqual(order.eis_status, 'PENDING')
        self.assertEqual(order.digital_signature, result.get('offline_signature'))

        mra_invoice = MRAInvoice.objects.filter(
            terminal=self.terminal,
            is_online=False,
            mra_response__order_id=str(order.id),
        ).first()
        self.assertIsNotNone(mra_invoice)
        self.assertEqual(mra_invoice.status, 'offline_queued')
        self.assertEqual(mra_invoice.invoice_signature, result.get('offline_signature'))
        self.assertTrue(OfflineInvoiceQueue.objects.filter(mra_invoice=mra_invoice).exists())

    def test_offline_replay_updates_source_pos_order(self):
        """Successful replay marks the original POS order submitted and locked."""
        order = self._create_pos_order(order_number=5003, amount=Decimal('300.00'))
        POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=False)

        self.terminal.is_online = True
        self.terminal.save(update_fields=['is_online'])
        result = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/report-sale-offline',
            data={
                'invoiceId': 'MRA-OFFLINE-5003',
                'eisUuid': 'EIS-OFFLINE-5003',
                'qrCodePayload': 'QR-OFFLINE-5003',
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=result):
            sync_result = InvoiceService.sync_offline_invoices(self.terminal)

        order.refresh_from_db()
        self.assertEqual(sync_result, {'synced': 1, 'failed': 0})
        self.assertEqual(order.eis_status, 'SUBMITTED')
        self.assertEqual(order.eis_uuid, 'MRA-OFFLINE-5003')
        self.assertEqual(order.qr_code_payload, 'QR-OFFLINE-5003')
        self.assertTrue(order.is_fiscal_locked)

    def test_recipe_sale_uses_mapped_finished_product_only(self):
        """EIS receives the produced meal, while ingredients stay internal."""
        from pos_sessions.models import Order, OrderItem

        ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef',
            item_type='ingredient',
            stock_units=Decimal('10.000'),
            unit_type='kg',
            is_recipe_ingredient=True,
        )
        meal = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Nsima Beef',
            category='Meals',
            item_type='sellable',
            stock_units=Decimal('0.000'),
            unit_type='unit',
            price=Decimal('6500.00'),
            is_produced=True,
            recipe=[
                {
                    'ingredientId': str(ingredient.id),
                    'inventoryItemId': str(ingredient.id),
                    'name': 'Beef',
                    'quantity': '0.250',
                    'unit': 'kg',
                }
            ],
        )
        InventoryMRAProductMapping.objects.create(
            inventory_item=meal,
            branch=self.branch,
            mra_product_code='MEAL-001',
            mra_product_name='Nsima Beef Meal',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            tax_calculation_method='inclusive',
            mra_levies=[{'levyTypeId': 'TOURISM', 'levyRate': 2.50}],
            is_approved=True,
            mra_synced=True,
        )
        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=5101,
            status='Completed',
            payment_method='Cash',
            subtotal=Decimal('6500.00'),
            total=Decimal('6500.00'),
            net_amount=Decimal('6500.00'),
            vat_amount=Decimal('0.00'),
            gross_amount=Decimal('6662.50'),
            charges_snapshot=[
                {
                    'source': 'mra',
                    'chargeType': 'LEVY',
                    'levyTypeId': 'TOURISM',
                    'amount': 162.50,
                }
            ],
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(meal.id),
            name='Nsima Beef',
            quantity=Decimal('1.000'),
            price=Decimal('6500.00'),
            subtotal=Decimal('6500.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('6500.00'),
            recipe=meal.recipe,
        )

        payload = POSOrderSubmissionService.build_pos_order_payload(
            order,
            self.terminal,
            is_online=True,
        )

        self.assertEqual(len(payload['items']), 1)
        self.assertEqual(payload['items'][0]['inventoryItemId'], str(meal.id))
        self.assertEqual(payload['items'][0]['productCode'], 'MEAL-001')
        self.assertEqual(payload['items'][0]['productName'], 'Nsima Beef Meal')
        self.assertEqual(payload['items'][0]['levies'][0]['levyTypeId'], 'TOURISM')
        self.assertEqual(payload['levyBreakDown'][0]['levyAmount'], '162.50')
        self.assertEqual(payload['grossAmount'], '6662.50')
        self.assertNotIn(str(ingredient.id), json.dumps(payload['items']))

    def test_recipe_sale_without_finished_product_mapping_is_rejected(self):
        """A recipe-only line cannot create an invalid EIS invoice."""
        from pos_sessions.models import Order, OrderItem

        meal = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Unmapped Meal',
            item_type='sellable',
            stock_units=Decimal('0.000'),
            unit_type='unit',
            price=Decimal('3000.00'),
            is_produced=True,
            recipe=[{'ingredientId': 'internal-ingredient', 'quantity': '1.000'}],
        )
        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=5102,
            status='Completed',
            payment_method='Cash',
            subtotal=Decimal('3000.00'),
            total=Decimal('3000.00'),
            net_amount=Decimal('3000.00'),
            vat_amount=Decimal('0.00'),
            gross_amount=Decimal('3000.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(meal.id),
            name='Unmapped Meal',
            quantity=Decimal('1.000'),
            price=Decimal('3000.00'),
            subtotal=Decimal('3000.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('3000.00'),
            recipe=meal.recipe,
        )

        with patch('mra_eis.services.MRAEISClient.call') as call:
            with self.assertRaises(MRAIntegrationError) as raised:
                POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=False)

        self.assertIn('mapped finished sellable product', str(raised.exception))
        self.assertIsNone(order.fiscal_invoice_number)
        call.assert_not_called()

    def test_online_pos_submission_is_idempotent_and_locks_order(self):
        """A successful retry must not submit or unlock the same fiscal sale twice."""
        from pos_sessions.models import Order, OrderItem

        order = self._create_pos_order(order_number=5103, amount=Decimal('300.00'))
        OrderItem.objects.create(
            order=order,
            inventory_item_id='ITEM-5103',
            name='Test Item',
            quantity=Decimal('1.000'),
            price=Decimal('300.00'),
            subtotal=Decimal('300.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('300.00'),
        )
        result = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/report-sale',
            data={
                'eisUuid': 'EIS-5103',
                'qrCodePayload': 'QR-5103',
                'digitalSignature': 'SIGNATURE-5103',
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=result) as call:
            first = POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=True)
            second = POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=True)

        order.refresh_from_db()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(first['fiscal_invoice_number'], second['fiscal_invoice_number'])
        self.assertTrue(second['already_submitted'])
        self.assertEqual(order.eis_status, 'SUBMITTED')
        self.assertTrue(order.is_fiscal_locked)

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_nested_accepted_pos_response_saves_fiscal_evidence(self):
        order = self._create_pos_order(order_number=5110, amount=Decimal('300.00'))
        accepted = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/report-sale',
            data={
                'statusCode': 1,
                'data': {
                    'invoiceId': 'MRA-POS-001',
                    'eisUuid': 'EIS-POS-001',
                    'qrCodePayload': 'QR-POS-001',
                    'digitalSignature': 'SIGNATURE-POS-001',
                },
                'errors': [],
            },
        )

        with patch.object(TerminalService, 'ensure_terminal_ready_for_sale', return_value={}):
            with patch('mra_eis.services.MRAEISClient.call', return_value=accepted):
                result = POSOrderSubmissionService.prepare_pos_order_submission(
                    order,
                    force_online=True,
                )

        order.refresh_from_db()
        mra_invoice = MRAInvoice.objects.get(
            terminal=self.terminal,
            invoice_number=1,
            is_online=True,
        )
        self.assertEqual(result['eis_status'], 'SUBMITTED')
        self.assertEqual(order.eis_uuid, 'EIS-POS-001')
        self.assertEqual(order.qr_code_payload, 'QR-POS-001')
        self.assertEqual(order.digital_signature, 'SIGNATURE-POS-001')
        self.assertEqual(mra_invoice.mra_invoice_id, 'MRA-POS-001')

    def test_mra_rejected_pos_order_is_not_queued_for_retry(self):
        """A live MRA validation rejection must stay out of the retry queue."""
        order = self._create_pos_order(order_number=5106, amount=Decimal('300.00'))
        rejected = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/report-sale',
            data={
                'statusCode': -1,
                'remark': 'Product is not mapped to this terminal',
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=rejected):
            with self.assertRaisesMessage(MRAResponseError, 'Product is not mapped to this terminal'):
                POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=True)

        order.refresh_from_db()
        self.assertIsNone(order.fiscal_invoice_number)
        self.assertEqual(order.eis_status, 'PENDING')
        self.assertFalse(
            SyncRetryQueue.objects.filter(
                terminal=self.terminal,
                operation_type='submit_pos_order',
            ).exists()
        )

    def test_retry_worker_fails_mra_rejection_without_rescheduling(self):
        """A queued validation rejection is failed for review, not retried."""
        order = self._create_pos_order(order_number=5107, amount=Decimal('300.00'))
        retry = RetryService.queue_retry(
            self.terminal,
            'submit_pos_order',
            {'order_id': str(order.id)},
        )

        with patch(
            'mra_eis.services.POSOrderSubmissionService.prepare_pos_order_submission',
            side_effect=MRAResponseError('MRA rejected report_sale: Invalid tax code'),
        ):
            result = RetryService.process_retry_queue()

        retry.refresh_from_db()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(retry.status, 'failed')
        self.assertEqual(retry.attempt_count, 1)
        self.assertIn('Invalid tax code', retry.last_error)

    def test_pos_order_retry_is_deduplicated(self):
        """Repeated connectivity failures keep one active retry per POS order."""
        order = self._create_pos_order(order_number=5104, amount=Decimal('300.00'))
        first = RetryService.queue_retry(
            self.terminal,
            'submit_pos_order',
            {'order_id': str(order.id)},
        )
        second = RetryService.queue_retry(
            self.terminal,
            'submit_pos_order',
            {'order_id': str(order.id)},
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            SyncRetryQueue.objects.filter(
                terminal=self.terminal,
                operation_type='submit_pos_order',
            ).count(),
            1,
        )

    def test_pos_order_retry_stays_pending_after_network_failure(self):
        """The retry worker must reschedule a failed online submission."""
        self.terminal.is_online = True
        self.terminal.save(update_fields=['is_online'])
        order = self._create_pos_order(order_number=5105, amount=Decimal('300.00'))

        with patch(
            'mra_eis.services.MRAEISClient.call',
            side_effect=MRAIntegrationError('temporary MRA outage'),
        ):
            prepared = POSOrderSubmissionService.prepare_pos_order_submission(
                order,
                force_online=True,
            )

        self.assertTrue(prepared.get('dry_run'))
        retry = SyncRetryQueue.objects.get(
            terminal=self.terminal,
            operation_type='submit_pos_order',
        )

        with patch(
            'mra_eis.services.MRAEISClient.call',
            side_effect=MRAIntegrationError('temporary MRA outage'),
        ):
            result = RetryService.process_retry_queue()

        retry.refresh_from_db()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(retry.status, 'pending')
        self.assertEqual(retry.attempt_count, 1)
        self.assertIn('temporary MRA outage', retry.last_error)

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_terminal_blocking_response_is_cached_and_suspends_terminal(self):
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/get-terminal-blocking-message',
            data={
                'statusCode': 1,
                'data': {
                    'isBlocked': True,
                    'blockingReason': 'MRA compliance review',
                    'blockedAt': '2026-08-31T08:00:00Z',
                },
                'errors': [],
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=response):
            result = TerminalService.get_terminal_blocking_message(self.terminal)

        self.terminal.refresh_from_db()
        self.assertTrue(result['is_blocked'])
        self.assertEqual(self.terminal.status, 'suspended')
        cached = TerminalService.get_cached_blocking_status(self.terminal)
        self.assertEqual(cached['blocking_reason'], 'MRA compliance review')
        self.assertEqual(cached['source'], 'mra_terminal_blocking_message')

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_unblock_response_reactivates_suspended_terminal(self):
        self.terminal.status = 'suspended'
        self.terminal.save(update_fields=['status', 'updated_at'])
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/check-terminal-unblock-status',
            data={
                'statusCode': 1,
                'data': {'isUnblocked': True, 'remark': 'Block cleared by MRA'},
                'errors': [],
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=response):
            result = TerminalService.check_terminal_unblock_status(self.terminal)

        self.terminal.refresh_from_db()
        self.assertTrue(result['is_unblocked'])
        self.assertEqual(self.terminal.status, 'active')

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_live_sale_is_rejected_before_fiscal_number_when_terminal_is_blocked(self):
        order = self._create_pos_order(order_number=5108, amount=Decimal('300.00'))
        response = MRACallResult(
            ok=True,
            dry_run=False,
            status_code=200,
            endpoint='https://eis.example/get-terminal-blocking-message',
            data={
                'statusCode': 1,
                'data': {'isBlocked': True, 'blockingReason': 'Terminal suspended by MRA'},
                'errors': [],
            },
        )

        with patch('mra_eis.services.MRAEISClient.call', return_value=response) as call:
            with self.assertRaisesMessage(
                MRAIntegrationError,
                'MRA terminal is blocked: Terminal suspended by MRA',
            ):
                POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=True)

        order.refresh_from_db()
        self.terminal.refresh_from_db()
        self.assertEqual([invocation.args[0] for invocation in call.call_args_list], [
            'get_terminal_blocking_message',
        ])
        self.assertIsNone(order.fiscal_invoice_number)
        self.assertEqual(self.terminal.online_invoice_counter, 0)

    @override_settings(
        MRA_EIS_DRY_RUN=False,
        MRA_EIS_ENABLE_HTTP_CALLS=True,
        MRA_EIS_ALLOW_LIVE_SUBMISSION=True,
    )
    def test_sale_response_can_suspend_terminal_for_future_sales(self):
        order = self._create_pos_order(order_number=5109, amount=Decimal('300.00'))
        calls = []

        def fake_call(endpoint_key, payload=None, **kwargs):
            calls.append(endpoint_key)
            if endpoint_key == 'get_terminal_blocking_message' and calls.count(endpoint_key) == 1:
                return MRACallResult(
                    ok=True,
                    dry_run=False,
                    status_code=200,
                    endpoint='https://eis.example/get-terminal-blocking-message',
                    data={'statusCode': 1, 'data': {'isBlocked': False}, 'errors': []},
                )
            if endpoint_key == 'report_sale':
                return MRACallResult(
                    ok=True,
                    dry_run=False,
                    status_code=200,
                    endpoint='https://eis.example/report-sale',
                    data={
                        'statusCode': 1,
                        'data': {
                            'eisUuid': 'EIS-5109',
                            'shouldBlockTerminal': True,
                            'blockingReason': 'MRA compliance review',
                        },
                        'errors': [],
                    },
                )
            if endpoint_key == 'get_terminal_blocking_message':
                return MRACallResult(
                    ok=True,
                    dry_run=False,
                    status_code=200,
                    endpoint='https://eis.example/get-terminal-blocking-message',
                    data={
                        'statusCode': 1,
                        'data': {
                            'isBlocked': True,
                            'blockingReason': 'MRA compliance review',
                        },
                        'errors': [],
                    },
                )
            raise AssertionError(f'Unexpected endpoint {endpoint_key}')

        with patch('mra_eis.services.MRAEISClient.call', side_effect=fake_call):
            result = POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=True)

        self.terminal.refresh_from_db()
        cached = TerminalService.get_cached_blocking_status(self.terminal)
        self.assertEqual(result['eis_status'], 'SUBMITTED')
        self.assertEqual(self.terminal.status, 'suspended')
        self.assertEqual(cached['blocking_reason'], 'MRA compliance review')
        self.assertEqual(calls, [
            'get_terminal_blocking_message',
            'report_sale',
            'get_terminal_blocking_message',
        ])


class ReceiptTests(TestCase):
    """Test receipt generation"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(business=self.business, name='Main', address='123 Main St', city='Lilongwe', country='Malawi')
        
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-001',
            device_serial='DEVICE-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-001',
            mra_api_key='test-key',
            status='active',
            is_online=True
        )

        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        self.invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

    def test_receipt_generation(self):
        """Test receipt is generated"""
        receipt = ReceiptService.generate_receipt(self.invoice)

        self.assertIsNotNone(receipt)
        self.assertIn('RECEIPT', receipt.receipt_text)
        self.assertIn(str(self.invoice.invoice_number), receipt.receipt_text)

    def test_qr_code_data(self):
        """Test QR code data is generated"""
        receipt = ReceiptService.generate_receipt(self.invoice)

        qr_data = json.loads(receipt.qr_code_data)
        self.assertEqual(qr_data['invoice_number'], self.invoice.invoice_number)
        self.assertEqual(qr_data['seller_tin'], self.invoice.seller_tin)
        self.assertEqual(qr_data['signature'], self.invoice.invoice_signature)

    def test_fiscal_receipt_has_legal_markers_and_tax_groups(self):
        receipt = ReceiptService.generate_receipt(self.invoice)

        self.assertIn('*** START OF LEGAL RECEIPT ***', receipt.receipt_text)
        self.assertIn('VAT A (STANDARD)', receipt.receipt_text)
        self.assertIn('VAT B (ZERO)', receipt.receipt_text)
        self.assertIn('VAT E (EXEMPT)', receipt.receipt_text)
        self.assertIn('*** END OF LEGAL RECEIPT ***', receipt.receipt_text)


class AuditLogTests(TestCase):
    """Test audit logging"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        self.branch = Branch.objects.create(business=self.business, name='Main', address='123 Main St', city='Lilongwe', country='Malawi')
        
        self.terminal = Terminal.objects.create(
            business=self.business,
            branch=self.branch,
            terminal_id='TERM-001',
            device_serial='DEVICE-001',
            pos_name='Handy POS',
            pos_version='1.0.0',
            os_type='Web',
            mra_terminal_id='MRA-TERM-001',
            mra_api_key='test-key',
            status='active',
            is_online=True
        )

    def test_terminal_audit_log(self):
        """Test terminal audit log is created"""
        logs = TerminalAuditLog.objects.filter(terminal=self.terminal)
        self.assertGreater(logs.count(), 0)

    def test_invoice_audit_log(self):
        """Test invoice audit log is created"""
        items = [
            {
                'mra_product_code': 'BEVERAGE-001',
                'name': 'Coca Cola 500ml',
                'quantity': Decimal('1'),
                'unit_price': Decimal('2500.00'),
                'tax_rate': Decimal('16.50'),
                'tax_category': 'standard',
            }
        ]

        invoice = InvoiceService.create_invoice(
            terminal=self.terminal,
            seller_tin='1234567890',
            seller_name='Test Business',
            items=items,
            is_online=True
        )

        logs = InvoiceAuditLog.objects.filter(mra_invoice=invoice)
        self.assertGreater(logs.count(), 0)
        self.assertEqual(logs.first().action, 'created')
