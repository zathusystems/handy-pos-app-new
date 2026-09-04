'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format, subDays } from 'date-fns';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CheckCircle2,
  CircleAlert,
  FileText,
  Landmark,
  Loader2,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';

import SaleDetailModal from '@/app/dashboard/sessions/modals/sale-detail-modal';
import { PaginationControls, usePaginatedItems } from '@/app/dashboard/inventory/components/pagination-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { useToast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import { db, type Order } from '@/lib/db';
import { syncService } from '@/lib/services/sync-service';

type FiscalStatus = 'PENDING' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'MISSING';
type StatusFilter = 'all' | Lowercase<FiscalStatus>;

type Terminal = {
  id: string;
  status?: string;
  terminalId?: string;
  mraTerminalId?: string;
  deviceSerial?: string;
  isOnline?: boolean | null;
  blockingStatus?: string | null;
  pendingOfflineInvoices?: number;
  lastSyncAt?: string | null;
};

const ACTIVE_BRANCH_STORAGE_KEY = 'handypos-active-branch';
const DEVICE_SERIAL_KEY = 'handypos-device-serial';
const LEGACY_DEVICE_SERIAL_KEY = 'handypos-eis-device-serial';

const getDeviceSerial = (): string => {
  if (typeof window === 'undefined') return '';

  const existing = window.localStorage.getItem(DEVICE_SERIAL_KEY) || window.localStorage.getItem(LEGACY_DEVICE_SERIAL_KEY);
  if (existing) {
    window.localStorage.setItem(DEVICE_SERIAL_KEY, existing);
    return existing;
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = userAgent.includes('android')
    ? 'AND'
    : userAgent.includes('win')
      ? 'WIN'
      : userAgent.includes('mac')
        ? 'MAC'
        : userAgent.includes('linux')
          ? 'LNX'
          : 'WEB';
  const serial = `HANDY-${platform}-${Date.now().toString(36).toUpperCase()}`;
  window.localStorage.setItem(DEVICE_SERIAL_KEY, serial);
  return serial;
};

const asList = <T,>(value: any): T[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};

const normalizeBranchId = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];
  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];
  return normalized;
};

const getBranchIdCandidates = (branchId?: string | null): string[] => {
  const raw = String(branchId ?? '').trim();
  const normalized = normalizeBranchId(raw);
  if (!normalized) return [];

  const candidates = new Set([raw, normalized]);
  if (/^\d+$/.test(normalized)) {
    candidates.add(`BRN-${normalized}`);
    candidates.add(`branch-${normalized}`);
  }
  return Array.from(candidates).filter(Boolean);
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toText = (value: unknown): string => String(value ?? '').trim();

const readBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const normalized = toText(value).toLowerCase();
  if (['true', '1', 'yes', 'online', 'active'].includes(normalized)) return true;
  if (['false', '0', 'no', 'offline'].includes(normalized)) return false;
  return null;
};

const getOrderDate = (order: Order): Date | null => {
  const raw = (order as any).createdAt ?? (order as any).created_at;
  const date = new Date(String(raw ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
};

const resolveFiscalStatus = (order: Order): FiscalStatus => {
  const source = order as any;
  const status = toText(source.eisStatus ?? source.eis_status).toUpperCase();
  if (status === 'PENDING' || status === 'SUBMITTED' || status === 'ACCEPTED' || status === 'REJECTED') {
    return status;
  }
  if (toText(source.fiscalInvoiceNumber ?? source.fiscal_invoice_number)) return 'SUBMITTED';
  return source._dirty ? 'PENDING' : 'MISSING';
};

const resolveFiscalNumber = (order: Order): string => toText(
  (order as any).fiscalInvoiceNumber ??
  (order as any).fiscal_invoice_number ??
  (order as any).receiptNumber ??
  (order as any).receipt_number
);

const resolveBuyer = (order: Order): string => toText(
  (order as any).customerName ??
  (order as any).customer_name ??
  (order as any).buyerName ??
  (order as any).buyer_name
);

const resolveOrderTotal = (order: Order): number => toNumber(
  (order as any).grossAmount ??
  (order as any).gross_amount ??
  order.total
);

const resolveOrderVat = (order: Order): number => toNumber(
  (order as any).vatAmount ??
  (order as any).vat_amount ??
  order.tax
);

const resolveTerminalBranchId = (terminal: any): string => {
  const branch = terminal?.branch;
  if (branch && typeof branch === 'object') {
    return toText(branch.id ?? branch.pk ?? branch.branch_id ?? branch.branchId);
  }
  return toText(branch ?? terminal?.branch_id ?? terminal?.branchId);
};

const resolveTerminalDeviceSerial = (terminal: any): string => toText(
  terminal?.device_serial ?? terminal?.deviceSerial ?? terminal?.mac_address ?? terminal?.macAddress
);

const mapTerminal = (payload: any, fallback?: Terminal | null): Terminal => ({
  ...(fallback || {}),
  id: toText(payload?.id ?? fallback?.id),
  status: toText(payload?.status ?? fallback?.status),
  terminalId: toText(payload?.terminal_id ?? payload?.terminalId ?? fallback?.terminalId),
  mraTerminalId: toText(payload?.mra_terminal_id ?? payload?.mraTerminalId ?? fallback?.mraTerminalId),
  deviceSerial: toText(payload?.device_serial ?? payload?.deviceSerial ?? fallback?.deviceSerial),
  isOnline: readBoolean(payload?.is_online ?? payload?.isOnline ?? fallback?.isOnline),
  blockingStatus: toText(payload?.blocking_status ?? payload?.blockingStatus ?? fallback?.blockingStatus) || null,
  pendingOfflineInvoices: toNumber(payload?.pending_offline_invoices ?? payload?.pendingOfflineInvoices ?? fallback?.pendingOfflineInvoices),
  lastSyncAt: toText(payload?.last_sync_at ?? payload?.lastSyncAt ?? fallback?.lastSyncAt) || null,
});

const statusVariant = (status: FiscalStatus): 'default' | 'secondary' | 'destructive' | 'outline' => {
  if (status === 'ACCEPTED' || status === 'SUBMITTED') return 'default';
  if (status === 'PENDING') return 'secondary';
  if (status === 'REJECTED') return 'destructive';
  return 'outline';
};

const statusIcon = (status: FiscalStatus) => {
  if (status === 'ACCEPTED' || status === 'SUBMITTED') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'REJECTED') return <XCircle className="h-3.5 w-3.5" />;
  if (status === 'PENDING') return <Loader2 className="h-3.5 w-3.5" />;
  return <CircleAlert className="h-3.5 w-3.5" />;
};

export default function EisSalesPage() {
  const { business } = useAuth();
  const { format: formatCurrency } = useCurrency();
  const { toast } = useToast();
  const businessId = String(business?.id ?? '').trim();
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [isEisEnabled, setIsEisEnabled] = useState<boolean | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [isLoadingTerminal, setIsLoadingTerminal] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [fromDate, setFromDate] = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'));
  const [toDate, setToDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  useEffect(() => {
    const readActiveBranch = () => setActiveBranchId(
      window.localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY) ||
      window.localStorage.getItem('current-branch') ||
      null
    );
    const handleBranchChanged = (event: Event) => {
      const nextBranchId = toText((event as CustomEvent<{ branchId?: unknown }>).detail?.branchId);
      setActiveBranchId(nextBranchId || window.localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY) || null);
    };

    readActiveBranch();
    window.addEventListener('storage', readActiveBranch);
    window.addEventListener('branchChanged', handleBranchChanged);
    window.addEventListener('handypos-active-branch-changed', handleBranchChanged);
    return () => {
      window.removeEventListener('storage', readActiveBranch);
      window.removeEventListener('branchChanged', handleBranchChanged);
      window.removeEventListener('handypos-active-branch-changed', handleBranchChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadEisStatus = async () => {
      if (!businessId) {
        if (!cancelled) setIsEisEnabled(false);
        return;
      }

      try {
        const response = await authFetch.fetch<any>(`/business/businesses/${businessId}/`);
        const enabled = response?.enable_eis ?? response?.enableEis ?? response?.settings?.enable_eis ?? response?.settings?.enableEis;
        if (!cancelled) setIsEisEnabled(enabled === true || enabled === 'true');
      } catch (error) {
        console.warn('[EIS Sales] Could not read EIS setting from server:', error);
        const localSettings = await db.businessSettings.get(businessId);
        if (!cancelled) setIsEisEnabled(localSettings?.enableEis === true);
      }
    };

    void loadEisStatus();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const loadTerminal = useCallback(async () => {
    if (!businessId || !activeBranchId || isEisEnabled !== true) {
      setTerminal(null);
      return;
    }

    setIsLoadingTerminal(true);
    try {
      const requestedBranchId = normalizeBranchId(activeBranchId);
      const params = new URLSearchParams({
        business_id: businessId,
        branch_id: requestedBranchId,
        device_serial: getDeviceSerial(),
      });
      const response = await authFetch.fetch<any>(`/mra-eis/terminals/?${params.toString()}`);
      const branchCandidates = new Set(getBranchIdCandidates(activeBranchId).map(normalizeBranchId));
      const currentDeviceSerial = getDeviceSerial().toLowerCase();
      const branchTerminals = asList<any>(response).filter((candidate) => (
        branchCandidates.has(normalizeBranchId(resolveTerminalBranchId(candidate)))
      ));
      const selected =
        branchTerminals.find((candidate) => (
          toText(candidate?.status).toLowerCase() === 'active' &&
          resolveTerminalDeviceSerial(candidate).toLowerCase() === currentDeviceSerial
        )) ||
        branchTerminals.find((candidate) => resolveTerminalDeviceSerial(candidate).toLowerCase() === currentDeviceSerial) ||
        branchTerminals.find((candidate) => toText(candidate?.status).toLowerCase() === 'active') ||
        branchTerminals[0];

      if (!selected?.id) {
        setTerminal(null);
        return;
      }

      let nextTerminal = mapTerminal(selected);
      try {
        const status = await authFetch.fetch<any>(`/mra-eis/terminals/${selected.id}/status/`);
        nextTerminal = mapTerminal(status, nextTerminal);
      } catch (error) {
        console.warn('[EIS Sales] Could not refresh terminal status:', error);
      }
      setTerminal(nextTerminal);
    } catch (error) {
      console.warn('[EIS Sales] Could not load terminal:', error);
      setTerminal(null);
    } finally {
      setIsLoadingTerminal(false);
    }
  }, [activeBranchId, businessId, isEisEnabled]);

  useEffect(() => {
    void loadTerminal();
  }, [loadTerminal]);

  const allOrders = useLiveQuery(async () => {
    const orders = await db.orders.toArray();
    const branchIds = new Set(getBranchIdCandidates(activeBranchId).map(normalizeBranchId));
    const branchOrders = branchIds.size > 0
      ? orders.filter((order) => branchIds.has(normalizeBranchId((order as any).branchId ?? (order as any).branch_id)))
      : [];
    return branchOrders.sort((first, second) => (
      (getOrderDate(second)?.getTime() ?? 0) - (getOrderDate(first)?.getTime() ?? 0)
    ));
  }, [activeBranchId]);

  const filteredOrders = useMemo(() => {
    const start = fromDate ? new Date(`${fromDate}T00:00:00`) : null;
    const end = toDate ? new Date(`${toDate}T23:59:59.999`) : null;
    const query = searchQuery.trim().toLowerCase();

    return (allOrders || []).filter((order) => {
      const createdAt = getOrderDate(order);
      if (start && createdAt && createdAt < start) return false;
      if (end && createdAt && createdAt > end) return false;

      const status = resolveFiscalStatus(order);
      if (statusFilter !== 'all' && status.toLowerCase() !== statusFilter) return false;
      if (!query) return true;

      const fields = [
        (order as any).orderNumber,
        (order as any).order_number,
        resolveFiscalNumber(order),
        resolveBuyer(order),
        (order as any).customerTin,
        (order as any).customer_tin,
      ];
      return fields.some((value) => String(value ?? '').toLowerCase().includes(query));
    });
  }, [allOrders, fromDate, searchQuery, statusFilter, toDate]);

  const fiscalSummary = useMemo(() => filteredOrders.reduce(
    (summary, order) => {
      const status = resolveFiscalStatus(order);
      summary.total += 1;
      summary[status.toLowerCase() as Lowercase<FiscalStatus>] += 1;
      summary.vat += resolveOrderVat(order);
      summary.value += resolveOrderTotal(order);
      return summary;
    },
    { total: 0, pending: 0, submitted: 0, accepted: 0, rejected: 0, missing: 0, vat: 0, value: 0 }
  ), [filteredOrders]);

  const {
    paginatedItems,
    effectiveCurrentPage,
    pageEndIndex,
    pageStartIndex,
    setCurrentPage,
    totalItems,
    totalPages,
  } = usePaginatedItems(filteredOrders);

  useEffect(() => {
    setCurrentPage(1);
  }, [fromDate, searchQuery, setCurrentPage, statusFilter, toDate]);

  const refreshData = async () => {
    if (!activeBranchId) return;
    setIsRefreshing(true);
    try {
      await syncService.performFullSync(activeBranchId);
      await loadTerminal();
      toast({ title: 'Fiscal sales refreshed' });
    } catch (error) {
      console.error('[EIS Sales] Could not refresh sales:', error);
      toast({
        variant: 'destructive',
        title: 'Refresh failed',
        description: 'Could not refresh the branch data. Check the connection and try again.',
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  if (isEisEnabled === false) {
    return (
      <div className="flex flex-1 items-start justify-center pt-10">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Fiscal Sales</CardTitle>
            <CardDescription>EIS must be enabled before fiscal sales can be viewed for this business.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/dashboard/settings/eis">Open EIS Integration</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 py-1 sm:gap-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Fiscal Sales</h1>
          <p className="mt-1 text-sm text-muted-foreground">EIS sales, fiscal receipt numbers, and submission state for the active branch.</p>
        </div>
        <Button variant="outline" onClick={() => void refreshData()} disabled={!activeBranchId || isRefreshing} className="w-full sm:w-auto">
          {isRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric title="Fiscal sales" value={fiscalSummary.total} detail="Current filters" />
        <Metric title="Accepted / submitted" value={fiscalSummary.accepted + fiscalSummary.submitted} detail={`${fiscalSummary.accepted} accepted, ${fiscalSummary.submitted} submitted`} />
        <Metric title="Pending" value={fiscalSummary.pending} detail="Awaiting EIS submission" tone={fiscalSummary.pending > 0 ? 'warning' : 'default'} />
        <Metric title="Rejected" value={fiscalSummary.rejected} detail="Needs attention" tone={fiscalSummary.rejected > 0 ? 'danger' : 'default'} />
        <Metric title="Fiscal value" value={formatCurrency(fiscalSummary.value)} detail={`VAT ${formatCurrency(fiscalSummary.vat)}`} />
      </div>

      <Card>
        <CardHeader className="gap-3 pb-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Landmark className="h-4 w-4" /> EIS Terminal</CardTitle>
              <CardDescription className="mt-1">The terminal used by this branch for fiscal transactions.</CardDescription>
            </div>
            {isLoadingTerminal && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          {terminal ? (
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <TerminalField label="Terminal" value={terminal.mraTerminalId || terminal.terminalId || 'Pending assignment'} />
              <TerminalField label="Status" value={terminal.status || 'Unknown'} />
              <TerminalField label="Connection" value={terminal.isOnline === true ? 'Online' : terminal.isOnline === false ? 'Offline' : 'Not checked'} />
              <TerminalField label="Pending offline" value={String(terminal.pendingOfflineInvoices || 0)} />
              {terminal.lastSyncAt && <TerminalField label="Last sync" value={format(new Date(terminal.lastSyncAt), 'PP p')} />}
              {terminal.blockingStatus && <TerminalField label="MRA notice" value={terminal.blockingStatus} />}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No EIS terminal is linked to this branch and device yet.</p>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-0">
        <CardHeader className="gap-4 pb-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" /> Fiscal receipt register</CardTitle>
            <CardDescription className="mt-1">Only fiscal status belongs here. Business reporting remains in Reports.</CardDescription>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative sm:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search sale, receipt, buyer, or TIN" className="pl-9" />
            </div>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
              <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="missing">No fiscal data</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="fiscal-sales-from" className="sr-only">From date</Label>
                <Input id="fiscal-sales-from" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fiscal-sales-to" className="sr-only">To date</Label>
                <Input id="fiscal-sales-to" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sale</TableHead>
                  <TableHead>Fiscal receipt</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="w-20 text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allOrders === undefined ? (
                  <TableRow><TableCell colSpan={8} className="h-28 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></TableCell></TableRow>
                ) : paginatedItems.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="h-28 text-center text-sm text-muted-foreground">No fiscal sales match these filters.</TableCell></TableRow>
                ) : paginatedItems.map((order) => {
                  const status = resolveFiscalStatus(order);
                  const issuedAt = getOrderDate(order);
                  const isExport = (order as any).isExport === true || (order as any).is_export === true;
                  const isRelief = (order as any).isReliefSupply === true || (order as any).is_relief_supply === true;
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <p className="font-medium">Sale #{(order as any).orderNumber ?? (order as any).order_number ?? 'N/A'}</p>
                        <p className="text-xs text-muted-foreground">{(order as any).paymentMethod ?? (order as any).payment_method ?? 'N/A'}</p>
                      </TableCell>
                      <TableCell className="max-w-52 break-all font-mono text-xs">{resolveFiscalNumber(order) || 'Not assigned'}</TableCell>
                      <TableCell className="max-w-44">
                        <p className="truncate">{resolveBuyer(order) || 'Walk-in'}</p>
                        {(isExport || isRelief) && <div className="mt-1 flex flex-wrap gap-1">{isExport && <Badge variant="outline">Export</Badge>}{isRelief && <Badge variant="outline">VAT relief</Badge>}</div>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{issuedAt ? format(issuedAt, 'PP p') : 'N/A'}</TableCell>
                      <TableCell><Badge variant={statusVariant(status)} className="gap-1">{statusIcon(status)}{status}</Badge></TableCell>
                      <TableCell className="text-right">{formatCurrency(resolveOrderVat(order))}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(resolveOrderTotal(order))}</TableCell>
                      <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => setSelectedOrder(order)}>View</Button></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            currentPage={effectiveCurrentPage}
            totalItems={totalItems}
            totalPages={totalPages}
            pageStartIndex={pageStartIndex}
            pageEndIndex={pageEndIndex}
            onPageChange={setCurrentPage}
            itemLabel="fiscal sales"
          />
        </CardContent>
      </Card>

      <SaleDetailModal order={selectedOrder} isOpen={Boolean(selectedOrder)} onOpenChange={(open) => !open && setSelectedOrder(null)} />
    </div>
  );
}

function Metric({ title, value, detail, tone = 'default' }: { title: string; value: React.ReactNode; detail: string; tone?: 'default' | 'warning' | 'danger' }) {
  const valueClass = tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm font-medium">{title}</CardTitle></CardHeader>
      <CardContent><p className={`text-xl font-semibold ${valueClass}`}>{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent>
    </Card>
  );
}

function TerminalField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words font-medium">{value}</p>
    </div>
  );
}
