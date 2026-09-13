import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from business.models import Branch, Business, Customer


class Appointment(models.Model):
    """A scheduled salon service which can later be checked in as a take order."""

    STATUS_BOOKED = 'booked'
    STATUS_CHECKED_IN = 'checked_in'
    STATUS_IN_SERVICE = 'in_service'
    STATUS_READY_FOR_PAYMENT = 'ready_for_payment'
    STATUS_COMPLETED = 'completed'
    STATUS_CANCELLED = 'cancelled'
    STATUS_NO_SHOW = 'no_show'

    STATUS_CHOICES = [
        (STATUS_BOOKED, 'Booked'),
        (STATUS_CHECKED_IN, 'Checked in'),
        (STATUS_IN_SERVICE, 'In service'),
        (STATUS_READY_FOR_PAYMENT, 'Ready for payment'),
        (STATUS_COMPLETED, 'Completed'),
        (STATUS_CANCELLED, 'Cancelled'),
        (STATUS_NO_SHOW, 'No show'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='appointments')
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='appointments')
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name='appointments')
    take_order = models.OneToOneField(
        'take_orders.TakeOrder',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointment',
        help_text='The normal service order created when this appointment is checked in.',
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointments_created',
    )
    checked_in_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointments_checked_in',
    )
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointments_cancelled',
    )
    no_show_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointments_marked_no_show',
    )
    scheduled_start = models.DateTimeField()
    scheduled_end = models.DateTimeField()
    status = models.CharField(max_length=32, choices=STATUS_CHOICES, default=STATUS_BOOKED)
    services = models.JSONField(
        default=list,
        help_text='Immutable snapshot of services, quantities, prices, and consumable recipes.',
    )
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    notes = models.TextField(blank=True)
    checked_in_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    cancellation_reason = models.TextField(blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    no_show_reason = models.TextField(blank=True)
    no_show_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['scheduled_start', 'created_at']
        indexes = [
            models.Index(fields=['business', 'branch', 'scheduled_start']),
            models.Index(fields=['branch', 'status', 'scheduled_start']),
            models.Index(fields=['customer', 'scheduled_start']),
            models.Index(fields=['take_order']),
        ]

    def clean(self):
        if self.branch_id and self.business_id and self.branch.business_id != self.business_id:
            raise ValidationError({'branch': 'The selected branch does not belong to this business.'})
        if self.customer_id and self.business_id and self.customer.business_id != self.business_id:
            raise ValidationError({'customer': 'The selected customer does not belong to this business.'})
        if self.customer_id and self.branch_id and self.customer.branch_id and self.customer.branch_id != self.branch_id:
            raise ValidationError({'customer': 'The selected customer belongs to another branch.'})
        if self.scheduled_end and self.scheduled_start and self.scheduled_end <= self.scheduled_start:
            raise ValidationError({'scheduled_end': 'The end time must be after the start time.'})

    def __str__(self):
        return f'{self.customer.name} - {self.scheduled_start:%Y-%m-%d %H:%M}'


class AppointmentDeposit(models.Model):
    """A customer payment recorded for a salon appointment before checkout."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    appointment = models.ForeignKey(
        Appointment,
        on_delete=models.CASCADE,
        related_name='deposits',
    )
    payment_transaction = models.OneToOneField(
        'business.CustomerAccountTransaction',
        on_delete=models.PROTECT,
        related_name='appointment_deposit',
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    payment_method = models.CharField(max_length=50, blank=True)
    reference = models.CharField(max_length=120, blank=True)
    notes = models.TextField(blank=True)
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='appointment_deposits_recorded',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['appointment', 'created_at']),
        ]

    def clean(self):
        if self.amount is not None and self.amount <= 0:
            raise ValidationError({'amount': 'Deposit amount must be greater than zero.'})

    def __str__(self):
        return f'{self.appointment.customer.name} deposit {self.amount}'
