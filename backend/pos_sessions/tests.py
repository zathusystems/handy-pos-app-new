import uuid
from decimal import Decimal
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from business.models import (
    Business,
    Branch,
    BusinessSettings,
    Customer,
    CustomerAccountTransaction,
    CustomerLaybuy,
    CustomerLaybuyPayment,
    CustomerLaybuyReservation,
    Invoice,
)
from business.customer_accounts import collect_laybuy, record_customer_payment, record_laybuy_payment
from inventory.models import InventoryItem, MRAProductMapping, PurchaseOrder, PurchaseOrderItem
from pos_sessions.correction_views import VoidTransactionViewSet
from pos_sessions.models import Order, OrderItem, Session
from pos_sessions.stock_validation import validate_stock_available_for_order_lines
from pos_sessions.sync_views import decrement_inventory_for_order
from staff.models import Staff, StaffRole

User = get_user_model()


class RecipeStockValidationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='recipe-stock@example.com',
            password='test12345'
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Recipe Stock Business',
            business_type='restaurant',
        )
        self.settings = BusinessSettings.objects.create(
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
        self.ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef',
            category='Kitchen',
            item_type='ingredient',
            stock_units=Decimal('0.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('5.00'),
            value=Decimal('0.00'),
            unit_type='kg',
        )
        self.meal = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef Stew',
            category='Meals',
            item_type='sellable',
            stock_units=Decimal('0.000'),
            reorder_level=Decimal('0.000'),
            cost=Decimal('0.00'),
            price=Decimal('25.00'),
            value=Decimal('0.00'),
            is_produced=True,
            recipe=[
                {
                    'ingredientId': str(self.ingredient.id),
                    'name': self.ingredient.name,
                    'quantity': 1,
                    'unit': 'kg',
                }
            ],
        )
        self.direct_product = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Bottled Water',
            category='Drinks',
            item_type='sellable',
            stock_units=Decimal('0.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('1.00'),
            price=Decimal('3.00'),
            value=Decimal('0.00'),
        )
        self.side_ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Potatoes',
            category='Kitchen',
            item_type='ingredient',
            stock_units=Decimal('0.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('2.00'),
            value=Decimal('0.00'),
            unit_type='kg',
        )

    def test_recipe_sale_is_blocked_when_ingredient_stock_is_short_by_default(self):
        with self.assertRaises(ValidationError):
            validate_stock_available_for_order_lines(
                [
                    {
                        'inventory_item_id': str(self.meal.id),
                        'name': self.meal.name,
                        'quantity': 1,
                    }
                ],
                self.business,
                self.branch,
            )

    def test_recipe_sale_can_record_negative_ingredient_stock_when_enabled(self):
        self.settings.allow_negative_ingredient_stock = True
        self.settings.save(update_fields=['allow_negative_ingredient_stock', 'updated_at'])

        validate_stock_available_for_order_lines(
            [
                {
                    'inventory_item_id': str(self.meal.id),
                    'name': self.meal.name,
                    'quantity': 1,
                }
            ],
            self.business,
            self.branch,
        )

        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=1001,
            order_type='sale',
            payment_method='Cash',
            subtotal=Decimal('25.00'),
            total=Decimal('25.00'),
            net_amount=Decimal('25.00'),
            gross_amount=Decimal('25.00'),
            vat_amount=Decimal('0.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(self.meal.id),
            name=self.meal.name,
            quantity=Decimal('1.000'),
            price=Decimal('25.00'),
            subtotal=Decimal('25.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('25.00'),
        )

        decrement_inventory_for_order(order, self.branch, self.business)

        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.stock_units, Decimal('-1.000'))

    def test_prepared_menu_item_recipe_validates_inventory_ingredients(self):
        self.ingredient.stock_units = Decimal('3.000')
        self.ingredient.save(update_fields=['stock_units', 'updated_at'])

        validate_stock_available_for_order_lines(
            [
                {
                    'inventory_item_id': '',
                    'menu_item_id': str(uuid.uuid4()),
                    'name': 'Menu Beef Stew',
                    'quantity': 2,
                    'is_prepared_menu_item': True,
                    'recipe': [
                        {
                            'ingredientId': str(self.ingredient.id),
                            'name': self.ingredient.name,
                            'quantity': 1,
                            'unit': 'kg',
                        }
                    ],
                }
            ],
            self.business,
            self.branch,
        )

        with self.assertRaises(ValidationError):
            validate_stock_available_for_order_lines(
                [
                    {
                        'inventory_item_id': '',
                        'menu_item_id': str(uuid.uuid4()),
                        'name': 'Menu Beef Stew',
                        'quantity': 4,
                        'is_prepared_menu_item': True,
                        'recipe': [
                            {
                                'ingredientId': str(self.ingredient.id),
                                'name': self.ingredient.name,
                                'quantity': 1,
                                'unit': 'kg',
                            }
                        ],
                    }
                ],
                self.business,
                self.branch,
            )

    def test_direct_product_sale_is_blocked_when_stock_is_short_by_default(self):
        with self.assertRaises(ValidationError):
            validate_stock_available_for_order_lines(
                [
                    {
                        'inventory_item_id': str(self.direct_product.id),
                        'name': self.direct_product.name,
                        'quantity': 2,
                    }
                ],
                self.business,
                self.branch,
            )

    def test_direct_product_sale_records_negative_stock_when_enabled(self):
        self.settings.allow_negative_ingredient_stock = True
        self.settings.save(update_fields=['allow_negative_ingredient_stock', 'updated_at'])

        validate_stock_available_for_order_lines(
            [
                {
                    'inventory_item_id': str(self.direct_product.id),
                    'name': self.direct_product.name,
                    'quantity': 2,
                }
            ],
            self.business,
            self.branch,
        )

        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=1002,
            order_type='sale',
            payment_method='Cash',
            subtotal=Decimal('6.00'),
            total=Decimal('6.00'),
            net_amount=Decimal('6.00'),
            gross_amount=Decimal('6.00'),
            vat_amount=Decimal('0.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(self.direct_product.id),
            name=self.direct_product.name,
            quantity=Decimal('2.000'),
            price=Decimal('3.00'),
            subtotal=Decimal('6.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('6.00'),
        )

        decrement_inventory_for_order(order, self.branch, self.business)

        self.direct_product.refresh_from_db()
        self.assertEqual(self.direct_product.stock_units, Decimal('-2.000'))

    def test_takeaway_packaging_is_deducted_directly_even_if_it_has_a_recipe(self):
        packaging_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Reusable Takeaway Box',
            category='Packaging',
            item_type='sellable',
            stock_units=Decimal('2.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('0.50'),
            price=Decimal('1.50'),
            value=Decimal('1.00'),
            recipe=[
                {
                    'ingredientId': str(self.ingredient.id),
                    'name': self.ingredient.name,
                    'quantity': 1,
                }
            ],
        )

        validate_stock_available_for_order_lines(
            [
                {
                    'inventory_item_id': str(packaging_item.id),
                    'name': packaging_item.name,
                    'quantity': 1,
                    'is_takeaway_packaging': True,
                }
            ],
            self.business,
            self.branch,
        )

        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=1004,
            order_type='sale',
            payment_method='Cash',
            is_takeaway=True,
            subtotal=Decimal('1.50'),
            total=Decimal('1.50'),
            net_amount=Decimal('1.50'),
            gross_amount=Decimal('1.50'),
            vat_amount=Decimal('0.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(packaging_item.id),
            name=packaging_item.name,
            quantity=Decimal('1.000'),
            price=Decimal('1.50'),
            is_takeaway_packaging=True,
            recipe=packaging_item.recipe,
            subtotal=Decimal('1.50'),
            tax_amount=Decimal('0.00'),
            total=Decimal('1.50'),
        )

        decrement_inventory_for_order(order, self.branch, self.business)

        packaging_item.refresh_from_db()
        self.ingredient.refresh_from_db()
        self.assertEqual(packaging_item.stock_units, Decimal('1.000'))
        self.assertEqual(self.ingredient.stock_units, Decimal('0.000'))

    def test_selected_option_recipe_is_included_in_stock_validation(self):
        self.ingredient.stock_units = Decimal('5.000')
        self.ingredient.save(update_fields=['stock_units', 'updated_at'])

        with self.assertRaises(ValidationError):
            validate_stock_available_for_order_lines(
                [
                    {
                        'inventory_item_id': str(self.meal.id),
                        'name': self.meal.name,
                        'quantity': 1,
                        'selected_options': [
                            {
                                'id': 'chips-side',
                                'name': 'Chips',
                                'quantity': 1,
                                'price_delta': '3.00',
                                'recipe': [
                                    {
                                        'ingredientId': str(self.side_ingredient.id),
                                        'name': self.side_ingredient.name,
                                        'quantity': '0.250',
                                    }
                                ],
                            }
                        ],
                    }
                ],
                self.business,
                self.branch,
            )

    def test_selected_option_recipe_is_deducted_with_base_recipe(self):
        self.settings.allow_negative_ingredient_stock = True
        self.settings.save(update_fields=['allow_negative_ingredient_stock', 'updated_at'])

        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=1003,
            order_type='sale',
            payment_method='Cash',
            subtotal=Decimal('56.00'),
            total=Decimal('56.00'),
            net_amount=Decimal('56.00'),
            gross_amount=Decimal('56.00'),
            vat_amount=Decimal('0.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(self.meal.id),
            name=self.meal.name,
            quantity=Decimal('2.000'),
            price=Decimal('28.00'),
            subtotal=Decimal('56.00'),
            tax_amount=Decimal('0.00'),
            total=Decimal('56.00'),
            selected_options=[
                {
                    'id': 'chips-side',
                    'name': 'Chips',
                    'quantity': 1,
                    'price_delta': '3.00',
                    'recipe': [
                        {
                            'ingredientId': str(self.side_ingredient.id),
                            'name': self.side_ingredient.name,
                            'quantity': '0.250',
                        }
                    ],
                }
            ],
        )

        decrement_inventory_for_order(order, self.branch, self.business)

        self.ingredient.refresh_from_db()
        self.side_ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.stock_units, Decimal('-2.000'))
        self.assertEqual(self.side_ingredient.stock_units, Decimal('-0.500'))


class OrderBatchTraceAndVoidTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='owner@example.com',
            password='test12345'
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Batch Trace Test Business',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )

        self.inventory_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Milk 1L',
            category='Dairy',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('1.00'),
            price=Decimal('2.00'),
            value=Decimal('10.00'),
        )

        # Batch 1 (older / should be consumed first)
        po1 = PurchaseOrder.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=uuid.uuid4(),
            created_by='tester',
            received_date=timezone.now() - timedelta(days=3),
            total_items=1,
            total_cost=Decimal('5.00'),
        )
        self.batch_1 = PurchaseOrderItem.objects.create(
            purchase_order=po1,
            inventory_item=self.inventory_item,
            quantity_ordered=Decimal('5.000'),
            quantity_received=Decimal('5.000'),
            quantity_remaining=Decimal('5.000'),
            cost_per_unit=Decimal('1.00'),
            total_cost=Decimal('5.00'),
            batch_number='BATCH-OLD',
            expiry_date=(timezone.now() + timedelta(days=15)).date(),
        )

        # Batch 2 (newer)
        po2 = PurchaseOrder.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=uuid.uuid4(),
            created_by='tester',
            received_date=timezone.now() - timedelta(days=1),
            total_items=1,
            total_cost=Decimal('5.00'),
        )
        self.batch_2 = PurchaseOrderItem.objects.create(
            purchase_order=po2,
            inventory_item=self.inventory_item,
            quantity_ordered=Decimal('5.000'),
            quantity_received=Decimal('5.000'),
            quantity_remaining=Decimal('5.000'),
            cost_per_unit=Decimal('1.00'),
            total_cost=Decimal('5.00'),
            batch_number='BATCH-NEW',
            expiry_date=(timezone.now() + timedelta(days=60)).date(),
        )

    def _create_order_with_single_item(self, order_number, quantity):
        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=order_number,
            order_type='sale',
            payment_method='Cash',
            subtotal=Decimal(str(quantity)),
            total=Decimal(str(quantity)),
            net_amount=Decimal(str(quantity)),
            gross_amount=Decimal(str(quantity)),
            vat_amount=Decimal('0.00'),
        )
        order_item = OrderItem.objects.create(
            order=order,
            inventory_item_id=str(self.inventory_item.id),
            name=self.inventory_item.name,
            quantity=Decimal(str(quantity)),
            price=Decimal('1.00'),
            subtotal=Decimal(str(quantity)),
            tax_amount=Decimal('0.00'),
            total=Decimal(str(quantity)),
        )
        return order, order_item

    def test_decrement_records_batch_consumption_trace(self):
        order, order_item = self._create_order_with_single_item(order_number=1001, quantity='4.000')
        decrement_inventory_for_order(order, self.branch, self.business)
        order_item.refresh_from_db()

        self.batch_1.refresh_from_db()
        self.batch_2.refresh_from_db()

        self.assertEqual(self.batch_1.quantity_remaining, Decimal('1.000'))
        self.assertEqual(self.batch_2.quantity_remaining, Decimal('5.000'))

        self.assertEqual(len(order_item.batch_consumption), 1)
        trace = order_item.batch_consumption[0]
        self.assertEqual(trace['inventory_item_id'], str(self.inventory_item.id))
        self.assertEqual(trace['batch_id'], str(self.batch_1.id))
        self.assertEqual(Decimal(trace['quantity']), Decimal('4.000'))

    def test_void_restores_original_batches_even_after_other_sales(self):
        # Order A uses 4 from old batch.
        order_a, order_item_a = self._create_order_with_single_item(order_number=1002, quantity='4.000')
        decrement_inventory_for_order(order_a, self.branch, self.business)

        # Order B later uses remaining old stock (1) and then new batch (1).
        order_b, _ = self._create_order_with_single_item(order_number=1003, quantity='2.000')
        decrement_inventory_for_order(order_b, self.branch, self.business)

        self.batch_1.refresh_from_db()
        self.batch_2.refresh_from_db()
        self.assertEqual(self.batch_1.quantity_remaining, Decimal('0.000'))
        self.assertEqual(self.batch_2.quantity_remaining, Decimal('4.000'))

        # Ensure order A trace points to its original batch usage only.
        order_item_a.refresh_from_db()
        self.assertEqual(len(order_item_a.batch_consumption), 1)
        self.assertEqual(order_item_a.batch_consumption[0]['batch_id'], str(self.batch_1.id))
        self.assertEqual(Decimal(order_item_a.batch_consumption[0]['quantity']), Decimal('4.000'))

        factory = APIRequestFactory()
        request = factory.post(
            '/sessions/void-transactions/create_void/',
            {
                'original_order_id': str(order_a.id),
                'void_reason': 'other',
                'reason_description': 'Regression test for original batch restore',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)
        response = VoidTransactionViewSet.as_view({'post': 'create_void'})(request)

        self.assertEqual(response.status_code, 201)

        self.batch_1.refresh_from_db()
        self.batch_2.refresh_from_db()
        self.inventory_item.refresh_from_db()
        order_a.refresh_from_db()

        # Expected after voiding only Order A:
        # batch_1 was 0 after A+B, should return +4 to 4
        # batch_2 should stay 4 (Order B still consumed 1 from it)
        self.assertEqual(self.batch_1.quantity_remaining, Decimal('4.000'))
        self.assertEqual(self.batch_2.quantity_remaining, Decimal('4.000'))
        self.assertEqual(self.inventory_item.stock_units, Decimal('8.000'))
        self.assertEqual(order_a.status, 'Voided')

    def test_void_does_not_reduce_inventory_when_batch_totals_are_lower_than_stock(self):
        # Simulate drifted state from production log:
        # product stock is 2, but batch balance after restore is only 1.
        self.inventory_item.stock_units = Decimal('2.000')
        self.inventory_item.save(update_fields=['stock_units', 'updated_at'])

        self.batch_1.quantity_ordered = Decimal('1.000')
        self.batch_1.quantity_received = Decimal('1.000')
        self.batch_1.quantity_remaining = Decimal('0.000')
        self.batch_1.save(
            update_fields=['quantity_ordered', 'quantity_received', 'quantity_remaining', 'updated_at']
        )

        # Keep only one relevant batch for this scenario.
        self.batch_2.quantity_ordered = Decimal('0.000')
        self.batch_2.quantity_received = Decimal('0.000')
        self.batch_2.quantity_remaining = Decimal('0.000')
        self.batch_2.save(
            update_fields=['quantity_ordered', 'quantity_received', 'quantity_remaining', 'updated_at']
        )

        order, order_item = self._create_order_with_single_item(order_number=1004, quantity='1.000')
        order_item.batch_consumption = [
            {
                'inventory_item_id': str(self.inventory_item.id),
                'batch_id': None,
                'quantity': '1.000',
                'unassigned': True,
            }
        ]
        order_item.save(update_fields=['batch_consumption', 'updated_at'])

        factory = APIRequestFactory()
        request = factory.post(
            '/sessions/void-transactions/create_void/',
            {
                'original_order_id': str(order.id),
                'void_reason': 'customer_request',
                'reason_description': 'Regression: void must not reduce stock',
            },
            format='json',
        )
        force_authenticate(request, user=self.user)
        response = VoidTransactionViewSet.as_view({'post': 'create_void'})(request)

        self.assertEqual(response.status_code, 201)

        self.batch_1.refresh_from_db()
        self.inventory_item.refresh_from_db()

        # Batch was restored by 1 (0 -> 1), and inventory stock must increase (2 -> 3), never decrease.
        self.assertEqual(self.batch_1.quantity_remaining, Decimal('1.000'))
        self.assertEqual(self.inventory_item.stock_units, Decimal('3.000'))


class SyncPushOrderTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='sync-owner@example.com',
            password='test12345'
        )
        self.business = Business.objects.create(
            owner=self.user,
            name='Sync Push Test Business',
        )
        BusinessSettings.objects.create(
            business=self.business,
            block_sales_if_tax_mapping_missing=True,
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.session = Session.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.user,
            status='active',
            opening_float=Decimal('0.00'),
            expected_cash=Decimal('0.00'),
            total_sales=Decimal('0.00'),
            started_at=timezone.now(),
        )
        self.inventory_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Soda Can',
            category='Beverages',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('3.00'),
            price=Decimal('5.00'),
            value=Decimal('30.00'),
        )
        MRAProductMapping.objects.create(
            inventory_item=self.inventory_item,
            branch=self.branch,
            mra_product_code='SODA-001',
            mra_product_name='Soda Can',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('0.00'),
            mra_unit_measure='unit',
            tax_calculation_method='inclusive',
            is_approved=True,
            mra_synced=True,
            approved_at=timezone.now(),
            last_synced_at=timezone.now(),
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _build_sync_payload(self, order_id: str) -> dict:
        now = timezone.now().isoformat()
        return {
            'last_synced_at': now,
            'branch_id': str(self.branch.id),
            'changes': [
                {
                    'id': order_id,
                    'entity_type': 'Order',
                    'op': 'create',
                    'timestamp': now,
                    'data': {
                        'id': order_id,
                        'orderNumber': 7001,
                        'orderType': 'sale',
                        'status': 'Completed',
                        'paymentMethod': 'Cash',
                        'subtotal': 5.0,
                        'total': 5.0,
                        'cogs': 3.0,
                        'createdAt': now,
                        'updatedAt': now,
                        'sessionId': str(self.session.id),
                        'items': [
                            {
                                'id': str(uuid.uuid4()),
                                'inventoryItemId': str(self.inventory_item.id),
                                'name': self.inventory_item.name,
                                'quantity': 1,
                                'price': 5.0,
                                'notes': '',
                            }
                        ],
                    },
                }
            ],
        }

    def _build_variable_price_sync_payload(
        self,
        order_id: str,
        *,
        quantity: float,
        price: float,
        item_total: float | None = None,
        item_subtotal: float | None = None,
        item_tax: float | None = None,
    ) -> dict:
        now = timezone.now().isoformat()
        item_payload = {
            'id': str(uuid.uuid4()),
            'inventoryItemId': str(self.inventory_item.id),
            'name': self.inventory_item.name,
            'quantity': quantity,
            'price': price,
            'notes': '',
        }
        if item_total is not None:
            item_payload['total'] = item_total
        if item_subtotal is not None:
            item_payload['subtotal'] = item_subtotal
        if item_tax is not None:
            item_payload['taxAmount'] = item_tax

        return {
            'last_synced_at': now,
            'branch_id': str(self.branch.id),
            'changes': [
                {
                    'id': order_id,
                    'entity_type': 'Order',
                    'op': 'create',
                    'timestamp': now,
                    'data': {
                        'id': order_id,
                        'orderNumber': 7101,
                        'orderType': 'sale',
                        'status': 'Completed',
                        'paymentMethod': 'Cash',
                        'subtotal': 0,
                        'total': 0,
                        'cogs': 0,
                        'createdAt': now,
                        'updatedAt': now,
                        'sessionId': str(self.session.id),
                        'items': [item_payload],
                    },
                }
            ],
        }

    def test_sync_push_creates_order_and_is_idempotent(self):
        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)

        first_response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(first_response.data['results']['errors'], [])
        self.assertEqual(len(first_response.data['results']['acknowledged']), 1)
        self.assertEqual(first_response.data['results']['acknowledged'][0]['id'], order_id)

        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)
        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.order_number, 7001)
        self.assertEqual(created_order.session_id, self.session.id)
        self.assertEqual(created_order.items.count(), 1)

        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('9.000'))

        second_response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.data['results']['errors'], [])
        self.assertEqual(len(second_response.data['results']['acknowledged']), 1)
        self.assertEqual(second_response.data['results']['acknowledged'][0]['id'], order_id)

        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)
        self.assertEqual(OrderItem.objects.filter(order_id=order_id).count(), 1)

        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('9.000'))

    def test_sync_push_records_cash_change_tip_in_session_totals(self):
        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        payload['changes'][0]['data']['tip'] = 1.5

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])
        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_cash_sales, Decimal('5.00'))
        self.assertEqual(self.session.total_tips, Decimal('1.50'))
        self.assertEqual(self.session.expected_cash, Decimal('6.50'))

        second_response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.data['results']['errors'], [])

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_cash_sales, Decimal('5.00'))
        self.assertEqual(self.session.total_tips, Decimal('1.50'))
        self.assertEqual(self.session.expected_cash, Decimal('6.50'))

    def test_sync_push_variable_price_keeps_unit_price_and_fractional_quantity(self):
        self.inventory_item.is_variable_price = True
        self.inventory_item.price = Decimal('40.00')
        self.inventory_item.save(update_fields=['is_variable_price', 'price', 'updated_at'])

        mapping = MRAProductMapping.objects.get(inventory_item=self.inventory_item, branch=self.branch)
        mapping.mra_tax_rate = Decimal('16.50')
        mapping.tax_calculation_method = 'inclusive'
        mapping.save(update_fields=['mra_tax_rate', 'tax_calculation_method', 'updated_at'])

        order_id = str(uuid.uuid4())
        payload = self._build_variable_price_sync_payload(
            order_id,
            quantity=2.5,
            price=40.0,
        )

        response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])
        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)

        created_order = Order.objects.get(id=order_id)
        created_item = created_order.items.get()

        self.assertAlmostEqual(float(created_order.gross_amount), 100.0, places=2)
        self.assertAlmostEqual(float(created_order.vat_amount), 14.16, places=2)
        self.assertAlmostEqual(float(created_item.quantity), 2.5, places=3)
        self.assertAlmostEqual(float(created_item.price), 40.0, places=2)

        self.inventory_item.refresh_from_db()
        self.assertAlmostEqual(float(self.inventory_item.stock_units), 7.5, places=3)

    def test_recipe_sellable_decrements_ingredients_even_when_not_produced(self):
        ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Burger Bun',
            category='Ingredients',
            item_type='ingredient',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('1.00'),
            value=Decimal('10.00'),
            is_recipe_ingredient=True,
        )
        recipe_product = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef Burger',
            category='Meals',
            item_type='sellable',
            stock_units=Decimal('3.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('4.00'),
            price=Decimal('8.00'),
            value=Decimal('12.00'),
            is_produced=False,
            recipe=[
                {
                    'ingredientId': str(ingredient.id),
                    'name': ingredient.name,
                    'quantity': 2,
                    'unit': 'unit',
                }
            ],
        )
        order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            session=self.session,
            order_number=7201,
            order_type='sale',
            status='Completed',
            payment_method='Cash',
            subtotal=Decimal('16.00'),
            total=Decimal('16.00'),
            cogs=Decimal('8.00'),
        )
        OrderItem.objects.create(
            order=order,
            inventory_item_id=str(recipe_product.id),
            name=recipe_product.name,
            quantity=Decimal('2.000'),
            price=Decimal('8.00'),
            subtotal=Decimal('16.00'),
            total=Decimal('16.00'),
        )

        decrement_inventory_for_order(order, self.branch, self.business)
        ingredient.refresh_from_db()
        recipe_product.refresh_from_db()

        self.assertEqual(ingredient.stock_units, Decimal('6.000'))
        self.assertEqual(recipe_product.stock_units, Decimal('3.000'))

        created_item = order.items.get()
        self.assertEqual(created_item.batch_consumption[0]['inventory_item_id'], str(ingredient.id))
        self.assertEqual(created_item.batch_consumption[0]['quantity'], '4.000')
        self.assertTrue(created_item.batch_consumption[0]['unassigned'])

    def test_sync_push_prepared_menu_item_decrements_recipe_ingredients(self):
        ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken Pieces',
            category='Ingredients',
            item_type='ingredient',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('2.00'),
            value=Decimal('20.00'),
            is_recipe_ingredient=True,
            unit_type='piece',
        )

        now = timezone.now().isoformat()
        order_id = str(uuid.uuid4())
        menu_item_id = str(uuid.uuid4())
        payload = {
            'last_synced_at': now,
            'branch_id': str(self.branch.id),
            'changes': [
                {
                    'id': order_id,
                    'entity_type': 'Order',
                    'op': 'create',
                    'timestamp': now,
                    'data': {
                        'id': order_id,
                        'orderNumber': 7202,
                        'orderType': 'sale',
                        'status': 'Completed',
                        'paymentMethod': 'Cash',
                        'subtotal': 30.0,
                        'total': 30.0,
                        'cogs': 0,
                        'createdAt': now,
                        'updatedAt': now,
                        'sessionId': str(self.session.id),
                        'items': [
                            {
                                'id': str(uuid.uuid4()),
                                'inventoryItemId': '',
                                'menuItemId': menu_item_id,
                                'name': 'Chicken and Chips',
                                'quantity': 2,
                                'price': 15.0,
                                'notes': '',
                                'isPreparedMenuItem': True,
                                'recipe': [
                                    {
                                        'ingredientId': str(ingredient.id),
                                        'name': ingredient.name,
                                        'quantity': 2,
                                        'unit': 'piece',
                                    }
                                ],
                            }
                        ],
                    },
                }
            ],
        }

        response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])

        ingredient.refresh_from_db()
        self.assertEqual(ingredient.stock_units, Decimal('6.000'))

        created_item = Order.objects.get(id=order_id).items.get()
        self.assertEqual(created_item.inventory_item_id, '')
        self.assertEqual(created_item.menu_item_id, menu_item_id)
        self.assertTrue(created_item.is_prepared_menu_item)
        self.assertEqual(created_item.batch_consumption[0]['inventory_item_id'], str(ingredient.id))
        self.assertEqual(created_item.batch_consumption[0]['quantity'], '4.000')

    def test_sync_push_variable_price_normalizes_legacy_line_total_price_payload(self):
        self.inventory_item.is_variable_price = True
        self.inventory_item.price = Decimal('40.00')
        self.inventory_item.save(update_fields=['is_variable_price', 'price', 'updated_at'])

        mapping = MRAProductMapping.objects.get(inventory_item=self.inventory_item, branch=self.branch)
        mapping.mra_tax_rate = Decimal('0.00')
        mapping.tax_calculation_method = 'inclusive'
        mapping.save(update_fields=['mra_tax_rate', 'tax_calculation_method', 'updated_at'])

        order_id = str(uuid.uuid4())
        payload = self._build_variable_price_sync_payload(
            order_id,
            quantity=2.5,
            price=100.0,       # Legacy client sends line-total into unit-price field.
            item_total=100.0,  # Explicit line total allows backend normalization.
            item_subtotal=100.0,
            item_tax=0.0,
        )

        response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])
        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)

        created_order = Order.objects.get(id=order_id)
        created_item = created_order.items.get()

        self.assertAlmostEqual(float(created_order.gross_amount), 100.0, places=2)
        self.assertAlmostEqual(float(created_order.vat_amount), 0.0, places=2)
        # Backend should normalize legacy line-total pricing to a per-unit stored value.
        self.assertAlmostEqual(float(created_item.price), 40.0, places=2)
        self.assertAlmostEqual(float(created_item.total), 100.0, places=2)

    def test_sync_push_variable_price_exclusive_tax_recalculation_is_accurate(self):
        self.inventory_item.is_variable_price = True
        self.inventory_item.price = Decimal('40.00')
        self.inventory_item.save(update_fields=['is_variable_price', 'price', 'updated_at'])

        mapping = MRAProductMapping.objects.get(inventory_item=self.inventory_item, branch=self.branch)
        mapping.mra_tax_rate = Decimal('16.50')
        mapping.tax_calculation_method = 'exclusive'
        mapping.save(update_fields=['mra_tax_rate', 'tax_calculation_method', 'updated_at'])

        order_id = str(uuid.uuid4())
        payload = self._build_variable_price_sync_payload(
            order_id,
            quantity=2.5,
            price=40.0,
        )

        response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])
        self.assertEqual(Order.objects.filter(id=order_id).count(), 1)

        created_order = Order.objects.get(id=order_id)
        created_item = created_order.items.get()

        self.assertAlmostEqual(float(created_order.net_amount), 100.0, places=2)
        self.assertAlmostEqual(float(created_order.vat_amount), 16.5, places=2)
        self.assertAlmostEqual(float(created_order.gross_amount), 116.5, places=2)
        self.assertAlmostEqual(float(created_item.subtotal), 100.0, places=2)
        self.assertAlmostEqual(float(created_item.tax_amount), 16.5, places=2)
        self.assertAlmostEqual(float(created_item.total), 116.5, places=2)

    def test_sync_push_blocks_products_with_unsynced_mra_mapping(self):
        mapping = MRAProductMapping.objects.get(inventory_item=self.inventory_item, branch=self.branch)
        mapping.is_approved = True
        mapping.mra_synced = False
        mapping.save(update_fields=['is_approved', 'mra_synced', 'updated_at'])

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.filter(id=order_id).count(), 0)
        self.assertTrue(response.data['results']['errors'])
        self.assertIn('unsynced MRA mappings', response.data['results']['errors'][0]['error'])

    def test_sync_push_cash_sale_can_be_assigned_to_customer_without_credit_debit(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Grace Banda',
            phone='0999000111',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        payload['changes'][0]['data']['customerId'] = str(customer.id)

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])

        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.customer_id, customer.id)
        self.assertEqual(created_order.customer_name, customer.name)
        self.assertEqual(created_order.customer_phone, customer.phone)
        self.assertFalse(
            CustomerAccountTransaction.objects.filter(
                customer=customer,
                order_id=str(created_order.id),
                entry_type='credit_sale',
            ).exists()
        )

    def test_sync_push_accepts_bank_transfer_sale(self):
        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        payload['changes'][0]['data']['paymentMethod'] = 'Bank Transfer'

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])

        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.payment_method, 'Bank Transfer')

    def test_sync_push_on_account_sale_is_acknowledged_and_creates_credit_debit(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Account Sale Customer',
            phone='0999000555',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        order_payload = payload['changes'][0]['data']
        order_payload['paymentMethod'] = 'On Account'
        order_payload['customerId'] = str(customer.id)

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])
        self.assertEqual(len(response.data['results']['acknowledged']), 1)
        self.assertEqual(response.data['results']['acknowledged'][0]['id'], order_id)

        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.payment_method, 'On Account')
        self.assertEqual(created_order.customer_id, customer.id)

        account_tx = CustomerAccountTransaction.objects.get(
            customer=customer,
            order_id=order_id,
            entry_type='credit_sale',
        )
        self.assertEqual(account_tx.amount, Decimal('5.00'))

        invoice = Invoice.objects.get(
            business=self.business,
            customer=customer,
            related_order_id=order_id,
            document_type='Invoice',
        )
        self.assertEqual(invoice.status, 'Sent')
        self.assertEqual(invoice.total, Decimal('5.00'))
        self.assertEqual(invoice.lines.count(), 1)
        invoice_line = invoice.lines.get()
        self.assertEqual(invoice_line.product_code, str(self.inventory_item.id))
        self.assertEqual(invoice_line.product_name, self.inventory_item.name)
        self.assertEqual(invoice_line.total_amount, Decimal('5.00'))

        created_order.refresh_from_db()
        account_tx.refresh_from_db()
        self.assertTrue(created_order.is_invoice_sale)
        self.assertEqual(created_order.invoice_id, str(invoice.id))
        self.assertEqual(account_tx.invoice_id, str(invoice.id))
        self.assertEqual(response.data['results']['acknowledged'][0]['invoice_id'], str(invoice.id))

        customer.refresh_from_db()
        self.assertEqual(customer.current_balance, Decimal('5.00'))

    def test_pos_on_account_sale_creates_linked_invoice(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Live Account Customer',
            phone='0999000777',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)['changes'][0]['data']
        payload['branch'] = self.branch.id
        payload['paymentMethod'] = 'On Account'
        payload['customerId'] = str(customer.id)

        response = self.client.post('/sessions/orders/', payload, format='json')

        self.assertEqual(response.status_code, 201)

        created_order = Order.objects.get(id=order_id)
        invoice = Invoice.objects.get(
            business=self.business,
            customer=customer,
            related_order_id=order_id,
            document_type='Invoice',
        )
        account_tx = CustomerAccountTransaction.objects.get(
            customer=customer,
            order_id=order_id,
            entry_type='credit_sale',
        )

        self.assertEqual(invoice.status, 'Sent')
        self.assertEqual(invoice.total, Decimal('5.00'))
        self.assertEqual(invoice.lines.count(), 1)
        self.assertTrue(created_order.is_invoice_sale)
        self.assertEqual(created_order.invoice_id, str(invoice.id))
        self.assertEqual(account_tx.invoice_id, str(invoice.id))
        self.assertEqual(response.data['invoice_id'], str(invoice.id))
        self.assertTrue(response.data['is_invoice_sale'])

    def test_sync_push_rejects_on_account_sale_above_credit_limit(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Limit Customer',
            phone='0999000666',
            account_enabled=True,
            credit_limit=Decimal('4.00'),
            current_balance=Decimal('1.00'),
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        order_payload = payload['changes'][0]['data']
        order_payload['paymentMethod'] = 'On Account'
        order_payload['customerId'] = str(customer.id)

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.filter(id=order_id).count(), 0)
        self.assertTrue(response.data['results']['errors'])
        self.assertIn('Credit limit exceeded', response.data['results']['errors'][0]['error'])

        customer.refresh_from_db()
        self.assertEqual(customer.current_balance, Decimal('1.00'))
        self.assertFalse(CustomerAccountTransaction.objects.filter(customer=customer).exists())

    def test_sync_push_laybuy_creates_reserved_sale_and_is_idempotent(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Laybuy Customer',
            phone='0999000222',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        order_payload = payload['changes'][0]['data']
        order_payload['paymentMethod'] = 'Laybuy'
        order_payload['customerId'] = str(customer.id)
        order_payload['laybuyDeposit'] = 2.0
        order_payload['laybuyPaymentMethod'] = 'Cash'

        first_response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(first_response.data['results']['errors'], [])

        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.payment_method, 'Laybuy')
        self.assertEqual(created_order.customer_id, customer.id)
        self.assertEqual(created_order.cogs, Decimal('0.00'))

        laybuy = CustomerLaybuy.objects.get(order_id=order_id)
        self.assertEqual(laybuy.customer_id, customer.id)
        self.assertEqual(laybuy.total, Decimal('5.00'))
        self.assertEqual(laybuy.paid_amount, Decimal('2.00'))
        self.assertEqual(laybuy.balance_due, Decimal('3.00'))
        self.assertEqual(CustomerLaybuyPayment.objects.filter(laybuy=laybuy).count(), 1)
        self.assertEqual(CustomerLaybuyReservation.objects.filter(laybuy=laybuy, status='active').count(), 1)

        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('10.000'))
        self.assertEqual(self.inventory_item.reserved_stock_units, Decimal('1.000'))

        reservation = CustomerLaybuyReservation.objects.get(laybuy=laybuy)
        self.assertEqual(reservation.inventory_item_id, self.inventory_item.id)
        self.assertEqual(reservation.quantity, Decimal('1.000'))
        self.assertFalse(
            CustomerAccountTransaction.objects.filter(
                customer=customer,
                order_id=order_id,
                entry_type='credit_sale',
            ).exists()
        )

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_cash_sales, Decimal('2.00'))
        self.assertEqual(self.session.expected_cash, Decimal('2.00'))

        created_order.status = 'Completed'
        created_order.save(update_fields=['status', 'updated_at'])
        self.session.refresh_from_db()
        self.assertEqual(self.session.total_cash_sales, Decimal('2.00'))
        self.assertEqual(self.session.expected_cash, Decimal('2.00'))

        second_response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.data['results']['errors'], [])
        self.assertEqual(CustomerLaybuy.objects.filter(order_id=order_id).count(), 1)
        self.assertEqual(CustomerLaybuyPayment.objects.filter(laybuy=laybuy).count(), 1)
        self.assertEqual(CustomerLaybuyReservation.objects.filter(laybuy=laybuy).count(), 1)

        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('10.000'))
        self.assertEqual(self.inventory_item.reserved_stock_units, Decimal('1.000'))

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_cash_sales, Decimal('2.00'))
        self.assertEqual(self.session.expected_cash, Decimal('2.00'))

    def test_sync_push_rejects_laybuy_deposit_above_total(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Laybuy Limit Customer',
            phone='0999000777',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        order_payload = payload['changes'][0]['data']
        order_payload['paymentMethod'] = 'Laybuy'
        order_payload['customerId'] = str(customer.id)
        order_payload['laybuyDeposit'] = 6.0
        order_payload['laybuy_deposit'] = 6.0

        response = self.client.post('/sessions/sync/push/', payload, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.filter(id=order_id).count(), 0)
        self.assertEqual(CustomerLaybuy.objects.filter(order_id=order_id).count(), 0)
        self.assertTrue(response.data['results']['errors'])
        self.assertIn('Laybuy deposit cannot exceed', response.data['results']['errors'][0]['error'])

    def test_laybuy_collection_consumes_reserved_stock_once(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Collection Customer',
            phone='0999000444',
            account_enabled=True,
        )

        order_id = str(uuid.uuid4())
        payload = self._build_sync_payload(order_id)
        order_payload = payload['changes'][0]['data']
        order_payload['paymentMethod'] = 'Laybuy'
        order_payload['customerId'] = str(customer.id)
        order_payload['laybuyDeposit'] = 2.0
        order_payload['laybuyPaymentMethod'] = 'Cash'

        response = self.client.post('/sessions/sync/push/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results']['errors'], [])

        laybuy = CustomerLaybuy.objects.get(order_id=order_id)
        created_order = Order.objects.get(id=order_id)
        self.assertEqual(created_order.cogs, Decimal('0.00'))
        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('10.000'))
        self.assertEqual(self.inventory_item.reserved_stock_units, Decimal('1.000'))

        record_laybuy_payment(
            laybuy=laybuy,
            amount=Decimal('3.00'),
            branch=self.branch,
            session=self.session,
            payment_method='Card',
            created_by=self.user,
        )
        laybuy.refresh_from_db()
        self.assertEqual(laybuy.balance_due, Decimal('0.00'))
        self.assertEqual(laybuy.status, 'ready_for_collection')

        collected = collect_laybuy(laybuy, created_by=self.user)
        self.assertEqual(collected.status, 'completed')

        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('9.000'))
        self.assertEqual(self.inventory_item.reserved_stock_units, Decimal('0.000'))

        reservation = CustomerLaybuyReservation.objects.get(laybuy=laybuy)
        self.assertEqual(reservation.status, 'fulfilled')
        created_order.refresh_from_db()
        self.assertEqual(created_order.cogs, Decimal('3.00'))

        collect_laybuy(collected, created_by=self.user)
        self.inventory_item.refresh_from_db()
        self.assertEqual(self.inventory_item.stock_units, Decimal('9.000'))
        self.assertEqual(self.inventory_item.reserved_stock_units, Decimal('0.000'))

    def test_customer_and_laybuy_payments_are_reflected_in_session_collections(self):
        customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Account Customer',
            phone='0999000333',
            account_enabled=True,
        )
        Order.objects.create(
            business=self.business,
            branch=self.branch,
            session=self.session,
            customer=customer,
            order_number=8001,
            order_type='sale',
            status='Completed',
            payment_method='On Account',
            subtotal=Decimal('10.00'),
            total=Decimal('10.00'),
            net_amount=Decimal('10.00'),
            gross_amount=Decimal('10.00'),
            vat_amount=Decimal('0.00'),
        )

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_sales, Decimal('10.00'))
        self.assertEqual(self.session.total_on_account_sales, Decimal('10.00'))
        self.assertEqual(self.session.total_cash_sales, Decimal('0.00'))

        record_customer_payment(
            customer=customer,
            amount=Decimal('4.00'),
            branch=self.branch,
            session=self.session,
            payment_method='Cash',
            created_by=self.user,
        )

        laybuy = CustomerLaybuy.objects.create(
            business=self.business,
            branch=self.branch,
            customer=customer,
            subtotal=Decimal('20.00'),
            total=Decimal('20.00'),
            balance_due=Decimal('20.00'),
            created_by=self.user,
        )
        record_laybuy_payment(
            laybuy=laybuy,
            amount=Decimal('5.00'),
            branch=self.branch,
            session=self.session,
            payment_method='Card',
            created_by=self.user,
        )

        self.session.refresh_from_db()
        self.assertEqual(self.session.total_sales, Decimal('10.00'))
        self.assertEqual(self.session.total_on_account_sales, Decimal('10.00'))
        self.assertEqual(self.session.total_cash_sales, Decimal('4.00'))
        self.assertEqual(self.session.total_card_sales, Decimal('5.00'))
        self.assertEqual(self.session.expected_cash, Decimal('4.00'))


class SessionVisibilityTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            email='session-owner@example.com',
            password='test12345',
        )
        self.superuser = User.objects.create_superuser(
            email='super@example.com',
            password='test12345',
        )
        self.business = Business.objects.create(
            owner=self.owner,
            name='Session Visibility Business',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.closed_session = Session.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.owner,
            status='closed',
            opening_float=Decimal('100.00'),
            expected_cash=Decimal('180.00'),
            actual_cash=Decimal('180.00'),
            closing_float=Decimal('180.00'),
            difference=Decimal('0.00'),
            total_sales=Decimal('80.00'),
            total_cash_sales=Decimal('80.00'),
            started_at=timezone.now() - timedelta(hours=4),
            closed_at=timezone.now() - timedelta(hours=1),
        )
        self.client = APIClient()

    def test_superuser_can_list_closed_sessions_without_business_assignment(self):
        self.client.force_authenticate(user=self.superuser)

        response = self.client.get(f'/api/sessions/sessions/?branch_id={self.branch.id}')

        self.assertEqual(response.status_code, 200)
        payload = response.json() if hasattr(response, 'json') else response.data
        session_rows = payload.get('results', payload) if isinstance(payload, dict) else payload
        returned_ids = {str(row['id']) for row in session_rows}
        self.assertIn(str(self.closed_session.id), returned_ids)

    def test_non_admin_staff_sees_only_own_closed_sessions_in_history(self):
        cashier_user = User.objects.create_user(
            email='cashier@example.com',
            password='test12345',
        )
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=cashier_user,
            name='Cashier User',
            email='cashier@example.com',
            role=StaffRole.CASHIER,
            is_active=True,
        )
        cashier_closed_session = Session.objects.create(
            business=self.business,
            branch=self.branch,
            user=cashier_user,
            status='closed',
            opening_float=Decimal('50.00'),
            expected_cash=Decimal('90.00'),
            actual_cash=Decimal('90.00'),
            closing_float=Decimal('90.00'),
            difference=Decimal('0.00'),
            total_sales=Decimal('40.00'),
            total_cash_sales=Decimal('40.00'),
            started_at=timezone.now() - timedelta(hours=3),
            closed_at=timezone.now() - timedelta(minutes=30),
        )

        self.client.force_authenticate(user=cashier_user)

        response = self.client.get(f'/api/sessions/sessions/closed_list/?branch_id={self.branch.id}')

        self.assertEqual(response.status_code, 200)
        payload = response.json() if hasattr(response, 'json') else response.data
        session_rows = payload.get('results', payload) if isinstance(payload, dict) else payload
        returned_ids = {str(row['id']) for row in session_rows}
        self.assertIn(str(cashier_closed_session.id), returned_ids)
        self.assertNotIn(str(self.closed_session.id), returned_ids)

    def test_manager_can_see_business_closed_sessions_in_history(self):
        manager_user = User.objects.create_user(
            email='manager@example.com',
            password='test12345',
        )
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=manager_user,
            name='Manager User',
            email='manager@example.com',
            role=StaffRole.MANAGER,
            is_active=True,
        )

        self.client.force_authenticate(user=manager_user)

        response = self.client.get(f'/api/sessions/sessions/closed_list/?branch_id={self.branch.id}')

        self.assertEqual(response.status_code, 200)
        payload = response.json() if hasattr(response, 'json') else response.data
        session_rows = payload.get('results', payload) if isinstance(payload, dict) else payload
        returned_ids = {str(row['id']) for row in session_rows}
        self.assertIn(str(self.closed_session.id), returned_ids)

    def test_close_session_rounds_long_decimal_money_values(self):
        active_session = Session.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.owner,
            status='active',
            opening_float=Decimal('100.00'),
            expected_cash=Decimal('180.00'),
            total_sales=Decimal('80.00'),
            total_cash_sales=Decimal('80.00'),
            started_at=timezone.now() - timedelta(hours=2),
        )
        self.client.force_authenticate(user=self.owner)

        response = self.client.post(
            f'/api/sessions/sessions/{active_session.id}/close/',
            {
                'actual_cash': '180.00000000000003',
                'closing_float': '180.00000000000003',
                'difference': '0.000000000000028421709430404',
                'closing_stock': [],
                'closed_at': timezone.now().isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        active_session.refresh_from_db()
        self.assertEqual(active_session.status, 'closed')
        self.assertEqual(active_session.actual_cash, Decimal('180.00'))
        self.assertEqual(active_session.closing_float, Decimal('180.00'))
        self.assertEqual(active_session.difference, Decimal('0.00'))
