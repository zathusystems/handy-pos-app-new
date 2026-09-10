import type { TakeOrder } from '@/lib/db';

export const TAKE_ORDER_PAYMENT_PERMISSION_MESSAGE =
  'Only the staff member who took this order can process its payment.';

export const canProcessTakeOrderPayment = (
  order: TakeOrder,
  currentUserId?: string | number | null,
  currentUserRole?: string | null
): boolean => {
  const role = String(currentUserRole ?? '').trim().toLowerCase();
  if (role === 'admin' || role === 'owner') {
    return true;
  }

  const userId = String(currentUserId ?? '').trim();
  if (!userId) {
    return false;
  }

  const createdBy = String(order.createdBy ?? (order as any).created_by ?? '').trim();
  return order.orderType === 'self_service' || !createdBy || createdBy === userId;
};
