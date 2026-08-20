import type { InventoryItem } from '@/lib/db';

export type StockTrackingInventoryLookup = {
  byId: Map<string, InventoryItem>;
  byName: Map<string, InventoryItem>;
};

export type SoldOrderStockMovement = {
  itemId?: string;
  name?: string;
  quantity: number;
  source: 'direct' | 'recipe' | 'option';
  parentItemName?: string;
  optionName?: string;
  optionGroupName?: string;
};

const normalizeName = (value: unknown): string => {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
};

const toPositiveNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const getOrderItemInventoryId = (item: any): string | undefined => {
  const rawId = item?.inventoryItemId ?? item?.inventory_item_id ?? item?.inventoryItem ?? item?.inventory_item;
  if (rawId === undefined || rawId === null) return undefined;
  const normalized = String(rawId).trim();
  return normalized || undefined;
};

const getRecipeIngredientId = (recipeItem: any): string | undefined => {
  const rawId =
    recipeItem?.ingredientId ??
    recipeItem?.ingredient_id ??
    recipeItem?.inventoryItemId ??
    recipeItem?.inventory_item_id ??
    recipeItem?.linkedInventoryItemId ??
    recipeItem?.linked_inventory_item_id ??
    recipeItem?.id;
  const normalized = String(rawId ?? '').trim();
  return normalized || undefined;
};

const getRecipeIngredientName = (recipeItem: any): string | undefined => {
  const normalized = String(
    recipeItem?.name ??
    recipeItem?.ingredientName ??
    recipeItem?.ingredient_name ??
    recipeItem?.inventoryItemName ??
    recipeItem?.inventory_item_name ??
    recipeItem?.linkedInventoryItemName ??
    recipeItem?.linked_inventory_item_name ??
    ''
  ).trim();
  return normalized || undefined;
};

const getSelectedOptions = (orderItem: any): Array<Record<string, any>> => {
  const selected = orderItem?.selectedOptions ?? orderItem?.selected_options;
  return Array.isArray(selected)
    ? selected.filter((option) => option && typeof option === 'object')
    : [];
};

const getSelectedOptionQuantity = (option: any): number => {
  const quantity = toPositiveNumber(
    option?.quantity ?? option?.selectedQuantity ?? option?.selected_quantity
  );
  return quantity > 0 ? quantity : 1;
};

const getSelectedOptionName = (option: any): string | undefined => {
  const normalized = String(option?.name ?? option?.label ?? option?.optionName ?? option?.option_name ?? '').trim();
  return normalized || undefined;
};

const getSelectedOptionGroupName = (option: any): string | undefined => {
  const normalized = String(
    option?.groupName ??
    option?.group_name ??
    option?.optionGroupName ??
    option?.option_group_name ??
    ''
  ).trim();
  return normalized || undefined;
};

const getSelectedOptionMovements = (
  orderItem: any,
  soldQuantity: number
): SoldOrderStockMovement[] => {
  const parentItemName = String(orderItem?.name ?? '').trim() || undefined;

  return getSelectedOptions(orderItem).flatMap((option): SoldOrderStockMovement[] => {
    const optionName = getSelectedOptionName(option);
    const optionGroupName = getSelectedOptionGroupName(option);
    const optionMultiplier = soldQuantity * getSelectedOptionQuantity(option);
    const movements: SoldOrderStockMovement[] = [];

    const linkedInventoryId = String(
      option?.linked_inventory_item ??
      option?.linkedInventoryItem ??
      option?.linked_inventory_item_id ??
      option?.linkedInventoryItemId ??
      ''
    ).trim();
    const linkedInventoryName = String(
      option?.linked_inventory_item_name ??
      option?.linkedInventoryItemName ??
      ''
    ).trim();
    const linkedInventoryQuantity = toPositiveNumber(
      option?.linked_inventory_quantity ?? option?.linkedInventoryQuantity
    );

    if (linkedInventoryId && linkedInventoryQuantity > 0) {
      movements.push({
        itemId: linkedInventoryId,
        name: linkedInventoryName || optionName,
        quantity: linkedInventoryQuantity * optionMultiplier,
        source: 'option',
        parentItemName,
        optionName,
        optionGroupName,
      });
    }

    const optionRecipe = Array.isArray(option?.recipe) ? option.recipe : [];
    optionRecipe.forEach((recipeItem: any) => {
      const ingredientId = getRecipeIngredientId(recipeItem);
      const ingredientQuantity = toPositiveNumber(recipeItem?.quantity);
      if (!ingredientId || ingredientQuantity <= 0) {
        return;
      }

      movements.push({
        itemId: ingredientId,
        name: getRecipeIngredientName(recipeItem),
        quantity: ingredientQuantity * optionMultiplier,
        source: 'option',
        parentItemName,
        optionName,
        optionGroupName,
      });
    });

    return movements;
  });
};

export const buildStockTrackingInventoryLookup = (
  inventoryItems: InventoryItem[] = []
): StockTrackingInventoryLookup => {
  const byId = new Map<string, InventoryItem>();
  const byName = new Map<string, InventoryItem>();

  inventoryItems.forEach((item) => {
    const id = String(item?.id ?? '').trim();
    if (id) {
      byId.set(id, item);
    }

    const normalizedName = normalizeName(item?.name);
    if (normalizedName && !byName.has(normalizedName)) {
      byName.set(normalizedName, item);
    }
  });

  return { byId, byName };
};

export const resolveInventoryItemForOrderLine = (
  orderItem: any,
  lookup: StockTrackingInventoryLookup
): InventoryItem | undefined => {
  const inventoryId = getOrderItemInventoryId(orderItem);
  if (inventoryId) {
    const byId = lookup.byId.get(inventoryId);
    if (byId) {
      return byId;
    }
  }

  const normalizedName = normalizeName(orderItem?.name);
  return normalizedName ? lookup.byName.get(normalizedName) : undefined;
};

export const getSoldOrderStockMovements = (
  orderItem: any,
  lookup: StockTrackingInventoryLookup
): SoldOrderStockMovement[] => {
  const soldQuantity = toPositiveNumber(orderItem?.quantity);
  if (soldQuantity <= 0) {
    return [];
  }

  const inventoryItem = resolveInventoryItemForOrderLine(orderItem, lookup);
  const recipeEntries = Array.isArray(inventoryItem?.recipe)
    ? inventoryItem.recipe
    : (Array.isArray(orderItem?.recipe) ? orderItem.recipe : []);
  const optionMovements = getSelectedOptionMovements(orderItem, soldQuantity);

  if (recipeEntries.length > 0) {
    const movements = recipeEntries
      .map((recipeItem: any): SoldOrderStockMovement | null => {
        const ingredientId = getRecipeIngredientId(recipeItem);
        const ingredientQuantity = toPositiveNumber(recipeItem?.quantity);
        if (!ingredientId || ingredientQuantity <= 0) {
          return null;
        }

        return {
          itemId: ingredientId,
          name: getRecipeIngredientName(recipeItem),
          quantity: ingredientQuantity * soldQuantity,
          source: 'recipe',
          parentItemName: String(orderItem?.name ?? '').trim() || undefined,
        };
      })
      .filter((movement): movement is SoldOrderStockMovement => movement !== null);

    if (movements.length > 0) {
      return [...movements, ...optionMovements];
    }
  }

  return [{
    itemId: getOrderItemInventoryId(orderItem),
    name: String(orderItem?.name ?? '').trim() || undefined,
    quantity: soldQuantity,
    source: 'direct',
  }, ...optionMovements];
};
