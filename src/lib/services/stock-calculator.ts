'use client';

import { db, type InventoryItem } from '@/lib/db';

function sanitizeBatchQuantity(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

async function getBatchesForItem(branchId: string, itemId: string) {
  let batches = await db.purchaseHistory
    .where({ branchId, productId: itemId as any })
    .toArray();

  if (batches.length === 0) {
    batches = await db.purchaseHistory
      .where('branchId')
      .equals(branchId)
      .filter(batch => String(batch.productId) === String(itemId))
      .toArray();
  }

  return batches;
}

/**
 * Calculate total stock units for an inventory item based on all its batches
 * This ensures stockUnits is always accurate and reflects actual batch quantities
 */
export async function calculateStockUnitsFromBatches(itemId: string, branchId: string): Promise<number> {
  try {
    const batches = await getBatchesForItem(branchId, itemId);

    const totalStock = batches.reduce((sum, batch) => sum + sanitizeBatchQuantity(batch.quantityRemaining), 0);
    
    console.log(`[Stock Calculator] Item ${itemId}: ${batches.length} batches, total stock = ${totalStock}`);
    
    return totalStock;
  } catch (error) {
    console.error(`[Stock Calculator] Error calculating stock for item ${itemId}:`, error);
    return 0;
  }
}

type StockUnitUpdateOptions = {
  markDirty?: boolean;
};

/**
 * Update inventory item's stockUnits to match total batch quantities
 * Should be called after any batch quantity change (receive, waste, sale)
 */
export async function updateInventoryStockUnits(
  itemId: string,
  branchId: string,
  options: StockUnitUpdateOptions = {}
): Promise<void> {
  try {
    const calculatedStock = await calculateStockUnitsFromBatches(itemId, branchId);
    const markDirty = options.markDirty ?? true;
    
    let item = await db.inventory.get(itemId as any);
    if (!item) {
      item = await db.inventory
        .where('branchId')
        .equals(branchId)
        .filter(candidate => String(candidate.id) === String(itemId))
        .first();
    }

    if (!item) {
      console.warn(`[Stock Calculator] Item ${itemId} not found in inventory`);
      return;
    }

    const oldStock = item.stockUnits || 0;
    
    if (oldStock !== calculatedStock) {
      console.log(`[Stock Calculator] Updating ${item.name}: ${oldStock} → ${calculatedStock}`);
      
      const updatePayload: Partial<InventoryItem> = {
        stockUnits: calculatedStock,
      };

      if (markDirty) {
        updatePayload._dirty = true;
        updatePayload._operation = 'update';
      }

      await db.inventory.update(item.id, updatePayload);
      
      console.log(`[Stock Calculator] Updated inventory item ${itemId} stock units to ${calculatedStock}`);
    } else {
      console.log(`[Stock Calculator] Stock units already correct for ${item.name}: ${calculatedStock}`);
    }
  } catch (error) {
    console.error(`[Stock Calculator] Error updating stock units for item ${itemId}:`, error);
  }
}

/**
 * Recalculate stock units for all items in a branch
 * Useful for reconciliation and after syncing from backend
 */
export async function recalculateAllStockUnits(branchId: string): Promise<{ updated: number; total: number }> {
  try {
    console.log(`[Stock Calculator] Starting full stock recalculation for branch ${branchId}`);
    
    const items = await db.inventory
      .where({ branchId })
      .toArray();

    let updated = 0;

    for (const item of items) {
      const calculatedStock = await calculateStockUnitsFromBatches(item.id, branchId);
      const oldStock = item.stockUnits || 0;

      if (oldStock !== calculatedStock) {
        console.log(`[Stock Calculator] Recalculating ${item.name}: ${oldStock} → ${calculatedStock}`);
        
        await db.inventory.update(item.id, {
          stockUnits: calculatedStock,
          _dirty: true,
          _operation: 'update'
        });
        
        updated++;
      }
    }

    console.log(`[Stock Calculator] Recalculation complete: ${updated}/${items.length} items updated`);
    
    return { updated, total: items.length };
  } catch (error) {
    console.error(`[Stock Calculator] Error recalculating stock units:`, error);
    return { updated: 0, total: 0 };
  }
}

/**
 * Get detailed stock breakdown for an item
 * Shows all batches and their quantities
 */
export async function getStockBreakdown(itemId: string, branchId: string): Promise<{
  itemId: string;
  totalStock: number;
  batches: Array<{
    batchId: string | number;
    batchNumber?: string;
    quantityRemaining: number;
    expiryDate?: string;
    receivedDate: string;
    costPerUnit: number;
  }>;
}> {
  try {
    const batches = await getBatchesForItem(branchId, itemId);

    const totalStock = batches.reduce((sum, batch) => sum + sanitizeBatchQuantity(batch.quantityRemaining), 0);

    const breakdown = {
      itemId,
      totalStock,
      batches: batches.map(b => ({
        batchId: b.id!,
        batchNumber: b.batchNumber,
        quantityRemaining: sanitizeBatchQuantity(b.quantityRemaining),
        expiryDate: b.expiryDate,
        receivedDate: b.receivedDate,
        costPerUnit: b.costPerUnit
      }))
    };

    console.log(`[Stock Calculator] Stock breakdown for ${itemId}:`, breakdown);
    
    return breakdown;
  } catch (error) {
    console.error(`[Stock Calculator] Error getting stock breakdown for item ${itemId}:`, error);
    return {
      itemId,
      totalStock: 0,
      batches: []
    };
  }
}
