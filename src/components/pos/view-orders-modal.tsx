'use client';

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type TakeOrder } from '@/lib/db';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/auth-fetch';
import {
  buildKitchenInventoryLookup,
  getKitchenOrderItems,
  orderHasKitchenPrepItems,
} from '@/lib/kitchen-order-routing';
import { isKitchenBusinessType, type BusinessType } from '@/lib/inventory/config';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChefHat,
  Clock,
  Phone,
  Printer,
  RefreshCw,
  ShoppingBasket,
  Tag,
  Utensils,
  User,
  X,
} from 'lucide-react';
import { useCurrency } from '@/hooks/use-currency';
import { useOrderNotificationSound } from '@/hooks/use-order-notification-sound';
import { useToast } from '@/hooks/use-toast';
import { format, parseISO } from 'date-fns';
import { TakeOrderModal } from './take-order-modal';
import { BillReceipt } from './bill-receipt';
import { syncService } from '@/lib/services/sync-service';

type ViewOrdersModalProps = {
  branchId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onProcessSale?: (order: TakeOrder) => Promise<boolean | void> | boolean | void;
  onRequestProcessSale?: (order: TakeOrder) => void;
  businessType?: BusinessType | string | null;
  currentUserRole?: string | null;
};

type OrderFilter = 'attention' | 'kitchen' | 'ready' | 'cancelled' | 'all';

const ATTENTION_STATUSES = new Set(['Pending', 'Confirmed', 'New']);
const KITCHEN_STATUSES = new Set(['Sent to Kitchen', 'Preparing']);
const READY_STATUSES = new Set(['Ready']);
const CANCELLED_STATUSES = new Set(['Cancelled']);
const ORDER_MODAL_REFRESH_MS = 10_000;
const ORDER_BILL_PRINT_ROOT_ID = 'orders-modal-bill-printable-area';

const normalizeBranchId = (value?: string | number | null): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const getTimeAgo = (dateString: string): string => {
  try {
    const date = parseISO(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins === 1) return '1 minute ago';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    
    return format(date, 'MMM dd');
  } catch (e) {
    return 'unknown';
  }
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getSelectedOptions = (item: any): Array<Record<string, any>> => {
  const selected = item?.selectedOptions ?? item?.selected_options;
  return Array.isArray(selected) ? selected.filter((option) => option && typeof option === 'object') : [];
};

const formatOptionPrice = (option: Record<string, any>, formatCurrency: (value: number) => string): string => {
  if (option.price_mode === 'override' || option.priceMode === 'override') {
    const override = Number(option.price_override ?? option.priceOverride);
    return Number.isFinite(override) ? formatCurrency(override) : '';
  }
  const delta = Number(option.price_delta ?? option.priceDelta ?? 0);
  if (!Number.isFinite(delta) || delta === 0) return '';
  return `${delta > 0 ? '+' : ''}${formatCurrency(delta)}`;
};

export function ViewOrdersModal({ branchId, isOpen, onOpenChange, onProcessSale, onRequestProcessSale, businessType, currentUserRole }: ViewOrdersModalProps) {
  const { format: formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [selectedOrder, setSelectedOrder] = useState<TakeOrder | null>(null);
  const [orderPendingCancellation, setOrderPendingCancellation] = useState<TakeOrder | null>(null);
  const [orderPendingItems, setOrderPendingItems] = useState<TakeOrder | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [showTakeOrderModal, setShowTakeOrderModal] = useState(false);
  const [activeFilter, setActiveFilter] = useState<OrderFilter>('attention');
  const [billOrder, setBillOrder] = useState<TakeOrder | null>(null);
  const [billPaperWidth, setBillPaperWidth] = useState<'80mm' | '58mm'>('80mm');
  const [billNumber, setBillNumber] = useState('');
  const [isPrintingBill, setIsPrintingBill] = useState(false);
  const billPrintLockRef = React.useRef(false);
  const [, setRefresh] = useState(0);
  const kitchenEnabled = isKitchenBusinessType(businessType);
  const inventoryItems = useLiveQuery(
    () => db.inventory.toArray(),
    []
  ) || [];
  const kitchenInventoryLookup = useMemo(
    () => buildKitchenInventoryLookup(inventoryItems),
    [inventoryItems]
  );
  const hasKitchenPrepItems = React.useCallback(
    (order: TakeOrder): boolean => kitchenEnabled && orderHasKitchenPrepItems(order, kitchenInventoryLookup),
    [kitchenEnabled, kitchenInventoryLookup]
  );
  const canCancelOrders = !currentUserRole || currentUserRole === 'Admin';

  // Fetch all take orders for this branch
  const allOrders = useLiveQuery(
    () => {
      if (!branchId) {
        console.log('[ViewOrdersModal] No branchId provided');
        return [];
      }
      const normalizedBranchId = normalizeBranchId(branchId);
      return db.takeOrders.toArray()
        .then(orders => {
          const filteredOrders = orders.filter(
            (order) => normalizeBranchId(order.branchId) === normalizedBranchId
          );

          console.log('[ViewOrdersModal] Fetched orders for branch:', normalizedBranchId, filteredOrders.length);
          if (filteredOrders.length > 0) {
            console.log('[ViewOrdersModal] First order:', filteredOrders[0]);
          }
          return filteredOrders.sort((a, b) => {
            // Sort by created date, newest first
            if (!a.createdAt || !b.createdAt) return 0;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });
        });
    },
    [branchId]
  ) || [];

  // Keep the orders modal fresh while staff are actively viewing it.
  React.useEffect(() => {
    if (!isOpen || !branchId) return;

    let cancelled = false;
    let inFlight = false;

    const refreshOrders = async () => {
      setRefresh(prev => prev + 1);

      if (inFlight) return;
      inFlight = true;

      try {
        const { syncService } = require('@/lib/services/sync-service');
        await syncService.fetchAllTakeOrdersFromBackend(branchId);
      } catch (error) {
        console.warn('[ViewOrdersModal] Auto-refresh skipped:', error);
      } finally {
        if (!cancelled) {
          inFlight = false;
        }
      }
    };

    void refreshOrders();
    const interval = window.setInterval(refreshOrders, ORDER_MODAL_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isOpen, branchId]);

  React.useEffect(() => {
    if (!kitchenEnabled && activeFilter === 'kitchen') {
      setActiveFilter('attention');
    }
  }, [activeFilter, kitchenEnabled]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Ready':
        return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case 'Preparing':
        return <Clock className="h-4 w-4 text-yellow-600" />;
      case 'Pending':
        return <AlertCircle className="h-4 w-4 text-blue-600" />;
      case 'Confirmed':
        return <CheckCircle2 className="h-4 w-4 text-purple-600" />;
      case 'Sent to Kitchen':
        return <Clock className="h-4 w-4 text-orange-600" />;
      case 'Completed':
        return <CheckCircle2 className="h-4 w-4 text-gray-600" />;
      case 'Cancelled':
        return <X className="h-4 w-4 text-red-600" />;
      default:
        return <ShoppingBasket className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Ready':
        return 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700';
      case 'Preparing':
        return 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700';
      case 'Pending':
        return 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700';
      case 'Confirmed':
        return 'bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-700';
      case 'Sent to Kitchen':
        return 'bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700';
      case 'Completed':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border-gray-300 dark:border-gray-600';
      case 'Cancelled':
        return 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700';
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border-gray-300 dark:border-gray-600';
    }
  };

  const getOrderTypeColor = (orderType: string) => {
    return orderType === 'staff' 
      ? 'bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200' 
      : 'bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200';
  };

  const statusCounts = useMemo(() => {
    const counts: { [key: string]: number } = {};
    allOrders.forEach(order => {
      counts[order.status] = (counts[order.status] || 0) + 1;
    });
    return counts;
  }, [allOrders]);

  const orderStats = useMemo(() => {
    const needsAttention = allOrders.filter((order) => ATTENTION_STATUSES.has(order.status)).length;
    const inKitchen = allOrders.filter((order) => (
      KITCHEN_STATUSES.has(order.status) &&
      hasKitchenPrepItems(order)
    )).length;
    const ready = allOrders.filter((order) => READY_STATUSES.has(order.status)).length;
    const cancelled = allOrders.filter((order) => CANCELLED_STATUSES.has(order.status)).length;

    return {
      needsAttention,
      inKitchen,
      ready,
      cancelled,
      all: allOrders.length,
    };
  }, [allOrders, hasKitchenPrepItems]);
  const audibleOrderIds = useMemo(
    () => allOrders
      .filter((order) => (
        ATTENTION_STATUSES.has(order.status) ||
        READY_STATUSES.has(order.status) ||
        (kitchenEnabled && KITCHEN_STATUSES.has(order.status) && hasKitchenPrepItems(order))
      ))
      .map((order) => order.id),
    [allOrders, hasKitchenPrepItems, kitchenEnabled]
  );
  useOrderNotificationSound(audibleOrderIds, isOpen);

  const filteredOrders = useMemo(() => {
    if (activeFilter === 'attention') {
      return allOrders.filter((order) => ATTENTION_STATUSES.has(order.status));
    }
    if (activeFilter === 'kitchen') {
      if (!kitchenEnabled) return [];
      return allOrders.filter((order) => (
        KITCHEN_STATUSES.has(order.status) &&
        hasKitchenPrepItems(order)
      ));
    }
    if (activeFilter === 'ready') {
      return allOrders.filter((order) => READY_STATUSES.has(order.status));
    }
    if (activeFilter === 'cancelled') {
      return allOrders.filter((order) => CANCELLED_STATUSES.has(order.status));
    }

    return allOrders;
  }, [activeFilter, allOrders, hasKitchenPrepItems, kitchenEnabled]);

  const filterOptions: Array<{
    key: OrderFilter;
    label: string;
    count: number;
    icon: React.ElementType;
  }> = [
    { key: 'attention', label: 'Needs Attention', count: orderStats.needsAttention, icon: AlertCircle },
    ...(kitchenEnabled ? [{ key: 'kitchen' as const, label: 'Kitchen', count: orderStats.inKitchen, icon: ChefHat }] : []),
    { key: 'ready', label: 'Ready for Sale', count: orderStats.ready, icon: CheckCircle2 },
    { key: 'cancelled', label: 'Cancelled', count: orderStats.cancelled, icon: X },
    { key: 'all', label: 'All Orders', count: orderStats.all, icon: ShoppingBasket },
  ];

  const getPrimaryAction = (order: TakeOrder) => {
    const status = order.status;
    if (status === 'Pending' || status === 'Confirmed') {
      if (!hasKitchenPrepItems(order)) {
        return { label: 'Mark Ready', nextStatus: 'Ready' as const };
      }
      return { label: 'Send to Kitchen', nextStatus: 'Sent to Kitchen' as const };
    }
    if ((status === 'Sent to Kitchen' || status === 'Preparing') && !kitchenEnabled) {
      return { label: 'Mark Ready', nextStatus: 'Ready' as const };
    }
    if (status === 'Sent to Kitchen') {
      return { label: 'Start', nextStatus: 'Preparing' as const };
    }
    if (status === 'Preparing') {
      return { label: 'Mark Ready', nextStatus: 'Ready' as const };
    }
    if (status === 'Ready') {
      return { label: 'Process Sale', processSale: true as const };
    }

    return null;
  };

  const handleProcessSale = async (order: TakeOrder) => {
    if (onProcessSale) {
      const processed = await onProcessSale(order);
      if (processed === false) {
        return;
      }
    } else if (onRequestProcessSale) {
      onRequestProcessSale(order);
    } else {
      window.dispatchEvent(new CustomEvent('handypos-open-pos-modal', {
        detail: { processTakeOrderId: order.id },
      }));
    }

    setSelectedOrder(null);
    onOpenChange(false);
  };

  const handlePrintBill = async (order: TakeOrder) => {
    if (billPrintLockRef.current) return;

    if (!order.items || order.items.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Nothing to print',
        description: 'This order has no items to print.',
      });
      return;
    }

    billPrintLockRef.current = true;
    setIsPrintingBill(true);

    try {
      const { printerService } = await import('@/lib/services/printer-service');
      const { silentPrintService } = await import('@/lib/services/silent-print-service');
      const defaultPrinter = await printerService.getDefaultPrinter(branchId);

      if (!defaultPrinter) {
        toast({
          variant: 'destructive',
          title: 'No Printer Configured',
          description: 'Configure a default printer before printing customer bills.',
        });
        return;
      }

      const selectedPaperWidth = (defaultPrinter.paperWidth as '80mm' | '58mm') || '80mm';
      setBillPaperWidth(selectedPaperWidth);
      setBillNumber(`Order ${order.orderNumber}`);
      setBillOrder(order);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const billElement = document.getElementById(ORDER_BILL_PRINT_ROOT_ID);
      const printContents = billElement?.innerHTML;
      if (!printContents || printContents.trim().length === 0) {
        toast({
          variant: 'destructive',
          title: 'Print Failed',
          description: 'Bill content was not ready. Please try again.',
        });
        return;
      }

      const isBluetoothPrinter =
        defaultPrinter.connectionType === 'bluetooth' ||
        String(defaultPrinter.id || '').toLowerCase().startsWith('bt:');
      const printAttemptTimeoutMs = isBluetoothPrinter ? 45_000 : 20_000;

      toast({
        title: 'Printing Bill',
        description: `Sending customer bill to ${defaultPrinter.name}`,
      });

      const result = await Promise.race([
        silentPrintService
          .printSilentlyViaSystem(printContents, {
            printerName: defaultPrinter.name,
            printerId: defaultPrinter.id,
            copies: 1,
            paperSize: selectedPaperWidth,
            printerPaperSize: defaultPrinter.paperWidth as '80mm' | '58mm',
          })
          .then((success) => ({ success, timedOut: false })),
        new Promise<{ success: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ success: false, timedOut: true }), printAttemptTimeoutMs)
        ),
      ]);

      if (!result.success) {
        toast({
          variant: 'destructive',
          title: result.timedOut ? 'Print Timed Out' : 'Print Failed',
          description: result.timedOut
            ? 'Printer did not respond in time. Check the connection and try again.'
            : 'Failed to send the customer bill to the printer.',
        });
        return;
      }

      toast({
        title: 'Bill Printed',
        description: `Order ${order.orderNumber} is still ready for sale processing.`,
      });
    } catch (error) {
      console.error('[Orders Bill Print] Failed to print bill:', error);
      toast({
        variant: 'destructive',
        title: 'Print Error',
        description: error instanceof Error ? error.message : 'An unknown error occurred.',
      });
    } finally {
      setIsPrintingBill(false);
      billPrintLockRef.current = false;
    }
  };

  const resolveStatusForOrder = (order: TakeOrder | undefined, requestedStatus: string) => {
    if (
      order &&
      requestedStatus === 'Sent to Kitchen' &&
      !hasKitchenPrepItems(order)
    ) {
      return 'Ready';
    }
    if ((requestedStatus === 'Sent to Kitchen' || requestedStatus === 'Preparing') && !kitchenEnabled) {
      return 'Ready';
    }
    return requestedStatus;
  };

  const handleUpdateStatus = async (orderId: string, newStatus: string, order?: TakeOrder, reason?: string): Promise<boolean> => {
    try {
      const resolvedStatus = resolveStatusForOrder(order || allOrders.find((candidate) => candidate.id === orderId), newStatus);
      const trimmedReason = String(reason || '').trim();
      if (resolvedStatus === 'Cancelled' && !trimmedReason) {
        toast({
          variant: 'destructive',
          title: 'Reason required',
          description: 'Please enter why this order is being cancelled.',
        });
        return false;
      }
      console.log(`[ViewOrdersModal] Updating order ${orderId} to status: ${resolvedStatus}`);

      await authFetch.fetch(
        `/orders/take-orders/${orderId}/update_status/`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: resolvedStatus,
            ...(resolvedStatus === 'Cancelled' ? { cancellation_reason: trimmedReason } : {}),
          })
        }
      );

      await db.takeOrders.update(orderId, {
        status: resolvedStatus as TakeOrder['status'],
        cancellationReason: resolvedStatus === 'Cancelled' ? trimmedReason : '',
        cancellation_reason: resolvedStatus === 'Cancelled' ? trimmedReason : '',
        updatedAt: new Date().toISOString(),
      });
      console.log(`[ViewOrdersModal] Order ${orderId} updated to ${resolvedStatus}`);
      const { syncService } = require('@/lib/services/sync-service');
      syncService.fetchAllTakeOrdersFromBackend(branchId);
      window.dispatchEvent(new CustomEvent('handypos-orders-changed'));
      return true;
    } catch (error) {
      console.error('[ViewOrdersModal] Error updating order status:', error);
      return false;
    }
  };

  const handleTakeOrderOpenChange = (open: boolean) => {
    setShowTakeOrderModal(open);
    if (!open && branchId) {
      const { syncService } = require('@/lib/services/sync-service');
      syncService.fetchAllTakeOrdersFromBackend(branchId);
    }
  };

  const renderOrderCard = (order: TakeOrder) => {
    const total = order.items.reduce((sum, item) => {
      return sum + (item.quantity * (item.price || 0));
    }, 0);
    const primaryAction = getPrimaryAction(order);
    const kitchenItemCount = kitchenEnabled ? getKitchenOrderItems(order, kitchenInventoryLookup).length : 0;
    const hasNotes = Boolean(order.customerNotes || order.specialInstructions || order.items.some((item) => item.notes));

    return (
      <div key={order.id} className="rounded-lg border bg-card p-3 shadow-sm transition hover:border-primary/30 hover:bg-muted/30 hover:shadow-md sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-base font-semibold text-foreground">Order {order.orderNumber}</p>
              <Badge className={`${getStatusColor(order.status)} flex items-center gap-1 border`}>
                {getStatusIcon(order.status)}
                <span className="text-xs font-semibold">{order.status}</span>
              </Badge>
              <Badge className={`${getOrderTypeColor(order.orderType)} text-xs`}>
                {order.orderType === 'staff' ? 'Staff' : 'QR Order'}
              </Badge>
              {hasNotes && (
                <Badge variant="outline" className="text-xs">
                  Notes
                </Badge>
              )}
              {kitchenEnabled && kitchenItemCount === 0 && (
                <Badge variant="outline" className="text-xs">
                  No kitchen prep
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {order.createdAt && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {getTimeAgo(order.createdAt)}
                </span>
              )}
              {order.customerName && (
                <span className="flex min-w-0 items-center gap-1">
                  <User className="h-3.5 w-3.5" />
                  <span className="min-w-0 break-words">{order.customerName}</span>
                </span>
              )}
              {order.tableNumber && (
                <span className="flex items-center gap-1">
                  <Utensils className="h-3.5 w-3.5" />
                  Table {order.tableNumber}
                </span>
              )}
              <span>{order.items.length} item{order.items.length === 1 ? '' : 's'}</span>
            </div>
          </div>

          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-between lg:w-auto lg:justify-end">
            <div className="col-span-2 flex items-end justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-left sm:min-w-24 sm:bg-transparent sm:p-0 sm:text-right">
              <p className="text-xs text-muted-foreground sm:hidden">Total</p>
              <p className="text-base font-semibold text-foreground">{formatCurrency(total)}</p>
              <p className="hidden text-xs text-muted-foreground sm:block">Total</p>
            </div>
            {primaryAction && (
              <Button
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => (
                  'processSale' in primaryAction
                    ? handleProcessSale(order)
                    : handleUpdateStatus(order.id, primaryAction.nextStatus, order)
                )}
              >
                {primaryAction.label}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setSelectedOrder(order)}
            >
              Details
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderOrderDetailsDialog = () => {
    const order = selectedOrder;
    if (!order) {
      return <Dialog open={false} onOpenChange={() => setSelectedOrder(null)} />;
    }

    const total = order.items.reduce((sum, item) => {
      return sum + (item.quantity * (item.price || 0));
    }, 0);

    const updateAndClose = async (status: string, nextFilter?: OrderFilter) => {
      const updated = await handleUpdateStatus(order.id, status, order);
      if (!updated) return;
      if (nextFilter) {
        setActiveFilter(nextFilter);
      }
      setSelectedOrder(null);
    };
    const confirmCancellation = async () => {
      if (!orderPendingCancellation) return;
      const updated = await handleUpdateStatus(
        orderPendingCancellation.id,
        'Cancelled',
        orderPendingCancellation,
        cancellationReason
      );
      if (!updated) return;
      setActiveFilter('cancelled');
      setOrderPendingCancellation(null);
      setCancellationReason('');
      setSelectedOrder(null);
    };
    const hasKitchenItems = hasKitchenPrepItems(order);

    return (
      <>
        <Dialog open={Boolean(order)} onOpenChange={(open) => !open && setSelectedOrder(null)}>
          <DialogContent className="tauri-android-sidebar-safe-top left-0 top-0 m-0 flex h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 [&>button]:top-[calc(env(safe-area-inset-top,0px)+1rem)] sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:[&>button]:top-4">
            <DialogHeader className="shrink-0 border-b bg-muted/30 px-4 pb-3 pt-5 text-left sm:px-6 sm:pt-6">
              <div className="flex min-w-0 flex-wrap items-center gap-2 pr-8">
                <DialogTitle className="min-w-0 break-words text-xl sm:text-2xl">Order {order.orderNumber}</DialogTitle>
                <Badge className={`${getStatusColor(order.status)} flex items-center gap-1 border`}>
                  {getStatusIcon(order.status)}
                  <span className="text-xs font-semibold">{order.status}</span>
                </Badge>
                <Badge className={`${getOrderTypeColor(order.orderType)} text-xs`}>
                  {order.orderType === 'staff' ? 'Staff' : 'Self-Service'}
                </Badge>
              </div>
              <DialogDescription>
                {order.createdAt ? `Created ${getTimeAgo(order.createdAt)}` : 'Order details'}
              </DialogDescription>
            </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {order.customerName && (
                <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                  <User className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Customer Name</p>
                    <p className="break-words font-medium text-foreground">{order.customerName}</p>
                  </div>
                </div>
              )}
              {order.customerPhone && (
                <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                  <Phone className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Phone</p>
                    <p className="break-words font-medium text-foreground">{order.customerPhone}</p>
                  </div>
                </div>
              )}
              {order.tableNumber && (
                <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                  <Utensils className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Table Number</p>
                    <p className="break-words font-medium text-foreground">#{order.tableNumber}</p>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                <Tag className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Order Type</p>
                  <p className="break-words font-medium text-foreground">{order.orderType === 'staff' ? 'Staff Created' : 'Self-Service'}</p>
                </div>
              </div>
              {order.createdByName && (
                <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                  <User className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Taken By</p>
                    <p className="break-words font-medium text-foreground">{order.createdByName}</p>
                  </div>
                </div>
              )}
            </div>

            {order.completedAt && (
              <div className="flex items-start gap-3 rounded-lg border bg-muted p-3">
                <CheckCircle2 className="mt-1 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Completed At</p>
                  <p className="break-words text-sm font-medium text-foreground">{format(parseISO(order.completedAt), 'MMM dd, yyyy HH:mm:ss')}</p>
                  {order.completedByName && (
                    <p className="mt-1 break-words text-sm text-muted-foreground">
                      Processed by {order.completedByName}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-muted p-3 sm:p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-foreground">Order Items ({order.items.length})</p>
              <div className="space-y-2">
                {order.items.map((item, idx) => (
                  <div key={idx} className="flex flex-col gap-2 rounded border-b border-border px-2 py-2 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium text-foreground">{item.name}</p>
                      {getSelectedOptions(item).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {getSelectedOptions(item).map((option, optionIndex) => (
                            <Badge key={`${option.id || option.name || optionIndex}`} variant="outline" className="max-w-full gap-1 text-[11px]">
                              <span className="truncate">{String(option.name || option.label || 'Option')}</span>
                              {formatOptionPrice(option, formatCurrency) && (
                                <span className="text-muted-foreground">{formatOptionPrice(option, formatCurrency)}</span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Qty: <span className="font-semibold">{item.quantity}</span></span>
                        {item.notes && <span className="break-words italic">Note: {item.notes}</span>}
                      </div>
                    </div>
                    <div className="text-left sm:ml-4 sm:text-right">
                      <p className="font-semibold text-foreground">
                        {formatCurrency(item.price * item.quantity)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        @ {formatCurrency(item.price)} each
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 rounded border-t bg-background p-3">
                <p className="text-lg font-bold text-foreground">Total</p>
                <p className="text-right text-xl font-bold text-primary">{formatCurrency(total)}</p>
              </div>
            </div>

            {order.customerNotes && (
              <div className="rounded border-l-4 border-accent bg-muted p-4">
                <p className="mb-2 text-xs font-bold uppercase text-foreground">Customer Notes</p>
                <p className="text-sm text-muted-foreground">{order.customerNotes}</p>
              </div>
            )}

            {order.specialInstructions && (
              <div className="rounded border-l-4 border-accent bg-muted p-4">
                <p className="mb-2 text-xs font-bold uppercase text-foreground">Special Instructions</p>
                <p className="text-sm text-muted-foreground">{order.specialInstructions}</p>
              </div>
            )}

            {order.status === 'Cancelled' && (order.cancellationReason || order.cancellation_reason) && (
              <div className="rounded border-l-4 border-destructive bg-destructive/10 p-4">
                <p className="mb-2 text-xs font-bold uppercase text-foreground">Cancellation Reason</p>
                <p className="text-sm text-muted-foreground">{order.cancellationReason || order.cancellation_reason}</p>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t bg-background p-3 sm:justify-between sm:p-4">
              <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto">
                <Button className="w-full sm:w-auto" variant="outline" onClick={() => setSelectedOrder(null)}>
                  Close Details
                </Button>
                <Button
                  className="w-full gap-2 sm:w-auto"
                  variant="outline"
                  onClick={() => void handlePrintBill(order)}
                  disabled={isPrintingBill || order.items.length === 0}
                >
                  <Printer className="h-4 w-4" />
                  {isPrintingBill ? 'Printing...' : 'Print Bill'}
                </Button>
                {order.status !== 'Cancelled' && order.status !== 'Completed' && (
                  <Button
                    className="w-full gap-2 sm:w-auto"
                    variant="outline"
                    onClick={() => setOrderPendingItems(order)}
                  >
                    <Utensils className="h-4 w-4" />
                    Add Items
                  </Button>
                )}
              </div>
              <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
                {order.status === 'Cancelled' && (
                  <Button className="w-full sm:w-auto" onClick={() => updateAndClose('Pending', 'attention')}>
                    Reopen Order
                  </Button>
                )}
                {order.status !== 'Cancelled' && order.status !== 'Completed' && (
                  <>
                    {order.status === 'Pending' && (
                      <Button className="w-full sm:w-auto" onClick={() => updateAndClose(hasKitchenItems ? 'Sent to Kitchen' : 'Ready')}>
                        {hasKitchenItems ? 'Send to Kitchen' : 'Mark Ready'}
                      </Button>
                    )}
                    {order.status === 'Confirmed' && (
                      <>
                        <Button className="w-full sm:w-auto" onClick={() => updateAndClose(hasKitchenItems ? 'Sent to Kitchen' : 'Ready')}>
                          {hasKitchenItems ? 'Send to Kitchen' : 'Mark Ready'}
                        </Button>
                        {hasKitchenItems && (
                          <Button className="w-full sm:w-auto" onClick={() => updateAndClose('Ready')} variant="outline">
                            Skip to Ready
                          </Button>
                        )}
                      </>
                    )}
                    {!kitchenEnabled && (order.status === 'Sent to Kitchen' || order.status === 'Preparing') && (
                      <Button className="w-full sm:w-auto" onClick={() => updateAndClose('Ready')}>
                        Mark Ready
                      </Button>
                    )}
                    {kitchenEnabled && order.status === 'Sent to Kitchen' && (
                      <Button className="w-full sm:w-auto" onClick={() => updateAndClose('Preparing')}>
                        Start Preparing
                      </Button>
                    )}
                    {kitchenEnabled && order.status === 'Preparing' && (
                      <Button className="w-full sm:w-auto" onClick={() => updateAndClose('Ready')}>
                        Mark as Ready
                      </Button>
                    )}
                    {order.status === 'Ready' && (
                      <Button className="w-full sm:w-auto" onClick={() => handleProcessSale(order)} variant="secondary">
                        Process Sale
                      </Button>
                    )}
                    {canCancelOrders && (
                      <Button
                        className="w-full sm:w-auto"
                        onClick={() => setOrderPendingCancellation(order)}
                        variant="destructive"
                      >
                        Cancel Order
                      </Button>
                    )}
                  </>
                )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={Boolean(orderPendingCancellation)}
          onOpenChange={(open) => {
            if (!open) {
              setOrderPendingCancellation(null);
              setCancellationReason('');
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
              <AlertDialogDescription>
                This moves Order {orderPendingCancellation?.orderNumber} to Cancelled. The order will stay available under Cancelled and All Orders, where it can be reopened later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="order-cancellation-reason">
                Cancellation reason
              </label>
              <Textarea
                id="order-cancellation-reason"
                value={cancellationReason}
                onChange={(event) => setCancellationReason(event.target.value)}
                placeholder="Example: customer changed their mind, duplicate order, item unavailable..."
                className="min-h-24"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Order</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={!cancellationReason.trim()}
                onClick={() => void confirmCancellation()}
              >
                Cancel Order
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="tauri-android-sidebar-safe-top left-0 top-0 m-0 flex h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 [&>button]:top-[calc(env(safe-area-inset-top,0px)+1rem)] sm:left-[50%] sm:top-[50%] sm:h-[90vh] sm:max-h-[90vh] sm:max-w-5xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:[&>button]:top-4">
          <DialogHeader className="shrink-0 text-left">
            <div className="space-y-3 border-b bg-muted/30 px-4 pb-3 pt-5 sm:space-y-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 pr-8 sm:pr-0">
                  <DialogTitle className="flex items-center gap-2 text-xl sm:text-2xl">
                    <ShoppingBasket className="h-5 w-5 text-primary sm:h-6 sm:w-6" />
                    Orders
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-sm">
                    Respond to QR and staff orders without leaving this screen.
                  </DialogDescription>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:self-start">
                  <Button
                    size="sm"
                    className="w-full gap-2 sm:w-auto"
                    onClick={() => setShowTakeOrderModal(true)}
                  >
                    <Utensils className="h-4 w-4" />
                    Take Order
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 sm:w-auto"
                    onClick={() => {
                      const { syncService } = require('@/lib/services/sync-service');
                      syncService.fetchAllTakeOrdersFromBackend(branchId);
                    }}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                </div>
              </div>

              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-4 sm:gap-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-5">
                {filterOptions.map(({ key, label, count, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveFilter(key)}
                    className={`flex min-w-[112px] shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-left transition sm:block sm:min-w-0 sm:rounded-lg sm:p-3 ${
                      activeFilter === key
                        ? 'border-primary bg-background shadow-sm'
                        : 'bg-background/60 hover:bg-background'
                    }`}
                  >
                    <div className="flex items-center gap-2 sm:justify-between">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-base font-semibold sm:text-lg">{count}</span>
                    </div>
                    <p className="truncate text-xs font-medium text-muted-foreground sm:mt-1">{label}</p>
                  </button>
                ))}
              </div>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
            {filteredOrders.length === 0 ? (
              <div className="flex min-h-[18rem] flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <ShoppingBasket className="h-16 w-16 mb-4 opacity-30" />
                <p className="text-lg font-semibold">No orders here</p>
                <p className="text-sm">Try another filter or refresh the list.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredOrders.map(renderOrderCard)}
              </div>
            )}
          </div>

          {Object.entries(statusCounts).length > 0 && (
            <div className="max-h-24 shrink-0 overflow-y-auto border-t bg-muted/20 p-3 sm:max-h-none sm:p-4">
              <div className="flex flex-wrap gap-2">
              {Object.entries(statusCounts).map(([status, count]) => (
                <Badge key={status} variant="outline" className="text-xs">
                  {status}: <span className="ml-1 font-bold">{count}</span>
                </Badge>
              ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <TakeOrderModal
        branchId={branchId}
        isOpen={showTakeOrderModal}
        onOpenChange={handleTakeOrderOpenChange}
        businessType={businessType}
      />
      <TakeOrderModal
        branchId={branchId}
        isOpen={Boolean(orderPendingItems)}
        onOpenChange={(open) => {
          if (!open) setOrderPendingItems(null);
        }}
        businessType={businessType}
        existingOrder={orderPendingItems}
        mode="add-items"
        onOrderUpdated={(order) => {
          setSelectedOrder(order);
          setOrderPendingItems(null);
          void syncService.fetchAllTakeOrdersFromBackend(branchId);
        }}
      />
      {billOrder && (
        <div className="hidden">
          <BillReceipt
            rootId={ORDER_BILL_PRINT_ROOT_ID}
            cart={billOrder.items.map((item) => ({
              id: String(item.id),
              name: item.name,
              quantity: toFiniteNumber(item.quantity, 0),
              price: toFiniteNumber(item.price, 0),
              notes: item.notes,
              selectedOptions: getSelectedOptions(item),
              selected_options: getSelectedOptions(item),
            }))}
            currencyFormatter={formatCurrency}
            subtotal={billOrder.items.reduce((sum, item) => (
              sum + toFiniteNumber(item.quantity, 0) * toFiniteNumber(item.price, 0)
            ), 0)}
            tax={0}
            total={billOrder.items.reduce((sum, item) => (
              sum + toFiniteNumber(item.quantity, 0) * toFiniteNumber(item.price, 0)
            ), 0)}
            taxLabel="Tax"
            billNumber={billNumber}
            customerName={billOrder.customerName}
            customerPhone={billOrder.customerPhone}
            tableNumber={billOrder.tableNumber}
            status={billOrder.status}
            orderNotes={billOrder.customerNotes}
            specialInstructions={billOrder.specialInstructions}
            createdAt={billOrder.createdAt}
            createdByName={billOrder.createdByName}
            paperWidth={billPaperWidth}
          />
        </div>
      )}
      {renderOrderDetailsDialog()}
    </>
  );
}
