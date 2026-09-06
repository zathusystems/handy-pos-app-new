from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase

from business.models import Branch, Business, TaxRate
from inventory.models import InventoryItem, MRAProductMapping
from pos_sessions.tax_utils import calculate_eis_tax_snapshot_for_order_lines


User = get_user_model()

class EISTaxSnapshotTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='eis-tax-source@example.com',
            password='test12345',
        )
        self.business = Business.objects.create(owner=self.user, name='EIS Tax Source Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main Street',
            city='Lilongwe',
            country='Malawi',
        )
        self.item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Mapped Soda',
            category='Beverages',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            cost=Decimal('50.00'),
            price=Decimal('116.50'),
            value=Decimal('500.00'),
        )
        MRAProductMapping.objects.create(
            inventory_item=self.item,
            branch=self.branch,
            mra_product_code='SODA-EIS-001',
            mra_product_name='Mapped Soda',
            mra_tax_type='standard',
            mra_tax_rate=Decimal('16.50'),
            mra_unit_measure='unit',
            tax_calculation_method='inclusive',
            is_approved=True,
            mra_synced=True,
        )
        TaxRate.objects.create(
            business=self.business,
            name='Local VAT that EIS must ignore',
            rate=Decimal('5.00'),
            tax_type='VAT_STANDARD',
            is_default=True,
            effective_from='2026-01-01',
            is_active=True,
            created_by=self.user,
        )

    def test_uses_the_approved_mra_mapping_instead_of_local_vat(self):
        snapshot = calculate_eis_tax_snapshot_for_order_lines(
            self.business,
            self.branch,
            [{
                'inventory_item_id': str(self.item.id),
                'name': self.item.name,
                'quantity': 1,
                'price': '116.50',
                'total': '116.50',
            }],
        )

        self.assertEqual(snapshot['net_amount'], Decimal('100.00'))
        self.assertEqual(snapshot['vat_amount'], Decimal('16.50'))
        self.assertEqual(snapshot['gross_amount'], Decimal('116.50'))
        self.assertEqual(snapshot['tax_rate_value'], Decimal('16.50'))
        self.assertEqual(snapshot['line_snapshots'][0]['tax_rate'], Decimal('16.50'))
