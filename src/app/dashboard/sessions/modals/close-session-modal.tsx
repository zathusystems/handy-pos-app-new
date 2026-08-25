import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm } from 'react-hook-form';
import { Loader2, CheckCircle2, Printer } from 'lucide-react';

import { db, type Session } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import { logAuditAction } from '@/lib/audit';
import { syncSessionOrdersToLocalDb } from '@/lib/session-order-sync';
import {
  buildZReportPrintHtml,
  calculateZReportSummary,
  SESSION_END_REPORT_TITLE,
} from '@/lib/z-report-print';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DialogFooter } from '@/components/ui/dialog';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch'
};

const roundMoney = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const moneyPayload = (value: unknown): string => roundMoney(value).toFixed(2);

type CloseSessionFormProps = {
  session: Session;
  onSessionClosed: (closedSession: Session) => void;
  onDone: () => void;
};

export default function CloseSessionForm({ session, onSessionClosed, onDone }: CloseSessionFormProps) {
  const { register, handleSubmit, watch, formState: { errors } } = useForm<{ actualCash: number }>({
    defaultValues: {
      actualCash: session.expectedCash,
    },
  });
  
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const { user } = useAuth();
  const { format: formatCurrency } = useCurrency();
  const [isLoading, setIsLoading] = useState(false);
  const [isPrintingZReport, setIsPrintingZReport] = useState(false);
  const [closedSession, setClosedSession] = useState<Session | null>(null);
  
  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  useEffect(() => {
    setClosedSession(null);
    setIsPrintingZReport(false);
  }, [session.id]);

  const currentInventory = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.inventory.where({ branchId: activeBranchId }).toArray()
    },
    [activeBranchId]
  ) || [];

  const sessionOrders = useLiveQuery(
    () => db.orders.where({ sessionId: session.id }).toArray(),
    [session.id]
  ) || [];

  const { paymentBreakdown, financialSummary, eisSummary } = useMemo(
    () => calculateZReportSummary(sessionOrders as any),
    [sessionOrders]
  );

  const hasOrderBreakdown = sessionOrders.length > 0;
  const resolvedPaymentBreakdown = {
    cash: hasOrderBreakdown ? paymentBreakdown.cash : (session.totalCashSales || 0),
    card: hasOrderBreakdown ? paymentBreakdown.card : (session.totalCardSales || 0),
    mobileMoney: hasOrderBreakdown ? paymentBreakdown.mobileMoney : (session.totalMobileMoneySales || 0),
    bankTransfer: hasOrderBreakdown ? paymentBreakdown.bankTransfer : (session.totalBankTransferSales || 0),
    onAccount: hasOrderBreakdown ? paymentBreakdown.onAccount : (session.totalOnAccountSales || 0),
    other: hasOrderBreakdown ? paymentBreakdown.other : (session.totalOtherSales || 0),
    laybuyDeposits: hasOrderBreakdown ? paymentBreakdown.laybuyDeposits : 0,
    laybuyOutstanding: hasOrderBreakdown ? paymentBreakdown.laybuyOutstanding : 0,
    totalCollected: hasOrderBreakdown
      ? paymentBreakdown.totalCollected
      : (session.totalCashSales || 0) + (session.totalCardSales || 0) + (session.totalMobileMoneySales || 0) + (session.totalBankTransferSales || 0) + (session.totalOtherSales || 0),
    totalDue: hasOrderBreakdown
      ? paymentBreakdown.totalDue
      : (session.totalOnAccountSales || 0),
  };
  const resolvedExpectedCash = (session.openingFloat || 0) + resolvedPaymentBreakdown.cash;
  const actualCash = watch('actualCash', resolvedExpectedCash);
  const difference = actualCash - resolvedExpectedCash;

  const handlePrintZReport = useCallback(async () => {
    if (!closedSession || !activeBranchId) {
      toast({
        variant: 'destructive',
        title: `Cannot print ${SESSION_END_REPORT_TITLE.toLowerCase()}`,
        description: 'Session was closed but branch or session context is missing.',
      });
      return;
    }

    try {
      setIsPrintingZReport(true);
      let reportOrders = sessionOrders;
      try {
        const syncedOrders = await syncSessionOrdersToLocalDb({
          sessionId: closedSession.id,
          branchId: activeBranchId,
        });
        if (syncedOrders.length > 0) {
          reportOrders = syncedOrders;
        }
      } catch (syncError) {
        console.warn('[Sessions] Could not refresh session orders before printing report:', syncError);
      }

      const reportSummary = calculateZReportSummary(reportOrders as any);
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
        session: closedSession,
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
      console.error('[Sessions] Error printing session end report after close:', error);
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
  }, [activeBranchId, closedSession, formatCurrency, sessionOrders]);

  const onSubmit = async (data: { actualCash: number }) => {
    if (!user || !activeBranchId) {
        toast({ variant: 'destructive', title: 'User not found.' });
        return;
    }

    setIsLoading(true);

    try {
        const closingStockData = currentInventory.map(i => ({ 
            itemId: i.id, 
            name: i.name, 
            quantity: i.stockUnits || 0 
        }));

        const actualCashValue = roundMoney(data.actualCash);
        const differenceValue = roundMoney(actualCashValue - resolvedExpectedCash);
        const closedAt = new Date().toISOString();
        const closingData = {
            status: 'closed',
            actual_cash: moneyPayload(actualCashValue),
            closing_float: moneyPayload(actualCashValue),
            difference: moneyPayload(differenceValue),
            closing_stock: closingStockData,
            closed_at: closedAt,
        };

        console.log('[Sessions] Current inventory count:', currentInventory.length);
        console.log('[Sessions] Current inventory items:', currentInventory.map(i => ({ id: i.id, name: i.name, stockUnits: i.stockUnits })));
        console.log('[Sessions] Closing stock data being sent:', closingStockData);
        console.log('[Sessions] Full closing data:', closingData);
        console.log('[Sessions] Closing session on backend:', session.id);

        // Update session on backend using the close action
        const response = await authFetch.fetch<any>(`/sessions/sessions/${session.id}/close/`, {
            method: 'POST',
            body: JSON.stringify(closingData),
            meta: {
                domain: 'sessions',
                entityType: 'Session',
                entityId: session.id,
                metadata: { action: 'close', actualCash: actualCashValue, difference: differenceValue }
            }
        });

        console.log('[Sessions] Session closed on backend:', response);

        const updatedSession: Session = {
          ...session,
          status: 'closed',
          expectedCash: resolvedExpectedCash,
          actualCash: actualCashValue,
          closingFloat: actualCashValue,
          difference: differenceValue,
          closingStock: closingData.closing_stock as any,
          closedAt,
        };

        try {
          // Best effort cache update only; backend close remains source of truth.
          await db.sessions.update(session.id, {
            status: 'closed',
            expectedCash: resolvedExpectedCash,
            actualCash: actualCashValue,
            closingFloat: actualCashValue,
            difference: differenceValue,
            closingStock: closingData.closing_stock,
            closedAt,
          });
          console.log('[Sessions] Session updated in local DB:', session.id);
        } catch (localUpdateError) {
          console.warn('[Sessions] Local DB session update failed after successful backend close:', localUpdateError);
        }

        // Log audit action
        await logAuditAction({
            userId: user.uid,
            userName: user.displayName || user.email || 'Unknown',
            branchId: activeBranchId,
            actionType: 'SESSION_END',
            entityType: 'Session',
            entityId: session.id,
            details: { 
                expectedCash: resolvedExpectedCash,
                actualCash: actualCashValue,
                difference: differenceValue 
            },
        });

        toast({ title: 'Session Closed', description: `Session has been successfully closed.` });
        
        // CRITICAL: Immediately refresh active session in POS modal
        // Dispatch custom event to notify POS modal that session was closed
        window.dispatchEvent(new CustomEvent('sessionClosed', { 
          detail: { sessionId: session.id, branchId: activeBranchId }
        }));
        console.log('[Sessions] Dispatched sessionClosed event for POS modal refresh');

        setClosedSession(updatedSession);
        onSessionClosed(updatedSession);
    } catch (error) {
        console.error('[Sessions] Error closing session:', error);
        toast({ 
            variant: 'destructive', 
            title: 'Failed to close session',
            description: error instanceof Error ? error.message : 'Unknown error'
        });
    } finally {
        setIsLoading(false);
    }
  };

  const sessionPaymentBreakdown = [
    { label: 'Cash Collected', value: resolvedPaymentBreakdown.cash },
    { label: 'Card Collected', value: resolvedPaymentBreakdown.card },
    { label: 'Mobile Money Collected', value: resolvedPaymentBreakdown.mobileMoney },
    { label: 'Bank Transfer Collected', value: resolvedPaymentBreakdown.bankTransfer },
    { label: 'Account / Invoice Due', value: resolvedPaymentBreakdown.onAccount },
    { label: 'Laybuy Deposits', value: resolvedPaymentBreakdown.laybuyDeposits },
    { label: 'Laybuy Outstanding', value: resolvedPaymentBreakdown.laybuyOutstanding },
    { label: 'Other Collected', value: resolvedPaymentBreakdown.other },
  ].filter(item => (item.value || 0) > 0);

  if (closedSession) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-6 p-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle2 className="h-5 w-5" />
                  Session Closed Successfully
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Closed At:</span>
                  <span className="font-medium">{closedSession.closedAt ? new Date(closedSession.closedAt).toLocaleString() : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net Sales:</span>
                  <span className="font-medium">{formatCurrency(financialSummary.netSales)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Tax:</span>
                  <span className="font-medium">{formatCurrency(financialSummary.totalTax)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gross Sales:</span>
                  <span className="font-medium">{formatCurrency(financialSummary.grossSales)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Collected:</span>
                  <span className="font-medium">{formatCurrency(paymentBreakdown.totalCollected)}</span>
                </div>
                {paymentBreakdown.totalDue > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Still Due:</span>
                    <span className="font-medium">{formatCurrency(paymentBreakdown.totalDue)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Difference:</span>
                  <span className={`font-semibold ${(closedSession.difference || 0) === 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {formatCurrency(closedSession.difference || 0)}
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Print {SESSION_END_REPORT_TITLE}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  Print the finalized {SESSION_END_REPORT_TITLE.toLowerCase()} for this closed session now.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Fiscal Assigned:</span>
                    <span>{eisSummary.ordersWithFiscalNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Fiscal Pending:</span>
                    <span>{eisSummary.pendingFiscalNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">With QR:</span>
                    <span>{eisSummary.ordersWithQr}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">With Signature:</span>
                    <span>{eisSummary.ordersWithSignature}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        <DialogFooter className="pt-4 border-t px-4 pb-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handlePrintZReport()}
            disabled={isPrintingZReport}
          >
            {isPrintingZReport ? <Loader2 className="mr-2 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
            {isPrintingZReport ? 'Printing...' : `Print ${SESSION_END_REPORT_TITLE}`}
          </Button>
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col h-full">
       <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-4">
        <Card>
            <CardHeader>
            <CardTitle>Sales & Collection Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between font-semibold">
                <span>Net Sales (Before Tax):</span>
                <span className="text-xs">{formatCurrency(financialSummary.netSales || session.totalSales || 0)}</span>
            </div>
            <div className="flex justify-between">
                <span className="text-muted-foreground">Tax:</span>
                <span className="font-medium text-xs">{formatCurrency(financialSummary.totalTax || 0)}</span>
            </div>
            <div className="flex justify-between">
                <span className="text-muted-foreground">Sales Value:</span>
                <span className="font-medium text-xs">{formatCurrency(financialSummary.grossSales || 0)}</span>
            </div>
            <Separator />
            {sessionPaymentBreakdown.map(item => (
                <div key={item.label} className="flex justify-between">
                <span>{item.label}</span> 
                <span className="font-medium text-xs">{formatCurrency(item.value || 0)}</span>
                </div>
            ))}
            <Separator />
            <div className="flex justify-between font-semibold">
                <span>Total Collected:</span>
                <span className="text-xs">{formatCurrency(resolvedPaymentBreakdown.totalCollected)}</span>
            </div>
            {resolvedPaymentBreakdown.totalDue > 0 && (
                <div className="flex justify-between font-semibold">
                <span>Still Due:</span>
                <span className="text-xs">{formatCurrency(resolvedPaymentBreakdown.totalDue)}</span>
                </div>
            )}
            </CardContent>
        </Card>
        <Card>
            <CardHeader>
            <CardTitle>Cash Reconciliation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex justify-between items-center text-sm border-b pb-2"><span>Opening Float:</span> <span className="font-medium text-xs">{formatCurrency(session.openingFloat || 0)}</span></div>
                <div className="flex justify-between items-center text-sm border-b pb-2"><span>+ Cash Collected:</span> <span className="font-medium text-green-600 text-xs">{formatCurrency(resolvedPaymentBreakdown.cash || 0)}</span></div>
                <div className="flex justify-between items-center font-semibold text-base border-b pb-2"><span>Expected in Drawer:</span> <span className="text-xs">{formatCurrency(resolvedExpectedCash || 0)}</span></div>
            
                <div className="grid gap-2">
                    <Label htmlFor="actualCash" className="font-semibold">Actual Cash Counted</Label>
                    <Input
                        id="actualCash"
                        type="number"
                        step="0.01"
                        {...register('actualCash', { required: true, valueAsNumber: true, min: 0 })}
                    />
                    {errors.actualCash && <p className="text-sm text-destructive">Please enter the counted cash amount.</p>}
                </div>
                
                <div className={`flex justify-between items-center font-semibold text-lg p-3 rounded-md ${difference === 0 ? 'bg-green-100' : 'bg-red-100'}`}>
                    <span>Difference:</span>
                    <span className={difference === 0 ? 'text-green-700' : 'text-red-700'}>
                    {formatCurrency(difference)}
                    </span>
                </div>
            </CardContent>
        </Card>
        </div>
      </div>
      
      <DialogFooter className="pt-4 border-t px-4 pb-4">
        <Button type="submit" variant="destructive" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 animate-spin" />}
            Confirm and Close Session
        </Button>
      </DialogFooter>
    </form>
  );
};
