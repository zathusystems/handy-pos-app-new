from django.contrib import admin

from .models import Appointment, AppointmentDeposit


@admin.register(Appointment)
class AppointmentAdmin(admin.ModelAdmin):
    list_display = (
        'customer', 'business', 'branch', 'scheduled_start', 'scheduled_end',
        'status', 'total', 'take_order',
    )
    list_filter = ('status', 'business', 'branch')
    search_fields = ('customer__name', 'customer__phone', 'notes')
    readonly_fields = (
        'id', 'services', 'total', 'take_order', 'created_by', 'checked_in_by',
        'checked_in_at', 'completed_at', 'cancelled_by', 'cancelled_at', 'cancellation_reason',
        'no_show_by', 'no_show_at', 'no_show_reason', 'created_at', 'updated_at',
    )
    ordering = ('-scheduled_start',)


@admin.register(AppointmentDeposit)
class AppointmentDepositAdmin(admin.ModelAdmin):
    list_display = ('appointment', 'amount', 'payment_method', 'reference', 'recorded_by', 'created_at')
    list_filter = ('payment_method', 'appointment__business', 'appointment__branch')
    search_fields = ('appointment__customer__name', 'reference', 'payment_transaction__reference')
    readonly_fields = ('id', 'appointment', 'payment_transaction', 'amount', 'payment_method', 'reference', 'notes', 'recorded_by', 'created_at', 'updated_at')
    ordering = ('-created_at',)
