import { db, type WasteRecord, type InventoryItem, type PurchaseRecord } from '@/lib/db';
import { logAuditAction } from '@/lib/audit';
import { syncService } from './sync-service';

/**
 * Offline-first waste record CRUD service
 * Marks items as dirty for sync via Sync Service
 * Sync Service handles all offline queueing and retry logic
 */

/**
 * Create a new waste record (offline-first)
 * 1. Saves to local database immediately with dirty flag
 * 2. Updates inventory stock immediately
 * 3. Logs audit action
 * 4. Sync Service will handle pushing to backend when online
 */
export async function createWasteRecord(
  waste: Omit<WasteRecord, 'id'>,
  userId: string,
  userName: string
): Promise<WasteRecord> {
  try {
    // 1. Save to local database immediately with sync flag
    const wasteWithSync = {
      ...waste,
      _dirty: true,
      _operation: 'create' as const
    };
    const id = await db.wasteLog.add(wasteWithSync as WasteRecord);
    console.log('[Waste Service] Created waste record with ID:', id);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId: waste.branchId,
      actionType: 'STOCK_WASTE',
      entityType: 'Waste',
      entityId: id,
      details: waste,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Waste Service] Triggering sync after waste creation');
      syncService.performFullSync(waste.branchId).catch(err => 
        console.error('[Waste Service] Sync failed:', err)
      );
    } else {
      console.log('[Waste Service] Offline - waste record queued for sync');
    }

    return { ...waste, id } as WasteRecord;
  } catch (error) {
    console.error('Failed to create waste record:', error);
    throw error;
  }
}

/**
 * Update an existing waste record (offline-first)
 * 1. Updates local database immediately with dirty flag
 * 2. Adjusts inventory if quantity changed
 * 3. Logs audit action
 * 4. Sync Service will handle pushing to backend when online
 */
export async function updateWasteRecord(
  recordId: string,
  updates: Partial<WasteRecord>,
  userId: string,
  userName: string,
  branchId: string
): Promise<void> {
  try {
    // Get existing record to calculate quantity difference
    const existingWaste = await db.wasteLog.get(recordId);
    if (!existingWaste) {
      throw new Error(`Waste record ${recordId} not found`);
    }

    // 1. Update local database immediately with sync flag
    const updatesWithSync = {
      ...updates,
      _dirty: true,
      _operation: 'update' as const
    };
    await db.wasteLog.update(recordId, updatesWithSync);
    console.log('[Waste Service] Marked waste record as dirty:', recordId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'STOCK_WASTE',
      entityType: 'Waste',
      entityId: recordId,
      details: updates,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Waste Service] Triggering sync after waste update');
      syncService.performFullSync(branchId).catch(err => 
        console.error('[Waste Service] Sync failed:', err)
      );
    } else {
      console.log('[Waste Service] Offline - waste record update queued for sync');
    }

    console.log(`[Waste Service] Updated waste record: ${recordId}`);
  } catch (error) {
    console.error('Failed to update waste record:', error);
    throw error;
  }
}

/**
 * Delete a waste record (offline-first)
 * 1. Deletes from local database immediately
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function deleteWasteRecord(
  recordId: string,
  userId: string,
  userName: string,
  branchId: string
): Promise<void> {
  try {
    // 1. Delete from local database immediately
    await db.wasteLog.delete(recordId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'STOCK_WASTE',
      entityType: 'Waste',
      entityId: recordId,
      details: { deletedAt: new Date().toISOString() },
    });

    console.log(`[Waste Service] Deleted waste record: ${recordId}`);

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Waste Service] Triggering sync after waste deletion');
      syncService.performFullSync(branchId).catch(err => 
        console.error('[Waste Service] Sync failed:', err)
      );
    } else {
      console.log('[Waste Service] Offline - waste record deletion queued for sync');
    }
  } catch (error) {
    console.error('Failed to delete waste record:', error);
    throw error;
  }
}

/**
 * Get all waste records for a branch
 */
export async function getWasteByBranch(branchId: string): Promise<WasteRecord[]> {
  try {
    return await db.wasteLog.where({ branchId }).toArray();
  } catch (error) {
    console.error('Failed to get waste records:', error);
    throw error;
  }
}

/**
 * Get a single waste record by ID
 */
export async function getWasteById(recordId: string): Promise<WasteRecord | undefined> {
  try {
    return await db.wasteLog.get(recordId);
  } catch (error) {
    console.error('Failed to get waste record:', error);
    throw error;
  }
}

/**
 * Get pending waste records (not yet synced)
 */
export async function getPendingWasteRecords(branchId: string): Promise<WasteRecord[]> {
  try {
    const allWaste = await db.wasteLog.where({ branchId }).toArray();
    return allWaste.filter(w => w._dirty === true);
  } catch (error) {
    console.error('Failed to get pending waste records:', error);
    throw error;
  }
}
