'use client';

import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';

type MarkTakeOrdersCompletedResult = {
  completed: string[];
  failed: string[];
};

export const markTakeOrdersCompleted = async (
  takeOrderIds: string[]
): Promise<MarkTakeOrdersCompletedResult> => {
  const uniqueIds = Array.from(
    new Set(takeOrderIds.map((id) => String(id || '').trim()).filter(Boolean))
  );
  const completed: string[] = [];
  const failed: string[] = [];

  for (const takeOrderId of uniqueIds) {
    const completedAt = new Date().toISOString();
    const localTakeOrder = await db.takeOrders.get(takeOrderId);
    let backendUpdated = false;

    try {
      const response = await authFetch.fetch(
        `/orders/take-orders/${encodeURIComponent(takeOrderId)}/update_status/`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'Completed' }),
          queueOnFailure: false,
        }
      );
      backendUpdated = true;
      const completedBy = response?.completed_by ?? response?.completedBy;
      const completedByName = response?.completed_by_name ?? response?.completedByName;
      await db.takeOrders.update(takeOrderId, {
        completedBy: completedBy ? String(completedBy) : undefined,
        completedByName: completedByName ? String(completedByName) : undefined,
      });
    } catch (error) {
      console.warn('[TakeOrder] Backend completion update failed:', takeOrderId, error);
      const httpStatus = Number((error as { status?: number } | null)?.status || 0);
      if (httpStatus >= 400 && httpStatus < 500) {
        failed.push(takeOrderId);
        continue;
      }
    }

    try {
      await db.takeOrders.update(takeOrderId, {
        status: 'Completed',
        cancellationReason: '',
        cancellation_reason: '',
        completedAt,
        updatedAt: completedAt,
        _dirty: !backendUpdated || localTakeOrder?._dirty,
        _operation: !backendUpdated
          ? (localTakeOrder?._operation === 'create' ? 'create' : 'update')
          : localTakeOrder?._operation,
        _synced_at: backendUpdated && !localTakeOrder?._dirty ? completedAt : undefined,
        syncPending: !backendUpdated || localTakeOrder?.syncPending || undefined,
      });
      completed.push(takeOrderId);
    } catch (error) {
      console.warn('[TakeOrder] Local completion update failed:', takeOrderId, error);
      failed.push(takeOrderId);
    }
  }

  if (completed.length > 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('handypos-orders-changed'));
  }

  return { completed, failed };
};
