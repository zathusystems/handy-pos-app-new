'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Clock,
  ClipboardList,
  Hash,
  Loader2,
  Phone,
  RefreshCw,
  ShoppingBag,
  StickyNote,
  User,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { useOrderNotificationSound } from '@/hooks/use-order-notification-sound';
import { useCurrency } from '@/hooks/use-currency';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';
import {
  readStoredBusinessSettingsObject,
  readStoredCustomSalesSectionSettings,
  resolveCustomSalesSectionSettings,
} from '@/lib/custom-sales-section';
import {
  buildKitchenInventoryLookup,
  getCustomSalesSectionOrderItems,
  getNonCustomSalesSectionOrderItems,
  resolveKitchenInventoryItem,
  type KitchenInventoryLookup,
} from '@/lib/kitchen-order-routing';
import { formatQuantityWithUnit, getPortionQuantityDisplay } from '@/lib/quantity-format';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type DisplayOrderStatus = 'Pending' | 'Confirmed' | 'Sent to Kitchen' | 'Preparing' | 'Ready' | 'Completed' | 'Cancelled';

interface DisplayOrderItem {
  id: string;
  inventory_item_id?: string;
  inventoryItemId?: string;
  name: string;
  quantity: number | string;
  price?: number | string;
  subtotal?: number | string;
  total?: number | string;
  notes?: string;
  selected_options?: Array<Record<string, unknown>>;
  selectedOptions?: Array<Record<string, unknown>>;
}

interface DisplayOrder {
  id: string;
  order_number: number;
  status: DisplayOrderStatus;
  customer_name?: string;
  customer_phone?: string;
  customer_notes?: string;
  table_number?: string;
  special_instructions?: string;
  items: DisplayOrderItem[];
  created_at: string;
  updated_at: string;
}

interface SectionInventoryItem {
  id: string;
  name: string;
  category?: string;
  itemType: string;
  stockUnits: number;
  unitType: string;
  isSoldInPortions: boolean;
  portionName?: string;
  portionsPerUnit?: number;
  reorderLevel: number;
  status?: string;
}

interface SoldSectionProduct {
  id: string;
  name: string;
  quantity: number;
  salesValue: number;
  orderCount: number;
  unitType: string;
  isSoldInPortions: boolean;
  portionName?: string;
  portionsPerUnit?: number;
}

const statusColors: Record<string, string> = {
  Pending: 'bg-blue-100 text-blue-800',
  Confirmed: 'bg-purple-100 text-purple-800',
  'Sent to Kitchen': 'bg-orange-100 text-orange-800',
  Preparing: 'bg-yellow-100 text-yellow-800',
  Ready: 'bg-green-100 text-green-800',
  Completed: 'bg-gray-100 text-gray-800',
  Cancelled: 'bg-red-100 text-red-800',
};

const activeStatuses = new Set<DisplayOrderStatus>(['Pending', 'Confirmed', 'Sent to Kitchen', 'Preparing', 'Ready']);

const normalizeBranchId = (value: string | null): string => {
  const normalized = String(value || '').trim();
  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const readTakeOrdersFromResponse = (response: unknown): DisplayOrder[] => {
  if (Array.isArray(response)) return response as DisplayOrder[];
  if (response && typeof response === 'object' && Array.isArray((response as any).results)) {
    return (response as any).results as DisplayOrder[];
  }
  return [];
};

const readItemsFromResponse = (response: unknown): any[] => {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object' && Array.isArray((response as any).results)) {
    return (response as any).results;
  }
  return [];
};

const readCompletedSalesFromResponse = (response: unknown): DisplayOrder[] =>
  readTakeOrdersFromResponse(response).filter((order) =>
    String(order.status || '').trim().toLowerCase() === 'completed'
  );

const getMinutesAgo = (dateString: string): string => {
  const createdTime = new Date(dateString);
  const diffMs = Date.now() - createdTime.getTime();
  const minutesAgo = Math.max(0, Math.floor(diffMs / 60000));

  if (minutesAgo < 1) return 'Just now';
  if (minutesAgo === 1) return '1 min ago';
  if (minutesAgo < 60) return `${minutesAgo} min ago`;

  const hoursAgo = Math.floor(minutesAgo / 60);
  if (hoursAgo === 1) return '1 hr ago';
  return `${hoursAgo} hrs ago`;
};

const getSelectedOptions = (item: DisplayOrderItem): Array<Record<string, any>> => {
  const selected = item.selectedOptions ?? item.selected_options;
  return Array.isArray(selected) ? selected.filter((option) => option && typeof option === 'object') : [];
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isMarkedForCustomSection = (item: any): boolean =>
  item?.showInCustomSalesSection === true ||
  item?.show_in_custom_sales_section === true ||
  item?.showInCustomSalesSection === 'true' ||
  item?.show_in_custom_sales_section === 'true';

const normalizeSectionInventoryItem = (item: any): SectionInventoryItem => ({
  id: String(item?.id || ''),
  name: String(item?.name || 'Unnamed product'),
  category: String(item?.category || '').trim() || undefined,
  itemType: String(item?.itemType ?? item?.item_type ?? 'sellable').trim().toLowerCase() || 'sellable',
  stockUnits: toFiniteNumber(item?.stockUnits ?? item?.stock_units, 0),
  unitType: String(item?.unitType ?? item?.unit_type ?? 'unit').trim() || 'unit',
  isSoldInPortions: item?.isSoldInPortions === true || item?.is_sold_in_portions === true ||
    item?.isSoldInPortions === 'true' || item?.is_sold_in_portions === 'true',
  portionName: String(item?.portionName ?? item?.portion_name ?? '').trim() || undefined,
  portionsPerUnit: toFiniteNumber(item?.portionsPerUnit ?? item?.portions_per_unit, 0) || undefined,
  reorderLevel: toFiniteNumber(item?.reorderLevel ?? item?.reorder_level, 0),
  status: String(item?.status || '').trim() || undefined,
});

export default function CustomSalesSectionPage() {
  const { toast } = useToast();
  const { business, loading: isAuthLoading } = useAuth();
  const { format: formatCurrency } = useCurrency();
  const businessRecord = useLiveQuery(
    () => business?.id ? db.business.get(business.id) : undefined,
    [business?.id]
  );
  const [settings, setSettings] = useState({ enabled: false, name: '' });
  const [orders, setOrders] = useState<DisplayOrder[]>([]);
  const [soldOrders, setSoldOrders] = useState<DisplayOrder[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const initialSettings = resolveCustomSalesSectionSettings(
      businessRecord as Record<string, any> | null,
      readStoredCustomSalesSectionSettings()
    );
    setSettings(initialSettings);
    const activeBranch = localStorage.getItem('handypos-active-branch');
    if (activeBranch) {
      setBranchId(activeBranch);
    }
  }, [businessRecord]);

  useEffect(() => {
    if (!business?.id || typeof window === 'undefined') {
      return;
    }

    let cancelled = false;

    const loadBusinessSettings = async () => {
      try {
        const response = await authFetch.fetch(`/business/businesses/${business.id}/business_settings/`);
        if (cancelled) {
          return;
        }

        const resolved = resolveCustomSalesSectionSettings(
          response as Record<string, any>,
          readStoredCustomSalesSectionSettings()
        );
        setSettings(resolved);

        const existing = await db.business.get(business.id);
        if (existing) {
          await db.business.put({
            ...existing,
            enableCustomSalesSection: resolved.enabled,
            enable_custom_sales_section: resolved.enabled,
            customSalesSectionName: resolved.name,
            custom_sales_section_name: resolved.name,
          });
        }

        window.localStorage.setItem('handypos-business-settings', JSON.stringify({
          ...readStoredBusinessSettingsObject(),
          enableCustomSalesSection: resolved.enabled,
          enable_custom_sales_section: resolved.enabled,
          customSalesSectionName: resolved.name,
          custom_sales_section_name: resolved.name,
        }));
        window.dispatchEvent(new Event('handypos-business-settings-changed'));
      } catch (error) {
        console.warn('[CustomSection] Failed to refresh custom section settings:', error);
      }
    };

    void loadBusinessSettings();

    return () => {
      cancelled = true;
    };
  }, [business?.id]);

  const fetchOrders = async () => {
    if (!branchId) return;

    try {
      setIsLoading(true);
      const backendBranchId = normalizeBranchId(branchId);
      const [ordersData, inventoryData, salesData] = await Promise.all([
        authFetch.fetch(`/orders/take-orders/?branch_id=${encodeURIComponent(backendBranchId)}`),
        authFetch.fetch(`/inventory/items/?branch_id=${encodeURIComponent(backendBranchId)}`),
        authFetch.fetch(`/sessions/orders/?branch_id=${encodeURIComponent(backendBranchId)}`),
      ]);

      setOrders(readTakeOrdersFromResponse(ordersData));
      setSoldOrders(readCompletedSalesFromResponse(salesData));
      setInventoryItems(readItemsFromResponse(inventoryData));
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      console.error('[CustomSection] Failed to fetch orders:', error);
      toast({
        variant: 'destructive',
        title: 'Could not refresh orders',
        description: `Failed to load ${settings.name || 'section'} orders.`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (branchId && settings.enabled) {
      void fetchOrders();
    } else {
      setIsLoading(false);
    }

    if (!autoRefresh || !branchId || !settings.enabled) return;

    const interval = setInterval(() => {
      void fetchOrders();
    }, 10000);

    return () => clearInterval(interval);
  }, [branchId, settings.enabled, autoRefresh]);

  const inventoryLookup = useMemo(
    () => buildKitchenInventoryLookup(inventoryItems),
    [inventoryItems]
  );

  const sectionOrders = useMemo(
    () => orders
      .filter((order) => activeStatuses.has(order.status))
      .filter((order) => getCustomSalesSectionOrderItems(order, inventoryLookup).length > 0),
    [orders, inventoryLookup]
  );

  const sectionSoldOrders = useMemo(
    () => soldOrders.filter((order) => getCustomSalesSectionOrderItems(order, inventoryLookup).length > 0),
    [soldOrders, inventoryLookup]
  );

  const sectionInventoryItems = useMemo(
    () =>
      inventoryItems
        .filter(isMarkedForCustomSection)
        .map(normalizeSectionInventoryItem)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [inventoryItems]
  );

  const lowStockItems = useMemo(
    () =>
      sectionInventoryItems.filter(
        (item) =>
          item.stockUnits <= 0 ||
          item.status === 'Out of Stock' ||
          (item.reorderLevel > 0 && item.stockUnits <= item.reorderLevel)
      ),
    [sectionInventoryItems]
  );

  useOrderNotificationSound(
    sectionOrders
      .filter((order) => order.status === 'Pending' || order.status === 'Confirmed' || order.status === 'Sent to Kitchen')
      .map((order) => order.id),
    settings.enabled
  );

  const itemCount = sectionOrders.reduce(
    (sum, order) => sum + getCustomSalesSectionOrderItems(order, inventoryLookup).length,
    0
  );

  const sectionSoldProducts = useMemo(() => {
    const productMap = new Map<string, SoldSectionProduct & { orderIds: Set<string> }>();

    sectionSoldOrders.forEach((order) => {
      getCustomSalesSectionOrderItems(order, inventoryLookup).forEach((item) => {
        const inventoryItem = resolveKitchenInventoryItem(item, inventoryLookup);
        const rawInventoryId = String(
          inventoryItem?.id ?? item.inventoryItemId ?? item.inventory_item_id ?? ''
        ).trim();
        const normalizedName = String(item.name || 'Unnamed product').trim().toLowerCase();
        const productId = rawInventoryId || `name:${normalizedName}`;
        const quantity = Math.max(0, toFiniteNumber(item.quantity, 0));
        if (quantity <= 0) {
          return;
        }

        const lineTotal = toFiniteNumber(item.total, Number.NaN);
        const unitPrice = toFiniteNumber(item.price, 0);
        const salesValue = Math.max(0, Number.isFinite(lineTotal) ? lineTotal : unitPrice * quantity);
        const existing = productMap.get(productId) || {
          id: productId,
          name: String(inventoryItem?.name || item.name || 'Unnamed product').trim(),
          quantity: 0,
          salesValue: 0,
          orderCount: 0,
          unitType: String((inventoryItem as any)?.unitType ?? (inventoryItem as any)?.unit_type ?? 'unit').trim() || 'unit',
          isSoldInPortions: Boolean(
            (inventoryItem as any)?.isSoldInPortions ?? (inventoryItem as any)?.is_sold_in_portions
          ),
          portionName: String(
            (inventoryItem as any)?.portionName ?? (inventoryItem as any)?.portion_name ?? ''
          ).trim() || undefined,
          portionsPerUnit: toFiniteNumber(
            (inventoryItem as any)?.portionsPerUnit ?? (inventoryItem as any)?.portions_per_unit,
            0
          ) || undefined,
          orderIds: new Set<string>(),
        };

        existing.quantity += quantity;
        existing.salesValue += salesValue;
        existing.orderIds.add(String(order.id));
        existing.orderCount = existing.orderIds.size;
        productMap.set(productId, existing);
      });
    });

    return Array.from(productMap.values())
      .map(({ orderIds, ...product }) => product)
      .sort((a, b) => b.salesValue - a.salesValue || b.quantity - a.quantity);
  }, [sectionSoldOrders, inventoryLookup]);

  const lastUpdatedLabel = lastUpdatedAt ? getMinutesAgo(lastUpdatedAt) : 'Not refreshed yet';

  if (isAuthLoading || businessRecord === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!settings.enabled) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Boxes className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-semibold">Custom section is not enabled</p>
              <p className="text-sm text-muted-foreground">
                Enable it in Settings, name it, then mark products to show here.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-card text-primary sm:h-11 sm:w-11">
            <Boxes className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{settings.name}</h1>
              {autoRefresh && (
                <Badge variant="secondary" className="gap-1">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  Live
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Display only. Orders remain managed from Orders and POS.
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
          <p className="text-xs text-muted-foreground sm:mr-1">Updated {lastUpdatedLabel}</p>
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="w-full gap-2 sm:w-auto"
          >
            <Clock className="h-4 w-4" />
            {autoRefresh ? 'Live On' : 'Live Off'}
          </Button>
          <Button variant="outline" onClick={() => void fetchOrders()} disabled={isLoading} className="w-full gap-2 sm:w-auto">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        <StatCard title="Orders" value={sectionOrders.length} icon={AlertCircle} />
        <StatCard title="Items" value={itemCount} icon={Boxes} />
        <StatCard title="Products" value={sectionInventoryItems.length} icon={CheckCircle2} />
      </div>

      <Tabs defaultValue="orders" className="space-y-4">
        <TabsList className="grid h-auto w-full max-w-lg grid-cols-3">
          <TabsTrigger value="orders" className="gap-2 py-2.5">
            <ClipboardList className="h-4 w-4" />
            Orders
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[11px]">
              {sectionOrders.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="stock" className="gap-2 py-2.5">
            <Boxes className="h-4 w-4" />
            Stock
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[11px]">
              {sectionInventoryItems.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="sold" className="gap-2 py-2.5">
            <ShoppingBag className="h-4 w-4" />
            Sold
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[11px]">
              {sectionSoldProducts.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="mt-0">
          <section className="rounded-lg border bg-background">
        <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div>
            <h2 className="text-base font-semibold">Section Stock</h2>
            <p className="text-xs text-muted-foreground">
              Products marked to appear in {settings.name}, with current stock and reorder warnings.
            </p>
          </div>
          <Badge variant={lowStockItems.length > 0 ? 'destructive' : 'secondary'}>
            {lowStockItems.length} need attention
          </Badge>
        </div>
        <div className="divide-y">
          {isLoading && sectionInventoryItems.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : sectionInventoryItems.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Boxes className="h-6 w-6" />
              <p className="text-sm">No products are marked for {settings.name} yet.</p>
            </div>
          ) : (
            sectionInventoryItems.map((item) => {
              const needsAttention =
                item.stockUnits <= 0 ||
                item.status === 'Out of Stock' ||
                (item.reorderLevel > 0 && item.stockUnits <= item.reorderLevel);
              const portionQuantityDisplay =
                item.itemType === 'sellable' && item.isSoldInPortions && item.portionsPerUnit
                  ? getPortionQuantityDisplay({
                      quantity: item.stockUnits,
                      unitLabel: item.unitType,
                      portionName: item.portionName || 'portion',
                      portionsPerUnit: item.portionsPerUnit,
                    })
                  : null;
              return (
                <div key={item.id} className="grid gap-3 p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.category || 'Uncategorized'}</p>
                  </div>
                  <div className="text-sm sm:text-right">
                    {portionQuantityDisplay ? (
                      <>
                        <p className="font-semibold">{portionQuantityDisplay.wholeUnitsText}</p>
                        <p className="text-xs text-muted-foreground">
                          {portionQuantityDisplay.remainingPortionsText} remaining
                        </p>
                      </>
                    ) : (
                      <p className="font-semibold">{item.stockUnits.toFixed(2)} {item.unitType}</p>
                    )}
                    <p className="text-xs text-muted-foreground">Reorder at {item.reorderLevel.toFixed(2)} {item.unitType}</p>
                  </div>
                  <Badge variant={needsAttention ? 'destructive' : 'secondary'} className="w-fit">
                    {needsAttention ? 'Check stock' : item.status || 'In Stock'}
                  </Badge>
                </div>
              );
            })
          )}
        </div>
          </section>
        </TabsContent>

        <TabsContent value="sold" className="mt-0">
          <section className="rounded-lg border bg-background">
            <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div>
                <h2 className="text-base font-semibold">Products Sold</h2>
                <p className="text-xs text-muted-foreground">
                  Completed POS sales for products marked for {settings.name}.
                </p>
              </div>
              <Badge variant="secondary">{sectionSoldOrders.length} orders</Badge>
            </div>
            <div className="divide-y">
              {isLoading && sectionSoldProducts.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : sectionSoldProducts.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <ShoppingBag className="h-6 w-6" />
                  <p className="text-sm">No products have been sold in {settings.name} yet.</p>
                </div>
              ) : (
                sectionSoldProducts.map((product) => {
                  const portionQuantityDisplay =
                    product.isSoldInPortions && product.portionsPerUnit
                      ? getPortionQuantityDisplay({
                          quantity: product.quantity,
                          unitLabel: product.unitType,
                          portionName: product.portionName || 'portion',
                          portionsPerUnit: product.portionsPerUnit,
                        })
                      : null;
                  const quantityLabel = portionQuantityDisplay
                    ? portionQuantityDisplay.summaryText
                    : formatQuantityWithUnit(product.quantity, product.unitType);

                  return (
                    <div
                      key={product.id}
                      className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4 sm:p-4"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{product.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {product.orderCount} order{product.orderCount === 1 ? '' : 's'}
                        </p>
                      </div>
                      <div className="text-sm sm:text-right">
                        <p className="font-semibold">{quantityLabel}</p>
                        {portionQuantityDisplay && (
                          <p className="text-xs text-muted-foreground">
                            {portionQuantityDisplay.totalPortions} {product.portionName || 'portions'} total
                          </p>
                        )}
                      </div>
                      <p className="text-sm font-semibold sm:text-right">{formatCurrency(product.salesValue)}</p>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="orders" className="mt-0">
          <section className="rounded-lg border bg-muted/20">
        <div className="flex items-start justify-between gap-3 border-b bg-background/70 p-3 sm:p-4">
          <div>
            <h2 className="text-base font-semibold">Active Orders</h2>
            <p className="text-xs text-muted-foreground">Only products marked for {settings.name} are shown.</p>
          </div>
          <Badge variant="secondary">{sectionOrders.length}</Badge>
        </div>

        <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {isLoading && sectionOrders.length === 0 ? (
            <div className="col-span-full flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : sectionOrders.length === 0 ? (
            <div className="col-span-full flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background/50 text-center">
              <Boxes className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No active {settings.name} orders</p>
            </div>
          ) : (
            sectionOrders.map((order) => (
              <SectionOrderCard
                key={order.id}
                order={order}
                inventoryLookup={inventoryLookup}
                sectionName={settings.name}
              />
            ))
          )}
        </div>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
}: {
  title: string;
  value: number;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">{title}</p>
          <p className="text-xl font-semibold sm:text-2xl">{value}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary sm:h-10 sm:w-10">
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function SectionOrderCard({
  order,
  inventoryLookup,
  sectionName,
}: {
  order: DisplayOrder;
  inventoryLookup: KitchenInventoryLookup;
  sectionName: string;
}) {
  const sectionItems = getCustomSalesSectionOrderItems(order, inventoryLookup) as DisplayOrderItem[];
  const hiddenCount = getNonCustomSalesSectionOrderItems(order, inventoryLookup).length;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="space-y-3 p-3 pb-2.5 sm:p-4 sm:pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base sm:text-lg">Order {order.order_number}</CardTitle>
            <CardDescription className="flex items-center gap-1 text-xs">
              <Clock className="h-3.5 w-3.5" />
              {getMinutesAgo(order.created_at)}
            </CardDescription>
          </div>
          <Badge className={cn('shrink-0 text-[11px] sm:text-xs', statusColors[order.status])}>
            {order.status}
          </Badge>
        </div>

        {(order.table_number || order.customer_name || order.customer_phone) && (
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            {order.table_number && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
                <Hash className="h-3.5 w-3.5" />
                <span className="truncate">{order.table_number}</span>
              </div>
            )}
            {order.customer_name && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
                <User className="h-3.5 w-3.5" />
                <span className="truncate">{order.customer_name}</span>
              </div>
            )}
            {order.customer_phone && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 sm:col-span-2">
                <Phone className="h-3.5 w-3.5" />
                <span className="truncate">{order.customer_phone}</span>
              </div>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3 p-3 pt-0 sm:p-4 sm:pt-0">
        <div className="space-y-2">
          {sectionItems.map((item) => (
            <div key={item.id} className="rounded-lg border bg-muted/30 p-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  {getSelectedOptions(item).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {getSelectedOptions(item).map((option, index) => (
                        <Badge key={`${option.id || option.name || index}`} variant="outline" className="max-w-full text-[11px]">
                          <span className="truncate">{String(option.name || option.label || 'Option')}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                  {item.notes && (
                    <p className="mt-1 text-xs italic text-muted-foreground">{item.notes}</p>
                  )}
                </div>
                <Badge variant="secondary" className="shrink-0">x{item.quantity}</Badge>
              </div>
            </div>
          ))}
        </div>

        {(order.special_instructions || order.customer_notes) && (
          <>
            <Separator />
            <div className="rounded-lg border bg-background p-2.5 text-xs text-muted-foreground">
              <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <StickyNote className="h-3.5 w-3.5" />
                Notes
              </p>
              {order.special_instructions && <p>{order.special_instructions}</p>}
              {order.customer_notes && <p>{order.customer_notes}</p>}
            </div>
          </>
        )}

        {hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {hiddenCount} other order item{hiddenCount === 1 ? '' : 's'} hidden from {sectionName}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
