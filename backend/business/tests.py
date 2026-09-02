from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from datetime import timedelta
from decimal import Decimal
from rest_framework.test import APIClient

from inventory.models import InventoryItem
from pos_sessions.models import Order
from .models import (
    Branch,
    Business,
    BusinessCharge,
    Customer,
    CustomerAccountTransaction,
    Expense,
    Invoice,
    TaxRate,
)
from staff.models import Staff, StaffRole
from subscription.models import FeaturePricing, Subscription


class CustomerAPITest(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email='customer-owner@example.com',
            password='testpass123',
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Customer API Business',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='Main Street',
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_customer_create_returns_read_payload_with_id(self):
        response = self.client.post(
            '/api/customers/',
            {
                'branch': self.branch.id,
                'name': 'Jane Customer',
                'phone': '0999000101',
                'account_enabled': True,
                'credit_limit': '1000.00',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertIn('id', response.data)
        self.assertTrue(str(response.data['id']).isdigit())
        self.assertEqual(response.data['name'], 'Jane Customer')
        self.assertEqual(response.data['branch'], self.branch.id)
        self.assertIn('current_balance', response.data)

    def test_customer_patch_returns_read_payload_with_id(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Original Customer',
            phone='0999000102',
        )

        response = self.client.patch(
            f'/api/customers/{customer.id}/',
            {'name': 'Updated Customer'},
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['id'], customer.id)
        self.assertEqual(response.data['name'], 'Updated Customer')
        self.assertIn('current_balance', response.data)


class AdminStaffBusinessScopeAPITest(TestCase):
    """Admin staff can use owner-scoped business endpoints safely."""

    def setUp(self):
        self.owner = get_user_model().objects.create_user(
            email='scope-owner@example.com',
            password='testpass123',
        )
        self.admin_user = get_user_model().objects.create_user(
            email='scope-admin@example.com',
            password='testpass123',
        )
        self.other_owner = get_user_model().objects.create_user(
            email='scope-other-owner@example.com',
            password='testpass123',
        )
        self.business = Business.objects.create(
            owner=self.owner,
            name='Scoped Admin Business',
        )
        self.other_business = Business.objects.create(
            owner=self.other_owner,
            name='Other Business',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Scoped Main Branch',
            address='Main Street',
            city='Blantyre',
            country='Malawi',
        )
        self.other_branch = Branch.objects.create(
            business=self.other_business,
            name='Other Main Branch',
            address='Other Street',
            city='Lilongwe',
            country='Malawi',
        )
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.admin_user,
            name='Scoped Admin',
            email='scope-admin@example.com',
            role=StaffRole.ADMIN,
            is_active=True,
        )
        Subscription.objects.create(
            business=self.business,
            status='active',
            account_balance=Decimal('1000000.00'),
        )
        FeaturePricing.objects.create(
            feature='expense_management',
            price_per_day=Decimal('0.00'),
            is_active=True,
        )
        TaxRate.objects.create(
            business=self.business,
            name='Scoped VAT',
            rate=Decimal('16.50'),
            effective_from=timezone.localdate(),
        )
        TaxRate.objects.create(
            business=self.other_business,
            name='Other VAT',
            rate=Decimal('16.50'),
            effective_from=timezone.localdate(),
        )
        Invoice.objects.create(
            business=self.business,
            branch=self.branch,
            invoice_number=1,
            customer_name='Scoped Customer',
            issue_date=timezone.now(),
            due_date=timezone.now(),
        )
        Invoice.objects.create(
            business=self.other_business,
            branch=self.other_branch,
            invoice_number=1,
            customer_name='Other Customer',
            issue_date=timezone.now(),
            due_date=timezone.now(),
        )
        Expense.objects.create(
            id='EXP-SCOPED-1',
            business=self.business,
            branch=self.branch,
            title='Scoped Expense',
            category='Supplies',
            amount=Decimal('10.00'),
            date=timezone.now(),
            created_by='scope-admin@example.com',
        )
        Expense.objects.create(
            id='EXP-OTHER-1',
            business=self.other_business,
            branch=self.other_branch,
            title='Other Expense',
            category='Supplies',
            amount=Decimal('20.00'),
            date=timezone.now(),
            created_by='scope-other-owner@example.com',
        )
        BusinessCharge.objects.create(
            business=self.business,
            name='Scoped Levy',
            rate=Decimal('2.00'),
            effective_from=timezone.localdate(),
        )
        BusinessCharge.objects.create(
            business=self.other_business,
            name='Other Levy',
            rate=Decimal('2.00'),
            effective_from=timezone.localdate(),
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin_user)

    def test_admin_staff_sees_only_assigned_business_records(self):
        def rows(response):
            payload = response.data
            return payload.get('results', []) if isinstance(payload, dict) else payload

        response = self.client.get('/api/business/businesses/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['id'] for row in rows(response)}, {self.business.id})

        response = self.client.get('/api/business/branches/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['id'] for row in rows(response)}, {self.branch.id})

        response = self.client.get('/api/business/tax-rates/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['business'] for row in rows(response)}, {self.business.id})

        response = self.client.get('/api/business/invoices/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['business'] for row in rows(response)}, {self.business.id})

        response = self.client.get('/api/business/expenses/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['business'] for row in rows(response)}, {self.business.id})

        response = self.client.get('/api/business/charges/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual({row['business'] for row in rows(response)}, {self.business.id})


class BillingDocumentAPITest(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email='billing-owner@example.com',
            password='testpass123',
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Billing API Business',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='Main Street',
        )
        self.customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Account Customer',
            phone='0999000301',
            account_enabled=True,
            credit_limit=Decimal('100.00'),
        )
        self.product = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Billing Product',
            category='General',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            unit_type='unit',
            cost=Decimal('2.00'),
            price=Decimal('5.00'),
            value=Decimal('20.00'),
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_invoice_send_creates_account_sale_and_payment_clears_balance(self):
        now = timezone.now()
        response = self.client.post(
            '/api/invoices/',
            {
                'document_type': 'Invoice',
                'branch': self.branch.id,
                'customer': self.customer.id,
                'customer_name': self.customer.name,
                'status': 'Draft',
                'issue_date': now.isoformat(),
                'due_date': (now + timedelta(days=7)).isoformat(),
                'notes': 'Test invoice',
                'lines': [
                    {
                        'product_code': str(self.product.id),
                        'product_name': self.product.name,
                        'quantity': '2.000',
                        'unit_price': '5.00',
                        'tax_rate': '0.00',
                        'tax_amount': '0.00',
                        'total_amount': '10.00',
                    }
                ],
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        invoice_id = response.data['id']
        self.assertEqual(response.data['document_type'], 'Invoice')
        self.assertEqual(response.data['lines'][0]['product_name'], self.product.name)
        self.assertEqual(Decimal(str(response.data['balance_due'])), Decimal('0.00'))
        self.assertEqual(Decimal(str(response.data['customer_current_balance'])), Decimal('0.00'))
        self.assertFalse(Order.objects.filter(invoice_id=invoice_id).exists())

        sent_response = self.client.patch(
            f'/api/invoices/{invoice_id}/',
            {'status': 'Sent'},
            format='json',
        )

        self.assertEqual(sent_response.status_code, 200)
        self.assertEqual(Decimal(str(sent_response.data['balance_due'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(sent_response.data['paid_amount'])), Decimal('0.00'))
        self.assertEqual(Decimal(str(sent_response.data['customer_current_balance'])), Decimal('10.00'))
        order = Order.objects.get(invoice_id=invoice_id)
        self.assertEqual(order.payment_method, 'On Account')
        self.assertFalse(order.is_paid)
        self.product.refresh_from_db()
        self.customer.refresh_from_db()
        self.assertEqual(self.product.stock_units, Decimal('8.000'))
        self.assertEqual(self.customer.current_balance, Decimal('10.00'))
        self.assertTrue(
            CustomerAccountTransaction.objects.filter(
                customer=self.customer,
                order_id=str(order.id),
                invoice_id=invoice_id,
                entry_type='credit_sale',
            ).exists()
        )

        paid_response = self.client.patch(
            f'/api/invoices/{invoice_id}/',
            {'status': 'Paid'},
            format='json',
        )

        self.assertEqual(paid_response.status_code, 200)
        self.assertEqual(Decimal(str(paid_response.data['balance_due'])), Decimal('0.00'))
        self.assertEqual(Decimal(str(paid_response.data['paid_amount'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(paid_response.data['customer_current_balance'])), Decimal('0.00'))
        order.refresh_from_db()
        self.customer.refresh_from_db()
        self.assertTrue(order.is_paid)
        self.assertEqual(self.customer.current_balance, Decimal('0.00'))
        self.assertTrue(
            CustomerAccountTransaction.objects.filter(
                customer=self.customer,
                invoice_id=invoice_id,
                entry_type='payment',
            ).exists()
        )

    def test_quotation_does_not_create_order_when_sent(self):
        now = timezone.now()
        response = self.client.post(
            '/api/invoices/',
            {
                'document_type': 'Quotation',
                'branch': self.branch.id,
                'customer': self.customer.id,
                'customer_name': self.customer.name,
                'status': 'Draft',
                'issue_date': now.isoformat(),
                'due_date': (now + timedelta(days=7)).isoformat(),
                'lines': [
                    {
                        'product_code': str(self.product.id),
                        'product_name': self.product.name,
                        'quantity': '2.000',
                        'unit_price': '5.00',
                        'tax_rate': '0.00',
                        'tax_amount': '0.00',
                        'total_amount': '10.00',
                    }
                ],
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        invoice_id = response.data['id']

        sent_response = self.client.patch(
            f'/api/invoices/{invoice_id}/',
            {'status': 'Sent'},
            format='json',
        )

        self.assertEqual(sent_response.status_code, 200)
        self.assertEqual(Decimal(str(sent_response.data['balance_due'])), Decimal('0.00'))
        self.assertEqual(Decimal(str(sent_response.data['customer_current_balance'])), Decimal('0.00'))
        self.assertFalse(Order.objects.filter(invoice_id=invoice_id).exists())
        self.product.refresh_from_db()
        self.customer.refresh_from_db()
        self.assertEqual(self.product.stock_units, Decimal('10.000'))
        self.assertEqual(self.customer.current_balance, Decimal('0.00'))

    def test_customer_screen_can_record_partial_invoice_payments(self):
        now = timezone.now()
        response = self.client.post(
            '/api/invoices/',
            {
                'document_type': 'Invoice',
                'branch': self.branch.id,
                'customer': self.customer.id,
                'customer_name': self.customer.name,
                'status': 'Draft',
                'issue_date': now.isoformat(),
                'due_date': (now + timedelta(days=7)).isoformat(),
                'lines': [
                    {
                        'product_code': str(self.product.id),
                        'product_name': self.product.name,
                        'quantity': '2.000',
                        'unit_price': '5.00',
                        'tax_rate': '0.00',
                        'tax_amount': '0.00',
                        'total_amount': '10.00',
                    }
                ],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        invoice_id = response.data['id']

        sent_response = self.client.patch(
            f'/api/invoices/{invoice_id}/',
            {'status': 'Sent'},
            format='json',
        )
        self.assertEqual(sent_response.status_code, 200)
        order = Order.objects.get(invoice_id=invoice_id)
        self.customer.refresh_from_db()
        self.assertEqual(self.customer.current_balance, Decimal('10.00'))

        partial_response = self.client.post(
            f'/api/customers/{self.customer.id}/payments/',
            {
                'invoice': invoice_id,
                'amount': '4.00',
                'payment_method': 'Cash',
                'branch': self.branch.id,
            },
            format='json',
        )

        self.assertEqual(partial_response.status_code, 201)
        self.assertEqual(Decimal(str(partial_response.data['invoice']['paid_amount'])), Decimal('4.00'))
        self.assertEqual(Decimal(str(partial_response.data['invoice']['balance_due'])), Decimal('6.00'))
        self.assertEqual(partial_response.data['invoice']['status'], 'Sent')
        self.assertEqual(Decimal(str(partial_response.data['customer']['current_balance'])), Decimal('6.00'))
        self.customer.refresh_from_db()
        self.assertEqual(self.customer.current_balance, Decimal('6.00'))

        final_response = self.client.post(
            f'/api/customers/{self.customer.id}/payments/',
            {
                'invoice': invoice_id,
                'amount': '6.00',
                'payment_method': 'Cash',
                'branch': self.branch.id,
            },
            format='json',
        )

        self.assertEqual(final_response.status_code, 201)
        self.assertEqual(final_response.data['invoice']['status'], 'Paid')
        self.assertEqual(Decimal(str(final_response.data['invoice']['paid_amount'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(final_response.data['invoice']['balance_due'])), Decimal('0.00'))
        self.assertEqual(Decimal(str(final_response.data['customer']['current_balance'])), Decimal('0.00'))
        order.refresh_from_db()
        self.customer.refresh_from_db()
        self.assertTrue(order.is_paid)
        self.assertEqual(self.customer.current_balance, Decimal('0.00'))
