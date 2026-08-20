
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { PlusCircle, MoreHorizontal, Edit, Trash2, Check, RefreshCw, Lock, Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { syncService } from '@/lib/services/sync-service';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';

interface TaxRate {
  id: string;
  name: string;
  rate: number;
  taxType: 'VAT_STANDARD' | 'VAT_ZERO' | 'VAT_EXEMPT';
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
  mraCompliant: boolean;
  isLocked: boolean;
  businessId: string;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';

const DEFAULT_TAX_TYPE: TaxRate['taxType'] = 'VAT_STANDARD';
const TAX_RATES_ENDPOINT = '/business/tax-rates/';

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeTaxType = (value: unknown): TaxRate['taxType'] => {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'VAT_ZERO' || raw === 'ZERO') return 'VAT_ZERO';
  if (raw === 'VAT_EXEMPT' || raw === 'EXEMPT') return 'VAT_EXEMPT';
  return DEFAULT_TAX_TYPE;
};

const normalizeMappingTaxType = (value: unknown): 'standard' | 'zero' | 'exempt' => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.includes('zero')) return 'zero';
  if (raw.includes('exempt')) return 'exempt';
  return 'standard';
};

const normalizeTaxTypeForMapping = (value: TaxRate['taxType']): 'standard' | 'zero' | 'exempt' => {
  if (value === 'VAT_ZERO') return 'zero';
  if (value === 'VAT_EXEMPT') return 'exempt';
  return 'standard';
};

const normalizeRateForSignature = (value: unknown, taxType: 'standard' | 'zero' | 'exempt'): number => {
  if (taxType !== 'standard') return 0;
  const raw = toNumber(value, 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw <= 1 ? raw * 100 : raw;
};

const buildTaxSignature = (taxType: 'standard' | 'zero' | 'exempt', rate: unknown): string => {
  const normalizedRate = normalizeRateForSignature(rate, taxType);
  return `${taxType}:${normalizedRate.toFixed(4)}`;
};

const normalizeInventoryReference = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nestedValue =
      obj.id ??
      obj.pk ??
      obj.uuid ??
      obj.inventory_item_id ??
      obj.inventoryItemId;
    return String(nestedValue ?? '').trim();
  }
  return String(value).trim();
};

const resolveMappingInventoryItemId = (mapping: any): string => {
  if (!mapping || typeof mapping !== 'object') return '';
  const candidates = [
    mapping.inventoryItemId,
    mapping.inventory_item_id,
    mapping.inventoryItem,
    mapping.inventory_item,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeInventoryReference(candidate);
    if (normalized) return normalized;
  }
  return '';
};

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { message?: string }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage;
  }
  return fallback;
};

const extractTaxRows = (response: any): any[] => {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.results)) return response.results;
  return [];
};

const normalizeBackendTaxRate = (tax: any, fallbackBusinessId: string): TaxRate => {
  const nowIso = new Date().toISOString();
  const fallbackDate = nowIso.split('T')[0];
  const businessId = String(
    tax?.business_id ?? tax?.businessId ?? tax?.business ?? fallbackBusinessId ?? ''
  ).trim() || fallbackBusinessId;

  return {
    id: String(tax?.id ?? '').trim(),
    name: String(tax?.name ?? '').trim(),
    rate: toNumber(tax?.rate, 0),
    taxType: normalizeTaxType(tax?.tax_type ?? tax?.taxType),
    effectiveFrom: String(tax?.effective_from ?? tax?.effectiveFrom ?? fallbackDate).trim() || fallbackDate,
    effectiveTo: String(tax?.effective_to ?? tax?.effectiveTo ?? '').trim(),
    isActive: toBoolean(tax?.is_active ?? tax?.isActive, true),
    mraCompliant: toBoolean(tax?.mra_compliant ?? tax?.mraCompliant, true),
    isLocked: toBoolean(tax?.is_locked ?? tax?.isLocked ?? tax?.locked, false),
    businessId,
    createdAt: String(tax?.created_at ?? tax?.createdAt ?? nowIso).trim() || nowIso,
    updatedAt: String(tax?.updated_at ?? tax?.updatedAt ?? nowIso).trim() || nowIso,
    isDefault: toBoolean(tax?.is_default ?? tax?.isDefault, false),
  };
};

const taxRateSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(2, 'Tax name is required.'),
    rate: z.number().min(0, 'Rate must be positive.').max(100, 'Rate cannot exceed 100.'),
    tax_type: z.enum(['VAT_STANDARD', 'VAT_ZERO', 'VAT_EXEMPT']).default('VAT_STANDARD'),
    effective_from: z.string().min(1, 'Effective from date is required.'),
    effective_to: z.string().optional(),
    is_active: z.boolean().default(true),
    mra_tax_code: z.string().optional(),
    locked: z.boolean().default(false),
});

type TaxRateFormValues = z.infer<typeof taxRateSchema>;

const TaxForm = ({
  onFormSubmit,
  defaultValues,
  onSuccess,
}: {
  onFormSubmit: (data: TaxRateFormValues) => void;
  defaultValues?: TaxRate;
  onSuccess?: () => void;
}) => {
  const form = useForm<TaxRateFormValues>({
    resolver: zodResolver(taxRateSchema),
    defaultValues: {
      tax_type: 'VAT_STANDARD',
      is_active: true,
      effective_from: new Date().toISOString().split('T')[0],
      effective_to: '',
    },
  });

  // Update form when defaultValues change (for edit mode)
  useEffect(() => {
    if (defaultValues) {
      form.reset({
        id: defaultValues.id,
        name: defaultValues.name,
        rate: defaultValues.rate,
        tax_type: defaultValues.taxType as 'VAT_STANDARD' | 'VAT_ZERO' | 'VAT_EXEMPT',
        effective_from: defaultValues.effectiveFrom,
        effective_to: defaultValues.effectiveTo,
        is_active: defaultValues.isActive,
      });
    } else {
      form.reset({
        tax_type: 'VAT_STANDARD',
        is_active: true,
        effective_from: new Date().toISOString().split('T')[0],
        effective_to: '',
      });
    }
  }, [defaultValues, form]);

  const onSubmit = (data: TaxRateFormValues) => {
    onFormSubmit(data);
    onSuccess?.();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 py-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tax Name</FormLabel>
              <FormControl><Input placeholder="e.g., Standard VAT" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="rate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rate (%)</FormLabel>
              <FormControl><Input type="number" step="0.01" placeholder="16.50" {...field} onChange={e => field.onChange(parseFloat(e.target.value))}/></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="tax_type"
          render={({ field }) => {
            const rateValue = form.watch('rate');
            return (
              <FormItem>
                <FormLabel>MRA Tax Category</FormLabel>
                <FormControl>
                  <select {...field} className="w-full px-3 py-2 border border-gray-300 rounded-md">
                    <option value="VAT_STANDARD">Standard Rated ({rateValue ? rateValue.toFixed(2) : '0.00'}%)</option>
                    <option value="VAT_ZERO">Zero Rated (0%)</option>
                    <option value="VAT_EXEMPT">Exempt (0%)</option>
                  </select>
                </FormControl>
                <p className="text-xs text-muted-foreground mt-1">
                  MRA-compliant tax categories for invoice reporting
                </p>
                <FormMessage />
              </FormItem>
            );
          }}
        />
        <FormField
          control={form.control}
          name="effective_from"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Effective From</FormLabel>
              <FormControl><Input type="date" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="effective_to"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Effective To (Optional)</FormLabel>
              <FormControl><Input type="date" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="is_active"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <input type="checkbox" {...field} value={field.value ? 'on' : 'off'} checked={field.value} onChange={e => field.onChange(e.target.checked)} />
              </FormControl>
              <FormLabel className="mb-0">Active</FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="submit">{defaultValues ? 'Save Changes' : 'Add Tax Rate'}</Button>
        </DialogFooter>
      </form>
    </Form>
  );
};

export default function TaxesSettingsPage() {
  const { business } = useAuth();
  const { accessCheck, isLoading: isLoadingAccess } = useSubscriptionFeatureAccess('tax_management');
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [isTaxModalOpen, setTaxModalOpen] = useState(false);
  const [editingTax, setEditingTax] = useState<TaxRate | undefined>(undefined);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState('');

  const lockedTaxSignatures = useLiveQuery(async () => {
    const [orders, mappings] = await Promise.all([
      db.orders.toArray(),
      db.mraMappings.toArray(),
    ]);

    const soldInventoryIds = new Set<string>();
    for (const order of orders || []) {
      const status = String((order as any)?.status ?? '').toLowerCase();
      if (status === 'voided' || status === 'cancelled') continue;
      const items = Array.isArray(order?.items) ? order.items : [];
      for (const item of items) {
        const inventoryId = String(item?.inventoryItemId ?? item?.inventory_item_id ?? item?.id ?? '').trim();
        if (inventoryId) {
          soldInventoryIds.add(inventoryId);
        }
      }
    }

    if (soldInventoryIds.size === 0) {
      return new Set<string>();
    }

    const signatures = new Set<string>();
    for (const mapping of mappings || []) {
      const inventoryId = resolveMappingInventoryItemId(mapping);
      if (!inventoryId || !soldInventoryIds.has(inventoryId)) continue;

      const taxType = normalizeMappingTaxType(
        mapping.mraTaxType ??
        mapping.mra_tax_type ??
        mapping.taxType ??
        mapping.tax_type
      );
      const taxRate = mapping.mraTaxRate ?? mapping.mra_tax_rate ?? mapping.taxRate ?? mapping.tax_rate ?? 0;
      signatures.add(buildTaxSignature(taxType, taxRate));
    }

    return signatures;
  }, [business?.id]);

  const isTaxLocked = useCallback((tax: TaxRate): boolean => {
    if (tax.isLocked) return true;
    if (!lockedTaxSignatures) return false;
    const signature = buildTaxSignature(normalizeTaxTypeForMapping(tax.taxType), tax.rate);
    return lockedTaxSignatures.has(signature);
  }, [lockedTaxSignatures]);

  const reconcileLocalTaxes = useCallback(async (backendTaxes: TaxRate[]) => {
    if (!business?.id) return;

    const nowIso = new Date().toISOString();
    const backendIds = new Set(backendTaxes.map((tax) => String(tax.id)));

    await db.transaction('rw', db.taxes, async () => {
      for (const tax of backendTaxes) {
        const existingTax = await db.taxes.get(tax.id);
        await db.taxes.put({
          ...(existingTax || {}),
          id: tax.id,
          businessId: tax.businessId || String(business.id),
          name: tax.name,
          rate: toNumber(tax.rate, 0),
          taxType: normalizeTaxType(tax.taxType),
          isDefault: Boolean(tax.isDefault),
          effectiveFrom: tax.effectiveFrom || nowIso.split('T')[0],
          effectiveTo: tax.effectiveTo || undefined,
          isActive: tax.isActive !== false,
          createdAt: tax.createdAt || nowIso,
          updatedAt: tax.updatedAt || nowIso,
          _dirty: false,
          _operation: undefined,
          _synced_at: nowIso,
        });
      }

      const localTaxes = await db.taxes.toArray();
      const staleTaxes = localTaxes.filter((localTax) => {
        const localBusinessId = String(localTax.businessId || '').trim();
        if (localBusinessId && localBusinessId !== String(business.id)) {
          return false;
        }
        if (backendIds.has(String(localTax.id))) {
          return false;
        }
        return !localTax._dirty;
      });

      if (staleTaxes.length > 0) {
        await db.taxes.bulkDelete(staleTaxes.map((tax) => tax.id));
        console.log(
          '[TaxesPage] Removed stale local tax rates:',
          staleTaxes.map((tax) => tax.id)
        );
      }
    });
  }, [business?.id]);

  const refreshTaxesFromBackend = useCallback(async (showErrorToast = true) => {
    if (!business?.id || isLoadingAccess || !accessCheck.allowed) {
      setTaxRates([]);
      return;
    }

    try {
      const response = await authFetch.fetch<any>(TAX_RATES_ENDPOINT);
      const formattedTaxes = extractTaxRows(response)
        .map((tax) => normalizeBackendTaxRate(tax, String(business.id)))
        .filter((tax) => Boolean(tax.id));

      console.log('[TaxesPage] Fetched from backend:', formattedTaxes);
      setTaxRates(formattedTaxes);
      await reconcileLocalTaxes(formattedTaxes);
    } catch (error) {
      console.error('[TaxesPage] Backend fetch failed:', error);
      if (showErrorToast) {
        toast({ variant: 'destructive', title: 'Error', description: 'Failed to load tax rates' });
      }
      setTaxRates([]);
    }
  }, [accessCheck.allowed, business?.id, isLoadingAccess, reconcileLocalTaxes]);

  useEffect(() => {
    if (!business?.id || isLoadingAccess || !accessCheck.allowed) {
      setTaxRates([]);
      return;
    }

    void refreshTaxesFromBackend();
  }, [accessCheck.allowed, business?.id, isLoadingAccess, refreshTaxesFromBackend]);

  // Initialize sync listener on component mount
  useEffect(() => {
    console.log('[Tax] Initializing sync listener');
    syncService.setupConnectivityListener();
  }, []);

  // Manual sync handler
  const handleManualSync = async () => {
    setIsSyncing(true);
    setSyncStatus('syncing');
    setSyncMessage('Syncing tax rates...');

    try {
      const branchId = localStorage.getItem('handypos-active-branch');
      if (!branchId) {
        setSyncStatus('error');
        setSyncMessage('No branch selected');
        setIsSyncing(false);
        return;
      }

      console.log('[Tax] Starting manual sync for branch:', branchId);
      await syncService.performFullSync(branchId);
      await refreshTaxesFromBackend(false);

      setSyncStatus('success');
      setSyncMessage('Tax rates synced successfully');
      toast({ title: 'Sync completed', description: 'Tax rates have been synced to the backend' });

      // Reset status after 3 seconds
      setTimeout(() => {
        setSyncStatus('idle');
        setSyncMessage('');
      }, 3000);
    } catch (error) {
      console.error('[Tax] Sync failed:', error);
      setSyncStatus('error');
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed');
      toast({
        variant: 'destructive',
        title: 'Sync failed',
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTaxSubmit = async (data: TaxRateFormValues) => {
    if (!business?.id) {
      toast({ variant: 'destructive', title: 'Error', description: 'Business not found' });
      return;
    }

    const payload = {
      name: data.name,
      rate: data.rate,
      tax_type: data.tax_type,
      effective_from: data.effective_from,
      effective_to: data.effective_to || null,
      is_active: data.is_active,
    };

    try {
      if (editingTax) {
        console.log('[Tax] Updating tax on backend:', editingTax.id, 'with data:', data);
        await authFetch.fetch<any>(`${TAX_RATES_ENDPOINT}${editingTax.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast({ title: 'Tax Rate Updated' });
      } else {
        console.log('[Tax] Creating new tax on backend with data:', data);
        await authFetch.fetch<any>(TAX_RATES_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast({ title: 'Tax Rate Added' });
      }

      setTaxModalOpen(false);
      setEditingTax(undefined);
      await refreshTaxesFromBackend(false);
    } catch (error) {
      console.error('Failed to save tax rate', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: extractErrorMessage(error, 'Failed to save tax rate'),
      });
    }
  };

  const handleEditTax = (tax: TaxRate) => {
    if (isTaxLocked(tax)) {
      toast({
        variant: 'destructive',
        title: 'Tax rate locked',
        description: 'This tax rate is linked to products with sales and cannot be edited.',
      });
      return;
    }

    setEditingTax(tax);
    setTaxModalOpen(true);
  };

  const handleDeleteTax = async (tax: TaxRate) => {
    if (isTaxLocked(tax)) {
      toast({
        variant: 'destructive',
        title: 'Tax rate locked',
        description: 'This tax rate is linked to products with sales and cannot be deleted.',
      });
      return;
    }

    const taxId = tax.id;
    if (!confirm('Are you sure you want to delete this tax rate?')) return;

    try {
      console.log('[Tax] Deleting tax on backend:', taxId);

      let deleteSuccess = false;
      try {
        await authFetch.fetch<any>(`${TAX_RATES_ENDPOINT}${taxId}/`, { method: 'DELETE' });
        deleteSuccess = true;
      } catch (deleteError: any) {
        if (
          deleteError?.message?.includes('JSON') ||
          deleteError?.status === 204 ||
          deleteError?.status === 404
        ) {
          console.log('[Tax] Tax deleted successfully (204 No Content)');
          deleteSuccess = true;
        } else {
          throw deleteError;
        }
      }

      if (!deleteSuccess) return;

      console.log('[Tax] Tax deleted on backend');
      await db.taxes.delete(taxId);
      toast({ title: 'Tax Rate Deleted' });

      // Optimistic update for immediate feedback.
      setTaxRates((prevTaxes) => prevTaxes.filter((tax) => tax.id !== taxId));

      try {
        await refreshTaxesFromBackend(false);
      } catch (refreshError) {
        console.error('[Tax] Failed to refresh after delete:', refreshError);
      }
    } catch (error) {
      console.error('[Tax] Backend delete failed:', error);
      const description = extractErrorMessage(error, 'Failed to delete tax rate');
      toast({
        variant: 'destructive',
        title: 'Error',
        description,
      });
    }
  };

  const handleSetDefaultTax = async (taxId: string) => {
    try {
      console.log('[Tax] Setting default tax on backend:', taxId);
      const defaultEndpoints = [
        `${TAX_RATES_ENDPOINT}${taxId}/set_default/`,
        `${TAX_RATES_ENDPOINT}${taxId}/set-default/`,
      ];

      let lastError: unknown;
      let updated = false;
      for (const endpoint of defaultEndpoints) {
        try {
          await authFetch.fetch<any>(endpoint, { method: 'POST' });
          updated = true;
          break;
        } catch (setDefaultError: any) {
          // Some backends return 204 with empty body, which may throw JSON parse errors.
          if (setDefaultError?.message?.includes('JSON') || setDefaultError?.status === 204) {
            updated = true;
            break;
          }
          if (setDefaultError?.status === 404) {
            lastError = setDefaultError;
            continue;
          }
          throw setDefaultError;
        }
      }

      if (!updated) {
        throw lastError ?? new Error('Unable to set default tax rate');
      }

      toast({ title: 'Default Tax Rate Updated' });
      await refreshTaxesFromBackend(false);
    } catch (error) {
      console.error('[Tax] Backend set default failed:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to set default tax rate' });
    }
  };

  const handleTaxModalOpenChange = (open: boolean) => {
    setTaxModalOpen(open);
    if (!open) {
      setEditingTax(undefined);
    }
  };

    if (isLoadingAccess) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!accessCheck.allowed) {
        return (
            <SubscriptionFeatureDisabledCard
                featureName="tax_management"
                accessCheck={accessCheck}
            />
        );
    }

    return (
        <>
            <Card>
              <CardHeader className="flex flex-col gap-4">
                <div className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>Tax Rate Management</CardTitle>
                    <CardDescription>
                      Define tax rates to be applied to sales and invoices.
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      onClick={handleManualSync} 
                      disabled={isSyncing}
                      variant="outline"
                      size="sm"
                    >
                      <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                      {isSyncing ? 'Syncing...' : 'Sync Now'}
                    </Button>
                    <Button onClick={() => setTaxModalOpen(true)}>
                      <PlusCircle className="mr-2 h-4 w-4" /> New Tax Rate
                    </Button>
                  </div>
                </div>
                {syncMessage && (
                  <div className={`text-sm px-3 py-2 rounded ${
                    syncStatus === 'success' ? 'bg-green-100 text-green-800' :
                    syncStatus === 'error' ? 'bg-red-100 text-red-800' :
                    'bg-blue-100 text-blue-800'
                  }`}>
                    {syncMessage}
                  </div>
                )}
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tax Name</TableHead>
                        <TableHead>Rate (%)</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Effective From</TableHead>
                        <TableHead>Effective To</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Default</TableHead>
                        <TableHead className="w-16 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {taxRates && taxRates.length > 0 ? (
                        taxRates.map((tax) => {
                          const locked = isTaxLocked(tax);
                          return (
                          <TableRow key={tax.id}>
                            <TableCell className="font-medium">{tax.name}</TableCell>
                            <TableCell>{tax.rate.toFixed(2)}%</TableCell>
                            <TableCell>
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                tax.taxType === 'VAT_STANDARD' ? 'bg-blue-100 text-blue-800' :
                                tax.taxType === 'VAT_ZERO' ? 'bg-green-100 text-green-800' :
                                'bg-gray-100 text-gray-800'
                              }`}>
                                {tax.taxType === 'VAT_STANDARD' ? 'Standard' :
                                 tax.taxType === 'VAT_ZERO' ? 'Zero-Rated' :
                                 'Exempt'}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {tax.effectiveFrom ? new Date(tax.effectiveFrom).toLocaleDateString() : '-'}
                            </TableCell>
                            <TableCell className="text-sm">
                              {tax.effectiveTo ? new Date(tax.effectiveTo).toLocaleDateString() : 'Ongoing'}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                <span className={`px-2 py-1 rounded text-xs font-medium ${
                                  tax.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                                }`}>
                                  {tax.isActive ? 'Active' : 'Inactive'}
                                </span>
                                {locked && (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-amber-100 text-amber-800">
                                    <Lock className="h-3 w-3" />
                                    Locked
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {tax.isDefault ? (
                                <Check className="h-5 w-5 text-green-600" />
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleSetDefaultTax(tax.id)}
                                >
                                  Set as Default
                                </Button>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon">
                                    <MoreHorizontal />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => handleEditTax(tax)}
                                    disabled={locked}
                                  >
                                    <Edit className="mr-2" /> Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDeleteTax(tax)}
                                    disabled={locked}
                                    className="text-destructive"
                                  >
                                    <Trash2 className="mr-2" /> Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        )})
                      ) : (
                        <TableRow>
                          <TableCell colSpan={8} className="h-24 text-center">
                            No tax rates found. Click "New Tax Rate" to begin.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <Dialog open={isTaxModalOpen} onOpenChange={handleTaxModalOpenChange}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{editingTax ? 'Edit Tax Rate' : 'Add New Tax Rate'}</DialogTitle>
                        <DialogDescription>
                        {editingTax ? 'Update the details for this tax rate.' : 'Create a new tax rate for your business.'}
                        </DialogDescription>
                    </DialogHeader>
                    <TaxForm
                        onFormSubmit={handleTaxSubmit}
                        defaultValues={editingTax}
                    />
                </DialogContent>
            </Dialog>
        </>
    )
}
