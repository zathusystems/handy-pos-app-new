

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Cloud, CloudOff, AlertCircle, Loader2, ChevronDown } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { useSyncStatus } from '@/hooks/use-sync-status';
import { useAuth } from '@/hooks/use-auth';
import { useOrderNotificationSound } from '@/hooks/use-order-notification-sound';
import { ScrollArea } from './ui/scroll-area';
import { fetchCurrentSubscription } from '@/lib/subscription-cache';
import { authFetch } from '@/lib/auth-fetch';
import { ViewOrdersModal } from '@/components/pos/view-orders-modal';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface DashboardHeaderProps {
  children?: React.ReactNode;
  onTakeOrderClick?: () => void;
  branchId?: string | null;
  onProcessSaleOrder?: (orderId: string) => void;
  mobileTopActions?: React.ReactNode;
}

interface SubscriptionReminderData {
  id: number | null;
  balance: number;
  monthlyCharge: number;
  currencyCode: string;
}

type HeaderTakeOrder = {
  id?: string;
  status?: string;
};

const ATTENTION_ORDER_STATUSES = new Set(['Pending', 'Confirmed', 'New', 'Ready']);
const ORDER_COUNTER_REFRESH_MS = 5_000;
export const OPEN_ORDERS_MODAL_EVENT = 'handypos-open-orders-modal';
export const ORDERS_ATTENTION_COUNT_EVENT = 'handypos-orders-attention-count-changed';

const normalizeHeaderBranchId = (value?: string | number | null): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const readOrdersFromResponse = (response: unknown): HeaderTakeOrder[] => {
  if (Array.isArray(response)) return response as HeaderTakeOrder[];
  if (response && typeof response === 'object' && Array.isArray((response as any).results)) {
    return (response as any).results as HeaderTakeOrder[];
  }
  return [];
};

export function DashboardHeader({
  children,
  onTakeOrderClick,
  branchId: propBranchId,
  onProcessSaleOrder,
  mobileTopActions,
}: DashboardHeaderProps) {
  const { business, user, loading: isAuthLoading } = useAuth();
  const {
    pendingCount,
    failedCount,
    isOnline,
    hasPending,
    hasFailed,
    dirtyRecords,
    failedQueueItems,
    pendingQueueItems,
  } = useSyncStatus(propBranchId);
  const [openSyncMenu, setOpenSyncMenu] = useState<string | null>(null);
  const [showLowFundsModal, setShowLowFundsModal] = useState(false);
  const [showOutOfCreditsModal, setShowOutOfCreditsModal] = useState(false);
  const [subscriptionReminder, setSubscriptionReminder] = useState<SubscriptionReminderData | null>(null);
  const [showOrdersModal, setShowOrdersModal] = useState(false);
  const [attentionOrderIds, setAttentionOrderIds] = useState<string[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businessId = business?.id || user?.businessId || null;

  const isBillingPath = pathname === '/dashboard/settings/billing' || pathname === '/dashboard/settings/billing/';
  const isBillingAddCreditFlow = isBillingPath && searchParams.get('openAddCredit') === '1';
  const lowFundsThreshold = useMemo(
    () => (subscriptionReminder ? subscriptionReminder.monthlyCharge * 0.2 : 0),
    [subscriptionReminder]
  );
  useOrderNotificationSound(attentionOrderIds, !showOrdersModal);

  const formatAmount = (value: number): string => {
    const code = subscriptionReminder?.currencyCode || 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
    } catch {
      return `${value.toFixed(2)} ${code}`;
    }
  };

  useEffect(() => {
    if (isAuthLoading || !businessId) {
      return;
    }

    let active = true;

    const syncSubscriptionReminder = async () => {
      try {
        const response = await fetchCurrentSubscription(businessId, {
          maxAgeMs: 60_000,
        });

        if (!active || !response) {
          return;
        }

        const balance = Number(response.account_balance ?? 0);
        const monthlyChargeFromApi = Number(response.monthly_charge ?? 0);
        const dailyCharge = Number(response.daily_charge ?? response.base_price_per_day ?? 0);
        const monthlyCharge = monthlyChargeFromApi > 0 ? monthlyChargeFromApi : Math.max(dailyCharge * 30, 0);
        const currencyCode = String(response.currency_code || 'USD').toUpperCase();
        const subscriptionId = Number.isFinite(Number(response.id)) ? Number(response.id) : null;

        setSubscriptionReminder({
          id: subscriptionId,
          balance,
          monthlyCharge,
          currencyCode,
        });

        if (isBillingAddCreditFlow) {
          setShowOutOfCreditsModal(false);
          setShowLowFundsModal(false);
          return;
        }

        if (balance <= 0) {
          setShowOutOfCreditsModal(true);
          setShowLowFundsModal(false);
          return;
        }

        const threshold = monthlyCharge * 0.2;
        if (monthlyCharge > 0 && balance < threshold) {
          const dayKey = new Date().toISOString().slice(0, 10);
          const reminderKey = `handypos-low-funds-reminder:${subscriptionId ?? 'current'}:${dayKey}`;
          const hasShownToday = localStorage.getItem(reminderKey) === '1';
          if (!hasShownToday) {
            localStorage.setItem(reminderKey, '1');
            setShowLowFundsModal(true);
          }
          setShowOutOfCreditsModal(false);
          return;
        }

        setShowOutOfCreditsModal(false);
        setShowLowFundsModal(false);
      } catch (error) {
        console.warn('[DashboardHeader] Subscription reminder fetch skipped:', error);
      }
    };

    void syncSubscriptionReminder();
    const handleFocus = () => {
      void syncSubscriptionReminder();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      active = false;
      window.removeEventListener('focus', handleFocus);
    };
  }, [businessId, isAuthLoading, isBillingAddCreditFlow]);

  useEffect(() => {
    const backendBranchId = normalizeHeaderBranchId(propBranchId);
    if (isAuthLoading || !businessId || !backendBranchId) {
      setAttentionOrderIds([]);
      window.dispatchEvent(new CustomEvent(ORDERS_ATTENTION_COUNT_EVENT, { detail: { count: 0 } }));
      return;
    }

    let active = true;

    const syncAttentionOrderCount = async () => {
      try {
        const response = await authFetch.fetch(
          `/orders/take-orders/?branch_id=${encodeURIComponent(backendBranchId)}`,
          { queueOnFailure: false }
        );
        if (!active) return;

        const orders = readOrdersFromResponse(response);
        const attentionOrders = orders.filter((order) => (
          ATTENTION_ORDER_STATUSES.has(String(order.status || '').trim())
        ));
        setAttentionOrderIds(
          attentionOrders
            .map((order) => String(order.id ?? '').trim())
            .filter(Boolean)
        );
        const nextCount = attentionOrders.length;
        window.dispatchEvent(new CustomEvent(ORDERS_ATTENTION_COUNT_EVENT, { detail: { count: nextCount } }));
      } catch (error) {
        if (active) {
          console.warn('[DashboardHeader] Order counter fetch skipped:', error);
        }
      }
    };

    void syncAttentionOrderCount();
    const intervalId = window.setInterval(syncAttentionOrderCount, ORDER_COUNTER_REFRESH_MS);
    const handleFocus = () => {
      void syncAttentionOrderCount();
    };
    const handleOrdersChanged = () => {
      void syncAttentionOrderCount();
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('handypos-orders-changed', handleOrdersChanged);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('handypos-orders-changed', handleOrdersChanged);
    };
  }, [businessId, isAuthLoading, propBranchId]);

  useEffect(() => {
    const handleOpenOrdersModal = () => {
      setShowOrdersModal(true);
    };

    window.addEventListener(OPEN_ORDERS_MODAL_EVENT, handleOpenOrdersModal);
    return () => {
      window.removeEventListener(OPEN_ORDERS_MODAL_EVENT, handleOpenOrdersModal);
    };
  }, []);

  const openBillingAddCredit = () => {
    setShowLowFundsModal(false);
    setShowOutOfCreditsModal(false);
    router.push('/dashboard/settings/billing/?openAddCredit=1');
  };

  const getOperationColor = (operation?: string) => {
    switch (operation) {
      case 'create':
        return 'bg-green-100 text-green-800';
      case 'update':
        return 'bg-blue-100 text-blue-800';
      case 'delete':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'InventoryItem':
        return '📦';
      case 'Session':
        return '🔄';
      case 'Order':
        return '🛒';
      case 'PurchaseOrder':
        return '📋';
      case 'StockTransfer':
        return '🚚';
      case 'WasteRecord':
        return '🗑️';
      default:
        return '📝';
    }
  };

  const getQueueItemTitle = (item: any): string => {
    const metadata = item?.metadata || {};
    const entityType = String(item?.entityType || '').trim();
    const entityId = String(item?.entityId || '').trim();
    const metadataLabel =
      metadata?.label ||
      metadata?.name ||
      metadata?.title ||
      '';
    if (metadataLabel) return String(metadataLabel);
    if (entityType) {
      return entityId ? `${entityType} #${entityId}` : entityType;
    }
    return String(item?.url || 'Request');
  };

  const getQueueItemSubtitle = (item: any): string => {
    const method = String(item?.method || '').trim().toUpperCase();
    const url = String(item?.url || '').trim();
    if (method && url) return `${method} ${url}`;
    return url || method || 'Queued request';
  };

  const renderConnectivityStatus = (compact = false) => (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-md',
        compact ? 'h-6 px-1.5 py-0.5' : 'h-8 px-2 py-1 sm:h-9',
        isOnline ? 'bg-green-500/10' : 'bg-destructive/10'
      )}
      title={isOnline ? 'Online' : 'Offline'}
    >
      {isOnline ? (
        <>
          <Cloud className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4', 'text-green-600')} />
          <span className={cn('text-xs font-medium text-green-600', compact && 'sr-only')}>
            Online
          </span>
        </>
      ) : (
        <>
          <CloudOff className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4', 'text-destructive')} />
          <span className={cn('text-xs font-medium text-destructive', compact && 'sr-only')}>
            Offline
          </span>
        </>
      )}
    </div>
  );

  const renderFailedSyncItems = (scope: string, compact = false) => {
    if (!hasFailed) return null;

    const menuId = `${scope}-failed`;

    return (
      <DropdownMenu
        open={openSyncMenu === menuId}
        onOpenChange={(open) => setOpenSyncMenu(open ? menuId : null)}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'shrink-0 gap-1 px-2',
              compact ? 'h-6 rounded-md' : 'h-8 sm:h-9'
            )}
            title={`${failedCount} failed sync item${failedCount === 1 ? '' : 's'}`}
          >
            <AlertCircle className={cn('text-destructive', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
            <Badge variant="destructive" className={cn('text-xs', compact && 'h-4 px-1 text-[10px]')}>
              <span className={compact ? '' : 'sm:hidden'}>{failedCount}</span>
              {!compact && <span className="hidden sm:inline">{failedCount} Failed</span>}
            </Badge>
            <ChevronDown className={cn('opacity-50', compact ? 'h-3 w-3' : 'h-3 w-3')} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="tauri-android-safe-bottom w-[calc(100vw-1rem)] max-w-[22rem] overflow-hidden p-0 sm:w-80">
          <DropdownMenuLabel>Failed Sync Items</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ScrollArea className="max-h-[min(70dvh,24rem)]">
            <div className="space-y-2 p-2">
              {failedQueueItems.length > 0 ? (
                failedQueueItems.map((item) => (
                  <div
                    key={item.id || `${item.method}-${item.url}-${item.timestamp || ''}`}
                    className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs"
                  >
                    <span className="text-lg">⚠️</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{getQueueItemTitle(item)}</div>
                      <div className="break-words text-xs text-muted-foreground sm:truncate">
                        {getQueueItemSubtitle(item)}
                      </div>
                      {item?.error && (
                        <div className="mt-1 break-words text-xs text-destructive sm:truncate">
                          {String(item.error)}
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className="shrink-0 whitespace-nowrap border-destructive/40 text-xs text-destructive">
                      Failed
                    </Badge>
                  </div>
                ))
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No failed items
                </div>
              )}
            </div>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const renderPendingSyncItems = (scope: string, compact = false) => {
    if (!hasPending) return null;

    const menuId = `${scope}-pending`;

    return (
      <DropdownMenu
        open={openSyncMenu === menuId}
        onOpenChange={(open) => setOpenSyncMenu(open ? menuId : null)}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'shrink-0 gap-1 px-2',
              compact ? 'h-6 rounded-md' : 'h-8 sm:h-9'
            )}
            title={`${pendingCount} pending sync item${pendingCount === 1 ? '' : 's'}`}
          >
            <Loader2 className={cn('animate-spin text-yellow-600', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
            <Badge variant="outline" className={cn('text-xs', compact && 'h-4 px-1 text-[10px]')}>
              <span className={compact ? '' : 'sm:hidden'}>{pendingCount}</span>
              {!compact && <span className="hidden sm:inline">{pendingCount} Pending</span>}
            </Badge>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="tauri-android-safe-bottom w-[calc(100vw-1rem)] max-w-[22rem] overflow-hidden p-0 sm:w-80">
          <DropdownMenuLabel>Pending Sync Items</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ScrollArea className="max-h-[min(70dvh,24rem)]">
            <div className="space-y-2 p-2">
              {pendingQueueItems.length === 0 && dirtyRecords.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No pending items
                </div>
              ) : (
                <>
                  {pendingQueueItems.length > 0 && (
                    <>
                      <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Queued Requests
                      </div>
                      {pendingQueueItems.map((item) => (
                        <div
                          key={item.id || `${item.method}-${item.url}-${item.timestamp || ''}`}
                          className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs"
                        >
                          <span className="text-lg">⏳</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{getQueueItemTitle(item)}</div>
                            <div className="break-words text-xs text-muted-foreground sm:truncate">
                              {getQueueItemSubtitle(item)}
                            </div>
                          </div>
                          <Badge variant="outline" className="shrink-0 whitespace-nowrap border-yellow-400/40 text-xs text-yellow-700">
                            Pending
                          </Badge>
                        </div>
                      ))}
                    </>
                  )}
                  {dirtyRecords.length > 0 && (
                    <>
                      <div className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Local Changes
                      </div>
                      {dirtyRecords.map((record) => (
                        <div
                          key={`${record.type}-${record.id}`}
                          className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs"
                        >
                          <span className="text-lg">{getTypeIcon(record.type)}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{record.name || record.id}</div>
                            <div className="text-xs text-muted-foreground">{record.type}</div>
                          </div>
                          <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap text-xs', getOperationColor(record.operation))}>
                            {record.operation || 'update'}
                          </Badge>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const renderSyncStatusControls = (scope: string, compact = false) => (
    <div
      className={cn(
        'flex min-w-0 shrink-0 items-center',
        compact ? 'h-7 justify-end gap-1' : 'gap-2'
      )}
    >
      {renderConnectivityStatus(compact)}
      {renderFailedSyncItems(scope, compact)}
      {renderPendingSyncItems(scope, compact)}
    </div>
  );

  return (
    <>
      <header className="tauri-android-safe-top sticky top-0 z-10 w-full border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col px-3 pb-2 pt-1 sm:h-16 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-3 lg:px-8 2xl:px-10">
          <div className="flex w-full items-center justify-end gap-1 border-b border-border/50 pb-1 sm:hidden">
            {mobileTopActions}
            {renderSyncStatusControls('mobile', true)}
          </div>

          <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 pt-1 sm:min-h-0 sm:gap-4 sm:pt-0">
            {children}
          </div>

          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {renderSyncStatusControls('desktop')}
          </div>
        </div>
      </header>

      {propBranchId && (
        <ViewOrdersModal
          branchId={propBranchId}
          isOpen={showOrdersModal}
          onOpenChange={setShowOrdersModal}
          onRequestProcessSale={onProcessSaleOrder ? (order) => onProcessSaleOrder(order.id) : undefined}
          businessType={business?.type}
          currentUserRole={user?.role ?? null}
        />
      )}

      <AlertDialog open={showOutOfCreditsModal}>
        <AlertDialogContent className="w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Subscription Credits Finished</AlertDialogTitle>
            <AlertDialogDescription>
              Your account balance is {formatAmount(Math.max(subscriptionReminder?.balance ?? 0, 0))}. Add credits now to keep using all features.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={openBillingAddCredit}>
              Go to Billing and Add Credits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showLowFundsModal} onOpenChange={setShowLowFundsModal}>
        <AlertDialogContent className="w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Low Subscription Credits</AlertDialogTitle>
            <AlertDialogDescription>
              Remaining credits ({formatAmount(subscriptionReminder?.balance ?? 0)}) are below 20% of your monthly charge ({formatAmount(subscriptionReminder?.monthlyCharge ?? 0)}).
              {lowFundsThreshold > 0 ? ` Threshold: ${formatAmount(lowFundsThreshold)}.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Later</AlertDialogCancel>
            <AlertDialogAction onClick={openBillingAddCredit}>
              Add Credits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
