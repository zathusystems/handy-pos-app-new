from rest_framework.exceptions import PermissionDenied

from .models import Subscription


FEATURE_LABELS = {
    'expense_management': 'Expense Management',
    'staff_management': 'Staff Management',
    'tax_management': 'Tax Management',
}


def _get_requested_business_id(request):
    request_data = getattr(request, 'data', None)
    if hasattr(request_data, 'get'):
        business_id = request_data.get('business')
        if business_id:
            return business_id

    query_params = getattr(request, 'query_params', None)
    if hasattr(query_params, 'get'):
        return query_params.get('business')

    return None


def _get_feature_label(feature_name):
    return FEATURE_LABELS.get(
        feature_name,
        feature_name.replace('_', ' ').strip().title() or 'This feature',
    )


def _format_feature_gate_message(feature_name, reason):
    feature_label = _get_feature_label(feature_name)
    normalized_reason = str(reason or '').strip()
    normalized_reason_lower = normalized_reason.lower()

    if 'not enabled' in normalized_reason_lower:
        return (
            f'{feature_label} is not enabled on this subscription. '
            'Enable it from Billing > Subscription Features to continue.'
        )

    if 'insufficient balance' in normalized_reason_lower:
        return (
            f'{feature_label} is unavailable because the subscription balance is too low. '
            'Add credits in Billing to continue.'
        )

    if 'not active' in normalized_reason_lower or normalized_reason_lower.startswith('subscription is '):
        return (
            f'{feature_label} is unavailable because the subscription is not active. '
            'Open Billing to restore access.'
        )

    if normalized_reason:
        return f'{feature_label} is unavailable. {normalized_reason}'

    return f'{feature_label} is unavailable for this subscription.'


def _resolve_business_id_for_request(
    request,
    allow_staff_access=False,
    admin_staff_only=False,
):
    requested_business_id = _get_requested_business_id(request)
    user = request.user

    owned_businesses = getattr(user, 'businesses', None)
    if owned_businesses is not None:
        owner_queryset = owned_businesses.all()
        if requested_business_id:
            owner_queryset = owner_queryset.filter(id=requested_business_id)

        business = owner_queryset.order_by('id').first()
        if business:
            return business.id

    if allow_staff_access:
        try:
            from staff.models import Staff, StaffRole
        except Exception:
            return None

        staff_profiles = Staff.objects.filter(
            user=user,
            is_active=True,
        )
        if admin_staff_only:
            staff_profiles = staff_profiles.filter(role=StaffRole.ADMIN)
        staff_profile = staff_profiles.only('business_id').first()

        if not staff_profile or not staff_profile.business_id:
            return None

        if requested_business_id and str(staff_profile.business_id) != str(requested_business_id):
            return None

        return staff_profile.business_id

    return None


def check_request_subscription_feature(
    request,
    feature_name,
    allow_staff_access=False,
    admin_staff_only=False,
):
    business_id = _resolve_business_id_for_request(
        request,
        allow_staff_access=allow_staff_access,
        admin_staff_only=admin_staff_only,
    )
    feature_label = _get_feature_label(feature_name)

    if not business_id:
        return False, (
            f'{feature_label} is unavailable because this user is not linked to a subscribed business.'
        )

    subscription = Subscription.objects.filter(business_id=business_id).order_by('id').first()
    if not subscription:
        return False, (
            f'{feature_label} is unavailable because this business has no subscription yet. '
            'Open Billing to continue.'
        )

    allowed, reason = subscription.can_use_feature(feature_name)
    if allowed:
        return True, None

    return False, _format_feature_gate_message(feature_name, reason)


class SubscriptionFeatureGateMixin:
    required_subscription_feature = None
    feature_gate_allow_staff_access = False
    feature_gate_admin_staff_only = False
    feature_gate_actions = None
    feature_gate_exempt_actions = set()

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)

        feature_name = getattr(self, 'required_subscription_feature', None)
        if not feature_name:
            return

        action = getattr(self, 'action', None)
        if action in getattr(self, 'feature_gate_exempt_actions', set()):
            return

        allowed_actions = getattr(self, 'feature_gate_actions', None)
        if allowed_actions is not None and action not in allowed_actions:
            return

        allowed, message = check_request_subscription_feature(
            request,
            feature_name,
            allow_staff_access=getattr(self, 'feature_gate_allow_staff_access', False),
            admin_staff_only=getattr(self, 'feature_gate_admin_staff_only', False),
        )
        if not allowed:
            raise PermissionDenied(detail=message)
