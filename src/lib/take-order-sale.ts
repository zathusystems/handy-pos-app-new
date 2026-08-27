'use client';

import { db, type InventoryItem, type TakeOrder, type TakeOrderItem } from '@/lib/db';

export type AddTakeOrderLineToCart = (
  item: InventoryItem,
  quantity: number,
  price: number,
  notes?: string,
  takeOrderId?: string,
  options?: {
    selectedOptions?: Array<Record<string, unknown>>;
  }
) => Promise<boolean | void> | boolean | void;

type AddTakeOrderToSaleCartResult = {
  added: number;
  failed: number;
};

const normalizeBranchId = (value?: string | number | null): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const getTakeOrderItemInventoryId = (item: TakeOrderItem): string => {
  return String(
    item.inventoryItemId ||
    (item as any).inventory_item_id ||
    (item as any).inventoryItem ||
    (item as any).inventory_item ||
    ''
  ).trim();
};

const findInventoryItemForTakeOrderItem = async (
  item: TakeOrderItem,
  branchId: string
): Promise<InventoryItem | undefined> => {
  const inventoryItemId = getTakeOrderItemInventoryId(item);
  if (inventoryItemId) {
    const byId = await db.inventory.get(inventoryItemId);
    if (byId) return byId;
  }

  const normalizedBranchId = normalizeBranchId(branchId);
  const allInventory = await db.inventory.toArray();
  return allInventory.find((inventoryItem) => (
    String(inventoryItem.name || '').trim().toLowerCase() ===
      String(item.name || '').trim().toLowerCase() &&
    (!normalizedBranchId || normalizeBranchId(inventoryItem.branchId) === normalizedBranchId)
  ));
};

const getSelectedOptions = (item: TakeOrderItem): Array<Record<string, unknown>> => {
  const selected = item.selectedOptions ?? item.selected_options;
  return Array.isArray(selected) ? selected.filter((option) => option && typeof option === 'object') : [];
};

export const addTakeOrderToSaleCart = async ({
  order,
  branchId,
  onAddToCart,
}: {
  order: TakeOrder;
  branchId: string;
  onAddToCart: AddTakeOrderLineToCart;
}): Promise<AddTakeOrderToSaleCartResult> => {
  let added = 0;
  let failed = 0;

  for (const item of order.items || []) {
    const quantity = Number(item.quantity || 0);
    const takeOrderPrice = Number((item as any).price || 0);
    const inventoryItem = await findInventoryItemForTakeOrderItem(item, branchId);
    const price = takeOrderPrice > 0 ? takeOrderPrice : Number(inventoryItem?.price || 0);
    const notes = item.notes?.trim() || undefined;

    if (quantity <= 0) {
      failed += 1;
      continue;
    }

    const menuItemId = String((item as any).menuItemId ?? (item as any).menu_item_id ?? '').trim();
    const preparedItemId = getTakeOrderItemInventoryId(item) || menuItemId || String(item.id);
    const cartItem: InventoryItem = {
      ...(inventoryItem || {
        id: preparedItemId,
        name: item.name,
        category: 'Take Order Item',
        itemType: 'sellable',
        branchId,
        price,
        recipe: Array.isArray((item as any).recipe) ? (item as any).recipe : [],
        isPreparedMenuItem: Boolean((item as any).isPreparedMenuItem ?? (item as any).is_prepared_menu_item),
        is_prepared_menu_item: Boolean((item as any).isPreparedMenuItem ?? (item as any).is_prepared_menu_item),
        menuItemId: menuItemId || undefined,
        menu_item_id: menuItemId || undefined,
      }),
      isTakeawayPackaging: Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging),
      is_takeaway_packaging: Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging),
    };

    const selectedOptions = getSelectedOptions(item);
    const result = await onAddToCart(cartItem, quantity, price, notes, order.id, { selectedOptions });
    if (result === false) {
      failed += 1;
      continue;
    }

    added += 1;
  }

  return { added, failed };
};
