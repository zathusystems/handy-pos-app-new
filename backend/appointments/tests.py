import uuid
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from business.models import (
    Branch,
    Business,
    Customer,
    CustomerAccountPaymentAllocation,
    CustomerAccountTransaction,
    Invoice,
)
from digitalmenu.models import Menu, MenuOption, MenuOptionGroup
from inventory.models import InventoryItem
from pos_sessions.models import Order, Session
from pos_sessions.sync_views import _build_order_sync_payload, handle_update_session
from staff.models import Staff, StaffRole
from take_orders.models import TakeOrder

from .models import Appointment, AppointmentDeposit
from .services import settle_appointment_order


User = get_user_model()


class AppointmentAPITests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email='salon-owner@example.com', password='test-pass')
        self.business = Business.objects.create(
            owner=self.owner,
            name='Salon Schedule Test',
            business_type='beauty_salon',
        )
        self.branch = Branch.objects.create(
            business=self.business,
            name='Main Branch',
            address='Main Road',
            city='Lilongwe',
            country='Malawi',
        )
        self.customer = Customer.objects.create(
            business=self.business,
            branch=self.branch,
            name='Thandiwe Banda',
            phone='0999000000',
        )
        self.service = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Wash and blow dry',
            category='Hair Care',
            item_type='sellable',
            is_service=True,
            stock_units=Decimal('0.000'),
            reorder_level=Decimal('0.000'),
            cost=Decimal('0.00'),
            price=Decimal('15000.00'),
            value=Decimal('0.00'),
            recipe=[],
        )
        self.retail_item = InventoryItem.objects.create(
            business=self.business,
            branch=self.branch,
            name='Hair Oil',
            category='Retail Products',
            item_type='sellable',
            stock_units=Decimal('10.000'),
            reorder_level=Decimal('1.000'),
            cost=Decimal('2000.00'),
            price=Decimal('5000.00'),
            value=Decimal('20000.00'),
        )
        self.service_menu = Menu.objects.create(
            business=self.business,
            branch=self.branch,
            inventory_item=self.service,
            is_visible=True,
        )
        self.service_options = MenuOptionGroup.objects.create(
            menu=self.service_menu,
            name='Treatment level',
            group_type='option',
            is_required=True,
            min_select=1,
            max_select=1,
        )
        self.deep_conditioning = MenuOption.objects.create(
            group=self.service_options,
            name='Deep conditioning',
            price_delta=Decimal('2500.00'),
            linked_inventory_item=self.retail_item,
            linked_inventory_quantity=Decimal('0.250'),
        )
        self.client.force_authenticate(self.owner)

    def payload(self, **overrides):
        start = timezone.now() + timedelta(days=1)
        payload = {
            'business_id': str(self.business.id),
            'branch': self.branch.id,
            'customer': self.customer.id,
            'scheduled_start': start.isoformat(),
            'scheduled_end': (start + timedelta(hours=1)).isoformat(),
            'services': [{'inventory_item_id': str(self.service.id), 'quantity': '1.000'}],
            'notes': 'Please use the usual conditioner.',
        }
        payload.update(overrides)
        return payload

    def create_active_session(self, user=None):
        return Session.objects.create(
            business=self.business,
            branch=self.branch,
            user=user or self.owner,
            status='active',
            opening_float=Decimal('0.00'),
            expected_cash=Decimal('0.00'),
            started_at=timezone.now(),
        )

    def test_create_appointment_snapshots_service_price(self):
        response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        appointment = Appointment.objects.get(pk=response.data['id'])
        self.assertEqual(appointment.status, Appointment.STATUS_BOOKED)
        self.assertEqual(appointment.total, Decimal('15000.00'))
        self.assertEqual(appointment.services[0]['inventory_item_id'], str(self.service.id))
        self.assertEqual(appointment.services[0]['price'], '15000.00')

    def test_cannot_book_non_service_as_an_appointment_service(self):
        response = self.client.post(
            '/api/appointments/appointments/',
            self.payload(services=[{'inventory_item_id': str(self.retail_item.id), 'quantity': '1.000'}]),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('services', response.data)

    def test_menu_service_snapshots_selected_choices_and_carries_them_to_service_order(self):
        response = self.client.post(
            '/api/appointments/appointments/',
            self.payload(services=[{
                'menu_item_id': str(self.service_menu.id),
                'quantity': '1.000',
                'selected_option_ids': {
                    str(self.service_options.id): [str(self.deep_conditioning.id)],
                },
            }]),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        appointment = Appointment.objects.get(pk=response.data['id'])
        snapshot = appointment.services[0]
        self.assertEqual(snapshot['menu_item_id'], str(self.service_menu.id))
        self.assertEqual(snapshot['price'], '17500.00')
        self.assertEqual(snapshot['total'], '17500.00')
        self.assertEqual(snapshot['selected_options'][0]['name'], 'Deep conditioning')
        self.assertEqual(snapshot['selected_options'][0]['linked_inventory_item'], str(self.retail_item.id))

        self.create_active_session()
        check_in_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )

        self.assertEqual(check_in_response.status_code, status.HTTP_200_OK, check_in_response.data)
        appointment.refresh_from_db()
        order_item = appointment.take_order.items.get()
        self.assertEqual(order_item.menu_item_id, str(self.service_menu.id))
        self.assertEqual(order_item.price, Decimal('17500.00'))
        self.assertEqual(order_item.selected_options[0]['name'], 'Deep conditioning')

    def test_menu_service_enforces_required_menu_choices(self):
        response = self.client.post(
            '/api/appointments/appointments/',
            self.payload(services=[{
                'menu_item_id': str(self.service_menu.id),
                'quantity': '1.000',
            }]),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('services', response.data)

    def test_check_in_requires_an_active_session(self):
        appointment = Appointment.objects.create(
            business=self.business,
            branch=self.branch,
            customer=self.customer,
            scheduled_start=timezone.now(),
            scheduled_end=timezone.now() + timedelta(hours=1),
            services=[{
                'inventory_item_id': str(self.service.id),
                'name': self.service.name,
                'quantity': '1.000',
                'price': '15000.00',
                'total': '15000.00',
                'recipe': [],
            }],
            total=Decimal('15000.00'),
        )

        response = self.client.post(f'/api/appointments/appointments/{appointment.id}/check-in/', format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Start an active session', str(response.data))

    def test_check_in_creates_normal_service_order_and_tracks_lifecycle(self):
        response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=response.data['id'])
        self.create_active_session()

        check_in_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )

        self.assertEqual(check_in_response.status_code, status.HTTP_200_OK, check_in_response.data)
        appointment.refresh_from_db()
        order = appointment.take_order
        self.assertIsNotNone(order)
        self.assertEqual(appointment.status, Appointment.STATUS_CHECKED_IN)
        self.assertEqual(order.status, 'Sent to Kitchen')
        self.assertEqual(order.customer, self.customer)
        self.assertEqual(order.created_by, self.owner)
        self.assertEqual(order.items.count(), 1)
        self.assertEqual(order.items.first().inventory_item_id, str(self.service.id))

        order_response = self.client.get(f'/api/orders/take-orders/{order.id}/')
        self.assertEqual(order_response.status_code, status.HTTP_200_OK, order_response.data)
        self.assertEqual(
            order_response.data['appointment_settlement']['appointment_id'],
            str(appointment.id),
        )
        self.assertEqual(
            order_response.data['appointment_settlement']['take_order_id'],
            str(order.id),
        )

        status_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Preparing'},
            format='json',
        )
        self.assertEqual(status_response.status_code, status.HTTP_200_OK, status_response.data)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.STATUS_IN_SERVICE)

        complete_response = self.client.patch(
            f'/api/orders/take-orders/{order.id}/update_status/',
            {'status': 'Completed'},
            format='json',
        )
        self.assertEqual(complete_response.status_code, status.HTTP_200_OK, complete_response.data)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.STATUS_COMPLETED)
        self.assertIsNotNone(appointment.completed_at)

    def test_cashier_can_check_in_appointment_but_waiter_cannot(self):
        create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=create_response.data['id'])
        cashier = User.objects.create_user(email='check-in-cashier@example.com', password='test-pass')
        waiter = User.objects.create_user(email='check-in-waiter@example.com', password='test-pass')
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=cashier,
            name='Check In Cashier',
            email='check-in-cashier@example.com',
            role=StaffRole.CASHIER,
        )
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=waiter,
            name='Check In Waiter',
            email='check-in-waiter@example.com',
            role=StaffRole.WAITER,
        )
        self.create_active_session(waiter)
        self.client.force_authenticate(waiter)

        denied_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )

        self.assertEqual(denied_response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('cashier, manager, or admin', str(denied_response.data))

        self.create_active_session(cashier)
        self.client.force_authenticate(cashier)
        approved_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )

        self.assertEqual(approved_response.status_code, status.HTTP_200_OK, approved_response.data)
        appointment.refresh_from_db()
        self.assertEqual(appointment.checked_in_by, cashier)
        self.assertEqual(appointment.take_order.session.user, cashier)

    def test_cashier_can_record_appointment_deposit_in_active_session(self):
        create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=create_response.data['id'])
        cashier = User.objects.create_user(email='deposit-cashier@example.com', password='test-pass')
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=cashier,
            name='Deposit Cashier',
            email='deposit-cashier@example.com',
            role=StaffRole.CASHIER,
        )
        session = self.create_active_session(cashier)
        self.client.force_authenticate(cashier)

        response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/record-deposit/',
            {
                'amount': '5000.00',
                'payment_method': 'Mobile Money',
                'reference': 'Airtel money',
                'notes': 'Deposit before the appointment.',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        deposit = AppointmentDeposit.objects.get(appointment=appointment)
        self.assertEqual(deposit.amount, Decimal('5000.00'))
        self.assertEqual(deposit.payment_method, 'Mobile Money')
        self.assertEqual(deposit.recorded_by, cashier)
        self.assertEqual(deposit.payment_transaction.session, session)
        self.assertEqual(deposit.payment_transaction.entry_type, 'payment')
        self.assertEqual(deposit.payment_transaction.direction, 'credit')
        self.assertEqual(Decimal(str(response.data['deposit_total'])), Decimal('5000.00'))
        self.assertEqual(Decimal(str(response.data['balance_due'])), Decimal('10000.00'))
        self.assertEqual(response.data['session_totals']['id'], str(session.id))
        self.assertEqual(Decimal(str(response.data['session_totals']['total_mobile_money_sales'])), Decimal('5000.00'))
        self.assertEqual(Decimal(str(response.data['session_totals']['total_sales'])), Decimal('0.00'))
        self.customer.refresh_from_db()
        self.assertEqual(self.customer.current_balance, Decimal('-5000.00'))
        self.assertTrue(CustomerAccountTransaction.objects.filter(
            customer=self.customer,
            session=session,
            entry_type='payment',
        ).exists())

    def test_appointment_deposit_settlement_records_only_the_remaining_payment(self):
        appointment_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=appointment_response.data['id'])
        deposit_session = self.create_active_session()
        checkout_cashier = User.objects.create_user(
            email='appointment-checkout@example.com',
            password='test-pass',
        )
        checkout_session = self.create_active_session(checkout_cashier)
        deposit_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/record-deposit/',
            {'amount': '5000.00', 'payment_method': 'Mobile Money'},
            format='json',
        )
        self.assertEqual(deposit_response.status_code, status.HTTP_201_CREATED, deposit_response.data)

        check_in_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )
        self.assertEqual(check_in_response.status_code, status.HTTP_200_OK, check_in_response.data)
        appointment.refresh_from_db()

        checkout_order = Order.objects.create(
            business=self.business,
            branch=self.branch,
            session=checkout_session,
            customer=self.customer,
            order_number=1,
            status='Completed',
            payment_method='Appointment Settlement',
            subtotal=Decimal('15000.00'),
            total=Decimal('15000.00'),
            appointment_settlement={
                'appointment_id': str(appointment.id),
                'take_order_id': str(appointment.take_order_id),
                'final_payment_method': 'Cash',
            },
        )

        settle_appointment_order(checkout_order, created_by=self.owner)
        settle_appointment_order(checkout_order, created_by=self.owner)

        checkout_order.refresh_from_db()
        invoice = Invoice.objects.get(id=checkout_order.invoice_id)
        self.customer.refresh_from_db()
        self.assertEqual(invoice.status, 'Paid')
        self.assertTrue(checkout_order.is_paid)
        self.assertEqual(self.customer.current_balance, Decimal('0.00'))
        allocations = CustomerAccountPaymentAllocation.objects.filter(invoice=invoice)
        self.assertEqual(sum((allocation.amount for allocation in allocations), Decimal('0.00')), Decimal('5000.00'))
        final_payments = CustomerAccountTransaction.objects.filter(
            customer=self.customer,
            order_id=str(checkout_order.id),
            invoice_id=str(invoice.id),
            entry_type='payment',
            direction='credit',
            payment_method='Cash',
        )
        self.assertEqual(final_payments.count(), 1)
        self.assertEqual(final_payments.first().amount, Decimal('10000.00'))
        self.assertEqual(len(checkout_order.payment_breakdown), 2)
        appointment.refresh_from_db()
        appointment.take_order.refresh_from_db()
        self.assertEqual(appointment.settled_order_id, checkout_order.id)
        self.assertEqual(appointment.status, Appointment.STATUS_COMPLETED)
        self.assertEqual(appointment.take_order.status, 'Completed')
        appointment_detail = self.client.get(f'/api/appointments/appointments/{appointment.id}/')
        self.assertEqual(appointment_detail.status_code, status.HTTP_200_OK, appointment_detail.data)
        self.assertEqual(appointment_detail.data['balance_due'], Decimal('0.00'))
        self.assertEqual(appointment_detail.data['settled_order_id'], str(checkout_order.id))
        deposit_session.refresh_from_db()
        self.assertEqual(deposit_session.total_sales, Decimal('0.00'))
        self.assertEqual(deposit_session.total_mobile_money_sales, Decimal('5000.00'))
        self.assertEqual(deposit_session.total_cash_sales, Decimal('0.00'))
        self.assertEqual(deposit_session.total_other_sales, Decimal('0.00'))
        self.assertEqual(deposit_session.expected_cash, Decimal('0.00'))
        checkout_session.refresh_from_db()
        self.assertEqual(checkout_session.total_sales, Decimal('15000.00'))
        self.assertEqual(checkout_session.total_cash_sales, Decimal('10000.00'))
        self.assertEqual(checkout_session.total_mobile_money_sales, Decimal('0.00'))
        self.assertEqual(checkout_session.expected_cash, Decimal('10000.00'))

        # A stale device must not overwrite the ledger-derived session totals.
        stale_session_result = handle_update_session(
            str(checkout_session.id),
            {
                'totalSales': 0,
                'totalCashSales': 0,
                'totalMobileMoneySales': 5000,
                'expectedCash': 0,
            },
            self.business,
            self.branch.id,
        )
        self.assertTrue(stale_session_result['success'])
        checkout_session.refresh_from_db()
        self.assertEqual(checkout_session.total_sales, Decimal('15000.00'))
        self.assertEqual(checkout_session.total_cash_sales, Decimal('10000.00'))

        # The next sync acknowledgement carries the authoritative customer and
        # session snapshot so the current device updates immediately.
        sync_payload = _build_order_sync_payload(checkout_order)
        self.assertEqual(sync_payload['customer_current_balance'], 0.0)
        self.assertEqual(sync_payload['session_totals']['id'], str(checkout_session.id))
        self.assertEqual(sync_payload['session_totals']['total_sales'], 15000.0)
        self.assertEqual(sync_payload['session_totals']['total_cash_sales'], 10000.0)

    def test_appointment_without_deposit_sync_checkout_keeps_customer_and_sale_linked(self):
        appointment_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=appointment_response.data['id'])
        checkout_session = self.create_active_session()

        check_in_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/check-in/',
            format='json',
        )
        self.assertEqual(check_in_response.status_code, status.HTTP_200_OK, check_in_response.data)
        appointment.refresh_from_db()
        appointment.take_order.status = 'Preparing'
        appointment.take_order.save(update_fields=['status', 'updated_at'])

        order_id = str(uuid.uuid4())
        now = timezone.now().isoformat()
        sync_response = self.client.post(
            '/sessions/sync/push/',
            {
                'last_synced_at': now,
                'branch_id': str(self.branch.id),
                'changes': [{
                    'id': order_id,
                    'entity_type': 'Order',
                    'op': 'create',
                    'timestamp': now,
                    'data': {
                        'id': order_id,
                        'orderNumber': 2,
                        'orderType': 'sale',
                        'status': 'Completed',
                        'paymentMethod': 'Appointment Settlement',
                        'subtotal': 15000.0,
                        'total': 15000.0,
                        'cogs': 0.0,
                        'createdAt': now,
                        'updatedAt': now,
                        'sessionId': str(checkout_session.id),
                        'appointmentSettlement': {
                            'appointmentId': str(appointment.id),
                            'takeOrderId': str(appointment.take_order_id),
                            'finalPaymentMethod': 'Card',
                            'depositTotal': 0,
                        },
                        'items': [{
                            'id': str(uuid.uuid4()),
                            'inventoryItemId': str(self.service.id),
                            'name': self.service.name,
                            'quantity': 1,
                            'price': 15000.0,
                            'notes': '',
                        }],
                    },
                }],
            },
            format='json',
        )
        self.assertEqual(sync_response.status_code, status.HTTP_200_OK, sync_response.data)
        self.assertEqual(sync_response.data['results']['errors'], [])
        order_ack = sync_response.data['results']['acknowledged'][0]
        self.assertEqual(order_ack['appointment_take_order']['id'], str(appointment.take_order_id))
        self.assertEqual(order_ack['appointment_take_order']['status'], 'Completed')

        checkout_order = Order.objects.get(pk=order_id)

        checkout_order.refresh_from_db()
        appointment.refresh_from_db()
        appointment.take_order.refresh_from_db()
        invoice = Invoice.objects.get(id=checkout_order.invoice_id)
        self.customer.refresh_from_db()

        self.assertTrue(checkout_order.is_paid)
        self.assertEqual(invoice.status, 'Paid')
        self.assertEqual(self.customer.current_balance, Decimal('0.00'))
        self.assertFalse(CustomerAccountPaymentAllocation.objects.filter(invoice=invoice).exists())
        final_payment = CustomerAccountTransaction.objects.get(
            customer=self.customer,
            order_id=str(checkout_order.id),
            invoice_id=str(invoice.id),
            entry_type='payment',
            direction='credit',
        )
        self.assertEqual(final_payment.amount, Decimal('15000.00'))
        self.assertEqual(final_payment.payment_method, 'Card')
        self.assertEqual(len(checkout_order.payment_breakdown), 1)
        self.assertEqual(checkout_order.payment_breakdown[0]['source'], 'checkout')
        self.assertEqual(appointment.settled_order_id, checkout_order.id)
        self.assertEqual(appointment.status, Appointment.STATUS_COMPLETED)
        self.assertEqual(appointment.take_order.status, 'Completed')
        appointment_detail = self.client.get(f'/api/appointments/appointments/{appointment.id}/')
        self.assertEqual(appointment_detail.status_code, status.HTTP_200_OK, appointment_detail.data)
        self.assertEqual(appointment_detail.data['balance_due'], Decimal('0.00'))
        checkout_session.refresh_from_db()
        self.assertEqual(checkout_session.total_sales, Decimal('15000.00'))
        self.assertEqual(checkout_session.total_card_sales, Decimal('15000.00'))
        self.assertEqual(checkout_session.total_cash_sales, Decimal('0.00'))

    def test_deposit_cannot_exceed_appointment_value(self):
        create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=create_response.data['id'])
        self.create_active_session()

        response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/record-deposit/',
            {'amount': '15000.01', 'payment_method': 'Cash'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('amount', response.data)
        self.assertFalse(AppointmentDeposit.objects.filter(appointment=appointment).exists())

    def test_only_owner_or_admin_can_cancel_or_mark_no_show(self):
        create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=create_response.data['id'])
        cashier = User.objects.create_user(email='salon-cashier@example.com', password='test-pass')
        Staff.objects.create(
            business=self.business,
            branch=self.branch,
            user=cashier,
            name='Salon Cashier',
            email='salon-cashier@example.com',
            role=StaffRole.CASHIER,
        )
        self.client.force_authenticate(cashier)

        denied_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/cancel/',
            {'reason': 'Client asked to cancel.'},
            format='json',
        )

        self.assertEqual(denied_response.status_code, status.HTTP_403_FORBIDDEN)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.STATUS_BOOKED)

        self.client.force_authenticate(self.owner)
        response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/cancel/',
            {'reason': 'Client asked to cancel.'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.STATUS_CANCELLED)
        self.assertEqual(appointment.cancellation_reason, 'Client asked to cancel.')
        self.assertEqual(appointment.cancelled_by, self.owner)
        self.assertIsNotNone(appointment.cancelled_at)

        no_show_create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        no_show_appointment = Appointment.objects.get(pk=no_show_create_response.data['id'])
        no_show_response = self.client.post(
            f'/api/appointments/appointments/{no_show_appointment.id}/mark-no-show/',
            {'reason': 'Client did not arrive.'},
            format='json',
        )
        self.assertEqual(no_show_response.status_code, status.HTTP_200_OK, no_show_response.data)
        no_show_appointment.refresh_from_db()
        self.assertEqual(no_show_appointment.status, Appointment.STATUS_NO_SHOW)
        self.assertEqual(no_show_appointment.no_show_reason, 'Client did not arrive.')
        self.assertEqual(no_show_appointment.no_show_by, self.owner)
        self.assertIsNotNone(no_show_appointment.no_show_at)

    def test_cancelled_service_order_updates_appointment_audit(self):
        create_response = self.client.post('/api/appointments/appointments/', self.payload(), format='json')
        appointment = Appointment.objects.get(pk=create_response.data['id'])
        self.create_active_session()
        check_in_response = self.client.post(f'/api/appointments/appointments/{appointment.id}/check-in/', format='json')
        self.assertEqual(check_in_response.status_code, status.HTTP_200_OK, check_in_response.data)
        appointment.refresh_from_db()

        cancel_response = self.client.patch(
            f'/api/orders/take-orders/{appointment.take_order_id}/update_status/',
            {'status': 'Cancelled', 'cancellation_reason': 'Client did not arrive.'},
            format='json',
        )

        self.assertEqual(cancel_response.status_code, status.HTTP_200_OK, cancel_response.data)
        appointment.refresh_from_db()
        appointment.take_order.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.STATUS_CANCELLED)
        self.assertEqual(appointment.cancellation_reason, 'Client did not arrive.')
        self.assertEqual(appointment.cancelled_by, self.owner)
        self.assertEqual(appointment.take_order.cancelled_by, self.owner)
        self.assertIsNotNone(appointment.cancelled_at)

    def test_summary_separates_service_value_from_deposits_and_open_balance(self):
        start = timezone.now().replace(second=0, microsecond=0)
        appointment = Appointment.objects.create(
            business=self.business,
            branch=self.branch,
            customer=self.customer,
            scheduled_start=start,
            scheduled_end=start + timedelta(hours=1),
            services=[{
                'inventory_item_id': str(self.service.id),
                'name': self.service.name,
                'quantity': '1.000',
                'price': '15000.00',
                'total': '15000.00',
                'recipe': [],
            }],
            total=Decimal('15000.00'),
        )
        self.create_active_session()
        deposit_response = self.client.post(
            f'/api/appointments/appointments/{appointment.id}/record-deposit/',
            {'amount': '4000.00', 'payment_method': 'Cash'},
            format='json',
        )
        self.assertEqual(deposit_response.status_code, status.HTTP_201_CREATED, deposit_response.data)

        response = self.client.get(
            f'/api/appointments/appointments/summary/?branch={self.branch.id}&from_date={start.date()}&to_date={start.date()}'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        totals = response.data['totals']
        self.assertEqual(totals['appointments'], 1)
        self.assertEqual(totals['booked'], 1)
        self.assertEqual(Decimal(str(totals['scheduled_value'])), Decimal('15000.00'))
        self.assertEqual(Decimal(str(totals['deposits_received'])), Decimal('4000.00'))
        self.assertEqual(Decimal(str(totals['outstanding_scheduled_value'])), Decimal('11000.00'))
        self.assertEqual(len(response.data['services']), 1)
        service = response.data['services'][0]
        self.assertEqual(service['name'], self.service.name)
        self.assertEqual(service['appointments'], 1)
        self.assertEqual(Decimal(str(service['quantity'])), Decimal('1.00'))
        self.assertEqual(Decimal(str(service['scheduled_value'])), Decimal('15000.00'))
        self.assertEqual(Decimal(str(service['completed_value'])), Decimal('0.00'))

    def test_summary_includes_selected_service_options(self):
        start = timezone.now().replace(second=0, microsecond=0)
        Appointment.objects.create(
            business=self.business,
            branch=self.branch,
            customer=self.customer,
            scheduled_start=start,
            scheduled_end=start + timedelta(hours=1),
            services=[{
                'inventory_item_id': str(self.service.id),
                'name': self.service.name,
                'quantity': '1.000',
                'price': '15000.00',
                'total': '15000.00',
                'recipe': [],
                'selected_options': [
                    {'name': 'Deep conditioning'},
                    {'name': 'Steam treatment'},
                ],
            }],
            total=Decimal('15000.00'),
        )

        response = self.client.get(
            f'/api/appointments/appointments/summary/?branch={self.branch.id}&from_date={start.date()}&to_date={start.date()}'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(len(response.data['services']), 1)
        self.assertEqual(
            response.data['services'][0]['name'],
            f'{self.service.name} - Deep conditioning, Steam treatment',
        )

    def test_appointments_are_not_visible_to_another_business(self):
        Appointment.objects.create(
            business=self.business,
            branch=self.branch,
            customer=self.customer,
            scheduled_start=timezone.now(),
            scheduled_end=timezone.now() + timedelta(hours=1),
            services=[],
            total=Decimal('0.00'),
        )
        outsider = User.objects.create_user(email='other-owner@example.com', password='test-pass')
        other_business = Business.objects.create(owner=outsider, name='Other Salon', business_type='beauty_salon')
        self.client.force_authenticate(outsider)

        response = self.client.get(f'/api/appointments/appointments/?business_id={other_business.id}')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data.get('results', response.data), [])
