import json
from decimal import Decimal

from django.contrib import admin, messages
from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.shortcuts import redirect
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html

from .models import (
    Affiliate,
    AffiliatePayment,
    AffiliateSettings,
    BusinessReferral,
    RecurringCommission,
)


def _format_money(amount: Decimal | float | int | None) -> str:
    value = amount or Decimal("0.00")
    return f"MWK {value:,.2f}"


def _badge(text: str, color: str) -> str:
    return format_html(
        '<span style="background-color: {color}; color: white; padding: 3px 10px; border-radius: 3px;">{text}</span>',
        color=color,
        text=text,
    )


def _has_payout_account(affiliate: Affiliate) -> bool:
    return bool(
        (affiliate.bank_name or "").strip()
        and (affiliate.account_holder or "").strip()
        and (affiliate.bank_account or "").strip()
    )


def _sync_affiliate_totals(affiliate_id) -> None:
    if not affiliate_id:
        return

    referral_qs = BusinessReferral.objects.filter(affiliate_id=affiliate_id)
    total_referred = referral_qs.count()
    total_active = referral_qs.filter(status="active").count()
    total_commissions = (
        RecurringCommission.objects.filter(affiliate_id=affiliate_id).aggregate(total=Sum("amount"))["total"]
        or Decimal("0.00")
    )
    total_paid = (
        AffiliatePayment.objects.filter(affiliate_id=affiliate_id, status="completed").aggregate(total=Sum("amount"))["total"]
        or Decimal("0.00")
    )

    Affiliate.objects.filter(pk=affiliate_id).update(
        total_referred_businesses=total_referred,
        total_active_referrals=total_active,
        total_commissions=total_commissions,
        total_paid=total_paid,
    )


_COMMISSION_SETTLEMENT_PREFIX = "__commission_settlement__="


def _split_payment_notes(notes: str | None) -> tuple[list[dict[str, object]], str]:
    raw_notes = (notes or "").strip()
    if not raw_notes:
        return [], ""

    settlement_meta: list[dict[str, object]] = []
    clean_lines: list[str] = []

    for line in raw_notes.splitlines():
        stripped = line.strip()
        if not stripped.startswith(_COMMISSION_SETTLEMENT_PREFIX):
            clean_lines.append(line)
            continue

        payload = stripped[len(_COMMISSION_SETTLEMENT_PREFIX):].strip()
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            clean_lines.append(line)
            continue

        if not isinstance(parsed, list):
            continue

        for item in parsed:
            if not isinstance(item, dict):
                continue
            commission_id = item.get("id")
            previous_status = item.get("from")
            if not isinstance(commission_id, int):
                continue
            if not isinstance(previous_status, str):
                continue
            settlement_meta.append({"id": commission_id, "from": previous_status})

    return settlement_meta, "\n".join(clean_lines).strip()


def _merge_payment_notes(notes_without_meta: str, settlement_meta: list[dict[str, object]]) -> str:
    sections: list[str] = []
    if settlement_meta:
        sections.append(f"{_COMMISSION_SETTLEMENT_PREFIX}{json.dumps(settlement_meta, separators=(',', ':'))}")
    if notes_without_meta:
        sections.append(notes_without_meta.strip())
    return "\n".join(sections).strip()


class PayoutAccountStateFilter(admin.SimpleListFilter):
    title = "payout account"
    parameter_name = "payout_account"

    def lookups(self, request, model_admin):
        return (
            ("ready", "Ready"),
            ("missing", "Missing"),
        )

    def queryset(self, request, queryset):
        required = (
            Q(bank_name__isnull=False)
            & ~Q(bank_name="")
            & Q(account_holder__isnull=False)
            & ~Q(account_holder="")
            & Q(bank_account__isnull=False)
            & ~Q(bank_account="")
        )
        value = self.value()
        if value == "ready":
            return queryset.filter(required)
        if value == "missing":
            return queryset.exclude(required)
        return queryset


class AvailableBalanceFilter(admin.SimpleListFilter):
    title = "available payout"
    parameter_name = "available_payout_state"

    def lookups(self, request, model_admin):
        return (
            ("payable", "Payable"),
            ("settled", "Settled"),
            ("overpaid", "Overpaid"),
        )

    def queryset(self, request, queryset):
        value = self.value()
        if value == "payable":
            return queryset.filter(total_commissions__gt=F("total_paid"))
        if value == "settled":
            return queryset.filter(total_commissions=F("total_paid"))
        if value == "overpaid":
            return queryset.filter(total_commissions__lt=F("total_paid"))
        return queryset


class BusinessReferralInline(admin.TabularInline):
    model = BusinessReferral
    extra = 0
    can_delete = False
    show_change_link = True
    fields = ("business", "status", "created_at", "activated_at", "cancelled_at")
    readonly_fields = ("created_at", "activated_at", "cancelled_at")
    raw_id_fields = ("business",)


class AffiliatePaymentInline(admin.TabularInline):
    model = AffiliatePayment
    extra = 0
    can_delete = False
    show_change_link = True
    fields = ("amount", "status", "payment_method", "requested_date", "processed_date", "completed_date")
    readonly_fields = ("requested_date", "processed_date", "completed_date")


@admin.register(Affiliate)
class AffiliateAdmin(admin.ModelAdmin):
    change_list_template = "admin/affiliate/affiliate/change_list.html"
    list_display = (
        "id",
        "user_email",
        "profile_picture_preview",
        "agent_location_display",
        "affiliate_code",
        "status_badge",
        "commission_rate_display",
        "payout_account_badge",
        "total_referred_businesses",
        "total_active_referrals",
        "total_commissions_display",
        "total_paid_display",
        "available_balance_display",
        "joined_date",
    )
    search_fields = (
        "user__email",
        "user__phone",
        "user__first_name",
        "user__last_name",
        "affiliate_code",
        "company_name",
        "residence_region",
        "residence_district",
        "residence_area",
        "address",
    )
    list_filter = (
        "status",
        "commission_type",
        PayoutAccountStateFilter,
        AvailableBalanceFilter,
        "joined_date",
    )
    ordering = ("-joined_date",)
    date_hierarchy = "joined_date"
    list_select_related = ("user",)
    raw_id_fields = ("user",)
    inlines = (BusinessReferralInline, AffiliatePaymentInline)
    actions = (
        "set_status_active",
        "set_status_suspended",
        "set_status_inactive",
        "recompute_selected_stats",
    )
    readonly_fields = (
        "affiliate_code",
        "status_badge",
        "payout_account_badge",
        "available_balance_display",
        "total_commissions_display",
        "total_paid_display",
        "total_referred_businesses",
        "total_active_referrals",
        "agent_location_display",
        "joined_date",
        "created_at",
        "updated_at",
    )
    fieldsets = (
        (
            "Operational Summary",
            {
                "fields": (
                    "status_badge",
                    "payout_account_badge",
                    "available_balance_display",
                    "total_commissions_display",
                    "total_paid_display",
                )
            },
        ),
        ("User Info", {"fields": ("user", "affiliate_code", "status", "agent_location_display")}),
        ("Commission Settings", {"fields": ("commission_rate", "commission_type")}),
        (
            "Profile Information",
            {
                "fields": (
                    "company_name",
                    "website",
                    "phone",
                    "profile_picture",
                    "residence_region",
                    "residence_district",
                    "residence_area",
                    "address",
                )
            },
        ),
        ("Payout Account", {"fields": ("bank_name", "account_holder", "bank_account", "swift_code")}),
        (
            "Stats",
            {
                "fields": (
                    "total_referred_businesses",
                    "total_active_referrals",
                    "total_commissions",
                    "total_paid",
                )
            },
        ),
        ("Dates", {"fields": ("joined_date", "created_at", "updated_at")}),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user")

    def changelist_view(self, request, extra_context=None):
        queryset = Affiliate.objects.all()
        total_affiliates = queryset.count()

        status_counts = {row["status"]: row["count"] for row in queryset.values("status").annotate(count=Count("id"))}
        status_cards = [
            {"label": "Active", "key": "active", "count": status_counts.get("active", 0), "color": "#16a34a"},
            {"label": "Pending", "key": "pending", "count": status_counts.get("pending", 0), "color": "#f59e0b"},
            {"label": "Suspended", "key": "suspended", "count": status_counts.get("suspended", 0), "color": "#dc2626"},
            {"label": "Inactive", "key": "inactive", "count": status_counts.get("inactive", 0), "color": "#6b7280"},
        ]

        ready_q = (
            Q(bank_name__isnull=False)
            & ~Q(bank_name="")
            & Q(account_holder__isnull=False)
            & ~Q(account_holder="")
            & Q(bank_account__isnull=False)
            & ~Q(bank_account="")
        )
        payout_ready_count = queryset.filter(ready_q).count()
        payout_missing_count = max(total_affiliates - payout_ready_count, 0)

        pending_payouts = AffiliatePayment.objects.filter(status="pending")
        processing_payouts = AffiliatePayment.objects.filter(status="processing")
        open_payouts = AffiliatePayment.objects.filter(status__in=("pending", "processing"))

        pending_commissions = RecurringCommission.objects.filter(status="pending")
        approved_commissions = RecurringCommission.objects.filter(status="approved")

        dashboard_data = {
            "total_affiliates": total_affiliates,
            "status_cards": status_cards,
            "payout_ready_count": payout_ready_count,
            "payout_missing_count": payout_missing_count,
            "pending_payout_count": pending_payouts.count(),
            "pending_payout_amount": _format_money(pending_payouts.aggregate(total=Sum("amount"))["total"]),
            "processing_payout_count": processing_payouts.count(),
            "processing_payout_amount": _format_money(processing_payouts.aggregate(total=Sum("amount"))["total"]),
            "open_payout_count": open_payouts.count(),
            "open_payout_amount": _format_money(open_payouts.aggregate(total=Sum("amount"))["total"]),
            "pending_commission_count": pending_commissions.count(),
            "pending_commission_amount": _format_money(pending_commissions.aggregate(total=Sum("amount"))["total"]),
            "approved_commission_count": approved_commissions.count(),
            "approved_commission_amount": _format_money(approved_commissions.aggregate(total=Sum("amount"))["total"]),
        }

        extra_context = extra_context or {}
        extra_context["affiliate_dashboard"] = dashboard_data
        return super().changelist_view(request, extra_context=extra_context)

    @admin.display(description="User")
    def user_email(self, obj: Affiliate):
        return obj.user.email or obj.user.phone or f"User {obj.user_id}"

    @admin.display(description="Profile")
    def profile_picture_preview(self, obj: Affiliate):
        if obj.profile_picture and getattr(obj.profile_picture, "url", None):
            return format_html(
                (
                    '<img src="{}" alt="profile" '
                    'style="width:36px;height:36px;border-radius:50%;object-fit:cover;'
                    'border:1px solid #d1d5db;" />'
                ),
                obj.profile_picture.url,
            )
        return "—"

    @admin.display(description="Agent Location")
    def agent_location_display(self, obj: Affiliate):
        region = (obj.residence_region or "").strip()
        district = (obj.residence_district or "").strip()
        area = (obj.residence_area or "").strip()
        if region and district and area:
            return f"{area}, {district}, {region}"

        affiliate_address = (obj.address or "").strip()
        user_location = (getattr(obj.user, "residence_location", "") or "").strip()
        return affiliate_address or user_location or "Not provided"

    @admin.display(description="Status")
    def status_badge(self, obj: Affiliate):
        colors = {
            "active": "#16a34a",
            "pending": "#f59e0b",
            "suspended": "#dc2626",
            "inactive": "#6b7280",
        }
        return _badge(obj.get_status_display(), colors.get(obj.status, "#6b7280"))

    @admin.display(description="Commission")
    def commission_rate_display(self, obj: Affiliate):
        if obj.commission_type == "percentage":
            return f"{obj.commission_rate}%"
        return _format_money(obj.commission_rate)

    @admin.display(description="Payout Account")
    def payout_account_badge(self, obj: Affiliate):
        if _has_payout_account(obj):
            return _badge("Ready", "#16a34a")
        return _badge("Missing", "#dc2626")

    @admin.display(description="Total Commissions")
    def total_commissions_display(self, obj: Affiliate):
        return _format_money(obj.total_commissions)

    @admin.display(description="Total Paid")
    def total_paid_display(self, obj: Affiliate):
        return _format_money(obj.total_paid)

    @admin.display(description="Available")
    def available_balance_display(self, obj: Affiliate):
        available = (obj.total_commissions or Decimal("0.00")) - (obj.total_paid or Decimal("0.00"))
        if available > 0:
            color = "#166534"
        elif available < 0:
            color = "#dc2626"
        else:
            color = "#6b7280"
        return format_html('<span style="color: {}; font-weight: 600;">{}</span>', color, _format_money(available))

    @admin.action(description="Set selected affiliates to Active")
    def set_status_active(self, request, queryset):
        updated = queryset.exclude(status="active").update(status="active")
        self.message_user(request, f"✓ {updated} affiliate(s) set to active.")

    @admin.action(description="Set selected affiliates to Suspended")
    def set_status_suspended(self, request, queryset):
        updated = queryset.exclude(status="suspended").update(status="suspended")
        self.message_user(request, f"✓ {updated} affiliate(s) set to suspended.")

    @admin.action(description="Set selected affiliates to Inactive")
    def set_status_inactive(self, request, queryset):
        updated = queryset.exclude(status="inactive").update(status="inactive")
        self.message_user(request, f"✓ {updated} affiliate(s) set to inactive.")

    @admin.action(description="Recompute selected affiliates stats from source records")
    def recompute_selected_stats(self, request, queryset):
        for affiliate in queryset.only("id"):
            _sync_affiliate_totals(affiliate.id)
        self.message_user(request, f"✓ Recomputed stats for {queryset.count()} affiliate(s).")


@admin.register(BusinessReferral)
class BusinessReferralAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "affiliate_email",
        "business",
        "status_badge",
        "created_at",
        "activated_at",
        "cancelled_at",
    )
    search_fields = ("affiliate__user__email", "business__name", "business__tin", "referral_code")
    list_filter = ("status", "created_at", "activated_at", "cancelled_at")
    ordering = ("-created_at",)
    list_select_related = ("affiliate", "affiliate__user", "business")
    raw_id_fields = ("affiliate", "business")
    date_hierarchy = "created_at"
    readonly_fields = ("referral_code", "created_at", "updated_at")
    actions = (
        "mark_referrals_active",
        "mark_referrals_cancelled",
        "sync_selected_affiliate_totals",
    )
    fieldsets = (
        ("Referral Info", {"fields": ("affiliate", "business", "referral_code", "referral_link", "status")}),
        ("Dates", {"fields": ("created_at", "activated_at", "cancelled_at", "updated_at")}),
    )

    @admin.display(description="Affiliate")
    def affiliate_email(self, obj: BusinessReferral):
        return obj.affiliate.user.email or obj.affiliate.user.phone or f"Affiliate {obj.affiliate_id}"

    @admin.display(description="Status")
    def status_badge(self, obj: BusinessReferral):
        colors = {
            "active": "#16a34a",
            "pending": "#f59e0b",
            "cancelled": "#dc2626",
        }
        return _badge(obj.get_status_display(), colors.get(obj.status, "#6b7280"))

    def save_model(self, request, obj, form, change):
        affected_affiliate_ids = set()
        if change:
            previous = BusinessReferral.objects.get(pk=obj.pk)
            affected_affiliate_ids.add(previous.affiliate_id)

        now = timezone.now()
        if obj.status == "active":
            obj.activated_at = obj.activated_at or now
            obj.cancelled_at = None
        elif obj.status == "cancelled":
            obj.cancelled_at = obj.cancelled_at or now

        super().save_model(request, obj, form, change)

        affected_affiliate_ids.add(obj.affiliate_id)
        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

    def delete_model(self, request, obj):
        affiliate_id = obj.affiliate_id
        super().delete_model(request, obj)
        _sync_affiliate_totals(affiliate_id)

    def delete_queryset(self, request, queryset):
        affiliate_ids = set(queryset.values_list("affiliate_id", flat=True))
        super().delete_queryset(request, queryset)
        for affiliate_id in affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

    @admin.action(description="Mark selected referrals as Active")
    def mark_referrals_active(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()
        now = timezone.now()

        for referral in queryset.select_related("affiliate"):
            if referral.status == "active":
                skipped += 1
                continue
            referral.status = "active"
            referral.activated_at = referral.activated_at or now
            referral.cancelled_at = None
            referral.save(update_fields=["status", "activated_at", "cancelled_at", "updated_at"])
            affected_affiliate_ids.add(referral.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} referral(s) marked as active.")
        if skipped:
            self.message_user(request, f"{skipped} referral(s) already active.", level=messages.WARNING)

    @admin.action(description="Mark selected referrals as Cancelled")
    def mark_referrals_cancelled(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()
        now = timezone.now()

        for referral in queryset.select_related("affiliate"):
            if referral.status == "cancelled":
                skipped += 1
                continue
            referral.status = "cancelled"
            referral.cancelled_at = referral.cancelled_at or now
            referral.save(update_fields=["status", "cancelled_at", "updated_at"])
            affected_affiliate_ids.add(referral.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} referral(s) marked as cancelled.")
        if skipped:
            self.message_user(request, f"{skipped} referral(s) already cancelled.", level=messages.WARNING)

    @admin.action(description="Recompute affiliate stats for selected referrals")
    def sync_selected_affiliate_totals(self, request, queryset):
        affiliate_ids = set(queryset.values_list("affiliate_id", flat=True))
        for affiliate_id in affiliate_ids:
            _sync_affiliate_totals(affiliate_id)
        self.message_user(request, f"✓ Recomputed stats for {len(affiliate_ids)} affiliate(s).")


@admin.register(RecurringCommission)
class RecurringCommissionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "affiliate_email",
        "business_name",
        "amount_display",
        "status_badge",
        "commission_type",
        "billing_month",
        "earned_date",
    )
    search_fields = ("affiliate__user__email", "business_referral__business__name", "transaction_id")
    list_filter = ("status", "commission_type", "payment_method", "billing_month", "earned_date")
    ordering = ("-earned_date",)
    list_select_related = ("affiliate", "affiliate__user", "business_referral", "business_referral__business", "subscription")
    raw_id_fields = ("affiliate", "business_referral", "subscription")
    date_hierarchy = "earned_date"
    readonly_fields = ("created_at", "updated_at")
    actions = (
        "mark_commissions_approved",
        "mark_commissions_rejected",
        "mark_commissions_paid",
        "sync_selected_affiliate_totals",
    )
    fieldsets = (
        (
            "Commission Info",
            {
                "fields": (
                    "affiliate",
                    "business_referral",
                    "subscription",
                    "amount",
                    "status",
                    "commission_type",
                    "commission_rate",
                    "commission_rate_type",
                )
            },
        ),
        ("Payment Info", {"fields": ("payment_method", "transaction_id")}),
        ("Billing", {"fields": ("billing_month",)}),
        ("Dates", {"fields": ("earned_date", "approved_date", "paid_date", "created_at", "updated_at")}),
    )

    @admin.display(description="Affiliate")
    def affiliate_email(self, obj: RecurringCommission):
        return obj.affiliate.user.email or obj.affiliate.user.phone or f"Affiliate {obj.affiliate_id}"

    @admin.display(description="Business")
    def business_name(self, obj: RecurringCommission):
        return obj.business_referral.business.name

    @admin.display(description="Amount")
    def amount_display(self, obj: RecurringCommission):
        return _format_money(obj.amount)

    @admin.display(description="Status")
    def status_badge(self, obj: RecurringCommission):
        colors = {
            "pending": "#f59e0b",
            "approved": "#2563eb",
            "paid": "#16a34a",
            "rejected": "#dc2626",
        }
        return _badge(obj.get_status_display(), colors.get(obj.status, "#6b7280"))

    def save_model(self, request, obj, form, change):
        affected_affiliate_ids = set()
        if change:
            previous = RecurringCommission.objects.get(pk=obj.pk)
            affected_affiliate_ids.add(previous.affiliate_id)

        now = timezone.now()
        if obj.status == "pending":
            obj.approved_date = None
            obj.paid_date = None
        elif obj.status == "approved":
            obj.approved_date = obj.approved_date or now
            obj.paid_date = None
        elif obj.status == "paid":
            obj.approved_date = obj.approved_date or now
            obj.paid_date = obj.paid_date or now
        elif obj.status == "rejected":
            obj.paid_date = None

        super().save_model(request, obj, form, change)

        affected_affiliate_ids.add(obj.affiliate_id)
        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

    def delete_model(self, request, obj):
        affiliate_id = obj.affiliate_id
        super().delete_model(request, obj)
        _sync_affiliate_totals(affiliate_id)

    def delete_queryset(self, request, queryset):
        affiliate_ids = set(queryset.values_list("affiliate_id", flat=True))
        super().delete_queryset(request, queryset)
        for affiliate_id in affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

    @admin.action(description="Mark selected commissions as Approved")
    def mark_commissions_approved(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()
        now = timezone.now()

        for commission in queryset:
            if commission.status != "pending":
                skipped += 1
                continue
            commission.status = "approved"
            commission.approved_date = commission.approved_date or now
            commission.paid_date = None
            commission.save(update_fields=["status", "approved_date", "paid_date", "updated_at"])
            affected_affiliate_ids.add(commission.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} commission(s) marked as approved.")
        if skipped:
            self.message_user(request, f"{skipped} commission(s) skipped (only pending can be approved).", level=messages.WARNING)

    @admin.action(description="Mark selected commissions as Rejected")
    def mark_commissions_rejected(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()

        for commission in queryset:
            if commission.status in ("rejected", "paid"):
                skipped += 1
                continue
            commission.status = "rejected"
            commission.paid_date = None
            commission.save(update_fields=["status", "paid_date", "updated_at"])
            affected_affiliate_ids.add(commission.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} commission(s) marked as rejected.")
        if skipped:
            self.message_user(
                request,
                f"{skipped} commission(s) skipped (paid/rejected cannot be rejected again).",
                level=messages.WARNING,
            )

    @admin.action(description="Mark selected commissions as Paid")
    def mark_commissions_paid(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()
        now = timezone.now()

        for commission in queryset:
            if commission.status != "approved":
                skipped += 1
                continue
            commission.status = "paid"
            commission.approved_date = commission.approved_date or now
            commission.paid_date = commission.paid_date or now
            commission.save(update_fields=["status", "approved_date", "paid_date", "updated_at"])
            affected_affiliate_ids.add(commission.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} commission(s) marked as paid.")
        if skipped:
            self.message_user(request, f"{skipped} commission(s) skipped (only approved can be paid).", level=messages.WARNING)

    @admin.action(description="Recompute affiliate stats for selected commissions")
    def sync_selected_affiliate_totals(self, request, queryset):
        affiliate_ids = set(queryset.values_list("affiliate_id", flat=True))
        for affiliate_id in affiliate_ids:
            _sync_affiliate_totals(affiliate_id)
        self.message_user(request, f"✓ Recomputed stats for {len(affiliate_ids)} affiliate(s).")


@admin.register(AffiliatePayment)
class AffiliatePaymentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "affiliate_email",
        "amount_display",
        "status_badge",
        "action_buttons",
        "payment_method",
        "requested_date",
        "processed_date",
        "completed_date",
    )
    search_fields = ("affiliate__user__email", "affiliate__user__phone", "transaction_id")
    list_filter = ("status", "payment_method", "requested_date", "processed_date", "completed_date")
    ordering = ("-requested_date",)
    date_hierarchy = "requested_date"
    readonly_fields = ("requested_date", "created_at", "updated_at")
    list_select_related = ("affiliate", "affiliate__user")
    raw_id_fields = ("affiliate",)
    actions = ("mark_as_pending", "mark_as_processing", "mark_as_completed", "mark_as_failed")
    fieldsets = (
        ("Payment Info", {"fields": ("affiliate", "amount", "status", "payment_method", "transaction_id")}),
        ("Notes", {"fields": ("notes",)}),
        ("Dates", {"fields": ("requested_date", "processed_date", "completed_date", "created_at", "updated_at")}),
    )

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path(
                "<path:object_id>/payout/",
                self.admin_site.admin_view(self.payout_request),
                name="affiliate_affiliatepayment_payout",
            ),
            path(
                "<path:object_id>/reject/",
                self.admin_site.admin_view(self.reject_request),
                name="affiliate_affiliatepayment_reject",
            ),
        ]
        return custom_urls + urls

    @admin.display(description="Affiliate")
    def affiliate_email(self, obj: AffiliatePayment):
        return obj.affiliate.user.email or obj.affiliate.user.phone or f"Affiliate {obj.affiliate_id}"

    @admin.display(description="Amount")
    def amount_display(self, obj: AffiliatePayment):
        return _format_money(obj.amount)

    @admin.display(description="Status")
    def status_badge(self, obj: AffiliatePayment):
        colors = {
            "pending": "#f59e0b",
            "processing": "#3b82f6",
            "completed": "#16a34a",
            "failed": "#dc2626",
        }
        return _badge(obj.get_status_display(), colors.get(obj.status, "#6b7280"))

    @admin.display(description="Quick Actions")
    def action_buttons(self, obj: AffiliatePayment):
        if obj.status not in ("pending", "processing"):
            return "—"

        payout_url = reverse("admin:affiliate_affiliatepayment_payout", args=[obj.pk])
        reject_url = reverse("admin:affiliate_affiliatepayment_reject", args=[obj.pk])
        return format_html(
            '<a class="button" href="{}" onclick="return confirm(\'Mark this payout request as completed?\');">Payout</a> '
            '<a class="button" href="{}" style="background:#dc2626;border-color:#dc2626;color:#fff;" '
            'onclick="return confirm(\'Reject this payout request?\');">Reject</a>',
            payout_url,
            reject_url,
        )

    def _settle_commissions_for_payment(self, payment: AffiliatePayment, settled_at) -> int:
        remaining = payment.amount or Decimal("0.00")
        commissions = RecurringCommission.objects.filter(
            affiliate_id=payment.affiliate_id,
            status__in=("approved", "pending"),
        ).order_by("billing_month", "earned_date", "id")

        settlement_meta: list[dict[str, object]] = []
        for commission in commissions:
            if remaining <= Decimal("0.00"):
                break

            commission_amount = commission.amount or Decimal("0.00")
            if commission_amount <= Decimal("0.00"):
                continue
            if commission_amount > remaining:
                continue

            previous_status = commission.status
            commission.status = "paid"
            commission.approved_date = commission.approved_date or settled_at
            commission.paid_date = settled_at
            commission.save(update_fields=["status", "approved_date", "paid_date", "updated_at"])

            settlement_meta.append({"id": commission.id, "from": previous_status})
            remaining -= commission_amount

        _, clean_notes = _split_payment_notes(payment.notes)
        payment.notes = _merge_payment_notes(clean_notes, settlement_meta)
        payment.save(update_fields=["notes", "updated_at"])
        return len(settlement_meta)

    def _revert_settled_commissions_for_payment(self, payment: AffiliatePayment) -> int:
        settlement_meta, clean_notes = _split_payment_notes(payment.notes)
        if not settlement_meta:
            return 0

        commission_ids = [item["id"] for item in settlement_meta if isinstance(item.get("id"), int)]
        commission_map = {
            commission.id: commission
            for commission in RecurringCommission.objects.filter(
                affiliate_id=payment.affiliate_id,
                id__in=commission_ids,
            )
        }

        reverted = 0
        for item in settlement_meta:
            commission_id = item.get("id")
            previous_status = item.get("from")
            if not isinstance(commission_id, int) or not isinstance(previous_status, str):
                continue

            commission = commission_map.get(commission_id)
            if not commission or commission.status != "paid":
                continue

            restore_status = previous_status if previous_status in ("pending", "approved") else "approved"
            commission.status = restore_status
            if restore_status == "pending":
                commission.approved_date = None
            else:
                commission.approved_date = commission.approved_date or timezone.now()
            commission.paid_date = None
            commission.save(update_fields=["status", "approved_date", "paid_date", "updated_at"])
            reverted += 1

        payment.notes = _merge_payment_notes(clean_notes, [])
        payment.save(update_fields=["notes", "updated_at"])
        return reverted

    def payout_request(self, request, object_id):
        payment = self.get_object(request, object_id)
        if payment is None:
            self.message_user(request, "Payout request not found.", level=messages.ERROR)
            return redirect(reverse("admin:affiliate_affiliatepayment_changelist"))

        if not self.has_change_permission(request, payment):
            self.message_user(request, "You do not have permission to process this payout.", level=messages.ERROR)
            return redirect(reverse("admin:affiliate_affiliatepayment_changelist"))

        self.mark_as_completed(request, AffiliatePayment.objects.filter(pk=payment.pk))
        return redirect(request.META.get("HTTP_REFERER", reverse("admin:affiliate_affiliatepayment_changelist")))

    def reject_request(self, request, object_id):
        payment = self.get_object(request, object_id)
        if payment is None:
            self.message_user(request, "Payout request not found.", level=messages.ERROR)
            return redirect(reverse("admin:affiliate_affiliatepayment_changelist"))

        if not self.has_change_permission(request, payment):
            self.message_user(request, "You do not have permission to reject this payout.", level=messages.ERROR)
            return redirect(reverse("admin:affiliate_affiliatepayment_changelist"))

        self.mark_as_failed(request, AffiliatePayment.objects.filter(pk=payment.pk))
        return redirect(request.META.get("HTTP_REFERER", reverse("admin:affiliate_affiliatepayment_changelist")))

    def save_model(self, request, obj, form, change):
        previous_status = None
        previous_amount = None
        previous_affiliate_id = None
        if change:
            previous = AffiliatePayment.objects.get(pk=obj.pk)
            previous_status = previous.status
            previous_amount = previous.amount
            previous_affiliate_id = previous.affiliate_id

        now = timezone.now()
        if obj.status in ("processing", "completed") and not obj.processed_date:
            obj.processed_date = now
        if obj.status == "completed" and not obj.completed_date:
            obj.completed_date = now
        if obj.status != "completed":
            obj.completed_date = None

        super().save_model(request, obj, form, change)

        with transaction.atomic():
            became_completed = False
            left_completed = False
            if not change and obj.status == "completed":
                Affiliate.objects.filter(pk=obj.affiliate_id).update(total_paid=F("total_paid") + obj.amount)
                became_completed = True
            elif previous_status != "completed" and obj.status == "completed":
                Affiliate.objects.filter(pk=obj.affiliate_id).update(total_paid=F("total_paid") + obj.amount)
                became_completed = True
            elif previous_status == "completed" and obj.status != "completed":
                Affiliate.objects.filter(pk=previous_affiliate_id).update(total_paid=F("total_paid") - previous_amount)
                left_completed = True
            elif previous_status == "completed" and obj.status == "completed":
                if previous_affiliate_id != obj.affiliate_id:
                    Affiliate.objects.filter(pk=previous_affiliate_id).update(total_paid=F("total_paid") - previous_amount)
                    Affiliate.objects.filter(pk=obj.affiliate_id).update(total_paid=F("total_paid") + obj.amount)
                elif previous_amount != obj.amount:
                    delta = obj.amount - previous_amount
                    Affiliate.objects.filter(pk=obj.affiliate_id).update(total_paid=F("total_paid") + delta)

            if became_completed:
                self._settle_commissions_for_payment(obj, now)
            elif left_completed:
                self._revert_settled_commissions_for_payment(obj)

        affected_affiliate_ids = {obj.affiliate_id}
        if previous_affiliate_id:
            affected_affiliate_ids.add(previous_affiliate_id)
        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

    @admin.action(description="Reset selected payout requests to Pending")
    def mark_as_pending(self, request, queryset):
        updated = 0
        skipped = 0
        affected_affiliate_ids = set()

        for payment in queryset.select_related("affiliate"):
            if payment.status == "pending":
                skipped += 1
                continue

            with transaction.atomic():
                if payment.status == "completed":
                    Affiliate.objects.filter(pk=payment.affiliate_id).update(total_paid=F("total_paid") - payment.amount)
                    self._revert_settled_commissions_for_payment(payment)
                payment.status = "pending"
                payment.processed_date = None
                payment.completed_date = None
                payment.save(update_fields=["status", "processed_date", "completed_date", "updated_at"])

            affected_affiliate_ids.add(payment.affiliate_id)
            updated += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if updated:
            self.message_user(request, f"✓ {updated} payout request(s) reset to pending.")
        if skipped:
            self.message_user(request, f"{skipped} request(s) already pending.", level=messages.WARNING)

    @admin.action(description="Mark selected payout requests as Processing")
    def mark_as_processing(self, request, queryset):
        updated = 0
        skipped = 0
        for payment in queryset:
            if payment.status != "pending":
                skipped += 1
                continue
            payment.status = "processing"
            payment.processed_date = payment.processed_date or timezone.now()
            payment.save(update_fields=["status", "processed_date", "updated_at"])
            updated += 1

        if updated:
            self.message_user(request, f"✓ {updated} payout request(s) marked as processing.")
        if skipped:
            self.message_user(
                request,
                f"{skipped} request(s) skipped (only pending requests can be moved to processing).",
                level=messages.WARNING,
            )

    @admin.action(description="Mark selected payout requests as Completed")
    def mark_as_completed(self, request, queryset):
        completed = 0
        skipped = 0
        affected_affiliate_ids = set()

        for payment in queryset.select_related("affiliate"):
            if payment.status not in ("pending", "processing"):
                skipped += 1
                continue

            now = timezone.now()
            with transaction.atomic():
                payment.status = "completed"
                payment.processed_date = payment.processed_date or now
                payment.completed_date = payment.completed_date or now
                payment.save(update_fields=["status", "processed_date", "completed_date", "updated_at"])
                Affiliate.objects.filter(pk=payment.affiliate_id).update(total_paid=F("total_paid") + payment.amount)
                self._settle_commissions_for_payment(payment, now)

            affected_affiliate_ids.add(payment.affiliate_id)
            completed += 1

        for affiliate_id in affected_affiliate_ids:
            _sync_affiliate_totals(affiliate_id)

        if completed:
            self.message_user(request, f"✓ {completed} payout request(s) marked as completed.")
        if skipped:
            self.message_user(
                request,
                f"{skipped} request(s) skipped (only pending/processing requests can be completed).",
                level=messages.WARNING,
            )

    @admin.action(description="Mark selected payout requests as Failed")
    def mark_as_failed(self, request, queryset):
        failed = 0
        skipped = 0
        for payment in queryset:
            if payment.status not in ("pending", "processing"):
                skipped += 1
                continue

            payment.status = "failed"
            payment.processed_date = payment.processed_date or timezone.now()
            payment.completed_date = None
            payment.save(update_fields=["status", "processed_date", "completed_date", "updated_at"])
            failed += 1

        if failed:
            self.message_user(request, f"✓ {failed} payout request(s) marked as failed.")
        if skipped:
            self.message_user(
                request,
                f"{skipped} request(s) skipped (only pending/processing requests can be failed).",
                level=messages.WARNING,
            )


@admin.register(AffiliateSettings)
class AffiliateSettingsAdmin(admin.ModelAdmin):
    list_display = (
        "enable_affiliate_program",
        "whatsapp_group_link",
        "default_commission_rate",
        "default_commission_type",
        "min_commission_for_payout",
        "auto_payout_enabled",
        "auto_payout_day",
        "updated_at",
    )
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        (
            "Program Settings",
            {"fields": ("enable_affiliate_program", "whatsapp_group_link", "default_commission_rate", "default_commission_type")},
        ),
        ("Referral Settings", {"fields": ("referral_expiry_days", "min_commission_for_payout")}),
        (
            "Commission Triggers",
            {
                "fields": (
                    "commission_on_signup",
                    "commission_on_first_purchase",
                    "commission_on_subscription",
                    "commission_on_monthly_recurring",
                )
            },
        ),
        ("Payout Settings", {"fields": ("auto_payout_enabled", "auto_payout_day")}),
        ("Dates", {"fields": ("created_at", "updated_at")}),
    )

    def changelist_view(self, request, extra_context=None):
        settings = AffiliateSettings.objects.order_by("-updated_at", "-id").first()
        if settings:
            return redirect(reverse("admin:affiliate_affiliatesettings_change", args=[settings.pk]))
        return redirect(reverse("admin:affiliate_affiliatesettings_add"))

    def has_add_permission(self, request):
        if AffiliateSettings.objects.exists():
            return False
        return super().has_add_permission(request)

    def has_delete_permission(self, request, obj=None):
        return False
