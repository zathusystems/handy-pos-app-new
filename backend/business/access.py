"""Shared business access helpers for authenticated application users."""

from .models import Business


def get_accessible_business_ids(user, *, admin_staff_only=False):
    """Return business IDs owned by ``user`` or assigned to eligible staff."""
    if not user or not getattr(user, 'is_authenticated', False):
        return []

    if getattr(user, 'is_superuser', False):
        return list(Business.objects.order_by('id').values_list('id', flat=True))

    business_ids = list(
        Business.objects.filter(owner=user).order_by('id').values_list('id', flat=True)
    )
    seen_business_ids = set(business_ids)

    try:
        from staff.models import Staff, StaffRole

        staff_qs = Staff.objects.filter(user=user, is_active=True).exclude(
            business_id__isnull=True,
        )
        if admin_staff_only:
            staff_qs = staff_qs.filter(role=StaffRole.ADMIN)
        for business_id in staff_qs.order_by('business_id').values_list('business_id', flat=True):
            if business_id not in seen_business_ids:
                business_ids.append(business_id)
                seen_business_ids.add(business_id)
    except Exception:
        # Keep owner access available if the staff app is unavailable during
        # migrations or isolated tests.
        pass

    return business_ids


def get_accessible_business_queryset(user, *, admin_staff_only=False):
    """Return businesses in the user's allowed business scope."""
    return Business.objects.filter(
        id__in=get_accessible_business_ids(user, admin_staff_only=admin_staff_only)
    ).order_by('id')


def get_accessible_business(user, business_id=None, *, admin_staff_only=False):
    """Resolve one accessible business, optionally by an explicit ID."""
    queryset = get_accessible_business_queryset(
        user,
        admin_staff_only=admin_staff_only,
    ).order_by('id')
    if business_id:
        queryset = queryset.filter(id=business_id)
    return queryset.first()


def user_can_access_business(user, business_id, *, admin_staff_only=False):
    """Check whether a user can operate on a business in the requested scope."""
    if not business_id:
        return False
    return get_accessible_business_queryset(
        user,
        admin_staff_only=admin_staff_only,
    ).filter(id=business_id).exists()
