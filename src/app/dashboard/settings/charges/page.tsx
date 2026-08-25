'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Edit, Loader2, MoreHorizontal, PlusCircle, RefreshCw, Trash2 } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { db, type BusinessCharge } from '@/lib/db';
import { syncService } from '@/lib/services/sync-service';
import { useAuth } from '@/hooks/use-auth';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { toast } from '@/hooks/use-toast';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const CHARGES_ENDPOINT = '/business/charges/';

const chargeSchema = z.object({
  name: z.string().min(2, 'Charge name is required.'),
  chargeType: z.enum(['LEVY', 'SERVICE_CHARGE', 'OTHER']).default('LEVY'),
  rate: z.number().min(0, 'Rate must be positive.').max(100, 'Rate cannot exceed 100.'),
  calculationMethod: z.enum(['exclusive', 'inclusive']).default('exclusive'),
  calculationBase: z.enum(['net_subtotal', 'gross_total']).default('net_subtotal'),
  autoApply: z.boolean().default(true),
  isActive: z.boolean().default(true),
  effectiveFrom: z.string().min(1, 'Effective from date is required.'),
  effectiveTo: z.string().optional(),
});

type ChargeFormValues = z.infer<typeof chargeSchema>;

const today = () => new Date().toISOString().split('T')[0];

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeCharge = (charge: any, businessId: string): BusinessCharge => ({
  id: String(charge?.id ?? '').trim(),
  businessId: String(charge?.business_id ?? charge?.businessId ?? charge?.business ?? businessId).trim() || businessId,
  name: String(charge?.name ?? 'Charge').trim() || 'Charge',
  chargeType: ['LEVY', 'SERVICE_CHARGE', 'OTHER'].includes(String(charge?.charge_type ?? charge?.chargeType).toUpperCase())
    ? String(charge?.charge_type ?? charge?.chargeType).toUpperCase() as BusinessCharge['chargeType']
    : 'LEVY',
  rate: toNumber(charge?.rate, 0),
  calculationMethod: String(charge?.calculation_method ?? charge?.calculationMethod).toLowerCase() === 'inclusive' ? 'inclusive' : 'exclusive',
  calculationBase: String(charge?.calculation_base ?? charge?.calculationBase).toLowerCase() === 'gross_total' ? 'gross_total' : 'net_subtotal',
  autoApply: (charge?.auto_apply ?? charge?.autoApply ?? true) !== false,
  isActive: (charge?.is_active ?? charge?.isActive ?? true) !== false,
  effectiveFrom: String(charge?.effective_from ?? charge?.effectiveFrom ?? today()).trim() || today(),
  effectiveTo: String(charge?.effective_to ?? charge?.effectiveTo ?? '').trim() || undefined,
  createdAt: String(charge?.created_at ?? charge?.createdAt ?? new Date().toISOString()),
  updatedAt: String(charge?.updated_at ?? charge?.updatedAt ?? new Date().toISOString()),
});

const toBackendPayload = (values: ChargeFormValues) => ({
  name: values.name,
  charge_type: values.chargeType,
  rate: values.rate,
  calculation_method: values.calculationMethod,
  calculation_base: values.calculationBase,
  auto_apply: values.autoApply,
  is_active: values.isActive,
  effective_from: values.effectiveFrom,
  effective_to: values.effectiveTo || null,
});

function ChargeForm({
  defaultValues,
  onSubmit,
}: {
  defaultValues?: BusinessCharge;
  onSubmit: (values: ChargeFormValues) => void;
}) {
  const form = useForm<ChargeFormValues>({
    resolver: zodResolver(chargeSchema),
    defaultValues: {
      name: '',
      chargeType: 'LEVY',
      rate: 0,
      calculationMethod: 'exclusive',
      calculationBase: 'net_subtotal',
      autoApply: true,
      isActive: true,
      effectiveFrom: today(),
      effectiveTo: '',
    },
  });

  useEffect(() => {
    form.reset(defaultValues ? {
      name: defaultValues.name,
      chargeType: defaultValues.chargeType,
      rate: defaultValues.rate,
      calculationMethod: defaultValues.calculationMethod,
      calculationBase: defaultValues.calculationBase,
      autoApply: defaultValues.autoApply,
      isActive: defaultValues.isActive,
      effectiveFrom: defaultValues.effectiveFrom,
      effectiveTo: defaultValues.effectiveTo || '',
    } : {
      name: '',
      chargeType: 'LEVY',
      rate: 0,
      calculationMethod: 'exclusive',
      calculationBase: 'net_subtotal',
      autoApply: true,
      isActive: true,
      effectiveFrom: today(),
      effectiveTo: '',
    });
  }, [defaultValues, form]);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 py-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl><Input placeholder="e.g., Tourism Levy" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="chargeType" render={({ field }) => (
            <FormItem>
              <FormLabel>Type</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="LEVY">Levy</SelectItem>
                  <SelectItem value="SERVICE_CHARGE">Service charge</SelectItem>
                  <SelectItem value="OTHER">Other charge</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
          )} />
          <FormField control={form.control} name="rate" render={({ field }) => (
            <FormItem>
              <FormLabel>Rate (%)</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" placeholder="1.00" value={field.value ?? ''} onChange={(event) => field.onChange(toNumber(event.target.value, 0))} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="calculationBase" render={({ field }) => (
            <FormItem>
              <FormLabel>Calculate From</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="net_subtotal">Net subtotal before VAT</SelectItem>
                  <SelectItem value="gross_total">Gross total after VAT</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
          )} />
          <FormField control={form.control} name="calculationMethod" render={({ field }) => (
            <FormItem>
              <FormLabel>Method</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="exclusive">Add on top of sale</SelectItem>
                  <SelectItem value="inclusive">Included in sale price</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
          )} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="effectiveFrom" render={({ field }) => (
            <FormItem>
              <FormLabel>Effective From</FormLabel>
              <FormControl><Input type="date" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="effectiveTo" render={({ field }) => (
            <FormItem>
              <FormLabel>Effective To</FormLabel>
              <FormControl><Input type="date" {...field} /></FormControl>
            </FormItem>
          )} />
        </div>
        <div className="grid gap-3 rounded-md border p-3">
          <FormField control={form.control} name="autoApply" render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <div>
                <FormLabel>Auto Apply</FormLabel>
                <FormDescription>Apply this charge automatically on sales while active.</FormDescription>
              </div>
              <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="isActive" render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <FormLabel>Active</FormLabel>
              <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
            </FormItem>
          )} />
        </div>
        <DialogFooter>
          <Button type="submit">{defaultValues ? 'Save Charge' : 'Add Charge'}</Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

export default function ChargesSettingsPage() {
  const { business } = useAuth();
  const { accessCheck, isLoading } = useSubscriptionFeatureAccess('tax_management');
  const [charges, setCharges] = useState<BusinessCharge[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCharge, setEditingCharge] = useState<BusinessCharge | undefined>();
  const [isSyncing, setIsSyncing] = useState(false);

  const refreshCharges = useCallback(async () => {
    if (!business?.id || !accessCheck.allowed) {
      setCharges([]);
      return;
    }
    const response = await authFetch.fetch<any>(CHARGES_ENDPOINT);
    const rows = Array.isArray(response) ? response : Array.isArray(response?.results) ? response.results : [];
    const normalized = rows.map((row) => normalizeCharge(row, String(business.id))).filter((row) => row.id);
    setCharges(normalized);

    const nowIso = new Date().toISOString();
    await db.transaction('rw', db.charges, async () => {
      for (const charge of normalized) {
        const existing = await db.charges.get(charge.id);
        await db.charges.put({
          ...(existing || {}),
          ...charge,
          _dirty: false,
          _operation: undefined,
          _synced_at: nowIso,
        });
      }
    });
  }, [accessCheck.allowed, business?.id]);

  useEffect(() => {
    if (!isLoading) {
      void refreshCharges().catch((error) => {
        console.error('[Charges] Failed to load charges:', error);
        toast({ variant: 'destructive', title: 'Could not load charges and levies' });
      });
    }
  }, [isLoading, refreshCharges]);

  const handleSave = async (values: ChargeFormValues) => {
    try {
      const payload = toBackendPayload(values);
      if (editingCharge) {
        await authFetch.fetch(`${CHARGES_ENDPOINT}${editingCharge.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast({ title: 'Charge updated' });
      } else {
        await authFetch.fetch(CHARGES_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast({ title: 'Charge added' });
      }
      setEditingCharge(undefined);
      setIsDialogOpen(false);
      await refreshCharges();
    } catch (error) {
      console.error('[Charges] Failed to save charge:', error);
      toast({ variant: 'destructive', title: 'Could not save charge' });
    }
  };

  const handleDelete = async (charge: BusinessCharge) => {
    if (!confirm(`Delete ${charge.name}?`)) return;
    try {
      await authFetch.fetch(`${CHARGES_ENDPOINT}${charge.id}/`, { method: 'DELETE' });
      await db.charges.delete(charge.id);
      setCharges((current) => current.filter((item) => item.id !== charge.id));
      toast({ title: 'Charge deleted' });
    } catch (error) {
      console.error('[Charges] Failed to delete charge:', error);
      toast({ variant: 'destructive', title: 'Could not delete charge' });
    }
  };

  const handleSync = async () => {
    const branchId = localStorage.getItem('handypos-active-branch');
    if (!branchId) return;
    setIsSyncing(true);
    try {
      await syncService.performFullSync(branchId);
      await refreshCharges();
      toast({ title: 'Charges synced' });
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return <div className="flex min-h-60 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!accessCheck.allowed) {
    return <SubscriptionFeatureDisabledCard featureName="tax_management" accessCheck={accessCheck} />;
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Charges & Levies</CardTitle>
            <CardDescription>Configure charges that can apply separately from VAT.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSync} disabled={isSyncing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
              Sync
            </Button>
            <Button onClick={() => { setEditingCharge(undefined); setIsDialogOpen(true); }}>
              <PlusCircle className="mr-2 h-4 w-4" />
              New Charge
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Base</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {charges.map((charge) => (
                  <TableRow key={charge.id}>
                    <TableCell className="font-medium">{charge.name}</TableCell>
                    <TableCell>{charge.chargeType === 'SERVICE_CHARGE' ? 'Service charge' : charge.chargeType === 'OTHER' ? 'Other' : 'Levy'}</TableCell>
                    <TableCell>{charge.rate.toFixed(2)}%</TableCell>
                    <TableCell>{charge.calculationBase === 'gross_total' ? 'Gross total' : 'Net subtotal'}</TableCell>
                    <TableCell>{charge.isActive ? 'Active' : 'Inactive'}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { setEditingCharge(charge); setIsDialogOpen(true); }}>
                            <Edit className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={() => void handleDelete(charge)}>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {charges.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No charges or levies configured.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) setEditingCharge(undefined); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingCharge ? 'Edit Charge' : 'New Charge'}</DialogTitle>
            <DialogDescription>Charges are stored separately from VAT so reports and receipts stay clear.</DialogDescription>
          </DialogHeader>
          <ChargeForm defaultValues={editingCharge} onSubmit={handleSave} />
        </DialogContent>
      </Dialog>
    </>
  );
}
