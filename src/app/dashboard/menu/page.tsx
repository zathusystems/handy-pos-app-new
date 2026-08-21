
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type InventoryItem } from '@/lib/db';
import { authFetch } from '@/lib/auth-fetch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PlusCircle, Utensils, QrCode, Copy, Loader2, Upload, X, Download, Settings, Save, Palette, Pencil, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Image from 'next/image';
import { useToast } from '@/hooks/use-toast';
import { useCurrency } from '@/hooks/use-currency';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { syncService } from '@/lib/services/sync-service';
import { MenuTemplates } from '@/components/menu/menu-templates';
import { QRCodeTemplates } from '@/components/menu/qr-code-templates';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';

const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch'
};

const getBackendBranchId = (branchId: string | null): number | null => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return null;

  const branchIdMatch = normalized.match(/\d+/);
  const parsed = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(normalized, 10);

  return Number.isFinite(parsed) ? parsed : null;
};

const getBranchIdCandidates = (branchId: string | null): string[] => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return [];

  const candidates = new Set<string>([normalized]);
  const backendId = getBackendBranchId(normalized);
  if (backendId !== null) {
    candidates.add(String(backendId));
    candidates.add(`BRN-${backendId}`);
    candidates.add(`branch-${backendId}`);
  }

  return Array.from(candidates);
};

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://api.handypos.online/api').replace(/\/$/, '');
const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');

const firstNonEmpty = (...values: Array<unknown>): string | undefined => {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return undefined;
};

const toNumber = (...values: Array<unknown>): number | undefined => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const isMenuItemVisible = (item: Pick<InventoryItem, 'menuIsVisible'>): boolean => item.menuIsVisible !== false;

const getMenuEntryInventoryId = (entry: any): string => String(
  entry?.inventory_item ??
  entry?.inventory_item_id ??
  entry?.item_details?.id ??
  ''
).trim();

const getMenuEntryId = (entry: any): string => String(entry?.id ?? entry?.menu_id ?? '').trim();

const resolveMenuItemImageSrc = (image?: string | null): string | null => {
  const value = String(image ?? '').trim();
  if (!value) return null;
  if (/^(data:|blob:|https?:\/\/)/i.test(value)) return value;
  if (value.startsWith('/')) return `${API_ORIGIN}${value}`;
  if (value.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return `data:image/jpeg;base64,${value.replace(/\s/g, '')}`;
  }
  return value;
};

const buildMenuInventoryItem = (
  entry: any,
  localItem: InventoryItem | undefined,
  branchId: string
): InventoryItem | null => {
  const details = entry?.item_details || {};
  const prepared = Boolean(entry?.is_prepared_item ?? entry?.isPreparedMenuItem) || !getMenuEntryInventoryId(entry);
  const menuEntryId = getMenuEntryId(entry);
  const id = prepared
    ? firstNonEmpty(menuEntryId, localItem?.id)
    : firstNonEmpty(localItem?.id, details.id, entry?.inventory_item, entry?.inventory_item_id);
  if (!id) return null;

  const rawItemType = String(
    details.item_type ??
    details.itemType ??
    localItem?.itemType ??
    'sellable'
  ).trim().toLowerCase();

  const image = localItem?._dirty && hasOwn(localItem, 'image')
    ? localItem.image
    : firstNonEmpty(localItem?.image, details.image);

  return {
    ...(localItem || {}),
    id,
    branchId: localItem?.branchId || branchId,
    name: firstNonEmpty(prepared ? entry?.name : undefined, details.name, localItem?.name, entry?.item_name) || 'Unnamed Item',
    category: firstNonEmpty(prepared ? entry?.category : undefined, details.category, localItem?.category) || '',
    itemType: rawItemType === 'ingredient' ? 'ingredient' : 'sellable',
    stockUnits: toNumber(details.stock_units, details.stockUnits, localItem?.stockUnits),
    unitType: firstNonEmpty(details.unit_type, details.unitType, localItem?.unitType),
    reorderLevel: toNumber(details.reorder_level, details.reorderLevel, localItem?.reorderLevel),
    cost: toNumber(details.cost, localItem?.cost),
    price: toNumber(prepared ? entry?.price : undefined, details.price, localItem?.price),
    value: toNumber(details.value, localItem?.value),
    status: details.status ?? localItem?.status,
    supplier: firstNonEmpty(details.supplier, localItem?.supplier),
    manufacturer: firstNonEmpty(details.manufacturer, localItem?.manufacturer),
    batch: firstNonEmpty(details.batch, localItem?.batch),
    brand: firstNonEmpty(details.brand, localItem?.brand),
    productCode: firstNonEmpty(details.product_code, details.productCode, localItem?.productCode),
    barcode: firstNonEmpty(details.barcode, localItem?.barcode),
    sku: firstNonEmpty(details.sku, localItem?.sku),
    expiry: firstNonEmpty(details.expiry, localItem?.expiry),
    recipe: Array.isArray(prepared ? entry?.recipe : details.recipe)
      ? (prepared ? entry.recipe : details.recipe)
      : localItem?.recipe,
    description: firstNonEmpty(entry?.description, localItem?.description),
    isPreparedMenuItem: prepared,
    is_prepared_menu_item: prepared,
    menuItemId: menuEntryId || localItem?.menuItemId,
    menu_item_id: menuEntryId || localItem?.menu_item_id,
    onMenu: true,
    menuEntryId: firstNonEmpty(entry?.id, localItem?.menuEntryId),
    menuIsVisible: hasOwn(entry || {}, 'is_visible')
      ? Boolean(entry.is_visible)
      : hasOwn(entry || {}, 'isVisible')
        ? Boolean(entry.isVisible)
        : localItem?.menuIsVisible !== false,
    image: prepared ? firstNonEmpty(entry?.image, image) : image,
  };
};

type MenuOption = {
  id: string;
  group: string;
  name: string;
  description?: string;
  price_mode?: 'delta' | 'override';
  price_delta?: number | string;
  price_override?: number | string | null;
  recipe?: Array<Record<string, unknown>>;
  linked_inventory_item?: string | null;
  linked_inventory_item_name?: string;
  linked_inventory_quantity?: number | string;
  is_default?: boolean;
  is_visible?: boolean;
};

type OptionRecipeRow = {
  ingredientId: string;
  quantity: string;
};

type MenuOptionGroup = {
  id: string;
  menu: string;
  name: string;
  group_type: 'option' | 'side' | 'addon';
  is_required: boolean;
  min_select: number;
  max_select: number;
  options: MenuOption[];
};

const MenuOptionsModal = ({
  item,
  activeBranchId,
  open,
  onOpenChange,
}: {
  item: InventoryItem | null;
  activeBranchId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { toast } = useToast();
  const [groups, setGroups] = useState<MenuOptionGroup[]>([]);
  const [stockItems, setStockItems] = useState<InventoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupType, setGroupType] = useState<'option' | 'side' | 'addon'>('side');
  const [groupRequired, setGroupRequired] = useState(false);
  const [groupMinSelect, setGroupMinSelect] = useState('0');
  const [groupMaxSelect, setGroupMaxSelect] = useState('3');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [optionGroupId, setOptionGroupId] = useState('');
  const [optionName, setOptionName] = useState('');
  const [optionDescription, setOptionDescription] = useState('');
  const [optionPriceMode, setOptionPriceMode] = useState<'delta' | 'override'>('delta');
  const [optionPrice, setOptionPrice] = useState('0');
  const [optionPriceOverride, setOptionPriceOverride] = useState('');
  const [optionDefault, setOptionDefault] = useState(false);
  const [optionVisible, setOptionVisible] = useState(true);
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [recipeRows, setRecipeRows] = useState<OptionRecipeRow[]>([
    { ingredientId: 'none', quantity: '' },
  ]);
  const [resolvedMenuEntryId, setResolvedMenuEntryId] = useState('');

  const menuEntryId = String(resolvedMenuEntryId || item?.menuEntryId || item?.menuItemId || item?.menu_item_id || '').trim();
  const canManageOptions = Boolean(menuEntryId);

  const getGroupTypeLabel = (type: MenuOptionGroup['group_type']) => {
    if (type === 'side') return 'Side choices';
    if (type === 'addon') return 'Add-ons';
    return 'Main options';
  };

  const resolveMenuEntryId = async (): Promise<string> => {
    const existingMenuEntryId = String(item?.menuEntryId || item?.menuItemId || item?.menu_item_id || '').trim();
    if (!item || !activeBranchId) return existingMenuEntryId;

    const branchIdInt = getBackendBranchId(activeBranchId);
    if (branchIdInt === null) return existingMenuEntryId;

    const response = await authFetch.fetch<any>(`/digital-menu/menu/by_branch/?branch_id=${branchIdInt}`);
    const rows: any[] = Array.isArray(response) ? response : response?.results || [];
    const itemId = String(item.id);
    const matchedEntry = rows.find((entry) => {
      const entryId = String(entry?.id || entry?.menu_id || '').trim();
      const inventoryItemId = getMenuEntryInventoryId(entry);
      return entryId === existingMenuEntryId || inventoryItemId === itemId || (!inventoryItemId && entryId === itemId);
    });

    const resolvedId = String(matchedEntry?.id || matchedEntry?.menu_id || existingMenuEntryId || '').trim();
    if (resolvedId && resolvedId !== existingMenuEntryId) {
      setResolvedMenuEntryId(resolvedId);
      await db.inventory.update(item.id, {
        menuEntryId: resolvedId,
        menuItemId: resolvedId,
        menu_item_id: resolvedId,
      });
    } else {
      setResolvedMenuEntryId(resolvedId);
    }
    return resolvedId;
  };

  const loadOptions = async () => {
    setIsLoading(true);
    let entryId = menuEntryId;
    try {
      entryId = entryId || await resolveMenuEntryId();
    } catch (error) {
      console.error('[Menu] Failed to resolve menu entry before loading options:', error);
    }

    if (!entryId) {
      setGroups([]);
      toast({
        title: 'Menu item needs to sync first',
        description: 'Save or sync this menu item before adding sides and options.',
        variant: 'destructive',
      });
      setIsLoading(false);
      return;
    }

    try {
      const response = await authFetch.fetch<any>(`/digital-menu/menu-option-groups/?menu_id=${encodeURIComponent(entryId)}`);
      const rows = Array.isArray(response) ? response : response?.results || [];
      setGroups(rows);
      if (!optionGroupId && rows[0]?.id) setOptionGroupId(rows[0].id);
    } catch (error) {
      console.error('[Menu] Failed to load menu options:', error);
      toast({
        title: 'Could not load sides and options',
        description: error instanceof Error ? error.message : 'Please try again after syncing your menu.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !item) return;
    setResolvedMenuEntryId(String(item?.menuEntryId || item?.menuItemId || item?.menu_item_id || '').trim());
    loadOptions();
  }, [open, item?.id]);

  useEffect(() => {
    const loadStockItems = async () => {
      if (!open || !activeBranchId) return;
      const branchCandidates = getBranchIdCandidates(activeBranchId);
      const rows = await db.inventory.where('branchId').anyOf(branchCandidates).toArray();
      setStockItems(rows);
    };
    loadStockItems();
  }, [open, activeBranchId]);

  useEffect(() => {
    if (groupType === 'option') {
      setGroupMaxSelect('1');
    } else if (!editingGroupId && groupMaxSelect === '1') {
      setGroupMaxSelect('3');
    }
  }, [groupType, editingGroupId, groupMaxSelect]);

  const resetGroupForm = () => {
    setEditingGroupId(null);
    setGroupName('');
    setGroupType('side');
    setGroupRequired(false);
    setGroupMinSelect('0');
    setGroupMaxSelect('3');
  };

  const resetOptionForm = () => {
    setEditingOptionId(null);
    setOptionName('');
    setOptionDescription('');
    setOptionPriceMode('delta');
    setOptionPrice('0');
    setOptionPriceOverride('');
    setOptionDefault(false);
    setOptionVisible(true);
    setRecipeRows([{ ingredientId: 'none', quantity: '' }]);
  };

  const getStockItemName = (stockItemId: string) => (
    stockItems.find((stockItem) => String(stockItem.id) === String(stockItemId))?.name || ''
  );

  const buildRecipePayload = () => (
    recipeRows
      .map((row) => {
        const ingredientId = row.ingredientId === 'none' ? '' : row.ingredientId;
        const quantity = Number(row.quantity || 0);
        if (!ingredientId || !Number.isFinite(quantity) || quantity <= 0) return null;
        return {
          ingredientId,
          name: getStockItemName(ingredientId),
          quantity,
        };
      })
      .filter(Boolean)
  );

  const loadGroupForEdit = (group: MenuOptionGroup) => {
    setEditingGroupId(group.id);
    setGroupName(group.name);
    setGroupType(group.group_type);
    setGroupRequired(Boolean(group.is_required));
    setGroupMinSelect(String(group.min_select ?? 0));
    setGroupMaxSelect(String(group.max_select ?? 1));
  };

  const loadOptionForEdit = (option: MenuOption) => {
    setEditingOptionId(option.id);
    setOptionGroupId(option.group);
    setOptionName(option.name);
    setOptionDescription(option.description || '');
    setOptionPriceMode(option.price_mode || 'delta');
    setOptionPrice(String(option.price_delta ?? 0));
    setOptionPriceOverride(option.price_override === null || option.price_override === undefined ? '' : String(option.price_override));
    setOptionDefault(Boolean(option.is_default));
    setOptionVisible(option.is_visible !== false);
    const recipe = Array.isArray(option.recipe) ? option.recipe : [];
    const rows = recipe
      .map((entry: any) => ({
        ingredientId: String(entry?.ingredientId ?? entry?.ingredient_id ?? entry?.inventoryItemId ?? entry?.inventory_item_id ?? entry?.id ?? 'none'),
        quantity: String(entry?.quantity ?? ''),
      }))
      .filter((row) => row.ingredientId && row.ingredientId !== 'none');
    setRecipeRows(rows.length > 0 ? rows : [{ ingredientId: 'none', quantity: '' }]);
  };

  const saveGroup = async () => {
    let entryId = menuEntryId;
    try {
      entryId = entryId || await resolveMenuEntryId();
    } catch (error) {
      console.error('[Menu] Failed to resolve menu item before saving group:', error);
    }

    if (!entryId) {
      toast({ title: 'Save this item to the menu first', variant: 'destructive' });
      return;
    }
    if (!groupName.trim()) {
      toast({ title: 'Enter a group name', variant: 'destructive' });
      return;
    }
    const minSelect = Math.max(0, Number(groupMinSelect || 0));
    const maxSelect = Math.max(groupType === 'option' ? 1 : 1, Number(groupMaxSelect || 0));
    if (maxSelect > 0 && minSelect > maxSelect) {
      toast({ title: 'Minimum choices cannot be greater than maximum choices', variant: 'destructive' });
      return;
    }
    try {
      const endpoint = editingGroupId
        ? `/digital-menu/menu-option-groups/${editingGroupId}/`
        : '/digital-menu/menu-option-groups/';
      const saved = await authFetch.fetch<MenuOptionGroup>(endpoint, {
        method: editingGroupId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          menu: entryId,
          name: groupName.trim(),
          group_type: groupType,
          is_required: groupRequired,
          min_select: groupRequired ? Math.max(1, minSelect) : minSelect,
          max_select: maxSelect,
        }),
      });
      setResolvedMenuEntryId(entryId);
      setOptionGroupId(saved.id);
      resetGroupForm();
      await loadOptions();
      toast({ title: editingGroupId ? 'Choice set updated' : 'Choice set added' });
    } catch (error) {
      console.error('[Menu] Failed to save choice set:', error);
      toast({
        title: editingGroupId ? 'Could not update choice set' : 'Could not add choice set',
        description: error instanceof Error ? error.message : 'Please try again after syncing your menu.',
        variant: 'destructive',
      });
    }
  };

  const deleteGroup = async (group: MenuOptionGroup) => {
    try {
      await authFetch.fetch(`/digital-menu/menu-option-groups/${group.id}/`, {
        method: 'DELETE',
      });
      if (optionGroupId === group.id) setOptionGroupId('');
      if (editingGroupId === group.id) resetGroupForm();
      await loadOptions();
      toast({ title: 'Choice set deleted' });
    } catch (error) {
      console.error('[Menu] Failed to delete choice set:', error);
      toast({
        title: 'Could not delete choice set',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  };

  const saveOption = async () => {
    if (!optionGroupId || !optionName.trim()) {
      toast({ title: 'Choose a group and enter an option name', variant: 'destructive' });
      return;
    }
    const recipe = buildRecipePayload();
    const firstRecipeRow = recipe[0] as { ingredientId?: string; quantity?: number } | undefined;
    try {
      const endpoint = editingOptionId
        ? `/digital-menu/menu-options/${editingOptionId}/`
        : '/digital-menu/menu-options/';
      await authFetch.fetch(endpoint, {
        method: editingOptionId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          group: optionGroupId,
          name: optionName.trim(),
          description: optionDescription.trim(),
          price_mode: optionPriceMode,
          price_delta: Number(optionPrice || 0),
          price_override: optionPriceMode === 'override' && optionPriceOverride !== '' ? Number(optionPriceOverride) : null,
          linked_inventory_item: firstRecipeRow?.ingredientId || null,
          linked_inventory_quantity: firstRecipeRow?.quantity || 0,
          recipe,
          is_default: optionDefault,
          is_visible: optionVisible,
        }),
      });
      resetOptionForm();
      await loadOptions();
      toast({ title: editingOptionId ? 'Choice updated' : 'Choice added' });
    } catch (error) {
      console.error('[Menu] Failed to save choice:', error);
      toast({
        title: editingOptionId ? 'Could not update choice' : 'Could not add choice',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  };

  const deleteOption = async (option: MenuOption) => {
    try {
      await authFetch.fetch(`/digital-menu/menu-options/${option.id}/`, {
        method: 'DELETE',
      });
      if (editingOptionId === option.id) resetOptionForm();
      await loadOptions();
      toast({ title: 'Choice deleted' });
    } catch (error) {
      console.error('[Menu] Failed to delete choice:', error);
      toast({
        title: 'Could not delete choice',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choices for {item?.name || 'menu item'}</DialogTitle>
          <DialogDescription>
            Add sides, sizes, sauces, or extras customers can choose from. Stock deduction is optional for each choice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!canManageOptions && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              This item is not linked to a saved menu record yet. Sync the menu first, then come back to add choices.
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">1. Choice set</CardTitle>
              <CardDescription>Example: Choose a side, Pick a size, Add extras.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Set name</Label>
                <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
                  <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Choose a side" />
                  <Select value={groupType} onValueChange={(value) => setGroupType(value as 'option' | 'side' | 'addon')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="side">Side choices</SelectItem>
                      <SelectItem value="option">Main options</SelectItem>
                      <SelectItem value="addon">Add-ons</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
                <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <Switch checked={groupRequired} onCheckedChange={setGroupRequired} />
                  <span className="text-sm">Customer must choose</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Minimum</Label>
                  <Input value={groupMinSelect} onChange={(e) => setGroupMinSelect(e.target.value)} type="number" min="0" step="1" />
                </div>
                <div className="space-y-1.5">
                  <Label>Maximum</Label>
                  <Input value={groupMaxSelect} onChange={(e) => setGroupMaxSelect(e.target.value)} type="number" min="1" step="1" />
                </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                {editingGroupId && (
                  <Button variant="outline" onClick={resetGroupForm}>Cancel</Button>
                )}
                <Button onClick={saveGroup} disabled={!canManageOptions}>{editingGroupId ? 'Save set' : 'Add set'}</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Choice</CardTitle>
              <CardDescription>Add the actual side, size, sauce, or extra under a choice set.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Belongs to</Label>
                <Select value={optionGroupId} onValueChange={setOptionGroupId}>
                  <SelectTrigger><SelectValue placeholder="Choose a choice set first" /></SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Choice name</Label>
                  <Input value={optionName} onChange={(e) => setOptionName(e.target.value)} placeholder="Chips" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Short note</Label>
                  <Input value={optionDescription} onChange={(e) => setOptionDescription(e.target.value)} placeholder="Optional" />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[190px_1fr]">
                <Select value={optionPriceMode} onValueChange={(value) => setOptionPriceMode(value as 'delta' | 'override')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delta">Extra charge</SelectItem>
                    <SelectItem value="override">Final item price</SelectItem>
                  </SelectContent>
                </Select>
                {optionPriceMode === 'delta' ? (
                  <Input value={optionPrice} onChange={(e) => setOptionPrice(e.target.value)} type="number" step="0.01" placeholder="0.00 if free" />
                ) : (
                  <Input value={optionPriceOverride} onChange={(e) => setOptionPriceOverride(e.target.value)} type="number" step="0.01" placeholder="Total price when selected" />
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-sm">Selected by default</span>
                  <Switch checked={optionDefault} onCheckedChange={setOptionDefault} />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-sm">Visible to customers</span>
                  <Switch checked={optionVisible} onCheckedChange={setOptionVisible} />
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Stock deducted when selected</p>
                    <p className="text-xs text-muted-foreground">Optional. Use this when a side or extra consumes stock separately.</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRecipeRows((rows) => [...rows, { ingredientId: 'none', quantity: '' }])}
                  >
                    Add row
                  </Button>
                </div>
                <div className="grid gap-2">
                  {recipeRows.map((row, index) => (
                    <div key={index} className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
                      <Select
                        value={row.ingredientId}
                        onValueChange={(value) => setRecipeRows((rows) => rows.map((current, rowIndex) => (
                          rowIndex === index ? { ...current, ingredientId: value } : current
                        )))}
                      >
                        <SelectTrigger><SelectValue placeholder="Choose ingredient" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No ingredient</SelectItem>
                          {stockItems.map((stockItem) => (
                            <SelectItem key={stockItem.id} value={stockItem.id}>{stockItem.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={row.quantity}
                        onChange={(e) => setRecipeRows((rows) => rows.map((current, rowIndex) => (
                          rowIndex === index ? { ...current, quantity: e.target.value } : current
                        )))}
                        type="number"
                        step="0.001"
                        placeholder="Qty"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setRecipeRows((rows) => rows.length === 1
                          ? [{ ingredientId: 'none', quantity: '' }]
                          : rows.filter((_, rowIndex) => rowIndex !== index))}
                        aria-label="Remove recipe row"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {editingOptionId && (
                  <Button variant="outline" onClick={resetOptionForm}>Cancel</Button>
                )}
                <Button onClick={saveOption} disabled={groups.length === 0}>
                  {editingOptionId ? 'Save choice' : 'Add choice'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading options...
              </div>
            ) : groups.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No options yet. Add a group first, then add choices under it.
              </p>
            ) : groups.map((group) => (
              <div key={group.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{group.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {getGroupTypeLabel(group.group_type)} / {group.is_required ? 'required' : 'optional'} / choose {group.min_select}-{group.max_select}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{group.options.length} options</Badge>
                    <Button variant="ghost" size="icon" onClick={() => loadGroupForEdit(group)} aria-label={`Edit ${group.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteGroup(group)} aria-label={`Delete ${group.name}`}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2">
                  {group.options.map((option) => (
                    <div key={option.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{option.name}</span>
                            {option.is_default && <Badge variant="secondary">Default</Badge>}
                            {option.is_visible === false && <Badge variant="outline">Hidden</Badge>}
                          </div>
                          {option.description && (
                            <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
                          )}
                          {Array.isArray(option.recipe) && option.recipe.length > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Uses {option.recipe.map((entry: any) => {
                                const quantity = Number(entry?.quantity || 0);
                                const name = String(entry?.name || getStockItemName(String(entry?.ingredientId || entry?.ingredient_id || entry?.id || '')) || 'ingredient');
                                return `${quantity} ${name}`;
                              }).join(', ')}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="text-xs text-muted-foreground">
                            {option.price_mode === 'override'
                              ? `Set ${Number(option.price_override || 0).toFixed(2)}`
                              : `+${Number(option.price_delta || 0).toFixed(2)}`}
                          </span>
                          <Button variant="ghost" size="icon" onClick={() => loadOptionForEdit(option)} aria-label={`Edit ${option.name}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => deleteOption(option)} aria-label={`Delete ${option.name}`}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {group.options.length === 0 && (
                    <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      No options in this group yet.
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const MenuItemCard = ({
  item,
  onItemUpdated,
  onVisibilityChange,
  onManageOptions,
  onDelete,
}: {
  item: InventoryItem;
  onItemUpdated: (itemId: string, updates: Partial<InventoryItem>) => void;
  onVisibilityChange: (item: InventoryItem, isVisible: boolean) => void;
  onManageOptions: (item: InventoryItem) => void;
  onDelete: (item: InventoryItem) => void;
}) => {
  const [isEditingImage, setIsEditingImage] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageSrc = resolveMenuItemImageSrc(item.image);
  const visible = isMenuItemVisible(item);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Image = event.target?.result as string;
      await db.inventory.update(item.id, { image: base64Image, _dirty: true, _operation: 'update' });
      await syncService.markAsDirty('InventoryItem', item.id, 'update');
      onItemUpdated(item.id, { image: base64Image, _dirty: true, _operation: 'update' });
      setIsEditingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = async () => {
    await db.inventory.update(item.id, { image: '', _dirty: true, _operation: 'update' });
    await syncService.markAsDirty('InventoryItem', item.id, 'update');
    onItemUpdated(item.id, { image: '', _dirty: true, _operation: 'update' });
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    const confirmed = window.confirm(`Delete ${item.name} from the menu completely? This also removes its options and sides.`);
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await onDelete(item);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        {/* Image Section */}
        <div className="relative mb-2 flex h-40 items-center justify-center rounded-lg bg-muted">
          {imageSrc ? (
            <div className="relative h-full w-full">
              <img
                src={imageSrc}
                alt={item.name}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity hover:opacity-100">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleRemoveImage}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <Upload className="h-8 w-8" />
              <span className="text-xs">Add Image</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
          />
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Recommended image size: 1200 x 800 px, JPG or PNG under 2 MB.
        </p>

        {/* Item Info */}
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold">{item.name}</h3>
              <p className="text-sm text-muted-foreground">{item.category}</p>
            </div>
            <Badge variant={visible ? 'secondary' : 'outline'}>
              {visible ? 'Visible' : 'Hidden'}
            </Badge>
          </div>
          <Badge variant="secondary">${Number(item.price)?.toFixed(2) || '0.00'}</Badge>
        </div>

        <Separator className="my-3" />
        <Button
          variant="outline"
          size="sm"
          className="mb-3 w-full"
          onClick={() => onManageOptions(item)}
        >
          Manage options and sides
        </Button>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Show on customer menu</p>
            <p className="text-xs text-muted-foreground">
              Turn off to keep it saved here but hide it from QR ordering.
            </p>
          </div>
          <Switch
            checked={visible}
            onCheckedChange={(checked) => onVisibilityChange(item, checked)}
            aria-label={`Show ${item.name} on customer menu`}
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          className="mt-3 w-full"
          onClick={handleDelete}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-2 h-4 w-4" />
          )}
          Delete from menu
        </Button>
      </CardContent>
    </Card>
  );
};

const AddToMenuModal = ({
  isOpen,
  onOpenChange,
  availableItems,
  recipeItems,
  activeBranchId,
  onItemAdded,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  availableItems: InventoryItem[];
  recipeItems: InventoryItem[];
  activeBranchId: string | null;
  onItemAdded: (item: InventoryItem) => void;
}) => {
  const { toast } = useToast();
  const [preparedName, setPreparedName] = useState('');
  const [preparedCategory, setPreparedCategory] = useState('');
  const [preparedDescription, setPreparedDescription] = useState('');
  const [preparedPrice, setPreparedPrice] = useState('');
  const [preparedRecipeRows, setPreparedRecipeRows] = useState<OptionRecipeRow[]>([
    { ingredientId: 'none', quantity: '' },
  ]);
  const [isCreatingPrepared, setIsCreatingPrepared] = useState(false);
  
  // Filter out ingredient products - only allow sellable items
  const menuEligibleItems = useMemo(() => {
    return availableItems.filter(item => item.itemType === 'sellable');
  }, [availableItems]);

  const stockRecipeItems = useMemo(() => (
    recipeItems
      .filter((item) => item.itemType === 'ingredient' || item.itemType === 'sellable')
      .sort((a, b) => a.name.localeCompare(b.name))
  ), [recipeItems]);

  const buildPreparedRecipePayload = () => (
    preparedRecipeRows
      .map((row) => {
        const ingredient = stockRecipeItems.find((candidate) => candidate.id === row.ingredientId);
        const quantity = Number(row.quantity);
        if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) return null;
        return {
          ingredientId: ingredient.id,
          inventoryItemId: ingredient.id,
          inventory_item_id: ingredient.id,
          name: ingredient.name,
          quantity,
          unit: ingredient.unitType || ingredient.unit_type || 'unit',
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  );

  const resetPreparedForm = () => {
    setPreparedName('');
    setPreparedCategory('');
    setPreparedDescription('');
    setPreparedPrice('');
    setPreparedRecipeRows([{ ingredientId: 'none', quantity: '' }]);
  };

  const handleCreatePreparedItem = async () => {
    const name = preparedName.trim();
    const price = Number(preparedPrice);
    const recipe = buildPreparedRecipePayload();

    if (!name) {
      toast({ variant: 'destructive', title: 'Name required', description: 'Enter the menu item name.' });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      toast({ variant: 'destructive', title: 'Invalid price', description: 'Enter a valid selling price.' });
      return;
    }
    if (recipe.length === 0) {
      toast({ variant: 'destructive', title: 'Recipe required', description: 'Add at least one inventory ingredient.' });
      return;
    }
    if (!activeBranchId) {
      toast({ variant: 'destructive', title: 'No branch selected' });
      return;
    }

    const branchIdInt = getBackendBranchId(activeBranchId);
    if (branchIdInt === null) {
      toast({ variant: 'destructive', title: 'Invalid branch selected' });
      return;
    }

    setIsCreatingPrepared(true);
    try {
      const response = await authFetch.fetch<any>('/digital-menu/menu/create_prepared_item/', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: branchIdInt,
          name,
          category: preparedCategory.trim(),
          description: preparedDescription.trim(),
          price,
          recipe,
          is_visible: true,
        }),
      });

      const preparedItem = buildMenuInventoryItem(response, undefined, activeBranchId);
      if (preparedItem) {
        onItemAdded(preparedItem);
      }
      resetPreparedForm();
      toast({
        title: 'Prepared item created',
        description: `${name} was added to the menu.`,
      });
    } catch (error) {
      console.error('[Menu] Error creating prepared menu item:', error);
      toast({
        variant: 'destructive',
        title: 'Could not create menu item',
        description: error instanceof Error ? error.message : 'Failed to create prepared menu item',
      });
    } finally {
      setIsCreatingPrepared(false);
    }
  };
  
  const handleAddToMenu = async (item: InventoryItem) => {
    try {
      // Save to local database
      await db.inventory.update(item.id, { onMenu: true, menuIsVisible: true, _dirty: true, _operation: 'update' });
      await syncService.markAsDirty('InventoryItem', item.id, 'update');
      let menuEntryUpdates: Partial<InventoryItem> = { menuIsVisible: true };
      
      // Save to backend
      if (activeBranchId) {
        const branchIdInt = getBackendBranchId(activeBranchId);
        if (branchIdInt === null) {
          throw new Error('Invalid branch selected');
        }
        
        const response = await authFetch.fetch<any>('/digital-menu/menu/add_item/', {
          method: 'POST',
          body: JSON.stringify({
            branch_id: branchIdInt,
            inventory_item_id: item.id,
          }),
        });
        menuEntryUpdates = {
          menuEntryId: firstNonEmpty(response?.id, item.menuEntryId),
          menuIsVisible: response?.is_visible !== undefined ? Boolean(response.is_visible) : true,
        };
        console.log('[Menu] Item added to backend menu:', item.id);
      }
      
      toast({
        title: 'Success',
        description: `${item.name} added to menu`,
      });
      onItemAdded({ ...item, ...menuEntryUpdates, onMenu: true });
    } catch (error) {
      console.error('[Menu] Error adding item to menu:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to add item to menu',
      });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Items to Menu</DialogTitle>
          <DialogDescription>
            Add purchased sellables from inventory, or create prepared menu items with recipes from inventory ingredients.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="inventory" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inventory">Inventory Items</TabsTrigger>
            <TabsTrigger value="prepared">Prepared Item</TabsTrigger>
          </TabsList>

          <TabsContent value="inventory" className="max-h-[60vh] overflow-y-auto space-y-3 p-1">
            {menuEligibleItems.length > 0 ? (
              menuEligibleItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-4 rounded-lg border p-3"
                >
                  <div className="flex-1">
                    <p className="font-semibold">{item.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {item.category}
                    </p>
                  </div>
                  <Badge variant="outline">${Number(item.price)?.toFixed(2) || '0.00'}</Badge>
                  <Button size="sm" onClick={() => handleAddToMenu(item)}>
                    Add
                  </Button>
                </div>
              ))
            ) : (
              <p className="py-8 text-center text-muted-foreground">
                All sellable items are already on the menu.
              </p>
            )}
          </TabsContent>

          <TabsContent value="prepared" className="max-h-[65vh] overflow-y-auto space-y-4 p-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="prepared-name">Menu item name</Label>
                <Input id="prepared-name" value={preparedName} onChange={(event) => setPreparedName(event.target.value)} placeholder="Chicken and chips" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prepared-price">Selling price</Label>
                <Input id="prepared-price" type="number" min="0" step="0.01" value={preparedPrice} onChange={(event) => setPreparedPrice(event.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prepared-category">Category</Label>
                <Input id="prepared-category" value={preparedCategory} onChange={(event) => setPreparedCategory(event.target.value)} placeholder="Meals" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="prepared-description">Description</Label>
                <Textarea id="prepared-description" value={preparedDescription} onChange={(event) => setPreparedDescription(event.target.value)} placeholder="Optional customer-facing description" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Recipe from inventory</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPreparedRecipeRows((rows) => [...rows, { ingredientId: 'none', quantity: '' }])}
                >
                  Add ingredient
                </Button>
              </div>
              <div className="space-y-2">
                {preparedRecipeRows.map((row, index) => (
                  <div key={`prepared-recipe-${index}`} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                    <Select
                      value={row.ingredientId}
                      onValueChange={(value) => setPreparedRecipeRows((rows) => rows.map((current, rowIndex) => (
                        rowIndex === index ? { ...current, ingredientId: value } : current
                      )))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select ingredient" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Select ingredient</SelectItem>
                        {stockRecipeItems.map((ingredient) => (
                          <SelectItem key={ingredient.id} value={ingredient.id}>
                            {ingredient.name} ({ingredient.unitType || ingredient.unit_type || 'unit'})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="0"
                      step="0.001"
                      value={row.quantity}
                      onChange={(event) => setPreparedRecipeRows((rows) => rows.map((current, rowIndex) => (
                        rowIndex === index ? { ...current, quantity: event.target.value } : current
                      )))}
                      placeholder="Qty"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setPreparedRecipeRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}
                      disabled={preparedRecipeRows.length <= 1}
                      aria-label="Remove ingredient"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <Button className="w-full" onClick={handleCreatePreparedItem} disabled={isCreatingPrepared}>
              {isCreatingPrepared && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Prepared Menu Item
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

const ShareMenuModal = ({
  isOpen,
  onOpenChange,
  publicMenuUrl,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  publicMenuUrl: string;
}) => {
  const { toast } = useToast();
  const [qrCodeUrl, setQrCodeUrl] = useState('');

  useEffect(() => {
    if (publicMenuUrl) {
      setQrCodeUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(publicMenuUrl)}`);
    }
  }, [publicMenuUrl]);

  const handleCopy = () => {
    navigator.clipboard.writeText(publicMenuUrl);
    toast({
      title: 'Copied to clipboard!',
      description: 'The public menu URL has been copied.',
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share Your Public Menu</DialogTitle>
          <DialogDescription>
            Let customers view your menu by scanning the QR code or using the
            link.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center gap-4 py-4">
          <div className="rounded-lg border p-4">
            {qrCodeUrl && (
              <Image
                src={qrCodeUrl}
                alt="Menu QR Code"
                width={200}
                height={200}
              />
            )}
          </div>
          <div className="relative w-full">
            <Input value={publicMenuUrl} readOnly />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
              onClick={handleCopy}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

interface MenuConfig {
  displayName: string;
  description: string;
  tagline: string;
  theme: 'light' | 'dark' | 'auto';
  primaryColor: string;
  accentColor: string;
  showPrices: boolean;
  showCategories: boolean;
  showImages: boolean;
  showBrandInfo: boolean;
  showContactInfo: boolean;
  itemsPerRow: 'auto' | '2' | '3' | '4';
  currency: string;
  businessLogo?: string;
  businessBanner?: string;
  footerText: string;
  enableSearch: boolean;
  enableFilters: boolean;
  enableSorting: boolean;
  acceptOrders: boolean;
}

const DEFAULT_CONFIG: MenuConfig = {
  displayName: 'Our Menu',
  description: 'Welcome to our restaurant',
  tagline: 'Fresh & Delicious',
  theme: 'auto',
  primaryColor: '#263b57',
  accentColor: '#236dd5',
  showPrices: true,
  showCategories: true,
  showImages: true,
  showBrandInfo: true,
  showContactInfo: true,
  itemsPerRow: '3',
  currency: 'MWK',
  footerText: 'Thank you for your visit!',
  enableSearch: true,
  enableFilters: true,
  enableSorting: true,
  acceptOrders: true,
};

const MENU_COLOR_PRESETS = [
  '#263B57',
  '#236DD5',
  '#0F766E',
  '#16A34A',
  '#DC2626',
  '#EA580C',
  '#7C3AED',
  '#111827',
];

const normalizeHexColor = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9A-Fa-f]{6}$/.test(withHash) ? withHash.toUpperCase() : fallback;
};

const hexToRgb = (value: string): { r: number; g: number; b: number } => {
  const normalized = normalizeHexColor(value, '#000000').replace('#', '');
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
};

const rgbToHue = ({ r, g, b }: { r: number; g: number; b: number }): number => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  if (delta === 0) return 0;
  const hue = max === red
    ? 60 * (((green - blue) / delta) % 6)
    : max === green
      ? 60 * ((blue - red) / delta + 2)
      : 60 * ((red - green) / delta + 4);

  return ((Math.round(hue) % 360) + 360) % 360;
};

const hueToHex = (hue: number): string => {
  const normalizedHue = ((Math.round(hue) % 360) + 360) % 360;
  const c = 1;
  const x = c * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const m = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (normalizedHue < 60) {
    red = c; green = x; blue = 0;
  } else if (normalizedHue < 120) {
    red = x; green = c; blue = 0;
  } else if (normalizedHue < 180) {
    red = 0; green = c; blue = x;
  } else if (normalizedHue < 240) {
    red = 0; green = x; blue = c;
  } else if (normalizedHue < 300) {
    red = x; green = 0; blue = c;
  } else {
    red = c; green = 0; blue = x;
  }

  const toHex = (channel: number) => Math.round((channel + m) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
};

const ColorSetting = ({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const [draftValue, setDraftValue] = useState(value.toUpperCase());
  const hueValue = rgbToHue(hexToRgb(value));

  useEffect(() => {
    setDraftValue(value.toUpperCase());
  }, [value]);

  const commitDraftValue = () => {
    const nextValue = normalizeHexColor(draftValue, value);
    setDraftValue(nextValue);
    onChange(nextValue);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
        <div className="flex flex-wrap gap-2">
          {MENU_COLOR_PRESETS.map((color) => {
            const isSelected = value.toUpperCase() === color;

            return (
              <button
                key={`${id}-${color}`}
                type="button"
                aria-label={`Use ${color}`}
                aria-pressed={isSelected}
                onClick={() => onChange(color)}
                className={`h-8 w-8 rounded-full border transition focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                  isSelected ? 'ring-2 ring-primary ring-offset-2' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <div className="h-9 w-12 rounded border" style={{ backgroundColor: value }} />
          <Input
            id={id}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onBlur={commitDraftValue}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraftValue();
              }
            }}
            placeholder="#236DD5"
            className="font-mono uppercase"
            maxLength={7}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Custom color</span>
            <span className="font-mono text-xs text-muted-foreground">{hueValue}deg</span>
          </div>
          <input
            type="range"
            min="0"
            max="359"
            value={hueValue}
            onChange={(e) => onChange(hueToHex(Number(e.target.value)))}
            className="h-3 w-full cursor-pointer appearance-none rounded-full border border-border/70 bg-transparent accent-primary"
            style={{
              background: 'linear-gradient(90deg,#ef4444,#f97316,#eab308,#22c55e,#06b6d4,#3b82f6,#8b5cf6,#ef4444)',
              accentColor: value,
            }}
            aria-label={`${label} hue`}
          />
        </div>
      </div>
    </div>
  );
};

const MenuConfigTab = ({ activeBranchId }: { activeBranchId: string | null }) => {
  const [config, setConfig] = useState<MenuConfig>(DEFAULT_CONFIG);
  const [editConfig, setEditConfig] = useState<MenuConfig>(DEFAULT_CONFIG);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [businessCurrency, setBusinessCurrency] = useState(DEFAULT_CONFIG.currency);
  const { toast } = useToast();
  const logoInputRef = React.useRef<HTMLInputElement>(null);
  const bannerInputRef = React.useRef<HTMLInputElement>(null);

  // Load business currency
  useEffect(() => {
    const loadBusinessCurrency = async () => {
      try {
        // Try to get from IndexedDB first
        const business = await db.business.get('main-business');
        if (business?.currency) {
          console.log('[MenuConfig] Business currency from IndexedDB:', business.currency);
          setBusinessCurrency(business.currency);
          return;
        }

        // Fallback: try to get all businesses and use the first one
        const allBusinesses = await db.business.toArray();
        if (allBusinesses.length > 0 && allBusinesses[0].currency) {
          console.log('[MenuConfig] Business currency from first business:', allBusinesses[0].currency);
          setBusinessCurrency(allBusinesses[0].currency);
          return;
        }

        // Fallback: check localStorage for business data
        const storedBusiness = localStorage.getItem('handypos-business');
        if (storedBusiness) {
          const parsed = JSON.parse(storedBusiness);
          if (parsed.currency) {
            console.log('[MenuConfig] Business currency from localStorage:', parsed.currency);
            setBusinessCurrency(parsed.currency);
            return;
          }
        }
      } catch (error) {
        console.error('[MenuConfig] Error loading business currency:', error);
      }
    };

    loadBusinessCurrency();
  }, []);

  // Load config from backend only
  useEffect(() => {
    const loadConfig = async () => {
      if (!activeBranchId) return;
      
      setIsLoading(true);
      try {
        const branchIdInt = getBackendBranchId(activeBranchId);
        if (branchIdInt === null) {
          throw new Error('Invalid branch selected');
        }
        console.log('[MenuConfig] Loading configuration from backend for branch:', branchIdInt);
        const data = await authFetch.fetch<any>(`/digital-menu/menu-config/by_branch/?branch_id=${branchIdInt}`);
        
        console.log('[MenuConfig] Configuration loaded from backend:', data);
        
        // Handle both single object and array responses
        const configData = Array.isArray(data) ? data[0] : data;
        
        if (!configData) {
          console.log('[MenuConfig] No configuration found, using defaults');
          const defaultConfig = { ...DEFAULT_CONFIG, currency: businessCurrency };
          setConfig(defaultConfig);
          setEditConfig(defaultConfig);
          setIsLoading(false);
          return;
        }
        
        // Map snake_case from backend to camelCase for frontend
        const mappedConfig = {
          displayName: configData.display_name || DEFAULT_CONFIG.displayName,
          description: configData.description || DEFAULT_CONFIG.description,
          tagline: configData.tagline || DEFAULT_CONFIG.tagline,
          theme: configData.theme || DEFAULT_CONFIG.theme,
          primaryColor: configData.primary_color || DEFAULT_CONFIG.primaryColor,
          accentColor: configData.accent_color || DEFAULT_CONFIG.accentColor,
          showPrices: configData.show_prices !== undefined ? configData.show_prices : DEFAULT_CONFIG.showPrices,
          showCategories: configData.show_categories !== undefined ? configData.show_categories : DEFAULT_CONFIG.showCategories,
          showImages: configData.show_images !== undefined ? configData.show_images : DEFAULT_CONFIG.showImages,
          showBrandInfo: configData.show_brand_info !== undefined ? configData.show_brand_info : DEFAULT_CONFIG.showBrandInfo,
          showContactInfo: configData.show_contact_info !== undefined ? configData.show_contact_info : DEFAULT_CONFIG.showContactInfo,
          itemsPerRow: configData.items_per_row || DEFAULT_CONFIG.itemsPerRow,
          currency: configData.currency || businessCurrency || DEFAULT_CONFIG.currency,
          businessLogo: configData.business_logo || undefined,
          businessBanner: configData.business_banner || undefined,
          footerText: configData.footer_text || DEFAULT_CONFIG.footerText,
          enableSearch: configData.enable_search !== undefined ? configData.enable_search : DEFAULT_CONFIG.enableSearch,
          enableFilters: configData.enable_filters !== undefined ? configData.enable_filters : DEFAULT_CONFIG.enableFilters,
          enableSorting: configData.enable_sorting !== undefined ? configData.enable_sorting : DEFAULT_CONFIG.enableSorting,
          acceptOrders: configData.accept_orders !== undefined ? configData.accept_orders : DEFAULT_CONFIG.acceptOrders,
        };
        setConfig(mappedConfig);
        setEditConfig(mappedConfig);
      } catch (error) {
        console.error('[MenuConfig] Error loading config from backend:', error);
        // No fallback - only use backend data
        const defaultConfig = { ...DEFAULT_CONFIG, currency: businessCurrency };
        setConfig(defaultConfig);
        setEditConfig(defaultConfig);
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, [activeBranchId]);

  const handleOpenEditModal = () => {
    // Set business currency as default if not already set
    const configWithDefault = {
      ...config,
      currency: businessCurrency || config.currency || DEFAULT_CONFIG.currency,
    };
    setEditConfig(configWithDefault);
    setIsEditModalOpen(true);
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    try {
      if (!activeBranchId) {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'No branch selected',
        });
        return;
      }

      console.log('[MenuConfig] Saving configuration to backend:', config);
      
      const responseData = await authFetch.fetch<any>('/digital-menu/menu-config/', {
        method: 'POST',
        body: JSON.stringify(config),
      });

      console.log('[MenuConfig] Configuration saved to backend:', responseData);

      toast({
        title: 'Success',
        description: 'Menu configuration saved successfully',
      });
    } catch (error) {
      console.error('[MenuConfig] Error saving config:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save menu configuration',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      setEditConfig(prev => ({ ...prev, businessLogo: base64 }));
      toast({ title: 'Logo uploaded', description: 'Save the configuration to publish it on the customer menu.' });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      setEditConfig(prev => ({ ...prev, businessBanner: base64 }));
      toast({ title: 'Banner uploaded', description: 'Save the configuration to publish it on the customer menu.' });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Details View - Single Centered Card */}
      <Card className="mx-auto max-w-2xl">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Menu Configuration</CardTitle>
          <CardDescription>Current settings for your digital menu</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Banner */}
          {config.businessBanner && (
            <div className="flex justify-center">
              <img src={config.businessBanner} alt="Banner" className="h-32 w-full max-w-md rounded-lg object-cover" />
            </div>
          )}

          {/* Logo & Branding */}
          {config.businessLogo && (
            <div className="flex justify-center">
              <div className="flex h-20 w-full max-w-sm items-center justify-center overflow-hidden rounded-lg border bg-muted/30 p-3">
                <img src={config.businessLogo} alt="Logo" className="max-h-full max-w-full object-contain" />
              </div>
            </div>
          )}

          {/* Display Name */}
          <div className="space-y-2 text-center">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Display Name</p>
            <p className="text-2xl font-bold">{config.displayName}</p>
          </div>

          <Separator />

          {/* Tagline */}
          <div className="space-y-2 text-center">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tagline</p>
            <p className="text-lg italic">{config.tagline}</p>
          </div>

          <Separator />

          {/* Description */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{config.description}</p>
          </div>

          <Separator />

          {/* Colors */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Colors</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-16 rounded border" style={{ backgroundColor: config.primaryColor }} />
                <div>
                  <p className="text-xs text-muted-foreground">Primary</p>
                  <p className="text-sm font-mono font-semibold">{config.primaryColor}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-10 w-16 rounded border" style={{ backgroundColor: config.accentColor }} />
                <div>
                  <p className="text-xs text-muted-foreground">Accent</p>
                  <p className="text-sm font-mono font-semibold">{config.accentColor}</p>
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Display Settings */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Display Settings</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Items Per Row</p>
                <Badge variant="outline" className="mt-1">{config.itemsPerRow === 'auto' ? 'Auto (Responsive)' : `${config.itemsPerRow} Items`}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Currency</p>
                <Badge variant="outline" className="mt-1">{config.currency}</Badge>
              </div>
            </div>
          </div>

          <Separator />

          {/* Display Options */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Display Options</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'showPrices', label: 'Show Prices' },
                { key: 'showCategories', label: 'Show Categories' },
                { key: 'showImages', label: 'Show Images' },
                { key: 'showBrandInfo', label: 'Show Brand Info' },
                { key: 'showContactInfo', label: 'Show Contact Info' },
                { key: 'enableSearch', label: 'Enable Search' },
                { key: 'enableFilters', label: 'Enable Filters' },
                { key: 'enableSorting', label: 'Enable Sorting' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between text-sm p-2 rounded-lg bg-muted/50">
                  <span>{label}</span>
                  <Badge variant={config[key as keyof MenuConfig] ? 'default' : 'secondary'} className="text-xs">
                    {config[key as keyof MenuConfig] ? '✓' : '✗'}
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Order Management */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Order Management</p>
            <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
              <div>
                <p className="font-semibold">Accept Orders</p>
                <p className="text-xs text-muted-foreground">Customers can place orders</p>
              </div>
              <Badge variant={config.acceptOrders ? 'default' : 'secondary'} className="text-xs">
                {config.acceptOrders ? '✓ Enabled' : '✗ Disabled'}
              </Badge>
            </div>
          </div>

          <Separator />

          {/* Theme */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Theme</p>
            <Badge variant="outline">{config.theme === 'auto' ? 'Auto (System)' : config.theme.charAt(0).toUpperCase() + config.theme.slice(1)}</Badge>
          </div>

          <Separator />

          {/* Footer Text */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Footer Text</p>
            <p className="text-sm text-muted-foreground italic">{config.footerText}</p>
          </div>
        </CardContent>
      </Card>

      {/* Update Button */}
      <div className="flex justify-center">
        <Button onClick={handleOpenEditModal} size="lg">
          <Settings className="mr-2 h-4 w-4" />
          Update Configuration
        </Button>
      </div>

      {/* Edit Modal */}
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Menu Configuration</DialogTitle>
            <DialogDescription>Customize your digital menu appearance and settings</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Display Name */}
            <div className="space-y-2">
              <Label htmlFor="edit-displayName">Menu Display Name</Label>
              <Input
                id="edit-displayName"
                value={editConfig.displayName}
                onChange={(e) => setEditConfig(prev => ({ ...prev, displayName: e.target.value }))}
                placeholder="e.g., Our Menu"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="edit-description">Menu Description</Label>
              <Textarea
                id="edit-description"
                value={editConfig.description}
                onChange={(e) => setEditConfig(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Welcome message for customers"
                rows={3}
              />
            </div>

            {/* Tagline */}
            <div className="space-y-2">
              <Label htmlFor="edit-tagline">Tagline</Label>
              <Input
                id="edit-tagline"
                value={editConfig.tagline}
                onChange={(e) => setEditConfig(prev => ({ ...prev, tagline: e.target.value }))}
                placeholder="e.g., Fresh & Delicious"
              />
            </div>

            <Separator />

            {/* Branding Images */}
            <div className="space-y-3">
              <h4 className="font-semibold">Customer Menu Branding</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div>
                    <Label>Business Logo</Label>
                    <p className="text-xs text-muted-foreground">Shown beside your business name on the public menu.</p>
                  </div>
                  <div className="space-y-3">
                    <div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-lg border bg-background p-3">
                      {editConfig.businessLogo ? (
                        <img src={editConfig.businessLogo} alt="Business logo preview" className="max-h-full max-w-full object-contain" />
                      ) : (
                        <Utensils className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={handleLogoUpload}
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()}>
                        <Upload className="mr-2 h-4 w-4" />
                        Upload
                      </Button>
                      {editConfig.businessLogo && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditConfig(prev => ({ ...prev, businessLogo: undefined }))}
                        >
                          <X className="mr-2 h-4 w-4" />
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div>
                    <Label>Menu Banner</Label>
                    <p className="text-xs text-muted-foreground">Shown in the public menu hero area.</p>
                  </div>
                  <div className="overflow-hidden rounded-lg border bg-background">
                    {editConfig.businessBanner ? (
                      <img src={editConfig.businessBanner} alt="Menu banner preview" className="h-24 w-full object-cover" />
                    ) : (
                      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                        No banner uploaded
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={bannerInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={handleBannerUpload}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => bannerInputRef.current?.click()}>
                      <Upload className="mr-2 h-4 w-4" />
                      Upload
                    </Button>
                    {editConfig.businessBanner && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditConfig(prev => ({ ...prev, businessBanner: undefined }))}
                      >
                        <X className="mr-2 h-4 w-4" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Colors */}
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorSetting
                id="edit-primaryColor"
                label="Primary Color"
                value={editConfig.primaryColor}
                onChange={(primaryColor) => setEditConfig(prev => ({ ...prev, primaryColor }))}
              />
              <ColorSetting
                id="edit-accentColor"
                label="Accent Color"
                value={editConfig.accentColor}
                onChange={(accentColor) => setEditConfig(prev => ({ ...prev, accentColor }))}
              />
            </div>

            <Separator />

            {/* Layout & Currency */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-itemsPerRow">Items Per Row</Label>
                <Select value={editConfig.itemsPerRow} onValueChange={(value: any) => setEditConfig(prev => ({ ...prev, itemsPerRow: value }))}>
                  <SelectTrigger id="edit-itemsPerRow">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (Responsive)</SelectItem>
                    <SelectItem value="2">2 Items</SelectItem>
                    <SelectItem value="3">3 Items</SelectItem>
                    <SelectItem value="4">4 Items</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-currency">Currency</Label>
                <div className="flex items-center gap-2 p-2 rounded-lg border bg-muted/50">
                  <span className="text-sm font-semibold">{businessCurrency}</span>
                  <span className="text-xs text-muted-foreground">(Business Currency)</span>
                </div>
              </div>
            </div>

            <Separator />

            {/* Display Options */}
            <div className="space-y-3">
              <h4 className="font-semibold">Display Options</h4>
              {[
                { key: 'showPrices', label: 'Show Prices' },
                { key: 'showCategories', label: 'Show Categories' },
                { key: 'showImages', label: 'Show Images' },
                { key: 'enableSearch', label: 'Enable Search' },
                { key: 'enableFilters', label: 'Enable Filters' },
                { key: 'enableSorting', label: 'Enable Sorting' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <Label>{label}</Label>
                  <button
                    onClick={() => setEditConfig(prev => ({ ...prev, [key]: !prev[key as keyof MenuConfig] }))}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      editConfig[key as keyof MenuConfig] ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        editConfig[key as keyof MenuConfig] ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              ))}
            </div>

            <Separator />

            {/* Order Management */}
            <div className="space-y-3">
              <h4 className="font-semibold">Order Management</h4>
              <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Accept Orders</Label>
                  <p className="text-sm text-muted-foreground">Allow customers to place orders</p>
                </div>
                <button
                  onClick={() => setEditConfig(prev => ({ ...prev, acceptOrders: !prev.acceptOrders }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    editConfig.acceptOrders ? 'bg-green-600' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      editConfig.acceptOrders ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex gap-2 justify-end pt-4">
            <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                setConfig(editConfig);
                setIsEditModalOpen(false);
                // Save after closing modal
                setIsSaving(true);
                try {
                  if (!activeBranchId) return;
                  
                  // Get business ID from IndexedDB with fallbacks
                  let businessId: string | null = null;
                  
                  // Try to get from IndexedDB first
                  let business = await db.business.get('main-business');
                  if (business) {
                    businessId = business.id;
                  } else {
                    // Fallback: try to get all businesses and use the first one
                    const allBusinesses = await db.business.toArray();
                    if (allBusinesses.length > 0) {
                      businessId = allBusinesses[0].id;
                    }
                  }
                  
                  if (!businessId) {
                    throw new Error('Business not found in local database');
                  }
                  
                  const branchIdInt = getBackendBranchId(activeBranchId);
                  if (branchIdInt === null) {
                    throw new Error('Invalid branch selected');
                  }
                  
                  console.log('[MenuConfig] Business ID:', businessId);
                  console.log('[MenuConfig] Branch ID (int):', branchIdInt);
                  
                  // Map camelCase to snake_case for backend
                  const backendData = {
                    business: businessId,
                    branch: branchIdInt,
                    display_name: editConfig.displayName,
                    description: editConfig.description,
                    tagline: editConfig.tagline,
                    theme: editConfig.theme,
                    primary_color: editConfig.primaryColor,
                    accent_color: editConfig.accentColor,
                    show_prices: editConfig.showPrices,
                    show_categories: editConfig.showCategories,
                    show_images: editConfig.showImages,
                    show_brand_info: editConfig.showBrandInfo,
                    show_contact_info: editConfig.showContactInfo,
                    items_per_row: editConfig.itemsPerRow,
                    currency: businessCurrency || editConfig.currency,
                    business_logo: editConfig.businessLogo ?? null,
                    business_banner: editConfig.businessBanner ?? null,
                    footer_text: editConfig.footerText,
                    enable_search: editConfig.enableSearch,
                    enable_filters: editConfig.enableFilters,
                    enable_sorting: editConfig.enableSorting,
                    accept_orders: editConfig.acceptOrders,
                  };
                  
                  console.log('[MenuConfig] Sending data to backend:', backendData);
                  
                  const responseData = await authFetch.fetch<any>('/digital-menu/menu-config/', {
                    method: 'POST',
                    body: JSON.stringify(backendData),
                  });
                  
                  console.log('[MenuConfig] Response data:', responseData);
                  
                  toast({ title: 'Success', description: 'Configuration saved successfully' });
                } catch (error) {
                  console.error('[MenuConfig] Error saving:', error);
                  toast({ variant: 'destructive', title: 'Error', description: error instanceof Error ? error.message : 'Failed to save configuration' });
                } finally {
                  setIsSaving(false);
                }
              }}
              disabled={isSaving}
            >
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default function MenuBuilderPage() {
  const { toast } = useToast();
  const { currencyCode } = useCurrency();
  const [isAddModalOpen, setAddModalOpen] = useState(false);
  const [isShareModalOpen, setShareModalOpen] = useState(false);
  const [publicMenuUrl, setPublicMenuUrl] = useState('');
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [menuDataRefreshToken, setMenuDataRefreshToken] = useState(0);
  const [businessName, setBusinessName] = useState('Our Restaurant');
  const {
    accessCheck: menuAccess,
    isLoading: isLoadingMenuAccess,
  } = useSubscriptionFeatureAccess('online_menu');

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if(branchId) {
      setActiveBranchId(branchId);
    }
  }, []);

  useEffect(() => {
    const syncActiveBranch = (branchId?: string | null) => {
      const nextBranchId = branchId || localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
      if (!nextBranchId) return;
      setActiveBranchId((currentBranchId) => (
        currentBranchId === nextBranchId ? currentBranchId : nextBranchId
      ));
    };

    const handleBranchChange = (event: Event) => {
      const branchId = (event as CustomEvent).detail?.branchId;
      syncActiveBranch(branchId);
    };
    const handleBranchesUpdated = () => syncActiveBranch();
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === LOCAL_STORAGE_KEYS.ACTIVE_BRANCH) {
        syncActiveBranch(event.newValue);
      }
    };

    window.addEventListener('branchChanged', handleBranchChange);
    window.addEventListener('branchesUpdated', handleBranchesUpdated);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('branchChanged', handleBranchChange);
      window.removeEventListener('branchesUpdated', handleBranchesUpdated);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // Pull server data when branch changes
  useEffect(() => {
    if (activeBranchId) {
      console.log('[Menu] Pulling server data for branch:', activeBranchId);
      pullServerData(activeBranchId);
    }
  }, [activeBranchId]);

  useEffect(() => {
    if (!activeBranchId) return;

    const refreshMenuData = () => {
      if (document.visibilityState === 'hidden') return;
      setMenuDataRefreshToken((token) => token + 1);
    };
    const handleVisibilityChange = () => refreshMenuData();

    window.addEventListener('focus', refreshMenuData);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshMenuData);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeBranchId]);

  const pullServerData = async (branchId: string) => {
    try {
      console.log('[Menu] Starting full sync for branch:', branchId);
      const { syncService } = await import('@/lib/services/sync-service');
      await syncService.performFullSync(branchId);
      console.log('[Menu] Full sync completed');
      
      // Also fetch all inventory items directly to ensure they're in local DB
      console.log('[Menu] Fetching all inventory items from backend');
      await syncService.fetchAllInventoryFromBackend(branchId);
      console.log('[Menu] Inventory fetch completed');
      setMenuDataRefreshToken((token) => token + 1);
    } catch (error) {
      console.error('[Menu] Sync error:', error);
      // Don't show error toast - sync is best effort
    }
  };

  // Fetch business name
  const business = useLiveQuery(
    () => db.business.get('main-business'),
    []
  );

  useEffect(() => {
    const loadBusinessName = async () => {
      // Try to get from IndexedDB first
      if (business?.name) {
        console.log('[Menu] Business name from IndexedDB:', business.name);
        setBusinessName(business.name);
        return;
      }

      // Fallback: try to get all businesses and use the first one
      try {
        const allBusinesses = await db.business.toArray();
        console.log('[Menu] All businesses in DB:', allBusinesses);
        if (allBusinesses.length > 0 && allBusinesses[0].name) {
          console.log('[Menu] Business name from first business:', allBusinesses[0].name);
          setBusinessName(allBusinesses[0].name);
          return;
        }
      } catch (error) {
        console.error('[Menu] Error fetching businesses:', error);
      }

      // Fallback: check localStorage for business data
      try {
        const storedBusiness = localStorage.getItem('handypos-business');
        if (storedBusiness) {
          const parsed = JSON.parse(storedBusiness);
          if (parsed.name) {
            console.log('[Menu] Business name from localStorage:', parsed.name);
            setBusinessName(parsed.name);
            return;
          }
        }
      } catch (error) {
        console.error('[Menu] Error parsing localStorage business:', error);
      }

      console.log('[Menu] Using default business name');
    };

    loadBusinessName();
  }, [business]);

  useEffect(() => {
    console.log('[Menu] Current businessName state:', businessName);
  }, [businessName]);

  // Fetch menu items from backend
  const [menuItems, setMenuItems] = useState<InventoryItem[]>([]);
  const [availableItems, setAvailableItems] = useState<InventoryItem[]>([]);
  const [isLoadingMenuItems, setIsLoadingMenuItems] = useState(false);
  const [optionsItem, setOptionsItem] = useState<InventoryItem | null>(null);
  const visibleMenuItems = useMemo(
    () => menuItems.filter((item) => isMenuItemVisible(item)),
    [menuItems]
  );

  // Fetch all sellable items from local database
  const allSellableItems = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      const branchCandidates = getBranchIdCandidates(activeBranchId);
      return db.inventory
        .where('branchId')
        .anyOf(branchCandidates)
        .filter(item => item.itemType === 'sellable')
        .toArray()
    },
    [activeBranchId]
  );

  // Fetch menu items from backend - independent of allSellableItems
  useEffect(() => {
    const fetchMenuItems = async () => {
      if (!activeBranchId) {
        console.log('[Menu] No activeBranchId, skipping menu fetch');
        return;
      }
      
      setIsLoadingMenuItems(true);
      try {
        const branchIdInt = getBackendBranchId(activeBranchId);
        if (branchIdInt === null) {
          throw new Error('Invalid branch selected');
        }
        
        console.log('[Menu] Fetching menu items from backend for branch:', branchIdInt);
        
        // Fetch menu entries from backend
        const menuData = await authFetch.fetch<any>(`/digital-menu/menu/by_branch/?branch_id=${branchIdInt}`);
        console.log('[Menu] Menu items from backend response:', menuData);
        
        // Handle different response formats
        let menuEntries: any[] = [];
        if (Array.isArray(menuData)) {
          menuEntries = menuData;
          console.log('[Menu] Response is array with', menuEntries.length, 'items');
        } else if (menuData && menuData.results && Array.isArray(menuData.results)) {
          menuEntries = menuData.results;
          console.log('[Menu] Response is paginated with', menuEntries.length, 'items');
        } else if (menuData) {
          console.warn('[Menu] Unexpected menu data format:', menuData);
          menuEntries = [];
        }
        
        const menuEntriesByItemId = new Map<string, any>();
        const preparedMenuEntries: any[] = [];
        menuEntries.forEach((entry: any) => {
          const inventoryItemId = getMenuEntryInventoryId(entry);
          if (inventoryItemId) {
            menuEntriesByItemId.set(inventoryItemId, entry);
          } else {
            preparedMenuEntries.push(entry);
          }
        });

        // Extract inventory item IDs from menu entries
        const menuItemIds = new Set(menuEntriesByItemId.keys());
        console.log('[Menu] Menu item IDs from backend:', Array.from(menuItemIds));
        
        // Get all inventory items from local database (not just sellable)
        const branchCandidates = getBranchIdCandidates(activeBranchId);
        const allItems = await db.inventory.where('branchId').anyOf(branchCandidates).toArray();
        console.log('[Menu] Total inventory items in local DB:', allItems.length);
        
        // Split items into menu and available
        const onMenu: InventoryItem[] = [];
        const notOnMenu: InventoryItem[] = [];
        
        const localItemIds = new Set<string>();
        allItems.forEach(item => {
          const itemId = String(item.id);
          localItemIds.add(itemId);
          if (menuItemIds.has(itemId)) {
            const menuItem = buildMenuInventoryItem(menuEntriesByItemId.get(itemId), item, activeBranchId);
            if (menuItem) onMenu.push(menuItem);
          } else {
            notOnMenu.push(item);
          }
        });

        menuEntriesByItemId.forEach((entry, itemId) => {
          if (localItemIds.has(itemId)) return;
          const menuItem = buildMenuInventoryItem(entry, undefined, activeBranchId);
          if (menuItem) onMenu.push(menuItem);
        });

        preparedMenuEntries.forEach((entry) => {
          const menuItem = buildMenuInventoryItem(entry, undefined, activeBranchId);
          if (menuItem) onMenu.push(menuItem);
        });
        
        console.log('[Menu] Split items - onMenu:', onMenu.length, 'available:', notOnMenu.length);
        setMenuItems(onMenu);
        setAvailableItems(notOnMenu);
      } catch (error) {
        console.error('[Menu] Error fetching menu items from backend:', error);
        // Fallback: get all items from local DB
        try {
          const branchCandidates = getBranchIdCandidates(activeBranchId);
          const allItems = await db.inventory.where('branchId').anyOf(branchCandidates).toArray();
          const onMenu: InventoryItem[] = [];
          const notOnMenu: InventoryItem[] = [];
          allItems.forEach(item => {
            if (item.onMenu === true) {
              onMenu.push(item);
            } else {
              notOnMenu.push(item);
            }
          });
          console.log('[Menu] Using fallback - onMenu:', onMenu.length, 'available:', notOnMenu.length);
          setMenuItems(onMenu);
          setAvailableItems(notOnMenu);
        } catch (fallbackError) {
          console.error('[Menu] Fallback also failed:', fallbackError);
          setMenuItems([]);
          setAvailableItems([]);
        }
      } finally {
        setIsLoadingMenuItems(false);
      }
    };
    
    fetchMenuItems();
  }, [activeBranchId, menuDataRefreshToken]);

  useEffect(() => {
    const fetchPublicMenuUrl = async () => {
      if (!activeBranchId) {
        console.log('[Menu] No activeBranchId, skipping menu URL fetch');
        return;
      }

      try {
        const branchIdInt = getBackendBranchId(activeBranchId);
        if (branchIdInt === null) {
          throw new Error('Invalid branch selected');
        }
        
        console.log('[Menu] Fetching menu config for branch:', branchIdInt);
        
        // Fetch menu config which includes the public_menu_url
        const menuConfigData = await authFetch.fetch<any>(`/digital-menu/menu-config/by_branch/?branch_id=${branchIdInt}`);
        
        console.log('[Menu] Menu config response:', menuConfigData);
        
        // Handle both single object and array responses
        const configData = Array.isArray(menuConfigData) ? menuConfigData[0] : menuConfigData;
        
        if (configData && configData.public_menu_url) {
          console.log('[Menu] Using public menu URL from backend:', configData.public_menu_url);
          setPublicMenuUrl(configData.public_menu_url);
        } else {
          console.warn('[Menu] No public_menu_url in menu config response');
        }
      } catch (error) {
        console.error('[Menu] Error fetching public menu URL from backend:', error);
      }
    };

    fetchPublicMenuUrl();
  }, [activeBranchId]);

  const handleMenuItemUpdated = (itemId: string, updates: Partial<InventoryItem>) => {
    setMenuItems((currentItems) => currentItems.map((currentItem) => (
      currentItem.id === itemId ? { ...currentItem, ...updates } : currentItem
    )));
    setAvailableItems((currentItems) => currentItems.map((currentItem) => (
      currentItem.id === itemId ? { ...currentItem, ...updates } : currentItem
    )));
  };

  const handleMenuItemAdded = (item: InventoryItem) => {
    setMenuItems((currentItems) => {
      if (currentItems.some((currentItem) => currentItem.id === item.id)) {
        return currentItems.map((currentItem) => (
          currentItem.id === item.id ? { ...currentItem, ...item, onMenu: true, menuIsVisible: true } : currentItem
        ));
      }
      return [...currentItems, { ...item, onMenu: true, menuIsVisible: true }];
    });
    setAvailableItems((currentItems) => currentItems.filter((currentItem) => currentItem.id !== item.id));
  };

  const handleMenuItemVisibilityChange = async (item: InventoryItem, isVisible: boolean) => {
    const previousVisible = isMenuItemVisible(item);

    handleMenuItemUpdated(item.id, { menuIsVisible: isVisible, onMenu: true });
    await db.inventory.update(item.id, { menuIsVisible: isVisible, onMenu: true });

    try {
      if (!activeBranchId) {
        throw new Error('No active branch selected');
      }

      const branchIdInt = getBackendBranchId(activeBranchId);
      if (branchIdInt === null) {
        throw new Error('Invalid branch selected');
      }

      const response = await authFetch.fetch<any>('/digital-menu/menu/set_visibility/', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: branchIdInt,
          inventory_item_id: item.isPreparedMenuItem || item.is_prepared_menu_item ? undefined : item.id,
          menu_item_id: item.menuEntryId || item.menuItemId || item.menu_item_id,
          is_visible: isVisible,
        }),
      });

      handleMenuItemUpdated(item.id, {
        menuEntryId: firstNonEmpty(response?.id, item.menuEntryId),
        menuIsVisible: response?.is_visible !== undefined ? Boolean(response.is_visible) : isVisible,
        onMenu: true,
      });

      toast({
        title: isVisible ? 'Item shown' : 'Item hidden',
        description: isVisible
          ? `${item.name} will appear on the customer menu.`
          : `${item.name} is saved but hidden from the customer menu.`,
      });
    } catch (error) {
      console.error('[Menu] Error updating menu item visibility:', error);
      handleMenuItemUpdated(item.id, { menuIsVisible: previousVisible, onMenu: true });
      await db.inventory.update(item.id, { menuIsVisible: previousVisible, onMenu: true });
      toast({
        variant: 'destructive',
        title: 'Visibility not saved',
        description: error instanceof Error ? error.message : 'Failed to update menu item visibility',
      });
    }
  };

  const handleMenuItemDelete = async (item: InventoryItem) => {
    try {
      if (!activeBranchId) {
        throw new Error('No active branch selected');
      }

      const branchIdInt = getBackendBranchId(activeBranchId);
      if (branchIdInt === null) {
        throw new Error('Invalid branch selected');
      }

      const isPrepared = Boolean(item.isPreparedMenuItem || item.is_prepared_menu_item);
      const menuItemId = item.menuEntryId || item.menuItemId || item.menu_item_id;

      await authFetch.fetch('/digital-menu/menu/delete_item/', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: branchIdInt,
          inventory_item_id: isPrepared ? undefined : item.id,
          menu_item_id: menuItemId,
        }),
      });

      setMenuItems((currentItems) => currentItems.filter((currentItem) => currentItem.id !== item.id));

      if (!isPrepared) {
        await db.inventory.update(item.id, { onMenu: false, menuIsVisible: false });
        setAvailableItems((currentItems) => {
          if (currentItems.some((currentItem) => currentItem.id === item.id)) return currentItems;
          return [...currentItems, { ...item, onMenu: false, menuIsVisible: false }];
        });
      }

      toast({
        title: 'Menu item deleted',
        description: `${item.name} was removed from the menu.`,
      });
    } catch (error) {
      console.error('[Menu] Error deleting menu item:', error);
      toast({
        variant: 'destructive',
        title: 'Could not delete menu item',
        description: error instanceof Error ? error.message : 'Failed to delete menu item',
      });
    }
  };

  if (isLoadingMenuAccess) {
    return (
        <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
  }

  if (!menuAccess.allowed) {
    return (
      <SubscriptionFeatureDisabledCard
        featureName="online_menu"
        accessCheck={menuAccess}
      />
    );
  }

  if (!activeBranchId) {
    return (
        <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
  }

  return (
    <>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Menu Builder</h1>
          <p className="text-muted-foreground">
            Manage the items that appear on your public customer-facing menu for the active branch.
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={() => setAddModalOpen(true)}
          >
            <PlusCircle className="mr-2 h-4 w-4" />
            Add Item to Menu
          </Button>
          <Button
            variant="outline"
            onClick={() => setShareModalOpen(true)}
            disabled={!publicMenuUrl}
          >
            <QrCode className="mr-2 h-4 w-4" />
            Share Menu
          </Button>
        </div>
      </div>

      
      <Tabs defaultValue="menu" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="menu">Menu Items</TabsTrigger>
          <TabsTrigger value="config">
            <Settings className="mr-2 h-4 w-4" />
            Configuration
          </TabsTrigger>
          <TabsTrigger value="templates">
            <Download className="mr-2 h-4 w-4" />
            Print Templates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="menu" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Current Menu</CardTitle>
              <CardDescription>
                Keep items saved here and switch them on or off for the public customer menu.
                {menuItems.length > 0 ? ` ${visibleMenuItems.length} of ${menuItems.length} items are visible.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {menuItems.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {menuItems.map((item) => (
	                    <MenuItemCard
	                      key={item.id}
	                      item={item}
	                      onItemUpdated={handleMenuItemUpdated}
	                      onVisibilityChange={handleMenuItemVisibilityChange}
	                      onManageOptions={setOptionsItem}
	                      onDelete={handleMenuItemDelete}
	                    />
                  ))}
                </div>
              ) : (
                <div
                  className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/30 py-24 text-center cursor-pointer hover:bg-muted/50"
                  onClick={() => setAddModalOpen(true)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setAddModalOpen(true)}
                >
                  <Utensils className="h-16 w-16 text-muted-foreground/30" />
                  <h2 className="mt-6 text-xl font-semibold">Your menu is empty</h2>
                  <p className="mt-2 text-muted-foreground">
                    Click here to add your first sellable product to the menu.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <MenuConfigTab activeBranchId={activeBranchId} />
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Menu Templates</CardTitle>
              <CardDescription>
                Download professional menu templates ready for printing. Choose from various layouts and styles.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MenuTemplates
                menuItems={visibleMenuItems}
                businessName={businessName}
                currencyCode={business?.currency || currencyCode}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>QR Code Designs</CardTitle>
              <CardDescription>
                Download print-ready QR code designs that customers can scan to access your digital menu. Choose from multiple professional designs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <QRCodeTemplates publicMenuUrl={publicMenuUrl} businessName={businessName} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
	      <AddToMenuModal 
	        isOpen={isAddModalOpen} 
	        onOpenChange={setAddModalOpen} 
	        availableItems={availableItems}
	        recipeItems={[...menuItems, ...availableItems]}
	        activeBranchId={activeBranchId}
	        onItemAdded={handleMenuItemAdded}
	      />

	      <MenuOptionsModal
	        item={optionsItem}
	        activeBranchId={activeBranchId}
	        open={!!optionsItem}
	        onOpenChange={(open) => {
	          if (!open) setOptionsItem(null);
	        }}
	      />
	      
	      <ShareMenuModal
        isOpen={isShareModalOpen}
        onOpenChange={setShareModalOpen}
        publicMenuUrl={publicMenuUrl}
      />
    </>
  );
}
