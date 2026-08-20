from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from business.models import Branch, Business
from staff.models import Staff, StaffRole

User = get_user_model()


class StaffUpdateTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            email='owner@example.com',
            password='owner-pass',
        )
        self.client.force_authenticate(user=self.owner)

        self.business = Business.objects.create(
            owner=self.owner,
            name='Test Business',
        )
        self.main_branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='123 Main St',
            city='Lilongwe',
            country='Malawi',
        )
        self.second_branch = Branch.objects.create(
            business=self.business,
            name='Second Branch',
            address='456 Side St',
            city='Blantyre',
            country='Malawi',
        )

        self.staff_user = User.objects.create_user(
            email='cashier@example.com',
            password='old-pass',
        )
        self.staff = Staff.objects.create(
            business=self.business,
            branch=self.main_branch,
            user=self.staff_user,
            name='Cashier One',
            email='cashier@example.com',
            role=StaffRole.CASHIER,
        )

    def test_owner_can_update_staff_without_needing_owner_staff_profile(self):
        response = self.client.patch(
            f'/api/staff/{self.staff.id}/',
            {
                'name': 'Updated Cashier',
                'email': 'updated.cashier@example.com',
                'role': StaffRole.MANAGER,
                'branch': self.second_branch.id,
                'is_active': False,
                'password': 'new-secret',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.staff.refresh_from_db()
        self.staff_user.refresh_from_db()

        self.assertEqual(self.staff.name, 'Updated Cashier')
        self.assertEqual(self.staff.email, 'updated.cashier@example.com')
        self.assertEqual(self.staff.role, StaffRole.MANAGER)
        self.assertEqual(self.staff.branch_id, self.second_branch.id)
        self.assertFalse(self.staff.is_active)

        self.assertEqual(self.staff_user.email, 'updated.cashier@example.com')
        self.assertEqual(self.staff_user.first_name, 'Updated')
        self.assertEqual(self.staff_user.last_name, 'Cashier')
        self.assertFalse(self.staff_user.is_active)
        self.assertTrue(self.staff_user.check_password('new-secret'))
