from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from business.models import Branch, Business
from inventory.models import InventoryItem, MRAProductMapping

User = get_user_model()


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
