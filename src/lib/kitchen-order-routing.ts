import type { InventoryItem } from '@/lib/db';

export type KitchenInventoryLookup = {
  byId: Map<string, InventoryItem>;
  byName: Map<string, InventoryItem>;
};

export type KitchenRecipeIngredient = {
  ingredientId?: string;
  name: string;
  quantity: number;
  unit?: string;
};

const normalizeText = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y'].includes(normalized);
};

export const getTakeOrderLineInventoryId = (item: any): string => {
  return String(
    item?.inventoryItemId ??
    item?.inventory_item_id ??
    item?.inventoryItem ??
    item?.inventory_item ??
    item?.id ??
    ''
  ).trim();
};

const normalizeRecipe = (value: unknown): KitchenRecipeIngredient[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry: any): KitchenRecipeIngredient | null => {
      const ingredientId = String(
        entry?.ingredientId ??
        entry?.ingredient_id ??
        entry?.inventoryItemId ??
        entry?.inventory_item_id ??
        entry?.id ??
        ''
      ).trim();
      const quantity = toFiniteNumber(entry?.quantity, 0);
      const name = String(entry?.name ?? '').trim();
      const unit = String(entry?.unit ?? entry?.unitType ?? entry?.unit_type ?? '').trim();

      if (!ingredientId && !name) return null;

      return {
        ingredientId: ingredientId || undefined,
        name: name || 'Ingredient',
        quantity,
        unit: unit || undefined,
      };
    })
    .filter((entry): entry is KitchenRecipeIngredient => entry !== null);
};

export const normalizeKitchenInventoryItem = (item: any): InventoryItem => ({
  ...item,
  id: String(item?.id ?? '').trim(),
  name: String(item?.name ?? '').trim(),
  category: String(item?.category ?? '').trim(),
  itemType: item?.itemType ?? item?.item_type ?? 'sellable',
  branchId: String(item?.branchId ?? item?.branch_id ?? item?.branch ?? '').trim(),
  isProduced: toBoolean(item?.isProduced ?? item?.is_produced),
  recipe: normalizeRecipe(item?.recipe),
});

export const buildKitchenInventoryLookup = (items: any[] = []): KitchenInventoryLookup => {
  const byId = new Map<string, InventoryItem>();
  const byName = new Map<string, InventoryItem>();

  items.forEach((rawItem) => {
    const item = normalizeKitchenInventoryItem(rawItem);
    if (item.id) byId.set(item.id, item);

    const normalizedName = normalizeText(item.name);
    if (normalizedName && !byName.has(normalizedName)) {
      byName.set(normalizedName, item);
    }
  });

  return { byId, byName };
};

export const resolveKitchenInventoryItem = (
  orderItem: any,
  lookup: KitchenInventoryLookup
): InventoryItem | undefined => {
  const itemId = getTakeOrderLineInventoryId(orderItem);
  if (itemId) {
    const byId = lookup.byId.get(itemId);
    if (byId) return byId;
  }

  const normalizedName = normalizeText(orderItem?.name);
  return normalizedName ? lookup.byName.get(normalizedName) : undefined;
};

export const getKitchenRecipeForOrderItem = (
  orderItem: any,
  lookup: KitchenInventoryLookup
): KitchenRecipeIngredient[] => {
  const inventoryItem = resolveKitchenInventoryItem(orderItem, lookup);
  const inventoryRecipe = normalizeRecipe(inventoryItem?.recipe);
  if (inventoryRecipe.length > 0) return inventoryRecipe;
  return normalizeRecipe(orderItem?.recipe);
};

export const isKitchenPrepOrderItem = (
  orderItem: any,
  lookup: KitchenInventoryLookup
): boolean => {
  if (toBoolean(orderItem?.isKitchenItem ?? orderItem?.is_kitchen_item)) {
    return true;
  }

  const inventoryItem = resolveKitchenInventoryItem(orderItem, lookup);
  if (inventoryItem) {
    return inventoryItem.itemType === 'sellable' && (
      Boolean(inventoryItem.isProduced) ||
      normalizeRecipe(inventoryItem.recipe).length > 0
    );
  }

  return toBoolean(orderItem?.isProduced ?? orderItem?.is_produced) ||
    normalizeRecipe(orderItem?.recipe).length > 0;
};

export const getKitchenOrderItems = <T extends { items?: any[] }>(
  order: T,
  lookup: KitchenInventoryLookup
): any[] => (order.items || []).filter((item) => isKitchenPrepOrderItem(item, lookup));

export const getNonKitchenOrderItems = <T extends { items?: any[] }>(
  order: T,
  lookup: KitchenInventoryLookup
): any[] => (order.items || []).filter((item) => !isKitchenPrepOrderItem(item, lookup));

export const orderHasKitchenPrepItems = <T extends { items?: any[] }>(
  order: T,
  lookup: KitchenInventoryLookup
): boolean => getKitchenOrderItems(order, lookup).length > 0;

export const getKitchenRouteStatus = <T extends { items?: any[] }>(
  order: T,
  lookup: KitchenInventoryLookup
): 'Sent to Kitchen' | 'Ready' => (
  orderHasKitchenPrepItems(order, lookup) ? 'Sent to Kitchen' : 'Ready'
);

export const getRecipeIngredientOrderQuantity = (
  ingredient: KitchenRecipeIngredient,
  orderItem: any
): number => toFiniteNumber(ingredient.quantity, 0) * toFiniteNumber(orderItem?.quantity, 0);
