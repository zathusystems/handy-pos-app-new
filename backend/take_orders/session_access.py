from .models import TakeOrder
from pos_sessions.models import Session


INCOMPLETE_TAKE_ORDER_STATUSES = tuple(
    status
    for status, _label in TakeOrder.STATUS_CHOICES
    if status not in {'Completed', 'Cancelled'}
)


def get_active_staff_session(*, user, business, branch):
    """Return the current user's active session for one branch, if present."""
    if not user or not getattr(user, 'is_authenticated', False):
        return None

    return Session.objects.filter(
        user=user,
        business=business,
        branch=branch,
        status='active',
    ).order_by('-started_at').first()


def get_uncompleted_orders_for_session(session):
    """Orders that must be resolved before the session can be closed."""
    return TakeOrder.objects.filter(
        session=session,
        status__in=INCOMPLETE_TAKE_ORDER_STATUSES,
    ).order_by('order_number')


def user_can_process_take_order_payment(*, user, take_order):
    """Whether a user may turn an order into a completed sale.

    Printing remains available to the team. This only protects the payment
    hand-off for staff-created orders, so one cashier cannot charge an order
    started by another cashier. QR/self-service and older unassigned orders
    remain available to the team because they have no individual taker.
    """
    if not user or not getattr(user, 'is_authenticated', False):
        return False

    if getattr(user, 'is_superuser', False):
        return True
    if take_order.business.owner_id == user.id:
        return True
    if take_order.order_type == 'self_service' or not take_order.created_by_id:
        return True
    if take_order.created_by_id == user.id:
        return True

    try:
        from staff.models import Staff, StaffRole

        return Staff.objects.filter(
            user=user,
            business=take_order.business,
            is_active=True,
            role=StaffRole.ADMIN,
        ).exists()
    except Exception:
        return False
