from django import forms
from django.contrib import admin, messages
from django.db.models import F
from django.utils.html import format_html, mark_safe
from django.utils import timezone
from django.urls import path, reverse
from django.shortcuts import redirect
from .models import (
    Subscription, Invoice, FeaturePricing, SubscriptionFeature, 
    UsageCharge, Deposit, DepositStatus, Refund
)


def _format_money(subscription, amount, suffix=''):
    currency = subscription.get_currency_code()
    return f"{currency} {amount}{suffix}"


class TrialStateFilter(admin.SimpleListFilter):
    title = 'trial state'
    parameter_name = 'trial_state'

    def lookups(self, request, model_admin):
        return (
            ('active', 'Active Trial'),
            ('expired', 'Expired Trial'),
            ('none', 'No Trial'),
        )

    def queryset(self, request, queryset):
        now = timezone.now()
        value = self.value()
        if value == 'active':
            return queryset.filter(
                free_trial_credits_applied=True,
                free_trial_end_date__isnull=False,
                free_trial_end_date__gt=now,
            )
        if value == 'expired':
            return queryset.filter(
                free_trial_credits_applied=True,
                free_trial_end_date__isnull=False,
                free_trial_end_date__lte=now,
            )
        if value == 'none':
            return queryset.filter(free_trial_credits_applied=False)
        return queryset


class BalanceStateFilter(admin.SimpleListFilter):
    title = 'balance state'
    parameter_name = 'balance_state'

    def lookups(self, request, model_admin):
        return (
            ('critical', 'Low Balance'),
            ('healthy', 'Healthy Balance'),
            ('zero', 'Zero Balance'),
        )

    def queryset(self, request, queryset):
        value = self.value()
        if value == 'critical':
            return queryset.filter(account_balance__lt=F('low_balance_threshold'))
        if value == 'healthy':
            return queryset.filter(account_balance__gte=F('low_balance_threshold'))
        if value == 'zero':
            return queryset.filter(account_balance__lte=0)
        return queryset


class SubscriptionFeatureInline(admin.TabularInline):
    model = SubscriptionFeature
    extra = 0
    fields = ('feature', 'enabled', 'enabled_date')
    readonly_fields = ('enabled_date',)
    autocomplete_fields = ('feature',)


class DepositAdminForm(forms.ModelForm):
    apply_immediately = forms.BooleanField(
        required=False,
        initial=True,
        label='Save and apply credits now',
        help_text=(
            'Use this for support/admin credit top-ups. It creates the deposit audit record, '
            'marks it completed, and adds the credited amount to the subscription balance.'
        ),
    )

    class Meta:
        model = Deposit
        fields = '__all__'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['subscription'].label = 'Business subscription'
        self.fields['subscription'].help_text = 'Choose the business account that should receive the credits.'
        self.fields['amount'].help_text = 'Amount paid or approved for this manual credit.'
        self.fields['credited_amount'].help_text = (
            'Optional. Leave blank to credit the same amount, or enter the full credit value for bundles/bonuses.'
        )
        self.fields['transaction_id'].help_text = (
            'Optional support reference. If left blank for an immediate admin credit, one is generated.'
        )
        self.fields['payment_proof'].help_text = 'Optional support note, receipt reference, or reason.'
        if not self.instance.pk:
            self.initial.setdefault('payment_method', 'manual')

    def clean_amount(self):
        amount = self.cleaned_data.get('amount')
        if amount is not None and amount <= 0:
            raise forms.ValidationError('Amount must be greater than zero.')
        return amount

    def clean_credited_amount(self):
        credited_amount = self.cleaned_data.get('credited_amount')
        if credited_amount is not None and credited_amount <= 0:
            raise forms.ValidationError('Credited amount must be greater than zero when provided.')
        return credited_amount

@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = (
        'id',
        'business',
        'owner_email',
        'status_badge',
        'trial_status_badge',
        'account_balance_display',
        'daily_charge_display',
        'coverage_days_display',
        'low_balance_badge',
        'created_at',
    )
    search_fields = ('business__name', 'business__owner__email', 'business__owner__username')
    list_filter = ('status', TrialStateFilter, BalanceStateFilter, 'created_at', 'low_balance_notified')
    ordering = ('-created_at',)
    list_select_related = ('business', 'business__owner')
    autocomplete_fields = ('business',)
    date_hierarchy = 'created_at'
    readonly_fields = (
        'created_at',
        'updated_at',
        'start_date',
        'total_spent',
        'last_charge_date',
        'status_badge',
        'trial_status_badge',
        'account_balance_display',
        'daily_charge_display',
        'coverage_days_display',
        'enabled_features_summary',
        'low_balance_badge',
    )
    actions = [
        'apply_daily_charges',
        'check_low_balance',
        'check_trial_expiry',
        'pause_subscriptions',
        'resume_subscriptions',
        'reset_low_balance_notifications',
        'sync_feature_assignments',
        'force_expire_trial_credits',
    ]
    inlines = (SubscriptionFeatureInline,)
    
    fieldsets = (
        ('Operational Summary', {
            'fields': (
                'status_badge',
                'trial_status_badge',
                'account_balance_display',
                'daily_charge_display',
                'coverage_days_display',
                'enabled_features_summary',
                'low_balance_badge',
            )
        }),
        ('Business', {
            'fields': ('business', 'status')
        }),
        ('Pricing', {
            'fields': ('base_price_per_day',)
        }),
        ('Account', {
            'fields': ('account_balance', 'total_spent', 'last_payment_date', 'last_billing_date', 'last_charge_date')
        }),
        ('Low Balance Alerts', {
            'fields': ('low_balance_threshold', 'low_balance_notified', 'low_balance_notified_date')
        }),
        ('Free Trial', {
            'fields': ('free_trial_days', 'free_trial_credits_applied', 'free_trial_credits_amount', 'free_trial_end_date')
        }),
        ('Payment', {
            'fields': ('stripe_customer_id',)
        }),
        ('Usage Limits', {
            'fields': ('enable_usage_limits',)
        }),
        ('Features', {
            'fields': (
                'enable_pos', 'enable_inventory', 'enable_invoicing', 'enable_online_menu',
                'enable_online_ordering', 'enable_kitchen', 'enable_expense_management',
                'enable_supplier_management', 'enable_purchases', 'enable_low_stock_alerts',
                'enable_expiry_alerts', 'enable_customer_management', 'enable_reports', 'enable_analytics',
                'enable_take_orders', 'enable_staff_management', 'enable_waste_management',
                'enable_stock_transfers', 'enable_stock_audits', 'enable_tax_management', 'enable_multi_branch'
            )
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related(
            'business',
            'business__owner',
        ).prefetch_related('enabled_features__feature')

    def owner_email(self, obj):
        return getattr(obj.business.owner, 'email', '-') or '-'
    owner_email.short_description = 'Owner'
    
    def status_badge(self, obj):
        colors = {
            'active': '#00cc00',
            'paused': '#FFA500',
            'cancelled': '#cc0000',
        }
        color = colors.get(obj.status, '#999999')
        return format_html(
            '<span style="background-color: {color}; color: white; padding: 3px 10px; border-radius: 3px;">{status}</span>',
            color=color,
            status=obj.get_status_display()
        )
    status_badge.short_description = 'Status'

    def trial_status_badge(self, obj):
        if not obj.free_trial_credits_applied:
            return format_html(
                '<span style="background-color: #6b7280; color: white; padding: 3px 10px; border-radius: 3px;">{}</span>',
                'No Trial',
            )

        if obj.is_free_trial_active():
            return format_html(
                '<span style="background-color: #2563eb; color: white; padding: 3px 10px; border-radius: 3px;">Active ({} days left)</span>',
                obj.get_free_trial_days_remaining(),
            )

        return format_html(
            '<span style="background-color: #b45309; color: white; padding: 3px 10px; border-radius: 3px;">{}</span>',
            'Expired',
        )
    trial_status_badge.short_description = 'Trial'
    
    def account_balance_display(self, obj):
        return _format_money(obj, obj.account_balance)
    account_balance_display.short_description = 'Balance'
    
    def daily_charge_display(self, obj):
        daily = obj.calculate_daily_charges()
        return _format_money(obj, daily, '/day')
    daily_charge_display.short_description = 'Daily Charge'

    def coverage_days_display(self, obj):
        daily_charge = obj.calculate_daily_charges()
        if daily_charge <= 0:
            return '∞'

        days = int(obj.account_balance / daily_charge)
        if days <= 3:
            color = '#cc0000'
        elif days <= 7:
            color = '#b45309'
        else:
            color = '#166534'
        return format_html('<span style="color: {}; font-weight: 600;">{} day(s)</span>', color, days)
    coverage_days_display.short_description = 'Coverage'

    def enabled_features_summary(self, obj):
        enabled = [sf.feature.get_feature_display() for sf in obj.enabled_features.all() if sf.enabled]
        if not enabled:
            enabled = [
                feature_name.replace('_', ' ').title()
                for feature_name, flag_field in obj.FEATURE_FLAG_FIELDS.items()
                if getattr(obj, flag_field, False)
            ]

        if not enabled:
            return '-'

        preview = enabled[:8]
        suffix = ''
        if len(enabled) > 8:
            suffix = f' +{len(enabled) - 8} more'
        return ', '.join(preview) + suffix
    enabled_features_summary.short_description = 'Enabled Features'
    
    def low_balance_badge(self, obj):
        if obj.account_balance < obj.low_balance_threshold:
            return mark_safe('<span style="background-color: #FFA500; color: white; padding: 3px 10px; border-radius: 3px;">LOW</span>')
        return '-'
    low_balance_badge.short_description = 'Balance Status'
    
    def apply_daily_charges(self, request, queryset):
        charged = 0
        paused = 0
        for sub in queryset.filter(status='active'):
            success, message = sub.apply_daily_charges()
            if success:
                charged += 1
            elif 'paused' in message.lower():
                paused += 1
        self.message_user(request, f'✓ {charged} charged, {paused} paused')
    apply_daily_charges.short_description = 'Apply daily charges'
    
    def check_low_balance(self, request, queryset):
        notified = 0
        for sub in queryset:
            success, message = sub.check_low_balance()
            if success:
                notified += 1
        self.message_user(request, f'✓ {notified} low balance notifications sent')
    check_low_balance.short_description = 'Check low balance'
    
    def check_trial_expiry(self, request, queryset):
        expired = 0
        for sub in queryset:
            success, message = sub.check_trial_expiry()
            if success:
                expired += 1
        self.message_user(request, f'✓ {expired} trial expiry checks completed')
    check_trial_expiry.short_description = 'Check trial expiry'
    
    def pause_subscriptions(self, request, queryset):
        count = queryset.filter(status='active').update(status='paused')
        self.message_user(request, f'✓ {count} subscriptions paused')
    pause_subscriptions.short_description = 'Pause selected subscriptions'
    
    def resume_subscriptions(self, request, queryset):
        resumed = 0
        insufficient_balance = 0
        for subscription in queryset.filter(status='paused'):
            if subscription.maybe_auto_resume():
                subscription.save(update_fields=['status', 'last_charge_date', 'updated_at'])
                resumed += 1
            else:
                insufficient_balance += 1

        message = f'✓ {resumed} subscriptions resumed'
        if insufficient_balance:
            message += f'; {insufficient_balance} need enough credit for one daily charge'
        self.message_user(request, message)
    resume_subscriptions.short_description = 'Resume selected subscriptions'

    def save_model(self, request, obj, form, change):
        previous_status = None
        if change and obj.pk:
            previous_status = Subscription.objects.filter(pk=obj.pk).values_list('status', flat=True).first()

        if previous_status == 'paused' and obj.status == 'active':
            obj.status = previous_status
            if obj.maybe_auto_resume():
                self.message_user(
                    request,
                    'Subscription resumed. Billing restarts from today.',
                    level=messages.SUCCESS,
                )
            else:
                self.message_user(
                    request,
                    'Subscription remains paused because its balance does not cover one daily charge.',
                    level=messages.WARNING,
                )

        super().save_model(request, obj, form, change)

    def reset_low_balance_notifications(self, request, queryset):
        count = queryset.update(low_balance_notified=False, low_balance_notified_date=None)
        self.message_user(request, f'✓ Reset low balance notifications for {count} subscription(s)')
    reset_low_balance_notifications.short_description = 'Reset low balance notifications'

    def sync_feature_assignments(self, request, queryset):
        synced = 0
        errors = []
        for subscription in queryset:
            try:
                subscription.sync_feature_assignments_from_flags()
                synced += 1
            except Exception as exc:
                errors.append(f"{subscription.business.name}: {exc}")

        self.message_user(request, f'✓ Synced feature assignments for {synced} subscription(s)')
        if errors:
            self.message_user(
                request,
                f'⚠ Sync errors: {"; ".join(errors)}',
                level=messages.WARNING,
            )
    sync_feature_assignments.short_description = 'Sync feature rows from enable_* flags'

    def force_expire_trial_credits(self, request, queryset):
        expired = 0
        for subscription in queryset.filter(free_trial_credits_applied=True):
            if subscription.expire_free_trial():
                expired += 1
        self.message_user(request, f'✓ Force-expired trial credits for {expired} subscription(s)')
    force_expire_trial_credits.short_description = 'Force expire free trial credits now'

@admin.register(Invoice)
class InvoiceAdmin(admin.ModelAdmin):
    list_display = ('invoice_number', 'subscription', 'amount_display', 'status_badge', 'issue_date')
    search_fields = ('invoice_number', 'subscription__business__name', 'subscription__business__owner__email')
    list_filter = ('status', 'issue_date')
    ordering = ('-issue_date',)
    list_select_related = ('subscription', 'subscription__business')
    autocomplete_fields = ('subscription',)
    readonly_fields = (
        'created_at',
        'updated_at',
        'invoice_number',
        'subscription',
        'amount',
        'status',
        'billing_period_start',
        'billing_period_end',
        'issue_date',
        'due_date',
        'paid_date',
        'stripe_invoice_id',
    )
    actions = None
    
    fieldsets = (
        ('Invoice Details', {
            'fields': ('invoice_number', 'subscription', 'amount', 'status')
        }),
        ('Billing Period', {
            'fields': ('billing_period_start', 'billing_period_end', 'issue_date', 'due_date')
        }),
        ('Payment', {
            'fields': ('paid_date', 'stripe_invoice_id')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    
    def amount_display(self, obj):
        return _format_money(obj.subscription, obj.amount)
    amount_display.short_description = 'Amount'
    
    def status_badge(self, obj):
        colors = {
            'draft': '#999999',
            'sent': '#0066cc',
            'paid': '#00cc00',
            'failed': '#cc0000',
        }
        color = colors.get(obj.status, '#999999')
        return format_html(
            '<span style="background-color: {color}; color: white; padding: 3px 10px; border-radius: 3px;">{status}</span>',
            color=color,
            status=obj.get_status_display()
        )
    status_badge.short_description = 'Status'
    
    def has_add_permission(self, request):
        return False

@admin.register(FeaturePricing)
class FeaturePricingAdmin(admin.ModelAdmin):
    list_display = ('feature', 'price_per_day', 'is_active', 'created_at')
    search_fields = ('feature',)
    list_filter = ('is_active', 'created_at')
    ordering = ['feature']
    readonly_fields = ('created_at', 'updated_at')

@admin.register(SubscriptionFeature)
class SubscriptionFeatureAdmin(admin.ModelAdmin):
    list_display = ('subscription', 'feature', 'enabled', 'enabled_date')
    search_fields = ('subscription__business__name', 'feature__feature')
    list_filter = ('enabled', 'feature', 'enabled_date')
    ordering = ['-enabled_date']
    readonly_fields = ('enabled_date',)
    list_select_related = ('subscription', 'subscription__business', 'feature')
    autocomplete_fields = ('subscription', 'feature')

@admin.register(UsageCharge)
class UsageChargeAdmin(admin.ModelAdmin):
    list_display = ('subscription', 'charge_type', 'amount', 'description', 'created_at')
    search_fields = ('subscription__business__name', 'description')
    list_filter = ('charge_type', 'created_at')
    ordering = ['-created_at']
    readonly_fields = ('created_at',)
    list_select_related = ('subscription', 'subscription__business')
    autocomplete_fields = ('subscription',)

@admin.register(Deposit)
class DepositAdmin(admin.ModelAdmin):
    form = DepositAdminForm
    list_display = (
        'deposit_id',
        'business_name',
        'owner_email',
        'amount_display',
        'credited_amount_display',
        'status_badge',
        'payment_method',
        'requested_date',
        'actions_display',
    )
    search_fields = ('subscription__business__name', 'subscription__business__owner__email', 'transaction_id', 'deposit_id')
    list_filter = ('status', 'payment_method', 'requested_date')
    ordering = ['-requested_date']
    list_select_related = ('subscription', 'subscription__business', 'subscription__business__owner')
    autocomplete_fields = ('subscription',)
    readonly_fields = ('created_at', 'updated_at', 'requested_date', 'completed_date', 'deposit_id', 'status_badge')
    actions = ['complete_deposits', 'cancel_deposits']

    add_fieldsets = (
        ('Add Subscription Credits', {
            'fields': ('subscription', 'amount', 'credited_amount', 'funding_period', 'apply_immediately')
        }),
        ('Support Reference', {
            'fields': ('payment_method', 'transaction_id', 'payment_proof', 'notes')
        }),
    )
    
    fieldsets = (
        ('Deposit Details', {
            'fields': ('deposit_id', 'subscription', 'amount', 'credited_amount', 'funding_period', 'status_badge')
        }),
        ('Payment Information', {
            'fields': ('payment_method', 'transaction_id', 'stripe_payment_intent_id', 'payment_proof')
        }),
        ('Dates', {
            'fields': ('requested_date', 'completed_date')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return self.add_fieldsets
        return super().get_fieldsets(request, obj)

    def get_changeform_initial_data(self, request):
        initial = super().get_changeform_initial_data(request)
        initial.setdefault('payment_method', 'manual')
        return initial

    def save_model(self, request, obj, form, change):
        if not change and not obj.payment_method:
            obj.payment_method = 'manual'
        if obj.transaction_id and not obj.payment_proof:
            obj.payment_proof = obj.transaction_id

        super().save_model(request, obj, form, change)

        should_apply = not change and form.cleaned_data.get('apply_immediately')
        if not should_apply:
            return

        if obj.status != DepositStatus.PENDING:
            self.message_user(
                request,
                f'Deposit {obj.deposit_id} was saved but not applied because it is already {obj.get_status_display().lower()}.',
                level=messages.WARNING,
            )
            return

        update_fields = []
        if not obj.transaction_id:
            obj.transaction_id = f'ADMIN-CREDIT-{obj.pk}'
            update_fields.append('transaction_id')
        if not obj.payment_proof:
            obj.payment_proof = f'Admin credit added by {request.user}'
            update_fields.append('payment_proof')
        if update_fields:
            update_fields.append('updated_at')
            obj.save(update_fields=update_fields)

        try:
            if obj.complete_deposit():
                credit_amount = obj.get_credit_amount()
                self.message_user(
                    request,
                    f'✓ Added {_format_money(obj.subscription, credit_amount)} credits to {obj.subscription.business.name}.',
                )
            else:
                self.message_user(
                    request,
                    f'Deposit {obj.deposit_id} was saved but credits were not applied.',
                    level=messages.WARNING,
                )
        except Exception as exc:
            self.message_user(
                request,
                f'Deposit {obj.deposit_id} was saved but failed to apply credits: {exc}',
                level=messages.ERROR,
            )
    
    def amount_display(self, obj):
        return _format_money(obj.subscription, obj.amount)
    amount_display.short_description = 'Amount'

    def credited_amount_display(self, obj):
        credit_amount = obj.get_credit_amount()
        if credit_amount == obj.amount:
            return _format_money(obj.subscription, credit_amount)
        return format_html(
            '{} <span style="color: #166534; font-weight: 600;">(+{} bonus)</span>',
            _format_money(obj.subscription, credit_amount),
            obj.get_bonus_credit_amount(),
        )
    credited_amount_display.short_description = 'Credits Added'

    def business_name(self, obj):
        return obj.subscription.business.name
    business_name.short_description = 'Business'
    business_name.admin_order_field = 'subscription__business__name'

    def owner_email(self, obj):
        return getattr(obj.subscription.business.owner, 'email', '-') or '-'
    owner_email.short_description = 'Owner'
    owner_email.admin_order_field = 'subscription__business__owner__email'

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path(
                '<int:deposit_id>/complete/',
                self.admin_site.admin_view(self.complete_single_deposit),
                name='subscription_deposit_complete',
            ),
            path(
                '<int:deposit_id>/cancel/',
                self.admin_site.admin_view(self.cancel_single_deposit),
                name='subscription_deposit_cancel',
            ),
        ]
        return custom_urls + urls

    def _deposit_changelist_url(self):
        return reverse('admin:subscription_deposit_changelist')
    
    def status_badge(self, obj):
        colors = {
            'pending': '#FFA500',
            'completed': '#00cc00',
            'failed': '#cc0000',
            'cancelled': '#999999',
        }
        color = colors.get(obj.status, '#999999')
        return format_html(
            '<span style="background-color: {color}; color: white; padding: 3px 10px; border-radius: 3px;">{status}</span>',
            color=color,
            status=obj.get_status_display()
        )
    status_badge.short_description = 'Status'
    
    def actions_display(self, obj):
        if obj.status == 'pending':
            complete_url = reverse('admin:subscription_deposit_complete', args=[obj.pk])
            cancel_url = reverse('admin:subscription_deposit_cancel', args=[obj.pk])
            return format_html(
                '<a class="button" href="{}">{}</a> <a class="button" href="{}">{}</a>',
                complete_url,
                'Complete',
                cancel_url,
                'Cancel',
            )
        return '-'
    actions_display.short_description = 'Actions'

    def complete_single_deposit(self, request, deposit_id):
        deposit = Deposit.objects.select_related('subscription', 'subscription__business').filter(pk=deposit_id).first()
        if not deposit:
            self.message_user(request, 'Deposit not found.', level=messages.ERROR)
            return redirect(self._deposit_changelist_url())

        if not self.has_change_permission(request, deposit):
            self.message_user(request, 'You do not have permission to complete this deposit.', level=messages.ERROR)
            return redirect(self._deposit_changelist_url())

        if deposit.status != DepositStatus.PENDING:
            self.message_user(
                request,
                f'Deposit {deposit.deposit_id} is already {deposit.get_status_display().lower()}.',
                level=messages.WARNING,
            )
            return redirect(self._deposit_changelist_url())

        try:
            if deposit.complete_deposit():
                self.message_user(request, f'✓ Deposit {deposit.deposit_id} completed successfully.')

                commission_success = getattr(deposit, '_affiliate_commission_success', None)
                commission_message = getattr(deposit, '_affiliate_commission_message', '')
                commission_amount = getattr(deposit, '_affiliate_commission_amount', 0)

                if commission_success is True:
                    self.message_user(
                        request,
                        f'✓ Affiliate commission added for deposit {deposit.deposit_id}: {commission_amount}'
                    )
                elif commission_success is False:
                    message_level = messages.ERROR if str(commission_message).lower().startswith('error') else messages.INFO
                    self.message_user(
                        request,
                        f'Affiliate commission result for {deposit.deposit_id}: {commission_message}',
                        level=message_level,
                    )
            else:
                self.message_user(request, f'Deposit {deposit.deposit_id} could not be completed.', level=messages.WARNING)
        except Exception as exc:
            self.message_user(request, f'Failed to complete deposit {deposit.deposit_id}: {exc}', level=messages.ERROR)

        return redirect(self._deposit_changelist_url())

    def cancel_single_deposit(self, request, deposit_id):
        deposit = Deposit.objects.select_related('subscription', 'subscription__business').filter(pk=deposit_id).first()
        if not deposit:
            self.message_user(request, 'Deposit not found.', level=messages.ERROR)
            return redirect(self._deposit_changelist_url())

        if not self.has_change_permission(request, deposit):
            self.message_user(request, 'You do not have permission to cancel this deposit.', level=messages.ERROR)
            return redirect(self._deposit_changelist_url())

        if deposit.status != DepositStatus.PENDING:
            self.message_user(
                request,
                f'Deposit {deposit.deposit_id} is already {deposit.get_status_display().lower()}.',
                level=messages.WARNING,
            )
            return redirect(self._deposit_changelist_url())

        try:
            if deposit.cancel_deposit():
                self.message_user(request, f'✓ Deposit {deposit.deposit_id} cancelled.')
            else:
                self.message_user(request, f'Deposit {deposit.deposit_id} could not be cancelled.', level=messages.WARNING)
        except Exception as exc:
            self.message_user(request, f'Failed to cancel deposit {deposit.deposit_id}: {exc}', level=messages.ERROR)

        return redirect(self._deposit_changelist_url())
    
    def complete_deposits(self, request, queryset):
        completed_count = 0
        commission_count = 0
        commission_skipped_count = 0
        commission_errors = []
        errors = []
        
        for deposit in queryset.filter(status=DepositStatus.PENDING):
            try:
                # Complete deposit (automatically processes affiliate commission)
                if deposit.complete_deposit():
                    completed_count += 1

                    commission_success = getattr(deposit, '_affiliate_commission_success', None)
                    commission_message = getattr(deposit, '_affiliate_commission_message', '')

                    if commission_success is True:
                        commission_count += 1
                    elif commission_success is False:
                        if str(commission_message).lower().startswith('error'):
                            commission_errors.append(f"{deposit.deposit_id}: {commission_message}")
                        else:
                            commission_skipped_count += 1
            except Exception as e:
                errors.append(f"{deposit.deposit_id}: {str(e)}")
        
        message = f'✓ {completed_count} deposits completed and credits added'
        if commission_count > 0:
            message += f', {commission_count} affiliate commissions created'
        if commission_skipped_count > 0:
            message += f', {commission_skipped_count} commission(s) skipped by rules'
        if commission_errors:
            message += f'\n⚠ Affiliate commission errors: {"; ".join(commission_errors)}'
        if errors:
            message += f'\n⚠ Errors: {"; ".join(errors)}'
        
        self.message_user(request, message)
    complete_deposits.short_description = 'Complete deposits & create affiliate commissions'
    
    def cancel_deposits(self, request, queryset):
        cancelled_count = 0
        for deposit in queryset.filter(status=DepositStatus.PENDING):
            if deposit.cancel_deposit():
                cancelled_count += 1
        self.message_user(request, f'{cancelled_count} deposits cancelled')
    cancel_deposits.short_description = 'Cancel selected deposits'


@admin.register(Refund)
class RefundAdmin(admin.ModelAdmin):
    list_display = ('refund_id', 'subscription', 'amount_display', 'status_badge', 'refund_method', 'requested_date', 'actions_display')
    search_fields = ('subscription__business__name', 'subscription__business__owner__email', 'refund_id', 'reason')
    list_filter = ('status', 'refund_method', 'requested_date')
    ordering = ['-requested_date']
    list_select_related = ('subscription', 'subscription__business', 'deposit')
    autocomplete_fields = ('subscription', 'deposit')
    readonly_fields = ('created_at', 'updated_at', 'requested_date', 'approved_date', 'processed_date', 'refund_id')
    actions = ['approve_refunds', 'process_refunds', 'reject_refunds']
    
    fieldsets = (
        ('Refund Details', {
            'fields': ('refund_id', 'subscription', 'deposit', 'amount', 'status')
        }),
        ('Reason', {
            'fields': ('reason',)
        }),
        ('Refund Method', {
            'fields': ('refund_method',)
        }),
        ('Request Information', {
            'fields': ('requested_by', 'requested_date')
        }),
        ('Approval Information', {
            'fields': ('approved_by', 'approved_date')
        }),
        ('Processing Information', {
            'fields': ('processed_date',)
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    
    def amount_display(self, obj):
        currency = obj.subscription.get_currency_code()
        return f"{currency} {obj.amount}"
    amount_display.short_description = 'Amount'
    
    def status_badge(self, obj):
        colors = {
            'pending': '#FFA500',
            'approved': '#0066cc',
            'processed': '#00cc00',
            'rejected': '#cc0000',
        }
        color = colors.get(obj.status, '#999999')
        return format_html(
            '<span style="background-color: {color}; color: white; padding: 3px 10px; border-radius: 3px;">{status}</span>',
            color=color,
            status=obj.get_status_display()
        )
    status_badge.short_description = 'Status'
    
    def actions_display(self, obj):
        if obj.status == 'pending':
            return format_html(
                '<a class="button">{}</a> <a class="button">{}</a>',
                'Approve',
                'Reject',
            )
        elif obj.status == 'approved':
            return format_html('<a class="button">{}</a>', 'Process')
        return '-'
    actions_display.short_description = 'Actions'
    
    def approve_refunds(self, request, queryset):
        approved = 0
        for refund in queryset.filter(status='pending'):
            if refund.approve_refund(request.user.username):
                approved += 1
        self.message_user(request, f'✓ {approved} refunds approved')
    approve_refunds.short_description = 'Approve selected refunds'
    
    def process_refunds(self, request, queryset):
        processed = 0
        for refund in queryset.filter(status='approved'):
            if refund.process_refund():
                processed += 1
        self.message_user(request, f'✓ {processed} refunds processed')
    process_refunds.short_description = 'Process selected refunds'
    
    def reject_refunds(self, request, queryset):
        rejected = 0
        for refund in queryset.filter(status='pending'):
            if refund.reject_refund(request.user.username):
                rejected += 1
        self.message_user(request, f'✓ {rejected} refunds rejected')
    reject_refunds.short_description = 'Reject selected refunds'
