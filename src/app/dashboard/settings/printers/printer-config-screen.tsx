'use client';

import React, { useState, useEffect } from 'react';
import { Printer, Plus, Minus, Trash2, Check, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Receipt2 as ReceiptPreview } from '@/components/pos/receipt2';
import type { Business, Order } from '@/lib/db';
import {
  DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
  DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
  DEFAULT_RECEIPT_FONT_WEIGHT,
  DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT,
  DEFAULT_RECEIPT_LINE_HEIGHT,
  RECEIPT_FONT_WEIGHT_OPTIONS,
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
  printerService,
  type PrinterConfig,
  type PrinterSettings,
} from '@/lib/services/printer-service';
import { printerDiscoveryService, type DiscoveredPrinter } from '@/lib/services/printer-discovery-service';
import { unifiedPrintingService } from '@/lib/services/unified-printing-service';

const forcePrintFlagsOn = (value: PrinterSettings): PrinterSettings => ({
  ...value,
  autoprint: true,
  printHeader: true,
  printFooter: true,
  printQRCode: true,
  printItemDetails: true,
  printTaxBreakdown: true,
});

const areForcedFlagsOn = (value: PrinterSettings): boolean => (
  value.autoprint &&
  value.printHeader &&
  value.printFooter &&
  value.printQRCode &&
  value.printItemDetails &&
  value.printTaxBreakdown
);

const RECEIPT_PREVIEW_BUSINESS: Business = {
  id: 'receipt-preview-business',
  name: 'Mkisi Enterprise',
  type: 'Retail',
  currency: 'MWK',
  tin: '30253908',
  email: 'catherinemkisi@gmail.com',
  phone: '0999022015',
};

const RECEIPT_PREVIEW_ORDER = {
  id: 'receipt-settings-preview-order',
  orderNumber: 1001,
  branchId: 'main',
  items: [
    {
      id: 'preview-squash-orange',
      name: 'SQUASH ORANGE',
      quantity: 1,
      price: 62800,
      subtotal: 53446.81,
      tax_amount: 9353.19,
      total: 62800,
      tax_rate: 17.5,
      tax_type: 'standard',
      tax_calculation_method: 'inclusive',
      vat_category: 'A',
    },
  ],
  status: 'Completed',
  subtotal: 53446.81,
  tax: 9353.19,
  vat_amount: 9353.19,
  net_amount: 53446.81,
  gross_amount: 62800,
  total: 62800,
  amountTendered: 62800,
  change: 0,
  paymentMethod: 'Cash',
  customerName: 'thocco mvola',
  localReceiptNumber: 'CrL-D-JY3f-F',
  receiptNumber: 'CrL-D-JY3f-F',
  cogs: 0,
  createdAt: '2026-04-20T16:03:00+02:00',
  updatedAt: '2026-04-20T16:03:00+02:00',
} as Order;

const formatPreviewCurrency = (amount: number): string => (
  Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
);

const getReceiptWeightLabel = (weight: number): string => {
  if (weight === 400) return 'Normal';
  if (weight === 500) return 'Medium';
  if (weight === 600) return 'Semi Bold';
  return 'Bold';
};

type NumberAdjustmentProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultHint?: React.ReactNode;
  onValueChange: (value: unknown) => void;
};

function NumberAdjustment({
  id,
  label,
  value,
  min,
  max,
  step,
  defaultHint,
  onValueChange,
}: NumberAdjustmentProps) {
  const decimals = Math.max(0, String(step).split('.')[1]?.length || 0);
  const clamp = (nextValue: number) => Math.min(max, Math.max(min, nextValue));
  const nudge = (direction: -1 | 1) => {
    const nextValue = Number(clamp(Number(value || 0) + direction * step).toFixed(decimals));
    onValueChange(nextValue);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-10 w-10"
          onClick={() => nudge(-1)}
          aria-label={`Decrease ${label}`}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Input
          id={id}
          type="number"
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="h-10 text-center"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-10 w-10"
          onClick={() => nudge(1)}
          aria-label={`Increase ${label}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {defaultHint ? <p className="text-xs text-muted-foreground">{defaultHint}</p> : null}
    </div>
  );
}

export function PrinterConfigScreen() {
  const { toast } = useToast();
  const isWindows =
    typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('windows');
  const isAndroidTauri =
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-tauri-android') === 'true';
  const [printers, setPrinters] = useState<PrinterConfig[]>([]);
  const [settings, setSettings] = useState<PrinterSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddingPrinter, setIsAddingPrinter] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [discoveredPrinters, setDiscoveredPrinters] = useState<DiscoveredPrinter[]>([]);

  const branchId = localStorage.getItem('handypos-active-branch') || 'main';

  // Load printers and settings
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const [printersList, printerSettings] = await Promise.all([
          printerService.getPrinterConfigs(branchId),
          printerService.getPrinterSettings(branchId),
        ]);
        setPrinters(printersList);
        const normalizedSettings = forcePrintFlagsOn(printerSettings);
        setSettings(normalizedSettings);
        if (!areForcedFlagsOn(printerSettings)) {
          try {
            await printerService.savePrinterSettings(normalizedSettings);
          } catch (error) {
            console.warn('Failed to enforce default print settings:', error);
          }
        }
      } catch (error) {
        console.error('Error loading printer data:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load printer configuration',
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [branchId, toast]);

  const handleDeletePrinter = async (printerId: string) => {
    try {
      await printerService.deletePrinterConfig(printerId, branchId);
      setPrinters(printers.filter(p => p.id !== printerId));

      toast({
        title: 'Success',
        description: 'Printer deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting printer:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete printer',
      });
    }
  };

  const handleSetDefault = async (printerId: string) => {
    try {
      const updatedPrinters = printers.map(p => ({
        ...p,
        isDefault: p.id === printerId,
      }));

      for (const printer of updatedPrinters) {
        await printerService.savePrinterConfig(printer);
      }

      setPrinters(updatedPrinters);

      toast({
        title: 'Success',
        description: 'Default printer updated',
      });
    } catch (error) {
      console.error('Error setting default printer:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to set default printer',
      });
    }
  };

  const handleTogglePrinter = async (printerId: string, isEnabled: boolean) => {
    try {
      const printer = printers.find(p => p.id === printerId);
      if (!printer) return;

      const updated = { ...printer, isEnabled };
      await printerService.savePrinterConfig(updated);

      setPrinters(printers.map(p => (p.id === printerId ? updated : p)));

      toast({
        title: 'Success',
        description: `Printer ${isEnabled ? 'enabled' : 'disabled'}`,
      });
    } catch (error) {
      console.error('Error toggling printer:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update printer',
      });
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      const normalizedSettings = forcePrintFlagsOn(settings);
      setSettings(normalizedSettings);
      await printerService.savePrinterSettings(normalizedSettings);

      toast({
        title: 'Success',
        description: 'Printer settings saved successfully',
      });
    } catch (error) {
      console.error('Error saving settings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save printer settings',
      });
    }
  };

  const resetReceiptTypography = () => {
    if (!settings) return;

    setSettings({
      ...settings,
      receiptFontSize: getDefaultReceiptFontSize(settings.receiptPaperWidth),
      receiptFontWeight: DEFAULT_RECEIPT_FONT_WEIGHT,
      receiptLineHeight: DEFAULT_RECEIPT_LINE_HEIGHT,
      receiptPaddingX: getDefaultReceiptPaddingX(settings.receiptPaperWidth),
      receiptBusinessNameFontSize: getDefaultReceiptBusinessNameFontSize(settings.receiptPaperWidth),
      receiptBusinessNameFontWeight: DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
      receiptBusinessNameScaleX: DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
      receiptHeaderDetailScaleX: DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
      receiptLegalMarkerFontSize: getDefaultReceiptLegalMarkerFontSize(settings.receiptPaperWidth),
      receiptLegalMarkerFontWeight: DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT,
      receiptLegalMarkerScaleX: DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
      receiptQrCodeSize: getDefaultReceiptQRCodeSize(settings.receiptPaperWidth),
    });
  };

  const handleTestPrinter = async (printer: PrinterConfig) => {
    try {
      setTestingPrinterId(printer.id);
      const result = await unifiedPrintingService.testPrint(printer);

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Test Failed',
          description: result.message,
        });
      }
    } catch (error) {
      console.error('Error running test print:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to run test print',
      });
    } finally {
      setTestingPrinterId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">Loading printer configuration...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-2 sm:space-y-6">
      {/* Printers List */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Printer className="h-5 w-5" />
                Configured Printers
              </CardTitle>
              <CardDescription>
                Manage receipt printers for your POS system
              </CardDescription>
            </div>
            <Dialog open={isAddingPrinter} onOpenChange={setIsAddingPrinter}>
              <DialogTrigger asChild>
                <Button className="w-full sm:w-auto">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Printer
                </Button>
              </DialogTrigger>
              <DialogContent className="tauri-android-safe-bottom max-h-[calc(100dvh-1rem)] w-[calc(100vw-0.75rem)] max-w-md overflow-y-auto p-4 sm:w-[calc(100vw-2rem)] sm:p-6">
                <DialogHeader>
                  <DialogTitle>Add Printer</DialogTitle>
                  <DialogDescription>
                    Scan for available printers or add manually
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Button
                      onClick={async () => {
                        try {
                          setIsScanning(true);
                          const discovered = await printerDiscoveryService.scanPrinters();
                          setDiscoveredPrinters(discovered);
                          
                          if (discovered.length === 0) {
                            toast({
                              title: 'No Printers Found',
                              description: 'Make sure your printer is connected and powered on.',
                            });
                          } else {
                            toast({
                              title: 'Success',
                              description: `Found ${discovered.length} printer(s)`,
                            });
                          }
                        } catch (error) {
                          console.error('Error scanning printers:', error);
                          const message = error instanceof Error ? error.message : 'Failed to scan for printers';
                          const lowerMessage = message.toLowerCase();
                          const isPermissionPrompt =
                            lowerMessage.includes('permission requested') ||
                            lowerMessage.includes('allow nearby devices permission');
                          toast({
                            variant: isPermissionPrompt ? undefined : 'destructive',
                            title: isPermissionPrompt ? 'Permission Requested' : 'Scan Failed',
                            description: message,
                          });
                        } finally {
                          setIsScanning(false);
                        }
                      }}
                      disabled={isScanning}
                      className="w-full"
                    >
                      {isScanning ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Scanning...
                        </>
                      ) : (
                        <>
                          <Search className="mr-2 h-4 w-4" />
                          Scan for Printers
                        </>
                      )}
                    </Button>
                  </div>

                  
                  {discoveredPrinters.length > 0 && (
                    <div className="space-y-2">
                      <Label>Available Printers</Label>
                      <div className="max-h-[45dvh] space-y-2 overflow-y-auto pr-1">
                        {discoveredPrinters.map((printer) => (
                          <div
                            key={printer.id}
                            className="flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted"
                            onClick={async () => {
                              try {
                                const configId = printer.id?.trim() || `manual-${Date.now()}`;
                                const alreadyExists = printers.some((p) => p.id === configId);
                                if (alreadyExists) {
                                  toast({
                                    title: 'Already Added',
                                    description: `${printer.name} is already configured`,
                                  });
                                  return;
                                }

                                const newPrinter: PrinterConfig = {
                                  id: configId,
                                  branchId,
                                  name: printer.name,
                                  type: printer.type === 'bluetooth' ? 'thermal_bluetooth' : 'thermal',
                                  paperWidth: '80mm',
                                  connectionType:
                                    printer.type === 'bluetooth'
                                      ? 'bluetooth'
                                      : printer.type === 'network'
                                      ? 'network'
                                      : 'usb',
                                  bluetoothDeviceId: printer.type === 'bluetooth' ? configId : undefined,
                                  bluetoothDeviceName: printer.type === 'bluetooth' ? printer.name : undefined,
                                  isDefault: printers.length === 0,
                                  isEnabled: true,
                                  autoprint: true,
                                  printCopies: 1,
                                  createdAt: new Date().toISOString(),
                                  updatedAt: new Date().toISOString(),
                                };

                                await printerService.savePrinterConfig(newPrinter);
                                setPrinters([...printers, newPrinter]);

                                toast({
                                  title: 'Success',
                                  description: `${printer.name} added successfully`,
                                });

                                setIsAddingPrinter(false);
                                setDiscoveredPrinters([]);
                              } catch (error) {
                                console.error('Error adding printer:', error);
                                toast({
                                  variant: 'destructive',
                                  title: 'Error',
                                  description: 'Failed to add printer',
                                });
                              }
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{printer.name}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                                  {printer.type}
                                </span>
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  printer.status === 'ready' 
                                    ? 'bg-green-100 text-green-800' 
                                    : printer.status === 'offline'
                                    ? 'bg-red-100 text-red-800'
                                    : 'bg-yellow-100 text-yellow-800'
                                }`}>
                                  {printer.status}
                                </span>
                              </div>
                            </div>
                            <Check className="h-5 w-5 flex-shrink-0 text-green-600" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {discoveredPrinters.length === 0 && !isScanning && (
                    <div className="space-y-4">
                          <div className="py-6 text-center text-muted-foreground sm:py-8">
                            <Printer className="mx-auto mb-2 h-10 w-10 opacity-50 sm:h-12 sm:w-12" />
                        <p className="text-sm">
                          {isAndroidTauri
                            ? 'Click "Scan for Printers" to find paired Bluetooth printers.'
                            : 'Click "Scan for Printers" to find available devices.'}
                        </p>
                        {isAndroidTauri ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Pair the printer in Android Bluetooth settings first, then scan here.
                          </p>
                        ) : null}
                      </div>
                      
                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <span className="w-full border-t border-gray-300" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white px-2 text-gray-500">Or</span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="manual-printer-name">Add Printer Manually</Label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            id="manual-printer-name"
                            placeholder="Enter printer name (e.g., Epson TM-T20)"
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                const name = (e.target as HTMLInputElement).value.trim();
                                if (name) {
                                  const manualId = isWindows ? `win:${name}` : `manual-${Date.now()}`;
                                  const manualPrinter: DiscoveredPrinter = {
                                    id: manualId,
                                    name,
                                    type: 'unknown',
                                    status: 'ready',
                                    isDefault: false,
                                    description: `Manual entry: ${name}`,
                                  };
                                  setDiscoveredPrinters([manualPrinter]);
                                  (e.target as HTMLInputElement).value = '';
                                }
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            className="w-full sm:w-auto"
                            onClick={(e) => {
                              const input = (e.currentTarget.parentElement?.querySelector('#manual-printer-name') as HTMLInputElement);
                              const name = input?.value.trim();
                              if (name) {
                                const manualId = isWindows ? `win:${name}` : `manual-${Date.now()}`;
                                const manualPrinter: DiscoveredPrinter = {
                                  id: manualId,
                                  name,
                                  type: 'unknown',
                                  status: 'ready',
                                  isDefault: false,
                                  description: `Manual entry: ${name}`,
                                };
                                setDiscoveredPrinters([manualPrinter]);
                                input.value = '';
                              }
                            }}
                          >
                            Add
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Enter your printer name and press Enter or click Add
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                <DialogFooter className="gap-2 sm:gap-0">
                  <Button variant="outline" onClick={() => {
                    setIsAddingPrinter(false);
                    setDiscoveredPrinters([]);
                  }}>
                    Close
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {printers.length === 0 ? (
            <div className="text-center py-8">
              <Printer className="h-12 w-12 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-muted-foreground">No printers configured yet</p>
              <p className="text-sm text-muted-foreground">Add a printer to enable receipt printing</p>
            </div>
          ) : (
            <div className="space-y-3">
              {printers.map((printer) => (
                <div
                  key={printer.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{printer.name}</h3>
                      {printer.isDefault && (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          Default
                        </span>
                      )}
                      {!printer.isEnabled && (
                        <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {printer.type.charAt(0).toUpperCase() + printer.type.slice(1)} • {printer.paperWidth}
                    </p>
                  </div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:flex sm:justify-end">
                    <Switch
                      checked={printer.isEnabled}
                      onCheckedChange={(checked) =>
                        handleTogglePrinter(printer.id, checked)
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-w-0 flex-1 sm:flex-none"
                      disabled={!printer.isEnabled || testingPrinterId === printer.id}
                      onClick={() => handleTestPrinter(printer)}
                    >
                      {testingPrinterId === printer.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        'Test Printer'
                      )}
                    </Button>
                    {!printer.isDefault && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-w-0 flex-1 sm:flex-none"
                        onClick={() => handleSetDefault(printer.id)}
                      >
                        Set Default
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="justify-self-end text-destructive hover:text-destructive sm:justify-self-auto"
                      onClick={() => handleDeletePrinter(printer.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Print Settings */}
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>Print Settings</CardTitle>
            <CardDescription>
              Configure default printing behavior for receipts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 px-3 sm:space-y-6 sm:px-6">
            <div className="space-y-4">
              <div className="border-t pt-4">
                <Label htmlFor="receipt-format">Receipt Format</Label>
                <Select
                  value={settings.receiptPaperWidth}
                  onValueChange={(value) => {
                    const nextPaperWidth = value === '58mm' ? '58mm' : '80mm';
                    setSettings({
                      ...settings,
                      receiptPaperWidth: nextPaperWidth,
                      receiptFontSize:
                        settings.receiptFontSize === getDefaultReceiptFontSize(settings.receiptPaperWidth)
                          ? getDefaultReceiptFontSize(nextPaperWidth)
                          : settings.receiptFontSize,
                      receiptPaddingX:
                        settings.receiptPaddingX === getDefaultReceiptPaddingX(settings.receiptPaperWidth)
                          ? getDefaultReceiptPaddingX(nextPaperWidth)
                          : settings.receiptPaddingX,
                      receiptBusinessNameFontSize:
                        settings.receiptBusinessNameFontSize === getDefaultReceiptBusinessNameFontSize(settings.receiptPaperWidth)
                          ? getDefaultReceiptBusinessNameFontSize(nextPaperWidth)
                          : settings.receiptBusinessNameFontSize,
                      receiptLegalMarkerFontSize:
                        settings.receiptLegalMarkerFontSize === getDefaultReceiptLegalMarkerFontSize(settings.receiptPaperWidth)
                          ? getDefaultReceiptLegalMarkerFontSize(nextPaperWidth)
                          : settings.receiptLegalMarkerFontSize,
                      receiptQrCodeSize:
                        settings.receiptQrCodeSize === getDefaultReceiptQRCodeSize(settings.receiptPaperWidth)
                          ? getDefaultReceiptQRCodeSize(nextPaperWidth)
                          : settings.receiptQrCodeSize,
                    })
                  }}
                >
                  <SelectTrigger id="receipt-format" className="mt-2 w-full sm:max-w-xs">
                    <SelectValue placeholder="Select receipt width" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="80mm">80mm (Standard)</SelectItem>
                    <SelectItem value="58mm">58mm (Compact)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground mt-1">
                  Controls receipt layout width. 58mm works on 80mm printers with side margins.
                </p>
              </div>

              <div className="border-t pt-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
	                  <div>
	                    <Label>Receipt Text</Label>
	                    <p className="text-sm text-muted-foreground mt-1">
	                      Adjust each receipt text area separately.
	                    </p>
	                  </div>
                  <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={resetReceiptTypography}>
                    Reset Defaults
                  </Button>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2">
                    <NumberAdjustment
                      id="receipt-font-size"
                      label="Font Size"
                      min={8}
                      max={18}
                      step={1}
                      value={settings.receiptFontSize}
                      onValueChange={(value) =>
                        setSettings({
                          ...settings,
                          receiptFontSize: normalizeReceiptFontSize(
                            value,
                            settings.receiptPaperWidth
                          ),
                        })
                      }
                      defaultHint={`Default: ${getDefaultReceiptFontSize(settings.receiptPaperWidth)}px`}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="receipt-font-weight">Boldness</Label>
                    <Select
                      value={String(settings.receiptFontWeight)}
                      onValueChange={(value) =>
                        setSettings({
                          ...settings,
                          receiptFontWeight: normalizeReceiptFontWeight(value),
                        })
                      }
                    >
                      <SelectTrigger id="receipt-font-weight">
                        <SelectValue placeholder="Select boldness" />
                      </SelectTrigger>
                      <SelectContent>
                        {RECEIPT_FONT_WEIGHT_OPTIONS.map((weight) => (
	                          <SelectItem key={weight} value={String(weight)}>
	                            {getReceiptWeightLabel(weight)} ({weight})
	                          </SelectItem>
	                        ))}
	                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Default: Medium (500)</p>
                  </div>

                  <div className="space-y-2">
                    <NumberAdjustment
                      id="receipt-line-height"
                      label="Word Height"
                      min={1.05}
                      max={1.6}
                      step={0.01}
                      value={settings.receiptLineHeight}
                      onValueChange={(value) =>
                        setSettings({
                          ...settings,
                          receiptLineHeight: normalizeReceiptLineHeight(value),
                        })
                      }
                      defaultHint={`Default: ${DEFAULT_RECEIPT_LINE_HEIGHT}`}
                    />
                  </div>

                  <div className="space-y-2">
                    <NumberAdjustment
                      id="receipt-padding-x"
                      label="Padding X"
                      min={6}
                      max={32}
                      step={1}
                      value={settings.receiptPaddingX}
                      onValueChange={(value) =>
                        setSettings({
                          ...settings,
                          receiptPaddingX: normalizeReceiptPaddingX(
                            value,
                            settings.receiptPaperWidth
                          ),
                        })
                      }
                      defaultHint={`Default: ${getDefaultReceiptPaddingX(settings.receiptPaperWidth)}px`}
                    />
		                  </div>
		                </div>

                    <div className="mt-5 border-t pt-4">
                      <Label>Header Details</Label>
                      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="space-y-2">
                          <NumberAdjustment
                            id="receipt-header-detail-scale"
                            label="Width Stretch"
                            min={0.75}
                            max={1.8}
                            step={0.01}
                            value={settings.receiptHeaderDetailScaleX}
                            onValueChange={(value) =>
                              setSettings({
                                ...settings,
                                receiptHeaderDetailScaleX: normalizeReceiptTextScaleX(
                                  value,
                                  DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
                                ),
                              })
                            }
                            defaultHint={`Default: ${DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X}`}
                          />
                        </div>
                      </div>
                    </div>

	                <div className="mt-5 border-t pt-4">
	                  <Label>Business Name</Label>
	                  <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
	                    <div className="space-y-2">
	                      <NumberAdjustment
	                        id="receipt-business-font-size"
	                        label="Font Size"
	                        min={10}
	                        max={28}
	                        step={1}
	                        value={settings.receiptBusinessNameFontSize}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptBusinessNameFontSize: normalizeReceiptBusinessNameFontSize(
	                              value,
	                              settings.receiptPaperWidth
	                            ),
	                          })
	                        }
	                        defaultHint={`Default: ${getDefaultReceiptBusinessNameFontSize(settings.receiptPaperWidth)}px`}
	                      />
	                    </div>

	                    <div className="space-y-2">
	                      <NumberAdjustment
	                        id="receipt-business-scale"
	                        label="Width Stretch"
	                        min={0.75}
	                        max={1.8}
	                        step={0.01}
	                        value={settings.receiptBusinessNameScaleX}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptBusinessNameScaleX: normalizeReceiptTextScaleX(
	                              value,
	                              DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
	                            ),
	                          })
	                        }
	                        defaultHint={`Default: ${DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X}`}
	                      />
	                    </div>

	                    <div className="space-y-2">
	                      <Label htmlFor="receipt-business-weight">Boldness</Label>
	                      <Select
	                        value={String(settings.receiptBusinessNameFontWeight)}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptBusinessNameFontWeight: normalizeReceiptFontWeight(value),
	                          })
	                        }
	                      >
	                        <SelectTrigger id="receipt-business-weight">
	                          <SelectValue placeholder="Select boldness" />
	                        </SelectTrigger>
	                        <SelectContent>
	                          {RECEIPT_FONT_WEIGHT_OPTIONS.map((weight) => (
	                            <SelectItem key={weight} value={String(weight)}>
	                              {getReceiptWeightLabel(weight)} ({weight})
	                            </SelectItem>
	                          ))}
	                        </SelectContent>
	                      </Select>
	                      <p className="text-xs text-muted-foreground">Default: {getReceiptWeightLabel(DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT)} ({DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT})</p>
	                    </div>
	                  </div>
	                </div>

	                <div className="mt-5 border-t pt-4">
	                  <Label>Legal Receipt Markers</Label>
	                  <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
	                    <div className="space-y-2">
	                      <NumberAdjustment
	                        id="receipt-marker-font-size"
	                        label="Font Size"
	                        min={8}
	                        max={18}
	                        step={1}
	                        value={settings.receiptLegalMarkerFontSize}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptLegalMarkerFontSize: normalizeReceiptLegalMarkerFontSize(
	                              value,
	                              settings.receiptPaperWidth
	                            ),
	                          })
	                        }
	                        defaultHint={`Default: ${getDefaultReceiptLegalMarkerFontSize(settings.receiptPaperWidth)}px`}
	                      />
	                    </div>

	                    <div className="space-y-2">
	                      <NumberAdjustment
	                        id="receipt-marker-scale"
	                        label="Width Stretch"
	                        min={0.75}
	                        max={1.8}
	                        step={0.01}
	                        value={settings.receiptLegalMarkerScaleX}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptLegalMarkerScaleX: normalizeReceiptTextScaleX(
	                              value,
	                              DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X
	                            ),
	                          })
	                        }
	                        defaultHint={`Default: ${DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X}`}
	                      />
	                    </div>

	                    <div className="space-y-2">
	                      <Label htmlFor="receipt-marker-weight">Boldness</Label>
	                      <Select
	                        value={String(settings.receiptLegalMarkerFontWeight)}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptLegalMarkerFontWeight: normalizeReceiptFontWeight(value),
	                          })
	                        }
	                      >
	                        <SelectTrigger id="receipt-marker-weight">
	                          <SelectValue placeholder="Select boldness" />
	                        </SelectTrigger>
	                        <SelectContent>
	                          {RECEIPT_FONT_WEIGHT_OPTIONS.map((weight) => (
	                            <SelectItem key={weight} value={String(weight)}>
	                              {getReceiptWeightLabel(weight)} ({weight})
	                            </SelectItem>
	                          ))}
	                        </SelectContent>
	                      </Select>
	                      <p className="text-xs text-muted-foreground">Default: {getReceiptWeightLabel(DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT)} ({DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT})</p>
	                    </div>
	                  </div>
	                </div>

	                <div className="mt-5 border-t pt-4">
	                  <Label>QR Code</Label>
	                  <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
	                    <div className="space-y-2">
	                      <NumberAdjustment
	                        id="receipt-qr-size"
	                        label="Size"
	                        min={48}
	                        max={140}
	                        step={2}
	                        value={settings.receiptQrCodeSize}
	                        onValueChange={(value) =>
	                          setSettings({
	                            ...settings,
	                            receiptQrCodeSize: normalizeReceiptQRCodeSize(
	                              value,
	                              settings.receiptPaperWidth
	                            ),
	                          })
	                        }
	                        defaultHint={`Default: ${getDefaultReceiptQRCodeSize(settings.receiptPaperWidth)}px`}
	                      />
	                    </div>
	                  </div>
	                </div>
	              </div>

              <div className="border-t pt-4">
                <div>
                  <Label>Receipt Preview</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Shows the current text and spacing settings before saving.
                  </p>
                </div>
                <div className="mt-4 max-w-full overflow-x-auto rounded-md border bg-muted/30 p-2 sm:p-3">
                  <ReceiptPreview
                    order={RECEIPT_PREVIEW_ORDER}
                    business={RECEIPT_PREVIEW_BUSINESS}
                    currencyFormatter={formatPreviewCurrency}
                    paperWidth={settings.receiptPaperWidth}
                    receiptFontSize={settings.receiptFontSize}
	                    receiptFontWeight={settings.receiptFontWeight}
	                    receiptLineHeight={settings.receiptLineHeight}
	                    receiptPaddingX={settings.receiptPaddingX}
	                    receiptBusinessNameFontSize={settings.receiptBusinessNameFontSize}
	                    receiptBusinessNameFontWeight={settings.receiptBusinessNameFontWeight}
	                    receiptBusinessNameScaleX={settings.receiptBusinessNameScaleX}
	                    receiptHeaderDetailScaleX={settings.receiptHeaderDetailScaleX}
	                    receiptLegalMarkerFontSize={settings.receiptLegalMarkerFontSize}
	                    receiptLegalMarkerFontWeight={settings.receiptLegalMarkerFontWeight}
	                    receiptLegalMarkerScaleX={settings.receiptLegalMarkerScaleX}
	                    receiptQrCodeSize={settings.receiptQrCodeSize}
	                    rootId="receipt-settings-preview-area"
	                  />
                </div>
              </div>

              <div className="border-t pt-4">
                <div className="w-full sm:max-w-xs">
                  <NumberAdjustment
                  id="print-copies"
                  label="Number of Copies"
                  min={1}
                  max={5}
                  step={1}
                  value={settings.printCopies}
                  onValueChange={(value) =>
                    setSettings({
                      ...settings,
                      printCopies: Math.max(1, parseInt(String(value), 10) || 1),
                    })
                  }
                />
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Number of receipt copies to print per sale
                </p>
              </div>
            </div>

            <Button onClick={handleSaveSettings} className="w-full">
              Save Settings
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
