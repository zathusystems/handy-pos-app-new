from decimal import Decimal

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from business.models import Branch, Business
from digitalmenu.models import Menu, MenuOption, MenuOptionGroup
from staff.models import Staff, StaffRole


class MenuOptionManagementTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='menu-owner@example.com', password='testpass123')
        self.staff_user = User.objects.create_user(email='menu-staff@example.com', password='testpass123')
        self.business = Business.objects.create(owner=self.owner, name='Menu Test Business', country='Malawi')
        self.branch = Branch.objects.create(business=self.business, name='Main Branch')
        self.menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken and Chips',
            category='Meals',
            price=Decimal('4500.00'),
            is_prepared_item=True,
        )
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.staff_user,
            name='Menu Staff',
            email='menu-staff@example.com',
            role=StaffRole.ADMIN,
            is_active=True,
        )
        self.client = APIClient()

    def test_active_staff_can_load_menu_option_groups(self):
        group = MenuOptionGroup.objects.create(
            menu=self.menu,
            name='Choose a side',
            group_type='side',
            max_select=2,
        )
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': self.menu.id},
        )

        self.assertEqual(response.status_code, 200, response.data)
        rows = response.data if isinstance(response.data, list) else response.data['results']
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]['id']), str(group.id))

    def test_active_staff_can_load_branch_menu_for_option_resolution(self):
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.get(
            '/api/digital-menu/menu/by_branch/',
            {'branch_id': self.branch.id},
        )

        self.assertEqual(response.status_code, 200, response.data)
        rows = response.data if isinstance(response.data, list) else response.data['results']
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]['id']), str(self.menu.id))

    def test_active_staff_can_completely_delete_menu_item(self):
        group = MenuOptionGroup.objects.create(
            menu=self.menu,
            name='Choose a side',
            group_type='side',
            max_select=1,
        )
        MenuOption.objects.create(group=group, name='Chips')
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.post(
            '/api/digital-menu/menu/delete_item/',
            {
                'branch_id': self.branch.id,
                'menu_item_id': str(self.menu.id),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(Menu.objects.filter(id=self.menu.id).exists())
        self.assertFalse(MenuOptionGroup.objects.filter(id=group.id).exists())
        self.assertEqual(response.data['deleted'], True)

    def test_active_staff_can_create_menu_option_group(self):
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.post(
            '/api/digital-menu/menu-option-groups/',
            {
                'menu': str(self.menu.id),
                'name': 'Choose sauce',
                'group_type': 'side',
                'is_required': False,
                'min_select': 0,
                'max_select': 2,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(
            MenuOptionGroup.objects.filter(id=response.data['id'], menu=self.menu).exists()
        )

    def test_required_group_defaults_minimum_to_one(self):
        self.client.force_authenticate(user=self.owner)

        response = self.client.post(
            '/api/digital-menu/menu-option-groups/',
            {
                'menu': str(self.menu.id),
                'name': 'Choose a side',
                'group_type': 'side',
                'is_required': True,
                'min_select': 0,
                'max_select': 2,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        group = MenuOptionGroup.objects.get(id=response.data['id'])
        self.assertEqual(group.min_select, 1)

    def test_group_rejects_minimum_greater_than_maximum(self):
        self.client.force_authenticate(user=self.owner)

        response = self.client.post(
            '/api/digital-menu/menu-option-groups/',
            {
                'menu': str(self.menu.id),
                'name': 'Choose sauces',
                'group_type': 'addon',
                'is_required': True,
                'min_select': 3,
                'max_select': 2,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('min_select', response.data)
