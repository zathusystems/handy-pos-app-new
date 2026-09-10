from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from business.models import Branch, Business
from staff.models import Staff, StaffRole

from .models import AttendanceRecord, Employee, EmploymentTerm, LeaveBalance, LeaveRequest, LeaveType, OvertimeRequest, WorkShift


User = get_user_model()


class EmployeeAPITests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='owner@example.com', password='owner-pass')
        self.business = Business.objects.create(owner=self.owner, name='People Test Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='Main Road',
            city='Lilongwe',
            country='Malawi',
        )
        self.admin_user = User.objects.create_user(email='admin@example.com', password='admin-pass')
        self.admin_staff = Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.admin_user,
            name='Business Admin',
            email='admin@example.com',
            role=StaffRole.ADMIN,
        )
        self.cashier_user = User.objects.create_user(email='cashier@example.com', password='cashier-pass')
        self.cashier_staff = Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.cashier_user,
            name='Cashier',
            email='cashier@example.com',
            role=StaffRole.CASHIER,
        )

    def employee_payload(self, **overrides):
        payload = {
            'business_id': self.business.id,
            'first_name': 'Thandiwe',
            'last_name': 'Banda',
            'email': 'thandiwe@example.com',
            'phone': '0999000000',
            'employment_status': 'active',
            'started_on': '2026-09-01',
            'initial_employment_term': {
                'branch': self.branch.id,
                'job_title': 'Cashier',
                'department': 'Front of house',
                'employment_type': 'full_time',
                'pay_frequency': 'monthly',
                'base_salary': '250000.00',
                'currency': 'MWK',
                'effective_from': '2026-09-01',
            },
        }
        payload.update(overrides)
        return payload

    def test_owner_can_create_employee_with_initial_term(self):
        self.client.force_authenticate(self.owner)

        response = self.client.post('/api/hr/employees/', self.employee_payload(), format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        employee = Employee.objects.get(pk=response.data['id'])
        self.assertEqual(employee.employee_number, 1)
        self.assertEqual(employee.employee_code, 'EMP-0001')
        self.assertEqual(employee.employment_terms.count(), 1)
        self.assertEqual(employee.employment_terms.first().base_salary, Decimal('250000.00'))

    def test_admin_staff_can_manage_people_for_assigned_business(self):
        self.client.force_authenticate(self.admin_user)

        response = self.client.post('/api/hr/employees/', self.employee_payload(), format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Employee.objects.filter(business=self.business).count(), 1)

    def test_operational_staff_cannot_access_people_records(self):
        Employee.objects.create(
            business=self.business,
            first_name='Existing',
            last_name='Employee',
        )
        self.client.force_authenticate(self.cashier_user)

        response = self.client.get(f'/api/hr/employees/?business_id={self.business.id}')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_link_staff_account_from_another_business(self):
        other_owner = User.objects.create_user(email='other-owner@example.com', password='other-pass')
        other_business = Business.objects.create(owner=other_owner, name='Other Business')
        other_branch = Branch.objects.create(
            business=other_business,
            name='Other Branch',
            address='Other Road',
            city='Blantyre',
            country='Malawi',
        )
        other_staff_user = User.objects.create_user(email='other-staff@example.com', password='other-pass')
        other_staff = Staff.objects.create(
            business=other_business,
            branch=other_branch,
            user=other_staff_user,
            name='Other Staff',
            email='other-staff@example.com',
            role=StaffRole.CASHIER,
        )
        self.client.force_authenticate(self.owner)

        response = self.client.post(
            '/api/hr/employees/',
            self.employee_payload(staff=other_staff.id),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('staff', response.data)

    def test_new_employment_term_closes_the_previous_open_term(self):
        employee = Employee.objects.create(
            business=self.business,
            first_name='Thandiwe',
            last_name='Banda',
        )
        EmploymentTerm.objects.create(
            employee=employee,
            branch=self.branch,
            job_title='Cashier',
            base_salary=Decimal('250000.00'),
            effective_from=date(2026, 9, 1),
        )
        self.client.force_authenticate(self.owner)

        response = self.client.post('/api/hr/employment-terms/', {
            'employee': str(employee.id),
            'branch': self.branch.id,
            'job_title': 'Senior Cashier',
            'employment_type': 'full_time',
            'pay_frequency': 'monthly',
            'base_salary': '300000.00',
            'currency': 'MWK',
            'effective_from': '2026-10-01',
        }, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        first_term = EmploymentTerm.objects.get(employee=employee, job_title='Cashier')
        self.assertEqual(first_term.effective_to, date(2026, 9, 30))
        self.assertEqual(employee.employment_terms.count(), 2)

    def test_overlapping_backdated_term_is_rejected(self):
        employee = Employee.objects.create(
            business=self.business,
            first_name='Thandiwe',
            last_name='Banda',
        )
        EmploymentTerm.objects.create(
            employee=employee,
            branch=self.branch,
            job_title='Cashier',
            base_salary=Decimal('250000.00'),
            effective_from=date(2026, 9, 1),
        )
        self.client.force_authenticate(self.owner)

        response = self.client.post('/api/hr/employment-terms/', {
            'employee': str(employee.id),
            'branch': self.branch.id,
            'job_title': 'Senior Cashier',
            'employment_type': 'full_time',
            'pay_frequency': 'monthly',
            'base_salary': '300000.00',
            'currency': 'MWK',
            'effective_from': '2026-09-01',
        }, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(
            'effective_from' in response.data or 'non_field_errors' in response.data,
        )


class PeopleOperationsAPITests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='owner-operations@example.com', password='owner-pass')
        self.business = Business.objects.create(owner=self.owner, name='Operations Test Business')
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='Main Road',
            city='Lilongwe',
            country='Malawi',
        )
        self.staff_user = User.objects.create_user(email='worker@example.com', password='worker-pass')
        self.staff = Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=self.staff_user,
            name='Linked Worker',
            email='worker@example.com',
            role=StaffRole.CASHIER,
        )
        self.employee = Employee.objects.create(
            business=self.business,
            staff=self.staff,
            first_name='Linked',
            last_name='Worker',
        )

    def create_leave_setup(self):
        leave_type = LeaveType.objects.create(
            business=self.business,
            name='Annual leave',
            code='ANNUAL',
            annual_allowance_days=Decimal('20.00'),
        )
        LeaveBalance.objects.create(
            employee=self.employee,
            leave_type=leave_type,
            year=2026,
            entitlement_days=Decimal('20.00'),
        )
        return leave_type

    def test_linked_employee_can_clock_in_and_clock_out(self):
        self.client.force_authenticate(self.staff_user)

        clock_in = self.client.post('/api/hr/attendance/clock-in/', {'branch': self.branch.id}, format='json')
        self.assertEqual(clock_in.status_code, status.HTTP_201_CREATED)
        self.assertEqual(clock_in.data['status'], AttendanceRecord.Status.OPEN)

        clock_out = self.client.post('/api/hr/attendance/clock-out/', {}, format='json')
        self.assertEqual(clock_out.status_code, status.HTTP_200_OK)
        self.assertEqual(clock_out.data['status'], AttendanceRecord.Status.SUBMITTED)
        self.assertIsNotNone(clock_out.data['clock_out'])

    def test_operational_staff_cannot_create_manual_attendance_for_another_employee(self):
        other_employee = Employee.objects.create(
            business=self.business,
            first_name='Other',
            last_name='Employee',
        )
        self.client.force_authenticate(self.staff_user)

        response = self.client.post('/api/hr/attendance/', {
            'employee': str(other_employee.id),
            'branch': self.branch.id,
            'work_date': '2026-09-07',
            'clock_in': '2026-09-07T08:00:00Z',
            'clock_out': '2026-09-07T17:00:00Z',
            'break_minutes': 60,
        }, format='json')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(AttendanceRecord.objects.filter(employee=other_employee).exists())

    def test_owner_can_schedule_a_shift_and_cancel_it(self):
        self.client.force_authenticate(self.owner)
        payload = {
            'employee': str(self.employee.id),
            'branch': self.branch.id,
            'work_date': '2026-09-10',
            'starts_at': '08:00:00',
            'ends_at': '17:00:00',
            'break_minutes': 60,
        }

        create_response = self.client.post('/api/hr/shifts/', payload, format='json')
        self.assertEqual(create_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(create_response.data['scheduled_minutes'], 480)

        cancel_response = self.client.post(f"/api/hr/shifts/{create_response.data['id']}/cancel/", {}, format='json')
        self.assertEqual(cancel_response.status_code, status.HTTP_200_OK)
        self.assertEqual(cancel_response.data['status'], WorkShift.Status.CANCELLED)

    def test_leave_request_is_self_service_and_requires_available_balance_to_approve(self):
        leave_type = self.create_leave_setup()
        self.client.force_authenticate(self.staff_user)
        request_response = self.client.post('/api/hr/leave-requests/', {
            'leave_type': str(leave_type.id),
            'start_date': '2026-09-07',
            'end_date': '2026-09-11',
            'reason': 'Annual break',
        }, format='json')

        self.assertEqual(request_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(request_response.data['requested_days'], '5.00')
        leave_request = LeaveRequest.objects.get(pk=request_response.data['id'])
        self.assertEqual(leave_request.employee, self.employee)

        self.client.force_authenticate(self.owner)
        approval_response = self.client.post(f'/api/hr/leave-requests/{leave_request.id}/approve/', {}, format='json')
        self.assertEqual(approval_response.status_code, status.HTTP_200_OK)
        self.assertEqual(approval_response.data['status'], LeaveRequest.Status.APPROVED)

    def test_owner_cannot_approve_leave_that_exceeds_balance(self):
        leave_type = self.create_leave_setup()
        leave_request = LeaveRequest.objects.create(
            employee=self.employee,
            leave_type=leave_type,
            start_date=date(2026, 9, 1),
            end_date=date(2026, 9, 30),
            requested_days=Decimal('22.00'),
            submitted_by=self.staff_user,
        )
        self.client.force_authenticate(self.owner)

        response = self.client.post(f'/api/hr/leave-requests/{leave_request.id}/approve/', {}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        leave_request.refresh_from_db()
        self.assertEqual(leave_request.status, LeaveRequest.Status.PENDING)

    def test_linked_employee_can_request_overtime_and_owner_can_approve_it(self):
        self.client.force_authenticate(self.staff_user)
        request_response = self.client.post('/api/hr/overtime-requests/', {
            'branch': self.branch.id,
            'work_date': '2026-09-07',
            'requested_minutes': 90,
            'reason': 'Month-end closing',
        }, format='json')
        self.assertEqual(request_response.status_code, status.HTTP_201_CREATED)

        self.client.force_authenticate(self.owner)
        approve_response = self.client.post(
            f"/api/hr/overtime-requests/{request_response.data['id']}/approve/",
            {'approved_minutes': 60},
            format='json',
        )
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)
        self.assertEqual(approve_response.data['status'], OvertimeRequest.Status.APPROVED)
        self.assertEqual(approve_response.data['approved_minutes'], 60)
