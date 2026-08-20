'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';

/**
 * Hook to track pending sync items from both:
 * 1. AuthFetch queue (sessions, settings, etc.)
 * 2. Sync Service dirty flags (inventory, orders, transfers, waste, etc.)
 * 
 * Updates whenever sync status changes
 * 
 * @param branchId - Optional branch ID to filter dirty records by branch
 */
export function useSyncStatus(branchId?: string | null) {
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [isOnline, setIsOnline] = useState(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine)
  );
  const [dirtyRecords, setDirtyRecords] = useState<any[]>([]);
  const [failedQueueItems, setFailedQueueItems] = useState<any[]>([]);
  const [pendingQueueItems, setPendingQueueItems] = useState<any[]>([]);

  useEffect(() => {
    // Check sync status from both authFetch and Sync Service dirty flags
    const updateSyncStatus = async () => {
      try {
        if (typeof navigator !== 'undefined') {
          setIsOnline(navigator.onLine);
        }

        const stableStringify = (value: any): string => {
          const normalize = (input: any): any => {
            if (Array.isArray(input)) {
              return input.map(normalize);
            }
            if (input && typeof input === 'object') {
              const sortedKeys = Object.keys(input).sort();
              const normalized: Record<string, any> = {};
              for (const key of sortedKeys) {
                normalized[key] = normalize(input[key]);
              }
              return normalized;
            }
            return input;
          };

          try {
            const serialized = JSON.stringify(normalize(value));
            return serialized === undefined ? 'undefined' : serialized;
          } catch {
            return String(value);
          }
        };

        const getQueueSignature = (item: any): string => {
          return [
            item?.method || '',
            item?.url || '',
            item?.domain || '',
            item?.entityType || '',
            item?.entityId || '',
            stableStringify(item?.body),
            stableStringify(item?.metadata),
          ].join('::');
        };

        const CANCELLED_KEY = 'handypos-cancelled-sync-items';
        const cancelledIds = new Set<string>(JSON.parse(localStorage.getItem(CANCELLED_KEY) || '[]'));

        // Get authFetch sync queue (includes sessions, settings, etc.)
        const authFetchStatus = authFetch.getSyncQueueStatus();
        const authQueueItems = authFetchStatus.items || [];
        const authFetchPending = Array.from(
          authQueueItems
            .filter((item: any) => !item?.cancelled && !cancelledIds.has(item.id))
            .reduce((acc: Map<string, any>, item: any) => {
              acc.set(getQueueSignature(item), item);
              return acc;
            }, new Map<string, any>())
            .values()
        );

        // Get dirty records from Sync Service (inventory, orders, transfers, waste, purchases, suppliers, etc.)
        // Note: Use filter() instead of where().equals() for boolean fields as IndexedDB doesn't support boolean key ranges
        const dirtyInventory = (await db.inventory.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtySessions = (await db.sessions.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtyOrders = (await db.orders.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtyPurchaseOrders = (await db.purchaseOrders.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtyStockTransfers = (await db.stockTransfers.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtyWasteRecords = (await db.wasteLog.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtyPurchaseHistory = (await db.purchaseHistory.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        const dirtySuppliers = (await db.suppliers.toArray()).filter(r => r._dirty === true && (!branchId || String(r.branchId) === String(branchId)));
        
        // Combine all dirty records
        const allDirtyRecords = [
          ...dirtyInventory.map(r => ({ type: 'InventoryItem', id: r.id, operation: r._operation, name: r.name })),
          ...dirtySessions.map(r => ({ type: 'Session', id: r.id, operation: r._operation, name: r.id })),
          ...dirtyOrders.map(r => ({ type: 'Order', id: r.id, operation: r._operation, name: r.id })),
          ...dirtyPurchaseOrders.map(r => ({ type: 'PurchaseOrder', id: r.id, operation: r._operation, name: r.order_number })),
          ...dirtyStockTransfers.map(r => ({ type: 'StockTransfer', id: r.id, operation: r._operation, name: r.id })),
          ...dirtyWasteRecords.map(r => ({ type: 'WasteRecord', id: r.id, operation: r._operation, name: r.id })),
          ...dirtyPurchaseHistory.map(r => ({ type: 'PurchaseRecord', id: r.id, operation: r._operation, name: r.productName })),
          ...dirtySuppliers.map(r => ({ type: 'Supplier', id: r.id, operation: r._operation, name: r.name })),
        ];
        
        const dirtyCount = allDirtyRecords.length;
        const failedQueueItems = authFetchPending.filter(
          (item: any) => Boolean(String(item?.error || '').trim())
        );
        const pendingQueueItems = authFetchPending.filter(
          (item: any) => !String(item?.error || '').trim()
        );
        const totalPending = dirtyCount + pendingQueueItems.length;
        const totalFailed = failedQueueItems.length;
        
        console.log(`[Sync Status] Dirty Records: ${dirtyCount} | AuthFetch: ${pendingQueueItems.length} pending, ${failedQueueItems.length} failed | Total Pending: ${totalPending}${branchId ? ` | Branch: ${branchId}` : ''}`);
        
        setPendingCount(totalPending);
        setFailedCount(totalFailed);
        setDirtyRecords(allDirtyRecords);
        setFailedQueueItems(failedQueueItems);
        setPendingQueueItems(pendingQueueItems);
      } catch (error) {
        console.error('[Sync Status] Error updating sync status:', error);
      }
    };

    if (typeof navigator !== 'undefined') {
      setIsOnline(navigator.onLine);
    }

    updateSyncStatus();

    // Listen for online/offline events
    const handleOnline = () => {
      console.log('[Sync Status] Network online - triggering sync check');
      setIsOnline(true);
    };
    const handleOffline = () => {
      console.log('[Sync Status] Network offline');
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Poll for sync status changes every 1 second (more frequent for dirty flags)
    const interval = setInterval(updateSyncStatus, 1000);

    // Listen for storage changes (sync from other tabs)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key?.includes('sync') || e.key?.includes('dirty')) {
        console.log('[Sync Status] Storage changed, updating sync status');
        updateSyncStatus();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, [branchId]);

  return {
    pendingCount,
    failedCount,
    isOnline,
    hasPending: pendingCount > 0,
    hasFailed: failedCount > 0,
    dirtyRecords,
    failedQueueItems,
    pendingQueueItems,
  };
}
