

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm, useFieldArray } from 'react-hook-form';
import {
  FileSignature,
  FileText,
  Eye,
  PlusCircle,
  MoreHorizontal,
  Trash2,
  Calendar as CalendarIcon,
  X,
  Plus,
  Loader2,
  Download,
} from 'lucide-react';
import { format } from 'date-fns';

import { db, type Invoice, type Customer, type InventoryItem, type TaxRate, type Subscription } from '@/lib/db';
import { authFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { generateInvoicePDF } from '@/lib/invoice-pdf';
import { fetchCurrentSubscription } from '@/lib/subscription-cache';
import { canUseInvoicing } from '@/lib/subscription-access';
import { getOfflineBusinessProfile } from '@/lib/business-profile';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch',
    BUSINESS_SETTINGS: 'handypos-business-settings',
};

type InvoiceFormValues = {
  customerId: string;
  issueDate: Date;
  dueDate: Date;
  items: {
    productId: string;
    name: string;
    quantity: number;
    price: number;
  }[];
  notes?: string;
};

type BillingDocumentType = 'Invoice' | 'Quotation';

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getBackendBranchId = (branchId: string | null): number | null => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return null;

  const branchIdMatch = normalized.match(/\d+/);
  const parsed = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(normalized, 10);

  return Number.isFinite(parsed) ? parsed : null;
};

const getTextValue = (...values: unknown[]): string => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
};

const getStoredBusinessSettings = (): Record<string, any> => {
  if (typeof window === 'undefined') return {};

  try {
    const storedSettings = localStorage.getItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS);
    const parsedSettings = storedSettings ? JSON.parse(storedSettings) : {};
    return parsedSettings && typeof parsedSettings === 'object' ? parsedSettings : {};
  } catch (error) {
    console.warn('[Invoicing] Failed to read stored business settings:', error);
    return {};
  }
};

const resolveBusinessProfileForExport = async (authBusiness: any) => {
  const [offlineBusiness, storedSettings] = await Promise.all([
    getOfflineBusinessProfile(),
    Promise.resolve(getStoredBusinessSettings()),
  ]);

  return {
    name: getTextValue(storedSettings.businessName, offlineBusiness?.name, authBusiness?.name, 'Your Business Name'),
    type: getTextValue(storedSettings.businessType, offlineBusiness?.type, authBusiness?.type),
    currency: getTextValue(storedSettings.currency, offlineBusiness?.currency, authBusiness?.currency, 'MWK'),
    email: getTextValue(storedSettings.email, offlineBusiness?.email),
    phone: getTextValue(storedSettings.phone, offlineBusiness?.phone),
    address: getTextValue(storedSettings.address, offlineBusiness?.address, 'Your Business Address'),
    website: getTextValue(storedSettings.website, offlineBusiness?.website),
    tin: getTextValue(storedSettings.tin, storedSettings.tax_pin, storedSettings.taxPin, (offlineBusiness as any)?.tin),
    vatRegistrationNumber: getTextValue(
      storedSettings.vatRegistrationNumber,
      storedSettings.vat_registration_number,
      (offlineBusiness as any)?.vatRegistrationNumber,
      (offlineBusiness as any)?.vat_registration_number
    ),
    vatRegistered: storedSettings.vatRegistered ?? storedSettings.vat_registered ?? (offlineBusiness as any)?.vatRegistered ?? (offlineBusiness as any)?.vat_registered,
    mraTaxpayerType: getTextValue(
      storedSettings.mraTaxpayerType,
      storedSettings.mra_taxpayer_type,
      (offlineBusiness as any)?.mraTaxpayerType,
      (offlineBusiness as any)?.mra_taxpayer_type
    ),
  };
};

const hasNumericValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
};

const toInvoiceItem = (line: any) => {
  const quantity = toNumber(line?.quantity, 0);
  const price = toNumber(line?.unit_price, 0);

  return {
    id: String(line?.product_code || line?.id || ''),
    productId: String(line?.product_code || ''),
    name: String(line?.product_name || 'Item'),
    quantity,
    price,
    total: toNumber(line?.total_amount, quantity * price),
  };
};

const mapBackendInvoice = (invoice: any, fallbackBranchId: string): Invoice => {
  const lines = Array.isArray(invoice?.lines) ? invoice.lines : [];
  const documentType: BillingDocumentType = invoice.document_type === 'Quotation' ? 'Quotation' : 'Invoice';
  const status = invoice.status || 'Draft';
  const total = toNumber(invoice.total, 0);

  return {
    id: String(invoice.id),
    invoiceNumber: toNumber(invoice.invoice_number, 0),
    documentType,
    branchId: fallbackBranchId,
    customerId: String(invoice.customer || ''),
    customerName: String(invoice.customer_name || invoice.customer_name_display || 'Customer'),
    status,
    approvalStatus: invoice.approval_status,
    items: lines.map(toInvoiceItem),
    subtotal: toNumber(invoice.subtotal, 0),
    tax: toNumber(invoice.tax, 0),
    total,
    paidAmount: toNumber(invoice.paid_amount ?? invoice.paidAmount, status === 'Paid' ? total : 0),
    balanceDue: toNumber(
      invoice.balance_due ?? invoice.balanceDue,
      documentType === 'Invoice' && status === 'Sent' ? total : 0
    ),
    customerCurrentBalance: hasNumericValue(invoice.customer_current_balance ?? invoice.customerCurrentBalance)
      ? toNumber(invoice.customer_current_balance ?? invoice.customerCurrentBalance, 0)
      : undefined,
    customerAvailableCredit: hasNumericValue(invoice.customer_available_credit ?? invoice.customerAvailableCredit)
      ? toNumber(invoice.customer_available_credit ?? invoice.customerAvailableCredit, 0)
      : null,
    issueDate: invoice.issue_date || new Date().toISOString(),
    dueDate: invoice.due_date || new Date().toISOString(),
    notes: invoice.notes || '',
    relatedOrderId: invoice.related_order_id || undefined,
    approvedBy: invoice.approved_by || undefined,
    approvedAt: invoice.approved_at || undefined,
    createdAt: invoice.created_at || new Date().toISOString(),
    updatedAt: invoice.updated_at || undefined,
    _synced_at: new Date().toISOString(),
  };
};

const InvoiceForm = ({
  onFormSubmit,
  onDocumentSaved,
  customers,
  products,
  defaultTaxRate,
  documentType,
}: {
  onFormSubmit: () => void;
  onDocumentSaved?: (invoice: Invoice, rawInvoice: any) => Promise<void> | void;
  customers: Customer[];
  products: InventoryItem[];
  defaultTaxRate?: TaxRate;
  documentType: BillingDocumentType;
}) => {
  const [activeBranchId, setActiveBranchId] = useState('main');
  const [isLoading, setIsLoading] = useState(false);
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const { format: formatCurrency } = useCurrency();

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  const form = useForm<InvoiceFormValues>({
    defaultValues: {
      issueDate: new Date(),
      dueDate: new Date(new Date().setDate(new Date().getDate() + 30)),
      items: [{ productId: '', name: '', quantity: 1, price: 0 }],
    },
  });

  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: 'items',
  });
  
  const taxRate = defaultTaxRate ? defaultTaxRate.rate / 100 : 0;
  const taxLabel = defaultTaxRate ? `${defaultTaxRate.name} (${defaultTaxRate.rate}%)` : 'Tax';
  const filteredProducts = useMemo(() => {
    const query = productSearchQuery.trim().toLowerCase();
    const sortedProducts = [...products].sort((a, b) => a.name.localeCompare(b.name));
    if (!query) return sortedProducts;
    return sortedProducts.filter((product) => {
      const haystack = [
        product.name,
        product.category,
        product.sku,
        product.barcode,
        product.productCode,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [products, productSearchQuery]);

  const { subtotal, tax, total } = useMemo(() => {
    const items = form.watch('items');
    const sub = items.reduce((acc, item) => acc + (item.quantity * item.price), 0);
    const taxAmount = sub * taxRate;
    return { subtotal: sub, tax: taxAmount, total: sub + taxAmount };
  }, [form.watch('items'), taxRate]);

  const onSubmit = async (data: InvoiceFormValues) => {
    setIsLoading(true);
    try {
      const selectedCustomer = customers.find(c => c.id === data.customerId);
      if (!selectedCustomer) {
        throw new Error('Customer not found');
      }

      const branchBackendId = getBackendBranchId(activeBranchId);
      if (branchBackendId === null) {
        throw new Error('Invalid branch selected');
      }

      const lines = data.items.map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.price);
        const lineSubtotal = quantity * unitPrice;
        const taxAmount = lineSubtotal * taxRate;

        return {
          product_code: item.productId,
          product_name: item.name,
          quantity,
          unit_price: unitPrice,
          tax_rate: defaultTaxRate?.rate || 0,
          tax_amount: Number(taxAmount.toFixed(2)),
          total_amount: Number((lineSubtotal + taxAmount).toFixed(2)),
        };
      });

      const invoicePayload = {
        document_type: documentType,
        branch: branchBackendId,
        customer: selectedCustomer.id,
        customer_name: selectedCustomer.name,
        status: 'Draft',
        lines,
        subtotal: Number(subtotal.toFixed(2)),
        tax: Number(tax.toFixed(2)),
        total: Number(total.toFixed(2)),
        issue_date: data.issueDate.toISOString(),
        due_date: data.dueDate.toISOString(),
        notes: data.notes || '',
      };

      // Send to backend
      const backendInvoice = await authFetch.fetch('/business/invoices/', {
        method: 'POST',
        body: JSON.stringify(invoicePayload),
        meta: {
          domain: 'sales',
          entityType: 'invoice',
          metadata: { action: 'create' },
        },
      });

      // Store in local DB with sync metadata
      const newInvoice: Invoice = mapBackendInvoice(backendInvoice, activeBranchId);

      await db.invoices.put(newInvoice);
      await onDocumentSaved?.(newInvoice, backendInvoice);
      toast({
        title: `${documentType} #${newInvoice.invoiceNumber} Created`,
        description: documentType === 'Quotation'
          ? 'You can send it to the customer and convert it to an invoice later.'
          : 'Invoice saved. Record payment when the customer pays.',
      });
      onFormSubmit();
      form.reset();
    } catch (error) {
      console.error('Failed to save invoice:', error);
      toast({ 
        variant: 'destructive', 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to create invoice'
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
                control={form.control}
                name="customerId"
                rules={{ required: 'Please select a customer.'}}
                render={({ field }) => (
                    <FormItem className="md:col-span-1">
                    <FormLabel>Customer</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                        <SelectTrigger>
                            <SelectValue placeholder="Select a customer" />
                        </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                        {customers.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                            {c.name}
                            </SelectItem>
                        ))}
                        </SelectContent>
                    </Select>
                    <FormMessage />
                    </FormItem>
                )}
            />
             <FormField
                control={form.control}
                name="issueDate"
                render={({ field }) => (
                    <FormItem className="flex flex-col">
                    <FormLabel>Issue Date</FormLabel>
                    <Popover><PopoverTrigger asChild><FormControl>
                        <Button variant="outline" className={cn(!field.value && "text-muted-foreground")}>
                            {field.value ? format(field.value, 'PPP') : <span>Pick a date</span>}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                    </FormControl></PopoverTrigger><PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={field.value} onSelect={field.onChange} initialFocus/>
                    </PopoverContent></Popover>
                    <FormMessage />
                    </FormItem>
                )}
             />
             <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                    <FormItem className="flex flex-col">
                    <FormLabel>Due Date</FormLabel>
                    <Popover><PopoverTrigger asChild><FormControl>
                        <Button variant="outline" className={cn(!field.value && "text-muted-foreground")}>
                            {field.value ? format(field.value, 'PPP') : <span>Pick a date</span>}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                    </FormControl></PopoverTrigger><PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={field.value} onSelect={field.onChange} />
                    </PopoverContent></Popover>
                    <FormMessage />
                    </FormItem>
                )}
            />
        </div>
        
        <Separator />
        
        <div>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-lg font-medium">{documentType} Items</h3>
                <p className="text-sm text-muted-foreground">Search by product name, category, SKU, barcode, or product code.</p>
              </div>
              <Input
                value={productSearchQuery}
                onChange={(event) => setProductSearchQuery(event.target.value)}
                placeholder="Search items..."
                className="sm:max-w-xs"
              />
            </div>
            <div className="space-y-3">
              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-12 gap-2 p-3 border rounded-lg items-start">
                  <div className="col-span-12 sm:col-span-5">
                    <FormField
                      control={form.control}
                      name={`items.${index}.productId`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="sr-only">Product</FormLabel>
                          <Select value={field.value} onValueChange={(value) => {
                            const product = products.find(p => p.id === value);
                            if (product) {
                                field.onChange(value);
                                update(index, { ...form.getValues(`items.${index}`), name: product.name, price: product.price || 0 });
                            }
                          }}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {(() => {
                                const selectedProduct = products.find((product) => product.id === field.value);
                                const rowProducts = selectedProduct && !filteredProducts.some((product) => product.id === selectedProduct.id)
                                  ? [selectedProduct, ...filteredProducts]
                                  : filteredProducts;
                                return rowProducts.length > 0
                                  ? rowProducts.map(p => (
                                    <SelectItem key={p.id} value={p.id}>
                                      {p.name}{p.category ? ` · ${p.category}` : ''}
                                    </SelectItem>
                                  ))
                                  : (
                                    <div className="px-3 py-2 text-sm text-muted-foreground">
                                      No items match your search.
                                    </div>
                                  );
                              })()}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                     <FormField control={form.control} name={`items.${index}.quantity`} render={({ field }) => (
                         <FormItem><FormLabel className="sr-only">Qty</FormLabel><FormControl><Input type="number" placeholder="Qty" {...field} /></FormControl></FormItem>
                     )} />
                  </div>
                   <div className="col-span-4 sm:col-span-2">
                     <FormField control={form.control} name={`items.${index}.price`} render={({ field }) => (
                         <FormItem><FormLabel className="sr-only">Price</FormLabel><FormControl><Input type="number" step="0.01" placeholder="Price" {...field} /></FormControl></FormItem>
                     )} />
                  </div>
                  <div className="col-span-3 sm:col-span-2 flex items-center">
                    <p className="font-medium w-full text-right">{formatCurrency(form.watch(`items.${index}.quantity`) * form.watch(`items.${index}.price`))}</p>
                  </div>
                  <div className="col-span-1 flex items-center justify-end">
                    <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} className="text-destructive"><X className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" onClick={() => append({ productId: '', name: '', quantity: 1, price: 0 })}>
                <Plus className="mr-2 h-4 w-4" /> Add Item
              </Button>
            </div>
        </div>
        
        <Separator />
        
        <div className="flex justify-end">
            <div className="w-full max-w-sm space-y-4">
                <div className="flex justify-between"><span>Subtotal:</span><span className="font-medium">{formatCurrency(subtotal)}</span></div>
                <div className="flex justify-between"><span>{taxLabel}:</span><span className="font-medium">{formatCurrency(tax)}</span></div>
                <div className="flex justify-between text-lg font-bold border-t pt-2"><span>Total:</span><span>{formatCurrency(total)}</span></div>
            </div>
        </div>
        
        <FormField control={form.control} name="notes" render={({ field }) => (
            <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Add any terms or additional details..." {...field} /></FormControl></FormItem>
        )} />

        <DialogFooter>
          <Button type="submit" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save as Draft
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
};

export default function InvoicingPage() {
  const { business, user, loading: isAuthLoading } = useAuth();
  const [isFormOpen, setFormOpen] = useState(false);
  const [documentType, setDocumentType] = useState<BillingDocumentType>('Invoice');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [isRefreshingDocuments, setIsRefreshingDocuments] = useState(false);
  const [activeBranchId, setActiveBranchId] = useState<string>('main');
  const [defaultTaxRate, setDefaultTaxRate] = useState<TaxRate | null>(null);
  const [isLoadingTax, setIsLoadingTax] = useState(true);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(true);
  const { format: formatCurrency } = useCurrency();
  const businessId = business?.id || user?.businessId || null;
  const cachedSubscription = useLiveQuery(() => db.subscriptions.get('sub_main-business'), [businessId]);
  const cachedSubscriptionMatchesBusiness = Boolean(
    cachedSubscription &&
      (!businessId || String(cachedSubscription.businessId || '') === String(businessId))
  );

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  useEffect(() => {
    if (cachedSubscription && cachedSubscriptionMatchesBusiness) {
      setSubscription(cachedSubscription);
      return;
    }

    setSubscription(null);
  }, [businessId, cachedSubscription, cachedSubscriptionMatchesBusiness]);

  // Fetch subscription data for access control
  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    if (!businessId) {
      setIsLoadingSubscription(false);
      return;
    }

    let active = true;

    const fetchSubscription = async () => {
      setIsLoadingSubscription(true);
      try {
        await fetchCurrentSubscription(businessId);
        const localSub = await db.subscriptions.get('sub_main-business');
        if (
          active &&
          localSub &&
          String(localSub.businessId || '') === String(businessId)
        ) {
          setSubscription(localSub);
          console.log('[Invoicing] Subscription loaded:', localSub.status);
        }
      } catch (error) {
        console.error('[Invoicing] Error fetching subscription:', error);
      } finally {
        if (active) {
          setIsLoadingSubscription(false);
        }
      }
    };

    void fetchSubscription();

    return () => {
      active = false;
    };
  }, [businessId, isAuthLoading]);

  // Fetch default tax rate from backend
  useEffect(() => {
    const fetchDefaultTaxRate = async () => {
      setIsLoadingTax(true);
      try {
        const response = await authFetch.fetch('/business/tax-rates/');
        const taxRates = Array.isArray(response) ? response : response.results || [];
        const defaultTax = taxRates.find((t: any) => t.is_default && t.is_active);
        
        if (defaultTax) {
          setDefaultTaxRate({
            id: defaultTax.id.toString(),
            name: defaultTax.name,
            rate: parseFloat(defaultTax.rate),
            taxType: defaultTax.tax_type,
            isDefault: defaultTax.is_default,
            isActive: defaultTax.is_active,
            effectiveFrom: defaultTax.effective_from,
            effectiveTo: defaultTax.effective_to,
            createdAt: defaultTax.created_at,
            updatedAt: defaultTax.updated_at,
          });
          console.log('[Invoicing] Default tax rate loaded:', defaultTax.name, `${defaultTax.rate}%`);
        } else {
          console.log('[Invoicing] No default tax rate found');
        }
      } catch (error) {
        console.error('[Invoicing] Error fetching default tax rate:', error);
        // Fall back to local DB
        try {
          const taxes = await db.taxes.toArray();
          const localDefaultTax = taxes.find(t => t.isDefault);
          if (localDefaultTax) {
            setDefaultTaxRate(localDefaultTax);
            console.log('[Invoicing] Using local default tax rate:', localDefaultTax.name);
          }
        } catch (localError) {
          console.error('[Invoicing] Error fetching from local DB:', localError);
        }
      } finally {
        setIsLoadingTax(false);
      }
    };

    fetchDefaultTaxRate();
  }, []);

  const invoices = useLiveQuery(() => {
    return db.invoices.where('branchId').equals(activeBranchId).toArray()
  }, [activeBranchId]) || [];
  
  const customers = useLiveQuery(() => {
    return db.customers.where('branchId').equals(activeBranchId).toArray()
  }, [activeBranchId]) || [];

  const products = useLiveQuery(() => {
    return db.inventory.where('branchId').equals(activeBranchId).and(item => item.itemType === 'sellable').toArray()
  }, [activeBranchId]) || [];

  const syncCustomerBalanceFromInvoice = async (rawInvoice: any, mappedInvoice?: Invoice) => {
    const customerId = String(rawInvoice?.customer ?? mappedInvoice?.customerId ?? '').trim();
    const balanceValue = rawInvoice?.customer_current_balance ?? rawInvoice?.customerCurrentBalance ?? mappedInvoice?.customerCurrentBalance;

    if (!customerId || !hasNumericValue(balanceValue)) {
      return;
    }

    const currentBalance = toNumber(balanceValue, 0);
    const availableCreditValue =
      rawInvoice?.customer_available_credit ??
      rawInvoice?.customerAvailableCredit ??
      mappedInvoice?.customerAvailableCredit;
    const existingCustomer = await db.customers.get(customerId);
    const creditLimit = existingCustomer?.creditLimit ?? 0;
    const availableCredit = hasNumericValue(availableCreditValue)
      ? toNumber(availableCreditValue, 0)
      : existingCustomer?.availableCredit ?? (creditLimit > 0 ? creditLimit - currentBalance : null);

    await db.customers.put({
      id: customerId,
      businessId: existingCustomer?.businessId,
      branchId: existingCustomer?.branchId || activeBranchId,
      name: existingCustomer?.name || mappedInvoice?.customerName || String(rawInvoice?.customer_name || rawInvoice?.customer_name_display || 'Customer'),
      email: existingCustomer?.email || '',
      phone: existingCustomer?.phone || '',
      address: existingCustomer?.address || '',
      notes: existingCustomer?.notes || '',
      isActive: existingCustomer?.isActive ?? true,
      accountEnabled: existingCustomer?.accountEnabled ?? true,
      creditLimit,
      currentBalance,
      availableCredit,
      hasCreditLimit: existingCustomer?.hasCreditLimit ?? creditLimit > 0,
      customerTin: existingCustomer?.customerTin,
      customer_tin: existingCustomer?.customer_tin,
      vatRegistered: existingCustomer?.vatRegistered,
      vat_registered: existingCustomer?.vat_registered,
      createdAt: existingCustomer?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _dirty: existingCustomer?._dirty ?? false,
      _operation: existingCustomer?._operation,
      _synced_at: existingCustomer?._synced_at,
    });
  };

  useEffect(() => {
    if (!activeBranchId || isAuthLoading) return;

    const branchBackendId = getBackendBranchId(activeBranchId);
    if (branchBackendId === null) return;

    let active = true;

    const fetchBillingDocuments = async () => {
      setIsRefreshingDocuments(true);
      try {
        const response = await authFetch.fetch(`/business/invoices/?branch_id=${branchBackendId}`);
        const documents = Array.isArray(response) ? response : response?.results || [];
        const mappedDocuments = documents.map((invoice: any) => mapBackendInvoice(invoice, activeBranchId));
        if (!active) return;
        await db.invoices.bulkPut(mappedDocuments);
        await Promise.all(
          mappedDocuments.map((mappedInvoice, index) => syncCustomerBalanceFromInvoice(documents[index], mappedInvoice))
        );
      } catch (error) {
        console.error('[Billing] Error refreshing documents:', error);
      } finally {
        if (active) {
          setIsRefreshingDocuments(false);
        }
      }
    };

    void fetchBillingDocuments();

    return () => {
      active = false;
    };
  }, [activeBranchId, isAuthLoading]);
  
  const statusBadge: Record<Invoice['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    Draft: 'outline',
    Sent: 'secondary',
    Paid: 'default',
    Void: 'destructive',
  };

  const getDocumentType = (invoice: Invoice): BillingDocumentType => invoice.documentType || 'Invoice';

  const invoiceDocuments = useMemo(
    () => invoices.filter((invoice) => getDocumentType(invoice) === 'Invoice'),
    [invoices]
  );

  const quotationDocuments = useMemo(
    () => invoices.filter((invoice) => getDocumentType(invoice) === 'Quotation'),
    [invoices]
  );

  const billingSummary = useMemo(() => {
    return invoices.reduce(
      (summary, invoice) => {
        const docType = getDocumentType(invoice);
        if (docType === 'Quotation') {
          summary.quotations += 1;
          summary.quotationValue += invoice.total || 0;
        } else {
          summary.invoices += 1;
          summary.paid += invoice.paidAmount || 0;
          summary.outstanding += invoice.balanceDue || 0;
        }
        return summary;
      },
      { quotations: 0, quotationValue: 0, invoices: 0, paid: 0, outstanding: 0 }
    );
  }, [invoices]);

  const openDocumentForm = (type: BillingDocumentType) => {
    setDocumentType(type);
    setFormOpen(true);
  };

  const handleUpdateStatus = async (invoiceId: string, newStatus: Invoice['status']) => {
    const previousInvoice = invoices.find((invoice) => invoice.id === invoiceId);
    const previousDocumentType = previousInvoice ? getDocumentType(previousInvoice) : 'Invoice';
    try {
      // Update locally first (offline-first)
      await db.invoices.update(invoiceId, { status: newStatus });
      setSelectedInvoice((current) => current?.id === invoiceId ? { ...current, status: newStatus } : current);

      // Then sync to backend with offline-first support
      const response = await authFetch.fetch(`/business/invoices/${invoiceId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
        meta: {
          domain: 'sales',
          entityType: 'invoice',
          entityId: invoiceId,
          metadata: { action: 'status_update', newStatus },
        },
      });

      if (response?.id) {
        const mappedInvoice = mapBackendInvoice(response, activeBranchId);
        await db.invoices.put(mappedInvoice);
        await syncCustomerBalanceFromInvoice(response, mappedInvoice);
        setSelectedInvoice((current) => current?.id === invoiceId ? mappedInvoice : current);
      }
      
      // Show appropriate message based on status change
      if (newStatus === 'Paid') {
        toast({ 
          title: `${previousDocumentType} marked as Paid`,
          description: 'Payment has been recorded. The order is now marked as paid.'
        });
      } else if (newStatus === 'Void') {
        toast({ 
          title: `${previousDocumentType} voided`,
          description: `${previousDocumentType} has been voided. Any related records will be updated.`
        });
      } else if (newStatus === 'Sent') {
        toast({ 
          title: `${previousDocumentType} marked as Sent`,
          description: `${previousDocumentType} has been sent to customer.`
        });
      } else {
        toast({ title: `${previousDocumentType} status updated to ${newStatus}` });
      }
    } catch (error) {
      console.error('[INVOICE] Error updating status:', error);
      // Don't show error if it's queued for sync
      if (error instanceof Error && error.message.includes('queued')) {
        toast({ 
          title: `${previousDocumentType} status update queued`,
          description: 'Will sync when connection is restored.'
        });
      } else {
        if (previousInvoice) {
          await db.invoices.put(previousInvoice);
          setSelectedInvoice((current) => current?.id === invoiceId ? previousInvoice : current);
        }
        toast({ 
          variant: 'destructive', 
          title: 'Error', 
          description: error instanceof Error ? error.message : 'Failed to update invoice'
        });
      }
    }
  };

  const handleConvertToInvoice = async (invoice: Invoice) => {
    const previousInvoice = { ...invoice };
    try {
      await db.invoices.update(invoice.id, { documentType: 'Invoice', status: 'Draft' });
      setSelectedInvoice((current) => current?.id === invoice.id ? { ...current, documentType: 'Invoice', status: 'Draft' } : current);

      const response = await authFetch.fetch(`/business/invoices/${invoice.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ document_type: 'Invoice', status: 'Draft' }),
        meta: {
          domain: 'sales',
          entityType: 'invoice',
          entityId: invoice.id,
          metadata: { action: 'convert_quotation_to_invoice' },
        },
      });

      if (response?.id) {
        const mappedInvoice = mapBackendInvoice(response, activeBranchId);
        await db.invoices.put(mappedInvoice);
        await syncCustomerBalanceFromInvoice(response, mappedInvoice);
        setSelectedInvoice((current) => current?.id === invoice.id ? mappedInvoice : current);
      }

      toast({
        title: 'Quotation converted',
        description: `Document #${invoice.invoiceNumber} is now an invoice.`,
      });
    } catch (error) {
      console.error('[INVOICE] Error converting quotation:', error);
      if (!(error instanceof Error && error.message.includes('queued'))) {
        await db.invoices.put(previousInvoice);
        setSelectedInvoice((current) => current?.id === invoice.id ? previousInvoice : current);
      }
      toast({
        variant: error instanceof Error && error.message.includes('queued') ? 'default' : 'destructive',
        title: error instanceof Error && error.message.includes('queued') ? 'Conversion queued' : 'Conversion failed',
        description: error instanceof Error && error.message.includes('queued')
          ? 'Will sync when connection is restored.'
          : error instanceof Error ? error.message : 'Failed to convert quotation to invoice',
      });
    }
  };

  const handleDeleteInvoice = async (invoiceId: string) => {
    const documentToDelete = invoices.find((invoice) => invoice.id === invoiceId);
    const documentType = documentToDelete ? getDocumentType(documentToDelete) : 'Invoice';

    if (!confirm(`Are you sure you want to delete this ${documentType.toLowerCase()}?`)) return;

    try {
      // Delete locally first (offline-first)
      await db.invoices.delete(invoiceId);

      // Then sync deletion to backend with offline-first support
      await authFetch.fetch(`/business/invoices/${invoiceId}/`, {
        method: 'DELETE',
        meta: {
          domain: 'sales',
          entityType: 'invoice',
          entityId: invoiceId,
          metadata: { action: 'delete' },
        },
      });

      toast({ title: `${documentType} deleted successfully`, variant: 'destructive' });
    } catch (error) {
      console.error('[INVOICE] Error deleting invoice:', error);
      // Don't show error if it's queued for sync
      if (error instanceof Error && error.message.includes('queued')) {
        toast({ 
          title: `${documentType} deletion queued`,
          description: 'Will sync when connection is restored.'
        });
      } else {
        toast({ 
          variant: 'destructive', 
          title: 'Error', 
          description: error instanceof Error ? error.message : `Failed to delete ${documentType.toLowerCase()}`
        });
      }
    }
  };

  const handleExportPDF = async (invoice: Invoice) => {
    try {
      const businessProfile = await resolveBusinessProfileForExport(business);
      await generateInvoicePDF(invoice, businessProfile);
      toast({ title: 'PDF Exported', description: `${getDocumentType(invoice)} #${invoice.invoiceNumber} has been downloaded.` });
    } catch (error) {
      console.error('Error exporting PDF:', error);
      toast({ 
        variant: 'destructive', 
        title: 'Error', 
        description: 'Failed to export invoice as PDF'
      });
    }
  };

  // Check access control
  const accessCheck = canUseInvoicing(subscription);
  const isLoading = isLoadingSubscription || isLoadingTax;
  const renderDocumentsTable = (documents: Invoice[], tabDocumentType: BillingDocumentType) => {
    const isInvoiceTab = tabDocumentType === 'Invoice';
    const emptyMessage = isInvoiceTab
      ? 'No invoices found. Create an invoice to get started.'
      : 'No quotations found. Create a quotation to get started.';

    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              {isInvoiceTab && <TableHead>Payment</TableHead>}
              {isInvoiceTab && <TableHead className="text-right">Balance Due</TableHead>}
              <TableHead>Issue Date</TableHead>
              <TableHead>{isInvoiceTab ? 'Due Date' : 'Valid Until'}</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="w-[50px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.length > 0 ? (
              documents.map((inv) => {
                const rowDocumentType = getDocumentType(inv);

                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">#{inv.invoiceNumber}</TableCell>
                    <TableCell>{inv.customerName}</TableCell>
                    <TableCell><Badge variant={statusBadge[inv.status]}>{inv.status}</Badge></TableCell>
                    {isInvoiceTab && (
                      <TableCell>
                        <Badge variant={inv.status === 'Paid' ? 'default' : 'secondary'}>
                          {inv.status === 'Paid' ? 'Paid' : 'Unpaid'}
                        </Badge>
                      </TableCell>
                    )}
                    {isInvoiceTab && (
                      <TableCell className="text-right font-medium">{formatCurrency(inv.balanceDue || 0)}</TableCell>
                    )}
                    <TableCell>{format(new Date(inv.issueDate), 'PP')}</TableCell>
                    <TableCell>{format(new Date(inv.dueDate), 'PP')}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(inv.total)}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setSelectedInvoice(inv)}>
                            <Eye className="mr-2 h-4 w-4" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleExportPDF(inv)}>
                            <Download className="mr-2 h-4 w-4" /> Export PDF
                          </DropdownMenuItem>
                          {inv.status !== 'Sent' && (
                            <DropdownMenuItem onClick={() => handleUpdateStatus(inv.id, 'Sent')}>
                              Mark as Sent
                            </DropdownMenuItem>
                          )}
                          {rowDocumentType === 'Quotation' && inv.status !== 'Void' && (
                            <DropdownMenuItem onClick={() => handleConvertToInvoice(inv)}>
                              Convert to Invoice
                            </DropdownMenuItem>
                          )}
                          {rowDocumentType === 'Invoice' && inv.status !== 'Paid' && inv.status !== 'Void' && (
                            <DropdownMenuItem onClick={() => handleUpdateStatus(inv.id, 'Paid')}>
                              Record Payment
                            </DropdownMenuItem>
                          )}
                          {inv.status !== 'Void' && inv.status !== 'Paid' && (
                            <DropdownMenuItem onClick={() => handleUpdateStatus(inv.id, 'Void')} className="text-destructive">
                              Void {rowDocumentType}
                            </DropdownMenuItem>
                          )}
                          {inv.status === 'Draft' && (
                            <DropdownMenuItem onClick={() => handleDeleteInvoice(inv.id)} className="text-destructive">
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={isInvoiceTab ? 9 : 7} className="h-48 text-center">
                  <div className="flex flex-col items-center justify-center space-y-4">
                    <FileSignature className="h-16 w-16 text-muted-foreground/30" />
                    <p>{emptyMessage}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground">Create quotations, convert them to invoices, and track customer payments.</p>
        </div>
        <Dialog open={isFormOpen} onOpenChange={setFormOpen}>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={!accessCheck.allowed || isLoading}
              onClick={() => openDocumentForm('Quotation')}
            >
              <FileText className="mr-2 h-4 w-4" /> New Quotation
            </Button>
            <Button disabled={!accessCheck.allowed || isLoading} onClick={() => openDocumentForm('Invoice')}>
              <PlusCircle className="mr-2 h-4 w-4" /> New Invoice
            </Button>
          </div>
          <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
            <DialogHeader className="sticky top-0 bg-background z-10 pt-6">
              <DialogTitle>New {documentType}</DialogTitle>
              <DialogDescription>
                {documentType === 'Quotation'
                  ? 'Prepare pricing for a customer without affecting stock or payment records.'
                  : 'Create an invoice for a customer and record payment later.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto -mx-6 px-6">
                <InvoiceForm
                  onFormSubmit={() => setFormOpen(false)}
                  onDocumentSaved={(savedInvoice, rawInvoice) => syncCustomerBalanceFromInvoice(rawInvoice, savedInvoice)}
                  customers={customers}
                  products={products}
                  defaultTaxRate={defaultTaxRate}
                  documentType={documentType}
                />
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {!accessCheck.allowed && !isLoading && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <h3 className="font-semibold text-amber-900 mb-1">Invoicing Feature Unavailable</h3>
                <p className="text-sm text-amber-800 mb-2">{accessCheck.reason}</p>
                {accessCheck.requiresUpgrade && (
                  <p className="text-sm text-amber-700">
                    Please upgrade your subscription or contact support to enable this feature.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Quotations</CardDescription>
            <CardTitle className="text-2xl">{billingSummary.quotations}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{formatCurrency(billingSummary.quotationValue)} quoted</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Invoices</CardDescription>
            <CardTitle className="text-2xl">{billingSummary.invoices}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Active billing documents</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Paid</CardDescription>
            <CardTitle className="text-2xl">{formatCurrency(billingSummary.paid)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Recorded invoice payments</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Outstanding</CardDescription>
            <CardTitle className="text-2xl">{formatCurrency(billingSummary.outstanding)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Unpaid invoices only</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Documents</CardTitle>
              <CardDescription>
                Invoices and quotations for the active branch.
                {isRefreshingDocuments ? ' Refreshing...' : ''}
              </CardDescription>
            </div>
            {isRefreshingDocuments && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="invoices" className="w-full">
            <TabsList className="grid w-full grid-cols-2 sm:w-[26rem]">
              <TabsTrigger value="invoices">Invoices ({invoiceDocuments.length})</TabsTrigger>
              <TabsTrigger value="quotations">Quotations ({quotationDocuments.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="invoices">
              {renderDocumentsTable(invoiceDocuments, 'Invoice')}
            </TabsContent>
            <TabsContent value="quotations">
              {renderDocumentsTable(quotationDocuments, 'Quotation')}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedInvoice)} onOpenChange={(open) => !open && setSelectedInvoice(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          {selectedInvoice && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {getDocumentType(selectedInvoice)} #{selectedInvoice.invoiceNumber}
                </DialogTitle>
                <DialogDescription>
                  {selectedInvoice.customerName} - {format(new Date(selectedInvoice.issueDate), 'PP')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge className="mt-2" variant={statusBadge[selectedInvoice.status]}>{selectedInvoice.status}</Badge>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    {getDocumentType(selectedInvoice) === 'Invoice' ? 'Due Date' : 'Valid Until'}
                  </p>
                  <p className="mt-2 text-sm font-medium">{format(new Date(selectedInvoice.dueDate), 'PP')}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    {getDocumentType(selectedInvoice) === 'Invoice' ? 'Invoice Balance' : 'Quotation Total'}
                  </p>
                  <p className="mt-2 text-sm font-semibold">
                    {formatCurrency(getDocumentType(selectedInvoice) === 'Invoice' ? selectedInvoice.balanceDue || 0 : selectedInvoice.total)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Customer Balance</p>
                  <p className="mt-2 text-sm font-semibold">
                    {selectedInvoice.customerCurrentBalance === undefined
                      ? 'Not synced'
                      : formatCurrency(selectedInvoice.customerCurrentBalance)}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedInvoice.items.map((item) => (
                      <TableRow key={`${selectedInvoice.id}-${item.productId}-${item.name}`}>
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.price)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="ml-auto w-full max-w-sm space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">{formatCurrency(selectedInvoice.subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="font-medium">{formatCurrency(selectedInvoice.tax)}</span>
                </div>
                <div className="flex justify-between border-t pt-2 text-base font-semibold">
                  <span>Total</span>
                  <span>{formatCurrency(selectedInvoice.total)}</span>
                </div>
              </div>

              {selectedInvoice.notes && (
                <div className="rounded-lg bg-muted/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground">Notes</p>
                  <p className="mt-1 text-sm">{selectedInvoice.notes}</p>
                </div>
              )}

              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="outline" onClick={() => handleExportPDF(selectedInvoice)}>
                  <Download className="mr-2 h-4 w-4" /> Export PDF
                </Button>
                <div className="flex flex-wrap justify-end gap-2">
                  {getDocumentType(selectedInvoice) === 'Quotation' && selectedInvoice.status !== 'Void' && (
                    <Button onClick={() => handleConvertToInvoice(selectedInvoice)}>
                      Convert to Invoice
                    </Button>
                  )}
                  {getDocumentType(selectedInvoice) === 'Invoice' && selectedInvoice.status !== 'Paid' && selectedInvoice.status !== 'Void' && (
                    <Button onClick={() => handleUpdateStatus(selectedInvoice.id, 'Paid')}>
                      Record Payment
                    </Button>
                  )}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
