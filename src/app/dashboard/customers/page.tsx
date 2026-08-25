'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm } from 'react-hook-form';
import {
  BookUser,
  CheckCircle2,
  CreditCard,
  Edit,
  Eye,
  Loader2,
  MoreHorizontal,
  PlusCircle,
  ReceiptText,
  ShoppingBasket,
  Trash2,
  Wallet,
} from 'lucide-react';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { db, type Customer, type Invoice, type Session } from '@/lib/db';
import { authFetch } from '@/lib/auth-fetch';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch',
};

const customerSchema = z.object({
  name: z.string().min(2, 'Customer name is required.'),
  email: z.string().email('Please enter a valid email address.').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  accountEnabled: z.boolean().default(true),
  creditLimit: z.coerce.number().min(0, 'Credit limit cannot be negative').default(0),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

type CustomerAccountTransaction = {
  id: string;
  entry_type?: string;
  entryType?: string;
  direction?: 'debit' | 'credit';
  amount: number | string;
  balance_after?: number | string;
  balanceAfter?: number | string;
  payment_method?: string;
  paymentMethod?: string;
  reference?: string;
  notes?: string;
  created_at?: string;
  createdAt?: string;
};

type CustomerLaybuyPayment = {
  id: string;
  amount: number | string;
  payment_method?: string;
  paymentMethod?: string;
  reference?: string;
  notes?: string;
  created_at?: string;
  createdAt?: string;
};

type CustomerLaybuyReservation = {
  id: string;
  inventory_item?: string | null;
  inventoryItem?: string | null;
  item_name?: string;
  itemName?: string;
  item_name_display?: string;
  itemNameDisplay?: string;
  quantity: number | string;
  status: 'active' | 'fulfilled' | 'released' | string;
};

type CustomerLaybuy = {
  id: string;
  laybuy_number?: string;
  laybuyNumber?: string;
  status: 'active' | 'ready_for_collection' | 'completed' | 'cancelled' | string;
  total: number | string;
  deposit_amount?: number | string;
  depositAmount?: number | string;
  paid_amount?: number | string;
  paidAmount?: number | string;
  balance_due?: number | string;
  balanceDue?: number | string;
  due_date?: string | null;
  dueDate?: string | null;
  notes?: string;
  created_at?: string;
  createdAt?: string;
  payments?: CustomerLaybuyPayment[];
  reservations?: CustomerLaybuyReservation[];
};

type CustomerAccountSummary = {
  total_outstanding?: number | string;
  totalOutstanding?: number | string;
  owing_customers?: number;
  owingCustomers?: number;
  laybuy_active_count?: number;
  laybuyActiveCount?: number;
  laybuy_balance_due?: number | string;
  laybuyBalanceDue?: number | string;
};

const normalizeBackendBranchId = (value?: string | number | null): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];
  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];
  return normalized;
};

const normalizeCollection = <T,>(payload: any): T[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const PAYMENT_METHODS = ['Cash', 'Card', 'Mobile Money', 'Bank Transfer', 'Other'];

const normalizeCustomerFromApi = (raw: any, fallbackBranchId: string): Customer => {
  const branchId = String(raw?.branchId ?? raw?.branch_id ?? raw?.branch ?? fallbackBranchId ?? '').trim();
  const creditLimit = toNumber(raw?.creditLimit ?? raw?.credit_limit, 0);
  const currentBalance = toNumber(raw?.currentBalance ?? raw?.current_balance, 0);
  const customerTin = String(raw?.customerTin ?? raw?.customer_tin ?? '').trim();
  const vatRegistered = Boolean(raw?.vatRegistered ?? raw?.vat_registered ?? false);

  return {
    id: String(raw?.id ?? ''),
    businessId: String(raw?.businessId ?? raw?.business ?? raw?.business_id ?? '').trim() || undefined,
    branchId: branchId || fallbackBranchId,
    name: String(raw?.name ?? 'Unnamed Customer'),
    email: String(raw?.email ?? ''),
    phone: String(raw?.phone ?? ''),
    address: String(raw?.address ?? ''),
    notes: String(raw?.notes ?? ''),
    isActive: raw?.isActive ?? raw?.is_active ?? true,
    accountEnabled: raw?.accountEnabled ?? raw?.account_enabled ?? true,
    creditLimit,
    currentBalance,
    availableCredit: raw?.availableCredit ?? raw?.available_credit ?? null,
    hasCreditLimit: raw?.hasCreditLimit ?? raw?.has_credit_limit ?? creditLimit > 0,
    customerTin,
    customer_tin: customerTin,
    vatRegistered,
    vat_registered: vatRegistered,
    createdAt: String(raw?.createdAt ?? raw?.created_at ?? new Date().toISOString()),
    updatedAt: String(raw?.updatedAt ?? raw?.updated_at ?? new Date().toISOString()),
    _dirty: false,
    _operation: undefined,
  };
};

const hasNumericValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
};

const normalizeInvoiceFromApi = (raw: any, fallbackBranchId: string): Invoice => {
  const status = raw?.status || 'Draft';
  const total = toNumber(raw?.total, 0);
  const documentType = raw?.documentType ?? raw?.document_type;
  const rawBranchId = String(raw?.branchId ?? raw?.branch_id ?? raw?.branch ?? '').trim();
  const branchId =
    rawBranchId && normalizeBackendBranchId(rawBranchId) !== normalizeBackendBranchId(fallbackBranchId)
      ? rawBranchId
      : fallbackBranchId;
  const customerBalanceValue = raw?.customerCurrentBalance ?? raw?.customer_current_balance;
  const availableCreditValue = raw?.customerAvailableCredit ?? raw?.customer_available_credit;

  return {
    id: String(raw?.id ?? ''),
    invoiceNumber: toNumber(raw?.invoiceNumber ?? raw?.invoice_number, 0),
    documentType: documentType === 'Quotation' ? 'Quotation' : 'Invoice',
    branchId,
    customerId: String(raw?.customerId ?? raw?.customer_id ?? raw?.customer ?? ''),
    customerName: String(raw?.customerName ?? raw?.customer_name ?? raw?.customer_name_display ?? 'Customer'),
    status,
    approvalStatus: raw?.approvalStatus ?? raw?.approval_status,
    items: Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.lines)
        ? raw.lines.map((line: any) => {
            const quantity = toNumber(line?.quantity, 0);
            const price = toNumber(line?.unit_price ?? line?.price, 0);
            return {
              id: String(line?.product_code || line?.id || ''),
              productId: String(line?.product_code || line?.productId || ''),
              name: String(line?.product_name || line?.name || 'Item'),
              quantity,
              price,
              total: toNumber(line?.total_amount ?? line?.total, quantity * price),
            };
          })
        : [],
    subtotal: toNumber(raw?.subtotal, 0),
    tax: toNumber(raw?.tax, 0),
    total,
    paidAmount: toNumber(raw?.paidAmount ?? raw?.paid_amount, status === 'Paid' ? total : 0),
    balanceDue: toNumber(raw?.balanceDue ?? raw?.balance_due, status === 'Sent' ? total : 0),
    customerCurrentBalance: hasNumericValue(customerBalanceValue) ? toNumber(customerBalanceValue, 0) : undefined,
    customerAvailableCredit: hasNumericValue(availableCreditValue) ? toNumber(availableCreditValue, 0) : null,
    issueDate: String(raw?.issueDate ?? raw?.issue_date ?? new Date().toISOString()),
    dueDate: String(raw?.dueDate ?? raw?.due_date ?? new Date().toISOString()),
    notes: String(raw?.notes ?? ''),
    relatedOrderId: raw?.relatedOrderId ?? raw?.related_order_id ?? undefined,
    approvedBy: raw?.approvedBy ?? raw?.approved_by ?? undefined,
    approvedAt: raw?.approvedAt ?? raw?.approved_at ?? undefined,
    createdAt: String(raw?.createdAt ?? raw?.created_at ?? new Date().toISOString()),
    updatedAt: raw?.updatedAt ?? raw?.updated_at ?? undefined,
    _synced_at: new Date().toISOString(),
  };
};

const getInvoiceBalanceDue = (invoice: Invoice): number => {
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'paid' || status === 'void') return 0;
  return Math.max(0, toNumber(invoice.balanceDue, status === 'sent' ? toNumber(invoice.total, 0) : 0));
};

const isOutstandingCustomerInvoice = (invoice: Invoice, customerId: string, branchId: string): boolean => {
  if ((invoice.documentType || 'Invoice') !== 'Invoice') return false;
  if (String(invoice.customerId || '') !== String(customerId || '')) return false;

  const invoiceBranchId = String(invoice.branchId || '').trim();
  const branchMatches =
    invoiceBranchId === branchId ||
    normalizeBackendBranchId(invoiceBranchId) === normalizeBackendBranchId(branchId);

  return branchMatches && getInvoiceBalanceDue(invoice) > 0;
};

const sortOutstandingInvoices = (invoices: Invoice[]): Invoice[] => {
  return [...invoices].sort((a, b) => {
    const dateA = Date.parse(a.dueDate || a.issueDate || '');
    const dateB = Date.parse(b.dueDate || b.issueDate || '');
    if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
      return dateA - dateB;
    }
    return (a.invoiceNumber || 0) - (b.invoiceNumber || 0);
  });
};

const paymentAmountInputValue = (amount: number): string => {
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
};

const isServerCustomerId = (value?: string | number | null): boolean => {
  return /^\d+$/.test(String(value ?? '').trim());
};

const removeStaleLocalCustomerDuplicates = async (branchId: string) => {
  const localCustomers = await db.customers.where({ branchId }).toArray();
  for (const localCustomer of localCustomers) {
    const localId = String(localCustomer.id ?? '').trim();
    if (isServerCustomerId(localId) || localCustomer._dirty) {
      continue;
    }

    await db.customers.delete(localCustomer.id);
  }
};

const filterDisplayCustomers = (customers: Customer[]): Customer[] => {
  return customers.filter((customer) => {
    const id = String(customer.id ?? '').trim();
    if (!id) return false;
    if (isServerCustomerId(id)) return true;
    return customer._dirty === true;
  });
};

const customerPayload = (data: CustomerFormValues, branchId: string) => ({
  branch: normalizeBackendBranchId(branchId) || undefined,
  name: data.name,
  email: data.email || '',
  phone: data.phone || '',
  address: data.address || '',
  notes: data.notes || '',
  account_enabled: data.accountEnabled,
  credit_limit: data.creditLimit || 0,
});

const CustomerForm = ({
  onFormSubmit,
  defaultValues,
}: {
  onFormSubmit: () => void;
  defaultValues?: Partial<Customer>;
}) => {
  const [activeBranchId, setActiveBranchId] = useState('main');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: defaultValues?.name || '',
      email: defaultValues?.email || '',
      phone: defaultValues?.phone || '',
      address: defaultValues?.address || '',
      notes: defaultValues?.notes || '',
      accountEnabled: defaultValues?.accountEnabled ?? true,
      creditLimit: toNumber(defaultValues?.creditLimit, 0),
    },
  });

  const onSubmit = async (data: CustomerFormValues) => {
    setIsLoading(true);
    try {
      const payload = customerPayload(data, activeBranchId);
      if (defaultValues?.id) {
        const updatedCustomer = await authFetch.fetch(`/customers/${defaultValues.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        const normalized = normalizeCustomerFromApi(updatedCustomer, activeBranchId);
        if (normalized.id) {
          await db.customers.put(normalized);
        }
        toast({ title: 'Customer updated successfully' });
      } else {
        const newCustomer = await authFetch.fetch('/customers/', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const normalized = normalizeCustomerFromApi(newCustomer, activeBranchId);
        if (normalized.id) {
          await db.customers.put(normalized);
        }
        toast({ title: 'Customer added successfully' });
      }
      onFormSubmit();
    } catch (error) {
      console.error('Failed to save customer:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save customer',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 py-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Customer Name</FormLabel>
            <FormControl><Input placeholder="e.g. John Doe, ACME Ltd" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="email" render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl><Input type="email" placeholder="contact@example.com" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="phone" render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl><Input placeholder="+265 999 000 000" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem>
            <FormLabel>Address</FormLabel>
            <FormControl><Textarea placeholder="Customer address" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
          <FormField control={form.control} name="creditLimit" render={({ field }) => (
            <FormItem>
              <FormLabel>Credit Limit</FormLabel>
              <FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl>
              <FormDescription>Use 0 for no fixed limit.</FormDescription>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="accountEnabled" render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <FormLabel className="text-sm">Credit Account</FormLabel>
                <FormDescription>Allow sales on account.</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )} />
        </div>

        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem>
            <FormLabel>Notes</FormLabel>
            <FormControl><Textarea placeholder="Optional account notes" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <DialogFooter>
          <Button type="submit" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {defaultValues?.id ? 'Save Changes' : 'Add Customer'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
};

export default function CustomersPage() {
  const { format } = useCurrency();
  const [isFormOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | undefined>(undefined);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [isSyncingCustomers, setIsSyncingCustomers] = useState(false);
  const [paymentCustomer, setPaymentCustomer] = useState<Customer | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentInvoices, setPaymentInvoices] = useState<Invoice[]>([]);
  const [selectedPaymentInvoiceId, setSelectedPaymentInvoiceId] = useState('');
  const [isLoadingPaymentInvoices, setIsLoadingPaymentInvoices] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [activityCustomer, setActivityCustomer] = useState<Customer | null>(null);
  const [transactions, setTransactions] = useState<CustomerAccountTransaction[]>([]);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false);
  const [accountSummary, setAccountSummary] = useState<CustomerAccountSummary | null>(null);
  const [laybuyCustomer, setLaybuyCustomer] = useState<Customer | null>(null);
  const [laybuys, setLaybuys] = useState<CustomerLaybuy[]>([]);
  const [isLoadingLaybuys, setIsLoadingLaybuys] = useState(false);
  const [newLaybuyTotal, setNewLaybuyTotal] = useState('');
  const [newLaybuyDeposit, setNewLaybuyDeposit] = useState('');
  const [newLaybuyDueDate, setNewLaybuyDueDate] = useState('');
  const [newLaybuyNotes, setNewLaybuyNotes] = useState('');
  const [newLaybuyPaymentMethod, setNewLaybuyPaymentMethod] = useState('Cash');
  const [isCreatingLaybuy, setIsCreatingLaybuy] = useState(false);
  const [laybuyPaymentId, setLaybuyPaymentId] = useState('');
  const [laybuyPaymentAmount, setLaybuyPaymentAmount] = useState('');
  const [laybuyPaymentMethod, setLaybuyPaymentMethod] = useState('Cash');
  const [laybuyPaymentReference, setLaybuyPaymentReference] = useState('');
  const [laybuyPaymentNotes, setLaybuyPaymentNotes] = useState('');
  const [isRecordingLaybuyPayment, setIsRecordingLaybuyPayment] = useState(false);
  const [collectingLaybuyId, setCollectingLaybuyId] = useState('');

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  useEffect(() => {
    const handleBranchChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      const branchId = customEvent.detail?.branchId;
      if (branchId) setActiveBranchId(branchId);
    };

    window.addEventListener('branchChanged', handleBranchChange);
    return () => window.removeEventListener('branchChanged', handleBranchChange);
  }, []);

  const customers = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.customers.where({ branchId: activeBranchId }).toArray();
    },
    [activeBranchId]
  ) || [];
  const displayCustomers = useMemo(
    () => filterDisplayCustomers(customers),
    [customers]
  );

  const activeSession = useLiveQuery(
    async () => {
      if (!activeBranchId) return null;
      const sessions = await db.sessions
        .where({ branchId: activeBranchId, status: 'active' })
        .toArray();
      return sessions
        .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''))[0] ?? null;
    },
    [activeBranchId]
  ) || null;

  const addCollectionToActiveSession = async (method: string, amount: number) => {
    if (!activeSession?.id || amount <= 0) return;

    await db.sessions.where({ id: activeSession.id }).modify((session: Session) => {
      const normalizedMethod = String(method || '').trim().toLowerCase();
      if (normalizedMethod === 'cash') {
        session.totalCashSales = (session.totalCashSales || 0) + amount;
        session.expectedCash = (session.expectedCash || 0) + amount;
      } else if (normalizedMethod === 'card') {
        session.totalCardSales = (session.totalCardSales || 0) + amount;
      } else if (normalizedMethod === 'mobile money') {
        session.totalMobileMoneySales = (session.totalMobileMoneySales || 0) + amount;
      } else if (normalizedMethod === 'bank transfer') {
        session.totalBankTransferSales = (session.totalBankTransferSales || 0) + amount;
      } else {
        session.totalOtherSales = (session.totalOtherSales || 0) + amount;
      }
      session._dirty = true;
      session._operation = 'update';
    });
  };

  const applyCollectedLaybuyInventoryLocally = async (laybuy: CustomerLaybuy) => {
    if (!activeBranchId || !Array.isArray(laybuy.reservations) || laybuy.reservations.length === 0) {
      return;
    }

    await db.transaction('rw', db.inventory, async () => {
      for (const reservation of laybuy.reservations || []) {
        const statusKey = String(reservation.status || '').toLowerCase();
        if (statusKey !== 'fulfilled') {
          continue;
        }

        const itemId = String(reservation.inventoryItem ?? reservation.inventory_item ?? '').trim();
        const quantity = toNumber(reservation.quantity, 0);
        if (!itemId || quantity <= 0) {
          continue;
        }

        let inventoryItem = await db.inventory.get(itemId);
        if (!inventoryItem || String(inventoryItem.branchId) !== String(activeBranchId)) {
          inventoryItem = await db.inventory
            .where('branchId')
            .equals(activeBranchId)
            .filter((item) => String(item.id) === itemId)
            .first();
        }
        if (!inventoryItem) {
          continue;
        }

        const stockUnits = toNumber(inventoryItem.stockUnits ?? inventoryItem.stock_units, 0);
        const reservedUnits = toNumber(inventoryItem.reservedStockUnits ?? inventoryItem.reserved_stock_units, 0);
        const newStockUnits = Math.max(0, stockUnits - quantity);
        const newReservedUnits = Math.max(0, reservedUnits - quantity);
        const availableStockUnits = Math.max(0, newStockUnits - newReservedUnits);
        const reorderLevel = toNumber(inventoryItem.reorderLevel, 0);
        const status =
          inventoryItem.isProduced
            ? 'In Stock'
            : availableStockUnits <= 0
              ? 'Out of Stock'
              : availableStockUnits <= reorderLevel
                ? 'Low Stock'
                : 'In Stock';

        await db.inventory.update(inventoryItem.id, {
          stockUnits: newStockUnits,
          stock_units: newStockUnits,
          reservedStockUnits: newReservedUnits,
          reserved_stock_units: newReservedUnits,
          availableStockUnits,
          available_stock_units: availableStockUnits,
          status,
        });
      }
    });
  };

  useEffect(() => {
    if (!activeBranchId) return;

    let cancelled = false;
    const fetchCustomers = async () => {
      setIsSyncingCustomers(true);
      try {
        const backendBranchId = normalizeBackendBranchId(activeBranchId);
        const url = backendBranchId
          ? `/customers/?branch_id=${encodeURIComponent(backendBranchId)}`
          : '/customers/';
        const response = await authFetch.fetch(url);
        if (cancelled) return;
        const backendCustomers = normalizeCollection<any>(response);
        for (const customer of backendCustomers) {
          const normalized = normalizeCustomerFromApi(customer, activeBranchId);
          if (normalized.id) {
            await db.customers.put(normalized);
          }
        }
        await removeStaleLocalCustomerDuplicates(activeBranchId);
      } catch (error) {
        console.warn('[Customers] Could not refresh customers from backend:', error);
      } finally {
        if (!cancelled) setIsSyncingCustomers(false);
      }
    };

    void fetchCustomers();
    return () => {
      cancelled = true;
    };
  }, [activeBranchId]);

  useEffect(() => {
    if (!activeBranchId) return;

    let cancelled = false;
    const fetchAccountSummary = async () => {
      try {
        const backendBranchId = normalizeBackendBranchId(activeBranchId);
        const url = backendBranchId
          ? `/customers/account_summary/?branch_id=${encodeURIComponent(backendBranchId)}`
          : '/customers/account_summary/';
        const response = await authFetch.fetch(url);
        if (!cancelled) {
          setAccountSummary(response);
        }
      } catch (error) {
        console.warn('[Customers] Could not refresh account summary:', error);
      }
    };

    void fetchAccountSummary();
    return () => {
      cancelled = true;
    };
  }, [activeBranchId, isSyncingCustomers]);

  const summary = useMemo(() => {
    const outstanding = displayCustomers.reduce((total, customer) => {
      const balance = toNumber(customer.currentBalance, 0);
      return total + Math.max(0, balance);
    }, 0);
    const prepaid = displayCustomers.reduce((total, customer) => {
      const balance = toNumber(customer.currentBalance, 0);
      return total + Math.abs(Math.min(0, balance));
    }, 0);
    const owing = displayCustomers.filter((customer) => toNumber(customer.currentBalance, 0) > 0).length;
    return {
      outstanding: toNumber(accountSummary?.totalOutstanding ?? accountSummary?.total_outstanding, outstanding),
      prepaid,
      owing: Number(accountSummary?.owingCustomers ?? accountSummary?.owing_customers ?? owing),
      laybuyActiveCount: Number(accountSummary?.laybuyActiveCount ?? accountSummary?.laybuy_active_count ?? 0),
      laybuyBalanceDue: toNumber(accountSummary?.laybuyBalanceDue ?? accountSummary?.laybuy_balance_due, 0),
    };
  }, [displayCustomers, accountSummary]);

  const selectedPaymentInvoice = useMemo(
    () => paymentInvoices.find((invoice) => invoice.id === selectedPaymentInvoiceId),
    [paymentInvoices, selectedPaymentInvoiceId]
  );

  const handleEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this customer?')) return;

    try {
      if (!isServerCustomerId(id)) {
        await db.customers.delete(id);
        toast({ title: 'Removed local duplicate customer', variant: 'destructive' });
        return;
      }

      await authFetch.fetch(`/customers/${id}/`, {
        method: 'DELETE',
      });
      await db.customers.delete(id);
      toast({ title: 'Customer deleted successfully', variant: 'destructive' });
    } catch (error) {
      console.error('Error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete customer',
      });
    }
  };

  const handleFormOpenChange = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditingCustomer(undefined);
  };

  const removeLocalOnlyCustomer = async (customer: Customer) => {
    await db.customers.delete(customer.id);
    toast({
      variant: 'destructive',
      title: 'Removed local duplicate customer',
      description: 'This customer row was not linked to a server record.',
    });
  };

  const applyPaymentInvoiceOptions = (invoices: Invoice[]) => {
    const outstandingInvoices = sortOutstandingInvoices(invoices);
    const selectedInvoice = outstandingInvoices[0];

    setPaymentInvoices(outstandingInvoices);
    setSelectedPaymentInvoiceId(selectedInvoice?.id || '');
    if (selectedInvoice) {
      setPaymentAmount(paymentAmountInputValue(getInvoiceBalanceDue(selectedInvoice)));
    }
  };

  const loadOutstandingPaymentInvoices = async (customer: Customer) => {
    if (!activeBranchId) return;

    setIsLoadingPaymentInvoices(true);

    let localInvoices: Invoice[] = [];
    try {
      localInvoices = await db.invoices
        .where('customerId')
        .equals(String(customer.id))
        .filter((invoice) => isOutstandingCustomerInvoice(invoice, customer.id, activeBranchId))
        .toArray();
      applyPaymentInvoiceOptions(localInvoices);

      const backendBranchId = normalizeBackendBranchId(activeBranchId);
      const params = new URLSearchParams();
      if (backendBranchId) params.set('branch_id', backendBranchId);
      params.set('customer', String(customer.id));
      params.set('document_type', 'Invoice');

      const response = await authFetch.fetch(`/business/invoices/?${params.toString()}`);
      const backendInvoices = normalizeCollection<any>(response)
        .map((invoice) => normalizeInvoiceFromApi(invoice, activeBranchId))
        .filter((invoice) => invoice.id);

      if (backendInvoices.length > 0) {
        await db.invoices.bulkPut(backendInvoices);
      }

      applyPaymentInvoiceOptions(
        backendInvoices.filter((invoice) => isOutstandingCustomerInvoice(invoice, customer.id, activeBranchId))
      );
    } catch (error) {
      console.warn('[Customers] Could not refresh outstanding invoices:', error);
      if (localInvoices.length === 0) {
        applyPaymentInvoiceOptions([]);
      }
    } finally {
      setIsLoadingPaymentInvoices(false);
    }
  };

  const openPaymentDialog = (customer: Customer) => {
    if (!isServerCustomerId(customer.id)) {
      void removeLocalOnlyCustomer(customer);
      return;
    }

    setPaymentCustomer(customer);
    setPaymentAmount('');
    setPaymentMethod('Cash');
    setPaymentReference('');
    setPaymentNotes('');
    setPaymentInvoices([]);
    setSelectedPaymentInvoiceId('');
    void loadOutstandingPaymentInvoices(customer);
  };

  const recordPayment = async () => {
    if (!paymentCustomer || !activeBranchId) return;
    const amount = toNumber(paymentAmount, 0);
    if (amount <= 0) {
      toast({ variant: 'destructive', title: 'Enter a payment amount' });
      return;
    }

    const selectedInvoice = selectedPaymentInvoiceId
      ? paymentInvoices.find((invoice) => invoice.id === selectedPaymentInvoiceId)
      : undefined;
    if (selectedInvoice) {
      const invoiceBalanceDue = getInvoiceBalanceDue(selectedInvoice);
      if (amount > invoiceBalanceDue) {
        toast({
          variant: 'destructive',
          title: 'Payment exceeds invoice balance',
          description: `Invoice #${selectedInvoice.invoiceNumber} has ${format(invoiceBalanceDue)} remaining.`,
        });
        return;
      }
    }

    setIsRecordingPayment(true);
    try {
      const response = await authFetch.fetch(`/customers/${paymentCustomer.id}/payments/`, {
        method: 'POST',
        body: JSON.stringify({
          amount,
          invoice: selectedPaymentInvoiceId || undefined,
          payment_method: paymentMethod,
          branch: normalizeBackendBranchId(activeBranchId) || undefined,
          session: activeSession?.id || undefined,
          reference: paymentReference,
          notes: paymentNotes,
        }),
      });

      const normalized = normalizeCustomerFromApi(response.customer, activeBranchId);
      if (normalized.id) {
        await db.customers.put(normalized);
      }
      if (response.invoice) {
        const normalizedInvoice = normalizeInvoiceFromApi(response.invoice, activeBranchId);
        if (normalizedInvoice.id) {
          await db.invoices.put(normalizedInvoice);
        }
      }
      const previousBalance = toNumber(paymentCustomer.currentBalance, 0);
      const nextBalance = toNumber(normalized.currentBalance, previousBalance - amount);
      setAccountSummary((current) => {
        if (!current) return current;

        const currentOutstanding = toNumber(current.totalOutstanding ?? current.total_outstanding, 0);
        const nextOutstanding = Math.max(
          0,
          currentOutstanding - Math.max(0, previousBalance) + Math.max(0, nextBalance)
        );
        const currentOwingCustomers = Number(current.owingCustomers ?? current.owing_customers ?? 0);
        const nextOwingCustomers =
          previousBalance > 0 && nextBalance <= 0
            ? Math.max(0, currentOwingCustomers - 1)
            : previousBalance <= 0 && nextBalance > 0
              ? currentOwingCustomers + 1
              : currentOwingCustomers;

        return {
          ...current,
          totalOutstanding: nextOutstanding,
          total_outstanding: nextOutstanding,
          owingCustomers: nextOwingCustomers,
          owing_customers: nextOwingCustomers,
        };
      });
      await addCollectionToActiveSession(paymentMethod, amount);
      toast({
        title: 'Payment recorded',
        description: selectedInvoice
          ? `${format(amount)} was applied to invoice #${selectedInvoice.invoiceNumber}.`
          : `${format(amount)} was added to ${normalized.name}.`,
      });
      setPaymentCustomer(null);
      setPaymentInvoices([]);
      setSelectedPaymentInvoiceId('');
    } catch (error) {
      console.error('[Customers] Failed to record payment:', error);
      toast({
        variant: 'destructive',
        title: 'Payment failed',
        description: error instanceof Error ? error.message : 'Could not record the customer payment.',
      });
    } finally {
      setIsRecordingPayment(false);
    }
  };

  const openActivityDialog = async (customer: Customer) => {
    if (!isServerCustomerId(customer.id)) {
      await removeLocalOnlyCustomer(customer);
      return;
    }

    setActivityCustomer(customer);
    setTransactions([]);
    setIsLoadingTransactions(true);
    try {
      const response = await authFetch.fetch(`/customers/${customer.id}/transactions/?limit=25`);
      setTransactions(normalizeCollection<CustomerAccountTransaction>(response));
    } catch (error) {
      console.error('[Customers] Failed to load transactions:', error);
      toast({
        variant: 'destructive',
        title: 'Could not load account activity',
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setIsLoadingTransactions(false);
    }
  };

  const resetLaybuyForm = () => {
    setNewLaybuyTotal('');
    setNewLaybuyDeposit('');
    setNewLaybuyDueDate('');
    setNewLaybuyNotes('');
    setNewLaybuyPaymentMethod('Cash');
    setLaybuyPaymentId('');
    setLaybuyPaymentAmount('');
    setLaybuyPaymentMethod('Cash');
    setLaybuyPaymentReference('');
    setLaybuyPaymentNotes('');
    setCollectingLaybuyId('');
  };

  const openLaybuyDialog = async (customer: Customer) => {
    if (!isServerCustomerId(customer.id)) {
      await removeLocalOnlyCustomer(customer);
      return;
    }

    setLaybuyCustomer(customer);
    setLaybuys([]);
    resetLaybuyForm();
    setIsLoadingLaybuys(true);
    try {
      const response = await authFetch.fetch(`/customers/${customer.id}/laybuys/`);
      setLaybuys(normalizeCollection<CustomerLaybuy>(response));
    } catch (error) {
      console.error('[Customers] Failed to load laybuys:', error);
      toast({
        variant: 'destructive',
        title: 'Could not load laybuys',
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setIsLoadingLaybuys(false);
    }
  };

  const createLaybuy = async () => {
    if (!laybuyCustomer || !activeBranchId) return;
    const total = toNumber(newLaybuyTotal, 0);
    const deposit = toNumber(newLaybuyDeposit, 0);
    if (total <= 0) {
      toast({ variant: 'destructive', title: 'Enter a laybuy total' });
      return;
    }
    if (deposit < 0 || deposit > total) {
      toast({ variant: 'destructive', title: 'Deposit must be between zero and the laybuy total' });
      return;
    }

    setIsCreatingLaybuy(true);
    try {
      const created = await authFetch.fetch(`/customers/${laybuyCustomer.id}/laybuys/`, {
        method: 'POST',
        body: JSON.stringify({
          total,
          deposit_amount: deposit,
          payment_method: newLaybuyPaymentMethod,
          branch: normalizeBackendBranchId(activeBranchId) || undefined,
          session: activeSession?.id || undefined,
          due_date: newLaybuyDueDate || null,
          notes: newLaybuyNotes,
        }),
      });
      setLaybuys((current) => [created, ...current]);
      if (deposit > 0) {
        await addCollectionToActiveSession(newLaybuyPaymentMethod, deposit);
      }
      setNewLaybuyTotal('');
      setNewLaybuyDeposit('');
      setNewLaybuyDueDate('');
      setNewLaybuyNotes('');
      toast({ title: 'Laybuy created', description: `${format(total)} laybuy added for ${laybuyCustomer.name}.` });
    } catch (error) {
      console.error('[Customers] Failed to create laybuy:', error);
      toast({
        variant: 'destructive',
        title: 'Could not create laybuy',
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setIsCreatingLaybuy(false);
    }
  };

  const recordLaybuyPayment = async () => {
    if (!laybuyCustomer || !activeBranchId || !laybuyPaymentId) return;
    const amount = toNumber(laybuyPaymentAmount, 0);
    if (amount <= 0) {
      toast({ variant: 'destructive', title: 'Enter a payment amount' });
      return;
    }

    setIsRecordingLaybuyPayment(true);
    try {
      const response = await authFetch.fetch(`/customers/${laybuyCustomer.id}/laybuy_payment/`, {
        method: 'POST',
        body: JSON.stringify({
          laybuy_id: laybuyPaymentId,
          amount,
          payment_method: laybuyPaymentMethod,
          branch: normalizeBackendBranchId(activeBranchId) || undefined,
          session: activeSession?.id || undefined,
          reference: laybuyPaymentReference,
          notes: laybuyPaymentNotes,
        }),
      });
      const updatedLaybuy = response.laybuy as CustomerLaybuy;
      setLaybuys((current) => current.map((laybuy) => laybuy.id === updatedLaybuy.id ? updatedLaybuy : laybuy));
      await addCollectionToActiveSession(laybuyPaymentMethod, amount);
      setLaybuyPaymentId('');
      setLaybuyPaymentAmount('');
      setLaybuyPaymentReference('');
      setLaybuyPaymentNotes('');
      toast({ title: 'Laybuy payment recorded', description: `${format(amount)} was added to ${laybuyCustomer.name}'s laybuy.` });
    } catch (error) {
      console.error('[Customers] Failed to record laybuy payment:', error);
      toast({
        variant: 'destructive',
        title: 'Payment failed',
        description: error instanceof Error ? error.message : 'Could not record the laybuy payment.',
      });
    } finally {
      setIsRecordingLaybuyPayment(false);
    }
  };

  const collectLaybuy = async (laybuy: CustomerLaybuy) => {
    if (!laybuyCustomer) return;

    const balance = toNumber(laybuy.balanceDue ?? laybuy.balance_due, 0);
    if (balance > 0) {
      toast({ variant: 'destructive', title: 'Laybuy is not fully paid yet' });
      return;
    }

    setCollectingLaybuyId(laybuy.id);
    try {
      const response = await authFetch.fetch(`/customers/${laybuyCustomer.id}/laybuy_collect/`, {
        method: 'POST',
        body: JSON.stringify({
          laybuy_id: laybuy.id,
        }),
      });
      const updatedLaybuy = response.laybuy as CustomerLaybuy;
      await applyCollectedLaybuyInventoryLocally(updatedLaybuy);
      setLaybuys((current) => current.map((row) => row.id === updatedLaybuy.id ? updatedLaybuy : row));
      toast({
        title: 'Laybuy collected',
        description: `${updatedLaybuy.laybuyNumber ?? updatedLaybuy.laybuy_number ?? 'Laybuy'} is now completed.`,
      });
    } catch (error) {
      console.error('[Customers] Failed to collect laybuy:', error);
      toast({
        variant: 'destructive',
        title: 'Collection failed',
        description: error instanceof Error ? error.message : 'Could not complete this laybuy.',
      });
    } finally {
      setCollectingLaybuyId('');
    }
  };

  if (!activeBranchId) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-normal">Customer Accounts</h1>
          <p className="text-muted-foreground">
            Manage customer profiles, credit limits, balances, and account payments.
          </p>
        </div>
        <Dialog open={isFormOpen} onOpenChange={handleFormOpenChange}>
          <DialogTrigger asChild>
            <Button>
              <PlusCircle className="mr-2 h-4 w-4" /> Add Customer
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{editingCustomer ? 'Edit Customer' : 'Add New Customer'}</DialogTitle>
              <DialogDescription>
                {editingCustomer
                  ? 'Update the customer profile and account settings.'
                  : 'Create a customer account for credit sales, payments, and history.'}
              </DialogDescription>
            </DialogHeader>
            <CustomerForm
              onFormSubmit={() => handleFormOpenChange(false)}
              defaultValues={editingCustomer}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-sm text-muted-foreground">Outstanding</p>
              <p className="mt-1 text-2xl font-semibold">{format(summary.outstanding)}</p>
            </div>
            <Wallet className="h-6 w-6 text-primary" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-sm text-muted-foreground">Customers Owing</p>
              <p className="mt-1 text-2xl font-semibold">{summary.owing}</p>
            </div>
            <CreditCard className="h-6 w-6 text-amber-600" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-sm text-muted-foreground">Prepaid Credit</p>
              <p className="mt-1 text-2xl font-semibold">{format(summary.prepaid)}</p>
            </div>
            <ReceiptText className="h-6 w-6 text-emerald-600" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-sm text-muted-foreground">Laybuy Balance</p>
              <p className="mt-1 text-2xl font-semibold">{format(summary.laybuyBalanceDue)}</p>
              <p className="text-xs text-muted-foreground">{summary.laybuyActiveCount} active</p>
            </div>
            <ShoppingBasket className="h-6 w-6 text-sky-600" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Customer List</CardTitle>
              <CardDescription>
                {isSyncingCustomers ? 'Refreshing customer accounts...' : 'Balances update from sales on account and payments.'}
              </CardDescription>
            </div>
            {isSyncingCustomers && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Credit Limit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[50px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayCustomers.length > 0 ? (
                  displayCustomers.map((customer) => {
                    const balance = toNumber(customer.currentBalance, 0);
                    const creditLimit = toNumber(customer.creditLimit, 0);
                    return (
                      <TableRow key={customer.id}>
                        <TableCell className="font-medium">{customer.name}</TableCell>
                        <TableCell>
                          <div className="text-sm">{customer.email || 'No email'}</div>
                          <div className="text-xs text-muted-foreground">{customer.phone || 'No phone'}</div>
                        </TableCell>
                        <TableCell>
                          <span className={balance > 0 ? 'font-semibold text-amber-700' : balance < 0 ? 'font-semibold text-emerald-700' : 'font-medium'}>
                            {format(balance)}
                          </span>
                        </TableCell>
                        <TableCell>{creditLimit > 0 ? format(creditLimit) : 'No limit'}</TableCell>
                        <TableCell>
                          <Badge variant={customer.accountEnabled === false ? 'secondary' : 'outline'}>
                            {customer.accountEnabled === false ? 'Credit Off' : 'Credit On'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openPaymentDialog(customer)}>
                                <CreditCard className="mr-2 h-4 w-4" /> Record Payment
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void openActivityDialog(customer)}>
                                <Eye className="mr-2 h-4 w-4" /> View Activity
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void openLaybuyDialog(customer)}>
                                <ShoppingBasket className="mr-2 h-4 w-4" /> Laybuys
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleEdit(customer)}>
                                <Edit className="mr-2 h-4 w-4" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDelete(customer.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-28 text-center">
                      <div className="flex flex-col items-center justify-center space-y-3">
                        <BookUser className="h-12 w-12 text-muted-foreground/30" />
                        <p>No customers found. Add a customer account to get started.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(paymentCustomer)}
        onOpenChange={(open) => {
          if (!open) {
            setPaymentCustomer(null);
            setPaymentInvoices([]);
            setSelectedPaymentInvoiceId('');
            setIsLoadingPaymentInvoices(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              {paymentCustomer ? `${paymentCustomer.name} currently owes ${format(toNumber(paymentCustomer.currentBalance, 0))}.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {(isLoadingPaymentInvoices || paymentInvoices.length > 0) && (
              <div className="space-y-2">
                <Label htmlFor="payment-invoice">Invoice</Label>
                {isLoadingPaymentInvoices ? (
                  <div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading open invoices...
                  </div>
                ) : (
                  <>
                    <select
                      id="payment-invoice"
                      value={selectedPaymentInvoiceId}
                      onChange={(event) => {
                        const invoiceId = event.target.value;
                        const invoice = paymentInvoices.find((candidate) => candidate.id === invoiceId);
                        setSelectedPaymentInvoiceId(invoiceId);
                        if (invoice) {
                          setPaymentAmount(paymentAmountInputValue(getInvoiceBalanceDue(invoice)));
                        }
                      }}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="">Account balance</option>
                      {paymentInvoices.map((invoice) => (
                        <option key={invoice.id} value={invoice.id}>
                          Invoice #{invoice.invoiceNumber} - {format(getInvoiceBalanceDue(invoice))} due
                        </option>
                      ))}
                    </select>
                    {selectedPaymentInvoice && (
                      <p className="text-xs text-muted-foreground">
                        Paid {format(toNumber(selectedPaymentInvoice.paidAmount, 0))} of {format(selectedPaymentInvoice.total)}.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="payment-amount">Amount</Label>
              <Input
                id="payment-amount"
                type="number"
                min="0"
                step="0.01"
                value={paymentAmount}
                onChange={(event) => setPaymentAmount(event.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-method">Payment Method</Label>
              <select
                id="payment-method"
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-reference">Reference</Label>
              <Input
                id="payment-reference"
                value={paymentReference}
                onChange={(event) => setPaymentReference(event.target.value)}
                placeholder="Receipt, transfer, or note reference"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-notes">Notes</Label>
              <Textarea
                id="payment-notes"
                value={paymentNotes}
                onChange={(event) => setPaymentNotes(event.target.value)}
                placeholder="Optional payment notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentCustomer(null)} disabled={isRecordingPayment}>
              Cancel
            </Button>
            <Button onClick={() => void recordPayment()} disabled={isRecordingPayment}>
              {isRecordingPayment && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(laybuyCustomer)}
        onOpenChange={(open) => {
          if (!open) {
            setLaybuyCustomer(null);
            setLaybuys([]);
            resetLaybuyForm();
          }
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Laybuys</DialogTitle>
            <DialogDescription>
              {laybuyCustomer ? `Reserved sales and installment payments for ${laybuyCustomer.name}.` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Current Laybuys</h3>
                  <p className="text-xs text-muted-foreground">Track deposits, balances, and completed laybuys.</p>
                </div>
                {isLoadingLaybuys && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>

              <div className="space-y-3">
                {!isLoadingLaybuys && laybuys.length === 0 && (
                  <div className="rounded-md bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                    No laybuys yet for this customer.
                  </div>
                )}

                {laybuys.map((laybuy) => {
                  const number = laybuy.laybuyNumber ?? laybuy.laybuy_number ?? 'Laybuy';
                  const statusValue = String(laybuy.status || 'active').replace(/_/g, ' ');
                  const total = toNumber(laybuy.total, 0);
                  const paid = toNumber(laybuy.paidAmount ?? laybuy.paid_amount, 0);
                  const balance = toNumber(laybuy.balanceDue ?? laybuy.balance_due, Math.max(0, total - paid));
                  const createdAt = laybuy.createdAt ?? laybuy.created_at;
                  const dueDate = laybuy.dueDate ?? laybuy.due_date;
                  const statusKey = String(laybuy.status || '').toLowerCase();
                  const isClosed = ['completed', 'cancelled'].includes(statusKey);
                  const isReadyForCollection = !isClosed && (statusKey === 'ready_for_collection' || balance <= 0);

                  return (
                    <div key={laybuy.id} className="rounded-md border bg-background p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{number}</p>
                            <Badge variant={isClosed ? 'secondary' : 'outline'} className="capitalize">
                              {statusValue}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {createdAt ? new Date(createdAt).toLocaleDateString() : 'No date'}
                            {dueDate ? ` - Due ${new Date(dueDate).toLocaleDateString()}` : ''}
                          </p>
                          {laybuy.notes && <p className="mt-2 text-xs text-muted-foreground">{laybuy.notes}</p>}
                        </div>
                        <div className="grid grid-cols-3 gap-3 text-right text-sm sm:min-w-[280px]">
                          <div>
                            <p className="text-xs text-muted-foreground">Total</p>
                            <p className="font-semibold">{format(total)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Paid</p>
                            <p className="font-semibold text-emerald-700">{format(paid)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Balance</p>
                            <p className="font-semibold text-amber-700">{format(balance)}</p>
                          </div>
                        </div>
                      </div>

                      {Array.isArray(laybuy.payments) && laybuy.payments.length > 0 && (
                        <div className="mt-3 rounded-md bg-muted/30 p-2">
                          <p className="mb-2 text-xs font-medium text-muted-foreground">Payments</p>
                          <div className="space-y-1">
                            {laybuy.payments.slice(0, 4).map((payment) => {
                              const paymentDate = payment.createdAt ?? payment.created_at;
                              return (
                                <div key={payment.id} className="flex items-center justify-between gap-3 text-xs">
                                  <span className="text-muted-foreground">
                                    {paymentDate ? new Date(paymentDate).toLocaleDateString() : 'No date'}
                                    {payment.paymentMethod || payment.payment_method ? ` - ${payment.paymentMethod ?? payment.payment_method}` : ''}
                                  </span>
                                  <span className="font-medium">{format(toNumber(payment.amount, 0))}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {!isClosed && isReadyForCollection && (
                        <div className="mt-3 flex justify-end">
                          <Button
                            size="sm"
                            onClick={() => void collectLaybuy(laybuy)}
                            disabled={collectingLaybuyId === laybuy.id}
                          >
                            {collectingLaybuyId === laybuy.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                            )}
                            Mark Collected
                          </Button>
                        </div>
                      )}

                      {!isClosed && !isReadyForCollection && (
                        <div className="mt-3">
                          {laybuyPaymentId === laybuy.id ? (
                            <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-5">
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={laybuyPaymentAmount}
                                onChange={(event) => setLaybuyPaymentAmount(event.target.value)}
                                placeholder="Amount"
                                className="sm:col-span-1"
                              />
                              <select
                                value={laybuyPaymentMethod}
                                onChange={(event) => setLaybuyPaymentMethod(event.target.value)}
                                className="h-10 rounded-md border bg-background px-3 text-sm sm:col-span-1"
                              >
                                {PAYMENT_METHODS.map((method) => (
                                  <option key={method}>{method}</option>
                                ))}
                              </select>
                              <Input
                                value={laybuyPaymentReference}
                                onChange={(event) => setLaybuyPaymentReference(event.target.value)}
                                placeholder="Reference"
                                className="sm:col-span-1"
                              />
                              <Input
                                value={laybuyPaymentNotes}
                                onChange={(event) => setLaybuyPaymentNotes(event.target.value)}
                                placeholder="Notes"
                                className="sm:col-span-1"
                              />
                              <div className="flex gap-2 sm:col-span-1">
                                <Button
                                  size="sm"
                                  className="flex-1"
                                  onClick={() => void recordLaybuyPayment()}
                                  disabled={isRecordingLaybuyPayment}
                                >
                                  {isRecordingLaybuyPayment && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setLaybuyPaymentId('');
                                    setLaybuyPaymentAmount('');
                                  }}
                                  disabled={isRecordingLaybuyPayment}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setLaybuyPaymentId(laybuy.id)}>
                              <CreditCard className="mr-2 h-4 w-4" /> Add Payment
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Create Manual Laybuy</h3>
                <p className="text-xs text-muted-foreground">Use this when the laybuy did not start from the POS cart.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="laybuy-total">Total</Label>
                  <Input
                    id="laybuy-total"
                    type="number"
                    min="0"
                    step="0.01"
                    value={newLaybuyTotal}
                    onChange={(event) => setNewLaybuyTotal(event.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="laybuy-deposit">Deposit</Label>
                  <Input
                    id="laybuy-deposit"
                    type="number"
                    min="0"
                    step="0.01"
                    value={newLaybuyDeposit}
                    onChange={(event) => setNewLaybuyDeposit(event.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="laybuy-method">Deposit Method</Label>
                  <select
                    id="laybuy-method"
                    value={newLaybuyPaymentMethod}
                    onChange={(event) => setNewLaybuyPaymentMethod(event.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method}>{method}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="laybuy-due-date">Due Date</Label>
                  <Input
                    id="laybuy-due-date"
                    type="date"
                    value={newLaybuyDueDate}
                    onChange={(event) => setNewLaybuyDueDate(event.target.value)}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="laybuy-notes">Notes</Label>
                  <Textarea
                    id="laybuy-notes"
                    value={newLaybuyNotes}
                    onChange={(event) => setNewLaybuyNotes(event.target.value)}
                    placeholder="Optional laybuy notes"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={() => void createLaybuy()} disabled={isCreatingLaybuy}>
                  {isCreatingLaybuy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Laybuy
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(activityCustomer)} onOpenChange={(open) => !open && setActivityCustomer(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Account Activity</DialogTitle>
            <DialogDescription>
              {activityCustomer ? `Recent customer account activity for ${activityCustomer.name}.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {isLoadingTransactions ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : transactions.length > 0 ? (
              transactions.map((tx) => {
                const direction = String(tx.direction || '').toLowerCase();
                const entryType = String(tx.entryType ?? tx.entry_type ?? 'Activity').replace(/_/g, ' ');
                const amount = toNumber(tx.amount, 0);
                const balanceAfter = toNumber(tx.balanceAfter ?? tx.balance_after, 0);
                const createdAt = tx.createdAt ?? tx.created_at;
                return (
                  <div key={tx.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium capitalize">{entryType}</p>
                        <p className="text-xs text-muted-foreground">
                          {createdAt ? new Date(createdAt).toLocaleString() : 'No date'}
                          {tx.paymentMethod || tx.payment_method ? ` - ${tx.paymentMethod ?? tx.payment_method}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={direction === 'credit' ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>
                          {direction === 'credit' ? '-' : '+'}{format(amount)}
                        </p>
                        <p className="text-xs text-muted-foreground">Balance {format(balanceAfter)}</p>
                      </div>
                    </div>
                    {(tx.reference || tx.notes) && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {[tx.reference, tx.notes].filter(Boolean).join(' - ')}
                      </p>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="flex h-32 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <ReceiptText className="mb-3 h-10 w-10 text-muted-foreground/30" />
                No account activity yet.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
