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
    }

    try {
      await db.takeOrders.update(takeOrderId, {
        status: 'Completed',
        completedAt,
        updatedAt: completedAt,
        _dirty: !backendUpdated,
        _operation: backendUpdated ? undefined : 'update',
        _synced_at: backendUpdated ? completedAt : undefined,
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
