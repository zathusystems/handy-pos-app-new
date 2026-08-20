

'use client';

import React, { useState, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Search,
  Printer,
  FileUp,
  Send,
  Upload,
  Download,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import Papa from 'papaparse';

import { db, type InventoryItem, type StockTake } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { downloadTextFile } from '@/lib/file-download';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  formatInventoryQuantity,
  formatQuantityWithUnit,
  getPortionQuantityDisplay,
} from '@/lib/quantity-format';

const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch'
};

const STOCK_AUDIT_CSV_ALIASES = {
  itemId: ['item_id', 'item id', 'inventory_item_id', 'inventory item id', 'id'],
  name: ['product_name', 'product name', 'name', 'item_name', 'item name'],
  barcode: ['barcode'],
  sku: ['sku'],
  productCode: ['product_code', 'product code', 'code'],
  countedQuantity: ['quantity', 'qty', 'counted_quantity', 'counted quantity', 'counted_stock', 'counted stock', 'counted', 'counted_qty'],
  countedFullUnits: ['counted_full_units', 'counted full units', 'full_units', 'full units', 'units'],
  countedPortions: ['counted_portions', 'counted portions', 'portions'],
};

type CsvAuditRow = Record<string, unknown>;

type CsvImportSummary = {
  filename: string;
  appliedCount: number;
  missingQuantityCount: number;
  unmatchedRows: string[];
};

type CsvImportProgressState = {
  active: boolean;
  value: number;
  label: string;
};

type StockTakeFormValues = {
  items: (InventoryItem & { countedStock: number | string })[];
};

type StockAuditItem = InventoryItem & { countedStock: number | string };

const normalizeCsvHeader = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const getCsvValue = (row: CsvAuditRow, aliases: string[]): unknown => {
  const rowEntries = Object.entries(row);
  const aliasSet = new Set(aliases.map((alias) => normalizeCsvHeader(alias)));

  for (const [key, value] of rowEntries) {
    if (aliasSet.has(normalizeCsvHeader(key))) {
      return value;
    }
  }

  return undefined;
};

const parseCsvQuantity = (value: unknown): number | null => {
  const normalized = String(value ?? '').trim().replace(/,/g, '');
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeLookupValue = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const waitForUiFrame = () =>
  new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });

const isPortionedStockItem = (
  item: Pick<InventoryItem, 'isSoldInPortions' | 'portionsPerUnit'>
): boolean => {
  const portionsPerUnit = Number(item.portionsPerUnit);
  return Boolean(item.isSoldInPortions && Number.isFinite(portionsPerUnit) && portionsPerUnit > 0);
};

const getStockQuantitySummary = (
  item: Pick<InventoryItem, 'isSoldInPortions' | 'portionsPerUnit' | 'portionName' | 'unitType'>,
  quantity: unknown
): string => {
  if (isPortionedStockItem(item)) {
    const portionDisplay = getPortionQuantityDisplay({
      quantity,
      unitLabel: item.unitType || 'unit',
      portionName: item.portionName || 'portion',
      portionsPerUnit: item.portionsPerUnit,
    });

    if (portionDisplay) {
      return portionDisplay.summaryText;
    }
  }

  return formatQuantityWithUnit(quantity, item.unitType || 'unit');
};

const getStockDifferenceSummary = (item: StockAuditItem, difference: number): string => {
  if (Math.abs(difference) < 0.0005) {
    return 'No Change';
  }

  const sign = difference > 0 ? '+' : '-';
  return `${sign}${getStockQuantitySummary(item, Math.abs(difference))}`;
};

const getPortionInputParts = (item: StockAuditItem) => {
  const quantity = Number(item.countedStock) || 0;
  const portionDisplay = getPortionQuantityDisplay({
    quantity,
    unitLabel: item.unitType || 'unit',
    portionName: item.portionName || 'portion',
    portionsPerUnit: item.portionsPerUnit,
  });

  return {
    wholeUnits: portionDisplay?.wholeUnits ?? 0,
    remainingPortions: portionDisplay?.remainingPortions ?? 0,
  };
};

export default function StockAuditPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useAuth();
  const { format: formatCurrency } = useCurrency();
  const isMobile = useIsMobile();
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [csvImportSummary, setCsvImportSummary] = useState<CsvImportSummary | null>(null);
  const [csvImportProgress, setCsvImportProgress] = useState<CsvImportProgressState>({
    active: false,
    value: 0,
    label: '',
  });
  const csvFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) {
      setActiveBranchId(branchId);
    }
  }, []);

  const inventoryItems = useLiveQuery(
    () => {
        if (!activeBranchId) return [];
        return db.inventory.where('branchId').equals(activeBranchId).toArray().then(items => 
          items.filter(item => !item.isProduced)
        )
    },
    [activeBranchId]
  );

  const form = useForm<StockTakeFormValues>();
  const { control, handleSubmit, setValue } = form;

  const { fields, replace } = useFieldArray({
    control,
    name: 'items',
    keyName: 'formId',
  });
  const watchedItems = useWatch({
    control,
    name: 'items',
  }) || [];

  useEffect(() => {
    if (inventoryItems) {
      const formattedItems = inventoryItems.map((item) => ({
        ...item,
        countedStock: item.stockUnits ?? '', // Pre-fill with system stock
      }));
      replace(formattedItems);
    }
  }, [inventoryItems, replace]);

  const deferredSearchTerm = useDeferredValue(searchTerm);

  const editableItems = useMemo(
    () =>
      fields.map((field, index) => {
        const watchedItem = watchedItems[index];
        return watchedItem ? { ...field, ...watchedItem } : field;
      }),
    [fields, watchedItems]
  );

  const displayedItems = useMemo(() => {
    const normalizedSearch = deferredSearchTerm.trim().toLowerCase();

    return editableItems
      .map((item, index) => ({
        item,
        index,
      }))
      .filter(({ item }) => {
        if (!normalizedSearch) {
          return true;
        }

        const searchableValues = [
          item.name,
          item.category,
          item.barcode,
          item.sku,
          item.productCode,
        ];

        return searchableValues.some((value) =>
          String(value || '').toLowerCase().includes(normalizedSearch)
        );
      });
  }, [deferredSearchTerm, editableItems]);

  const { totalValue, countedValue, totalDiscrepancy } = useMemo(() => {
    if (!editableItems.length) {
      return { totalValue: 0, countedValue: 0, totalDiscrepancy: 0 };
    }

    const result = editableItems.reduce(
      (acc, item) => {
        const systemStock = Number(item.stockUnits) || 0;
        const countedStock = Number(item.countedStock) || 0;
        const cost = Number(item.cost) || 0;

        acc.totalValue += systemStock * cost;
        acc.countedValue += countedStock * cost;
        acc.totalDiscrepancy += (countedStock - systemStock) * cost;
        return acc;
      },
      { totalValue: 0, countedValue: 0, totalDiscrepancy: 0 }
    );
    return result;
  }, [editableItems]);

  const auditSummary = useMemo(() => {
    return editableItems.reduce(
      (acc, item) => {
        const systemStock = Number(item.stockUnits) || 0;
        const countedStock = Number(item.countedStock) || 0;

        if (countedStock < systemStock) {
          acc.shortages += 1;
        } else if (countedStock > systemStock) {
          acc.surplus += 1;
        }

        return acc;
      },
      { shortages: 0, surplus: 0 }
    );
  }, [editableItems]);

  const handleDownloadCsvTemplate = () => {
    if (!editableItems.length) {
      toast({
        variant: 'destructive',
        title: 'Nothing to export',
        description: 'There are no stock audit items available for this branch yet.',
      });
      return;
    }

    const rows = editableItems.map((item) => ({
      product_name: item.name,
      system_stock: getStockQuantitySummary(item, item.stockUnits),
      unit_type: item.unitType || '',
      portion_name: isPortionedStockItem(item) ? item.portionName || 'portion' : '',
      portions_per_unit: isPortionedStockItem(item) ? item.portionsPerUnit || '' : '',
      counted_full_units: '',
      counted_portions: '',
      quantity: '',
    }));

    const csv = Papa.unparse(rows);
    const filename = `stock-audit-count-sheet-${activeBranchId || 'branch'}.csv`;
    const started = downloadTextFile(csv, filename);

    if (started) {
      toast({
        title: 'CSV downloaded',
        description: 'Fill in the `quantity` column, then upload the file to apply the counts.',
      });
      return;
    }

    toast({
      variant: 'destructive',
      title: 'Download failed',
      description: 'The count sheet could not be downloaded on this device.',
    });
  };

  const applyCsvCounts = async (rows: CsvAuditRow[], filename: string) => {
    if (!editableItems.length) {
      setCsvImportProgress({ active: false, value: 0, label: '' });
      toast({
        variant: 'destructive',
        title: 'No audit items available',
        description: 'Load inventory items for this branch before importing a CSV count sheet.',
      });
      return;
    }

    const itemsToUpdate = editableItems.map((item) => ({ ...item }));
    const indexById = new Map<string, number>();
    const indexByBarcode = new Map<string, number>();
    const indexBySku = new Map<string, number>();
    const indexByProductCode = new Map<string, number>();
    const indexByName = new Map<string, number>();
    const duplicateNames = new Set<string>();

    itemsToUpdate.forEach((item, index) => {
      const idKey = normalizeLookupValue(item.id);
      const barcodeKey = normalizeLookupValue(item.barcode);
      const skuKey = normalizeLookupValue(item.sku);
      const productCodeKey = normalizeLookupValue(item.productCode);
      const nameKey = normalizeLookupValue(item.name);

      if (idKey) indexById.set(idKey, index);
      if (barcodeKey) indexByBarcode.set(barcodeKey, index);
      if (skuKey) indexBySku.set(skuKey, index);
      if (productCodeKey) indexByProductCode.set(productCodeKey, index);
      if (nameKey) {
        if (indexByName.has(nameKey)) {
          duplicateNames.add(nameKey);
          indexByName.delete(nameKey);
        } else if (!duplicateNames.has(nameKey)) {
          indexByName.set(nameKey, index);
        }
      }
    });

    const unmatchedRows: string[] = [];
    let appliedCount = 0;
    let missingQuantityCount = 0;

    const chunkSize = 50;

    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);

      chunk.forEach((row) => {
        let countedQuantity = parseCsvQuantity(
          getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.countedQuantity)
        );

        const rowName = normalizeLookupValue(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.name));
        const lookupCandidates = [
          indexByName.get(rowName),
          indexById.get(normalizeLookupValue(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.itemId))),
          indexByBarcode.get(normalizeLookupValue(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.barcode))),
          indexBySku.get(normalizeLookupValue(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.sku))),
          indexByProductCode.get(normalizeLookupValue(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.productCode))),
        ];

        const matchedIndex = lookupCandidates.find((candidate) => typeof candidate === 'number');
        if (typeof matchedIndex !== 'number') {
          const rowLabel =
            String(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.name) || '').trim()
            || String(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.itemId) || '').trim()
            || String(getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.barcode) || '').trim()
            || 'Unnamed row';
          unmatchedRows.push(
            duplicateNames.has(rowName) && rowLabel
              ? `${rowLabel} (duplicate product name)`
              : rowLabel
          );
          return;
        }

        const matchedItem = itemsToUpdate[matchedIndex];
        if (countedQuantity === null && isPortionedStockItem(matchedItem)) {
          const countedFullUnits = parseCsvQuantity(
            getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.countedFullUnits)
          );
          const countedPortions = parseCsvQuantity(
            getCsvValue(row, STOCK_AUDIT_CSV_ALIASES.countedPortions)
          );

          if (countedFullUnits !== null || countedPortions !== null) {
            countedQuantity =
              (countedFullUnits || 0) +
              (countedPortions || 0) / Number(matchedItem.portionsPerUnit);
          }
        }

        if (countedQuantity === null) {
          missingQuantityCount += 1;
          return;
        }

        itemsToUpdate[matchedIndex] = {
          ...matchedItem,
          countedStock: countedQuantity,
        };
        appliedCount += 1;
      });

      const processed = Math.min(start + chunk.length, rows.length);
      const progressValue = 35 + (processed / rows.length) * 55;
      setCsvImportProgress({
        active: true,
        value: Math.min(90, progressValue),
        label: `Balancing stock from CSV... ${processed} of ${rows.length} rows processed`,
      });

      await waitForUiFrame();
    }

    if (appliedCount === 0) {
      setCsvImportProgress({ active: false, value: 0, label: '' });
      toast({
        variant: 'destructive',
        title: 'No counts applied',
        description: 'No matching stock audit rows with counted quantities were found in the uploaded CSV.',
      });
      setCsvImportSummary({
        filename,
        appliedCount,
        missingQuantityCount,
        unmatchedRows,
      });
      return;
    }

    setCsvImportProgress({
      active: true,
      value: 95,
      label: 'Applying balanced quantities to the audit form...',
    });
    await waitForUiFrame();

    replace(itemsToUpdate);
    setCsvImportSummary({
      filename,
      appliedCount,
      missingQuantityCount,
      unmatchedRows,
    });
    setCsvImportProgress({
      active: true,
      value: 100,
      label: `Balancing complete. Applied ${appliedCount} counted quantities.`,
    });

    toast({
      title: 'CSV counts applied',
      description:
        unmatchedRows.length > 0
          ? `Applied ${appliedCount} counted quantities. ${unmatchedRows.length} row(s) could not be matched.`
          : `Applied ${appliedCount} counted quantities from the uploaded CSV.`,
    });

    window.setTimeout(() => {
      setCsvImportProgress({ active: false, value: 0, label: '' });
    }, 1200);
  };

  const handleCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    Papa.parse<CsvAuditRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setCsvImportProgress({
          active: true,
          value: 20,
          label: `Parsing ${file.name}...`,
        });
        event.target.value = '';

        const rows = (results.data || []).filter((row) =>
          Object.values(row).some((value) => String(value ?? '').trim().length > 0)
        );

        if (rows.length === 0) {
          setCsvImportProgress({ active: false, value: 0, label: '' });
          toast({
            variant: 'destructive',
            title: 'Empty CSV',
            description: 'The uploaded CSV did not contain any count rows to import.',
          });
          return;
        }

        setCsvImportProgress({
          active: true,
          value: 35,
          label: `Parsed ${rows.length} rows. Starting stock balancing...`,
        });
        void applyCsvCounts(rows, file.name);
      },
      error: (error) => {
        event.target.value = '';
        setCsvImportProgress({ active: false, value: 0, label: '' });
        console.error('[StockAudit] Failed to parse CSV:', error);
        toast({
          variant: 'destructive',
          title: 'CSV upload failed',
          description: 'The count sheet could not be parsed. Please check the file format and try again.',
        });
      },
    });
  };

  const onConfirmSubmit = async (data: StockTakeFormValues) => {
    if (!user || !activeBranchId) {
        toast({ variant: 'destructive', title: 'Authentication Error', description: 'You must be logged in to submit an audit.' });
        return;
    }
    setIsSubmitting(true);

    const stockTakeRecord: StockTake = {
      id: `ST-${Date.now()}`,
      branchId: activeBranchId,
      createdAt: new Date().toISOString(),
      createdBy: user.displayName || user.email,
      status: 'Pending Approval',
      items: data.items.map(item => ({
        itemId: item.id,
        itemName: item.name,
        systemStock: Number(item.stockUnits) || 0,
        countedStock: Number(item.countedStock) || 0,
        discrepancy: (Number(item.countedStock) || 0) - (Number(item.stockUnits) || 0),
      })),
      totalDiscrepancyValue: totalDiscrepancy,
    };

    try {
      // Mark stock take as dirty for sync
      const stockTakeWithSync: StockTake = {
        ...stockTakeRecord,
        _dirty: true,
        _operation: 'create'
      };
      await db.stockTakes.add(stockTakeWithSync);
      console.log('[Sync] Marked stock audit as dirty:', stockTakeRecord.id);

      // Queue to backend with offline support
      try {
        await authFetch.fetch('/inventory/stock-takes/', {
          method: 'POST',
          body: JSON.stringify(stockTakeRecord),
          offline: true,
          meta: {
            domain: 'inventory',
            entityType: 'StockTake',
            entityId: stockTakeRecord.id,
          },
        });
        console.log('[StockAudit] Queued audit submission to backend:', stockTakeRecord.id);
      } catch (syncError) {
        console.warn('[StockAudit] Failed to queue audit sync, but local save succeeded:', syncError);
      }

      toast({
        title: 'Audit Submitted for Approval',
        description: 'Your stock count has been saved and is awaiting admin approval.',
      });
      router.push('/dashboard/inventory');
    } catch (error) {
      console.error('Failed to save stock take:', error);
      toast({
        variant: 'destructive',
        title: 'Error Submitting Audit',
        description: 'There was a problem saving the stock audit.',
      });
    } finally {
      setIsSubmitting(false);
      setIsConfirmModalOpen(false);
    }
  };

  const updatePortionedCount = (
    index: number,
    item: StockAuditItem,
    field: 'wholeUnits' | 'remainingPortions',
    rawValue: string
  ) => {
    const portionsPerUnit = Number(item.portionsPerUnit);
    if (!Number.isFinite(portionsPerUnit) || portionsPerUnit <= 0) {
      return;
    }

    const currentParts = getPortionInputParts(item);
    const parsedValue = Number(rawValue);
    const normalizedValue = Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 0;
    const wholeUnits = field === 'wholeUnits' ? Math.floor(normalizedValue) : currentParts.wholeUnits;
    const remainingPortions = field === 'remainingPortions' ? Math.floor(normalizedValue) : currentParts.remainingPortions;
    const nextQuantity = wholeUnits + remainingPortions / portionsPerUnit;

    setValue(`items.${index}.countedStock`, Number(nextQuantity.toFixed(6)), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const renderCountedStockInput = (item: StockAuditItem, index: number) => {
    if (!isPortionedStockItem(item)) {
      return (
        <Input
          {...form.register(`items.${index}.countedStock`)}
          type="number"
          inputMode="decimal"
          step="any"
          className="text-right"
        />
      );
    }

    const portionParts = getPortionInputParts(item);
    const portionLabel = item.portionName || 'portion';
    const unitLabel = item.unitType || 'unit';

    return (
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{unitLabel}</label>
          <Input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={portionParts.wholeUnits}
            onChange={(event) => updatePortionedCount(index, item, 'wholeUnits', event.target.value)}
            className="text-right"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{portionLabel}</label>
          <Input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={portionParts.remainingPortions}
            onChange={(event) => updatePortionedCount(index, item, 'remainingPortions', event.target.value)}
            className="text-right"
          />
        </div>
        <p className="col-span-2 text-right text-[11px] text-muted-foreground">
          Counted as {getStockQuantitySummary(item, item.countedStock)}
        </p>
      </div>
    );
  };

  const renderDiscrepancy = (item: StockAuditItem) => {
    const systemStock = Number(item.stockUnits) || 0;
    const countedStock = Number(item.countedStock) || 0;
    const discrepancy = countedStock - systemStock;

    if (discrepancy === 0) {
      return <Badge variant="secondary">No Change</Badge>;
    }
    const isSurplus = discrepancy > 0;
    return (
      <Badge variant={isSurplus ? 'default' : 'destructive'} className={isSurplus ? 'bg-green-600' : ''}>
        {isSurplus ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
        {getStockDifferenceSummary(item, discrepancy)}
      </Badge>
    );
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
      <div className="flex w-full flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-center">
        <div className="grid gap-2">
          <Button variant="outline" size="sm" className="w-fit" onClick={() => router.back()}>
            <ArrowLeft className="mr-2" /> Back to Inventory
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Full Stock Audit</h1>
          <p className="text-muted-foreground">
            Count your physical stock and submit for approval to update system levels.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
          <input
            ref={csvFileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleCsvUpload}
          />
          <Button variant="outline" onClick={handleDownloadCsvTemplate} disabled={isSubmitting}>
            <Download className="mr-2 h-4 w-4" /> Download CSV Count Sheet
          </Button>
          <Button
            variant="outline"
            onClick={() => csvFileInputRef.current?.click()}
            disabled={isSubmitting}
          >
            <Upload className="mr-2 h-4 w-4" /> Upload Filled CSV
          </Button>
          <Button variant="outline" onClick={() => {}} disabled={isSubmitting}>
            <Printer className="mr-2 h-4 w-4" /> Print Count Sheet
          </Button>
          <Button onClick={() => setIsConfirmModalOpen(true)} disabled={isSubmitting || editableItems.length === 0}>
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Review & Submit Audit
          </Button>
        </div>
      </div>

      {csvImportProgress.active && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Balancing Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={Math.max(0, Math.min(100, csvImportProgress.value))} />
            <p className="text-sm text-muted-foreground">{csvImportProgress.label}</p>
          </CardContent>
        </Card>
      )}

      {csvImportSummary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">CSV Balance Results</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-sm font-medium">Applied Counts</p>
              <p className="text-2xl font-bold">{csvImportSummary.appliedCount}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Rows Without Count</p>
              <p className="text-2xl font-bold">{csvImportSummary.missingQuantityCount}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Unmatched Rows</p>
              <p className="text-2xl font-bold">{csvImportSummary.unmatchedRows.length}</p>
            </div>
            <div className="sm:col-span-3">
              <p className="text-sm text-muted-foreground">
                Imported from <span className="font-medium text-foreground">{csvImportSummary.filename}</span>.
                Review the updated counted quantities below before submitting the audit.
              </p>
              {csvImportSummary.unmatchedRows.length > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Unmatched: {csvImportSummary.unmatchedRows.slice(0, 5).join(', ')}
                  {csvImportSummary.unmatchedRows.length > 5 ? ` and ${csvImportSummary.unmatchedRows.length - 5} more.` : '.'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">System Stock Value</CardTitle>
                  <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                  <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
              </CardContent>
          </Card>
           <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Counted Stock Value</CardTitle>
                  <FileUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                  <div className="text-2xl font-bold">{formatCurrency(countedValue)}</div>
              </CardContent>
          </Card>
          <Card className={cn(totalDiscrepancy !== 0 && (totalDiscrepancy > 0 ? 'border-green-500' : 'border-destructive'))}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Discrepancy Value</CardTitle>
              </CardHeader>
              <CardContent>
                  <div className={cn("text-2xl font-bold", totalDiscrepancy !== 0 && (totalDiscrepancy > 0 ? 'text-green-600' : 'text-destructive'))}>
                    {totalDiscrepancy > 0 ? '+' : ''}{formatCurrency(totalDiscrepancy)}
                  </div>
              </CardContent>
          </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search items by name, category, barcode, or SKU..."
              className="w-full pl-10 md:w-80"
            />
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(() => setIsConfirmModalOpen(true))}>
            {isMobile ? (
            <div className="space-y-3">
              {displayedItems.length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">
                  No audit items match "{searchTerm.trim()}".
                </div>
              ) : displayedItems.map(({ item, index }) => {
                const systemStock = Number(item.stockUnits) || 0;
                const countedStock = Number(item.countedStock) || 0;
                const cost = Number(item.cost) || 0;
                const discrepancy = countedStock - systemStock;
                const discrepancyValue = discrepancy * cost;

                return (
                  <Card
                    key={item.formId}
                    className={cn('mobile-data-card', discrepancy !== 0 && 'border-primary/40')}
                  >
                    <CardContent className="space-y-4 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium">{item.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {item.category || 'Uncategorized'}
                          </p>
                        </div>
                        {renderDiscrepancy(item)}
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-md bg-muted/40 p-3">
                          <p className="text-muted-foreground">System Stock</p>
                          <p className="font-semibold">
                            {getStockQuantitySummary(item, systemStock)}
                          </p>
                          {isPortionedStockItem(item) && (
                            <p className="text-[11px] text-muted-foreground">
                              {formatInventoryQuantity(systemStock)} {item.unitType || 'unit'} total
                            </p>
                          )}
                        </div>
                        <div className="rounded-md bg-muted/40 p-3">
                          <p className="text-muted-foreground">Cost / Unit</p>
                          <p className="font-semibold">{formatCurrency(cost)}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">Counted Stock</label>
                        {renderCountedStockInput(item, index)}
                      </div>

                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Discrepancy Value</span>
                        <span
                          className={cn(
                            'font-semibold',
                            discrepancyValue !== 0 && (discrepancyValue > 0 ? 'text-green-600' : 'text-destructive')
                          )}
                        >
                          {discrepancyValue > 0 ? '+' : ''}
                          {formatCurrency(discrepancyValue)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[250px]">Item</TableHead>
                    <TableHead className="text-right">System Stock</TableHead>
                    <TableHead className="w-40 text-right">Counted Stock</TableHead>
                    <TableHead className="text-right">Discrepancy</TableHead>
                    <TableHead className="text-right">Cost/Unit</TableHead>
                    <TableHead className="text-right">Discrepancy Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                        No audit items match "{searchTerm.trim()}".
                      </TableCell>
                    </TableRow>
                  ) : displayedItems.map(({ item, index }) => {
                    const systemStock = Number(item.stockUnits) || 0;
                    const countedStock = Number(item.countedStock) || 0;
                    const cost = Number(item.cost) || 0;
                    const discrepancy = countedStock - systemStock;
                    const discrepancyValue = discrepancy * cost;
                    
                    return (
                        <TableRow key={item.formId} className={cn(discrepancy !== 0 && 'bg-muted/50')}>
                            <TableCell className="font-medium">
                              <div className="space-y-1">
                                <p>{item.name}</p>
                                {isPortionedStockItem(item) && (
                                  <p className="text-xs font-normal text-muted-foreground">
                                    {formatQuantityWithUnit(item.portionsPerUnit, item.portionName || 'portion', {
                                      preferWholeNumbers: true,
                                      maximumFractionDigits: 0,
                                    })} per {item.unitType || 'unit'}
                                  </p>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              <div className="space-y-1">
                                <p>{getStockQuantitySummary(item, systemStock)}</p>
                                {isPortionedStockItem(item) && (
                                  <p className="text-xs font-normal text-muted-foreground">
                                    {formatInventoryQuantity(systemStock)} {item.unitType || 'unit'} total
                                  </p>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                                <div className="ml-auto w-48 max-w-full">
                                  {renderCountedStockInput(item, index)}
                                </div>
                            </TableCell>
                            <TableCell className="text-right">{renderDiscrepancy(item)}
                            </TableCell>
                             <TableCell className="text-right font-mono">{formatCurrency(cost)}</TableCell>
                            <TableCell className={cn("text-right font-semibold", discrepancyValue !== 0 && (discrepancyValue > 0 ? 'text-green-600' : 'text-destructive'))}>
                                {discrepancyValue > 0 ? '+' : ''}{formatCurrency(discrepancyValue)}
                            </TableCell>
                        </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            )}
          </form>
        </CardContent>
      </Card>
      
      <Dialog open={isConfirmModalOpen} onOpenChange={setIsConfirmModalOpen}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Submit Audit for Approval?</DialogTitle>
                <DialogDescription>
                    This will save the audit and send it to an administrator for approval.
                    Inventory levels will not be updated until the audit is approved.
                </DialogDescription>
            </DialogHeader>
            <Card className="bg-muted">
                <CardHeader>
                    <CardTitle className="text-base">Summary of Changes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                     <div className="flex justify-between">
                        <span>Items with shortages:</span>
                        <span className="font-medium">{auditSummary.shortages}</span>
                    </div>
                     <div className="flex justify-between">
                        <span>Items with surplus:</span>
                        <span className="font-medium">{auditSummary.surplus}</span>
                    </div>
                    <div className="flex justify-between font-semibold pt-2 border-t">
                        <span>Total Discrepancy Value:</span>
                        <span className={cn(totalDiscrepancy !== 0 && (totalDiscrepancy > 0 ? 'text-green-600' : 'text-destructive'))}>
                          {totalDiscrepancy >= 0 ? `+${formatCurrency(totalDiscrepancy)}` : `-${formatCurrency(Math.abs(totalDiscrepancy))}`}
                        </span>
                    </div>
                </CardContent>
            </Card>
            <DialogFooter>
                <Button variant="ghost" onClick={() => setIsConfirmModalOpen(false)} disabled={isSubmitting}>Cancel</Button>
                <Button onClick={handleSubmit(onConfirmSubmit)} disabled={isSubmitting}>
                     {isSubmitting ? (
                        <Loader2 className="mr-2 animate-spin" />
                     ) : (
                        <Send className="mr-2" />
                     )}
                    Submit Audit
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
