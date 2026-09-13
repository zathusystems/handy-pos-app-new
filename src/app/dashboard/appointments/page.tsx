'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  addDays,
  format as formatDate,
  parseISO,
  startOfWeek,
} from 'date-fns';
import {
  CalendarDays,
  CircleDollarSign,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Plus,
  Scissors,
  UserRound,
  X,
} from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { db, type Customer, type InventoryItem } from '@/lib/db';
import { syncInventoryFromBackend } from '@/lib/services/inventory-sync';
import { isSalonServiceBusinessType } from '@/lib/inventory/config';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';


const ACTIVE_BRANCH_KEY = 'handypos-active-branch';

type AppointmentServiceSnapshot = {
  inventory_item_id: string;
  name: string;
  category?: string;
  quantity: string | number;
  price: string | number;
  total?: string | number;
  recipe?: unknown[];
};

type Appointment = {
  id: string;
  branch: string | number;
  branch_name: string;
  customer: string | number;
  customer_name: string;
  customer_phone?: string;
  scheduled_start: string;
  scheduled_end: string;
  status: 'booked' | 'checked_in' | 'in_service' | 'ready_for_payment' | 'completed' | 'cancelled' | 'no_show';
  services: AppointmentServiceSnapshot[];
  total: string | number;
  notes?: string;
  take_order_id?: string | null;
  take_order_number?: number | null;
  cancellation_reason?: string;
  cancelled_at?: string | null;
  cancelled_by_name?: string | null;
  no_show_reason?: string;
  no_show_at?: string | null;
  no_show_by_name?: string | null;
  deposit_total?: string | number;
  balance_due?: string | number;
  deposits?: Array<{
    id: string;
    amount: string | number;
    payment_method: string;
    reference?: string;
    notes?: string;
    recorded_by_name?: string | null;
    created_at: string;
  }>;
};

type AppointmentSummary = {
  totals: {
    appointments: number;
    booked: number;
    checked_in: number;
    in_service: number;
    ready_for_payment: number;
    completed: number;
    cancelled: number;
    no_show: number;
    scheduled_value: string | number;
    completed_service_value: string | number;
    deposits_received: string | number;
    outstanding_scheduled_value: string | number;
  };
};

type ServiceRow = {
  inventoryItemId: string;
  quantity: string;
};

const toBackendBranchId = (value: string): string => {
  const normalized = String(value || '').trim();
  const match = /^BRN-(\d+)$/i.exec(normalized) || /^branch-(\d+)$/i.exec(normalized);
  return match ? match[1] : normalized;
};

const branchIdCandidates = (branchId: string): string[] => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return [];
  const backendId = toBackendBranchId(normalized);
  const candidates = new Set([normalized, backendId]);
  if (/^\d+$/.test(backendId)) {
    candidates.add(`BRN-${backendId}`);
    candidates.add(`branch-${backendId}`);
  }
  return Array.from(candidates);
};

const asCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: T[] }).results)) {
    return (payload as { results: T[] }).results;
  }
  return [];
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const statusMeta: Record<Appointment['status'], { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  checked_in: { label: 'Checked in', className: 'border-violet-200 bg-violet-50 text-violet-700' },
  in_service: { label: 'In service', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  ready_for_payment: { label: 'Ready for payment', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  completed: { label: 'Completed', className: 'border-slate-200 bg-slate-50 text-slate-700' },
  cancelled: { label: 'Cancelled', className: 'border-rose-200 bg-rose-50 text-rose-700' },
  no_show: { label: 'No show', className: 'border-rose-200 bg-rose-50 text-rose-700' },
};

const createLocalDateTime = (date: string, time: string): string => {
  const [hours = '0', minutes = '0'] = String(time || '00:00').split(':');
  const value = new Date(`${date}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`);
  return value.toISOString();
};

const inputDate = (value: string): string => formatDate(parseISO(value), 'yyyy-MM-dd');
const inputTime = (value: string): string => formatDate(parseISO(value), 'HH:mm');

export default function AppointmentsPage() {
  const { business, user } = useAuth();
  const { format: formatCurrency } = useCurrency();
  const [activeBranchId, setActiveBranchId] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => formatDate(new Date(), 'yyyy-MM-dd'));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [summary, setSummary] = useState<AppointmentSummary | null>(null);
  const [remoteCustomers, setRemoteCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [checkingInId, setCheckingInId] = useState<string | null>(null);
  const [depositAppointment, setDepositAppointment] = useState<Appointment | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMethod, setDepositMethod] = useState('Cash');
  const [depositReference, setDepositReference] = useState('');
  const [depositNotes, setDepositNotes] = useState('');
  const [isRecordingDeposit, setIsRecordingDeposit] = useState(false);
  const [outcomeAppointment, setOutcomeAppointment] = useState<Appointment | null>(null);
  const [outcomeType, setOutcomeType] = useState<'cancel' | 'no_show'>('cancel');
  const [outcomeReason, setOutcomeReason] = useState('');
  const [isRecordingOutcome, setIsRecordingOutcome] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([{ inventoryItemId: '', quantity: '1' }]);
  const [appointmentDate, setAppointmentDate] = useState(() => formatDate(new Date(), 'yyyy-MM-dd'));
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const setInitialBranch = () => setActiveBranchId(localStorage.getItem(ACTIVE_BRANCH_KEY) || '');
    setInitialBranch();
    window.addEventListener('branchChanged', setInitialBranch);
    return () => window.removeEventListener('branchChanged', setInitialBranch);
  }, []);

  const localCustomers = useLiveQuery(
    async () => {
      const candidates = branchIdCandidates(activeBranchId);
      if (!candidates.length) return [] as Customer[];
      return candidates.length === 1
        ? db.customers.where('branchId').equals(candidates[0]).toArray()
        : db.customers.where('branchId').anyOf(candidates).toArray();
    },
    [activeBranchId],
  ) || [];

  const branchInventory = useLiveQuery(
    async () => {
      const candidates = branchIdCandidates(activeBranchId);
      if (!candidates.length) return [] as InventoryItem[];
      return candidates.length === 1
        ? db.inventory.where('branchId').equals(candidates[0]).toArray()
        : db.inventory.where('branchId').anyOf(candidates).toArray();
    },
    [activeBranchId],
  ) || [];

  const services = useMemo(
    () => branchInventory
      .filter((item) => item.itemType === 'sellable' && Boolean(item.isService ?? item.is_service))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [branchInventory],
  );

  const customers = useMemo(() => {
    const merged = new Map<string, Customer>();
    for (const customer of [...localCustomers, ...remoteCustomers]) {
      merged.set(String(customer.id), customer);
    }
    return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [localCustomers, remoteCustomers]);

  const loadSchedule = useCallback(async () => {
    if (!activeBranchId) {
      setAppointments([]);
      return;
    }
    setIsLoading(true);
    try {
      const branchId = encodeURIComponent(toBackendBranchId(activeBranchId));
      const payload = await authFetch.fetch<unknown>(
        `/appointments/appointments/?branch=${branchId}&date=${selectedDate}`,
        { queueOnFailure: false },
      );
      setAppointments(asCollection<Appointment>(payload));
    } catch (error) {
      console.error('[Appointments] Failed to load schedule:', error);
      toast({ variant: 'destructive', title: 'Could not load appointments', description: error instanceof Error ? error.message : undefined });
    } finally {
      setIsLoading(false);
    }
  }, [activeBranchId, selectedDate]);

  const loadSummary = useCallback(async () => {
    if (!activeBranchId) {
      setSummary(null);
      return;
    }
    const weekStart = startOfWeek(new Date(`${selectedDate}T12:00:00`), { weekStartsOn: 1 });
    const weekEnd = addDays(weekStart, 6);
    try {
      const branchId = encodeURIComponent(toBackendBranchId(activeBranchId));
      const payload = await authFetch.fetch<AppointmentSummary>(
        `/appointments/appointments/summary/?branch=${branchId}&from_date=${formatDate(weekStart, 'yyyy-MM-dd')}&to_date=${formatDate(weekEnd, 'yyyy-MM-dd')}`,
        { queueOnFailure: false },
      );
      setSummary(payload);
    } catch (error) {
      console.warn('[Appointments] Failed to load salon summary:', error);
      setSummary(null);
    }
  }, [activeBranchId, selectedDate]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (!activeBranchId) return;
    let cancelled = false;
    const loadSupportingData = async () => {
      const branchId = encodeURIComponent(toBackendBranchId(activeBranchId));
      try {
        const payload = await authFetch.fetch<unknown>(`/customers/?branch=${branchId}`, { queueOnFailure: false });
        if (!cancelled) {
          setRemoteCustomers(asCollection<Customer>(payload));
        }
      } catch (error) {
        console.warn('[Appointments] Failed to refresh customers:', error);
      }
      try {
        await syncInventoryFromBackend(activeBranchId);
      } catch (error) {
        console.warn('[Appointments] Failed to refresh services:', error);
      }
    };
    void loadSupportingData();
    return () => {
      cancelled = true;
    };
  }, [activeBranchId]);

  const selectedServicesTotal = useMemo(() => serviceRows.reduce((total, row) => {
    const service = services.find((item) => String(item.id) === row.inventoryItemId);
    return total + numberValue(service?.price) * Math.max(numberValue(row.quantity), 0);
  }, 0), [serviceRows, services]);

  const scheduleStart = useMemo(() => startOfWeek(new Date(`${selectedDate}T12:00:00`), { weekStartsOn: 1 }), [selectedDate]);
  const scheduleDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(scheduleStart, index)), [scheduleStart]);

  const resetForm = useCallback((appointment?: Appointment | null) => {
    const next = appointment || null;
    setEditingAppointment(next);
    setCustomerId(next ? String(next.customer) : '');
    setServiceRows(next?.services?.length
      ? next.services.map((service) => ({ inventoryItemId: String(service.inventory_item_id), quantity: String(service.quantity) }))
      : [{ inventoryItemId: '', quantity: '1' }]);
    setAppointmentDate(next ? inputDate(next.scheduled_start) : selectedDate);
    setStartTime(next ? inputTime(next.scheduled_start) : '09:00');
    setEndTime(next ? inputTime(next.scheduled_end) : '10:00');
    setNotes(next?.notes || '');
  }, [selectedDate]);

  const openNewAppointment = () => {
    resetForm(null);
    setDialogOpen(true);
  };

  const openEditAppointment = (appointment: Appointment) => {
    resetForm(appointment);
    setDialogOpen(true);
  };

  const updateServiceRow = (index: number, patch: Partial<ServiceRow>) => {
    setServiceRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };

  const submitAppointment = async () => {
    const validServices = serviceRows.filter((row) => row.inventoryItemId && numberValue(row.quantity) > 0);
    if (!customerId) {
      toast({ variant: 'destructive', title: 'Choose a customer before saving.' });
      return;
    }
    if (!validServices.length) {
      toast({ variant: 'destructive', title: 'Add at least one salon service.' });
      return;
    }
    const scheduledStart = createLocalDateTime(appointmentDate, startTime);
    const scheduledEnd = createLocalDateTime(appointmentDate, endTime);
    if (Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) {
      toast({ variant: 'destructive', title: 'The end time must be after the start time.' });
      return;
    }
    if (!business?.id || !activeBranchId) {
      toast({ variant: 'destructive', title: 'Choose a branch before saving an appointment.' });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        business_id: business.id,
        branch: toBackendBranchId(activeBranchId),
        customer: customerId,
        scheduled_start: scheduledStart,
        scheduled_end: scheduledEnd,
        services: validServices.map((row) => ({ inventory_item_id: row.inventoryItemId, quantity: row.quantity })),
        notes,
      };
      const url = editingAppointment
        ? `/appointments/appointments/${editingAppointment.id}/`
        : '/appointments/appointments/';
      await authFetch.fetch(url, {
        method: editingAppointment ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
        queueOnFailure: false,
      });
      toast({ title: editingAppointment ? 'Appointment updated' : 'Appointment booked' });
      setDialogOpen(false);
      await Promise.all([loadSchedule(), loadSummary()]);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not save appointment',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const checkInAppointment = async (appointment: Appointment) => {
    setCheckingInId(appointment.id);
    try {
      const updated = await authFetch.fetch<Appointment>(
        `/appointments/appointments/${appointment.id}/check-in/`,
        { method: 'POST', queueOnFailure: false },
      );
      toast({
        title: 'Sent to Service Queue',
        description: updated.take_order_number ? `Order ${updated.take_order_number} is ready for its service docket.` : undefined,
      });
      await Promise.all([loadSchedule(), loadSummary()]);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not check in appointment',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setCheckingInId(null);
    }
  };

  const openDeposit = (appointment: Appointment) => {
    setDepositAppointment(appointment);
    setDepositAmount('');
    setDepositMethod('Cash');
    setDepositReference('');
    setDepositNotes('');
  };

  const recordDeposit = async () => {
    if (!depositAppointment || numberValue(depositAmount) <= 0) {
      toast({ variant: 'destructive', title: 'Enter a deposit amount greater than zero.' });
      return;
    }
    const remaining = numberValue(depositAppointment.balance_due ?? depositAppointment.total);
    if (numberValue(depositAmount) > remaining) {
      toast({ variant: 'destructive', title: `The remaining appointment balance is ${formatCurrency(remaining)}.` });
      return;
    }
    setIsRecordingDeposit(true);
    try {
      await authFetch.fetch<Appointment>(
        `/appointments/appointments/${depositAppointment.id}/record-deposit/`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: depositAmount,
            payment_method: depositMethod,
            reference: depositReference,
            notes: depositNotes,
          }),
          queueOnFailure: false,
        },
      );
      toast({ title: 'Deposit recorded', description: 'The payment is now in the customer account and this active session.' });
      setDepositAppointment(null);
      await Promise.all([loadSchedule(), loadSummary()]);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not record deposit',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsRecordingDeposit(false);
    }
  };

  const openOutcome = (appointment: Appointment, type: 'cancel' | 'no_show') => {
    setOutcomeAppointment(appointment);
    setOutcomeType(type);
    setOutcomeReason('');
  };

  const recordOutcome = async () => {
    if (!outcomeAppointment || !outcomeReason.trim()) {
      toast({ variant: 'destructive', title: 'Add a reason before continuing.' });
      return;
    }
    setIsRecordingOutcome(true);
    try {
      await authFetch.fetch<Appointment>(
        `/appointments/appointments/${outcomeAppointment.id}/${outcomeType === 'cancel' ? 'cancel' : 'mark-no-show'}/`,
        { method: 'POST', body: JSON.stringify({ reason: outcomeReason.trim() }), queueOnFailure: false },
      );
      toast({ title: outcomeType === 'cancel' ? 'Appointment cancelled' : 'Client marked as no show' });
      setOutcomeAppointment(null);
      await Promise.all([loadSchedule(), loadSummary()]);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not update appointment',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsRecordingOutcome(false);
    }
  };

  const canManageOutcomes = user?.role === 'Admin';

  if (!isSalonServiceBusinessType(business?.type)) {
    return (
      <Card className="mx-auto mt-8 max-w-xl">
        <CardHeader>
          <CardTitle>Appointments are for salons and spas</CardTitle>
          <CardDescription>This workspace becomes available when the business category is Beauty Salon and Spa.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
            <Scissors className="size-4" />
            Service planning
          </div>
          <h1 className="text-2xl font-semibold">Appointments</h1>
          <p className="mt-1 text-sm text-muted-foreground">Book services, check clients in, and keep every sale in the normal service queue.</p>
        </div>
        <Button onClick={openNewAppointment} disabled={!activeBranchId} className="shrink-0">
          <Plus />
          Book appointment
        </Button>
      </div>

      {summary && activeBranchId && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-medium uppercase text-muted-foreground">This week</p>
              <p className="mt-1 text-2xl font-semibold">{summary.totals.appointments}</p>
              <p className="mt-1 text-sm text-muted-foreground">{summary.totals.completed} completed · {summary.totals.no_show} no show</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-medium uppercase text-muted-foreground">Service value</p>
              <p className="mt-1 text-lg font-semibold">{formatCurrency(numberValue(summary.totals.scheduled_value))}</p>
              <p className="mt-1 text-sm text-muted-foreground">{formatCurrency(numberValue(summary.totals.completed_service_value))} completed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-medium uppercase text-muted-foreground">Deposits received</p>
              <p className="mt-1 text-lg font-semibold">{formatCurrency(numberValue(summary.totals.deposits_received))}</p>
              <p className="mt-1 text-sm text-muted-foreground">{formatCurrency(numberValue(summary.totals.outstanding_scheduled_value))} open balance</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="gap-4 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">Schedule</CardTitle>
            <CardDescription className="mt-1">Choose a day to see its client bookings.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" onClick={() => setSelectedDate(formatDate(addDays(new Date(`${selectedDate}T12:00:00`), -7), 'yyyy-MM-dd'))} aria-label="Previous week">
              <ChevronLeft />
            </Button>
            <Input className="h-10 w-[9.5rem]" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            <Button size="icon" variant="outline" onClick={() => setSelectedDate(formatDate(addDays(new Date(`${selectedDate}T12:00:00`), 7), 'yyyy-MM-dd'))} aria-label="Next week">
              <ChevronRight />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-7 border-b">
            {scheduleDays.map((day) => {
              const value = formatDate(day, 'yyyy-MM-dd');
              const active = value === selectedDate;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSelectedDate(value)}
                  className={`min-w-0 border-r px-1 py-3 text-center last:border-r-0 sm:px-2 ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/70'}`}
                >
                  <span className="block text-[0.68rem] font-medium uppercase sm:text-xs">{formatDate(day, 'EEE')}</span>
                  <span className="mt-1 block text-base font-semibold sm:text-lg">{formatDate(day, 'd')}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays className="size-4 text-muted-foreground" />
              {formatDate(new Date(`${selectedDate}T12:00:00`), 'EEEE, d MMMM')}
            </div>
            {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      </Card>

      {!activeBranchId ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">Choose a branch to manage its appointments.</CardContent>
        </Card>
      ) : appointments.length === 0 && !isLoading ? (
        <Card>
          <CardContent className="flex flex-col items-center py-14 text-center">
            <CalendarDays className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">No appointments on this day</p>
            <p className="mt-1 text-sm text-muted-foreground">Book a service to begin the day’s schedule.</p>
            <Button className="mt-4" variant="outline" onClick={openNewAppointment}><Plus />Book appointment</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {appointments.map((appointment) => {
            const meta = statusMeta[appointment.status] || statusMeta.booked;
            return (
              <article key={appointment.id} className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Clock3 className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="font-semibold">{formatDate(parseISO(appointment.scheduled_start), 'HH:mm')} - {formatDate(parseISO(appointment.scheduled_end), 'HH:mm')}</p>
                      <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                      <UserRound className="size-3.5 shrink-0" />
                      <span className="truncate">{appointment.customer_name}</span>
                      {appointment.customer_phone && <span className="hidden sm:inline">{appointment.customer_phone}</span>}
                    </div>
                    <p className="mt-2 text-sm">
                      {appointment.services.map((service) => `${service.name} x${service.quantity}`).join(' · ')}
                    </p>
                    {appointment.notes && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{appointment.notes}</p>}
                    {appointment.status === 'cancelled' && appointment.cancellation_reason && (
                      <p className="mt-1 text-xs text-rose-700">Cancelled: {appointment.cancellation_reason}</p>
                    )}
                    {appointment.status === 'no_show' && appointment.no_show_reason && (
                      <p className="mt-1 text-xs text-rose-700">No show: {appointment.no_show_reason}</p>
                    )}
                    {appointment.status !== 'cancelled' && appointment.status !== 'no_show' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Deposits {formatCurrency(numberValue(appointment.deposit_total))} · Balance {formatCurrency(numberValue(appointment.balance_due ?? appointment.total))}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <span className="mr-auto text-sm font-semibold sm:mr-2">{formatCurrency(numberValue(appointment.total))}</span>
                  {appointment.status === 'booked' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => openEditAppointment(appointment)}>Edit</Button>
                      {numberValue(appointment.balance_due ?? appointment.total) > 0 && (
                        <Button size="sm" variant="outline" onClick={() => openDeposit(appointment)}><CircleDollarSign />Deposit</Button>
                      )}
                      <Button size="sm" onClick={() => void checkInAppointment(appointment)} disabled={checkingInId === appointment.id}>
                        {checkingInId === appointment.id ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                        Check in
                      </Button>
                      {canManageOutcomes && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => openOutcome(appointment, 'no_show')}>No show</Button>
                          <Button size="sm" variant="destructive" onClick={() => openOutcome(appointment, 'cancel')}>Cancel</Button>
                        </>
                      )}
                    </>
                  )}
                  {appointment.status !== 'booked' && appointment.status !== 'cancelled' && appointment.status !== 'no_show' && numberValue(appointment.balance_due ?? appointment.total) > 0 && (
                    <Button size="sm" variant="outline" onClick={() => openDeposit(appointment)}><CircleDollarSign />Deposit</Button>
                  )}
                  {appointment.take_order_id && appointment.status !== 'completed' && (
                    <Button asChild size="sm" variant="outline"><Link href="/dashboard/kitchen">Service queue</Link></Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) setEditingAppointment(null);
      }}>
        <DialogContent className="flex max-h-[min(94dvh,48rem)] max-w-2xl flex-col overflow-hidden p-0 sm:rounded-lg">
          <DialogHeader className="border-b px-5 py-4 sm:px-6">
            <DialogTitle>{editingAppointment ? 'Edit appointment' : 'Book appointment'}</DialogTitle>
            <DialogDescription>Services and current prices are saved with this booking. Check-in sends them to the Service Queue.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="appointment-customer">Customer</Label>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger id="appointment-customer"><SelectValue placeholder="Select an existing customer" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((customer) => <SelectItem key={customer.id} value={String(customer.id)}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
                {!customers.length && <p className="text-xs text-muted-foreground">Create the client in Customers first, then return here to book their service.</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="appointment-date">Date</Label>
                <Input id="appointment-date" type="date" value={appointmentDate} onChange={(event) => setAppointmentDate(event.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label htmlFor="appointment-start">Start</Label><Input id="appointment-start" type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></div>
                <div className="space-y-2"><Label htmlFor="appointment-end">End</Label><Input id="appointment-end" type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></div>
              </div>
            </div>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div><Label>Services</Label><p className="mt-1 text-xs text-muted-foreground">Only services configured in Products & Stock are available here.</p></div>
                <Button type="button" size="sm" variant="outline" onClick={() => setServiceRows((current) => [...current, { inventoryItemId: '', quantity: '1' }])}><Plus />Add service</Button>
              </div>
              <div className="space-y-2">
                {serviceRows.map((row, index) => {
                  const selected = services.find((service) => String(service.id) === row.inventoryItemId);
                  return (
                    <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_2.25rem] items-center gap-2" key={`${row.inventoryItemId}-${index}`}>
                      <Select value={row.inventoryItemId} onValueChange={(value) => updateServiceRow(index, { inventoryItemId: value })}>
                        <SelectTrigger><SelectValue placeholder="Select service" /></SelectTrigger>
                        <SelectContent>{services.map((service) => <SelectItem key={service.id} value={String(service.id)}>{service.name} · {formatCurrency(numberValue(service.price))}</SelectItem>)}</SelectContent>
                      </Select>
                      <Input aria-label="Service quantity" type="number" min="0.001" step="0.001" value={row.quantity} onChange={(event) => updateServiceRow(index, { quantity: event.target.value })} />
                      <Button type="button" size="icon" variant="ghost" aria-label="Remove service" disabled={serviceRows.length === 1} onClick={() => setServiceRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><X /></Button>
                      {selected && <p className="col-span-3 -mt-1 text-right text-xs text-muted-foreground">{formatCurrency(numberValue(selected.price) * Math.max(numberValue(row.quantity), 0))}</p>}
                    </div>
                  );
                })}
              </div>
              {!services.length && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No salon services are available in this branch. Create a sellable product and mark it as a service in Products & Stock.</p>}
              <div className="flex justify-end border-t pt-3 text-sm font-semibold">Appointment total: {formatCurrency(selectedServicesTotal)}</div>
            </section>

            <div className="space-y-2"><Label htmlFor="appointment-notes">Notes</Label><Textarea id="appointment-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional client or service notes" /></div>
          </div>
          <DialogFooter className="border-t px-5 py-4 sm:px-6">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => void submitAppointment()} disabled={isSaving || !services.length}>
              {isSaving && <Loader2 className="animate-spin" />}
              {editingAppointment ? 'Save changes' : 'Book appointment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(depositAppointment)} onOpenChange={(open) => {
        if (!open && !isRecordingDeposit) setDepositAppointment(null);
      }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record deposit</DialogTitle>
            <DialogDescription>
              {depositAppointment?.customer_name} has {formatCurrency(numberValue(depositAppointment?.balance_due ?? depositAppointment?.total))} remaining on this appointment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="appointment-deposit-amount">Amount</Label>
              <Input id="appointment-deposit-amount" type="number" min="0.01" step="0.01" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} autoFocus />
            </div>
            <div className="space-y-2">
              <Label>Payment method</Label>
              <Select value={depositMethod} onValueChange={setDepositMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Card">Card</SelectItem>
                  <SelectItem value="Mobile Money">Mobile Money</SelectItem>
                  <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="appointment-deposit-reference">Reference</Label>
              <Input id="appointment-deposit-reference" value={depositReference} onChange={(event) => setDepositReference(event.target.value)} placeholder="Optional payment reference" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="appointment-deposit-notes">Notes</Label>
              <Textarea id="appointment-deposit-notes" value={depositNotes} onChange={(event) => setDepositNotes(event.target.value)} placeholder="Optional deposit note" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositAppointment(null)} disabled={isRecordingDeposit}>Cancel</Button>
            <Button onClick={() => void recordDeposit()} disabled={isRecordingDeposit}>
              {isRecordingDeposit && <Loader2 className="animate-spin" />}
              Record deposit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(outcomeAppointment)} onOpenChange={(open) => {
        if (!open && !isRecordingOutcome) setOutcomeAppointment(null);
      }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{outcomeType === 'cancel' ? 'Cancel appointment' : 'Mark client as no show'}</DialogTitle>
            <DialogDescription>
              This is an audited admin action. The appointment remains in the client history with the reason below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="appointment-outcome-reason">Reason</Label>
            <Textarea
              id="appointment-outcome-reason"
              value={outcomeReason}
              onChange={(event) => setOutcomeReason(event.target.value)}
              placeholder={outcomeType === 'cancel' ? 'Why is this appointment being cancelled?' : 'Why did the client not attend?'}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOutcomeAppointment(null)} disabled={isRecordingOutcome}>Back</Button>
            <Button variant={outcomeType === 'cancel' ? 'destructive' : 'default'} onClick={() => void recordOutcome()} disabled={isRecordingOutcome}>
              {isRecordingOutcome && <Loader2 className="animate-spin" />}
              {outcomeType === 'cancel' ? 'Cancel appointment' : 'Mark no show'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
