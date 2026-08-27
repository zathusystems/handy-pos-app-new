
'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type InventoryItem, type TakeOrder } from '@/lib/db';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ArrowLeft, Plus, Minus, Send, ShoppingBasket, Trash2, Loader2 } from 'lucide-react';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { Textarea } from '../ui/textarea';
import { Input } from '../ui/input';
import { authFetch } from '@/lib/auth-fetch';
import {
    buildKitchenInventoryLookup,
    getKitchenOrderItems,
} from '@/lib/kitchen-order-routing';
import { isKitchenBusinessType, type BusinessType } from '@/lib/inventory/config';
import { PortionSaleDialog, canSellInPortions } from './portion-sale-dialog';
import { getPortionQuantityDisplay } from '@/lib/quantity-format';

type TakeOrderModalProps = {
  branchId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  businessType?: BusinessType | string | null;
  existingOrder?: TakeOrder | null;
  mode?: 'create' | 'add-items';
  onOrderUpdated?: (order: TakeOrder) => void;
};

type OrderDestination = 'kitchen' | 'pos';

type TakeawayConfig = {
    enabled: boolean;
    packagingItemId: string;
    packagingName: string;
    price: number;
};

type MenuOption = {
    id: string;
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

type MenuOptionGroup = {
    id: string;
    name: string;
    group_type?: 'option' | 'side' | 'addon' | string;
    is_required?: boolean;
    min_select?: number;
    max_select?: number;
    options: MenuOption[];
};

type MenuItemWithOptions = InventoryItem & {
    optionGroups?: MenuOptionGroup[];
    option_groups?: MenuOptionGroup[];
};

type OrderCartItem = {
    id: string;
    cartKey: string;
    name: string;
    quantity: number;
    price: number;
    notes?: string;
    recipe?: InventoryItem['recipe'];
    isPreparedMenuItem?: boolean;
    is_prepared_menu_item?: boolean;
    menuItemId?: string;
    menu_item_id?: string;
    menuEntryId?: string;
    isSoldInPortions?: boolean;
    portionName?: string;
    portionsPerUnit?: number;
    unitType?: string;
    portionDisplay?: string;
    isTakeawayPackaging?: boolean;
    is_takeaway_packaging?: boolean;
    selectedOptions?: Array<Record<string, unknown>>;
    selected_options?: Array<Record<string, unknown>>;
}

const normalizeBranchId = (value?: string | number | null): string => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';

    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];

    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];

    return normalized;
};

const getBranchIdCandidates = (branchId?: string | number | null): string[] => {
    const normalized = normalizeBranchId(branchId);
    if (!normalized) return [];

    const candidates = new Set<string>([normalized, String(branchId ?? '').trim()]);
    if (/^\d+$/.test(normalized)) {
        candidates.add(`BRN-${normalized}`);
        candidates.add(`branch-${normalized}`);
    }

    return Array.from(candidates).filter(Boolean);
};

const getBackendBranchId = (branchId?: string | number | null): number | null => {
    const normalized = String(branchId ?? '').trim();
    if (!normalized) return null;

    const branchIdMatch = normalized.match(/\d+/);
    const parsed = branchIdMatch ? Number.parseInt(branchIdMatch[0], 10) : Number.parseInt(normalized, 10);

    return Number.isFinite(parsed) ? parsed : null;
};

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

const getMenuEntryInventoryId = (entry: any): string => String(
    entry?.inventory_item ??
    entry?.inventory_item_id ??
    entry?.item_details?.id ??
    ''
).trim();

const getMenuEntryId = (entry: any): string => String(entry?.id ?? entry?.menu_id ?? '').trim();

const getMenuOptionGroups = (item: InventoryItem | null | undefined): MenuOptionGroup[] => {
    const candidate = (item as MenuItemWithOptions | null | undefined)?.optionGroups
        ?? (item as MenuItemWithOptions | null | undefined)?.option_groups;
    if (!Array.isArray(candidate)) return [];

    return candidate.filter((group) => (
        group
        && Array.isArray(group.options)
        && group.options.some((option) => option?.is_visible !== false)
    ));
};

const getMenuItemKey = (item: InventoryItem): string => {
    const menuItem = item as MenuItemWithOptions;
    return String(menuItem.isPreparedMenuItem || menuItem.is_prepared_menu_item
        ? menuItem.menuEntryId || menuItem.id
        : menuItem.id);
};

const getConfiguredMenuPrice = (
    item: InventoryItem,
    selectedOptions: Array<Record<string, unknown>> = []
): number => {
    let price = Number(item.price || 0);
    selectedOptions.forEach((option) => {
        const mode = String(option?.price_mode ?? option?.priceMode ?? '').toLowerCase();
        const override = Number(option?.price_override ?? option?.priceOverride);
        if (mode === 'override' && Number.isFinite(override)) {
            price = override;
            return;
        }
        const delta = Number(option?.price_delta ?? option?.priceDelta ?? 0);
        if (Number.isFinite(delta)) price += delta;
    });
    return Math.max(0, price);
};

const getDefaultOptionIds = (item: InventoryItem): Record<string, string[]> => {
    return Object.fromEntries(
        getMenuOptionGroups(item).map((group) => {
            const maxSelect = Math.max(1, Number(group.max_select || 1));
            const defaults = group.options
                .filter((option) => option.is_visible !== false && option.is_default)
                .slice(0, maxSelect)
                .map((option) => String(option.id));
            return [String(group.id), defaults];
        })
    );
};

const buildSelectedOptionSnapshots = (
    item: InventoryItem,
    selectedOptionIds: Record<string, string[]>
): Array<Record<string, unknown>> => {
    return getMenuOptionGroups(item).flatMap((group) => {
        const selectedIds = selectedOptionIds[String(group.id)] || [];
        return selectedIds.flatMap((optionId) => {
            const option = group.options.find((candidate) => String(candidate.id) === String(optionId));
            if (!option) return [];
            return [{
                id: String(option.id),
                group_id: String(group.id),
                group_name: group.name,
                group_type: group.group_type,
                name: option.name,
                description: option.description || '',
                quantity: 1,
                price_mode: option.price_mode || 'delta',
                price_delta: Number(option.price_delta || 0),
                price_override: option.price_override === null || option.price_override === undefined
                    ? null
                    : Number(option.price_override),
                recipe: Array.isArray(option.recipe) ? option.recipe : [],
                linked_inventory_item: option.linked_inventory_item || null,
                linked_inventory_item_name: option.linked_inventory_item_name || '',
                linked_inventory_quantity: Number(option.linked_inventory_quantity || 0),
            }];
        });
    });
};

const buildTakeOrderMenuItem = (
    entry: any,
    localItem: InventoryItem | undefined,
    branchId: string
): MenuItemWithOptions | null => {
    const details = entry?.item_details || {};
    const prepared = Boolean(entry?.is_prepared_item ?? entry?.isPreparedMenuItem) || !getMenuEntryInventoryId(entry);
    const menuEntryId = getMenuEntryId(entry);
    const id = prepared
        ? firstNonEmpty(menuEntryId, localItem?.id)
        : firstNonEmpty(localItem?.id, details.id, entry?.inventory_item, entry?.inventory_item_id);

    if (!id) return null;

    const recipe = Array.isArray(prepared ? entry?.recipe : details.recipe)
        ? (prepared ? entry.recipe : details.recipe)
        : localItem?.recipe;

    return {
        ...(localItem || {}),
        id,
        branchId: localItem?.branchId || branchId,
        name: firstNonEmpty(prepared ? entry?.name : undefined, details.name, localItem?.name, entry?.item_name) || 'Unnamed Item',
        category: firstNonEmpty(prepared ? entry?.category : undefined, details.category, localItem?.category) || 'Uncategorized',
        itemType: 'sellable',
        price: toNumber(prepared ? entry?.price : undefined, details.price, localItem?.price) ?? 0,
        recipe,
        description: firstNonEmpty(entry?.description, localItem?.description),
        isPreparedMenuItem: prepared,
        is_prepared_menu_item: prepared,
        menuItemId: menuEntryId || localItem?.menuItemId,
        menu_item_id: menuEntryId || localItem?.menu_item_id,
        menuEntryId: firstNonEmpty(entry?.id, localItem?.menuEntryId),
        onMenu: true,
        menuIsVisible: entry && Object.prototype.hasOwnProperty.call(entry, 'is_visible')
            ? Boolean(entry.is_visible)
            : localItem?.menuIsVisible !== false,
        image: prepared ? firstNonEmpty(entry?.image, localItem?.image) : firstNonEmpty(localItem?.image, details.image),
        isSoldInPortions: Boolean(details.is_sold_in_portions ?? localItem?.isSoldInPortions),
        portionName: firstNonEmpty(details.portion_name, localItem?.portionName),
        portionsPerUnit: toNumber(details.portions_per_unit, localItem?.portionsPerUnit),
        portionPrice: toNumber(details.portion_price, localItem?.portionPrice),
        unitType: firstNonEmpty(details.unit_type, localItem?.unitType),
        optionGroups: Array.isArray(entry?.option_groups)
            ? entry.option_groups
            : (Array.isArray(entry?.optionGroups) ? entry.optionGroups : []),
    };
};

export function TakeOrderModal({
    branchId,
    isOpen,
    onOpenChange,
    businessType,
    existingOrder = null,
    mode = 'create',
    onOrderUpdated,
}: TakeOrderModalProps) {
    const { format: formatCurrency } = useCurrency();
    const [cart, setCart] = useState<OrderCartItem[]>([]);
    const [selectedPortionItem, setSelectedPortionItem] = useState<MenuItemWithOptions | null>(null);
    const [selectedOptionsItem, setSelectedOptionsItem] = useState<MenuItemWithOptions | null>(null);
    const [selectedOptionIds, setSelectedOptionIds] = useState<Record<string, string[]>>({});
    const [pendingSelectedOptions, setPendingSelectedOptions] = useState<Array<Record<string, unknown>>>([]);
    const [selectedMenuItemId, setSelectedMenuItemId] = useState<string | null>(null);
    const [backendMenuItems, setBackendMenuItems] = useState<MenuItemWithOptions[]>([]);
    const [takeawayConfig, setTakeawayConfig] = useState<TakeawayConfig | null>(null);
    const [takeawayPackagingItem, setTakeawayPackagingItem] = useState<InventoryItem | null>(null);
    const [isTakeaway, setIsTakeaway] = useState(false);
    const [mobilePanel, setMobilePanel] = useState<'menu' | 'order'>('menu');
    const kitchenEnabled = isKitchenBusinessType(businessType);

    useEffect(() => {
        if (isOpen) {
            setMobilePanel('menu');
            setIsTakeaway(Boolean(existingOrder?.isTakeaway ?? existingOrder?.is_takeaway));
        }
    }, [existingOrder, isOpen]);
    
    const localMenuItems = useLiveQuery(
        () => {
            if (!branchId) return [];
            const branchCandidates = getBranchIdCandidates(branchId);
            if (branchCandidates.length === 0) return [];

            return db.inventory
                .where('branchId')
                .anyOf(branchCandidates)
                .filter(item => item.itemType === 'sellable' && item.onMenu === true)
                .toArray()
        },
        [branchId]
    ) || [];

    useEffect(() => {
        let cancelled = false;

        const fetchMenuEntries = async () => {
            if (!isOpen || !branchId) {
                setBackendMenuItems([]);
                return;
            }

            const backendBranchId = getBackendBranchId(branchId);
            if (backendBranchId === null) {
                setBackendMenuItems([]);
                return;
            }

            try {
                const menuData = await authFetch.fetch<any>(`/digital-menu/menu/by_branch/?branch_id=${backendBranchId}`);
                const menuEntries = Array.isArray(menuData)
                    ? menuData
                    : Array.isArray(menuData?.results)
                        ? menuData.results
                        : [];
                const localById = new Map(localMenuItems.map((item) => [String(item.id), item]));
                const normalizedItems = menuEntries
                    .map((entry: any) => buildTakeOrderMenuItem(
                        entry,
                        localById.get(getMenuEntryInventoryId(entry)),
                        String(branchId)
                    ))
                    .filter((item: InventoryItem | null): item is InventoryItem => Boolean(item))
                    .filter((item: InventoryItem) => item.menuIsVisible !== false);

                if (!cancelled) {
                    setBackendMenuItems(normalizedItems);
                }
            } catch (error) {
                console.warn('[TakeOrderModal] Could not load backend menu entries:', error);
                if (!cancelled) {
                    setBackendMenuItems([]);
                }
            }
        };

        fetchMenuEntries();

        return () => {
            cancelled = true;
        };
    }, [branchId, isOpen, localMenuItems]);

    useEffect(() => {
        let cancelled = false;

        const loadTakeawayConfig = async () => {
            if (!isOpen || !branchId) {
                setTakeawayConfig(null);
                setTakeawayPackagingItem(null);
                return;
            }

            const backendBranchId = getBackendBranchId(branchId);
            if (backendBranchId === null) return;

            try {
                const response = await authFetch.fetch<any>(
                    `/digital-menu/menu-config/public/?branch_id=${backendBranchId}`
                );
                const configData = Array.isArray(response) ? response[0] : response;
                const packagingItemId = String(
                    configData?.takeaway_packaging_item ?? configData?.takeaway_packaging_item_id ?? ''
                ).trim();
                const enabled = Boolean(configData?.takeaway_enabled && packagingItemId);

                if (!enabled) {
                    if (!cancelled) {
                        setTakeawayConfig(null);
                        setTakeawayPackagingItem(null);
                        setIsTakeaway(false);
                    }
                    return;
                }

                const config: TakeawayConfig = {
                    enabled,
                    packagingItemId,
                    packagingName: String(configData?.takeaway_packaging_item_name || 'Takeaway packaging'),
                    price: Number(configData?.takeaway_packaging_price || 0),
                };
                const localItem = await db.inventory.get(packagingItemId);
                const packageItem: InventoryItem = localItem || {
                    id: packagingItemId,
                    name: config.packagingName,
                    category: 'Packaging',
                    itemType: 'ingredient',
                    branchId,
                    price: config.price,
                    stockUnits: 0,
                };

                if (!cancelled) {
                    setTakeawayConfig(config);
                    setTakeawayPackagingItem(packageItem);
                }
            } catch (error) {
                console.warn('[TakeOrderModal] Could not load takeaway configuration:', error);
                if (!cancelled) {
                    setTakeawayConfig(null);
                    setTakeawayPackagingItem(null);
                    setIsTakeaway(false);
                }
            }
        };

        void loadTakeawayConfig();
        return () => {
            cancelled = true;
        };
    }, [branchId, isOpen]);

    const menuItems = useMemo(() => {
        const mergedByKey = new Map<string, InventoryItem>();

        localMenuItems
            .filter((item) => item.menuIsVisible !== false)
            .forEach((item) => {
                mergedByKey.set(String(item.id), item);
            });

        backendMenuItems.forEach((item) => {
            const key = String(item.isPreparedMenuItem || item.is_prepared_menu_item ? item.menuEntryId || item.id : item.id);
            mergedByKey.set(key, item);
        });

        return Array.from(mergedByKey.values());
    }, [backendMenuItems, localMenuItems]);

    const categories = useMemo(() => {
        const uniqueCategories = [...new Set(menuItems.map(item => item.category || 'Uncategorized'))];
        return ['All', ...uniqueCategories];
    }, [menuItems]);
    const kitchenInventoryLookup = useMemo(
        () => buildKitchenInventoryLookup(menuItems),
        [menuItems]
    );

    const getPortionDisplay = useCallback((item: InventoryItem, quantity: number) => {
        if (!canSellInPortions(item)) return undefined;
        const display = getPortionQuantityDisplay({
            quantity,
            unitLabel: item.unitType || 'unit',
            portionName: item.portionName || 'portion',
            portionsPerUnit: item.portionsPerUnit,
        });
        return display?.summaryText;
    }, []);

    const handleAddToCart = useCallback((
        item: InventoryItem,
        quantity = 1,
        price?: number,
        selectedOptions: Array<Record<string, unknown>> = []
    ) => {
        if (quantity <= 0) return false;
        const unitPrice = Number(price ?? item.price ?? 0);
        const isPortionSale = Boolean(item.isSoldInPortions && Number(item.portionsPerUnit || 0) > 0);
        const normalizedSelectedOptions = selectedOptions.filter((option) => option && typeof option === 'object');
        const optionsKey = normalizedSelectedOptions
            .map((option) => String(option.id ?? option.name ?? ''))
            .sort()
            .join('|');
        const cartKey = isPortionSale
            ? `${item.id}:portion:${unitPrice}:${optionsKey}`
            : `${item.id}:unit:${unitPrice}:${optionsKey}`;
        setCart(prevCart => {
            const existingItemIndex = prevCart.findIndex(cartItem => cartItem.cartKey === cartKey);
            if (existingItemIndex > -1) {
                const updatedCart = [...prevCart];
                const nextQuantity = Number((updatedCart[existingItemIndex].quantity + quantity).toFixed(6));
                updatedCart[existingItemIndex] = {
                    ...updatedCart[existingItemIndex],
                    quantity: nextQuantity,
                    portionDisplay: getPortionDisplay(item, nextQuantity),
                };
                return updatedCart;
            }
            return [...prevCart, {
                id: item.id,
                cartKey,
                name: item.name,
                quantity,
                price: unitPrice,
                notes: '',
                recipe: item.recipe,
                isPreparedMenuItem: item.isPreparedMenuItem,
                is_prepared_menu_item: item.is_prepared_menu_item,
                isTakeawayPackaging: Boolean(item.isTakeawayPackaging),
                is_takeaway_packaging: Boolean(item.isTakeawayPackaging),
                selectedOptions: normalizedSelectedOptions,
                selected_options: normalizedSelectedOptions,
                menuItemId: item.menuItemId,
                menu_item_id: item.menu_item_id,
                menuEntryId: item.menuEntryId,
                isSoldInPortions: isPortionSale,
                portionName: item.portionName,
                portionsPerUnit: item.portionsPerUnit,
                unitType: item.unitType,
                portionDisplay: getPortionDisplay(item, quantity),
            }];
        });
        return true;
    }, [getPortionDisplay]);

    const selectedOptionSnapshots = useMemo(
        () => selectedOptionsItem
            ? buildSelectedOptionSnapshots(selectedOptionsItem, selectedOptionIds)
            : [],
        [selectedOptionIds, selectedOptionsItem]
    );

    const selectedOptionsPrice = useMemo(
        () => selectedOptionsItem
            ? getConfiguredMenuPrice(selectedOptionsItem, selectedOptionSnapshots)
            : 0,
        [selectedOptionSnapshots, selectedOptionsItem]
    );

    const handleMenuItemClick = useCallback((item: MenuItemWithOptions) => {
        setSelectedMenuItemId(getMenuItemKey(item));
        const optionGroups = getMenuOptionGroups(item);
        if (optionGroups.length > 0) {
            setSelectedOptionsItem(item);
            setSelectedOptionIds(getDefaultOptionIds(item));
            return;
        }
        if (canSellInPortions(item)) {
            setPendingSelectedOptions([]);
            setSelectedPortionItem(item);
            return;
        }
        handleAddToCart(item);
    }, [handleAddToCart]);

    const handleOptionToggle = (group: MenuOptionGroup, optionId: string, checked: boolean) => {
        const groupId = String(group.id);
        const maxSelect = Math.max(1, Number(group.max_select || 1));
        setSelectedOptionIds((current) => {
            const selected = current[groupId] || [];
            if (maxSelect === 1) {
                return { ...current, [groupId]: checked ? [optionId] : [] };
            }
            if (!checked) {
                return { ...current, [groupId]: selected.filter((id) => id !== optionId) };
            }
            if (selected.includes(optionId) || (maxSelect > 0 && selected.length >= maxSelect)) {
                return current;
            }
            return { ...current, [groupId]: [...selected, optionId] };
        });
    };

    const confirmOptions = () => {
        if (!selectedOptionsItem) return;

        const invalidGroup = getMenuOptionGroups(selectedOptionsItem).find((group) => {
            const selectedCount = (selectedOptionIds[String(group.id)] || []).length;
            const minSelect = group.is_required ? Math.max(1, Number(group.min_select || 1)) : Number(group.min_select || 0);
            const maxSelect = Number(group.max_select || 0);
            return selectedCount < minSelect || (maxSelect > 0 && selectedCount > maxSelect);
        });
        if (invalidGroup) {
            const minSelect = invalidGroup.is_required ? Math.max(1, Number(invalidGroup.min_select || 1)) : Number(invalidGroup.min_select || 0);
            toast({
                variant: 'destructive',
                title: `Choose ${invalidGroup.name}`,
                description: minSelect > 0
                    ? `Select at least ${minSelect} option${minSelect === 1 ? '' : 's'}.`
                    : `Choose up to ${invalidGroup.max_select || 1} option${Number(invalidGroup.max_select || 1) === 1 ? '' : 's'}.`,
            });
            return;
        }

        const item = selectedOptionsItem;
        const options = selectedOptionSnapshots;
        setSelectedOptionsItem(null);
        setSelectedOptionIds({});
        if (canSellInPortions(item)) {
            setPendingSelectedOptions(options);
            setSelectedPortionItem(item);
            return;
        }
        handleAddToCart(item, 1, getConfiguredMenuPrice(item, options), options);
    };

    const handleUpdateQuantity = (cartKey: string, delta: number) => {
        setCart(prevCart => {
            const updatedCart = prevCart.map(item => {
                if (item.cartKey === cartKey) {
                    const step = item.isSoldInPortions && Number(item.portionsPerUnit || 0) > 0
                        ? 1 / Number(item.portionsPerUnit || 1)
                        : 1;
                    const nextQuantity = Math.max(0, Number((item.quantity + delta * step).toFixed(6)));
                    const display = item.isSoldInPortions
                        ? getPortionQuantityDisplay({
	                            quantity: nextQuantity,
	                            unitLabel: item.unitType || 'unit',
	                            portionName: item.portionName || 'portion',
	                            portionsPerUnit: item.portionsPerUnit,
	                        })?.summaryText
                        : undefined;
                    return { ...item, quantity: nextQuantity, portionDisplay: display };
                }
                return item;
            });
            return updatedCart.filter(item => item.quantity > 0);
        });
    };
    
    const handleUpdateNotes = (cartKey: string, notes: string) => {
         setCart(prevCart => prevCart.map(item => item.cartKey === cartKey ? { ...item, notes } : item));
    }

    const handleClearCart = () => {
        setCart([]);
        setIsTakeaway(false);
    };

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showCustomerForm, setShowCustomerForm] = useState(false);
    const [customerName, setCustomerName] = useState('');
    const [customerPhone, setCustomerPhone] = useState('');
    const [customerNotes, setCustomerNotes] = useState('');
    const [tableNumber, setTableNumber] = useState('');
    const [orderDestination, setOrderDestination] = useState<OrderDestination>('kitchen');
    const kitchenCartItemCount = useMemo(
        () => kitchenEnabled ? getKitchenOrderItems({ items: cart }, kitchenInventoryLookup).length : 0,
        [cart, kitchenEnabled, kitchenInventoryLookup]
    );
    const hasKitchenCartItems = kitchenEnabled && kitchenCartItemCount > 0;

    const isAddingToExistingOrder = mode === 'add-items' && Boolean(existingOrder);

    const handleTakeawayChange = useCallback((enabled: boolean) => {
        if (enabled && (!takeawayConfig || !takeawayPackagingItem)) {
            toast({
                variant: 'destructive',
                title: 'Takeaway is not configured',
                description: 'Choose a packaging item in Menu settings first.',
            });
            return;
        }

        setIsTakeaway(enabled);
        setCart((previousCart) => {
            const withoutPackaging = previousCart.filter((item) => !item.isTakeawayPackaging);
            if (!enabled || (isAddingToExistingOrder && Boolean(existingOrder?.isTakeaway ?? existingOrder?.is_takeaway))) {
                return withoutPackaging;
            }

            return [
                ...withoutPackaging,
                {
                    id: takeawayPackagingItem!.id,
                    cartKey: `${takeawayPackagingItem!.id}:takeaway`,
                    name: takeawayConfig!.packagingName,
                    quantity: 1,
                    price: takeawayConfig!.price,
                    notes: '',
                    recipe: [],
                    isPreparedMenuItem: false,
                    is_prepared_menu_item: false,
                    isTakeawayPackaging: true,
                },
            ];
        });
    }, [existingOrder, isAddingToExistingOrder, takeawayConfig, takeawayPackagingItem]);

    const handleSendOrderClick = (destination: OrderDestination) => {
        if (cart.length === 0) {
            toast({ variant: 'destructive', title: 'Empty order', description: 'Please add items to the order.' });
            return;
        }
        if (isAddingToExistingOrder) {
            void handleSubmitOrder(destination);
            return;
        }
        const resolvedDestination = destination === 'kitchen' && (!kitchenEnabled || !hasKitchenCartItems) ? 'pos' : destination;
        if (destination === 'kitchen' && resolvedDestination === 'pos') {
            toast({
                title: kitchenEnabled ? 'No kitchen prep needed' : 'Order queue selected',
                description: kitchenEnabled
                    ? 'This order only has purchased/no-recipe items, so it will be ready for sale processing.'
                    : 'Kitchen is only used for restaurant and bar businesses, so this order will be ready for sale processing.',
            });
        }
        setOrderDestination(resolvedDestination);
        setShowCustomerForm(true);
    };

    const getCartSelectedOptions = (item: OrderCartItem): Array<Record<string, unknown>> => {
        const options = Array.isArray(item.selectedOptions ?? item.selected_options)
            ? [...(item.selectedOptions ?? item.selected_options ?? [])]
            : [];
        if (item.isSoldInPortions) {
            options.unshift({
                type: 'portion_sale',
                name: item.portionDisplay || item.portionName || 'Portion',
                group_name: 'Portion',
                quantity: 1,
                price_delta: 0,
                portion_name: item.portionName,
                portions_per_unit: item.portionsPerUnit,
            });
        }
        return options;
    };

    const buildOrderItemsPayload = () => cart.map(item => {
        const isPreparedMenuItem = Boolean(item.isPreparedMenuItem || item.is_prepared_menu_item);
        const menuItemId = item.menuItemId || item.menu_item_id || item.menuEntryId || (isPreparedMenuItem ? item.id : undefined);
        return {
            inventory_item_id: isPreparedMenuItem ? undefined : item.id,
            menu_item_id: menuItemId,
            is_prepared_menu_item: isPreparedMenuItem,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            recipe: Array.isArray(item.recipe) ? item.recipe : [],
            notes: item.notes || undefined,
            is_takeaway_packaging: Boolean(item.isTakeawayPackaging),
            selected_options: getCartSelectedOptions(item),
        };
    });

    const mapCartItemsToLocalOrderItems = () => cart.map(item => ({
        id: item.id,
        inventoryItemId: item.isPreparedMenuItem || item.is_prepared_menu_item ? undefined : item.id,
        menuItemId: item.menuItemId || item.menu_item_id || item.menuEntryId || ((item.isPreparedMenuItem || item.is_prepared_menu_item) ? item.id : undefined),
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        recipe: Array.isArray(item.recipe) ? item.recipe : [],
        isPreparedMenuItem: Boolean(item.isPreparedMenuItem || item.is_prepared_menu_item),
        isTakeawayPackaging: Boolean(item.isTakeawayPackaging),
        is_takeaway_packaging: Boolean(item.isTakeawayPackaging),
        notes: item.notes,
        selectedOptions: getCartSelectedOptions(item),
        selected_options: getCartSelectedOptions(item),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }));

    const handleSubmitOrder = async (forcedDestination?: OrderDestination) => {
        setIsSubmitting(true);

        try {
            const selectedDestination = forcedDestination || orderDestination;
            const resolvedDestination = selectedDestination === 'kitchen' && kitchenEnabled && hasKitchenCartItems ? 'kitchen' : 'pos';
            const orderStatus: TakeOrder['status'] = resolvedDestination === 'pos' ? 'Ready' : 'Sent to Kitchen';
            const itemsPayload = buildOrderItemsPayload();

            if (isAddingToExistingOrder && existingOrder) {
                const updatedOrder = await authFetch.fetch<any>(`/orders/take-orders/${existingOrder.id}/add_items/`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        items: itemsPayload,
                        is_takeaway: isTakeaway,
                    }),
                });

                const localNewItems = mapCartItemsToLocalOrderItems();
                const mergedOrder: TakeOrder = {
                    ...existingOrder,
                    status: updatedOrder?.status || existingOrder.status,
                    items: Array.isArray(updatedOrder?.items)
                        ? updatedOrder.items.map((item: any) => ({
                            id: item.id || item.inventory_item_id || item.menu_item_id || crypto.randomUUID(),
                            inventoryItemId: item.inventory_item_id,
                            menuItemId: item.menu_item_id,
                            name: item.name,
                            quantity: Number(item.quantity || 0),
                            price: Number(item.price || 0),
                            recipe: Array.isArray(item.recipe) ? item.recipe : [],
                            isPreparedMenuItem: Boolean(item.is_prepared_menu_item),
                            isTakeawayPackaging: Boolean(item.is_takeaway_packaging),
                            is_takeaway_packaging: Boolean(item.is_takeaway_packaging),
                            notes: item.notes,
                            selectedOptions: Array.isArray(item.selected_options) ? item.selected_options : [],
                            selected_options: Array.isArray(item.selected_options) ? item.selected_options : [],
                            createdAt: item.created_at || new Date().toISOString(),
                            updatedAt: item.updated_at || new Date().toISOString(),
                        }))
                        : [...(existingOrder.items || []), ...localNewItems],
                    updatedAt: updatedOrder?.updated_at || new Date().toISOString(),
                };

                await db.takeOrders.put(mergedOrder);
                onOrderUpdated?.(mergedOrder);
                window.dispatchEvent(new CustomEvent('handypos-orders-changed'));
                toast({
                    title: 'Items added',
                    description: `Order ${existingOrder.orderNumber} has been updated.`,
                });
                handleClearCart();
                onOpenChange(false);
                return;
            }

            // Prepare the take order payload
            const payload = {
                branch_id: normalizeBranchId(branchId),
                status: orderStatus,
                is_takeaway: isTakeaway,
                table_number: tableNumber || undefined,
                customer_name: customerName || undefined,
                customer_phone: customerPhone || undefined,
                customer_notes: customerNotes || undefined,
                items: itemsPayload,
            };

            // Send to backend API
            console.log('[TakeOrderModal] Sending payload:', payload);
            const createdOrder = await authFetch.fetch('/orders/take-orders/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            console.log('[TakeOrderModal] Response from backend:', createdOrder);
            
            if (!createdOrder || !createdOrder.id) {
                console.error('[TakeOrderModal] Invalid response structure:', createdOrder);
                throw new Error(`Failed to create take order - invalid response: ${JSON.stringify(createdOrder)}`);
            }

            // Also save to local IndexedDB for offline support
            const takeOrder: TakeOrder = {
                id: createdOrder.id,
                orderNumber: createdOrder.order_number,
                branchId,
                status: orderStatus,
                tableNumber: tableNumber || undefined,
                customerName: createdOrder.customer_name,
                customerPhone: createdOrder.customer_phone,
                customerNotes: createdOrder.customer_notes,
                items: mapCartItemsToLocalOrderItems(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    orderType: 'staff',
                    isTakeaway,
                    is_takeaway: isTakeaway,
                };

            await db.takeOrders.add(takeOrder);
            window.dispatchEvent(new CustomEvent('handypos-orders-changed'));

            toast({
                title: resolvedDestination === 'pos' ? 'Order Ready for Sale' : 'Order Sent to Kitchen',
                description: resolvedDestination === 'pos'
                    ? `Order ${createdOrder.order_number} is ready for sale processing from Orders.`
                    : `Order ${createdOrder.order_number} has been created successfully.`,
            });

            // Reset form
            handleClearCart();
            setTableNumber('');
            setCustomerName('');
            setCustomerPhone('');
            setCustomerNotes('');
            setShowCustomerForm(false);
            onOpenChange(false);
        } catch (error) {
            console.error('Failed to send order:', error);
            toast({
                variant: 'destructive',
                title: isAddingToExistingOrder ? 'Failed to Add Items' : 'Failed to Send Order',
                description: error instanceof Error ? error.message : 'An error occurred while saving the order.',
            });
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const subtotal = cart.reduce((acc, item) => acc + item.price * item.quantity, 0);

  return (
    <>
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="tauri-android-sidebar-safe-top left-0 top-0 m-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 [&>button]:top-[calc(env(safe-area-inset-top,0px)+1rem)] sm:left-[50%] sm:top-[50%] sm:h-[90vh] sm:max-h-[90vh] sm:w-[95vw] sm:max-w-[95vw] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:[&>button]:top-4">
        <DialogHeader className="p-4 sm:p-6 pb-2 sm:pb-2 shrink-0">
          <DialogTitle className="text-xl sm:text-2xl">
            {isAddingToExistingOrder ? `Add Items to Order ${existingOrder?.orderNumber}` : 'Take a New Order'}
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            {isAddingToExistingOrder
                ? 'Add more items to this open order before processing one final sale.'
                : "Select items from the menu to build the customer's order."}
          </DialogDescription>
        </DialogHeader>
        
        {/* Mobile uses one focused panel at a time; desktop keeps menu and cart side by side. */}
        <div className="flex flex-1 min-h-0 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* Menu Items */}
            <div className={`${mobilePanel === 'menu' ? 'flex' : 'hidden'} min-h-0 h-full flex-col overflow-hidden border-r lg:flex`}>
                <Tabs defaultValue="All" className="flex h-full min-h-0 flex-col overflow-hidden">
                    <TabsList className="mx-3 w-[calc(100%-1.5rem)] shrink-0 justify-start overflow-x-auto">
                        {categories.map(category => (
                            <TabsTrigger key={category} value={category} className="shrink-0">{category}</TabsTrigger>
                        ))}
                    </TabsList>
                    <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                        {categories.map(category => (
                            <TabsContent key={category} value={category} className="mt-0">
                                <div className="grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
                                {menuItems
                                    .filter(item => category === 'All' || item.category === category)
                                    .map(item => {
                                        const optionGroups = getMenuOptionGroups(item);
                                        const isSelected = selectedMenuItemId === getMenuItemKey(item);
                                        return (
                                        <Card
                                            key={item.id}
                                            className={`cursor-pointer overflow-hidden transition-shadow hover:shadow-md ${isSelected ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : ''}`}
                                            onClick={() => handleMenuItemClick(item)}
                                            aria-pressed={isSelected}
                                        >
                                            {/* Image Section */}
                                            <div className="relative flex h-24 items-center justify-center overflow-hidden bg-muted sm:h-32">
                                                {item.image ? (
                                                    <img
                                                        src={item.image}
                                                        alt={item.name}
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <ShoppingBasket className="h-12 w-12 text-muted-foreground" />
                                                )}
                                            </div>
                                            {/* Item Info */}
                                            <CardContent className="p-2 text-center sm:p-3">
                                                <p className="line-clamp-2 text-sm font-semibold sm:text-base">{item.name}</p>
                                                <p className="text-sm text-muted-foreground">{formatCurrency(item.price || 0)}</p>
                                                {canSellInPortions(item) && (
                                                    <p className="text-[11px] text-muted-foreground">
                                                        or {formatCurrency(Number(item.portionPrice || item.portion_price || 0) || Number(item.price || 0) / Number(item.portionsPerUnit || 1))}/{item.portionName || 'portion'}
                                                    </p>
                                                )}
                                                {optionGroups.length > 0 && (
                                                    <p className="mt-1 text-[11px] font-medium text-primary">
                                                        {optionGroups.length} choice set{optionGroups.length === 1 ? '' : 's'} available
                                                    </p>
                                                )}
                                            </CardContent>
                                        </Card>
                                        );
                                    })}
                                </div>
                            </TabsContent>
                        ))}
                    </div>
                </Tabs>
            </div>
            
            {/* Cart */}
            <div className={`${mobilePanel === 'order' ? 'flex' : 'hidden'} min-h-0 h-full flex-col bg-muted/30 lg:flex`}>
                <div className="p-3 sm:p-4 border-b shrink-0">
                    <h3 className="text-base sm:text-lg font-semibold flex justify-between items-center">
                        <span>Current Order</span>
                         {cart.length > 0 && (
                            <Button variant="ghost" size="sm" className="text-destructive h-7 sm:h-8 text-xs sm:text-sm" onClick={handleClearCart}>
                                <Trash2 className="mr-1 h-3 w-3 sm:h-4 sm:w-4" /> Clear
                            </Button>
                        )}
                    </h3>
                </div>

                <div className="flex-1 overflow-y-auto p-2 sm:p-4 space-y-2 min-h-0">
                {cart.length > 0 ? (
                    cart.map(item => (
                        <div key={item.cartKey} className="rounded-lg border bg-background p-3 transition-shadow hover:shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate">{item.name}</p>
                                    {item.isTakeawayPackaging && (
                                        <p className="text-xs font-medium text-primary">Packaging for takeaway</p>
                                    )}
                                    {getCartSelectedOptions(item).filter((option) => option.type !== 'portion_sale').length > 0 && (
                                        <p className="text-xs text-muted-foreground">
                                            {getCartSelectedOptions(item)
                                                .filter((option) => option.type !== 'portion_sale')
                                                .map((option) => String(option.name || ''))
                                                .filter(Boolean)
                                                .join(', ')}
                                        </p>
                                    )}
                                    <p className="text-xs text-muted-foreground">{formatCurrency(item.price)}</p>
                                    {item.portionDisplay && (
                                        <p className="text-xs font-medium text-muted-foreground">{item.portionDisplay}</p>
                                    )}
                                </div>
                                {!item.isTakeawayPackaging && <div className="flex items-center gap-1 shrink-0">
                                    <Button 
                                        size="icon" 
                                        variant="ghost" 
                                        className="h-6 w-6 text-muted-foreground hover:text-foreground" 
                                        onClick={() => handleUpdateQuantity(item.cartKey, -1)}
                                    >
                                        <Minus className="h-3 w-3"/>
                                    </Button>
                                    <span className="min-w-8 text-center text-sm font-semibold">
                                        {item.isSoldInPortions && item.portionDisplay
                                            ? Math.round(item.quantity * Number(item.portionsPerUnit || 1))
                                            : item.quantity}
                                    </span>
                                    <Button 
                                        size="icon" 
                                        variant="ghost" 
                                        className="h-6 w-6 text-muted-foreground hover:text-foreground" 
                                        onClick={() => handleUpdateQuantity(item.cartKey, 1)}
                                    >
                                        <Plus className="h-3 w-3"/>
                                    </Button>
                                </div>}
                                <div className="text-right shrink-0">
                                    <p className="font-bold text-sm">{formatCurrency(item.price * item.quantity)}</p>
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                        <ShoppingBasket className="h-16 w-16" />
                        <p className="mt-4 text-sm">Your order is empty.</p>
                        <p className="text-xs">Select items from the menu to begin.</p>
                    </div>
                )}
                </div>
                <div className="p-4 border-t mt-auto space-y-4 bg-background">
                    {takeawayConfig && (
                        <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/40 p-3">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4 accent-primary"
                                checked={isTakeaway}
                                onChange={(event) => handleTakeawayChange(event.target.checked)}
                            />
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                                    <span>Take away</span>
                                    <span>{formatCurrency(takeawayConfig.price)}</span>
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                    Adds {takeawayConfig.packagingName} once and deducts it from stock when sold.
                                </span>
                            </span>
                        </label>
                    )}
                    <div className="flex justify-between font-bold text-xl">
                        <span>Subtotal</span>
                        <span>{formatCurrency(subtotal)}</span>
                    </div>
                    <div className={`grid gap-2 ${kitchenEnabled ? 'sm:grid-cols-2' : ''}`}>
                        {kitchenEnabled && (
                            <Button size="lg" disabled={cart.length === 0} onClick={() => handleSendOrderClick('kitchen')}>
                                <Send className="mr-2 h-5 w-5"/> {hasKitchenCartItems ? 'Send to Kitchen' : 'Ready for Sale'}
                            </Button>
                        )}
                        <Button
                            size="lg"
                            variant={kitchenEnabled ? 'secondary' : 'default'}
                            disabled={cart.length === 0}
                            onClick={() => handleSendOrderClick('pos')}
                        >
                            <ShoppingBasket className="mr-2 h-5 w-5"/> {kitchenEnabled ? 'Ready for Sale' : 'Send to Orders'}
                        </Button>
                    </div>
                </div>
            </div>
        </div>

        <div className="tauri-android-floating-bottom pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-end px-4 lg:hidden">
            <Button
                type="button"
                size="icon"
                className="pointer-events-auto relative h-12 w-12 rounded-full shadow-lg"
                onClick={() => setMobilePanel(mobilePanel === 'menu' ? 'order' : 'menu')}
                aria-label={mobilePanel === 'menu' ? 'View current order' : 'Back to menu'}
                title={mobilePanel === 'menu' ? 'View current order' : 'Back to menu'}
            >
                {mobilePanel === 'menu' ? (
                    <ShoppingBasket className="h-5 w-5" />
                ) : (
                    <ArrowLeft className="h-5 w-5" />
                )}
                {mobilePanel === 'menu' && cart.length > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                        {cart.length > 9 ? '9+' : cart.length}
                    </span>
                )}
            </Button>
        </div>

        {/* Customer Form Modal */}
        {showCustomerForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-md">
              <CardHeader>
                <CardTitle>Customer Information</CardTitle>
                <CardDescription>
                  {orderDestination === 'pos'
                    ? 'Send this order to the ready-for-sale queue. A cashier can process it from Orders.'
                    : kitchenEnabled
                      ? 'Send this order to the kitchen screen.'
                      : 'Send this order to the ready-for-sale queue.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Table Number</label>
                  <Input
                    placeholder="Enter table number"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Customer Name</label>
                  <Input
                    placeholder="Enter customer name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Phone Number</label>
                  <Input
                    placeholder="Enter phone number"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Special Instructions</label>
                  <Textarea
                    placeholder="Add any special instructions..."
                    value={customerNotes}
                    onChange={(e) => setCustomerNotes(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowCustomerForm(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700"
                  onClick={() => void handleSubmitOrder()}
                  disabled={isSubmitting}
                >
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isSubmitting
                    ? 'Sending...'
                    : orderDestination === 'pos'
                      ? kitchenEnabled ? 'Mark Ready for Sale' : 'Send to Orders'
                      : kitchenEnabled ? 'Send to Kitchen' : 'Send to Orders'}
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}
      </DialogContent>
    </Dialog>
    <Dialog
        open={Boolean(selectedOptionsItem)}
        onOpenChange={(open) => {
            if (!open) {
                setSelectedOptionsItem(null);
                setSelectedOptionIds({});
            }
        }}
    >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
                <DialogTitle>Choose options{selectedOptionsItem ? ` for ${selectedOptionsItem.name}` : ''}</DialogTitle>
                <DialogDescription>
                    Select the choices that should be included with this order item. Stock linked to a choice is deducted when the sale is processed.
                </DialogDescription>
            </DialogHeader>

            {selectedOptionsItem && (
                <div className="space-y-4 py-2">
                    {getMenuOptionGroups(selectedOptionsItem).map((group) => {
                        const groupId = String(group.id);
                        const selectedIds = selectedOptionIds[groupId] || [];
                        const maxSelect = Math.max(1, Number(group.max_select || 1));
                        const rule = group.is_required
                            ? `Required${maxSelect > 1 ? ` · choose up to ${maxSelect}` : ''}`
                            : maxSelect > 1 ? `Optional · choose up to ${maxSelect}` : 'Optional';

                        return (
                            <section key={groupId} className="space-y-2 rounded-lg border p-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="font-semibold">{group.name}</p>
                                        <p className="text-xs text-muted-foreground">{rule}</p>
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {selectedIds.length}/{maxSelect}
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    {group.options
                                        .filter((option) => option.is_visible !== false)
                                        .map((option) => {
                                            const optionId = String(option.id);
                                            const checked = selectedIds.includes(optionId);
                                            const optionDelta = Number(option.price_delta || 0);
                                            const optionOverride = Number(option.price_override);
                                            const optionPrice = option.price_mode === 'override' && Number.isFinite(optionOverride)
                                                ? `Set to ${formatCurrency(optionOverride)}`
                                                : optionDelta === 0
                                                    ? 'Included'
                                                    : `${optionDelta > 0 ? '+' : ''}${formatCurrency(optionDelta)}`;

                                            return (
                                                <label
                                                    key={optionId}
                                                    htmlFor={`take-order-option-${groupId}-${optionId}`}
                                                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
                                                >
                                                    <input
                                                        id={`take-order-option-${groupId}-${optionId}`}
                                                        type={maxSelect === 1 ? 'radio' : 'checkbox'}
                                                        name={`take-order-option-group-${groupId}`}
                                                        checked={checked}
                                                        onChange={(event) => handleOptionToggle(group, optionId, event.target.checked)}
                                                        className="mt-1 h-4 w-4 accent-primary"
                                                    />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="flex items-start justify-between gap-3 text-sm font-medium">
                                                            <span>{option.name}</span>
                                                            <span className="shrink-0 text-muted-foreground">{optionPrice}</span>
                                                        </span>
                                                        {option.description && (
                                                            <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                                                        )}
                                                    </span>
                                                </label>
                                            );
                                        })}
                                </div>
                            </section>
                        );
                    })}

                    <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
                        <span className="text-sm text-muted-foreground">Price after choices</span>
                        <span className="font-semibold">{formatCurrency(selectedOptionsPrice)}</span>
                    </div>
                </div>
            )}

            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSelectedOptionsItem(null)}
                >
                    Cancel
                </Button>
                <Button type="button" onClick={confirmOptions}>
                    Add to order
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
    <PortionSaleDialog
        item={selectedPortionItem}
        open={!!selectedPortionItem}
        onOpenChange={(open) => {
            if (!open) {
                setSelectedPortionItem(null);
                setPendingSelectedOptions([]);
            }
        }}
        selectedOptions={pendingSelectedOptions}
        onAddToCart={handleAddToCart}
    />
    </>
  );
}
