import { db, type PurchaseRecord } from '@/lib/db';
import { logAuditAction } from '@/lib/audit';
import { syncService } from './sync-service';

/**
 * Offline-first purchase CRUD service
 * Marks items as dirty for sync via Sync Service
 * Sync Service handles all offline queueing and retry logic
 */

/**
 * Create a new purchase record (offline-first)
 * 1. Saves to local database immediately with dirty flag
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function createPurchaseRecord(
  purchase: Omit<PurchaseRecord, 'id'>,
  userId: string,
  userName: string
): Promise<PurchaseRecord> {
  try {
    // 1. Save to local database immediately with sync flag
    const purchaseWithSync = {
      ...purchase,
      _dirty: true,
      _operation: 'create' as const
    };
    const id = await db.purchaseHistory.add(purchaseWithSync as PurchaseRecord);
    console.log('[Purchase Service] Created purchase record with ID:', id);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId: purchase.branchId,
      actionType: 'STOCK_RECEIVE',
      entityType: 'PurchaseRecord',
      entityId: String(id),
      details: purchase,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Purchase Service] Triggering sync after purchase creation');
      syncService.performFullSync(purchase.branchId).catch(err => 
        console.error('[Purchase Service] Sync failed:', err)
      );
    }

    return { ...purchase, id } as PurchaseRecord;
  } catch (error) {
    console.error('Failed to create purchase record:', error);
    throw error;
  }
}

/**
 * Update an existing purchase record (offline-first)
 * 1. Updates local database immediately with dirty flag
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function updatePurchaseRecord(
  recordId: number,
  updates: Partial<PurchaseRecord>,
  userId: string,
  userName: string,
  branchId: string
): Promise<void> {
  try {
    // 1. Update local database immediately with sync flag
    const updatesWithSync = {
      ...updates,
      _dirty: true,
      _operation: 'update' as const
    };
    await db.purchaseHistory.update(recordId, updatesWithSync);
    console.log('[Purchase Service] Marked purchase record as dirty:', recordId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'STOCK_RECEIVE_UPDATE',
      entityType: 'PurchaseRecord',
      entityId: String(recordId),
      details: updates,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Purchase Service] Triggering sync after purchase update');
      syncService.performFullSync(branchId).catch(err => 
        console.error('[Purchase Service] Sync failed:', err)
      );
    }

    console.log(`[Purchase Service] Updated purchase record: ${recordId}`);
  } catch (error) {
    console.error('Failed to update purchase record:', error);
    throw error;
  }
}

/**
 * Delete a purchase record (offline-first)
 * 1. Deletes from local database immediately
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function deletePurchaseRecord(
  recordId: number,
  userId: string,
  userName: string,
  branchId: string
): Promise<void> {
  try {
    // 1. Delete from local database immediately
    await db.purchaseHistory.delete(recordId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'STOCK_RECEIVE_DELETE',
      entityType: 'PurchaseRecord',
      entityId: String(recordId),
      details: { deletedAt: new Date().toISOString() },
    });

    console.log(`[Purchase Service] Deleted purchase record: ${recordId}`);
  } catch (error) {
    console.error('Failed to delete purchase record:', error);
    throw error;
  }
}

/**
 * Get all purchase records for a branch
 */
export async function getPurchasesByBranch(branchId: string): Promise<PurchaseRecord[]> {
  try {
    return await db.purchaseHistory.where({ branchId }).toArray();
  } catch (error) {
    console.error('Failed to get purchase records:', error);
    throw error;
  }
}

/**
 * Get a single purchase record by ID
 */
export async function getPurchaseById(recordId: number): Promise<PurchaseRecord | undefined> {
  try {
    return await db.purchaseHistory.get(recordId);
  } catch (error) {
    console.error('Failed to get purchase record:', error);
    throw error;
  }
}
