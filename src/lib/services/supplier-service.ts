import { v4 as uuidv4 } from 'uuid';
import { db, type Supplier } from '@/lib/db';
import { logAuditAction } from '@/lib/audit';
import { syncService } from './sync-service';

const resolveStoredBusinessId = (): string => {
  if (typeof window === 'undefined') return '';

  const storageKeys = ['handy-pos-business', 'handypos-business'];
  for (const key of storageKeys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.id) {
        return String(parsed.id);
      }
    } catch (error) {
      console.warn(`[Supplier Service] Could not parse ${key}:`, error);
    }
  }

  const fallbackBusinessId = localStorage.getItem('handypos-business-id');
  return fallbackBusinessId ? String(fallbackBusinessId) : '';
};

/**
 * Offline-first supplier CRUD service
 * Marks items as dirty for sync via Sync Service
 * Sync Service handles all offline queueing and retry logic
 */

/**
 * Create a new supplier (offline-first)
 * 1. Saves to local database immediately with dirty flag
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function createSupplier(
  supplier: Omit<Supplier, 'id'>,
  userId: string,
  userName: string,
  branchId: string,
  businessId?: string
): Promise<Supplier> {
  try {
    // Generate UUID locally - this same ID will be used on backend
    const id = uuidv4();
    
    // Resolve business ID from explicit arg first, then local storage fallbacks.
    let bid = String(businessId || '').trim();
    if (!bid) {
      bid = resolveStoredBusinessId();
    }
    if (!bid) {
      throw new Error('Cannot create supplier without a business ID');
    }
    
    // 1. Save to local database immediately with sync flag
    const supplierWithSync = {
      ...supplier,
      id,
      businessId: bid,
      _dirty: true,
      _operation: 'create' as const
    };
    await db.suppliers.add(supplierWithSync as Supplier);
    console.log('[Supplier Service] Created supplier with ID:', id, 'for business:', bid);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'SUPPLIER_CREATE',
      entityType: 'Supplier',
      entityId: id,
      details: supplier,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Supplier Service] Triggering sync after supplier creation');
      syncService.performFullSync(branchId).catch(err => 
        console.error('[Supplier Service] Sync failed:', err)
      );
    }

    return { ...supplier, id } as Supplier;
  } catch (error) {
    console.error('Failed to create supplier:', error);
    throw error;
  }
}

/**
 * Update an existing supplier (offline-first)
 * 1. Updates local database immediately with dirty flag
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function updateSupplier(
  supplierId: string,
  updates: Partial<Supplier>,
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
    await db.suppliers.update(supplierId, updatesWithSync);
    console.log('[Supplier Service] Marked supplier as dirty:', supplierId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'SUPPLIER_UPDATE',
      entityType: 'Supplier',
      entityId: supplierId,
      details: updates,
    });

    // 3. Trigger sync if online
    if (typeof window !== 'undefined' && navigator.onLine) {
      console.log('[Supplier Service] Triggering sync after supplier update');
      syncService.performFullSync(branchId).catch(err => 
        console.error('[Supplier Service] Sync failed:', err)
      );
    }

    console.log(`[Supplier Service] Updated supplier: ${supplierId}`);
  } catch (error) {
    console.error('Failed to update supplier:', error);
    throw error;
  }
}

/**
 * Delete a supplier (offline-first)
 * 1. Deletes from local database immediately
 * 2. Logs audit action
 * 3. Sync Service will handle pushing to backend when online
 */
export async function deleteSupplier(
  supplierId: string,
  userId: string,
  userName: string,
  branchId: string
): Promise<void> {
  try {
    // 1. Delete from local database immediately
    await db.suppliers.delete(supplierId);

    // 2. Log audit action locally
    await logAuditAction({
      userId,
      userName,
      branchId,
      actionType: 'SUPPLIER_DELETE',
      entityType: 'Supplier',
      entityId: supplierId,
      details: { deletedAt: new Date().toISOString() },
    });

    console.log(`[Supplier Service] Deleted supplier: ${supplierId}`);
  } catch (error) {
    console.error('Failed to delete supplier:', error);
    throw error;
  }
}

/**
 * Get all suppliers
 */
export async function getAllSuppliers(): Promise<Supplier[]> {
  try {
    return await db.suppliers.toArray();
  } catch (error) {
    console.error('Failed to get suppliers:', error);
    throw error;
  }
}

/**
 * Get a single supplier by ID
 */
export async function getSupplierById(supplierId: string): Promise<Supplier | undefined> {
  try {
    return await db.suppliers.get(supplierId);
  } catch (error) {
    console.error('Failed to get supplier:', error);
    throw error;
  }
}
