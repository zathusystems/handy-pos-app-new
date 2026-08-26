
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

const buildTakeOrderMenuItem = (
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
    const [selectedPortionItem, setSelectedPortionItem] = useState<InventoryItem | null>(null);
    const [backendMenuItems, setBackendMenuItems] = useState<InventoryItem[]>([]);
    const [mobilePanel, setMobilePanel] = useState<'menu' | 'order'>('menu');
    const kitchenEnabled = isKitchenBusinessType(businessType);

    useEffect(() => {
        if (isOpen) {
            setMobilePanel('menu');
        }
    }, [isOpen]);
    
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

    const handleAddToCart = useCallback((item: InventoryItem, quantity = 1, price?: number) => {
        if (quantity <= 0) return false;
        const unitPrice = Number(price ?? item.price ?? 0);
        const isPortionSale = Boolean(item.isSoldInPortions && Number(item.portionsPerUnit || 0) > 0);
        const cartKey = isPortionSale
            ? `${item.id}:portion:${unitPrice}`
            : `${item.id}:unit:${unitPrice}`;
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

    const handleMenuItemClick = useCallback((item: InventoryItem) => {
        if (canSellInPortions(item)) {
            setSelectedPortionItem(item);
            return;
        }
        handleAddToCart(item);
    }, [handleAddToCart]);

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

    const handleClearCart = () => setCart([]);

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
            selected_options: item.isSoldInPortions ? [{
                type: 'portion_sale',
                name: item.portionDisplay || item.portionName || 'Portion',
                group_name: 'Portion',
                quantity: 1,
                price_delta: 0,
                portion_name: item.portionName,
                portions_per_unit: item.portionsPerUnit,
            }] : [],
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
        notes: item.notes,
        selectedOptions: item.isSoldInPortions ? [{
            type: 'portion_sale',
            name: item.portionDisplay || item.portionName || 'Portion',
            group_name: 'Portion',
            quantity: 1,
            price_delta: 0,
            portion_name: item.portionName,
            portions_per_unit: item.portionsPerUnit,
        }] : [],
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
                            notes: item.notes,
                            selectedOptions: Array.isArray(item.selected_options) ? item.selected_options : [],
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
                    .map(item => (
                                        <Card key={item.id} className="cursor-pointer hover:shadow-md overflow-hidden transition-shadow" onClick={() => handleMenuItemClick(item)}>
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
                                            </CardContent>
                                        </Card>
                                    ))}
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
                                    <p className="text-xs text-muted-foreground">{formatCurrency(item.price)}</p>
                                    {item.portionDisplay && (
                                        <p className="text-xs font-medium text-muted-foreground">{item.portionDisplay}</p>
                                    )}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
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
                                </div>
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
    <PortionSaleDialog
        item={selectedPortionItem}
        open={!!selectedPortionItem}
        onOpenChange={(open) => {
            if (!open) {
                setSelectedPortionItem(null);
            }
        }}
        onAddToCart={handleAddToCart}
    />
    </>
  );
}
