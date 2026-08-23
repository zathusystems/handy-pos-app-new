'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  DollarSign,
  Package,
  ShoppingCart,
  TrendingUp,
  Circle,
  Download,
  Calendar as CalendarIcon,
  AlertTriangle,
  ClipboardList,
  Loader2,
  Truck,
  Repeat2,
  Trash2,
  Receipt,
  FileText,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { DateRange } from 'react-day-picker';
import { endOfDay, format, startOfDay, subDays } from 'date-fns';
import { useRouter } from 'next/navigation';
import Papa from 'papaparse';

import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadTextFile } from '@/lib/file-download';
import { isKitchenBusinessType } from '@/lib/inventory/config';
import { ViewOrdersModal } from '@/components/pos/view-orders-modal';

interface DashboardData {
  kpiData?: Array<{
    title: string;
    value: number;
    change: string;
    icon: string;
  }>;
  topProducts?: Array<{
    name: string;
    unitsSold: number;
    revenue: number;
    profit: number;
  }>;
  paymentData?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  amountDueData?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  collectionSummary?: {
    total_collected: number;
    account_invoice_due: number;
    laybuy_outstanding: number;
    total_due: number;
  };
  salesData?: Array<{
    name: string;
    total: number;
  }>;
  lowStockItems?: Array<{
    id: string;
    name: string;
    category: string;
    stock_units: number;
    unit_type: string;
    reorder_level: number;
    status: string;
  }>;
  expiringProducts?: Array<{
    id: string;
    productId?: string;
    productName: string;
    category?: string;
    batchNumber?: string | null;
    expiryDate: string;
    quantityRemaining: number;
    unitType?: string;
    daysUntilExpiry: number;
    status: 'Expired' | 'Expires Today' | 'Expiring Soon';
  }>;
  todayOrders?: Array<{
    id: string;
    orderNumber: number;
    status: 'New' | 'Preparing' | 'Ready' | 'Completed';
    total: number;
  }>;
  takeOrders?: Array<{
    id: string;
    orderNumber: number;
    status: 'Pending' | 'Confirmed' | 'Sent to Kitchen' | 'Preparing' | 'Ready' | 'Completed' | 'Cancelled';
    customerName?: string;
    total?: number;
  }>;
  recentSales?: Array<{
    id: string;
    description?: string;
    amount: number;
    paymentMethod: string;
    createdAt: string;
  }>;
  activeSession?: {
    id: string;
    status: string;
    started_by_user_id?: string | null;
    started_by_name?: string | null;
    started_by_email?: string | null;
    opening_float: number;
    expected_cash: number;
    total_sales: number;
    total_cash_sales: number;
    total_card_sales: number;
    total_mobile_money_sales: number;
    total_on_account_sales: number;
    total_tips: number;
    started_at: string;
    active_session_count?: number;
  } | null;
}

const iconMap: Record<string, React.ComponentType<any>> = {
  DollarSign,
  TrendingUp,
  ShoppingCart,
  Package,
};

const parseDashboardDateTime = (value: unknown): Date | null => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const hasExplicitTimezone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);

  if (hasExplicitTimezone) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const localDateMatch =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(
      normalized
    );
  if (localDateMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', fractional = '0'] = localDateMatch;
    const milliseconds = Number.parseInt(fractional.padEnd(3, '0').slice(0, 3), 10) || 0;
    const parsed = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
      milliseconds
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallbackParsed = new Date(normalized);
  return Number.isNaN(fallbackParsed.getTime()) ? null : fallbackParsed;
};

const getCurrentDaySession = (session: DashboardData['activeSession']) => {
  if (!session) {
    return null;
  }

  const startedAt = parseDashboardDateTime(session.started_at);
  if (!startedAt) {
    return null;
  }

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
  const startedToday = startedAt >= todayStart && startedAt <= todayEnd;

  return startedToday ? session : null;
};

const doesRangeIncludeToday = (dateRange?: DateRange) => {
  if (!dateRange?.from || !dateRange?.to) {
    return true;
  }

  const rangeStart = startOfDay(dateRange.from);
  const rangeEnd = endOfDay(dateRange.to);
  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  return rangeStart <= todayEnd && rangeEnd >= todayStart;
};

const formatExpiryAlertTime = (daysUntilExpiry: number) => {
  if (daysUntilExpiry < 0) {
    const overdueDays = Math.abs(daysUntilExpiry);
    return `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`;
  }

  if (daysUntilExpiry === 0) {
    return 'expires today';
  }

  return `${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'} left`;
};

function DashboardFilters({
  date,
  setDate,
  onExport,
  isExportDisabled = false,
}: {
  date?: DateRange;
  setDate: (date?: DateRange) => void;
  onExport: () => void;
  isExportDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Welcome back, here&apos;s a look at your business.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="date"
              variant={'outline'}
              className={cn('w-full justify-start text-left font-normal sm:w-[260px]', !date && 'text-muted-foreground')}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {date?.from ? (
                date.to ? (
                  <>
                    {format(date.from, 'LLL dd, y')} - {format(date.to, 'LLL dd, y')}
                  </>
                ) : (
                  format(date.from, 'LLL dd, y')
                )
              ) : (
                <span>Pick a date</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-auto" align="end">
            <DropdownMenuItem onClick={() => setDate({ from: startOfDay(new Date()), to: endOfDay(new Date()) })}>
              Today
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const yesterday = subDays(new Date(), 1);
                setDate({ from: startOfDay(yesterday), to: endOfDay(yesterday) });
              }}
            >
              Yesterday
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDate({ from: startOfDay(subDays(new Date(), 7)), to: endOfDay(new Date()) })}>
              Last 7 Days
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDate({ from: startOfDay(subDays(new Date(), 30)), to: endOfDay(new Date()) })}>
              Last 30 Days
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Custom Range</DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="w-auto p-0">
                  <Calendar
                    initialFocus
                    mode="range"
                    defaultMonth={date?.from}
                    selected={date}
                    onSelect={setDate}
                    numberOfMonths={2}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="icon"
          className="hidden sm:inline-flex"
          onClick={onExport}
          disabled={isExportDisabled}
        >
          <Download className="h-4 w-4" />
          <span className="sr-only">Download Report</span>
        </Button>
      </div>
    </div>
  );
}

function SessionSummaryCard({
  activeSession,
  emptyDescription = 'You do not have an active session.',
  emptyHint = 'Go to the Sessions page to start a new session.',
}: {
  activeSession: DashboardData['activeSession'];
  emptyDescription?: string;
  emptyHint?: string;
}) {
  const { format: formatCurrency } = useCurrency();

  if (!activeSession) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active POS Session</CardTitle>
          <CardDescription>{emptyDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center text-muted-foreground py-8">
            <p>{emptyHint}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const activeSessionCount = activeSession.active_session_count || 1;
  const startedByName = (activeSession.started_by_name || '').trim();
  const generatedActiveSessionLabel = /^\d+\s+active sessions?\s+in this branch$/i;
  const shouldShowStarterName = Boolean(startedByName) && !generatedActiveSessionLabel.test(startedByName);
  const startedAt = parseDashboardDateTime(activeSession.started_at);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{activeSessionCount > 1 ? 'Active Sessions' : 'Current Session'}</CardTitle>
        <CardDescription>
          {activeSessionCount > 1
            ? `${activeSessionCount} active sessions in this branch`
            : (
              <>
                Started at {startedAt ? format(startedAt, 'p') : '-'}
                {shouldShowStarterName ? ` by ${startedByName}` : ''}
              </>
            )
          }
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="text-sm font-medium text-muted-foreground">Opening Float</div>
          <div className="text-2xl font-bold">{formatCurrency(activeSession.opening_float)}</div>
        </div>
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="text-sm font-medium text-muted-foreground">Cash Collected</div>
          <div className="text-2xl font-bold text-green-600">+{formatCurrency(activeSession.total_cash_sales)}</div>
        </div>
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="text-sm font-medium text-muted-foreground">Card / Mobile Collected</div>
          <div className="text-2xl font-bold text-blue-600">
            +{formatCurrency(activeSession.total_card_sales + activeSession.total_mobile_money_sales)}
          </div>
        </div>
        <div className="rounded-lg bg-muted/50 p-4">
          <div className="text-sm font-medium text-muted-foreground">Expected Cash</div>
          <div className="text-2xl font-bold">{formatCurrency(activeSession.expected_cash)}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function CollectionsDueCard({
  dashboardData,
  isLoading,
  formatCurrency,
}: {
  dashboardData: DashboardData | null;
  isLoading: boolean;
  formatCurrency: (value: number) => string;
}) {
  const paymentData = dashboardData?.paymentData || [];
  const amountDueData = dashboardData?.amountDueData || [];
  const collectionSummary = dashboardData?.collectionSummary;
  const totalCollected = Number(
    collectionSummary?.total_collected ??
      paymentData.reduce((sum, entry) => sum + Number(entry.value || 0), 0)
  );
  const totalDue = Number(
    collectionSummary?.total_due ??
      amountDueData.reduce((sum, entry) => sum + Number(entry.value || 0), 0)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collections & Due</CardTitle>
        <CardDescription>Money received is separate from customer balances still owed.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[250px] w-full" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-xs font-medium text-muted-foreground">Collected</div>
                <div className="mt-1 text-xl font-bold text-green-700">{formatCurrency(totalCollected)}</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-xs font-medium text-muted-foreground">Still Due</div>
                <div className="mt-1 text-xl font-bold text-amber-700">{formatCurrency(totalDue)}</div>
              </div>
            </div>
            <div className="space-y-4">
              {paymentData.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium">Collected By Method</p>
                  <div className="flex flex-wrap gap-2">
                    {paymentData.filter((entry) => Number(entry.value || 0) > 0).map((entry) => (
                      <Badge key={entry.name} variant="secondary" className="gap-2">
                        <Circle className="h-3 w-3" style={{ fill: entry.color, color: entry.color }} />
                        {entry.name}: {formatCurrency(Number(entry.value || 0))}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {amountDueData.some((entry) => Number(entry.value || 0) > 0) && (
                <div>
                  <p className="mb-2 text-sm font-medium">Balances Due</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {amountDueData.filter((entry) => Number(entry.value || 0) > 0).map((entry) => (
                      <div key={entry.name} className="rounded-lg border p-3">
                        <div className="text-xs text-muted-foreground">{entry.name}</div>
                        <div className="mt-1 font-semibold">{formatCurrency(Number(entry.value || 0))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {paymentData.every((entry) => Number(entry.value || 0) <= 0) &&
                amountDueData.every((entry) => Number(entry.value || 0) <= 0) && (
                  <p className="text-sm text-muted-foreground">No collections or outstanding balances for this period.</p>
                )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Admin/Manager Dashboard Component
function AdminManagerDashboard({
  dashboardData,
  isLoading,
  error,
  dateRange,
  setDateRange,
  formatCurrency,
  router,
  onExport,
}: any) {
  const currentDaySession = useMemo(
    () => getCurrentDaySession(dashboardData?.activeSession || null),
    [dashboardData?.activeSession]
  );
  const selectedRangeIncludesToday = useMemo(
    () => doesRangeIncludeToday(dateRange),
    [dateRange?.from, dateRange?.to]
  );
  const rangeFilteredActiveSession = selectedRangeIncludesToday ? currentDaySession : null;
  const sessionEmptyDescription = selectedRangeIncludesToday
    ? 'No active sessions started today.'
    : 'This card shows only sessions started today.';
  const sessionEmptyHint = selectedRangeIncludesToday
    ? 'Active sessions carried over from yesterday are not shown here.'
    : 'Include today in the date range to view today sessions.';

  if (error) {
    return (
      <div className="flex h-full flex-col gap-6">
        <DashboardFilters date={dateRange} setDate={setDateRange} onExport={onExport} isExportDisabled />
        <Card className="w-full text-center">
          <CardHeader>
            <CardTitle>Error Loading Dashboard</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="py-8">
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <DashboardFilters
        date={dateRange}
        setDate={setDateRange}
        onExport={onExport}
        isExportDisabled={isLoading}
      />

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-4">
        {isLoading
          ? Array(4)
              .fill(0)
              .map((_, i) => (
                <Card key={i}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-4" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-3/4" />
                    <Skeleton className="h-3 w-1/2 mt-2" />
                  </CardContent>
                </Card>
              ))
          : dashboardData?.kpiData.map((kpi: any, index: number) => {
              const IconComponent = iconMap[kpi.icon];
              const isCurrencyValue = kpi.title !== 'Total Transactions';
              const displayValue = isCurrencyValue ? formatCurrency(kpi.value) : kpi.value;
              return (
                <Card key={index}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{kpi.title}</CardTitle>
                    {IconComponent && <IconComponent className="h-4 w-4 text-muted-foreground" />}
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{displayValue}</div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4">
        <Button
          variant="outline"
          className="h-auto flex-row items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-500/5 hover:bg-blue-500/10 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 border-blue-500/20 dark:border-blue-500/30"
          onClick={() => router.push('/dashboard/inventory?tab=purchases&modal=receive')}
        >
          <Truck className="h-4 w-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="text-xs font-medium">Receive</span>
        </Button>

        <Button
          variant="outline"
          className="h-auto flex-row items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-500/5 hover:bg-red-500/10 dark:bg-red-500/10 dark:hover:bg-red-500/20 border-red-500/20 dark:border-red-500/30"
          onClick={() => router.push('/dashboard/inventory?tab=waste&modal=waste')}
        >
          <Trash2 className="h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400" />
          <span className="text-xs font-medium">Waste</span>
        </Button>

        <Button
          variant="outline"
          className="h-auto flex-row items-center justify-center gap-2 px-3 py-2 rounded-lg bg-orange-500/5 hover:bg-orange-500/10 dark:bg-orange-500/10 dark:hover:bg-orange-500/20 border-orange-500/20 dark:border-orange-500/30"
          onClick={() => router.push('/dashboard/expenses')}
        >
          <Receipt className="h-4 w-4 flex-shrink-0 text-orange-600 dark:text-orange-400" />
          <span className="text-xs font-medium">Expense</span>
        </Button>

        <Button
          variant="outline"
          className="h-auto flex-row items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/5 hover:bg-indigo-500/10 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 border-indigo-500/20 dark:border-indigo-500/30"
          onClick={() => router.push('/dashboard/inventory')}
        >
          <Package className="h-4 w-4 flex-shrink-0 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-medium">Inventory</span>
        </Button>
      </div>

      {/* Active Session and Recent Sales - Side by Side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Active Session */}
        <SessionSummaryCard
          activeSession={rangeFilteredActiveSession}
          emptyDescription={sessionEmptyDescription}
          emptyHint={sessionEmptyHint}
        />

        {/* Recent Sales */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Sales</CardTitle>
            <CardDescription>Latest transactions</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[250px] w-full" />
            ) : dashboardData?.recentSales && dashboardData.recentSales.length > 0 ? (
              <div className="space-y-4">
                {dashboardData.recentSales.map((sale: any) => (
                  <div key={sale.id} className="flex items-center justify-between border-b pb-3 last:border-0">
                    <div className="flex-1">
                      <p className="font-medium text-sm">{sale.description || `Sale #${sale.id}`}</p>
                      <p className="text-xs text-muted-foreground">{format(new Date(sale.createdAt), 'p')}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{formatCurrency(sale.amount)}</p>
                      <Badge variant="outline" className="text-xs mt-1">
                        {sale.paymentMethod}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-10">No recent sales.</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sales Performance and Top Products */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Sales Performance Chart */}
        <Card className="col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle>Sales Performance</CardTitle>
            <CardDescription>Showing sales trend for the selected period.</CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            {isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dashboardData?.salesData || []}>
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatCurrency(value as number)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 'var(--radius)',
                    }}
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Area type="monotone" dataKey="total" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorTotal)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top Products Table */}
        <Card>
          <CardHeader>
            <CardTitle>Top Selling Products</CardTitle>
            <CardDescription>Your best performers in the selected period.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[200px] w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboardData?.topProducts.map((product: any) => (
                    <TableRow key={product.name}>
                      <TableCell className="font-medium">{product.name}</TableCell>
                      <TableCell className="text-right">{formatCurrency(product.revenue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Collections and Inventory */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CollectionsDueCard
          dashboardData={dashboardData}
          isLoading={isLoading}
          formatCurrency={formatCurrency}
        />

        {/* Inventory Alerts */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Inventory Alerts</CardTitle>
                <CardDescription>Low stock and expiry warnings.</CardDescription>
              </div>
              {!isLoading && (
                <Badge variant="outline" className="shrink-0">
                  {(dashboardData?.lowStockItems?.length || 0) + (dashboardData?.expiringProducts?.length || 0)} alerts
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <Skeleton className="h-[200px] w-full" />
            ) : (dashboardData?.lowStockItems?.length || 0) + (dashboardData?.expiringProducts?.length || 0) > 0 ? (
              <>
                {dashboardData?.expiringProducts && dashboardData.expiringProducts.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Expiring Products</p>
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => router.push('/dashboard/inventory?tab=purchases')}>
                        Review
                      </Button>
                    </div>
                    {dashboardData.expiringProducts.map((item) => {
                      const isExpired = item.daysUntilExpiry < 0;
                      const isToday = item.daysUntilExpiry === 0;
                      return (
                        <div key={item.id} className="flex items-start gap-4 rounded-lg border p-3">
                          <div
                            className={cn(
                              'mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                              isExpired
                                ? 'bg-red-500/10 text-red-600'
                                : isToday
                                  ? 'bg-orange-500/10 text-orange-600'
                                  : 'bg-amber-500/10 text-amber-600'
                            )}
                          >
                            <AlertTriangle className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-sm">{item.productName}</p>
                              <Badge
                                variant={isExpired ? 'destructive' : 'secondary'}
                                className={cn('text-xs', !isExpired && isToday && 'bg-orange-100 text-orange-800 hover:bg-orange-100')}
                              >
                                {item.status}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {item.batchNumber ? `Batch ${item.batchNumber} · ` : ''}
                              {item.quantityRemaining} {item.unitType || 'units'} remaining · {formatExpiryAlertTime(item.daysUntilExpiry)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Expires {format(new Date(item.expiryDate), 'MMM dd, yyyy')}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {dashboardData?.lowStockItems && dashboardData.lowStockItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Low Stock</p>
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => router.push('/dashboard/inventory')}>
                        Reorder
                      </Button>
                    </div>
                    {dashboardData.lowStockItems.map((item: any) => (
                      <div key={item.id} className="flex items-start gap-4">
                        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-yellow-500/10 text-yellow-600">
                          <Package className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <p className="font-semibold text-sm">{item.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Stock: {item.stock_units} {item.unit_type}. Reorder level is {item.reorder_level}.
                          </p>
                        </div>
                        <Badge variant="secondary" className="text-xs">
                          Low Stock
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center text-muted-foreground py-10">No inventory alerts.</div>
            )}
          </CardContent>
        </Card>
      </div>

    </div>
  );
}

// Cashier/Waiter Dashboard Component
function CashierWaiterDashboard({
  dashboardData,
  isLoading,
  error,
  formatCurrency,
  router,
  activeBranchId,
  businessType,
  currentUserRole,
}: any) {
  const [isOrdersModalOpen, setIsOrdersModalOpen] = useState(false);
  const currentDaySession = useMemo(
    () => getCurrentDaySession(dashboardData?.activeSession || null),
    [dashboardData?.activeSession]
  );
  const takeOrders = dashboardData?.takeOrders || [];
  const openOrderCount = takeOrders.filter((order: any) => !['Completed', 'Cancelled'].includes(String(order.status || ''))).length;
  const attentionOrderCount = takeOrders.filter((order: any) => ['Pending', 'Confirmed', 'New'].includes(String(order.status || ''))).length;
  const readyOrderCount = takeOrders.filter((order: any) => String(order.status || '') === 'Ready').length;

  if (error) {
    return (
      <div className="flex h-full flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground">Welcome back, here&apos;s your quick overview.</p>
          </div>
        </div>
        <Card className="w-full text-center">
          <CardHeader>
            <CardTitle>Error Loading Dashboard</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="py-8">
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Welcome back, here&apos;s your quick overview.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              Orders
            </CardTitle>
            <CardDescription>Take new orders and respond to customer requests.</CardDescription>
          </div>
          <Button onClick={() => setIsOrdersModalOpen(true)} disabled={!activeBranchId}>
            Open Orders
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Needs Attention</p>
                <p className="mt-1 text-2xl font-semibold">{attentionOrderCount}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Ready for Sale</p>
                <p className="mt-1 text-2xl font-semibold">{readyOrderCount}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Open Orders</p>
                <p className="mt-1 text-2xl font-semibold">{openOrderCount}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Collections and Session */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CollectionsDueCard
          dashboardData={dashboardData}
          isLoading={isLoading}
          formatCurrency={formatCurrency}
        />

        {/* Active Session */}
        <SessionSummaryCard
          activeSession={currentDaySession}
          emptyDescription="No active sessions started today."
          emptyHint="Active sessions carried over from yesterday are not shown here."
        />
      </div>

      {/* Recent Sales (Last Section) */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sales</CardTitle>
          <CardDescription>Latest transactions</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[250px] w-full" />
          ) : dashboardData?.recentSales && dashboardData.recentSales.length > 0 ? (
            <div className="space-y-4">
              {dashboardData.recentSales.map((sale: any) => (
                <div key={sale.id} className="flex items-center justify-between border-b pb-3 last:border-0">
                  <div className="flex-1">
                    <p className="font-medium text-sm">{sale.description || `Sale #${sale.id}`}</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(sale.createdAt), 'p')}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{formatCurrency(sale.amount)}</p>
                    <Badge variant="outline" className="text-xs mt-1">
                      {sale.paymentMethod}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-10">No recent sales.</div>
          )}
        </CardContent>
      </Card>
      {activeBranchId && (
        <ViewOrdersModal
          branchId={activeBranchId}
          isOpen={isOrdersModalOpen}
          onOpenChange={setIsOrdersModalOpen}
          businessType={businessType}
          currentUserRole={currentUserRole ?? null}
        />
      )}
    </div>
  );
}

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch'
};

export default function DashboardPage() {
  const { user, business, loading } = useAuth();
  const router = useRouter();
  const { format: formatCurrency } = useCurrency();
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);

  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfDay(new Date()),
    to: endOfDay(new Date()),
  });

  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get active branch ID from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
      setActiveBranchId(branchId);
      console.log('[Dashboard] Active branch ID:', branchId);
    }
  }, []);

  useEffect(() => {
    const fetchDashboardData = async () => {
      if (!dateRange?.from || !dateRange?.to || !activeBranchId) {
        console.log('[Dashboard] Skipping fetch - missing params:', { dateRange, activeBranchId });
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // Normalize branch reference for backend compatibility:
        // - BRN-10 -> 10
        // - 10 -> 10
        // - main/main-branch -> main
        // - invalid (NaN/null/undefined) -> omit branch_id to use backend default branch
        const normalizedBranch = (() => {
          const raw = String(activeBranchId || '').trim();
          if (!raw) return null;

          const lower = raw.toLowerCase();
          if (['nan', 'null', 'none', 'undefined'].includes(lower)) {
            return null;
          }

          const legacyMatch = /^BRN-(\d+)$/i.exec(raw);
          if (legacyMatch?.[1]) {
            return legacyMatch[1];
          }

          if (/^\d+$/.test(raw)) {
            return raw;
          }

          if (['main', 'main-branch', 'main_branch'].includes(lower)) {
            return 'main';
          }

          return raw;
        })();

        const params = new URLSearchParams({
          from_date: dateRange.from.toISOString(),
          to_date: dateRange.to.toISOString(),
        });
        if (normalizedBranch) {
          params.set('branch_id', normalizedBranch);
        }

        console.log('[Dashboard] Fetching data with params:', {
          from_date: dateRange.from.toISOString(),
          to_date: dateRange.to.toISOString(),
          branch_id: normalizedBranch,
        });

        const response = await authFetch.fetch<DashboardData>(`/business/dashboard/summary/?${params}`);
        console.log('[Dashboard] Fetched dashboard data:', response);
        console.log('[Dashboard] Today Orders:', response?.todayOrders);
        console.log('[Dashboard] Take Orders:', response?.takeOrders);
        console.log('[Dashboard] Today Orders Count:', response?.todayOrders?.length || 0);
        console.log('[Dashboard] Take Orders Count:', response?.takeOrders?.length || 0);
        setDashboardData(response);
      } catch (err: any) {
        console.error('Failed to fetch dashboard data:', err);
        setError(err.message || 'Failed to load dashboard data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, [dateRange, activeBranchId]);

  const handleExportDashboardData = () => {
    if (isLoading) {
      toast({
        title: 'Dashboard is still loading',
        description: 'Please wait for the latest data to finish loading before exporting.',
      });
      return;
    }

    if (!dashboardData) {
      toast({
        variant: 'destructive',
        title: 'No data to export',
        description: 'Dashboard data is not available yet.',
      });
      return;
    }

    const rows: Array<Record<string, string | number>> = [];

    dashboardData.kpiData?.forEach((kpi) => {
      rows.push({
        section: 'KPI',
        metric: kpi.title,
        value: Number(kpi.value || 0),
        change: kpi.change || '',
      });
    });

    dashboardData.salesData?.forEach((point) => {
      rows.push({
        section: 'Sales Trend',
        period: point.name,
        total: Number(point.total || 0),
      });
    });

    dashboardData.paymentData?.forEach((payment) => {
      rows.push({
        section: 'Collected Payment Method',
        method: payment.name,
        amount: Number(payment.value || 0),
      });
    });

    dashboardData.amountDueData?.forEach((due) => {
      rows.push({
        section: 'Amount Due',
        method: due.name,
        amount: Number(due.value || 0),
      });
    });

    dashboardData.topProducts?.forEach((product) => {
      rows.push({
        section: 'Top Product',
        name: product.name,
        unitsSold: Number(product.unitsSold || 0),
        revenue: Number(product.revenue || 0),
        profit: Number(product.profit || 0),
      });
    });

    dashboardData.lowStockItems?.forEach((item) => {
      rows.push({
        section: 'Low Stock',
        name: item.name,
        category: item.category,
        stockUnits: Number(item.stock_units || 0),
        reorderLevel: Number(item.reorder_level || 0),
        status: item.status,
      });
    });

    dashboardData.expiringProducts?.forEach((item) => {
      rows.push({
        section: 'Expiring Product',
        name: item.productName,
        category: item.category || '',
        batchNumber: item.batchNumber || '',
        expiryDate: item.expiryDate,
        quantityRemaining: Number(item.quantityRemaining || 0),
        unitType: item.unitType || '',
        daysUntilExpiry: Number(item.daysUntilExpiry || 0),
        status: item.status,
      });
    });

    dashboardData.recentSales?.forEach((sale) => {
      rows.push({
        section: 'Recent Sale',
        saleId: sale.id,
        description: sale.description || '',
        amount: Number(sale.amount || 0),
        paymentMethod: sale.paymentMethod,
        createdAt: sale.createdAt,
      });
    });

    if (rows.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No data to export',
        description: 'The selected period has no dashboard rows to export.',
      });
      return;
    }

    const csv = Papa.unparse(rows);
    const fromDate = format(dateRange?.from || new Date(), 'yyyy-MM-dd');
    const toDate = format(dateRange?.to || new Date(), 'yyyy-MM-dd');
    const filename = `dashboard-summary-${fromDate}-to-${toDate}.csv`;
    const downloadStarted = downloadTextFile(csv, filename);

    if (!downloadStarted) {
      toast({
        variant: 'destructive',
        title: 'Export failed',
        description: 'Unable to trigger file download on this device.',
      });
      return;
    }

    toast({
      title: 'Export complete',
      description: `${rows.length} records were exported to ${filename}.`,
    });
  };

  const kitchenAvailable = isKitchenBusinessType(business?.type);

  useEffect(() => {
    if (!loading && user?.role === 'Kitchen Staff' && kitchenAvailable) {
      router.replace('/dashboard/kitchen');
    }
  }, [kitchenAvailable, loading, user?.role, router]);

  if (loading) {
    return (
      <div className="tauri-android-safe-bottom flex h-[100dvh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Route based on user role
  if (user?.role === 'Admin' || user?.role === 'Manager') {
    return (
      <AdminManagerDashboard
        dashboardData={dashboardData}
        isLoading={isLoading}
        error={error}
        dateRange={dateRange}
        setDateRange={setDateRange}
        formatCurrency={formatCurrency}
        router={router}
        onExport={handleExportDashboardData}
      />
    );
  }

  if (user?.role === 'Cashier' || user?.role === 'Waiter') {
    return (
      <CashierWaiterDashboard
        dashboardData={dashboardData}
        isLoading={isLoading}
        error={error}
        formatCurrency={formatCurrency}
        router={router}
        activeBranchId={activeBranchId}
        businessType={business?.type}
        currentUserRole={user?.role ?? null}
      />
    );
  }

  if (user?.role === 'Kitchen Staff') {
    return (
      <CashierWaiterDashboard
        dashboardData={dashboardData}
        isLoading={isLoading}
        error={error}
        formatCurrency={formatCurrency}
        router={router}
        activeBranchId={activeBranchId}
        businessType={business?.type}
        currentUserRole={user?.role ?? null}
      />
    );
  }

  return null;
}
