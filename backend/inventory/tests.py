from decimal import Decimal
import uuid

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase
from django.utils import timezone

from business.models import Branch, Business, BusinessSettings
from inventory.models import InventoryItem, MRAProductMapping
from inventory.models import PurchaseOrder, PurchaseOrderItem
from mra_eis.models import MRAConfiguration

User = get_user_model()


class PurchaseHistoryAccessTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='purchase-owner@example.com', password='test123')
        self.staff_user = User.objects.create_user(email='purchase-staff@example.com', password='test123')
        self.business = Business.objects.create(owner=self.owner, name='Purchase Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        from staff.models import Staff

        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.staff_user,
            name='Purchase Staff',
            email='purchase-staff@example.com',
            role='Cashier',
        )
        self.inventory_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Stock item',
            category='General',
            item_type='sellable',
            price=Decimal('100.00'),
        )
        self.purchase_order = PurchaseOrder.objects.create(
            business=self.business,
            branch=self.branch,
            order_number=uuid.uuid4(),
            status='Received',
            total_items=1,
            total_cost=Decimal('100.00'),
            payment_status='Paid',
            amount_paid=Decimal('100.00'),
            amount_due=Decimal('0.00'),
            created_by='Purchase Staff',
        )
        PurchaseOrderItem.objects.create(
            purchase_order=self.purchase_order,
            inventory_item=self.inventory_item,
            quantity_ordered=1,
            quantity_received=1,
            quantity_remaining=1,
            cost_per_unit=Decimal('100.00'),
        )

    def test_assigned_staff_can_view_purchase_history(self):
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.get(
            f'/api/inventory/purchase-orders/?business_id={self.business.id}&branch_id={self.branch.id}'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        records = response.data.get('results', response.data)
        self.assertEqual(len(records), 1)
        self.assertEqual(str(records[0]['id']), str(self.purchase_order.id))
        self.assertIn('received_date', records[0])


class MRAProductMappingCreateTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(email='owner@example.com', password='test123')
        self.client.force_authenticate(user=self.user)

        self.business = Business.objects.create(owner=self.user, name='Test Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )

        self.item_1 = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Sugar 1kg',
            category='Grocery',
            item_type='sellable',
            price=Decimal('3000.00'),
        )
        self.item_2 = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Rice 1kg',
            category='Grocery',
            item_type='sellable',
            price=Decimal('4500.00'),
        )

        self.url = '/api/inventory/mra-mappings/'

    def test_single_mapping_create_still_works(self):
        payload = {
            'inventory_item_id': str(self.item_1.id),
            'mra_product_code': 'GROC-001',
            'mra_product_name': 'Sugar',
            'mra_tax_type': 'standard',
            'mra_tax_rate': '16.50',
            'mra_unit_measure': 'unit',
            'tax_calculation_method': 'inclusive',
        }

        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        mapping = MRAProductMapping.objects.get(inventory_item=self.item_1)
        self.assertEqual(mapping.mra_product_code, 'GROC-001')
        self.assertEqual(mapping.tax_calculation_method, 'inclusive')
        self.assertEqual(mapping.mra_tax_rate, Decimal('16.50'))

    def test_bulk_mapping_create_supports_per_row_tax_configuration(self):
        payload = {
            'mappings': [
                {
                    'inventory_item_id': str(self.item_1.id),
                    'mra_product_code': 'GROC-001',
                    'mra_product_name': 'Sugar',
                    'mra_tax_type': 'standard',
                    'mra_tax_rate': '16.50',
                    'mra_unit_measure': 'unit',
                    'tax_calculation_method': 'exclusive',
                },
                {
                    'inventory_item_id': str(self.item_2.id),
                    'mra_product_code': 'GROC-002',
                    'mra_product_name': 'Rice',
                    'mra_tax_type': 'zero',
                    'mra_tax_rate': '0.00',
                    'mra_unit_measure': 'kg',
                    'tax_calculation_method': 'exclusive',
                },
            ]
        }

        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data.get('count'), 2)

        first_mapping = MRAProductMapping.objects.get(inventory_item=self.item_1)
        second_mapping = MRAProductMapping.objects.get(inventory_item=self.item_2)

        self.assertEqual(first_mapping.mra_tax_rate, Decimal('16.50'))
        self.assertEqual(first_mapping.tax_calculation_method, 'exclusive')

        self.assertEqual(second_mapping.mra_tax_rate, Decimal('0.00'))
        # Zero/exempt rows are normalized to inclusive by serializer validation.
        self.assertEqual(second_mapping.tax_calculation_method, 'inclusive')
        self.assertEqual(second_mapping.mra_unit_measure, 'kg')

    def test_bulk_mapping_rejects_existing_mappings_without_partial_writes(self):
        MRAProductMapping.objects.create(
            inventory_item=self.item_1,
            branch=self.branch,
            mra_product_code='GROC-EXIST',
            mra_product_name='Sugar Existing',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            tax_calculation_method='inclusive',
            is_approved=False,
            mra_synced=False,
        )

        payload = {
            'mappings': [
                {
                    'inventory_item_id': str(self.item_1.id),
                    'mra_product_code': 'GROC-001',
                    'mra_product_name': 'Sugar',
                    'mra_tax_type': 'standard',
                    'mra_tax_rate': '16.50',
                    'mra_unit_measure': 'unit',
                    'tax_calculation_method': 'inclusive',
                },
                {
                    'inventory_item_id': str(self.item_2.id),
                    'mra_product_code': 'GROC-002',
                    'mra_product_name': 'Rice',
                    'mra_tax_type': 'standard',
                    'mra_tax_rate': '16.50',
                    'mra_unit_measure': 'unit',
                    'tax_calculation_method': 'inclusive',
                },
            ]
        }

        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn(str(self.item_1.id), response.data.get('inventory_item_ids', []))
        # Ensure no partial writes for remaining items.
        self.assertFalse(MRAProductMapping.objects.filter(inventory_item=self.item_2).exists())

    def test_approval_does_not_claim_mapping_was_synced(self):
        mapping = MRAProductMapping.objects.create(
            inventory_item=self.item_1,
            branch=self.branch,
            mra_product_code='GROC-APPROVAL',
            mra_product_name='Sugar',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            tax_calculation_method='inclusive',
            is_approved=False,
            mra_synced=False,
        )

        response = self.client.post(
            f'{self.url}{mapping.id}/approve/',
            {'is_approved': True, 'mra_synced': True},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        mapping.refresh_from_db()
        self.assertTrue(mapping.is_approved)
        self.assertFalse(mapping.mra_synced)

    @override_settings(MRA_EIS_STRICT_PRODUCT_CODES=True)
    def test_eis_mapping_must_use_active_catalog_code(self):
        BusinessSettings.objects.create(business=self.business, enable_eis=True)
        MRAConfiguration.objects.create(
            business=self.business,
            config_type='product_codes',
            config_version='catalog-1',
            config_data={'items': [{'productCode': 'GROC-PORTAL', 'name': 'Portal Sugar'}]},
            effective_from=timezone.now(),
            fetched_from_mra_at=timezone.now(),
            is_active=True,
        )

        unknown_response = self.client.post(
            self.url,
            {
                'inventory_item_id': str(self.item_1.id),
                'mra_product_code': 'LOCAL-ONLY',
                'mra_product_name': 'Local label',
                'mra_tax_type': 'standard',
                'mra_tax_rate': '16.50',
                'mra_unit_measure': 'unit',
                'tax_calculation_method': 'inclusive',
            },
            format='json',
        )
        self.assertEqual(unknown_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('mra_product_code', unknown_response.data)

        valid_response = self.client.post(
            self.url,
            {
                'inventory_item_id': str(self.item_1.id),
                'mra_product_code': 'groc-portal',
                'mra_product_name': 'Stale local label',
                'mra_tax_type': 'standard',
                'mra_tax_rate': '16.50',
                'mra_unit_measure': 'unit',
                'tax_calculation_method': 'inclusive',
            },
            format='json',
        )
        self.assertEqual(valid_response.status_code, status.HTTP_201_CREATED)
        mapping = MRAProductMapping.objects.get(inventory_item=self.item_1)
        self.assertEqual(mapping.mra_product_code, 'GROC-PORTAL')
        self.assertEqual(mapping.mra_product_name, 'Portal Sugar')


class InventoryItemFlagNormalizationTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(email='inventory-owner@example.com', password='test123')
        self.business = Business.objects.create(owner=self.user, name='Inventory Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )

    def test_produced_sellable_clears_variable_price_and_portions(self):
        item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken Pizza',
            category='Meals',
            item_type='sellable',
            price=Decimal('30000.00'),
            is_produced=True,
            is_variable_price=True,
            is_sold_in_portions=True,
            portion_name='Slice',
            portions_per_unit=8,
            portion_price=Decimal('4000.00'),
        )

        item.refresh_from_db()

        self.assertTrue(item.is_produced)
        self.assertFalse(item.is_variable_price)
        self.assertFalse(item.is_sold_in_portions)
        self.assertIsNone(item.portion_name)
        self.assertIsNone(item.portions_per_unit)
        self.assertIsNone(item.portion_price)

    def test_ingredient_clears_sellable_only_flags(self):
        item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Mozzarella',
            category='Ingredients',
            item_type='ingredient',
            stock_units=Decimal('5.000'),
            is_produced=True,
            is_variable_price=True,
            is_sold_in_portions=True,
            show_in_custom_sales_section=True,
        )

        item.refresh_from_db()

        self.assertFalse(item.is_produced)
        self.assertFalse(item.is_variable_price)
        self.assertFalse(item.is_sold_in_portions)
        self.assertFalse(item.show_in_custom_sales_section)
