'use client';

import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { useOrderNotificationSound } from '@/hooks/use-order-notification-sound';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertCircle,
  CheckCircle2,
  ChefHat,
  Clock,
  Hash,
  Loader2,
  Phone,
  Play,
  RefreshCw,
  StickyNote,
  Utensils,
  User,
  XCircle,
} from 'lucide-react';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';
import { cn } from '@/lib/utils';
import { isKitchenBusinessType, normalizeBusinessType } from '@/lib/inventory/config';
import { formatQuantityWithUnit } from '@/lib/quantity-format';
import {
  buildKitchenInventoryLookup,
  getKitchenOrderItems,
  getKitchenRecipeForOrderItem,
  getNonKitchenOrderItems,
  getRecipeIngredientOrderQuantity,
  type KitchenInventoryLookup,
} from '@/lib/kitchen-order-routing';

interface TakeOrderItem {
  id: string;
  inventory_item_id?: string;
  inventoryItemId?: string;
  name: string;
  quantity: number | string;
  notes?: string;
  selected_options?: Array<Record<string, unknown>>;
  selectedOptions?: Array<Record<string, unknown>>;
  recipe?: unknown[];
  is_kitchen_item?: boolean;
  isKitchenItem?: boolean;
  is_produced?: boolean;
  isProduced?: boolean;
}

interface TakeOrder {
  id: string;
  order_number: number;
  status: 'Pending' | 'Confirmed' | 'Sent to Kitchen' | 'Preparing' | 'Ready' | 'Completed' | 'Cancelled';
  customer_name?: string;
  customer_phone?: string;
  customer_notes?: string;
  table_number?: string;
  special_instructions?: string;
  cancellation_reason?: string;
  cancellationReason?: string;
  items: TakeOrderItem[];
  created_at: string;
  updated_at: string;
}

const statusColors: Record<string, string> = {
  'Pending': 'bg-blue-100 text-blue-800',
  'Confirmed': 'bg-purple-100 text-purple-800',
  'Sent to Kitchen': 'bg-orange-100 text-orange-800',
  'Preparing': 'bg-yellow-100 text-yellow-800',
  'Ready': 'bg-green-100 text-green-800',
  'Completed': 'bg-gray-100 text-gray-800',
  'Cancelled': 'bg-red-100 text-red-800',
};

const statusIcons: Record<string, React.ReactNode> = {
  'Pending': <AlertCircle className="h-4 w-4" />,
  'Confirmed': <CheckCircle2 className="h-4 w-4" />,
  'Sent to Kitchen': <Clock className="h-4 w-4" />,
  'Preparing': <Clock className="h-4 w-4" />,
  'Ready': <CheckCircle2 className="h-4 w-4" />,
  'Completed': <CheckCircle2 className="h-4 w-4" />,
  'Cancelled': <AlertCircle className="h-4 w-4" />,
};

const normalizeBranchId = (value: string | null): string => {
  const normalized = String(value || '').trim();
  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const getOrderAccentColor = (status: TakeOrder['status']): string => {
  if (status === 'Preparing') return '#eab308';
  if (status === 'Ready') return '#16a34a';
  if (status === 'Sent to Kitchen') return '#f97316';
  return '#a855f7';
};

const readTakeOrdersFromResponse = (response: unknown): TakeOrder[] => {
  if (Array.isArray(response)) return response as TakeOrder[];
  if (response && typeof response === 'object' && Array.isArray((response as any).results)) {
    return (response as any).results as TakeOrder[];
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

const formatRecipeQuantity = (quantity: number, unit?: string): string => (
  formatQuantityWithUnit(quantity, unit || 'unit', {
    maximumFractionDigits: 3,
  })
);

const getSelectedOptions = (item: TakeOrderItem): Array<Record<string, any>> => {
  const selected = item.selectedOptions ?? item.selected_options;
  return Array.isArray(selected) ? selected.filter((option) => option && typeof option === 'object') : [];
};

const getSelectedOptionNames = (item: TakeOrderItem): string[] => (
  getSelectedOptions(item)
    .map((option) => String(option.name ?? option.label ?? '').trim())
    .filter(Boolean)
);

const getOptionStockText = (option: Record<string, any>): string => {
  const linkedName = String(option.linked_inventory_item_name ?? option.linkedInventoryItemName ?? '').trim();
  const linkedQuantity = Number(option.linked_inventory_quantity ?? option.linkedInventoryQuantity ?? 0);
  if (linkedName && Number.isFinite(linkedQuantity) && linkedQuantity > 0) {
    return `${formatRecipeQuantity(linkedQuantity)} ${linkedName}`;
  }

  const recipe = Array.isArray(option.recipe) ? option.recipe : [];
  if (recipe.length === 0) return '';
  return recipe
    .map((entry) => {
      const name = String(entry?.name ?? '').trim();
      const quantity = Number(entry?.quantity ?? 0);
      if (!name || !Number.isFinite(quantity) || quantity <= 0) return '';
      return `${formatRecipeQuantity(quantity, entry?.unit)} ${name}`;
    })
    .filter(Boolean)
    .join(', ');
};

type KitchenLaneKey = 'New' | 'Preparing' | 'Ready';

export default function KitchenPage() {
  const { toast } = useToast();
  const { business, user, loading: isAuthLoading } = useAuth();
  const {
    accessCheck: kitchenAccess,
    isLoading: isLoadingKitchenAccess,
  } = useSubscriptionFeatureAccess('kitchen');
  const businessRecord = useLiveQuery(
    () => business?.id ? db.business.get(business.id) : undefined,
    [business?.id]
  );
  const [takeOrders, setTakeOrders] = useState<TakeOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<TakeOrder | null>(null);
  const [orderPendingCancellation, setOrderPendingCancellation] = useState<TakeOrder | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [activeMobileLane, setActiveMobileLane] = useState<KitchenLaneKey>('New');
  const canCancelOrders = user?.role === 'Admin';

  // Get active branch from localStorage
  useEffect(() => {
    const activeBranch = localStorage.getItem('handypos-active-branch');
    if (activeBranch) {
      setBranchId(activeBranch);
    }
  }, []);

  // Fetch take orders
  const fetchTakeOrders = async () => {
    if (!branchId) return;

    try {
      setIsLoading(true);
      const backendBranchId = normalizeBranchId(branchId);
      const [ordersData, inventoryData] = await Promise.all([
        authFetch.fetch(`/orders/take-orders/?branch_id=${encodeURIComponent(backendBranchId)}`),
        authFetch.fetch(`/inventory/items/?branch_id=${encodeURIComponent(backendBranchId)}`),
      ]);

      setTakeOrders(readTakeOrdersFromResponse(ordersData));
      setInventoryItems(readItemsFromResponse(inventoryData));
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      console.error('Error fetching take orders:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to fetch take orders from kitchen',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Initial fetch and auto-refresh
  useEffect(() => {
    if (branchId) {
      fetchTakeOrders();
    }

    if (!autoRefresh) return;

    const interval = setInterval(() => {
      if (branchId) {
        fetchTakeOrders();
      }
    }, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [branchId, autoRefresh]);

  // Update order status
  const updateOrderStatus = async (orderId: string, newStatus: string, reason?: string) => {
    const trimmedReason = String(reason || '').trim();
    try {
      if (newStatus === 'Cancelled' && !trimmedReason) {
        toast({
          variant: 'destructive',
          title: 'Reason required',
          description: 'Please enter why this order is being cancelled.',
        });
        return;
      }
      await authFetch.fetch(
        `/orders/take-orders/${orderId}/update_status/`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: newStatus,
            ...(newStatus === 'Cancelled' ? { cancellation_reason: trimmedReason } : {}),
          }),
        }
      );

      await fetchTakeOrders();
      window.dispatchEvent(new CustomEvent('handypos-orders-changed'));
      toast({
        title: 'Success',
        description: `Order status updated to ${newStatus}`,
      });
    } catch (error: any) {
      console.error('Error updating order status:', error);

      if (error?.message?.includes('404') || error?.message?.includes('not found')) {
        try {
          console.log('Take order not found on backend, attempting to sync...');
          const takeOrder = await (window as any).db?.takeOrders?.get(orderId);

          if (takeOrder) {
            await (window as any).db?.takeOrders?.update(orderId, {
              _dirty: true,
              _operation: 'update',
              status: newStatus,
              ...(newStatus === 'Cancelled' ? {
                cancellationReason: trimmedReason,
                cancellation_reason: trimmedReason,
              } : {}),
            });

            const { syncService } = await import('@/lib/services/sync-service');
            await syncService.performFullSync(branchId!);

            await authFetch.fetch(
              `/orders/take-orders/${orderId}/update_status/`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  status: newStatus,
                  ...(newStatus === 'Cancelled' ? { cancellation_reason: trimmedReason } : {}),
                }),
              }
            );

            await fetchTakeOrders();
            window.dispatchEvent(new CustomEvent('handypos-orders-changed'));
            toast({
              title: 'Success',
              description: `Order status updated to ${newStatus}`,
            });
          }
        } catch (syncError) {
          console.error('Error syncing take order:', syncError);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Take order not found. Please sync and try again.',
          });
        }
      } else {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to update order status',
        });
      }
    }
  };

  const requestCancelOrder = (order: TakeOrder) => {
    setOrderPendingCancellation(order);
    setCancellationReason('');
  };

  const confirmCancelOrder = async () => {
    if (!orderPendingCancellation) return;
    await updateOrderStatus(orderPendingCancellation.id, 'Cancelled', cancellationReason);
    setOrderPendingCancellation(null);
    setCancellationReason('');
    setSelectedOrder(null);
  };

  // Group orders by status (exclude Pending orders, show Confirmed as "New Orders")
  const kitchenInventoryLookup = React.useMemo(
    () => buildKitchenInventoryLookup(inventoryItems),
    [inventoryItems]
  );
  const kitchenOrders = React.useMemo(
    () => takeOrders.filter((order) => getKitchenOrderItems(order, kitchenInventoryLookup).length > 0),
    [takeOrders, kitchenInventoryLookup]
  );
  const ordersByStatus = {
    'New': kitchenOrders.filter(o => o.status === 'Confirmed' || o.status === 'Sent to Kitchen'),
    'Preparing': kitchenOrders.filter(o => o.status === 'Preparing'),
    'Ready': kitchenOrders.filter(o => o.status === 'Ready'),
  };
  const totalKitchenOrders =
    ordersByStatus.New.length + ordersByStatus.Preparing.length + ordersByStatus.Ready.length;
  const lastUpdatedLabel = lastUpdatedAt ? getMinutesAgo(lastUpdatedAt) : 'Not refreshed yet';
  const kitchenColumns = [
    {
      key: 'New' as KitchenLaneKey,
      title: 'New Orders',
      description: 'Waiting to be started',
      icon: ChefHat,
      iconClassName: 'text-orange-600',
      emptyText: 'No new kitchen orders',
    },
    {
      key: 'Preparing' as KitchenLaneKey,
      title: 'Preparing',
      description: 'Currently in progress',
      icon: Clock,
      iconClassName: 'text-yellow-600',
      emptyText: 'No orders being prepared',
    },
    {
      key: 'Ready' as KitchenLaneKey,
      title: 'Ready',
      description: 'Waiting for pickup or checkout',
      icon: CheckCircle2,
      iconClassName: 'text-green-600',
      emptyText: 'No ready orders',
    },
  ];
  const currentBusinessType = normalizeBusinessType(businessRecord?.type ?? business?.type, 'General Retail');
  const hasResolvedBusinessType = Boolean(businessRecord?.type || business?.type);
  const kitchenBusinessAvailable = isKitchenBusinessType(currentBusinessType);
  useOrderNotificationSound(
    ordersByStatus.New.map((order) => order.id),
    kitchenBusinessAvailable && kitchenAccess.allowed
  );

  if (isAuthLoading || isLoadingKitchenAccess || !hasResolvedBusinessType) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!kitchenBusinessAvailable) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ChefHat className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-semibold">Kitchen is not available for this business type</p>
              <p className="text-sm text-muted-foreground">
                Kitchen workflow is only available for Restaurant and Bar & Liquor businesses. Use Orders to manage customer requests.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!kitchenAccess.allowed) {
    return (
      <SubscriptionFeatureDisabledCard
        featureName="kitchen"
        accessCheck={kitchenAccess}
      />
    );
  }

  if (!branchId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ChefHat className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-semibold">No branch selected</p>
              <p className="text-sm text-muted-foreground">Select a branch to view kitchen orders.</p>
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
            <ChefHat className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Kitchen Screen</h1>
              {autoRefresh && (
                <Badge variant="secondary" className="gap-1">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  Live
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Track kitchen tickets from received order to ready for service.
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
          <Button variant="outline" onClick={fetchTakeOrders} disabled={isLoading} className="w-full gap-2 sm:w-auto">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
        <KitchenStatCard title="Active Tickets" value={totalKitchenOrders} icon={Utensils} />
        <KitchenStatCard title="New" value={ordersByStatus.New.length} icon={ChefHat} />
        <KitchenStatCard title="Preparing" value={ordersByStatus.Preparing.length} icon={Clock} />
        <KitchenStatCard title="Ready" value={ordersByStatus.Ready.length} icon={CheckCircle2} />
      </div>

      <div className="grid grid-cols-3 gap-2 xl:hidden">
        {kitchenColumns.map(({ key, title }) => (
          <Button
            key={key}
            type="button"
            variant={activeMobileLane === key ? 'default' : 'outline'}
            className="h-auto min-h-11 flex-col gap-0.5 px-2 py-2 text-xs"
            onClick={() => setActiveMobileLane(key)}
          >
            <span className="truncate">{key === 'New' ? 'New' : title}</span>
            <span className="text-[11px] opacity-80">{ordersByStatus[key].length}</span>
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {kitchenColumns.map(({ key, title, description, icon: Icon, iconClassName, emptyText }) => {
          const orders = ordersByStatus[key];

          return (
            <section
              key={key}
              className={cn(
                'flex min-h-[20rem] flex-col rounded-lg border bg-muted/20 xl:min-h-[28rem]',
                activeMobileLane !== key && 'hidden xl:flex'
              )}
            >
              <div className="flex items-start justify-between gap-3 border-b bg-background/70 p-3 sm:p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card sm:h-9 sm:w-9">
                    <Icon className={cn('h-4 w-4 sm:h-5 sm:w-5', iconClassName)} />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold">{title}</h2>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </div>
                <Badge variant="secondary">{orders.length}</Badge>
              </div>

              <div className="flex-1 space-y-3 p-2.5 sm:p-3">
                {isLoading && orders.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : orders.length === 0 ? (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background/50 text-center">
                    <Icon className={cn('h-6 w-6', iconClassName)} />
                    <p className="text-sm text-muted-foreground">{emptyText}</p>
                  </div>
                ) : (
                  orders.map(order => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      inventoryLookup={kitchenInventoryLookup}
                      onStatusChange={updateOrderStatus}
                      onCancel={requestCancelOrder}
                      canCancel={canCancelOrders}
                      onViewDetails={setSelectedOrder}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
      <OrderDetailsDialog
        order={selectedOrder}
        inventoryLookup={kitchenInventoryLookup}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedOrder(null);
          }
        }}
        onStatusChange={updateOrderStatus}
        onCancel={requestCancelOrder}
        canCancel={canCancelOrders}
      />
      <Dialog
        open={Boolean(orderPendingCancellation)}
        onOpenChange={(open) => {
          if (!open) {
            setOrderPendingCancellation(null);
            setCancellationReason('');
          }
        }}
      >
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel order #{orderPendingCancellation?.order_number}</DialogTitle>
            <DialogDescription>
              Add a reason so the team can review why this order was cancelled.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="kitchen-cancellation-reason">
              Cancellation reason
            </label>
            <Textarea
              id="kitchen-cancellation-reason"
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              placeholder="Example: customer changed their mind, duplicate order, item unavailable..."
              className="min-h-24"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderPendingCancellation(null)}>
              Keep Order
            </Button>
            <Button variant="destructive" disabled={!cancellationReason.trim()} onClick={() => void confirmCancelOrder()}>
              Cancel Order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KitchenStatCard({
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

const getNextKitchenStatus = (currentStatus: string): string => {
  const statusFlow: Record<string, string> = {
    'Confirmed': 'Preparing',
    'Sent to Kitchen': 'Preparing',
    'Preparing': 'Ready',
  };
  return statusFlow[currentStatus] || currentStatus;
};

const getKitchenActionLabel = (nextStatus: string): string => {
  if (nextStatus === 'Preparing') return 'Start';
  if (nextStatus === 'Ready') return 'Mark Ready';
  return 'Update';
};

function OrderCard({
  order,
  inventoryLookup,
  onStatusChange,
  onCancel,
  canCancel,
  onViewDetails,
}: {
  order: TakeOrder;
  inventoryLookup: KitchenInventoryLookup;
  onStatusChange: (orderId: string, status: string) => void;
  onCancel: (order: TakeOrder) => void;
  canCancel: boolean;
  onViewDetails: (order: TakeOrder) => void;
}) {
  const nextStatus = getNextKitchenStatus(order.status);
  const primaryLabel = getKitchenActionLabel(nextStatus);
  const canAdvanceStatus = nextStatus !== order.status && order.status !== 'Completed' && order.status !== 'Cancelled';
  const kitchenItems = getKitchenOrderItems(order, inventoryLookup);
  const nonKitchenItems = getNonKitchenOrderItems(order, inventoryLookup);
  const hasNotes = Boolean(order.special_instructions || order.customer_notes || kitchenItems.some((item) => item.notes));
  const optionSummary = kitchenItems
    .flatMap(getSelectedOptionNames)
    .slice(0, 3);

  return (
    <Card className="overflow-hidden border-l-4 shadow-sm" style={{ borderLeftColor: getOrderAccentColor(order.status) }}>
      <CardHeader className="space-y-3 p-3 pb-2.5 sm:p-4 sm:pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base sm:text-lg">Order #{order.order_number}</CardTitle>
            <CardDescription className="flex items-center gap-1 text-xs">
              <Clock className="h-3.5 w-3.5" />
              {getMinutesAgo(order.created_at)}
            </CardDescription>
          </div>
          <Badge className={cn('shrink-0 gap-1 text-[11px] sm:text-xs', statusColors[order.status])}>
            <span className="mr-1">{statusIcons[order.status]}</span>
            {order.status}
          </Badge>
        </div>

        {(order.table_number || order.customer_name || order.customer_phone) && (
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            {order.table_number && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
                <Hash className="h-3.5 w-3.5" />
                <span className="truncate">Table {order.table_number}</span>
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

      <CardContent className="space-y-3 p-3 pt-0 sm:space-y-4 sm:p-4 sm:pt-0">
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-2.5 sm:p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{kitchenItems.length} kitchen item{kitchenItems.length === 1 ? '' : 's'}</p>
            <p className="truncate text-xs text-muted-foreground">
              {optionSummary.length > 0
                ? optionSummary.join(', ')
                : nonKitchenItems.length > 0
                ? `${nonKitchenItems.length} non-kitchen item${nonKitchenItems.length === 1 ? '' : 's'} hidden`
                : hasNotes
                  ? 'Includes notes or instructions'
                  : 'Open details to review the prep ticket'}
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => onViewDetails(order)}>
            Details
          </Button>
        </div>

        <Separator />
        <div className="grid gap-2 min-[380px]:grid-cols-2">
          {canAdvanceStatus && (
            <Button
              className="gap-2"
              onClick={() => onStatusChange(order.id, nextStatus)}
            >
              {nextStatus === 'Preparing' && <Play className="h-4 w-4" />}
              {nextStatus !== 'Preparing' && <CheckCircle2 className="h-4 w-4" />}
              {primaryLabel}
            </Button>
          )}
          {order.status === 'Ready' && (
            <Button className="gap-2" variant="secondary" disabled>
              <CheckCircle2 className="h-4 w-4" />
              Ready for Sale
            </Button>
          )}
          {canCancel && order.status !== 'Completed' && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => onCancel(order)}
            >
              <XCircle className="h-4 w-4" />
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OrderDetailsDialog({
  order,
  inventoryLookup,
  onOpenChange,
  onStatusChange,
  onCancel,
  canCancel,
}: {
  order: TakeOrder | null;
  inventoryLookup: KitchenInventoryLookup;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (orderId: string, status: string) => void;
  onCancel: (order: TakeOrder) => void;
  canCancel: boolean;
}) {
  if (!order) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const nextStatus = getNextKitchenStatus(order.status);
  const primaryLabel = getKitchenActionLabel(nextStatus);
  const canAdvanceStatus = nextStatus !== order.status && order.status !== 'Completed' && order.status !== 'Cancelled';
  const kitchenItems = getKitchenOrderItems(order, inventoryLookup);
  const nonKitchenItems = getNonKitchenOrderItems(order, inventoryLookup);

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="tauri-android-safe-bottom flex h-[calc(100dvh-1rem)] w-[calc(100vw-0.75rem)] max-w-2xl flex-col overflow-hidden p-0 sm:h-auto sm:max-h-[85dvh] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-10 sm:px-6 sm:py-4">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Order #{order.order_number}</DialogTitle>
            <Badge className={cn('gap-1 text-[11px] sm:text-xs', statusColors[order.status])}>
              {statusIcons[order.status]}
              {order.status}
            </Badge>
          </div>
          <DialogDescription>
            Created {getMinutesAgo(order.created_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {(order.table_number || order.customer_name || order.customer_phone) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {order.table_number && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <Hash className="h-4 w-4" />
                    Table
                  </p>
                  <p className="mt-1 font-medium">{order.table_number}</p>
                </div>
              )}
              {order.customer_name && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <User className="h-4 w-4" />
                    Customer
                  </p>
                  <p className="mt-1 font-medium">{order.customer_name}</p>
                </div>
              )}
              {order.customer_phone && (
                <div className="rounded-lg border bg-muted/30 p-3 sm:col-span-2">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    Phone
                  </p>
                  <p className="mt-1 font-medium">{order.customer_phone}</p>
                </div>
              )}
            </div>
          )}

          {order.special_instructions && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <p className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
                <StickyNote className="h-4 w-4" />
                Special Instructions
              </p>
              <p className="mt-1 text-amber-800 dark:text-amber-100">{order.special_instructions}</p>
            </div>
          )}

          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Utensils className="h-4 w-4 text-muted-foreground" />
              Kitchen Items
            </p>
            <div className="overflow-hidden rounded-lg border">
              {kitchenItems.map(item => {
                const recipe = getKitchenRecipeForOrderItem(item, inventoryLookup);
                return (
                  <div key={item.id} className="space-y-3 border-b p-3 text-sm last:border-b-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <p className="font-medium">{item.name}</p>
                        {getSelectedOptions(item).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {getSelectedOptions(item).map((option, optionIndex) => (
                              <Badge key={`${option.id || option.name || optionIndex}`} variant="outline" className="max-w-full text-[11px]">
                                <span className="truncate">{String(option.name || option.label || 'Option')}</span>
                              </Badge>
                            ))}
                          </div>
                        )}
                        {item.notes && (
                          <p className="text-xs italic text-muted-foreground">{item.notes}</p>
                        )}
                      </div>
                      <Badge variant="secondary" className="ml-2 flex-shrink-0">
                        x{item.quantity}
                      </Badge>
                    </div>

                    {getSelectedOptions(item).length > 0 && (
                      <div className="rounded-md border bg-background p-3">
                        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Selected Options</p>
                        <div className="space-y-1.5">
                          {getSelectedOptions(item).map((option, optionIndex) => {
                            const stockText = getOptionStockText(option);
                            return (
                              <div key={`${option.id || option.name || optionIndex}`} className="grid gap-1 text-xs min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center">
                                <span className="min-w-0 truncate font-medium">{String(option.name || option.label || 'Option')}</span>
                                {stockText && (
                                  <span className="text-muted-foreground min-[420px]:text-right">
                                    Uses {stockText} each
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {recipe.length > 0 ? (
                      <div className="rounded-md border bg-muted/40 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Recipe</p>
                        <div className="space-y-1.5">
                          {recipe.map((ingredient, index) => (
                            <div key={`${ingredient.ingredientId || ingredient.name}-${index}`} className="grid gap-1 text-xs min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center">
                              <span className="min-w-0 truncate font-medium">{ingredient.name}</span>
                              <span className="text-muted-foreground min-[420px]:text-right">
                                {formatRecipeQuantity(ingredient.quantity, ingredient.unit)} each
                                {' '}
                                <span className="text-foreground">
                                  ({formatRecipeQuantity(getRecipeIngredientOrderQuantity(ingredient, item), ingredient.unit)} total)
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                        No recipe configured for this prepared item.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {nonKitchenItems.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {nonKitchenItems.length} purchased or no-prep item{nonKitchenItems.length === 1 ? '' : 's'} hidden from kitchen.
              </p>
            )}
          </div>

          {order.customer_notes && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-semibold">Customer Notes</p>
              <p className="mt-1 text-muted-foreground">{order.customer_notes}</p>
            </div>
          )}
          {order.status === 'Cancelled' && (order.cancellation_reason || order.cancellationReason) && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <p className="font-semibold">Cancellation Reason</p>
              <p className="mt-1 text-muted-foreground">{order.cancellation_reason || order.cancellationReason}</p>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t p-3 sm:justify-between sm:p-4">
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <div className="grid w-full gap-2 sm:w-auto sm:grid-flow-col sm:auto-cols-max">
            {canAdvanceStatus && (
              <Button className="gap-2" onClick={() => onStatusChange(order.id, nextStatus)}>
                {nextStatus === 'Preparing' && <Play className="h-4 w-4" />}
                {nextStatus !== 'Preparing' && <CheckCircle2 className="h-4 w-4" />}
                {primaryLabel}
              </Button>
            )}
            {order.status === 'Ready' && (
              <Button className="gap-2" variant="secondary" disabled>
                <CheckCircle2 className="h-4 w-4" />
                Ready for Sale
              </Button>
            )}
            {canCancel && order.status !== 'Completed' && (
              <Button variant="outline" className="gap-2" onClick={() => onCancel(order)}>
                <XCircle className="h-4 w-4" />
                Cancel
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
