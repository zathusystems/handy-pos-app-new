
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Loader2, Package, Printer } from 'lucide-react';

import { db, type Session, type Order } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { syncSessionOrdersToLocalDb } from '@/lib/session-order-sync';
import {
  buildSessionStockReportPrintHtml,
  buildXReportPrintHtml,
  buildZReportPrintHtml,
  calculateZReportSummary,
  isSessionClosedForZReport,
  SESSION_END_REPORT_TITLE,
  SESSION_STOCK_REPORT_TITLE,
  SESSION_X_REPORT_TITLE,
} from '@/lib/z-report-print';
import {
  formatInventoryQuantity,
  formatQuantityWithUnit,
  getPortionQuantityDisplay,
} from '@/lib/quantity-format';
import {
  buildStockTrackingInventoryLookup,
  getSoldOrderStockMovements,
} from '@/lib/session-stock-tracking';
import { SaleDetailModal } from './index';
import { SessionPaginationControls, useSessionPagination } from '../session-pagination';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch',
};

type SessionReportPrintResult =
    | { success: true; printerName: string }
    | { success: false; reason: 'missing-printer' | 'print-failed' };

const printSessionReport = async (htmlContent: string): Promise<SessionReportPrintResult> => {
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
        return { success: false, reason: 'missing-printer' };
    }

    const selectedPaperSize: '80mm' | '58mm' =
        printerSettings.receiptPaperWidth === '58mm' ? '58mm' : '80mm';
    const didPrint = await silentPrintService.printSilentlyViaSystem(htmlContent, {
        printerName: defaultPrinter.name,
        printerId: defaultPrinter.id,
        copies: 1,
        paperSize: selectedPaperSize,
        printerPaperSize: defaultPrinter.paperWidth === '58mm' ? '58mm' : '80mm',
        timeout: 20000,
    });

    return didPrint
        ? { success: true, printerName: defaultPrinter.name }
        : { success: false, reason: 'print-failed' };
};

const normalizeStockBranchId = (value?: string | number | null): string => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';

    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];

    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];

    return normalized;
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

const SessionSalesListModal = ({ sessionId }: { sessionId: string }) => {
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

  const orderStatusBadge: Record<any, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    New: 'default',
    Preparing: 'secondary',
    Ready: 'outline',
    Completed: 'default',
    Voided: 'destructive',
    Cancelled: 'destructive',
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
              <p className="text-muted-foreground">No sales recorded in this session.</p>
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

const ZReportTabModal = ({ session }: { session: Session }) => {
    const { format: formatCurrency } = useCurrency();
    const [isPrintingZReport, setIsPrintingZReport] = useState(false);
    const [isPrintingXReport, setIsPrintingXReport] = useState(false);
    
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
                console.warn('[Session Detail] Could not refresh session orders before printing report:', syncError);
            }

            const reportSummary = calculateZReportSummary(reportOrders as any);
            const htmlContent = buildZReportPrintHtml({
                session,
                paymentBreakdown: reportSummary.paymentBreakdown,
                financialSummary: reportSummary.financialSummary,
                eisSummary: reportSummary.eisSummary,
                formatCurrency,
            });
            const printResult = await printSessionReport(htmlContent);

            if (printResult.success === false && printResult.reason === 'missing-printer') {
                toast({
                    variant: 'destructive',
                    title: 'No Printer Configured',
                    description: `Please configure a default printer before printing the ${SESSION_END_REPORT_TITLE.toLowerCase()}.`,
                });
                return;
            }

            if (printResult.success === false) {
                toast({
                    variant: 'destructive',
                    title: 'Print Failed',
                    description: `Could not print the ${SESSION_END_REPORT_TITLE.toLowerCase()}. Check the printer connection and try again.`,
                });
                return;
            }

            toast({
                title: `${SESSION_END_REPORT_TITLE} Printed`,
                description: `Sent to ${printResult.printerName}`,
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

    const handlePrintXReport = useCallback(async () => {
        if (isSessionClosed) {
            return;
        }

        try {
            setIsPrintingXReport(true);
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
                console.warn('[Session Detail] Could not refresh session orders before printing X report:', syncError);
            }

            const reportSummary = calculateZReportSummary(reportOrders as any);
            const htmlContent = buildXReportPrintHtml({
                session,
                paymentBreakdown: reportSummary.paymentBreakdown,
                financialSummary: reportSummary.financialSummary,
                formatCurrency,
            });
            const printResult = await printSessionReport(htmlContent);

            if (printResult.success === false && printResult.reason === 'missing-printer') {
                toast({
                    variant: 'destructive',
                    title: 'No Printer Configured',
                    description: `Please configure a default printer before printing the ${SESSION_X_REPORT_TITLE.toLowerCase()}.`,
                });
                return;
            }

            if (printResult.success === false) {
                toast({
                    variant: 'destructive',
                    title: 'Print Failed',
                    description: `Could not print the ${SESSION_X_REPORT_TITLE.toLowerCase()}. Check the printer connection and try again.`,
                });
                return;
            }

            toast({
                title: `${SESSION_X_REPORT_TITLE} Printed`,
                description: `Sent to ${printResult.printerName}`,
            });
        } catch (error) {
            console.error('Error printing X report:', error);
            toast({
                variant: 'destructive',
                title: 'Print Error',
                description:
                    error instanceof Error
                        ? error.message
                        : `Unexpected error while printing the ${SESSION_X_REPORT_TITLE.toLowerCase()}.`,
            });
        } finally {
            setIsPrintingXReport(false);
        }
    }, [formatCurrency, isSessionClosed, session, sessionOrders]);

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <CardTitle>Session Reports</CardTitle>
                        <CardDescription>
                            {isSessionClosed
                                ? 'Complete session summary and cash reconciliation'
                                : 'Print a current sales and cash collection snapshot.'}
                        </CardDescription>
                    </div>
                    {isSessionClosed ? (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={isPrintingZReport}
                            onClick={handlePrintZReport}
                        >
                            {isPrintingZReport ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Printer className="mr-2 h-4 w-4" />
                            )}
                            {isPrintingZReport ? 'Printing...' : `Print ${SESSION_END_REPORT_TITLE}`}
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={isPrintingXReport}
                            onClick={handlePrintXReport}
                        >
                            {isPrintingXReport ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Printer className="mr-2 h-4 w-4" />
                            )}
                            {isPrintingXReport ? 'Printing...' : `Print ${SESSION_X_REPORT_TITLE}`}
                        </Button>
                    )}
                </div>
                {!isSessionClosed && (
                    <p className="text-xs text-muted-foreground">
                        The X report is a snapshot for an open session. Close this session to print the {SESSION_END_REPORT_TITLE.toLowerCase()}.
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
                            {financialSummary.totalLevies > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Levies:</span>
                                    <span>{formatCurrency(financialSummary.totalLevies)}</span>
                                </div>
                            )}
                            {financialSummary.totalOtherCharges > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Other Charges:</span>
                                    <span>{formatCurrency(financialSummary.totalOtherCharges)}</span>
                                </div>
                            )}
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
                                <span className="text-muted-foreground">Bank Transfer Collected:</span>
                                <span>{formatCurrency(paymentBreakdown.bankTransfer)}</span>
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

const StockReportTabModal = ({ session }: { session: Session }) => {
    const { format: formatCurrency } = useCurrency();
    const [isPrintingStockReport, setIsPrintingStockReport] = useState(false);
    
    const sessionOrders = useLiveQuery(
        () => db.orders.where({ sessionId: session.id }).toArray(),
        [session.id]
    ) || [];

    const sessionPurchases = useLiveQuery(
        async () => {
            const purchasesBySession = await db.purchaseHistory
                .where('sessionId')
                .equals(session.id)
                .toArray();
            
            let purchases = purchasesBySession;

            if (session.startedAt) {
                const startTime = new Date(session.startedAt);
                const endTime = session.closedAt ? new Date(session.closedAt) : new Date();
                const normalizedSessionBranchId = normalizeStockBranchId(session.branchId);
                
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

    const sessionWaste = useLiveQuery(
        async () => {
            const wasteBySession = await db.wasteLog
                .where('sessionId')
                .equals(session.id)
                .toArray();
            
            let wasteRecords = wasteBySession;

            if (session.startedAt) {
                const startTime = new Date(session.startedAt);
                const endTime = session.closedAt ? new Date(session.closedAt) : new Date();
                const normalizedSessionBranchId = normalizeStockBranchId(session.branchId);
                
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

    const productSalesData = useMemo(() => {
        const productMap = new Map<string, { key: string; name: string; quantity: number; totalCash: number }>();

        const activeOrders = sessionOrders.filter(order => 
            order.status !== 'Voided' && order.status !== 'Cancelled'
        );

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

        (session.openingStock || []).forEach((item: any) => {
            const key = resolveCanonicalProductKey(item.itemId, item.name, productIdentity.nameToId);
            if (!key) return;
            const resolvedName = resolveDisplayProductName(item.itemId, item.name, productIdentity.idToName);
            const row = ensureProduct(key, resolvedName);
            row.opening += parseFloat(String(item.quantity || 0));
        });

        sessionPurchases.forEach((purchase) => {
            const key = resolveCanonicalProductKey(purchase.productId, purchase.productName, productIdentity.nameToId);
            if (!key) return;
            const resolvedName = resolveDisplayProductName(purchase.productId, purchase.productName, productIdentity.idToName);
            const row = ensureProduct(key, resolvedName);
            row.received += parseFloat(String(purchase.quantityReceived || 0));
        });

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

    const handlePrintStockReport = useCallback(async () => {
        try {
            setIsPrintingStockReport(true);
            const htmlContent = buildSessionStockReportPrintHtml({
                session,
                stockRows: comprehensiveStockData.map((item) => ({
                    name: item.name,
                    opening: formatSessionQuantity(item.key, item.opening),
                    received: formatSessionQuantity(item.key, item.received),
                    sold: formatSessionQuantity(item.key, item.sold),
                    waste: formatSessionQuantity(item.key, item.waste),
                    closing: formatSessionQuantity(item.key, item.remaining),
                })),
                optionUsage: optionStockUsageData.map((item) => ({
                    stockItemName: item.name,
                    menuItemName: item.parentItemName,
                    optionName: item.optionGroupName
                        ? `${item.optionGroupName}: ${item.optionName}`
                        : item.optionName,
                    quantity: formatSessionQuantity(item.itemKey, item.quantity),
                })),
            });
            const printResult = await printSessionReport(htmlContent);

            if (printResult.success === false && printResult.reason === 'missing-printer') {
                toast({
                    variant: 'destructive',
                    title: 'No Printer Configured',
                    description: `Please configure a default printer before printing the ${SESSION_STOCK_REPORT_TITLE.toLowerCase()}.`,
                });
                return;
            }

            if (printResult.success === false) {
                toast({
                    variant: 'destructive',
                    title: 'Print Failed',
                    description: `Could not print the ${SESSION_STOCK_REPORT_TITLE.toLowerCase()}. Check the printer connection and try again.`,
                });
                return;
            }

            toast({
                title: `${SESSION_STOCK_REPORT_TITLE} Printed`,
                description: `Sent to ${printResult.printerName}`,
            });
        } catch (error) {
            console.error('Error printing session stock report:', error);
            toast({
                variant: 'destructive',
                title: 'Print Error',
                description:
                    error instanceof Error
                        ? error.message
                        : `Unexpected error while printing the ${SESSION_STOCK_REPORT_TITLE.toLowerCase()}.`,
            });
        } finally {
            setIsPrintingStockReport(false);
        }
    }, [comprehensiveStockData, formatSessionQuantity, optionStockUsageData, session]);

    return (
        <Card className="min-h-[500px]">
            <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <CardTitle>Stock Report</CardTitle>
                        <CardDescription>Product sales quantities, cash value, and remaining stock</CardDescription>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={isPrintingStockReport}
                        onClick={handlePrintStockReport}
                    >
                        {isPrintingStockReport ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Printer className="mr-2 h-4 w-4" />
                        )}
                        {isPrintingStockReport ? 'Printing...' : 'Print Stock Report'}
                    </Button>
                </div>
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

                <div className="space-y-0">
                    <h3 className="font-semibold mb-3">Complete Stock Tracking (Opening + Received - Sold - Waste = Closing)</h3>
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
                                                    <p className="text-[11px] text-muted-foreground">Closing</p>
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
                                                <TableHead className="text-right">Closing</TableHead>
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

export default function SessionDetailDialog({ session, isOpen, onOpenChange }: { session: Session; isOpen: boolean; onOpenChange: (open: boolean) => void; }) {
    const { format: formatCurrency } = useCurrency();

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        void syncSessionOrdersToLocalDb({
            sessionId: session.id,
            branchId: String(session.branchId || ''),
        }).catch((error) => {
            console.warn('[Session Detail] Could not hydrate session orders for detail view:', error);
        });
    }, [isOpen, session.branchId, session.id]);
    
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[95vh] max-h-[95dvh] w-[calc(100vw-0.75rem)] max-w-4xl flex-col overflow-hidden p-4 sm:w-[95vw] sm:p-6">
                <DialogHeader>
                    <DialogTitle>Session Details</DialogTitle>
                    <DialogDescription>
                        Summary for session started on {format(new Date(session.startedAt), 'PPpp')} by {session.userName}.
                    </DialogDescription>
                </DialogHeader>
                <Tabs defaultValue="sales" className="flex-1 overflow-hidden flex flex-col">
                    <TabsList className="grid h-auto w-full grid-cols-1 sm:grid-cols-3">
                        <TabsTrigger value="sales" className="text-xs sm:text-sm">Sales Report</TabsTrigger>
                        <TabsTrigger value="session-end-report" className="text-xs sm:text-sm">Session Reports</TabsTrigger>
                        <TabsTrigger value="stock" className="text-xs sm:text-sm">Stock Report</TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="sales" className="flex-1 overflow-y-auto">
                        <SessionSalesListModal sessionId={session.id} />
                    </TabsContent>
                    
                    <TabsContent value="session-end-report" className="flex-1 overflow-y-auto">
                        <ZReportTabModal session={session} />
                    </TabsContent>
                    
                    <TabsContent value="stock" className="flex-1 overflow-y-auto">
                        <StockReportTabModal session={session} />
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};
