'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { MoreHorizontal, AlertTriangle, FileText, Loader2, Printer } from 'lucide-react';

import { db, type Order, type Business } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { useToast } from '@/hooks/use-toast';
import { getOfflineBusinessProfile } from '@/lib/business-profile';
import {
  DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
  DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
  DEFAULT_RECEIPT_FONT_WEIGHT,
  DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT,
  DEFAULT_RECEIPT_LINE_HEIGHT,
  PRINTER_CONFIG_UPDATED_EVENT,
  getDefaultReceiptBusinessNameFontSize,
  getDefaultReceiptFontSize,
  getDefaultReceiptLegalMarkerFontSize,
  getDefaultReceiptPaddingX,
  getDefaultReceiptQRCodeSize,
  normalizeReceiptBusinessNameFontSize,
  normalizeReceiptFontSize,
  normalizeReceiptFontWeight,
  normalizeReceiptLegalMarkerFontSize,
  normalizeReceiptLineHeight,
  normalizeReceiptPaddingX,
  normalizeReceiptQRCodeSize,
  normalizeReceiptTextScaleX,
  type PrinterSettings,
} from '@/lib/services/printer-service';
import { getNextReceiptCopyNumber, markReceiptPrinted } from '@/lib/services/receipt-copy-service';
import { formatQuantityWithUnit, getPortionQuantityDisplay } from '@/lib/quantity-format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Receipt2 as Receipt } from '@/components/pos/receipt2';
import { VoidModal } from './void-modal';

interface VoidTransaction {
  id: string;
  void_number: string;
  void_reason: string;
  reason_description: string;
  voided_amount: number;
  voided_vat: number;
  refund_method: string;
  refund_amount: number;
  refund_processed: boolean;
  created_by_name?: string;
  created_at: string;
}

type InventoryQuantityMeta = {
  unitLabel: string;
  isSoldInPortions: boolean;
  portionName?: string;
  portionsPerUnit?: number;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeItemTaxType = (value: unknown): 'standard' | 'zero' | 'exempt' => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('zero')) return 'zero';
  if (normalized.includes('exempt')) return 'exempt';
  return 'standard';
};

const normalizeTaxMethod = (value: unknown): 'inclusive' | 'exclusive' => {
  return String(value ?? '').trim().toLowerCase() === 'exclusive' ? 'exclusive' : 'inclusive';
};

const toTrimmedString = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = String(value).trim();
  return trimmed;
};

const resolveOrderItemInventoryId = (item: any): string => {
  const candidates = [
    item?.inventoryItemId,
    item?.inventory_item_id,
    item?.inventoryItem,
    item?.inventory_item,
  ];

  for (const candidate of candidates) {
    const normalized = toTrimmedString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const rawLineId = toTrimmedString(item?.id);
  if (!rawLineId) {
    return '';
  }
  return rawLineId.split('::cart::')[0] || rawLineId;
};

const normalizeUnitLabel = (value: unknown): string => {
  return toTrimmedString(value);
};

const formatUnitLabel = (unit: string, quantity: number): string => {
  const trimmed = normalizeUnitLabel(unit);
  if (!trimmed) {
    return '';
  }
  if (trimmed.toLowerCase() === 'unit') {
    return quantity === 1 ? 'unit' : 'units';
  }
  return trimmed;
};

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

export default function SaleDetailModal({ order, isOpen, onOpenChange }: { order: Order | null; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { format: formatCurrency } = useCurrency();
  const { user } = useAuth();
  const { toast } = useToast();
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidTransaction, setVoidTransaction] = useState<VoidTransaction | null>(null);
  const [loadingVoid, setLoadingVoid] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [businessSettings, setBusinessSettings] = useState<Business | null>(null);
  const [inventoryQuantityMetaById, setInventoryQuantityMetaById] = useState<Record<string, InventoryQuantityMeta>>({});
  const [receiptPaperWidth, setReceiptPaperWidth] = useState<'80mm' | '58mm'>('80mm');
  const [receiptCopyNumber, setReceiptCopyNumber] = useState(1);
  const [receiptDisplaySettings, setReceiptDisplaySettings] = useState({
    showHeader: true,
    showFooter: true,
    showQRCode: true,
    showItemDetails: true,
    showTaxBreakdown: true,
    receiptFontSize: getDefaultReceiptFontSize('80mm'),
    receiptFontWeight: DEFAULT_RECEIPT_FONT_WEIGHT as PrinterSettings['receiptFontWeight'],
    receiptLineHeight: DEFAULT_RECEIPT_LINE_HEIGHT,
    receiptPaddingX: getDefaultReceiptPaddingX('80mm'),
    receiptBusinessNameFontSize: getDefaultReceiptBusinessNameFontSize('80mm'),
    receiptBusinessNameFontWeight: DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT as PrinterSettings['receiptFontWeight'],
    receiptBusinessNameScaleX: DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
    receiptHeaderDetailScaleX: DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
    receiptLegalMarkerFontSize: getDefaultReceiptLegalMarkerFontSize('80mm'),
    receiptLegalMarkerFontWeight: DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT as PrinterSettings['receiptFontWeight'],
    receiptLegalMarkerScaleX: DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
    receiptQrCodeSize: getDefaultReceiptQRCodeSize('80mm'),
  });

  const applyPrinterSettingsToReceipt = useCallback(
    (
      settings?: Partial<PrinterSettings> | null,
      fallbackPaperWidth: '80mm' | '58mm' = '80mm'
    ): '80mm' | '58mm' => {
      const resolvedPaperWidth: '80mm' | '58mm' =
        settings?.receiptPaperWidth === '58mm' ? '58mm' : fallbackPaperWidth;

      setReceiptPaperWidth(resolvedPaperWidth);
      setReceiptDisplaySettings({
        showHeader: settings?.printHeader ?? true,
        showFooter: settings?.printFooter ?? true,
        showQRCode: settings?.printQRCode ?? true,
        showItemDetails: settings?.printItemDetails ?? true,
        showTaxBreakdown: settings?.printTaxBreakdown ?? true,
        receiptFontSize: normalizeReceiptFontSize(settings?.receiptFontSize, resolvedPaperWidth),
        receiptFontWeight: normalizeReceiptFontWeight(settings?.receiptFontWeight),
        receiptLineHeight: normalizeReceiptLineHeight(settings?.receiptLineHeight),
        receiptPaddingX: normalizeReceiptPaddingX(settings?.receiptPaddingX, resolvedPaperWidth),
        receiptBusinessNameFontSize: normalizeReceiptBusinessNameFontSize(
          settings?.receiptBusinessNameFontSize,
          resolvedPaperWidth
        ),
        receiptBusinessNameFontWeight: normalizeReceiptFontWeight(
          settings?.receiptBusinessNameFontWeight ?? DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT
        ),
        receiptBusinessNameScaleX: normalizeReceiptTextScaleX(
          settings?.receiptBusinessNameScaleX,
          DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
        ),
        receiptHeaderDetailScaleX: normalizeReceiptTextScaleX(
          settings?.receiptHeaderDetailScaleX,
          DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
        ),
        receiptLegalMarkerFontSize: normalizeReceiptLegalMarkerFontSize(
          settings?.receiptLegalMarkerFontSize,
          resolvedPaperWidth
        ),
        receiptLegalMarkerFontWeight: normalizeReceiptFontWeight(
          settings?.receiptLegalMarkerFontWeight ?? DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT
        ),
        receiptLegalMarkerScaleX: normalizeReceiptTextScaleX(
          settings?.receiptLegalMarkerScaleX,
          DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X
        ),
        receiptQrCodeSize: normalizeReceiptQRCodeSize(
          settings?.receiptQrCodeSize,
          resolvedPaperWidth
        ),
      });

      return resolvedPaperWidth;
    },
    []
  );

  const refreshPrinterSettings = useCallback(async () => {
    const activeBranchId = localStorage.getItem('handypos-active-branch') || 'main';
    const { printerService } = await import('@/lib/services/printer-service');
    const [printerSettings, defaultPrinter] = await Promise.all([
      printerService.getPrinterSettings(activeBranchId),
      printerService.getDefaultPrinter(activeBranchId),
    ]);

    applyPrinterSettingsToReceipt(
      printerSettings,
      (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
    );
  }, [applyPrinterSettingsToReceipt]);

  // Fetch business settings and void transaction details
  useEffect(() => {
    let isMounted = true;

    if (isOpen) {
      // Fetch business settings
      getOfflineBusinessProfile().then((business) => {
        if (isMounted) {
          setBusinessSettings(business || null);
        }
      });

      const activeBranchId = localStorage.getItem('handypos-active-branch') || 'main';
      import('@/lib/services/printer-service')
        .then(async ({ printerService }) => {
          const [printerSettings, defaultPrinter] = await Promise.all([
            printerService.getPrinterSettings(activeBranchId),
            printerService.getDefaultPrinter(activeBranchId),
          ]);

          if (isMounted) {
            applyPrinterSettingsToReceipt(
              printerSettings,
              (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
            );
          }
        })
        .catch((error) => {
          console.warn('Error loading printer settings:', error);
        });

      // Fetch void transaction details if order is voided
      if (order && order.status === 'Voided') {
        setLoadingVoid(true);
        authFetch.fetch<any>(`/sessions/void-transactions/by_order/?order_id=${order.id}`)
          .then(response => {
            if (response && Array.isArray(response) && response.length > 0) {
              setVoidTransaction(response[0]);
            }
          })
          .catch(error => {
            console.error('Error fetching void transaction:', error);
          })
          .finally(() => {
            setLoadingVoid(false);
          });
      }
    }

    return () => {
      isMounted = false;
    };
  }, [order, isOpen, applyPrinterSettingsToReceipt]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePrinterUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ branchId?: string }>;
      const activeBranchId = localStorage.getItem('handypos-active-branch') || 'main';
      const updatedBranchId = String(customEvent.detail?.branchId || '').trim();
      if (updatedBranchId && updatedBranchId !== activeBranchId) {
        return;
      }

      void refreshPrinterSettings().catch((error) => {
        console.warn('Error refreshing printer settings after update:', error);
      });
    };

    window.addEventListener(PRINTER_CONFIG_UPDATED_EVENT, handlePrinterUpdate);
    return () => window.removeEventListener(PRINTER_CONFIG_UPDATED_EVENT, handlePrinterUpdate);
  }, [isOpen, refreshPrinterSettings]);

  useEffect(() => {
    let isMounted = true;

    if (!isOpen || !order) {
      setInventoryQuantityMetaById({});
      return () => {
        isMounted = false;
      };
    }

    const inventoryIds = Array.from(
      new Set(
        order.items
          .map((item) => resolveOrderItemInventoryId(item))
          .filter((id) => Boolean(id))
      )
    );

    if (inventoryIds.length === 0) {
      setInventoryQuantityMetaById({});
      return () => {
        isMounted = false;
      };
    }

    db.inventory
      .bulkGet(inventoryIds)
      .then((items) => {
        if (!isMounted) {
          return;
        }
        const nextMap: Record<string, InventoryQuantityMeta> = {};
        items.forEach((inventoryItem, index) => {
          const id = inventoryIds[index];
          if (!inventoryItem || !id) {
            return;
          }
          const unitLabel =
            normalizeUnitLabel((inventoryItem as any).unitType) ||
            normalizeUnitLabel((inventoryItem as any).unit_type) ||
            normalizeUnitLabel((inventoryItem as any).unit);
          nextMap[id] = {
            unitLabel: unitLabel || 'unit',
            isSoldInPortions: Boolean((inventoryItem as any).isSoldInPortions),
            portionName: toTrimmedString((inventoryItem as any).portionName),
            portionsPerUnit: toFiniteNumber((inventoryItem as any).portionsPerUnit, 0),
          };
        });
        setInventoryQuantityMetaById(nextMap);
      })
      .catch((error) => {
        console.warn('Error loading inventory units:', error);
        if (isMounted) {
          setInventoryQuantityMetaById({});
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, order]);

  if (!order) return null;

  const buyerDetails = resolveBuyerDetails(order);
  const buyerNameDisplay = buyerDetails.name || 'Walk-in Customer';
  const buyerPhoneDisplay = buyerDetails.phone || 'N/A';
  const buyerTinDisplay = buyerDetails.tin || 'N/A';
  const eisStatusDisplay = toTrimmedString((order as any).eisStatus ?? (order as any).eis_status).toUpperCase();

  const isVoided = order.status === 'Voided' || order.status === 'Cancelled';
  const isFiscalLocked = order.is_fiscal_locked;
  const isAdminUser = String(user?.role || '').toLowerCase() === 'admin';
  const normalizedItems = order.items.map((item) => {
    const itemTaxRate = toFiniteNumber(item.tax_rate ?? item.taxRate, 0);
    const itemTaxType = normalizeItemTaxType(item.tax_type ?? item.taxType);
    const itemTaxMethod = normalizeTaxMethod(
      item.tax_calculation_method ?? item.taxCalculationMethod
    );
    const itemPrice = toFiniteNumber(item.price, 0);
    const itemQuantity = toFiniteNumber(item.quantity, 1);
    const itemSubtotal = toFiniteNumber(item.subtotal, itemPrice * itemQuantity);
    const itemTaxAmount = toFiniteNumber(item.tax_amount ?? item.taxAmount, 0);
    const itemTotal = toFiniteNumber(item.total, itemSubtotal + itemTaxAmount);
    const directUnit =
      normalizeUnitLabel((item as any).unitType) ||
      normalizeUnitLabel((item as any).unit_type) ||
      normalizeUnitLabel((item as any).unit) ||
      normalizeUnitLabel((item as any).mraUnitMeasure) ||
      normalizeUnitLabel((item as any).mra_unit_measure);
    const resolvedInventoryId = resolveOrderItemInventoryId(item);
    const inventoryMeta = resolvedInventoryId ? inventoryQuantityMetaById[resolvedInventoryId] : undefined;
    const snapshotPortionsPerUnit = toFiniteNumber(
      (item as any).portionsPerUnit ?? (item as any).portions_per_unit,
      0
    );
    const snapshotIsSoldInPortions =
      (item as any).isSoldInPortions ?? (item as any).is_sold_in_portions;
    const effectiveQuantityMeta = {
      unitLabel: directUnit || inventoryMeta?.unitLabel || 'unit',
      isSoldInPortions:
        snapshotIsSoldInPortions !== undefined && snapshotIsSoldInPortions !== null
          ? Boolean(snapshotIsSoldInPortions)
          : Boolean(inventoryMeta?.isSoldInPortions),
      portionName:
        toTrimmedString((item as any).portionName ?? (item as any).portion_name) ||
        inventoryMeta?.portionName,
      portionsPerUnit:
        snapshotPortionsPerUnit > 0 ? snapshotPortionsPerUnit : inventoryMeta?.portionsPerUnit,
    };
    const quantityDisplay = (() => {
      const portionsPerUnit = toFiniteNumber(effectiveQuantityMeta.portionsPerUnit, 0);
      if (effectiveQuantityMeta.isSoldInPortions && portionsPerUnit > 0) {
        const portionDisplay = getPortionQuantityDisplay({
          quantity: itemQuantity,
          unitLabel: effectiveQuantityMeta.unitLabel,
          portionName: effectiveQuantityMeta.portionName,
          portionsPerUnit,
        });
        if (portionDisplay) {
          return portionDisplay.summaryText;
        }
      }

      return formatQuantityWithUnit(itemQuantity, effectiveQuantityMeta.unitLabel, {
        maximumFractionDigits: 3,
      });
    })();

    return {
      ...item,
      itemTaxRate,
      itemTaxType,
      itemTaxMethod,
      itemPrice,
      itemQuantity,
      itemSubtotal,
      itemTaxAmount,
      itemTotal,
      quantityDisplay,
    };
  });

  const handlePrintReceipt = async () => {
    try {
      setIsPrinting(true);
      const { printerService } = await import('@/lib/services/printer-service');
      const { silentPrintService } = await import('@/lib/services/silent-print-service');
      const orderId = String(order?.id ?? '').trim();

      const activeBranchId = localStorage.getItem('handypos-active-branch') || 'main';
      const [settings, defaultPrinter] = await Promise.all([
        printerService.getPrinterSettings(activeBranchId),
        printerService.getDefaultPrinter(activeBranchId),
      ]);
      const selectedPaperWidth = applyPrinterSettingsToReceipt(
        settings,
        (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
      );
      
      if (!defaultPrinter) {
        console.error('No default printer configured');
        toast({
          variant: 'destructive',
          title: 'No Printer Configured',
          description: 'Please configure a printer in Settings → Printers before printing.',
        });
        setIsPrinting(false);
        return;
      }

      const configuredCopies = Number.isFinite(Number(settings.printCopies))
        ? Number(settings.printCopies)
        : 1;
      const copiesToPrint = Math.max(1, Math.floor(configuredCopies));
      const startingCopyNumber = getNextReceiptCopyNumber(orderId);

      toast({
        title: 'Printing...',
        description: `Sending ${copiesToPrint} receipt${copiesToPrint > 1 ? 's' : ''} to ${defaultPrinter.name}`,
      });

      // Try silent printing first (works with Tauri/Electron or auto-submit)
      const availableMethods = silentPrintService.getAvailableMethods();
      console.log('[Print] Available print methods:', availableMethods);

      let printedCopies = 0;
      let failedResult: { timedOut: boolean } | null = null;

      for (let copyIndex = 0; copyIndex < copiesToPrint; copyIndex += 1) {
        const currentCopyNumber = startingCopyNumber + copyIndex;
        setReceiptCopyNumber(currentCopyNumber);

        // Wait for receipt to re-render with updated ORIGINAL/COPY marker.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const receiptElement = document.getElementById('receipt-printable-area');
        const printContents = receiptElement?.innerHTML;

        if (!printContents || printContents.trim().length === 0) {
          console.error('Receipt content not found or empty');
          failedResult = { timedOut: false };
          break;
        }

        const printAttempt = Promise.race([
          silentPrintService.printSilentlyViaSystem(printContents, {
            printerName: defaultPrinter.name,
            printerId: defaultPrinter.id,
            copies: 1,
            paperSize: selectedPaperWidth,
            printerPaperSize: defaultPrinter.paperWidth as '80mm' | '58mm',
          }).then((success) => ({ success, timedOut: false })),
          new Promise<{ success: false; timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ success: false, timedOut: true }), 20000)
          ),
        ]);

        const result = await printAttempt;
        if (!result.success) {
          failedResult = { timedOut: result.timedOut };
          break;
        }

        printedCopies += 1;
      }

      if (printedCopies > 0) {
        markReceiptPrinted(orderId, printedCopies);
      }

      const isCompleteSuccess = printedCopies === copiesToPrint && failedResult === null;
      if (isCompleteSuccess) {
        const printedTypeLabel = startingCopyNumber > 1 ? 'Receipt copy printed' : 'Original receipt printed';
        toast({
          title: 'Print Successful',
          description: copiesToPrint > 1
            ? `${printedCopies} receipts sent to ${defaultPrinter.name}`
            : `${printedTypeLabel} to ${defaultPrinter.name}`,
        });
      } else {
        console.warn('Print failed');
        const failedDescription = failedResult?.timedOut
          ? 'Printer did not respond in time. Check printer connection and try again.'
          : 'Failed to send receipt to printer. Please try again.';
        toast({
          variant: 'destructive',
          title: failedResult?.timedOut ? 'Print Timed Out' : 'Print Failed',
          description: printedCopies > 0
            ? `${printedCopies} receipt${printedCopies > 1 ? 's were' : ' was'} printed, then printing stopped. ${failedDescription}`
            : failedDescription,
        });
      }
    } catch (error) {
      console.error('Error printing receipt:', error);
      toast({
        variant: 'destructive',
        title: 'Print Error',
        description: error instanceof Error ? error.message : 'An unknown error occurred',
      });
    } finally {
      setIsPrinting(false);
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[95dvh] w-[calc(100vw-0.75rem)] max-w-4xl flex-col overflow-hidden p-4 sm:w-[95vw] sm:p-6">
          <DialogHeader className="gap-3 pr-8 text-left sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1">
              <DialogTitle>Order #{order.orderNumber} Details</DialogTitle>
              <DialogDescription>
                {format(new Date(order.createdAt), 'PPpp')}
              </DialogDescription>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:justify-end">
              <Button 
                variant="outline" 
                size="sm" 
                className="h-8 flex-1 sm:h-9 sm:flex-none"
                onClick={handlePrintReceipt}
                disabled={isPrinting}
              >
                <Printer className="mr-2 h-4 w-4" />
                {isPrinting ? 'Printing...' : 'Print'}
              </Button>
              {!isVoided && isAdminUser && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem 
                      onClick={() => setVoidOpen(true)} 
                      disabled={isFiscalLocked} 
                      className="text-red-600"
                    >
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      <span>Void Sale</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </DialogHeader>

          <div className="space-y-6 overflow-y-auto pb-1">
            {/* Status Badges */}
            {isVoided && (
              <div className="bg-destructive/10 border border-destructive/30 p-3 rounded-lg flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <span className="text-sm font-medium text-destructive">This sale has been voided</span>
              </div>
            )}

            {isFiscalLocked && (
              <div className="bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/30 p-3 rounded-lg flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">This invoice is locked (submitted to MRA)</span>
              </div>
            )}

            {/* Items Table with Tax Details */}
            <div>
              <h3 className="font-semibold mb-3">Items & Tax Details</h3>
              <div className="space-y-3 sm:hidden">
                {normalizedItems.map((item, idx) => (
                  <Card key={`mobile-item-${idx}`} className="mobile-data-card border">
                    <CardContent className="space-y-3 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium break-words">{item.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Qty: {item.quantityDisplay}
                          </p>
                          {item.notes && (
                            <p className="mt-1 text-xs text-muted-foreground break-words">{item.notes}</p>
                          )}
                        </div>
                        <p className="text-sm font-bold whitespace-nowrap">{formatCurrency(item.itemTotal)}</p>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-md bg-muted p-2">
                          <p className="text-muted-foreground">Unit Price</p>
                          <p className="font-medium">{formatCurrency(item.itemPrice)}</p>
                        </div>
                        <div className="rounded-md bg-muted p-2">
                          <p className="text-muted-foreground">Subtotal</p>
                          <p className="font-medium">{formatCurrency(item.itemSubtotal)}</p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                          {item.itemTaxRate}%
                        </span>
                        <span className="rounded-full bg-muted px-2 py-1">
                          {item.itemTaxType === 'standard'
                            ? 'Standard'
                            : item.itemTaxType === 'zero'
                              ? 'Zero'
                              : 'Exempt'}
                        </span>
                        <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                          {item.itemTaxMethod === 'exclusive' ? 'Exclusive' : 'Inclusive'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between border-t pt-2 text-sm">
                        <span className="text-muted-foreground">Item Tax</span>
                        <span className="font-semibold text-green-600 dark:text-green-400">
                          {formatCurrency(item.itemTaxAmount)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Name & Qty</TableHead>
                      <TableHead className="text-right">Unit Price</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                      <TableHead className="text-right">Tax Details</TableHead>
                      <TableHead className="text-right">Item Tax</TableHead>
                      <TableHead className="text-right">Item Total</TableHead>
                    </TableRow>
                  </TableHeader>
                    <TableBody>
                    {normalizedItems.map((item, idx) => {
                      return (
                        <TableRow key={idx}>
                          <TableCell className="font-medium">
                            <div>
                              <p>{item.name}</p>
                              <p className="text-xs text-muted-foreground">
                                Qty: {item.quantityDisplay}
                              </p>
                              {item.notes && <p className="text-xs text-muted-foreground mt-1">{item.notes}</p>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{formatCurrency(item.itemPrice)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.itemSubtotal)}</TableCell>
                          <TableCell className="text-right">
                            <div className="space-y-1">
                              <div className="text-blue-600 dark:text-blue-400 font-medium">{item.itemTaxRate}%</div>
                              <div className="text-xs px-2 py-1 rounded-full bg-muted inline-block">
                                {item.itemTaxType === 'standard' ? 'Standard' : item.itemTaxType === 'zero' ? 'Zero' : 'Exempt'}
                              </div>
                              <div className="text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 inline-block ml-1">
                                {item.itemTaxMethod === 'exclusive' ? 'Exclusive' : 'Inclusive'}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-medium text-green-600 dark:text-green-400">{formatCurrency(item.itemTaxAmount)}</TableCell>
                          <TableCell className="text-right font-bold">{formatCurrency(item.itemTotal)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Payment & Status Info */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Payment Method</p>
                <p className="font-semibold">{order.paymentMethod}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <p className="font-semibold capitalize">{order.status}</p>
              </div>
            </div>

            {/* Buyer Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Buyer Details</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-sm text-muted-foreground">Name</p>
                  <p className="font-semibold">{buyerNameDisplay}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Phone</p>
                  <p className="font-semibold">{buyerPhoneDisplay}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">TIN</p>
                  <p className="font-semibold">{buyerTinDisplay}</p>
                </div>
              </CardContent>
            </Card>

            {/* Tax Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tax Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal:</span>
                  <span className="font-medium">{formatCurrency(order.subtotal)}</span>
                </div>
                
                <div className="border-t pt-3 space-y-2">
                  {/* Group items by tax rate and calculation method */}
                  {(() => {
                    const taxBreakdown: Record<string, { count: number; taxAmount: number; method: string }> = {};
                    
                    order.items.forEach((item) => {
                      const taxRate = toFiniteNumber(item.tax_rate ?? item.taxRate, 0);
                      const taxAmount = toFiniteNumber(item.tax_amount ?? item.taxAmount, 0);
                      const taxMethod = normalizeTaxMethod(
                        item.tax_calculation_method ?? item.taxCalculationMethod
                      );
                      const rateKey = `${taxRate}-${taxMethod}`;
                      
                      if (!taxBreakdown[rateKey]) {
                        taxBreakdown[rateKey] = { count: 0, taxAmount: 0, method: taxMethod };
                      }
                      taxBreakdown[rateKey].count += 1;
                      taxBreakdown[rateKey].taxAmount += taxAmount;
                    });
                    
                    return Object.entries(taxBreakdown)
                      .sort(([keyA], [keyB]) => {
                        const rateA = parseFloat(keyA.split('-')[0]);
                        const rateB = parseFloat(keyB.split('-')[0]);
                        return rateB - rateA;
                      })
                      .map(([key, data]) => {
                        const rate = key.split('-')[0];
                        const methodLabel = data.method === 'exclusive' ? 'Exclusive' : 'Inclusive';
                        return (
                          <div key={key} className="flex items-start justify-between gap-3 text-sm">
                            <div className="min-w-0 text-muted-foreground">
                              <div>
                                Tax @ {parseFloat(rate).toFixed(2)}% ({data.count} item{data.count !== 1 ? 's' : ''})
                              </div>
                              <div className="text-xs text-muted-foreground/70 ml-2">
                                {methodLabel}
                              </div>
                            </div>
                            <span className="font-medium text-blue-600 dark:text-blue-400">
                              {formatCurrency(data.taxAmount)}
                            </span>
                          </div>
                        );
                      });
                  })()}
                  
                  <div className="flex justify-between pt-2 border-t">
                    <span className="text-muted-foreground font-medium">Total VAT:</span>
                    <span className="font-bold text-blue-600 dark:text-blue-400">{formatCurrency(order.vatAmount || order.tax || 0)}</span>
                  </div>
                </div>

                <div className="border-t pt-3">
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total Amount:</span>
                    <span>{formatCurrency(order.total)}</span>
                  </div>
                </div>

              </CardContent>
            </Card>

            {/* COGS */}
            {order.cogs > 0 && (
              <div className="bg-muted p-3 rounded-md">
                <p className="text-sm text-muted-foreground">Cost of Goods Sold (COGS)</p>
                <p className="font-semibold">{formatCurrency(order.cogs)}</p>
              </div>
            )}

            {/* MRA EIS Status */}
            {eisStatusDisplay && (
              <div className="bg-blue-500/10 dark:bg-blue-500/20 p-3 rounded-md border border-blue-500/30">
                <p className="text-sm text-muted-foreground">MRA EIS Status</p>
                <p className="font-semibold capitalize text-blue-700 dark:text-blue-300">{eisStatusDisplay}</p>
                {order.fiscalInvoiceNumber && (
                  <p className="text-xs text-muted-foreground mt-1">Fiscal Invoice: {order.fiscalInvoiceNumber}</p>
                )}
                {eisStatusDisplay === 'PENDING' && (
                  <p className="text-xs text-blue-700/80 dark:text-blue-300 mt-1">
                    Pending sync to EIS. Will auto-submit when connectivity is restored.
                  </p>
                )}
              </div>
            )}

            {/* Void Transaction Details */}
            {isVoided && (
              <Card className="border-destructive/30 bg-destructive/5">
                <CardHeader>
                  <CardTitle className="text-base text-destructive">Void Transaction Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {loadingVoid ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      <span className="text-sm text-muted-foreground">Loading void details...</span>
                    </div>
                  ) : voidTransaction ? (
                    <>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Void Number</p>
                          <p className="font-semibold text-destructive">{voidTransaction.void_number}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Void Reason</p>
                          <p className="font-semibold text-destructive capitalize">{voidTransaction.void_reason.replace(/_/g, ' ')}</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-xs text-muted-foreground">Reason Description</p>
                        <p className="text-sm text-destructive">{voidTransaction.reason_description}</p>
                      </div>

                      <div className="border-t border-destructive/30 pt-3 space-y-2">
                        <div className="flex justify-between">
                          <span className="text-xs text-muted-foreground">Voided Amount:</span>
                          <span className="font-medium text-destructive">{formatCurrency(voidTransaction.voided_amount)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-xs text-muted-foreground">Voided VAT:</span>
                          <span className="font-medium text-destructive">{formatCurrency(voidTransaction.voided_vat)}</span>
                        </div>
                      </div>

                      <div className="border-t border-destructive/30 pt-3 space-y-2">
                        <div className="flex justify-between">
                          <span className="text-xs text-muted-foreground">Refund Method:</span>
                          <span className="font-medium text-destructive capitalize">{voidTransaction.refund_method}</span>
                        </div>
                        {voidTransaction.refund_amount > 0 && (
                          <div className="flex justify-between">
                            <span className="text-xs text-muted-foreground">Refund Amount:</span>
                            <span className="font-medium text-destructive">{formatCurrency(voidTransaction.refund_amount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-xs text-muted-foreground">Refund Processed:</span>
                          <span className="font-medium text-destructive">{voidTransaction.refund_processed ? 'Yes' : 'No'}</span>
                        </div>
                      </div>

                      <div className="border-t border-destructive/30 pt-3 space-y-1">
                        <p className="text-xs text-muted-foreground">Voided By: {voidTransaction.created_by_name || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">Voided At: {format(new Date(voidTransaction.created_at), 'PPpp')}</p>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">No void transaction details found</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Hidden Receipt for Printing */}
      <div className="hidden">
        <Receipt 
          order={order} 
          business={businessSettings} 
          currencyFormatter={formatCurrency}
          paperWidth={receiptPaperWidth}
          showHeader={receiptDisplaySettings.showHeader}
          showFooter={receiptDisplaySettings.showFooter}
          showQRCode={receiptDisplaySettings.showQRCode}
          showItemDetails={receiptDisplaySettings.showItemDetails}
          showTaxBreakdown={receiptDisplaySettings.showTaxBreakdown}
          receiptFontSize={receiptDisplaySettings.receiptFontSize}
          receiptFontWeight={receiptDisplaySettings.receiptFontWeight}
          receiptLineHeight={receiptDisplaySettings.receiptLineHeight}
          receiptPaddingX={receiptDisplaySettings.receiptPaddingX}
          receiptBusinessNameFontSize={receiptDisplaySettings.receiptBusinessNameFontSize}
          receiptBusinessNameFontWeight={receiptDisplaySettings.receiptBusinessNameFontWeight}
          receiptBusinessNameScaleX={receiptDisplaySettings.receiptBusinessNameScaleX}
          receiptHeaderDetailScaleX={receiptDisplaySettings.receiptHeaderDetailScaleX}
          receiptLegalMarkerFontSize={receiptDisplaySettings.receiptLegalMarkerFontSize}
          receiptLegalMarkerFontWeight={receiptDisplaySettings.receiptLegalMarkerFontWeight}
          receiptLegalMarkerScaleX={receiptDisplaySettings.receiptLegalMarkerScaleX}
          receiptQrCodeSize={receiptDisplaySettings.receiptQrCodeSize}
          copyNumber={receiptCopyNumber}
        />
      </div>

      <VoidModal
        order={order}
        isOpen={voidOpen}
        onOpenChange={setVoidOpen}
        canVoid={isAdminUser}
        onVoidCreated={(updatedOrder) => {
          // Update the order with the new status from the response
          if (order && updatedOrder) {
            Object.assign(order, updatedOrder);
          }
          setVoidOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
