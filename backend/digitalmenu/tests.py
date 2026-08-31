from decimal import Decimal

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from business.models import Branch, Business
from digitalmenu.models import Menu, MenuConfig, MenuOption, MenuOptionGroup, MenuOptionGroupMenu
from inventory.models import InventoryItem
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

    def test_active_staff_can_update_prepared_menu_item(self):
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.patch(
            '/api/digital-menu/menu/update_item/',
            {
                'branch_id': self.branch.id,
                'menu_item_id': str(self.menu.id),
                'name': 'Grilled Chicken and Chips',
                'category': 'Grill',
                'description': 'Served with kachumbari',
                'price': '5500.00',
                'recipe': [{'ingredientId': 'salt', 'name': 'Salt', 'quantity': 1}],
                'is_visible': False,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.menu.refresh_from_db()
        self.assertEqual(self.menu.name, 'Grilled Chicken and Chips')
        self.assertEqual(self.menu.category, 'Grill')
        self.assertEqual(self.menu.description, 'Served with kachumbari')
        self.assertEqual(self.menu.price, Decimal('5500.00'))
        self.assertEqual(self.menu.recipe[0]['name'], 'Salt')
        self.assertFalse(self.menu.is_visible)

    def test_active_staff_can_update_inventory_backed_menu_item_source_product(self):
        inventory_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Coca Cola',
            category='Drinks',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            unit_type='bottle',
            price=Decimal('1500.00'),
            on_menu=True,
        )
        inventory_menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            inventory_item=inventory_item,
            is_visible=True,
        )
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.patch(
            '/api/digital-menu/menu/update_item/',
            {
                'branch_id': self.branch.id,
                'menu_item_id': str(inventory_menu.id),
                'name': 'Coca Cola 500ml',
                'category': 'Soft Drinks',
                'description': 'Chilled bottle',
                'price': '1800.00',
                'is_visible': False,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        inventory_item.refresh_from_db()
        inventory_menu.refresh_from_db()
        self.assertEqual(inventory_item.name, 'Coca Cola 500ml')
        self.assertEqual(inventory_item.category, 'Soft Drinks')
        self.assertEqual(inventory_item.price, Decimal('1800.00'))
        self.assertEqual(inventory_menu.description, 'Chilled bottle')
        self.assertFalse(inventory_menu.is_visible)

    def test_create_prepared_item_creates_produced_sellable_inventory_product(self):
        ingredient = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef',
            category='Ingredients',
            item_type='ingredient',
            stock_units=Decimal('10.000'),
            unit_type='kg',
            price=Decimal('0.00'),
            is_recipe_ingredient=True,
        )
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.post(
            '/api/digital-menu/menu/create_prepared_item/',
            {
                'branch_id': self.branch.id,
                'name': 'Nsima Beef',
                'category': 'Meals',
                'description': 'Served with vegetables',
                'price': '6500.00',
                'recipe': [
                    {
                        'ingredientId': str(ingredient.id),
                        'inventoryItemId': str(ingredient.id),
                        'name': 'Beef',
                        'quantity': 0.25,
                        'unit': 'kg',
                    }
                ],
                'is_visible': True,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        menu_item = Menu.objects.get(id=response.data['id'])
        self.assertIsNotNone(menu_item.inventory_item)
        self.assertFalse(menu_item.is_prepared_item)
        self.assertEqual(menu_item.description, 'Served with vegetables')

        inventory_item = menu_item.inventory_item
        self.assertEqual(inventory_item.name, 'Nsima Beef')
        self.assertEqual(inventory_item.category, 'Meals')
        self.assertEqual(inventory_item.item_type, 'sellable')
        self.assertTrue(inventory_item.is_produced)
        self.assertTrue(inventory_item.on_menu)
        self.assertEqual(inventory_item.price, Decimal('6500.00'))
        self.assertEqual(inventory_item.recipe[0]['name'], 'Beef')
        self.assertEqual(str(response.data['item_details']['id']), str(inventory_item.id))

    def test_menu_config_uses_inventory_packaging_selling_price(self):
        packaging_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Takeaway Cup',
            category='Packaging',
            item_type='ingredient',
            stock_units=Decimal('25.000'),
            price=Decimal('175.00'),
        )
        MenuConfig.objects.create(
            business=self.business,
            branch=self.branch,
            takeaway_enabled=True,
            takeaway_packaging_item=packaging_item,
            takeaway_packaging_price=Decimal('999.00'),
        )

        response = self.client.get(
            '/api/digital-menu/menu-config/public/',
            {'branch_id': self.branch.id},
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(Decimal(str(response.data['takeaway_packaging_price'])), Decimal('175.00'))

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

    def test_shared_choice_set_can_be_reused_and_detached(self):
        second_menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            name='Chicken Burger',
            category='Meals',
            price=Decimal('5000.00'),
            is_prepared_item=True,
        )
        self.client.force_authenticate(user=self.staff_user)

        create_response = self.client.post(
            '/api/digital-menu/menu-option-groups/',
            {
                'menu': str(self.menu.id),
                'name': 'Extras',
                'group_type': 'addon',
                'is_shared': True,
                'min_select': 0,
                'max_select': 3,
            },
            format='json',
        )

        self.assertEqual(create_response.status_code, 201, create_response.data)
        group = MenuOptionGroup.objects.get(id=create_response.data['id'])
        self.assertTrue(group.is_shared)
        self.assertTrue(
            MenuOptionGroupMenu.objects.filter(group=group, menu=self.menu).exists()
        )

        attach_response = self.client.post(
            f'/api/digital-menu/menu-option-groups/{group.id}/attach/',
            {'menu': str(second_menu.id)},
            format='json',
        )

        self.assertEqual(attach_response.status_code, 200, attach_response.data)
        self.assertEqual(attach_response.data['attached_menu_count'], 2)
        self.assertTrue(
            MenuOptionGroupMenu.objects.filter(group=group, menu=second_menu).exists()
        )

        second_menu_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(second_menu.id)},
        )
        self.assertEqual(second_menu_response.status_code, 200, second_menu_response.data)
        second_menu_groups = (
            second_menu_response.data
            if isinstance(second_menu_response.data, list)
            else second_menu_response.data['results']
        )
        self.assertEqual(len(second_menu_groups), 1)
        self.assertEqual(second_menu_groups[0]['name'], 'Extras')

        menu_response = self.client.get(
            '/api/digital-menu/menu/by_branch/',
            {'branch_id': self.branch.id},
        )
        self.assertEqual(menu_response.status_code, 200, menu_response.data)
        menu_rows = menu_response.data if isinstance(menu_response.data, list) else menu_response.data['results']
        second_menu_row = next(row for row in menu_rows if str(row['id']) == str(second_menu.id))
        self.assertEqual([group['name'] for group in second_menu_row['option_groups']], ['Extras'])

        detach_response = self.client.post(
            f'/api/digital-menu/menu-option-groups/{group.id}/detach/',
            {'menu': str(second_menu.id)},
            format='json',
        )
        self.assertEqual(detach_response.status_code, 200, detach_response.data)
        self.assertFalse(
            MenuOptionGroupMenu.objects.filter(group=group, menu=second_menu).exists()
        )

    def test_shared_choice_can_be_customized_or_removed_for_one_menu_item(self):
        second_menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            name='Beef Burger',
            category='Meals',
            price=Decimal('5000.00'),
            is_prepared_item=True,
        )
        group = MenuOptionGroup.objects.create(
            menu=self.menu,
            name='Sides',
            group_type='side',
            is_shared=True,
            max_select=1,
        )
        option = MenuOption.objects.create(
            group=group,
            name='Chips',
            price_delta=Decimal('500.00'),
        )
        MenuOptionGroupMenu.objects.get_or_create(group=group, menu=self.menu)
        MenuOptionGroupMenu.objects.create(group=group, menu=second_menu)
        self.client.force_authenticate(user=self.staff_user)

        customize_response = self.client.post(
            f'/api/digital-menu/menu-options/{option.id}/customize-for-item/',
            {
                'menu': str(second_menu.id),
                'name': 'Sweet potato fries',
                'price_delta': '750.00',
            },
            format='json',
        )

        self.assertEqual(customize_response.status_code, 200, customize_response.data)
        option.refresh_from_db()
        self.assertEqual(option.name, 'Chips')
        self.assertEqual(option.price_delta, Decimal('500.00'))
        assignment = MenuOptionGroupMenu.objects.get(group=group, menu=second_menu)
        self.assertEqual(assignment.option_overrides[str(option.id)]['name'], 'Sweet potato fries')

        second_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(second_menu.id)},
        )
        second_rows = second_response.data if isinstance(second_response.data, list) else second_response.data['results']
        self.assertEqual(second_rows[0]['options'][0]['name'], 'Sweet potato fries')
        self.assertTrue(second_rows[0]['options'][0]['is_overridden'])

        owner_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(self.menu.id)},
        )
        owner_rows = owner_response.data if isinstance(owner_response.data, list) else owner_response.data['results']
        self.assertEqual(owner_rows[0]['options'][0]['name'], 'Chips')
        self.assertFalse(owner_rows[0]['options'][0]['is_overridden'])

        source_update_response = self.client.patch(
            f'/api/digital-menu/menu-options/{option.id}/',
            {'name': 'Potato wedges'},
            format='json',
        )
        self.assertEqual(source_update_response.status_code, 200, source_update_response.data)
        owner_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(self.menu.id)},
        )
        owner_rows = owner_response.data if isinstance(owner_response.data, list) else owner_response.data['results']
        self.assertEqual(owner_rows[0]['options'][0]['name'], 'Potato wedges')
        second_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(second_menu.id)},
        )
        second_rows = second_response.data if isinstance(second_response.data, list) else second_response.data['results']
        self.assertEqual(second_rows[0]['options'][0]['name'], 'Sweet potato fries')

        remove_response = self.client.post(
            f'/api/digital-menu/menu-options/{option.id}/remove-from-item/',
            {'menu': str(second_menu.id)},
            format='json',
        )
        self.assertEqual(remove_response.status_code, 200, remove_response.data)
        second_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(second_menu.id)},
        )
        second_rows = second_response.data if isinstance(second_response.data, list) else second_response.data['results']
        self.assertEqual(second_rows[0]['options'], [])
        self.assertEqual(second_rows[0]['removed_options'][0]['name'], 'Sweet potato fries')

        restore_response = self.client.post(
            f'/api/digital-menu/menu-options/{option.id}/restore-for-item/',
            {'menu': str(second_menu.id)},
            format='json',
        )
        self.assertEqual(restore_response.status_code, 200, restore_response.data)
        second_response = self.client.get(
            '/api/digital-menu/menu-option-groups/',
            {'menu_id': str(second_menu.id)},
        )
        second_rows = second_response.data if isinstance(second_response.data, list) else second_response.data['results']
        self.assertEqual(second_rows[0]['options'][0]['name'], 'Potato wedges')

    def test_deleting_a_shared_source_requires_global_confirmation(self):
        second_menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            name='Second menu item',
            category='Meals',
            price=Decimal('5000.00'),
            is_prepared_item=True,
        )
        group = MenuOptionGroup.objects.create(
            menu=self.menu,
            name='Extras',
            group_type='addon',
            is_shared=True,
        )
        option = MenuOption.objects.create(group=group, name='Sauce')
        MenuOptionGroupMenu.objects.get_or_create(group=group, menu=self.menu)
        MenuOptionGroupMenu.objects.create(group=group, menu=second_menu)
        self.client.force_authenticate(user=self.staff_user)

        response = self.client.delete(f'/api/digital-menu/menu-options/{option.id}/')

        self.assertEqual(response.status_code, 409, response.data)
        self.assertTrue(response.data['requires_confirmation'])
        self.assertTrue(MenuOption.objects.filter(id=option.id).exists())

        response = self.client.delete(
            f'/api/digital-menu/menu-options/{option.id}/?confirm_global=true',
        )

        self.assertEqual(response.status_code, 204, response.data)
        self.assertFalse(MenuOption.objects.filter(id=option.id).exists())
