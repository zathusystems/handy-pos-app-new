import json
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from business.models import Branch, Business, BusinessSettings
from inventory.models import InventoryItem
from .models import TakeOrder, TakeOrderItem


User = get_user_model()


class PublicOrderTrackingTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.owner = User.objects.create_user(
            email='public-orders@example.com',
            password='test12345',
        )
        self.business = Business.objects.create(
            owner=self.owner,
            name='Public Orders Test',
            business_type='restaurant',
        )
        BusinessSettings.objects.create(
            business=self.business,
            currency='MWK',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken Wrap',
            category='Meals',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('2.00'),
            price=Decimal('8.50'),
            value=Decimal('20.00'),
        )

    def _create_self_service_order(self, *, business=None, branch=None, phone='0999000000', order_number=1002, status='Pending'):
        business = business or self.business
        branch = branch or self.branch
        order = TakeOrder.objects.create(
            order_number=order_number,
            branch=branch,
            business=business,
            customer_name='Guest',
            customer_phone=phone,
            table_number='Table 4',
            order_type='self_service',
            status=status,
        )
        TakeOrderItem.objects.create(
            take_order=order,
            inventory_item_id=str(self.item.id),
            name=self.item.name,
            quantity=Decimal('1.000'),
            price=Decimal('8.50'),
        )
        return order

    def test_self_service_order_returns_minimal_trackable_payload(self):
        response = self.client.post(
            '/api/orders/self-service/',
            data=json.dumps({
                'branch_id': str(self.branch.id),
                'customer_name': 'Guest',
                'customer_phone': '0999000000',
                'table_number': 'Table 3',
                'items': [
                    {
                        'inventory_item_id': str(self.item.id),
                        'name': self.item.name,
                        'quantity': 2,
                        'price': 8.5,
                    }
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertIn('id', payload)
        self.assertEqual(payload['branch_id'], str(self.branch.id))
        self.assertEqual(payload['order_number'], 1001)
        self.assertEqual(payload['status'], 'Pending')
        self.assertEqual(payload['currency'], 'MWK')
        self.assertEqual(payload['total'], 17.0)
        self.assertEqual(payload['items'][0]['name'], self.item.name)
        self.assertNotIn('customer_phone', payload)
        self.assertNotIn('table_number', payload)

    def test_self_service_order_accepts_items_with_no_stock(self):
        self.item.stock_units = Decimal('0.000')
        self.item.save(update_fields=['stock_units', 'updated_at'])

        response = self.client.post(
            '/api/orders/self-service/',
            data=json.dumps({
                'branch_id': str(self.branch.id),
                'customer_name': 'Guest',
                'customer_phone': '0999000000',
                'table_number': 'Table 3',
                'items': [
                    {
                        'inventory_item_id': str(self.item.id),
                        'name': self.item.name,
                        'quantity': 2,
                        'price': 8.5,
                    }
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertEqual(payload['status'], 'Pending')
        self.assertEqual(payload['total'], 17.0)

    def test_self_service_order_persists_selected_options_snapshot(self):
        response = self.client.post(
            '/api/orders/self-service/',
            data=json.dumps({
                'branch_id': str(self.branch.id),
                'customer_name': 'Guest',
                'customer_phone': '0999000000',
                'table_number': 'Table 3',
                'items': [
                    {
                        'inventory_item_id': str(self.item.id),
                        'name': self.item.name,
                        'quantity': 1,
                        'price': 10.0,
                        'selectedOptions': [
                            {
                                'id': 'chips-side',
                                'name': 'Chips',
                                'price_delta': '1.50',
                                'recipe': [{'ingredientId': 'potatoes', 'quantity': '0.250'}],
                            }
                        ],
                    }
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        order = TakeOrder.objects.get(id=response.json()['id'])
        self.assertEqual(order.items.count(), 1)
        order_item = order.items.first()
        self.assertEqual(order_item.selected_options[0]['name'], 'Chips')
        self.assertEqual(response.json()['items'][0]['selected_options'][0]['name'], 'Chips')

    def test_public_status_returns_same_device_tracking_payload(self):
        order = self._create_self_service_order(status='Ready')

        response = self.client.get(
            f'/api/orders/public-status/{order.id}/',
            {'branch_id': str(self.branch.id)},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['id'], str(order.id))
        self.assertEqual(payload['business_name'], self.business.name)
        self.assertEqual(payload['status'], 'Ready')
        self.assertEqual(payload['total'], 8.5)
        self.assertNotIn('customer_phone', payload)
        self.assertNotIn('table_number', payload)

    def test_public_status_is_scoped_to_branch(self):
        order = TakeOrder.objects.create(
            order_number=1003,
            branch=self.branch,
            business=self.business,
            customer_name='Guest',
            order_type='self_service',
            status='Pending',
        )
        other_branch = Branch.objects.create(
            business=self.business,
            name='Other Branch',
            address='456 Main St',
            city='Blantyre',
            country='Malawi',
        )

        response = self.client.get(
            f'/api/orders/public-status/{order.id}/',
            {'branch_id': str(other_branch.id)},
        )

        self.assertEqual(response.status_code, 404)

    def test_public_phone_lookup_returns_orders_across_businesses(self):
        first_order = self._create_self_service_order(phone='+265 999 000 000', order_number=1004)

        other_owner = User.objects.create_user(
            email='other-public-orders@example.com',
            password='test12345',
        )
        other_business = Business.objects.create(
            owner=other_owner,
            name='Other Restaurant',
            business_type='restaurant',
        )
        BusinessSettings.objects.create(
            business=other_business,
            currency='ZAR',
        )
        other_branch = Branch.objects.create(
            business=other_business,
            name='Other Main',
            address='456 Main St',
            city='Blantyre',
            country='Malawi',
        )
        second_order = self._create_self_service_order(
            business=other_business,
            branch=other_branch,
            phone='0999000000',
            order_number=1001,
            status='Preparing',
        )

        response = self.client.get('/api/orders/public-lookup/', {'phone': '999000000'})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        returned_ids = {row['id'] for row in payload['orders']}
        self.assertEqual(payload['count'], 2)
        self.assertIn(str(first_order.id), returned_ids)
        self.assertIn(str(second_order.id), returned_ids)
        business_names = {row['business_name'] for row in payload['orders']}
        self.assertEqual(business_names, {self.business.name, other_business.name})
        currencies = {row['business_name']: row['currency'] for row in payload['orders']}
        self.assertEqual(currencies[self.business.name], 'MWK')
        self.assertEqual(currencies[other_business.name], 'ZAR')
        self.assertNotIn('customer_phone', payload['orders'][0])
        self.assertNotIn('table_number', payload['orders'][0])

    def test_public_phone_lookup_rejects_short_phone(self):
        response = self.client.get('/api/orders/public-lookup/', {'phone': '123'})

        self.assertEqual(response.status_code, 400)


class TakeOrderStatusManagementTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(
            email='take-orders-owner@example.com',
            password='test12345',
        )
        self.business = Business.objects.create(
            owner=self.owner,
            name='Take Orders Status Test',
            business_type='restaurant',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken Wrap',
            category='Meals',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('2.00'),
            price=Decimal('8.50'),
            value=Decimal('20.00'),
        )
        self.client.force_authenticate(self.owner)

    def _create_order(self, status='Pending'):
        order = TakeOrder.objects.create(
            order_number=1001,
            branch=self.branch,
            business=self.business,
            customer_name='Guest',
            order_type='staff',
            status=status,
        )
        TakeOrderItem.objects.create(
            take_order=order,
            inventory_item_id=str(self.item.id),
            name=self.item.name,
            quantity=Decimal('1.000'),
            price=Decimal('8.50'),
        )
        return order

    def test_cancelled_order_stays_accessible_and_can_be_reopened(self):
        order = self._create_order(status='Pending')

        missing_reason_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Cancelled'},
            format='json',
        )

        self.assertEqual(missing_reason_response.status_code, 400)
        self.assertIn('cancellation_reason', missing_reason_response.data)

        cancel_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Cancelled', 'cancellation_reason': 'Customer changed their mind'},
            format='json',
        )

        self.assertEqual(cancel_response.status_code, 200)
        self.assertEqual(cancel_response.data['status'], 'Cancelled')
        self.assertEqual(cancel_response.data['cancellation_reason'], 'Customer changed their mind')

        list_response = self.client.get(
            '/api/orders/take-orders/',
            {'branch_id': str(self.branch.id)},
        )

        self.assertEqual(list_response.status_code, 200)
        listed_orders = list_response.data['results'] if 'results' in list_response.data else list_response.data
        listed_ids = {str(row['id']) for row in listed_orders}
        self.assertIn(str(order.id), listed_ids)

        reopen_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Pending'},
            format='json',
        )

        self.assertEqual(reopen_response.status_code, 200)
        self.assertEqual(reopen_response.data['status'], 'Pending')
        self.assertFalse(reopen_response.data['cancellation_reason'])

    def test_completed_order_records_cashier_name(self):
        order = self._create_order(status='Ready')

        complete_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Completed'},
            format='json',
        )

        self.assertEqual(complete_response.status_code, 200)
        self.assertEqual(complete_response.data['status'], 'Completed')
        self.assertEqual(complete_response.data['completed_by'], self.owner.id)
        self.assertEqual(complete_response.data['completed_by_name'], self.owner.get_username())
        self.assertIsNotNone(complete_response.data['completed_at'])

        order.refresh_from_db()
        self.assertEqual(order.completed_by, self.owner)

    def test_reopened_completed_order_clears_cashier_name(self):
        order = self._create_order(status='Ready')
        order.status = 'Completed'
        order.completed_by = self.owner
        order.completed_at = timezone.now()
        order.save(update_fields=['status', 'completed_by', 'completed_at', 'updated_at'])

        reopen_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Pending'},
            format='json',
        )

        self.assertEqual(reopen_response.status_code, 200)
        self.assertEqual(reopen_response.data['status'], 'Pending')
        self.assertIsNone(reopen_response.data['completed_by'])
        self.assertIsNone(reopen_response.data['completed_by_name'])
        self.assertIsNone(reopen_response.data['completed_at'])
