"""
MRA EIS Integration Tests
"""
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from django.contrib.auth import get_user_model
from datetime import timedelta
from decimal import Decimal
import json
from unittest.mock import patch

from business.models import Business, Branch, BusinessSettings
from mra_eis.models import (
    Terminal, TerminalActivationCode, MRAConfiguration, MRAProductMapping,
    MRAInvoice, OfflineInvoiceQueue, Receipt, InvoiceAuditLog,
    TerminalAuditLog, MRAAPIError, SyncRetryQueue
)
from mra_eis.services import (
    TerminalService, ConfigurationService, ProductMappingService,
    InvoiceService, ReceiptService, RetryService,
    POSOrderSubmissionService, MRAIntegrationError, MRACallResult
)

User = get_user_model()


class TerminalActivationTests(TestCase):
    """Test terminal activation flow"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
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


class InvoiceTests(TransactionTestCase):
    """Test invoice creation and submission"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
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


class OfflineInvoiceTests(TransactionTestCase):
    """Test offline invoice queuing and sync"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
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


class POSOfflineComplianceTests(TransactionTestCase):
    """Test MRA offline compliance rules on POS order submission flow."""

    def setUp(self):
        self.user = User.objects.create_user(email='pos@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='POS Compliance Business')
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

        result = POSOrderSubmissionService.prepare_pos_order_submission(order, force_online=False)
        order.refresh_from_db()

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


class ReceiptTests(TestCase):
    """Test receipt generation"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
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


class AuditLogTests(TestCase):
    """Test audit logging"""

    def setUp(self):
        self.user = User.objects.create_user(email='test@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Test Business')
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
