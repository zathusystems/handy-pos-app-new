'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm } from 'react-hook-form';
import { PlusCircle, Loader2, AlertTriangle, CheckCircle, History, DoorOpen, DoorClosed, MoreHorizontal, Package, ArrowLeft, Printer } from 'lucide-react';
import { format } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

import { db, type Session, type InventoryItem, type StockRecord, type Order } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { logAuditAction } from '@/lib/audit';
import { authFetch } from '@/lib/auth-fetch';
import { syncSessionOrdersToLocalDb } from '@/lib/session-order-sync';
import {
  buildStockTrackingInventoryLookup,
  getSoldOrderStockMovements,
} from '@/lib/session-stock-tracking';
import { syncService } from '@/lib/services/sync-service';
import {
  buildZReportPrintHtml,
  calculateZReportSummary,
  isSessionClosedForZReport,
  SESSION_END_REPORT_TITLE,
} from '@/lib/z-report-print';
import {
  formatInventoryQuantity,
  formatQuantityWithUnit,
  getPortionQuantityDisplay,
} from '@/lib/quantity-format';
import {
  StartSessionForm,
  CloseSessionForm,
  SessionDetailDialog,
  SessionHistoryModal,
  SaleDetailModal,
} from '@/app/dashboard/sessions/modals';
import { SessionPaginationControls, useSessionPagination } from './session-pagination';


const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch'
};
const BRANCHES_STORAGE_KEY = 'handypos-branches';

const isPlaceholderBranchId = (value?: string | null): boolean => {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return true;
    return ['main', 'main-branch', 'main_branch', 'nan', 'null', 'none', 'undefined'].includes(normalized);
};

const resolveValidBranchIdFromStorage = (): string | null => {
    if (typeof window === 'undefined') return null;

    const storedActiveBranch = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (storedActiveBranch && !isPlaceholderBranchId(storedActiveBranch)) {
        return storedActiveBranch;
    }

    try {
        const rawBranches = localStorage.getItem(BRANCHES_STORAGE_KEY);
        const parsedBranches = rawBranches ? JSON.parse(rawBranches) : [];
        if (Array.isArray(parsedBranches)) {
            const firstValidBranch = parsedBranches.find((branch: any) => {
                const candidateId = String(branch?.id ?? '').trim();
                return candidateId && !isPlaceholderBranchId(candidateId);
            });

            const resolvedId = String(firstValidBranch?.id ?? '').trim();
            if (resolvedId) {
                localStorage.setItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH, resolvedId);
                return resolvedId;
            }
        }
    } catch (error) {
        console.warn('[Sessions Page] Failed to parse stored branches:', error);
    }

    return storedActiveBranch ? String(storedActiveBranch).trim() : null;
};

type StockReconciliationItem = {
    name: string;
    opening: number;
    closing: number;
    sold: number;
    discrepancy: number;
}

const normalizeStockBranchId = (value?: string | number | null): string => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';

    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];

    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];

    return normalized;
};

const parseSessionDateTime = (value: unknown): Date | null => {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return null;
    }

    const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
    const hasExplicitTimezone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);

    if (hasExplicitTimezone) {
        const parsed = new Date(normalized);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const localDateMatch =
        /^(\d{4})-(\d{2})-(\d{2})(?:[T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(
            normalized
        );
    if (localDateMatch) {
        const [, year, month, day, hour = '0', minute = '0', second = '0', fractional = '0'] = localDateMatch;
        const milliseconds = Number.parseInt(fractional.padEnd(3, '0').slice(0, 3), 10) || 0;
        const parsed = new Date(
            Number.parseInt(year, 10),
            Number.parseInt(month, 10) - 1,
            Number.parseInt(day, 10),
            Number.parseInt(hour, 10),
            Number.parseInt(minute, 10),
            Number.parseInt(second, 10),
            milliseconds
        );
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const fallbackParsed = new Date(normalized);
    return Number.isNaN(fallbackParsed.getTime()) ? null : fallbackParsed;
};

const normalizeProductName = (value?: string | null): string => {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
};

const isMeaningfulProductName = (value?: string | null): boolean => {
    const normalized = normalizeProductName(value);
    return normalized !== '' && normalized !== 'unknown item' && normalized !== 'unknown';
};

const toProductIdKey = (itemId?: string | number | null): string => {
    const normalizedItemId = String(itemId ?? '').trim();
    if (!normalizedItemId) return '';
    return `id:${normalizedItemId}`;
};

const resolveCanonicalProductKey = (
    itemId: string | number | null | undefined,
    name: string | null | undefined,
    nameToId: Map<string, string>
): string => {
    const idKey = toProductIdKey(itemId);
    if (idKey) return idKey;

    const normalizedName = normalizeProductName(name);
    if (!normalizedName) return '';

    const mappedId = nameToId.get(normalizedName);
    if (mappedId) return `id:${mappedId}`;

    return `name:${normalizedName}`;
};

const resolveDisplayProductName = (
    itemId: string | number | null | undefined,
    name: string | null | undefined,
    idToName: Map<string, string>
): string => {
    const trimmedName = String(name ?? '').trim();
    if (isMeaningfulProductName(trimmedName)) return trimmedName;

    const normalizedItemId = String(itemId ?? '').trim();
    if (normalizedItemId && idToName.has(normalizedItemId)) {
        return idToName.get(normalizedItemId)!;
    }

    if (trimmedName) return trimmedName;
    return 'Unknown Item';
};

const getOrderItemInventoryId = (item: any): string | undefined => {
    const rawId = item?.inventoryItemId ?? item?.inventory_item_id ?? item?.inventoryItem ?? item?.inventory_item;
    if (rawId === undefined || rawId === null) return undefined;
    const normalized = String(rawId).trim();
    return normalized || undefined;
};

const toTrimmedString = (value: unknown): string => {
    if (value === undefined || value === null) {
        return '';
    }
    const trimmed = String(value).trim();
    return trimmed;
};

type InventoryQuantityMeta = {
    unitLabel: string;
    isSoldInPortions: boolean;
    portionName?: string;
    portionsPerUnit?: number;
};

const formatTrackedQuantity = (
    quantity: number,
    meta?: InventoryQuantityMeta,
    fallbackUnit?: string
): string => {
    const portionsPerUnit = Number(meta?.portionsPerUnit);
    if (meta?.isSoldInPortions && Number.isFinite(portionsPerUnit) && portionsPerUnit > 0) {
        const portionDisplay = getPortionQuantityDisplay({
            quantity,
            unitLabel: meta.unitLabel || fallbackUnit || 'unit',
            portionName: meta.portionName,
            portionsPerUnit,
        });
        if (portionDisplay) {
            return portionDisplay.summaryText;
        }
    }

    const unitLabel = toTrimmedString(meta?.unitLabel || fallbackUnit);
    if (unitLabel) {
        return formatQuantityWithUnit(quantity, unitLabel, {
            maximumFractionDigits: 3,
        });
    }

    return formatInventoryQuantity(quantity, {
        maximumFractionDigits: 3,
    });
};

type MobileReportField = {
    label: string;
    value: React.ReactNode;
    valueClassName?: string;
    fullWidth?: boolean;
};

const MobileReportFieldGrid = ({ fields }: { fields: MobileReportField[] }) => (
    <div className="grid grid-cols-2 gap-2 text-xs">
        {fields.map((field, index) => (
            <div
                key={`${field.label}-${index}`}
                className={field.fullWidth ? 'col-span-2 rounded-md bg-muted p-2' : 'rounded-md bg-muted p-2'}
            >
                <p className="text-muted-foreground">{field.label}</p>
                <div className={field.valueClassName || 'mt-1 break-words font-medium'}>
                    {field.value}
                </div>
            </div>
        ))}
    </div>
);

const resolveBuyerField = (...candidates: Array<unknown>): string => {
    for (const candidate of candidates) {
        const trimmed = toTrimmedString(candidate);
        if (trimmed) {
            return trimmed;
        }
    }
    return '';
};

const resolveBuyerDetails = (order: Order | null | undefined) => {
    const source = order as any;
    const customer = source?.customer ?? {};
    const buyer = source?.buyer ?? {};
    const name = resolveBuyerField(
        source?.customerName,
        source?.customer_name,
        source?.buyerName,
        source?.buyer_name,
        customer?.name,
        customer?.fullName,
        buyer?.name,
        buyer?.fullName
    );
    const phone = resolveBuyerField(
        source?.customerPhone,
        source?.customer_phone,
        source?.buyerPhone,
        source?.buyer_phone,
        customer?.phone,
        customer?.phoneNumber,
        buyer?.phone,
        buyer?.phoneNumber
    );
    const tin = resolveBuyerField(
        source?.customerTin,
        source?.customer_tin,
        source?.buyerTin,
        source?.buyer_tin,
        customer?.tin,
        customer?.taxPin,
        customer?.tax_pin,
        buyer?.tin,
        buyer?.taxPin,
        buyer?.tax_pin
    );

    return {
        name: name || '',
        phone: phone || '',
        tin: tin || '',
    };
};

const resolveEisStatus = (order: Order | null | undefined): string => {
    const source = order as any;
    const status = toTrimmedString(source?.eisStatus ?? source?.eis_status);
    return status ? status.toUpperCase() : '';
};

const sortOrdersByMostRecent = (orders: Order[]): Order[] => {
    return [...orders].sort((a, b) => {
        const timeA = Date.parse(String((a as any)?.createdAt ?? (a as any)?.created_at ?? ''));
        const timeB = Date.parse(String((b as any)?.createdAt ?? (b as any)?.created_at ?? ''));
        const normalizedTimeA = Number.isFinite(timeA) ? timeA : 0;
        const normalizedTimeB = Number.isFinite(timeB) ? timeB : 0;
        if (normalizedTimeB !== normalizedTimeA) {
            return normalizedTimeB - normalizedTimeA;
        }

        const orderNumberA = Number((a as any)?.orderNumber ?? (a as any)?.order_number ?? 0);
        const orderNumberB = Number((b as any)?.orderNumber ?? (b as any)?.order_number ?? 0);
        const normalizedOrderNumberA = Number.isFinite(orderNumberA) ? orderNumberA : 0;
        const normalizedOrderNumberB = Number.isFinite(orderNumberB) ? orderNumberB : 0;
        if (normalizedOrderNumberB !== normalizedOrderNumberA) {
            return normalizedOrderNumberB - normalizedOrderNumberA;
        }

        return String((b as any)?.id ?? '').localeCompare(String((a as any)?.id ?? ''));
    });
};

const SessionSalesList = ({ sessionId }: { sessionId: string }) => {
  const { format: formatCurrency } = useCurrency();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  
  const sessionOrders = useLiveQuery(
    () => db.orders.where({ sessionId }).toArray(),
    [sessionId, refreshKey]
  ) || [];
  const orderedSessionSales = useMemo(() => sortOrdersByMostRecent(sessionOrders), [sessionOrders]);
  const {
    currentPage: salesCurrentPage,
    setCurrentPage: setSalesCurrentPage,
    totalItems: salesTotalItems,
    totalPages: salesTotalPages,
    pageStartIndex: salesPageStartIndex,
    pageEndIndex: salesPageEndIndex,
    paginatedItems: paginatedSessionSales,
  } = useSessionPagination(orderedSessionSales, 10);

  const orderStatusBadge: Record<Order['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    New: 'default',
    Preparing: 'secondary',
    Ready: 'outline',
    Completed: 'default',
    Voided: 'destructive',
    Cancelled: 'destructive',
    Refunded: 'destructive',
    'Partially Refunded': 'destructive',
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Sales List</CardTitle>
          <CardDescription>{orderedSessionSales.length} sale{orderedSessionSales.length !== 1 ? 's' : ''} recorded in this session</CardDescription>
        </CardHeader>
        <CardContent>
          {orderedSessionSales.length > 0 ? (
            <>
              <div className="space-y-3 sm:hidden">
                {paginatedSessionSales.map((order) => {
                  const buyerDetails = resolveBuyerDetails(order);
                  const buyerName = buyerDetails.name || 'Walk-in';
                  const eisStatus = resolveEisStatus(order);
                  const isEisPending = eisStatus === 'PENDING' || (!eisStatus && Boolean((order as any)?._dirty));

                  return (
                    <Card
                      key={`sale-mobile-${order.id}`}
                      className={`mobile-data-card border ${order.status === 'Voided' ? 'opacity-60' : ''}`}
                    >
                      <CardContent className="space-y-3 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium break-words">Order #{order.orderNumber}</p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(order.createdAt), 'PPp')}
                            </p>
                          </div>
                          <p className="text-sm font-bold whitespace-nowrap">
                            {formatCurrency(order.total)}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={orderStatusBadge[order.status]}>
                            {order.status}
                          </Badge>
                          {isEisPending && (
                            <Badge variant="outline" className="border-amber-300 text-amber-700">
                              EIS Pending
                            </Badge>
                          )}
                        </div>

                        <MobileReportFieldGrid
                          fields={[
                            {
                              label: 'Buyer',
                              value: buyerDetails.phone ? `${buyerName} • ${buyerDetails.phone}` : buyerName,
                            },
                            {
                              label: 'Items',
                              value: `${order.items.length} item${order.items.length !== 1 ? 's' : ''}`,
                            },
                            {
                              label: 'Payment',
                              value: order.paymentMethod,
                            },
                            {
                              label: 'Tax',
                              value: formatCurrency(order.tax),
                            },
                            {
                              label: 'Subtotal',
                              value: formatCurrency(order.subtotal),
                            },
                            {
                              label: 'Total',
                              value: formatCurrency(order.total),
                              valueClassName: 'mt-1 font-semibold',
                            },
                          ]}
                        />

                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => setSelectedOrder(order)}
                        >
                          View Sale Details
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order #</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                      <TableHead className="text-right">Tax</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedSessionSales.map((order) => {
                      const buyerDetails = resolveBuyerDetails(order);
                      const buyerName = buyerDetails.name || 'Walk-in';
                      const eisStatus = resolveEisStatus(order);
                      const isEisPending = eisStatus === 'PENDING' || (!eisStatus && Boolean((order as any)?._dirty));
                      return (
                        <TableRow
                          key={order.id}
                          className={`cursor-pointer hover:bg-muted/50 ${order.status === 'Voided' ? 'opacity-60' : ''}`}
                          onClick={() => setSelectedOrder(order)}
                        >
                          <TableCell className="font-medium">#{order.orderNumber}</TableCell>
                          <TableCell className="text-sm">{format(new Date(order.createdAt), 'HH:mm:ss')}</TableCell>
                          <TableCell className="text-sm">
                            <div className="font-medium">{buyerName}</div>
                            {buyerDetails.phone && (
                              <div className="text-xs text-muted-foreground">{buyerDetails.phone}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{order.items.length} item{order.items.length !== 1 ? 's' : ''}</TableCell>
                          <TableCell className="text-sm">{order.paymentMethod}</TableCell>
                          <TableCell>
                            <div className="flex flex-col items-start gap-1">
                              <Badge variant={orderStatusBadge[order.status]}>
                                {order.status}
                              </Badge>
                              {isEisPending && (
                                <Badge variant="outline" className="border-amber-300 text-amber-700">
                                  EIS Pending
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm">{formatCurrency(order.subtotal)}</TableCell>
                          <TableCell className="text-right text-sm">{formatCurrency(order.tax)}</TableCell>
                          <TableCell className="text-right font-medium text-sm">{formatCurrency(order.total)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <SessionPaginationControls
                currentPage={salesCurrentPage}
                totalItems={salesTotalItems}
                totalPages={salesTotalPages}
                pageStartIndex={salesPageStartIndex}
                pageEndIndex={salesPageEndIndex}
                onPageChange={setSalesCurrentPage}
                itemLabel="sales"
              />
            </>
          ) : (
            <div className="flex min-h-24 items-center justify-center text-center">
              <p className="text-muted-foreground">No sales recorded yet in this session.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <SaleDetailModal 
        order={selectedOrder}
        isOpen={!!selectedOrder}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedOrder(null);
            // Trigger refresh of orders list when modal closes (in case order was voided)
            setRefreshKey(prev => prev + 1);
          }
        }}
      />
    </>
  );
};


//on here session detail modal 

const ZReportTab = ({ session }: { session: Session }) => {
    const { format: formatCurrency } = useCurrency();
    const [isPrintingZReport, setIsPrintingZReport] = useState(false);
    
    const sessionOrders = useLiveQuery(
        () => db.orders.where({ sessionId: session.id }).toArray(),
        [session.id]
    ) || [];

    const { paymentBreakdown, financialSummary, eisSummary } = useMemo(
        () => calculateZReportSummary(sessionOrders as any),
        [sessionOrders]
    );

    const isSessionClosed = isSessionClosedForZReport(session);
    const formatOptionalDateTime = (value?: string) => {
        if (!value) return 'N/A';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return 'N/A';
        return format(parsed, 'PPpp');
    };

    const handlePrintZReport = useCallback(async () => {
        if (!isSessionClosed) {
            return;
        }

        try {
            setIsPrintingZReport(true);
            let reportOrders = sessionOrders;
            try {
                const syncedOrders = await syncSessionOrdersToLocalDb({
                    sessionId: session.id,
                    branchId: String(session.branchId || ''),
                });
                if (syncedOrders.length > 0) {
                    reportOrders = syncedOrders;
                }
            } catch (syncError) {
                console.warn('[Sessions Page] Could not refresh session orders before printing report:', syncError);
            }

            const reportSummary = calculateZReportSummary(reportOrders as any);
            const activeBranchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH) || 'main';
            const [{ printerService }, { silentPrintService }] = await Promise.all([
                import('@/lib/services/printer-service'),
                import('@/lib/services/silent-print-service'),
            ]);

            const [printerSettings, defaultPrinter] = await Promise.all([
                printerService.getPrinterSettings(activeBranchId),
                printerService.getDefaultPrinter(activeBranchId),
            ]);

            if (!defaultPrinter) {
                toast({
                    variant: 'destructive',
                    title: 'No Printer Configured',
                    description: `Please configure a default printer before printing the ${SESSION_END_REPORT_TITLE.toLowerCase()}.`,
                });
                return;
            }

            const selectedPaperSize: '80mm' | '58mm' =
                printerSettings.receiptPaperWidth === '58mm' ? '58mm' : '80mm';

            const htmlContent = buildZReportPrintHtml({
                session,
                paymentBreakdown: reportSummary.paymentBreakdown,
                financialSummary: reportSummary.financialSummary,
                eisSummary: reportSummary.eisSummary,
                formatCurrency,
            });

            const didPrint = await silentPrintService.printSilentlyViaSystem(htmlContent, {
                printerName: defaultPrinter.name,
                printerId: defaultPrinter.id,
                copies: 1,
                paperSize: selectedPaperSize,
                printerPaperSize: defaultPrinter.paperWidth === '58mm' ? '58mm' : '80mm',
                timeout: 20000,
            });

            if (!didPrint) {
                toast({
                    variant: 'destructive',
                    title: 'Print Failed',
                    description: `Could not print the ${SESSION_END_REPORT_TITLE.toLowerCase()}. Check the printer connection and try again.`,
                });
                return;
            }

            toast({
                title: `${SESSION_END_REPORT_TITLE} Printed`,
                description: `Sent to ${defaultPrinter.name}`,
            });
        } catch (error) {
            console.error('Error printing session end report:', error);
            toast({
                variant: 'destructive',
                title: 'Print Error',
                description:
                    error instanceof Error
                        ? error.message
                        : `Unexpected error while printing the ${SESSION_END_REPORT_TITLE.toLowerCase()}.`,
            });
        } finally {
            setIsPrintingZReport(false);
        }
    }, [formatCurrency, isSessionClosed, session, sessionOrders]);

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <CardTitle>{SESSION_END_REPORT_TITLE}</CardTitle>
                        <CardDescription>Complete session summary and cash reconciliation</CardDescription>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!isSessionClosed || isPrintingZReport}
                        onClick={handlePrintZReport}
                    >
                        {isPrintingZReport ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Printer className="mr-2 h-4 w-4" />
                        )}
                        {isPrintingZReport ? 'Printing...' : `Print ${SESSION_END_REPORT_TITLE}`}
                    </Button>
                </div>
                {!isSessionClosed && (
                    <p className="text-xs text-muted-foreground">
                        Close this session first to print the {SESSION_END_REPORT_TITLE.toLowerCase()}.
                    </p>
                )}
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Sales & Collection Summary</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Orders:</span>
                                <span className="font-semibold">{financialSummary.orderCount}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Session Sales Value:</span>
                                <span className="font-semibold">{formatCurrency(session.totalSales || 0)}</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Net Sales:</span>
                                <span>{formatCurrency(financialSummary.netSales)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Total Tax:</span>
                                <span>{formatCurrency(financialSummary.totalTax)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Gross Sales:</span>
                                <span>{formatCurrency(financialSummary.grossSales)}</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Cash Collected:</span>
                                <span>{formatCurrency(paymentBreakdown.cash)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Card Collected:</span>
                                <span>{formatCurrency(paymentBreakdown.card)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Mobile Money Collected:</span>
                                <span>{formatCurrency(paymentBreakdown.mobileMoney)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Account / Invoice Due:</span>
                                <span>{formatCurrency(paymentBreakdown.onAccount)}</span>
                            </div>
                            {paymentBreakdown.laybuyDeposits > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Laybuy Deposits:</span>
                                    <span>{formatCurrency(paymentBreakdown.laybuyDeposits)}</span>
                                </div>
                            )}
                            {paymentBreakdown.laybuyOutstanding > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Laybuy Outstanding:</span>
                                    <span>{formatCurrency(paymentBreakdown.laybuyOutstanding)}</span>
                                </div>
                            )}
                            {paymentBreakdown.other > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Other Collected:</span>
                                    <span>{formatCurrency(paymentBreakdown.other)}</span>
                                </div>
                            )}
                            <Separator />
                            <div className="flex justify-between font-semibold">
                                <span>Total Collected:</span>
                                <span>{formatCurrency(paymentBreakdown.totalCollected)}</span>
                            </div>
                            <div className="flex justify-between font-semibold">
                                <span>Still Due:</span>
                                <span>{formatCurrency(paymentBreakdown.totalDue)}</span>
                            </div>
                        </CardContent>
                    </Card>
                    
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Cash Reconciliation</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Opening Float:</span>
                                <span className="font-semibold">{formatCurrency(session.openingFloat || 0)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">+ Cash Collected:</span>
                                <span className="text-green-600">{formatCurrency(paymentBreakdown.cash)}</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between font-semibold">
                                <span>Expected in Drawer:</span>
                                <span>{formatCurrency((session.openingFloat || 0) + paymentBreakdown.cash)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Actual Cash:</span>
                                <span>{formatCurrency(session.actualCash || 0)}</span>
                            </div>
                            <Separator />
                            <div className={`flex justify-between font-semibold p-2 rounded ${(session.difference || 0) === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                <span>Difference:</span>
                                <span>{formatCurrency(session.difference || 0)}</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">EIS Compliance</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Fiscal Assigned:</span>
                                <span className="font-semibold">{eisSummary.ordersWithFiscalNumber}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Fiscal Pending:</span>
                                <span>{eisSummary.pendingFiscalNumber}</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">EIS Pending:</span>
                                <span>{eisSummary.eisStatusCounts.pending}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">EIS Submitted:</span>
                                <span>{eisSummary.eisStatusCounts.submitted}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">EIS Accepted:</span>
                                <span className="text-green-600">{eisSummary.eisStatusCounts.accepted}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">EIS Rejected:</span>
                                <span className="text-red-600">{eisSummary.eisStatusCounts.rejected}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">EIS Unknown:</span>
                                <span>{eisSummary.eisStatusCounts.unknown}</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">With QR:</span>
                                <span>{eisSummary.ordersWithQr}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">With Signature:</span>
                                <span>{eisSummary.ordersWithSignature}</span>
                            </div>
                            <Separator />
                            <div className="space-y-1 text-xs">
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">First Fiscal #:</span>
                                    <span className="font-medium break-all text-right">{eisSummary.firstFiscalInvoice || 'N/A'}</span>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Last Fiscal #:</span>
                                    <span className="font-medium break-all text-right">{eisSummary.lastFiscalInvoice || 'N/A'}</span>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">First Submission:</span>
                                    <span className="text-right">{formatOptionalDateTime(eisSummary.firstSubmissionAt)}</span>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Last Submission:</span>
                                    <span className="text-right">{formatOptionalDateTime(eisSummary.lastSubmissionAt)}</span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </CardContent>
        </Card>
    );
};

const StockReportTab = ({ session }: { session: Session }) => {
    const { format: formatCurrency } = useCurrency();
    
    const sessionOrders = useLiveQuery(
        () => db.orders.where({ sessionId: session.id }).toArray(),
        [session.id]
    ) || [];

    // Fetch purchases received during this session
    const sessionPurchases = useLiveQuery(
        async () => {
            // Query purchases by sessionId first (NEW: direct session linking)
            const purchasesBySession = await db.purchaseHistory
                .where('sessionId')
                .equals(session.id)
                .toArray();
            
            let purchases = purchasesBySession;
            
            if (session.startedAt) {
                const startTime = new Date(session.startedAt);
                const endTime = session.closedAt ? new Date(session.closedAt) : new Date();
                const normalizedSessionBranchId = normalizeStockBranchId(session.branchId);
                
                // Get all purchase records and filter by branch/time for backward compatibility
                const allPurchases = await db.purchaseHistory.toArray();
                const purchasesInWindow = allPurchases.filter(p => {
                    if (normalizeStockBranchId(p.branchId) !== normalizedSessionBranchId) return false;
                    const receivedTime = new Date(p.receivedDate);
                    return receivedTime >= startTime && receivedTime <= endTime;
                });

                if (purchasesBySession.length === 0) {
                    purchases = purchasesInWindow;
                } else {
                    const merged = new Map<string, typeof purchasesBySession[number]>();
                    const recordKey = (purchase: typeof purchasesBySession[number]) => {
                        const id = String((purchase as any).id ?? '').trim();
                        if (id) return `id:${id}`;
                        return `fallback:${String(purchase.productId ?? '').trim()}|${String(purchase.receivedDate ?? '').trim()}|${String(purchase.batchNumber ?? '').trim()}|${String(purchase.quantityReceived ?? '')}`;
                    };

                    purchasesBySession.forEach((purchase) => {
                        merged.set(recordKey(purchase), purchase);
                    });
                    purchasesInWindow.forEach((purchase) => {
                        const key = recordKey(purchase);
                        if (!merged.has(key)) {
                            merged.set(key, purchase);
                        }
                    });

                    purchases = Array.from(merged.values());
                }
            }

            if (purchasesBySession.length > 0) {
                console.log('[Sessions] Found', purchasesBySession.length, 'purchase records linked to session:', session.id);
            }

            const inventoryItems = await db.inventory.toArray();
            const inventoryNameById = new Map(inventoryItems.map((item) => [String(item.id), item.name]));

            return purchases.map((purchase) => {
                const fallbackName = purchase.productId ? inventoryNameById.get(String(purchase.productId)) : undefined;
                const resolvedName = isMeaningfulProductName(purchase.productName)
                    ? String(purchase.productName).trim()
                    : (fallbackName || 'Unknown Item');

                return {
                    ...purchase,
                    productName: resolvedName,
                };
            });
        },
        [session.id, session.startedAt, session.closedAt, session.branchId]
    ) || [];

    // Fetch waste records during this session
    const sessionWaste = useLiveQuery(
        async () => {
            // Query waste records by sessionId first (NEW: direct session linking)
            const wasteBySession = await db.wasteLog
                .where('sessionId')
                .equals(session.id)
                .toArray();
            
            let wasteRecords = wasteBySession;
            
            if (session.startedAt) {
                const startTime = new Date(session.startedAt);
                const endTime = session.closedAt ? new Date(session.closedAt) : new Date();
                const normalizedSessionBranchId = normalizeStockBranchId(session.branchId);
                
                // Get all waste records and filter by branch/time for backward compatibility
                const allWaste = await db.wasteLog.toArray();
                const wasteInWindow = allWaste.filter(w => {
                    if (normalizeStockBranchId(w.branchId) !== normalizedSessionBranchId) return false;
                    const recordedTime = new Date(w.recordedAt);
                    return recordedTime >= startTime && recordedTime <= endTime;
                });

                if (wasteBySession.length === 0) {
                    wasteRecords = wasteInWindow;
                } else {
                    const merged = new Map<string, typeof wasteBySession[number]>();
                    const recordKey = (waste: typeof wasteBySession[number]) => {
                        const id = String((waste as any).id ?? '').trim();
                        if (id) return `id:${id}`;
                        return `fallback:${String(waste.itemId ?? '').trim()}|${String(waste.recordedAt ?? '').trim()}|${String(waste.quantity ?? '')}`;
                    };

                    wasteBySession.forEach((waste) => {
                        merged.set(recordKey(waste), waste);
                    });
                    wasteInWindow.forEach((waste) => {
                        const key = recordKey(waste);
                        if (!merged.has(key)) {
                            merged.set(key, waste);
                        }
                    });

                    wasteRecords = Array.from(merged.values());
                }
            }

            if (wasteBySession.length > 0) {
                console.log('[Sessions] Found', wasteBySession.length, 'waste records linked to session:', session.id);
            }

            const inventoryItems = await db.inventory.toArray();
            const inventoryNameById = new Map(inventoryItems.map((item) => [String(item.id), item.name]));

            return wasteRecords.map((waste) => {
                const fallbackName = waste.itemId ? inventoryNameById.get(String(waste.itemId)) : undefined;
                const resolvedName = isMeaningfulProductName(waste.itemName)
                    ? String(waste.itemName).trim()
                    : (fallbackName || 'Unknown Item');

                return {
                    ...waste,
                    itemName: resolvedName,
                };
            });
        },
        [session.id, session.startedAt, session.closedAt, session.branchId]
    ) || [];

    const paymentBreakdown = useMemo(
        () => calculateZReportSummary(sessionOrders as any).paymentBreakdown,
        [sessionOrders]
    );

    const sessionInventoryItems = useLiveQuery(
        async () => db.inventory.toArray(),
        []
    ) || [];

    const stockTrackingInventoryLookup = useMemo(
        () => buildStockTrackingInventoryLookup(sessionInventoryItems),
        [sessionInventoryItems]
    );

    const productIdentity = useMemo(() => {
        const nameToId = new Map<string, string>();
        const idToName = new Map<string, string>();

        const registerIdentity = (itemId?: string | number | null, name?: string | null) => {
            const normalizedItemId = String(itemId ?? '').trim();
            const trimmedName = String(name ?? '').trim();
            if (!normalizedItemId || !isMeaningfulProductName(trimmedName)) return;

            const normalizedName = normalizeProductName(trimmedName);
            nameToId.set(normalizedName, normalizedItemId);

            if (!idToName.has(normalizedItemId)) {
                idToName.set(normalizedItemId, trimmedName);
            }
        };

        (session.openingStock || []).forEach((item: any) => registerIdentity(item.itemId, item.name));
        sessionInventoryItems.forEach((item) => registerIdentity(item.id, item.name));
        sessionPurchases.forEach((purchase) => registerIdentity(purchase.productId, purchase.productName));
        sessionWaste.forEach((waste) => registerIdentity(waste.itemId, waste.itemName));
        sessionOrders.forEach((order) => {
            order.items?.forEach((item) => {
                registerIdentity(getOrderItemInventoryId(item), item.name);
                getSoldOrderStockMovements(item, stockTrackingInventoryLookup).forEach((movement) => {
                    registerIdentity(movement.itemId, movement.name);
                });
            });
        });

        return { nameToId, idToName };
    }, [session.openingStock, sessionInventoryItems, sessionOrders, sessionPurchases, sessionWaste, stockTrackingInventoryLookup]);

    const inventoryQuantityIds = useMemo(
        () => Array.from(productIdentity.idToName.keys()).filter((id) => id.length > 0),
        [productIdentity]
    );

    const inventoryQuantityMetaById = useLiveQuery(
        async () => {
            if (inventoryQuantityIds.length === 0) {
                return {} as Record<string, InventoryQuantityMeta>;
            }

            const inventoryItems = await db.inventory.bulkGet(inventoryQuantityIds);
            const nextMap: Record<string, InventoryQuantityMeta> = {};

            inventoryItems.forEach((inventoryItem, index) => {
                const inventoryId = inventoryQuantityIds[index];
                if (!inventoryItem || !inventoryId) {
                    return;
                }

                nextMap[inventoryId] = {
                    unitLabel:
                        toTrimmedString((inventoryItem as any).unitType) ||
                        toTrimmedString((inventoryItem as any).unit_type) ||
                        toTrimmedString((inventoryItem as any).unit) ||
                        'unit',
                    isSoldInPortions: Boolean((inventoryItem as any).isSoldInPortions),
                    portionName: toTrimmedString((inventoryItem as any).portionName),
                    portionsPerUnit: Number((inventoryItem as any).portionsPerUnit || 0),
                };
            });

            return nextMap;
        },
        [inventoryQuantityIds.join('|')]
    ) || {};

    const formatSessionQuantity = useCallback(
        (productKey: string, quantity: number, fallbackUnit?: string) => {
            const inventoryId = productKey.startsWith('id:') ? productKey.slice(3) : '';
            const meta = inventoryId ? inventoryQuantityMetaById[inventoryId] : undefined;
            return formatTrackedQuantity(quantity, meta, fallbackUnit);
        },
        [inventoryQuantityMetaById]
    );

    // Calculate product sales from orders (excluding voided/cancelled orders)
    const productSalesData = useMemo(() => {
        const productMap = new Map<string, { key: string; name: string; quantity: number; totalCash: number }>();

        // Filter out voided and cancelled orders
        const activeOrders = sessionOrders.filter(order => 
            order.status !== 'Voided' && order.status !== 'Cancelled'
        );

        // Aggregate items from active orders only
        activeOrders.forEach(order => {
            order.items?.forEach(item => {
                const itemInventoryId = getOrderItemInventoryId(item);
                const key = resolveCanonicalProductKey(itemInventoryId, item.name, productIdentity.nameToId);
                if (!key) return;

                if (!productMap.has(key)) {
                    productMap.set(key, {
                        key,
                        name: resolveDisplayProductName(itemInventoryId, item.name, productIdentity.idToName),
                        quantity: 0,
                        totalCash: 0,
                    });
                }
                const product = productMap.get(key)!;
                const resolvedName = resolveDisplayProductName(itemInventoryId, item.name, productIdentity.idToName);
                if (!product.name || product.name === 'Unknown Item') {
                    product.name = resolvedName;
                }

                const quantity = parseFloat(String(item.quantity ?? 0));
                const safeQuantity = Number.isFinite(quantity) ? quantity : 0;
                const unitPrice = parseFloat(String(item.price ?? 0));
                const safeUnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0;
                const lineTotal = parseFloat(String(item.total ?? safeUnitPrice * safeQuantity));
                const safeLineTotal = Number.isFinite(lineTotal) ? lineTotal : safeUnitPrice * safeQuantity;

                product.quantity += safeQuantity;
                product.totalCash += safeLineTotal;
            });
        });

        return Array.from(productMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [sessionOrders, productIdentity]);
    const {
        currentPage: productSalesCurrentPage,
        setCurrentPage: setProductSalesCurrentPage,
        totalItems: productSalesTotalItems,
        totalPages: productSalesTotalPages,
        pageStartIndex: productSalesPageStartIndex,
        pageEndIndex: productSalesPageEndIndex,
        paginatedItems: paginatedProductSalesData,
    } = useSessionPagination(productSalesData, 10);

    // Aggregate purchases by product for display
    const purchasesData = useMemo(() => {
        const purchaseMap = new Map<string, { 
            key: string;
            name: string; 
            quantity: number; 
            totalCost: number; 
            unitCost: number;
            vatAmount: number;
            vatMethod: 'inclusive' | 'exclusive' | 'mixed';
            supplier: string;
            batchNumber?: string;
            expiryDate?: string;
        }>();

        const normalizeMethod = (value: unknown): 'inclusive' | 'exclusive' => {
            return value === 'inclusive' ? 'inclusive' : 'exclusive';
        };

        const resolveVatAmount = (purchase: any, method: 'inclusive' | 'exclusive'): number => {
            const taxRate = Number(purchase.taxRate);
            const base = Number(purchase.totalCost || 0);
            if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(taxRate) || taxRate <= 0) {
                return typeof purchase.taxAmount === 'number' && Number.isFinite(purchase.taxAmount)
                    ? purchase.taxAmount
                    : 0;
            }
            if (method === 'inclusive') {
                return base - base / (1 + taxRate / 100);
            }
            return base * (taxRate / 100);
        };

        sessionPurchases.forEach(purchase => {
            const key = resolveCanonicalProductKey(purchase.productId, purchase.productName, productIdentity.nameToId);
            if (!key) return;

            const method = normalizeMethod(purchase.taxCalculationMethod);
            const vatAmount = resolveVatAmount(purchase, method);

            if (!purchaseMap.has(key)) {
                purchaseMap.set(key, {
                    key,
                    name: resolveDisplayProductName(purchase.productId, purchase.productName, productIdentity.idToName),
                    quantity: 0,
                    totalCost: 0,
                    unitCost: purchase.costPerUnit,
                    vatAmount: 0,
                    vatMethod: method,
                    supplier: purchase.supplierName || 'Unknown Supplier',
                    batchNumber: purchase.batchNumber,
                    expiryDate: purchase.expiryDate,
                });
            }
            const item = purchaseMap.get(key)!;
            const resolvedName = resolveDisplayProductName(purchase.productId, purchase.productName, productIdentity.idToName);
            if (!item.name || item.name === 'Unknown Item') {
                item.name = resolvedName;
            }
            if (item.vatMethod !== method) {
                item.vatMethod = 'mixed';
            }
            item.quantity += purchase.quantityReceived;
            item.totalCost += purchase.totalCost;
            item.vatAmount += vatAmount;
        });

        return Array.from(purchaseMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [sessionPurchases, productIdentity]);

    // Calculate comprehensive stock tracking: Opening + Received - Sold - Waste = Remaining
    const comprehensiveStockData = useMemo(() => {
        const productMap = new Map<string, {
            key: string;
            name: string;
            opening: number;
            received: number;
            sold: number;
            waste: number;
        }>();

        const ensureProduct = (key: string, name?: string) => {
            if (!productMap.has(key)) {
                productMap.set(key, {
                    key,
                    name: name || 'Unknown Item',
                    opening: 0,
                    received: 0,
                    sold: 0,
                    waste: 0,
                });
            }
            const existing = productMap.get(key)!;
            if (name && (!existing.name || existing.name === 'Unknown Item')) {
                existing.name = name;
            }
            return existing;
        };

        const activeOrders = sessionOrders.filter(order => 
            order.status !== 'Voided' && order.status !== 'Cancelled'
        );

        // Opening stock snapshot
        (session.openingStock || []).forEach((item: any) => {
            const key = resolveCanonicalProductKey(item.itemId, item.name, productIdentity.nameToId);
            if (!key) return;
            const resolvedName = resolveDisplayProductName(item.itemId, item.name, productIdentity.idToName);
            const row = ensureProduct(key, resolvedName);
            row.opening += parseFloat(String(item.quantity || 0));
        });

        // Received in session
        sessionPurchases.forEach((purchase) => {
            const key = resolveCanonicalProductKey(purchase.productId, purchase.productName, productIdentity.nameToId);
            if (!key) return;
            const resolvedName = resolveDisplayProductName(purchase.productId, purchase.productName, productIdentity.idToName);
            const row = ensureProduct(key, resolvedName);
            row.received += parseFloat(String(purchase.quantityReceived || 0));
        });

        // Sold in session
        activeOrders.forEach((order) => {
            order.items?.forEach((item) => {
                getSoldOrderStockMovements(item, stockTrackingInventoryLookup).forEach((movement) => {
                    const key = resolveCanonicalProductKey(movement.itemId, movement.name, productIdentity.nameToId);
                    if (!key) return;
                    const resolvedName = resolveDisplayProductName(movement.itemId, movement.name, productIdentity.idToName);
                    const row = ensureProduct(key, resolvedName);
                    row.sold += movement.quantity;
                });
            });
        });

        // Wasted in session
        sessionWaste.forEach((waste) => {
            const key = resolveCanonicalProductKey(waste.itemId, waste.itemName, productIdentity.nameToId);
            if (!key) return;
            const resolvedName = resolveDisplayProductName(waste.itemId, waste.itemName, productIdentity.idToName);
            const row = ensureProduct(key, resolvedName);
            row.waste += parseFloat(String(waste.quantity || 0));
        });

        return Array.from(productMap.values())
            .map((row) => ({
                key: row.key,
                name: row.name,
                opening: row.opening,
                received: row.received,
                sold: row.sold,
                waste: row.waste,
                remaining: Math.max(0, row.opening + row.received - row.sold - row.waste),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [session.openingStock, sessionOrders, sessionPurchases, sessionWaste, productIdentity, stockTrackingInventoryLookup]);

    const optionStockUsageData = useMemo(() => {
        const usageMap = new Map<string, {
            key: string;
            itemKey: string;
            name: string;
            quantity: number;
            parentItemName: string;
            optionName: string;
            optionGroupName?: string;
        }>();

        const activeOrders = sessionOrders.filter(order => 
            order.status !== 'Voided' && order.status !== 'Cancelled'
        );

        activeOrders.forEach((order) => {
            order.items?.forEach((item) => {
                getSoldOrderStockMovements(item, stockTrackingInventoryLookup)
                    .filter((movement) => movement.source === 'option')
                    .forEach((movement) => {
                        const itemKey = resolveCanonicalProductKey(movement.itemId, movement.name, productIdentity.nameToId);
                        if (!itemKey) return;

                        const resolvedName = resolveDisplayProductName(movement.itemId, movement.name, productIdentity.idToName);
                        const parentItemName = String(movement.parentItemName || item.name || 'Menu item').trim();
                        const optionName = String(movement.optionName || 'Selected option').trim();
                        const optionGroupName = String(movement.optionGroupName || '').trim() || undefined;
                        const key = [
                            itemKey,
                            normalizeProductName(parentItemName),
                            normalizeProductName(optionName),
                            normalizeProductName(optionGroupName),
                        ].join('|');

                        if (!usageMap.has(key)) {
                            usageMap.set(key, {
                                key,
                                itemKey,
                                name: resolvedName,
                                quantity: 0,
                                parentItemName,
                                optionName,
                                optionGroupName,
                            });
                        }

                        usageMap.get(key)!.quantity += movement.quantity;
                    });
            });
        });

        return Array.from(usageMap.values()).sort((a, b) => {
            const itemCompare = a.name.localeCompare(b.name);
            if (itemCompare !== 0) return itemCompare;
            return `${a.parentItemName} ${a.optionName}`.localeCompare(`${b.parentItemName} ${b.optionName}`);
        });
    }, [sessionOrders, productIdentity, stockTrackingInventoryLookup]);

    return (
        <Card className="min-h-[500px]">
            <CardHeader>
                <CardTitle>Stock Report</CardTitle>
                <CardDescription>Product sales quantities, cash value, and remaining stock</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Tabs defaultValue="sold" className="w-full">
                    <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
                        <TabsTrigger value="sold" className="text-xs sm:text-sm">Sold ({productSalesData.length})</TabsTrigger>
                        <TabsTrigger value="received" className="text-xs sm:text-sm">Received ({purchasesData.length})</TabsTrigger>
                        <TabsTrigger value="waste" className="text-xs sm:text-sm">Waste ({sessionWaste.length})</TabsTrigger>
                        <TabsTrigger value="tracking" className="text-xs sm:text-sm">Tracking ({comprehensiveStockData.length})</TabsTrigger>
                    </TabsList>
                    <TabsContent value="sold" className="mt-4 min-h-[340px]">
                {/* Products Sold */}
                <div className="space-y-0">
                    <h3 className="font-semibold mb-3">Products Sold</h3>
                    {productSalesData.length > 0 ? (
                        <div className="space-y-0">
                            <div className="space-y-3 sm:hidden">
                                {paginatedProductSalesData.map((product) => (
                                    <Card key={`sold-mobile-${product.key}`} className="mobile-data-card border">
                                        <CardContent className="space-y-3 p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-medium break-words">{product.name}</p>
                                                    <p className="text-xs text-muted-foreground">Product sale summary</p>
                                                </div>
                                                <p className="text-sm font-bold whitespace-nowrap text-green-600">
                                                    {formatCurrency(product.totalCash)}
                                                </p>
                                            </div>
                                            <MobileReportFieldGrid
                                                fields={[
                                                    {
                                                        label: 'Quantity Sold',
                                                        value: formatSessionQuantity(product.key, product.quantity),
                                                    },
                                                    {
                                                        label: 'Total Cash',
                                                        value: formatCurrency(product.totalCash),
                                                        valueClassName: 'mt-1 font-semibold text-green-600',
                                                    },
                                                ]}
                                            />
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>

                            <div className="hidden sm:block">
                                <ScrollArea className="h-[500px] w-full rounded-md border">
                                    <Table className="min-w-[640px]">
                                        <TableHeader className="sticky top-0 bg-muted">
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead className="text-right">Quantity Sold</TableHead>
                                                <TableHead className="text-right">Total Cash</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {paginatedProductSalesData.map((product) => (
                                                <TableRow key={product.key}>
                                                    <TableCell className="font-medium">{product.name}</TableCell>
                                                    <TableCell className="text-right">
                                                        {formatSessionQuantity(product.key, product.quantity)}
                                                    </TableCell>
                                                    <TableCell className="text-right font-semibold">{formatCurrency(product.totalCash)}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </div>
                            <SessionPaginationControls
                                currentPage={productSalesCurrentPage}
                                totalItems={productSalesTotalItems}
                                totalPages={productSalesTotalPages}
                                pageStartIndex={productSalesPageStartIndex}
                                pageEndIndex={productSalesPageEndIndex}
                                onPageChange={setProductSalesCurrentPage}
                                itemLabel="products sold"
                            />
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-center py-4">No products sold in this session.</p>
                    )}
                </div>
                    </TabsContent>
                    <TabsContent value="received" className="mt-4 min-h-[340px]">

                {/* Purchases Received */}
                <div className="space-y-0">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <Package className="h-4 w-4" />
                        Stock Received in Session
                    </h3>
                    {purchasesData.length > 0 ? (
                        <div className="space-y-0">
                            <div className="space-y-3 sm:hidden">
                                {purchasesData.map((purchase) => (
                                    <Card key={`purchase-mobile-${purchase.key}`} className="mobile-data-card border">
                                        <CardContent className="space-y-3 p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-medium break-words">{purchase.name}</p>
                                                    <p className="text-xs text-muted-foreground">Stock received during session</p>
                                                </div>
                                                <p className="text-sm font-bold whitespace-nowrap">
                                                    {formatCurrency(purchase.totalCost)}
                                                </p>
                                            </div>
                                            <MobileReportFieldGrid
                                                fields={[
                                                    {
                                                        label: 'Quantity',
                                                        value: formatSessionQuantity(purchase.key, purchase.quantity),
                                                        valueClassName: 'mt-1 font-medium text-blue-600',
                                                    },
                                                    {
                                                        label: 'Unit Cost',
                                                        value: formatCurrency(purchase.unitCost),
                                                    },
                                                    {
                                                        label: 'VAT',
                                                        value: `${formatCurrency(purchase.vatAmount)} (${purchase.vatMethod === 'mixed' ? 'Mixed' : purchase.vatMethod === 'inclusive' ? 'Incl' : 'Excl'})`,
                                                    },
                                                    {
                                                        label: 'Expiry Date',
                                                        value: purchase.expiryDate ? format(new Date(purchase.expiryDate), 'MMM dd, yyyy') : '-',
                                                    },
                                                    {
                                                        label: 'Supplier',
                                                        value: purchase.supplier,
                                                        fullWidth: true,
                                                    },
                                                    {
                                                        label: 'Batch #',
                                                        value: purchase.batchNumber || '-',
                                                        fullWidth: true,
                                                    },
                                                ]}
                                            />
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>

                            <div className="hidden sm:block">
                                <ScrollArea className="h-[500px] w-full rounded-md border">
                                    <Table className="min-w-[980px]">
                                        <TableHeader className="sticky top-0 bg-muted">
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead className="text-right">Quantity</TableHead>
                                                <TableHead className="text-right">Unit Cost</TableHead>
                                                <TableHead className="text-right">Total Cost</TableHead>
                                                <TableHead className="text-right">VAT (Incl/Excl)</TableHead>
                                                <TableHead>Supplier</TableHead>
                                                <TableHead>Batch #</TableHead>
                                                <TableHead>Expiry Date</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {purchasesData.map((purchase) => (
                                                <TableRow key={purchase.key}>
                                                    <TableCell className="font-medium">{purchase.name}</TableCell>
                                                    <TableCell className="text-right text-blue-600 font-medium">
                                                        {formatSessionQuantity(purchase.key, purchase.quantity)}
                                                    </TableCell>
                                                    <TableCell className="text-right">{formatCurrency(purchase.unitCost)}</TableCell>
                                                    <TableCell className="text-right font-semibold">{formatCurrency(purchase.totalCost)}</TableCell>
                                                    <TableCell className="text-right">
                                                        {formatCurrency(purchase.vatAmount)} ({purchase.vatMethod === 'mixed' ? 'Mixed' : purchase.vatMethod === 'inclusive' ? 'Incl' : 'Excl'})
                                                    </TableCell>
                                                    <TableCell className="text-sm">{purchase.supplier}</TableCell>
                                                    <TableCell className="text-sm">{purchase.batchNumber || '-'}</TableCell>
                                                    <TableCell className="text-sm">{purchase.expiryDate ? format(new Date(purchase.expiryDate), 'MMM dd, yyyy') : '-'}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </div>
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-center py-4">No stock received in this session.</p>
                    )}
                </div>
                    </TabsContent>
                    <TabsContent value="waste" className="mt-4 min-h-[340px]">

                {/* Waste Recorded */}
                <div className="space-y-0">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-500" />
                        Waste Recorded in Session
                    </h3>
                    {sessionWaste.length > 0 ? (
                        <div className="space-y-0">
                            <div className="space-y-3 sm:hidden">
                                {sessionWaste.map((waste) => {
                                    const wasteProductKey = resolveCanonicalProductKey(
                                        waste.itemId,
                                        waste.itemName,
                                        productIdentity.nameToId
                                    );

                                    return (
                                        <Card key={`waste-mobile-${waste.id}`} className="mobile-data-card border">
                                            <CardContent className="space-y-3 p-3">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="font-medium break-words">{waste.itemName}</p>
                                                        <p className="text-xs text-muted-foreground">Waste record</p>
                                                    </div>
                                                    <p className="text-sm font-bold whitespace-nowrap">
                                                        {formatCurrency(waste.cost)}
                                                    </p>
                                                </div>
                                                <MobileReportFieldGrid
                                                    fields={[
                                                        {
                                                            label: 'Quantity',
                                                            value: formatSessionQuantity(
                                                                wasteProductKey,
                                                                Number(waste.quantity || 0),
                                                                waste.unit || undefined
                                                            ),
                                                            valueClassName: 'mt-1 font-medium text-red-600',
                                                        },
                                                        {
                                                            label: 'Unit',
                                                            value: waste.unit || '-',
                                                        },
                                                        {
                                                            label: 'Reason',
                                                            value: waste.reason,
                                                        },
                                                        {
                                                            label: 'Recorded By',
                                                            value: waste.recordedBy,
                                                        },
                                                        {
                                                            label: 'Notes',
                                                            value: waste.notes || '-',
                                                            fullWidth: true,
                                                        },
                                                    ]}
                                                />
                                            </CardContent>
                                        </Card>
                                    );
                                })}
                            </div>

                            <div className="hidden sm:block">
                                <ScrollArea className="h-[500px] w-full rounded-md border">
                                    <Table className="min-w-[980px]">
                                        <TableHeader className="sticky top-0 bg-muted">
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead className="text-right">Quantity</TableHead>
                                                <TableHead>Unit</TableHead>
                                                <TableHead className="text-right">Cost</TableHead>
                                                <TableHead>Reason</TableHead>
                                                <TableHead>Recorded By</TableHead>
                                                <TableHead>Notes</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {sessionWaste.map((waste) => (
                                                <TableRow key={waste.id}>
                                                    <TableCell className="font-medium">{waste.itemName}</TableCell>
                                                    <TableCell className="text-right text-red-600 font-medium">
                                                        {formatSessionQuantity(
                                                            resolveCanonicalProductKey(waste.itemId, waste.itemName, productIdentity.nameToId),
                                                            Number(waste.quantity || 0),
                                                            waste.unit || undefined
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-sm">{waste.unit || '-'}</TableCell>
                                                    <TableCell className="text-right">{formatCurrency(waste.cost)}</TableCell>
                                                    <TableCell className="text-sm">{waste.reason}</TableCell>
                                                    <TableCell className="text-sm">{waste.recordedBy}</TableCell>
                                                    <TableCell className="text-sm">{waste.notes || '-'}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </div>
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-center py-4">No waste recorded in this session.</p>
                    )}
                </div>
                    </TabsContent>
                    <TabsContent value="tracking" className="mt-4 min-h-[340px]">

                {/* Comprehensive Stock Tracking */}
                <div className="space-y-0">
                    <h3 className="font-semibold mb-3">Complete Stock Tracking (Opening + Received - Sold - Waste = Remaining)</h3>
                    {optionStockUsageData.length > 0 && (
                        <div className="mb-5 space-y-3">
                            <div>
                                <h4 className="text-sm font-semibold">Option ingredient usage</h4>
                                <p className="text-xs text-muted-foreground">Stock used by selected sides, add-ons, and meal options.</p>
                            </div>

                            <div className="space-y-3 sm:hidden">
                                {optionStockUsageData.map((item) => (
                                    <Card key={`option-usage-mobile-${item.key}`} className="mobile-data-card border">
                                        <CardContent className="space-y-3 p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-medium break-words">{item.name}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {item.parentItemName} · {item.optionGroupName ? `${item.optionGroupName}: ` : ''}{item.optionName}
                                                    </p>
                                                </div>
                                                <Badge variant="secondary" className="shrink-0">
                                                    {formatSessionQuantity(item.itemKey, item.quantity)}
                                                </Badge>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>

                            <div className="hidden sm:block">
                                <ScrollArea className="h-[220px] w-full rounded-md border">
                                    <Table className="min-w-[760px]">
                                        <TableHeader className="sticky top-0 bg-muted">
                                            <TableRow>
                                                <TableHead>Ingredient / stock item</TableHead>
                                                <TableHead>Menu item</TableHead>
                                                <TableHead>Selected option</TableHead>
                                                <TableHead className="text-right">Used</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {optionStockUsageData.map((item) => (
                                                <TableRow key={item.key}>
                                                    <TableCell className="font-medium">{item.name}</TableCell>
                                                    <TableCell>{item.parentItemName}</TableCell>
                                                    <TableCell>
                                                        {item.optionGroupName ? (
                                                            <span className="text-muted-foreground">{item.optionGroupName}: </span>
                                                        ) : null}
                                                        {item.optionName}
                                                    </TableCell>
                                                    <TableCell className="text-right font-medium text-red-600">
                                                        {formatSessionQuantity(item.itemKey, item.quantity)}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </div>
                        </div>
                    )}
                    {comprehensiveStockData.length > 0 ? (
                        <div className="space-y-0">
                            <div className="space-y-3 sm:hidden">
                                {comprehensiveStockData.map((item) => (
                                    <Card key={`tracking-mobile-${item.key}`} className="mobile-data-card border">
                                        <CardContent className="space-y-3 p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-medium break-words">{item.name}</p>
                                                    <p className="text-xs text-muted-foreground">Opening + received - sold - waste</p>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-[11px] text-muted-foreground">Remaining</p>
                                                    <p className="text-sm font-bold text-green-600">
                                                        {formatSessionQuantity(item.key, item.remaining)}
                                                    </p>
                                                </div>
                                            </div>
                                            <MobileReportFieldGrid
                                                fields={[
                                                    {
                                                        label: 'Opening',
                                                        value: formatSessionQuantity(item.key, item.opening),
                                                    },
                                                    {
                                                        label: 'Received',
                                                        value: formatSessionQuantity(item.key, item.received),
                                                        valueClassName: 'mt-1 font-medium text-blue-600',
                                                    },
                                                    {
                                                        label: 'Sold',
                                                        value: formatSessionQuantity(item.key, item.sold),
                                                        valueClassName: 'mt-1 font-medium text-red-600',
                                                    },
                                                    {
                                                        label: 'Waste',
                                                        value: formatSessionQuantity(item.key, item.waste),
                                                        valueClassName: 'mt-1 font-medium text-orange-600',
                                                    },
                                                ]}
                                            />
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>

                            <div className="hidden sm:block">
                                <ScrollArea className="h-[500px] w-full rounded-md border">
                                    <Table className="min-w-[760px]">
                                        <TableHeader className="sticky top-0 bg-muted">
                                            <TableRow>
                                                <TableHead>Item</TableHead>
                                                <TableHead className="text-right">Opening</TableHead>
                                                <TableHead className="text-right">Received</TableHead>
                                                <TableHead className="text-right">Sold</TableHead>
                                                <TableHead className="text-right">Waste</TableHead>
                                                <TableHead className="text-right">Remaining</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {comprehensiveStockData.map((item) => (
                                                <TableRow key={item.key}>
                                                    <TableCell className="font-medium">{item.name}</TableCell>
                                                    <TableCell className="text-right">{formatSessionQuantity(item.key, item.opening)}</TableCell>
                                                    <TableCell className="text-right text-blue-600 font-medium">{formatSessionQuantity(item.key, item.received)}</TableCell>
                                                    <TableCell className="text-right text-red-600 font-medium">{formatSessionQuantity(item.key, item.sold)}</TableCell>
                                                    <TableCell className="text-right text-orange-600 font-medium">{formatSessionQuantity(item.key, item.waste)}</TableCell>
                                                    <TableCell className="text-right text-green-600 font-medium">{formatSessionQuantity(item.key, item.remaining)}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </div>
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-center py-4">No stock data available for this session.</p>
                    )}
                </div>
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    );
};

export default function SessionsPage() {
    const [isStartModalOpen, setStartModalOpen] = useState(false);
    const [isCloseModalOpen, setCloseModalOpen] = useState(false);
    const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
    const [viewingSession, setViewingSession] = useState<Session | null>(null);
    const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
    const [activeSessions, setActiveSessions] = useState<Session[]>([]);
    const [carryoverActiveSessions, setCarryoverActiveSessions] = useState<Session[]>([]);
    const [todayClosedSessions, setTodayClosedSessions] = useState<Session[]>([]);
    const [activeSession, setActiveSession] = useState<Session | null>(null);
    const [isLoadingSession, setIsLoadingSession] = useState(false);
    const { user } = useAuth();
    const { format: formatCurrency } = useCurrency();

    useEffect(() => {
        const resolvedBranchId = resolveValidBranchIdFromStorage();
        if (resolvedBranchId && !isPlaceholderBranchId(resolvedBranchId)) {
            setActiveBranchId(resolvedBranchId);
            return;
        }

        if (user?.branchId) {
            localStorage.setItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH, user.branchId);
            setActiveBranchId(user.branchId);
            return;
        }

        if (resolvedBranchId) {
            setActiveBranchId(resolvedBranchId);
        }
    }, [user]);

    // Listen for branch changes and pull data
    useEffect(() => {
        const handleBranchChange = (e: Event) => {
            const customEvent = e as CustomEvent;
            const branchId = customEvent.detail?.branchId;
            if (branchId) {
                setActiveBranchId(branchId);
                console.log('[Sessions Page] Branch changed to:', branchId);
                // Fetch active sessions from backend when branch changes
                fetchActiveSessions(branchId);
            }
        };
        window.addEventListener('branchChanged', handleBranchChange);
        return () => window.removeEventListener('branchChanged', handleBranchChange);
    }, []);

    // Fetch active sessions from backend on page load
    useEffect(() => {
        if (activeBranchId) {
            console.log('[Sessions Page] Fetching active sessions for branch:', activeBranchId);
            fetchActiveSessions(activeBranchId);
        }
    }, [activeBranchId]);

    const toBackendBranchId = (branchId: string): string => {
        const normalized = String(branchId || '').trim();
        const prefixed = /^BRN-(\d+)$/i.exec(normalized);
        if (prefixed) return prefixed[1];
        return normalized;
    };

    const normalizeBranchId = (value?: string | number | null): string => {
        const normalized = String(value ?? '').trim();
        if (!normalized) return '';

        const prefixed = /^BRN-(\d+)$/i.exec(normalized);
        if (prefixed) return prefixed[1];

        const legacy = /^branch-(\d+)$/i.exec(normalized);
        if (legacy) return legacy[1];

        return normalized;
    };

    const mapBackendSessionToLocal = (response: any, branchId: string): Session => ({
        id: String(response.id),
        branchId: String(response.branch || branchId),
        userId: String(response.user || ''),
        userEmail: response.user_email || '',
        userName: response.user_name || response.user_email || 'Unknown User',
        status: String(response.status).toLowerCase() === 'closed' ? 'closed' : 'active',
        pumpName: response.pump_name ?? response.pumpName ?? undefined,
        openingFloat: parseFloat(response.opening_float || 0),
        expectedCash: parseFloat(response.expected_cash || 0),
        actualCash: response.actual_cash !== null && response.actual_cash !== undefined ? parseFloat(response.actual_cash) : undefined,
        closingFloat: response.closing_float !== null && response.closing_float !== undefined ? parseFloat(response.closing_float) : undefined,
        difference: response.difference !== null && response.difference !== undefined ? parseFloat(response.difference) : undefined,
        totalSales: parseFloat(response.total_sales || 0),
        totalCashSales: parseFloat(response.total_cash_sales || 0),
        totalCardSales: parseFloat(response.total_card_sales || 0),
        totalMobileMoneySales: parseFloat(response.total_mobile_money_sales || 0),
        totalOnAccountSales: parseFloat(response.total_on_account_sales || 0),
        totalOtherSales: parseFloat(response.total_other_sales || 0),
        totalTips: parseFloat(response.total_tips || 0),
        openingStock: response.opening_stock || [],
        closingStock: response.closing_stock || [],
        startedAt: response.started_at,
        closedAt: response.closed_at,
    });

    const isOwnSession = (session: Session) => {
        if (!user) return false;
        if (user.email && session.userEmail) {
            return user.email === session.userEmail;
        }
        return String(session.userId) === String(user.uid);
    };

    const isDateInCurrentDay = (value?: string) => {
        if (!value) return false;
        const parsed = parseSessionDateTime(value);
        if (!parsed) return false;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfTomorrow = new Date(startOfToday);
        startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

        return parsed >= startOfToday && parsed < startOfTomorrow;
    };

    const isClosedSessionFromCurrentDay = (session: Session) => {
        if (session.status !== 'closed') return false;
        // "Today's Sessions" should represent sessions that STARTED today.
        // Sessions carried over from yesterday but closed after midnight are excluded.
        return isDateInCurrentDay(session.startedAt);
    };

    const isActiveSessionFromCurrentDay = (session: Session) => {
        if (session.status !== 'active') return false;
        return isDateInCurrentDay(session.startedAt);
    };

    const isCarryoverActiveSession = (session: Session) => {
        if (session.status !== 'active') return false;
        return !isDateInCurrentDay(session.startedAt);
    };

    const mergeSessions = (sessions: Session[]) => {
        const unique = new Map<string, Session>();
        sessions.forEach((session) => {
            if (!session?.id) return;
            unique.set(session.id, session);
        });

        return Array.from(unique.values()).sort(
            (a, b) => {
                const startedAtA = parseSessionDateTime(a.startedAt)?.getTime() ?? 0;
                const startedAtB = parseSessionDateTime(b.startedAt)?.getTime() ?? 0;
                return startedAtB - startedAtA;
            }
        );
    };

    const fetchPagedSessions = async (initialUrl: string): Promise<any[]> => {
        const allSessions: any[] = [];
        let nextUrl: string | null = initialUrl;
        const visitedUrls = new Set<string>();

        while (nextUrl) {
            if (visitedUrls.has(nextUrl)) {
                console.warn('[Sessions Page] Duplicate pagination URL detected, stopping:', nextUrl);
                break;
            }
            visitedUrls.add(nextUrl);

            const response = await authFetch.fetch<any>(nextUrl);
            if (Array.isArray(response)) {
                allSessions.push(...response);
                break;
            }

            if (Array.isArray(response?.results)) {
                allSessions.push(...response.results);
                nextUrl = typeof response.next === 'string' && response.next.length > 0
                    ? response.next
                    : null;
            } else {
                nextUrl = null;
            }
        }

        return allSessions;
    };

    const fetchOrdersForSession = async (session: Session, branchId: string) => {
        try {
            const syncedOrders = await syncSessionOrdersToLocalDb({
                sessionId: session.id,
                branchId,
            });
            console.log('[Sessions Page] Loaded', syncedOrders.length, 'orders for session:', session.id);
        } catch (ordersError) {
            console.warn('[Sessions Page] Could not fetch orders for session:', session.id, ordersError);
        }
    };

    const fetchActiveSessions = async (branchId: string, preferredSessionId?: string) => {
        setIsLoadingSession(true);
        try {
            const backendBranchId = toBackendBranchId(branchId);
            console.log('[Sessions Page] Fetching active sessions from backend for branch:', backendBranchId);

            let mappedActiveSessions: Session[] = [];
            let mappedCarryoverActiveSessions: Session[] = [];
            let mappedTodayClosedSessions: Session[] = [];
            let usedBackendData = false;

            try {
                const businessQuery = user?.businessId
                    ? `&business_id=${encodeURIComponent(String(user.businessId))}`
                    : '';
                const activeResponse = await authFetch.fetch<any>(
                    `/sessions/sessions/active_list/?branch_id=${encodeURIComponent(backendBranchId)}${businessQuery}`
                );
                const backendActiveSessions = Array.isArray(activeResponse?.results)
                    ? activeResponse.results
                    : Array.isArray(activeResponse)
                    ? activeResponse
                    : [];

                const mappedAllActiveSessions = backendActiveSessions
                    .map((session) => mapBackendSessionToLocal(session, branchId))
                    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

                mappedActiveSessions = mappedAllActiveSessions.filter((session) => isActiveSessionFromCurrentDay(session));
                mappedCarryoverActiveSessions = mappedAllActiveSessions.filter((session) => isCarryoverActiveSession(session));

                usedBackendData = true;
            } catch (backendActiveError) {
                console.warn('[Sessions Page] Backend active_list fetch failed:', backendActiveError);
            }

            try {
                const businessQuery = user?.businessId
                    ? `&business_id=${encodeURIComponent(String(user.businessId))}`
                    : '';
                const allSessionsUrl = `/sessions/sessions/?branch_id=${encodeURIComponent(backendBranchId)}${businessQuery}`;
                const backendAllSessions = await fetchPagedSessions(allSessionsUrl);

                mappedTodayClosedSessions = backendAllSessions
                    .map((session) => mapBackendSessionToLocal(session, branchId))
                    .filter((session) => isClosedSessionFromCurrentDay(session))
                    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

                usedBackendData = true;
            } catch (backendClosedError) {
                console.warn('[Sessions Page] Backend full session list fetch failed:', backendClosedError);
            }

            if (usedBackendData) {
                const selectableSessions = mergeSessions([
                    ...mappedActiveSessions,
                    ...mappedTodayClosedSessions,
                    ...mappedCarryoverActiveSessions,
                ]);
                setActiveSessions(mappedActiveSessions);
                setCarryoverActiveSessions(mappedCarryoverActiveSessions);
                setTodayClosedSessions(mappedTodayClosedSessions);

                if (selectableSessions.length === 0) {
                    setActiveSession(null);
                    return;
                }

                const selectedSession =
                    selectableSessions.find((session) => session.id === preferredSessionId) ||
                    mappedActiveSessions.find((session) => isOwnSession(session)) ||
                    mappedActiveSessions[0] ||
                    mappedCarryoverActiveSessions.find((session) => isOwnSession(session)) ||
                    mappedCarryoverActiveSessions[0] ||
                    selectableSessions.find((session) => isOwnSession(session)) ||
                    selectableSessions[0];

                setActiveSession(selectedSession);
                await fetchOrdersForSession(selectedSession, branchId);
                return;
            }

            // Fallback: local DB (offline mode)
            const localSessions = branchId
                ? (await db.sessions.toArray()).filter(
                    (session) => normalizeBranchId(session.branchId) === normalizeBranchId(branchId)
                )
                : [];

            const localActiveSessions = localSessions
                .filter((session) => isActiveSessionFromCurrentDay(session))
                .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

            const localCarryoverActiveSessions = localSessions
                .filter((session) => isCarryoverActiveSession(session))
                .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

            const localTodayClosedSessions = localSessions
                .filter((session) => isClosedSessionFromCurrentDay(session))
                .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

            const selectableSessions = mergeSessions([
                ...localActiveSessions,
                ...localTodayClosedSessions,
                ...localCarryoverActiveSessions,
            ]);
            setActiveSessions(localActiveSessions);
            setCarryoverActiveSessions(localCarryoverActiveSessions);
            setTodayClosedSessions(localTodayClosedSessions);

            if (selectableSessions.length > 0) {
                const selectedSession =
                    selectableSessions.find((session) => session.id === preferredSessionId) ||
                    localActiveSessions.find((session) => isOwnSession(session)) ||
                    localActiveSessions[0] ||
                    localCarryoverActiveSessions.find((session) => isOwnSession(session)) ||
                    localCarryoverActiveSessions[0] ||
                    selectableSessions.find((session) => isOwnSession(session)) ||
                    selectableSessions[0];

                setActiveSession(selectedSession);
                await fetchOrdersForSession(selectedSession, branchId);
                console.log('[Sessions Page] Using local session data (offline mode):', selectedSession.id);
            } else {
                setActiveSession(null);
                console.log('[Sessions Page] No active/today-closed sessions found');
            }
        } catch (error) {
            console.error('[Sessions Page] Error fetching active sessions:', error);
            setActiveSessions([]);
            setCarryoverActiveSessions([]);
            setTodayClosedSessions([]);
            setActiveSession(null);
        } finally {
            setIsLoadingSession(false);
        }
    };

    const handleSwitchActiveSession = async (sessionId: string) => {
        if (!activeBranchId) return;
        const selectedSession = manageableSessions.find((session) => session.id === sessionId);
        if (!selectedSession || activeSession?.id === selectedSession.id) return;

        setIsLoadingSession(true);
        try {
            setActiveSession(selectedSession);
            await fetchOrdersForSession(selectedSession, activeBranchId);
        } finally {
            setIsLoadingSession(false);
        }
    };

    const normalizedUserRole = String(user?.role || '').toLowerCase();
    const isAdminUser = normalizedUserRole === 'admin' || normalizedUserRole === 'owner' || normalizedUserRole === 'administrator';
    const listedSessions = useMemo(
        () => mergeSessions([...activeSessions, ...carryoverActiveSessions]),
        [activeSessions, carryoverActiveSessions]
    );
    const manageableSessions = listedSessions;
    const totalActiveSessions = activeSessions.length + carryoverActiveSessions.length;
    const hasOwnActiveSession = useMemo(
        () => manageableSessions.some((session) => session.status === 'active' && isOwnSession(session)),
        [manageableSessions]
    );
    const canCloseActiveSession =
        !!activeSession &&
        activeSession.status === 'active' &&
        (isOwnSession(activeSession) || isAdminUser);
    const keepCloseDialogMounted = canCloseActiveSession || isCloseModalOpen;
    const listedActiveSessions = listedSessions;

    const formatSessionDateTime = (value?: string) => {
        if (!value) return '-';
        const parsed = parseSessionDateTime(value);
        if (!parsed) return '-';
        return format(parsed, 'PPpp');
    };
    
    if (!activeBranchId) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Session Management</h1>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => setHistoryModalOpen(true)}>
                        <History className="mr-2 h-4 w-4" /> History
                    </Button>
                    <Dialog open={isStartModalOpen} onOpenChange={setStartModalOpen}>
                        <DialogTrigger asChild>
                            <Button disabled={hasOwnActiveSession}>
                                <PlusCircle className="mr-2 h-4 w-4" /> Start New Session
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-md">
                            <DialogHeader>
                                <DialogTitle>Start a New Session</DialogTitle>
                            </DialogHeader>
                            <StartSessionForm onSessionStarted={async () => {
                                setStartModalOpen(false);
                                // Reload active sessions from backend
                                await fetchActiveSessions(activeBranchId);
                            }} />
                        </DialogContent>
                    </Dialog>
                </div>
            </div>

            {listedSessions.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>Active Sessions In This Branch</CardTitle>
                        <CardDescription>{totalActiveSessions} active.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {listedActiveSessions.length === 0 ? (
                            <div className="flex min-h-24 items-center justify-center text-center text-sm text-muted-foreground">
                                No active sessions.
                            </div>
                        ) : (
                            <>
                                <div className="space-y-3 sm:hidden">
                                    {listedActiveSessions.map((session) => {
                                        const isSelected = activeSession?.id === session.id;

                                        return (
                                            <Card key={`active-session-mobile-${session.id}`} className="mobile-data-card border">
                                                <CardContent className="space-y-3 p-3">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <p className="font-medium break-words">{session.userName}</p>
                                                            <p className="text-xs text-muted-foreground break-words">
                                                                {session.userEmail || 'No email'}
                                                            </p>
                                                        </div>
                                                        <Badge variant={isSelected ? 'default' : 'secondary'}>
                                                            {isSelected ? 'Selected' : 'Active'}
                                                        </Badge>
                                                    </div>

                                                    <MobileReportFieldGrid
                                                        fields={[
                                                            {
                                                                label: 'Started At',
                                                                value: formatSessionDateTime(session.startedAt),
                                                                fullWidth: true,
                                                            },
                                                            {
                                                                label: 'Sales',
                                                                value: formatCurrency(session.totalSales || 0),
                                                                valueClassName: 'mt-1 font-semibold',
                                                            },
                                                            {
                                                                label: 'Status',
                                                                value: isSelected ? 'Viewing now' : 'Available to view',
                                                            },
                                                        ]}
                                                    />

                                                    <Button
                                                        className="w-full"
                                                        size="sm"
                                                        variant={isSelected ? 'secondary' : 'outline'}
                                                        onClick={() => void handleSwitchActiveSession(session.id)}
                                                        disabled={isLoadingSession || isSelected}
                                                    >
                                                        {isSelected ? 'Viewing' : 'View'}
                                                    </Button>
                                                </CardContent>
                                            </Card>
                                        );
                                    })}
                                </div>

                                <div className="hidden sm:block">
                                    <ScrollArea className="w-full">
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead>Started By</TableHead>
                                                    <TableHead>Email</TableHead>
                                                    <TableHead>Started At</TableHead>
                                                    <TableHead className="text-right">Sales</TableHead>
                                                    <TableHead>Status</TableHead>
                                                    <TableHead className="text-right">Action</TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {listedActiveSessions.map((session) => {
                                                    const isSelected = activeSession?.id === session.id;

                                                    return (
                                                        <TableRow key={session.id} className={isSelected ? 'bg-muted/40' : undefined}>
                                                            <TableCell className="font-medium">{session.userName}</TableCell>
                                                            <TableCell>{session.userEmail || '-'}</TableCell>
                                                            <TableCell>{formatSessionDateTime(session.startedAt)}</TableCell>
                                                            <TableCell className="text-right">{formatCurrency(session.totalSales || 0)}</TableCell>
                                                            <TableCell>
                                                                <Badge variant={isSelected ? 'default' : 'secondary'}>
                                                                    {isSelected ? 'Selected' : 'Active'}
                                                                </Badge>
                                                            </TableCell>
                                                            <TableCell className="text-right">
                                                                <Button
                                                                    size="sm"
                                                                    variant={isSelected ? 'secondary' : 'outline'}
                                                                    onClick={() => void handleSwitchActiveSession(session.id)}
                                                                    disabled={isLoadingSession || isSelected}
                                                                >
                                                                    {isSelected ? 'Viewing' : 'View'}
                                                                </Button>
                                                            </TableCell>
                                                        </TableRow>
                                                    );
                                                })}
                                            </TableBody>
                                        </Table>
                                    </ScrollArea>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            )}


            {isLoadingSession ? (
                <Card className="flex flex-col items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </Card>
            ) : activeSession ? (
                <>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <div className="flex items-center gap-3">
                                    <CheckCircle className={`h-6 w-6 ${activeSession.status === 'closed' ? 'text-muted-foreground' : 'text-green-500'}`} />
                                    <CardTitle className="text-xl">
                                        {activeSession.status === 'closed'
                                            ? isOwnSession(activeSession)
                                                ? 'Your Closed Session'
                                                : `Closed Session - ${activeSession.userName}`
                                            : isOwnSession(activeSession)
                                                ? 'Your Active Session'
                                                : `Active Session - ${activeSession.userName}`
                                        }
                                    </CardTitle>
                                </div>
                                <CardDescription>
                                    Session started by {isOwnSession(activeSession) ? 'you' : activeSession.userName} at {formatSessionDateTime(activeSession.startedAt)}
                                    {activeSession.status === 'closed' && ` and closed at ${formatSessionDateTime(activeSession.closedAt)}`}
                                </CardDescription>
                            </div>
                            <div className="flex items-center gap-2">
                              {manageableSessions.length > 1 && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="outline">
                                      Switch Session ({manageableSessions.length})
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {manageableSessions.map((session) => (
                                      <DropdownMenuItem
                                        key={session.id}
                                        onSelect={() => {
                                          void handleSwitchActiveSession(session.id);
                                        }}
                                      >
                                        {session.userName}
                                        {session.userEmail ? ` (${session.userEmail})` : ''}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                              {keepCloseDialogMounted ? (
                                <>
                                  <Dialog open={isCloseModalOpen} onOpenChange={setCloseModalOpen}>
                                      {canCloseActiveSession ? (
                                        <DialogTrigger asChild>
                                            <Button variant="destructive">
                                                <DoorClosed className="mr-2" />
                                                {isOwnSession(activeSession) ? 'Close Session' : "Close This Session"}
                                            </Button>
                                        </DialogTrigger>
                                      ) : null}
                                      <DialogContent className="max-h-[90vh] flex flex-col overflow-hidden sm:max-w-md">
                                          <DialogHeader className="flex-shrink-0">
                                              <DialogTitle>{isOwnSession(activeSession) ? 'Close Current Session' : `Close ${activeSession.userName}'s Session`}</DialogTitle>
                                              <DialogDescription>Review sales and reconcile cash to end this session.</DialogDescription>
                                          </DialogHeader>
                                          <div className="flex-1 overflow-y-auto min-h-0">
                                              <CloseSessionForm
                                                session={activeSession}
                                                onSessionClosed={(closedSession) => {
                                                  setActiveSession(closedSession);
                                                  setActiveSessions((sessions) =>
                                                    sessions.filter((candidate) => candidate.id !== closedSession.id)
                                                  );
                                                  setCarryoverActiveSessions((sessions) =>
                                                    sessions.filter((candidate) => candidate.id !== closedSession.id)
                                                  );
                                                  setTodayClosedSessions((sessions) =>
                                                    mergeSessions([closedSession, ...sessions])
                                                      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                                                  );
                                                  window.dispatchEvent(new CustomEvent('sessionClosed', {
                                                    detail: { sessionId: closedSession.id, branchId: activeBranchId }
                                                  }));
                                                }}
                                                onDone={() => {
                                                  setCloseModalOpen(false);
                                                  void fetchActiveSessions(activeBranchId, activeSession.id);
                                                }}
                                              />
                                          </div>
                                      </DialogContent>
                                  </Dialog>
                                </>
                              ) : (
                                <Badge variant="secondary" className="text-base px-3 py-1">
                                  Viewing {activeSession.userName}'s Session
                                </Badge>
                              )}
                            </div>
                        </CardHeader>
                        <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-6">
                            <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Opening Float</div>
                                <div className="text-lg font-bold">{formatCurrency(activeSession.openingFloat || 0)}</div>
                            </div>
                             <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Sales Value</div>
                                <div className="text-lg font-bold">{formatCurrency(activeSession.totalSales || 0)}</div>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Collected</div>
                                <div className="text-lg font-bold text-green-600">
                                    {formatCurrency(
                                        (activeSession.totalCashSales || 0)
                                        + (activeSession.totalCardSales || 0)
                                        + (activeSession.totalMobileMoneySales || 0)
                                        + (activeSession.totalOtherSales || 0)
                                    )}
                                </div>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Card / Mobile</div>
                                <div className="text-lg font-bold text-blue-600">
                                    {formatCurrency((activeSession.totalCardSales || 0) + (activeSession.totalMobileMoneySales || 0))}
                                </div>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Still Due</div>
                                <div className="text-lg font-bold text-amber-600">{formatCurrency(activeSession.totalOnAccountSales || 0)}</div>
                            </div>
                             <div className="rounded-lg bg-muted/50 p-4">
                                <div className="text-sm font-medium text-muted-foreground">Expected in Drawer</div>
                                <div className="text-lg font-bold">{formatCurrency(activeSession.expectedCash || 0)}</div>
                            </div>
                        </CardContent>
                    </Card>
                    <Tabs defaultValue="sales" className="w-full">
                        <TabsList className="grid h-auto w-full grid-cols-1 sm:grid-cols-3">
                            <TabsTrigger value="sales" className="text-xs sm:text-sm">Sales Report</TabsTrigger>
                            <TabsTrigger value="session-end-report" className="text-xs sm:text-sm">{SESSION_END_REPORT_TITLE}</TabsTrigger>
                            <TabsTrigger value="stock" className="text-xs sm:text-sm">Stock Report</TabsTrigger>
                        </TabsList>
                        
                        <TabsContent value="sales" className="mt-4 min-h-[640px]">
                            <SessionSalesList sessionId={activeSession.id} />
                        </TabsContent>
                        
                        <TabsContent value="session-end-report" className="mt-4 min-h-[640px]">
                            <ZReportTab session={activeSession} />
                        </TabsContent>
                        
                        <TabsContent value="stock" className="mt-4 min-h-[640px]">
                            <StockReportTab session={activeSession} />
                        </TabsContent>
                    </Tabs>
                </>
            ) : (
                 <Card className="flex flex-col items-center justify-center py-12 text-center">
                    <CardHeader>
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400">
                            <AlertTriangle />
                        </div>
                        <CardTitle className="mt-4 text-xl">No Sessions For Today</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground">Start a new session or open History.</p>
                    </CardContent>
                 </Card>
            )}

            <SessionHistoryModal
                isOpen={isHistoryModalOpen}
                onOpenChange={setHistoryModalOpen}
                branchId={activeBranchId}
            />

            {viewingSession && (
                <SessionDetailDialog 
                    session={viewingSession}
                    isOpen={!!viewingSession}
                    onOpenChange={(open) => !open && setViewingSession(null)}
                />
            )}

        </div>
    );
}
