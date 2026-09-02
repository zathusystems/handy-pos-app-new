'use client';

import React from 'react';
import { Archive, CheckCircle2, ClipboardCheck, Loader2, RefreshCw, Send, X } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { formatInventoryQuantity } from '@/lib/quantity-format';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaginationControls, usePaginatedItems } from './pagination-controls';

type Branch = {
  id: string;
  name: string;
  address?: string;
  isWarehouse?: boolean;
};

type WarehouseStockItem = {
  barcode: string;
  productName: string;
  productDescription: string;
  currentQuantity: number;
  uom: string;
  price: number | null;
};

type TransferDraft = {
  quantity: string;
  price: string;
};

type ReconciliationRow = {
  inventory_item_id?: string;
  name: string;
  mra_product_code: string;
  local_quantity?: string;
  remote_quantity?: string;
  difference?: string;
};

type ReconciliationResult = {
  matched_count: number;
  quantity_mismatch_count: number;
  missing_in_eis_count: number;
  missing_in_pos_count: number;
  matched: ReconciliationRow[];
  quantity_mismatches: ReconciliationRow[];
  missing_in_eis: ReconciliationRow[];
  missing_in_pos: ReconciliationRow[];
};

type Terminal = {
  id: string;
  status?: string;
  branch?: string | { id?: string; pk?: string };
  branch_id?: string;
  branchId?: string;
  terminal_id?: string;
  terminalId?: string;
};

interface WarehouseStockTabProps {
  businessId?: string | null;
  branchId?: string | null;
  branches: Branch[];
  searchTerm: string;
  currency?: string;
}

const extractApiList = <T,>(value: any): T[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.stocks)) return value.stocks;
  return [];
};

const firstPresent = (...values: unknown[]): unknown => (
  values.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
);

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toOptionalNumber = (value: unknown): number | null => {
  const present = firstPresent(value);
  if (present === undefined) return null;
  const parsed = Number(present);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBackendBranchId = (value: unknown): string => {
  const normalized = String(value || '').trim();
  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];
  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];
  return normalized;
};

const getTerminalBranchId = (terminal: Terminal): string => {
  if (terminal.branch && typeof terminal.branch === 'object') {
    return String(terminal.branch.id ?? terminal.branch.pk ?? (terminal.branch as any).branch_id ?? '').trim();
  }
  return String(terminal.branch ?? terminal.branch_id ?? terminal.branchId ?? '').trim();
};

const getTerminalLabel = (terminal: Terminal | null): string => (
  String(terminal?.terminal_id || terminal?.terminalId || terminal?.id || 'EIS terminal')
);

const normalizeItem = (item: any): WarehouseStockItem | null => {
  const barcode = String(
    item?.barcode || item?.barCode || item?.productCode || item?.product_code ||
    item?.mraProductCode || item?.mra_product_code || ''
  ).trim();
  if (!barcode) return null;

  return {
    barcode,
    productName: String(
      item?.productName || item?.product_name || item?.name || item?.description || barcode
    ).trim(),
    productDescription: String(item?.productDescription || item?.product_description || '').trim(),
    currentQuantity: toNumber(
      firstPresent(item?.currentQuantity, item?.current_quantity, item?.quantityInStock, item?.quantity)
    ),
    uom: String(
      item?.uom || item?.unitOfMeasure || item?.unit_of_measure || item?.unit || ''
    ).trim(),
    price: toOptionalNumber(firstPresent(
      item?.price,
      item?.sellingPrice,
      item?.selling_price,
      item?.unitPrice,
      item?.unit_price,
      item?.retailPrice,
      item?.retail_price,
    )),
  };
};

const formatMoney = (value: unknown, currency: string): string => {
  const amount = toOptionalNumber(value);
  if (amount === null) return 'Not set';
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export function WarehouseStockTab({
  businessId,
  branchId,
  branches,
  searchTerm,
  currency = 'MWK',
}: WarehouseStockTabProps) {
  const [terminal, setTerminal] = React.useState<Terminal | null>(null);
  const [items, setItems] = React.useState<WarehouseStockItem[]>([]);
  const [selectedItems, setSelectedItems] = React.useState<Record<string, TransferDraft>>({});
  const [toBranchId, setToBranchId] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [isTransferring, setIsTransferring] = React.useState(false);
  const [isReconciling, setIsReconciling] = React.useState(false);
  const [error, setError] = React.useState('');
  const [isReviewOpen, setIsReviewOpen] = React.useState(false);
  const [reconciliation, setReconciliation] = React.useState<ReconciliationResult | null>(null);

  const destinationBranches = React.useMemo(
    () => branches.filter((branch) => !branch.isWarehouse),
    [branches]
  );
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredItems = React.useMemo(() => {
    if (!normalizedSearchTerm) return items;
    return items.filter((item) => [
      item.productName,
      item.productDescription,
      item.barcode,
      item.uom,
      item.currentQuantity,
      item.price,
    ].some((value) => String(value ?? '').toLowerCase().includes(normalizedSearchTerm)));
  }, [items, normalizedSearchTerm]);

  const {
    setCurrentPage,
    totalItems,
    totalPages,
    effectiveCurrentPage,
    pageStartIndex,
    pageEndIndex,
    paginatedItems,
  } = usePaginatedItems(filteredItems);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [normalizedSearchTerm, setCurrentPage]);

  const selectedRows = React.useMemo(() => (
    Object.entries(selectedItems)
      .map(([barcode, draft]) => {
        const item = items.find((candidate) => candidate.barcode === barcode);
        return item ? { item, draft } : null;
      })
      .filter(Boolean) as Array<{ item: WarehouseStockItem; draft: TransferDraft }>
  ), [items, selectedItems]);

  const selectedValidationError = React.useMemo(() => {
    if (selectedRows.length === 0) return 'Select at least one product.';
    for (const { item, draft } of selectedRows) {
      const quantity = Number(draft.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return `Enter a transfer quantity for ${item.productName}.`;
      }
      if (quantity > item.currentQuantity) {
        return `${item.productName} exceeds the available warehouse quantity.`;
      }
      const price = draft.price.trim() === '' ? null : Number(draft.price);
      if (price !== null && (!Number.isFinite(price) || price < 0)) {
        return `${item.productName} has an invalid selling price.`;
      }
    }
    return '';
  }, [selectedRows]);

  const loadWarehouseStock = React.useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      if (!businessId) throw new Error('Business context is not ready.');

      const branchQuery = branchId
        ? `&branch_id=${encodeURIComponent(toBackendBranchId(branchId))}`
        : '';
      let terminals: Terminal[] = [];
      if (branchQuery) {
        try {
          const branchTerminalsResponse = await authFetch.fetch<any>(
            `/mra-eis/terminals/?business_id=${encodeURIComponent(businessId)}${branchQuery}`
          );
          terminals = extractApiList<Terminal>(branchTerminalsResponse);
        } catch (branchError) {
          console.warn('[WarehouseStockTab] Branch terminal lookup failed; trying business terminals.', branchError);
        }
      }

      if (
        branchQuery &&
        !terminals.some((candidate) => String(candidate?.status || '').toLowerCase() === 'active')
      ) {
        const terminalsResponse = await authFetch.fetch<any>(
          `/mra-eis/terminals/?business_id=${encodeURIComponent(businessId)}`
        );
        terminals = extractApiList<Terminal>(terminalsResponse);
      } else if (terminals.length === 0) {
        const terminalsResponse = await authFetch.fetch<any>(
          `/mra-eis/terminals/?business_id=${encodeURIComponent(businessId)}`
        );
        terminals = extractApiList<Terminal>(terminalsResponse);
      }

      const activeTerminals = terminals.filter(
        (candidate) => String(candidate?.status || '').toLowerCase() === 'active'
      );
      const normalizedBranch = toBackendBranchId(branchId);
      const selectedTerminal = activeTerminals.find(
        (candidate) => toBackendBranchId(getTerminalBranchId(candidate)) === normalizedBranch
      ) || activeTerminals[0] || null;

      if (!selectedTerminal?.id) {
        setTerminal(null);
        setItems([]);
        throw new Error('Activate an EIS terminal before viewing warehouse stock.');
      }

      setTerminal(selectedTerminal);
      const stockResponse = await authFetch.fetch<any>(
        `/mra-eis/terminals/${selectedTerminal.id}/warehouse_inventory/?page_size=200&max_pages=25`
      );
      const stockRows = extractApiList<any>(
        stockResponse?.stocks || stockResponse?.items || stockResponse?.data?.stocks ||
        stockResponse?.data || stockResponse
      )
        .map(normalizeItem)
        .filter(Boolean) as WarehouseStockItem[];

      setItems(stockRows);
      setSelectedItems((current) => Object.fromEntries(
        Object.entries(current).filter(([barcode]) => stockRows.some((item) => item.barcode === barcode))
      ));
    } catch (caught: any) {
      const message = caught?.message || 'Could not load warehouse stock.';
      setError(message);
      if (businessId) {
        toast({ variant: 'destructive', title: 'Warehouse stock unavailable', description: message });
      }
    } finally {
      setIsLoading(false);
    }
  }, [branchId, businessId]);

  React.useEffect(() => {
    void loadWarehouseStock();
  }, [loadWarehouseStock]);

  const toggleSelection = (item: WarehouseStockItem, checked: boolean) => {
    setSelectedItems((current) => {
      const next = { ...current };
      if (checked) {
        next[item.barcode] = {
          quantity: '1',
          price: item.price === null ? '' : String(item.price),
        };
      } else {
        delete next[item.barcode];
      }
      return next;
    });
    if (checked && !toBranchId) {
      setToBranchId(destinationBranches[0]?.id || '');
    }
  };

  const updateDraft = (barcode: string, updates: Partial<TransferDraft>) => {
    setSelectedItems((current) => ({
      ...current,
      [barcode]: { ...current[barcode], ...updates },
    }));
  };

  const clearSelection = () => {
    setSelectedItems({});
    setIsReviewOpen(false);
  };

  const openReview = () => {
    if (!toBranchId) {
      toast({ variant: 'destructive', title: 'Select a destination branch.' });
      return;
    }
    if (selectedValidationError) {
      toast({ variant: 'destructive', title: selectedValidationError });
      return;
    }
    setIsReviewOpen(true);
  };

  const submitTransfer = async () => {
    if (!terminal?.id || !toBranchId || selectedValidationError) return;

    setIsTransferring(true);
    try {
      await authFetch.fetch<any>(`/mra-eis/terminals/${terminal.id}/transfer_inventory/`, {
        method: 'POST',
        body: JSON.stringify({
          toBranchId,
          fromWarehouseToSite: true,
          items: selectedRows.map(({ item, draft }) => ({
            barcode: item.barcode,
            quantity: Number(draft.quantity),
            ...(draft.price.trim() === '' ? {} : { price: Number(draft.price) }),
          })),
        }),
      });
      toast({
        title: 'Warehouse transfer submitted',
        description: 'Refresh the branch POS after MRA accepts the transfer.',
      });
      clearSelection();
      await loadWarehouseStock();
    } catch (caught: any) {
      toast({
        variant: 'destructive',
        title: 'Transfer failed',
        description: caught?.message || 'Could not submit the warehouse transfer.',
      });
    } finally {
      setIsTransferring(false);
    }
  };

  const reconcileWarehouseStock = async () => {
    if (!terminal?.id) {
      toast({ variant: 'destructive', title: 'Load warehouse stock first.' });
      return;
    }

    setIsReconciling(true);
    try {
      const response = await authFetch.fetch<any>(
        `/mra-eis/terminals/${terminal.id}/reconcile_inventory/`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );
      const result = response?.data && !Array.isArray(response.data) ? response.data : response;
      const normalized: ReconciliationResult = {
        matched_count: Number(result?.matched_count ?? result?.matched?.length ?? 0),
        quantity_mismatch_count: Number(
          result?.quantity_mismatch_count ?? result?.quantity_mismatches?.length ?? 0
        ),
        missing_in_eis_count: Number(result?.missing_in_eis_count ?? result?.missing_in_eis?.length ?? 0),
        missing_in_pos_count: Number(result?.missing_in_pos_count ?? result?.missing_in_pos?.length ?? 0),
        matched: Array.isArray(result?.matched) ? result.matched : [],
        quantity_mismatches: Array.isArray(result?.quantity_mismatches) ? result.quantity_mismatches : [],
        missing_in_eis: Array.isArray(result?.missing_in_eis) ? result.missing_in_eis : [],
        missing_in_pos: Array.isArray(result?.missing_in_pos) ? result.missing_in_pos : [],
      };
      setReconciliation(normalized);
      const issueCount = normalized.quantity_mismatch_count + normalized.missing_in_eis_count + normalized.missing_in_pos_count;
      toast({
        title: issueCount > 0 ? 'EIS stock check completed' : 'EIS stock matches',
        description: issueCount > 0
          ? `${issueCount} item${issueCount === 1 ? '' : 's'} need attention.`
          : `${normalized.matched_count} mapped product${normalized.matched_count === 1 ? '' : 's'} matched.`,
      });
    } catch (caught: any) {
      toast({
        variant: 'destructive',
        title: 'EIS stock check failed',
        description: caught?.message || 'Could not compare local and EIS stock.',
      });
    } finally {
      setIsReconciling(false);
    }
  };

  const destinationBranch = destinationBranches.find((branch) => branch.id === toBranchId);

  return (
    <CardContent>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Archive className="h-4 w-4 text-muted-foreground" />
            <p className="font-medium">EIS Warehouse Stock</p>
            {terminal && <Badge variant="outline">{getTerminalLabel(terminal)}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            View portal stock and transfer approved products to a branch.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => void reconcileWarehouseStock()}
            disabled={isLoading || isReconciling || !terminal}
          >
            {isReconciling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}
            Check EIS stock
          </Button>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => void loadWarehouseStock()}
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {reconciliation && (
        <div className="mb-5 space-y-4 rounded-md border bg-muted/20 p-3 sm:p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              <p className="font-medium">EIS stock check</p>
            </div>
            <p className="text-xs text-muted-foreground">Read-only comparison; no stock was changed.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Matched</p>
              <p className="mt-1 text-lg font-semibold text-emerald-600">{reconciliation.matched_count}</p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Quantity mismatch</p>
              <p className="mt-1 text-lg font-semibold text-amber-600">{reconciliation.quantity_mismatch_count}</p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Missing in EIS</p>
              <p className="mt-1 text-lg font-semibold text-destructive">{reconciliation.missing_in_eis_count}</p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Missing in POS</p>
              <p className="mt-1 text-lg font-semibold text-blue-600">{reconciliation.missing_in_pos_count}</p>
            </div>
          </div>

          {reconciliation.quantity_mismatches.length > 0 && (
            <div className="overflow-x-auto rounded-md border bg-background">
              <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                <X className="h-4 w-4 text-amber-600" />
                Quantity differences
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Local</TableHead>
                    <TableHead className="text-right">EIS</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconciliation.quantity_mismatches.slice(0, 50).map((row, index) => (
                    <TableRow key={`${row.mra_product_code}-${row.inventory_item_id || index}`}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="font-mono text-xs">{row.mra_product_code}</TableCell>
                      <TableCell className="text-right">{row.local_quantity}</TableCell>
                      <TableCell className="text-right">{row.remote_quantity}</TableCell>
                      <TableCell className="text-right font-medium">{row.difference}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {reconciliation.quantity_mismatches.length > 50 && (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  Showing the first 50 differences.
                </p>
              )}
            </div>
          )}

          {reconciliation.quantity_mismatches.length === 0 &&
            reconciliation.missing_in_eis_count === 0 &&
            reconciliation.missing_in_pos_count === 0 && (
              <p className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                All mapped products matched the EIS stock returned for this check.
              </p>
            )}
        </div>
      )}

      {!isLoading && items.length > 0 && (
        <div className="mb-4 rounded-md border bg-muted/20 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <Label htmlFor="warehouse-destination">Destination branch</Label>
              <Select value={toBranchId} onValueChange={setToBranchId}>
                <SelectTrigger id="warehouse-destination" className="w-full lg:w-72">
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {destinationBranches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedRows.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearSelection} disabled={isTransferring}>
                  <X className="mr-2 h-4 w-4" />
                  Clear {selectedRows.length}
                </Button>
              )}
              <Button
                onClick={openReview}
                disabled={isTransferring || Boolean(selectedValidationError) || !toBranchId}
              >
                <Send className="mr-2 h-4 w-4" />
                Review transfer
              </Button>
            </div>
          </div>
          {selectedRows.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Select products to transfer to the chosen branch.
            </p>
          )}
          {selectedRows.length > 0 && selectedValidationError && (
            <p className="mt-2 text-xs text-destructive">{selectedValidationError}</p>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex min-h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading warehouse stock
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Product</TableHead>
                  <TableHead>Barcode</TableHead>
                  <TableHead className="text-right">Warehouse stock</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="w-32 text-right">Transfer qty</TableHead>
                  <TableHead className="w-36 text-right">Selling price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedItems.length > 0 ? paginatedItems.map((item) => {
                  const draft = selectedItems[item.barcode];
                  return (
                    <TableRow key={item.barcode} data-state={draft ? 'selected' : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={Boolean(draft)}
                          disabled={item.currentQuantity <= 0 || destinationBranches.length === 0}
                          onCheckedChange={(checked) => toggleSelection(item, checked === true)}
                          aria-label={`Select ${item.productName}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.productName}</div>
                        {item.productDescription && <div className="text-xs text-muted-foreground">{item.productDescription}</div>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.barcode}</TableCell>
                      <TableCell className="text-right font-medium">{formatInventoryQuantity(item.currentQuantity)}</TableCell>
                      <TableCell>{item.uom || '-'}</TableCell>
                      <TableCell>
                        <Input
                          className="ml-auto h-8 w-24 text-right"
                          inputMode="decimal"
                          value={draft?.quantity || ''}
                          disabled={!draft}
                          placeholder="Qty"
                          onChange={(event) => updateDraft(item.barcode, { quantity: event.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="ml-auto h-8 w-28 text-right"
                          inputMode="decimal"
                          value={draft?.price || ''}
                          disabled={!draft}
                          placeholder={formatMoney(item.price, currency)}
                          onChange={(event) => updateDraft(item.barcode, { price: event.target.value })}
                        />
                      </TableCell>
                    </TableRow>
                  );
                }) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {normalizedSearchTerm ? `No warehouse stock matches "${searchTerm.trim()}".` : 'No warehouse stock found.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-3 md:hidden">
            {paginatedItems.length > 0 ? paginatedItems.map((item) => {
              const draft = selectedItems[item.barcode];
              return (
                <div key={item.barcode} className="rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <Checkbox
                        className="mt-1"
                        checked={Boolean(draft)}
                        disabled={item.currentQuantity <= 0 || destinationBranches.length === 0}
                        onCheckedChange={(checked) => toggleSelection(item, checked === true)}
                        aria-label={`Select ${item.productName}`}
                      />
                      <div className="min-w-0">
                        <p className="break-words font-semibold leading-tight">{item.productName}</p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.barcode}</p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {formatInventoryQuantity(item.currentQuantity)} {item.uom || 'units'}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">Price: {formatMoney(item.price, currency)}</p>
                  {draft && (
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Transfer qty</Label>
                        <Input
                          inputMode="decimal"
                          value={draft.quantity}
                          onChange={(event) => updateDraft(item.barcode, { quantity: event.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Selling price</Label>
                        <Input
                          inputMode="decimal"
                          value={draft.price}
                          placeholder={formatMoney(item.price, currency)}
                          onChange={(event) => updateDraft(item.barcode, { price: event.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            }) : (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {normalizedSearchTerm ? `No warehouse stock matches "${searchTerm.trim()}".` : 'No warehouse stock found.'}
              </div>
            )}
          </div>

          <PaginationControls
            currentPage={effectiveCurrentPage}
            totalItems={totalItems}
            totalPages={totalPages}
            pageStartIndex={pageStartIndex}
            pageEndIndex={pageEndIndex}
            onPageChange={setCurrentPage}
            itemLabel="warehouse products"
          />
        </>
      )}

      <Dialog open={isReviewOpen} onOpenChange={(open) => !isTransferring && setIsReviewOpen(open)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review warehouse transfer</DialogTitle>
            <DialogDescription>
              Confirm the products and quantities before sending them to EIS.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2">
            <div><p className="text-muted-foreground">Destination</p><p className="font-medium">{destinationBranch?.name || 'Not selected'}</p></div>
            <div><p className="text-muted-foreground">Products</p><p className="font-medium">{selectedRows.length}</p></div>
          </div>
          <div className="max-h-[50vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Product</TableHead><TableHead>Barcode</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Price</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {selectedRows.map(({ item, draft }) => (
                  <TableRow key={item.barcode}>
                    <TableCell className="font-medium">{item.productName}</TableCell>
                    <TableCell className="font-mono text-xs">{item.barcode}</TableCell>
                    <TableCell className="text-right">{draft.quantity}</TableCell>
                    <TableCell className="text-right">{draft.price ? formatMoney(draft.price, currency) : 'Use EIS price'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReviewOpen(false)} disabled={isTransferring}>Back</Button>
            <Button onClick={() => void submitTransfer()} disabled={isTransferring || Boolean(selectedValidationError)}>
              {isTransferring ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Submit transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  );
}
