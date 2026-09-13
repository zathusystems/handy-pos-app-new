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
import { db, type Customer } from '@/lib/db';
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
  menu_item_id?: string;
  name: string;
  category?: string;
  quantity: string | number;
  price: string | number;
  total?: string | number;
  recipe?: unknown[];
  selected_options?: MenuOptionSnapshot[];
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
  menuItemId: string;
  quantity: string;
  selectedOptionIds: Record<string, string[]>;
};

type MenuOptionSnapshot = {
  id: string;
  group_id?: string;
  group_name?: string;
  name: string;
  price_mode?: 'delta' | 'override' | string;
  price_delta?: string | number;
  price_override?: string | number | null;
  is_visible?: boolean;
  is_default?: boolean;
  description?: string;
};

type MenuOptionGroup = {
  id: string;
  name: string;
  is_required?: boolean;
  min_select?: number | string;
  max_select?: number | string;
  options: MenuOptionSnapshot[];
};

type AppointmentMenuService = {
  id: string;
  inventory_item?: string;
  item_name?: string;
  name?: string;
  category?: string;
  price?: string | number;
  is_visible?: boolean;
  item_details?: {
    id?: string;
    name?: string;
    category?: string;
    price?: string | number;
  };
  option_groups?: MenuOptionGroup[];
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

const menuServiceName = (service: AppointmentMenuService): string => (
  String(service.item_name || service.item_details?.name || service.name || 'Unnamed service')
);

const menuServiceCategory = (service: AppointmentMenuService): string => (
  String(service.item_details?.category || service.category || '')
);

const menuServicePrice = (service: AppointmentMenuService): number => (
  numberValue(service.item_details?.price ?? service.price)
);

const menuOptionGroups = (service: AppointmentMenuService | null | undefined): MenuOptionGroup[] => (
  Array.isArray(service?.option_groups)
    ? service.option_groups.filter((group) => Array.isArray(group.options) && group.options.some((option) => option.is_visible !== false))
    : []
);

const defaultOptionIds = (service: AppointmentMenuService): Record<string, string[]> => Object.fromEntries(
  menuOptionGroups(service).map((group) => {
    const maxSelect = Math.max(1, numberValue(group.max_select) || 1);
    return [
      String(group.id),
      group.options
        .filter((option) => option.is_visible !== false && option.is_default)
        .slice(0, maxSelect)
        .map((option) => String(option.id)),
    ];
  }),
);

const optionIdsFromSnapshot = (options: MenuOptionSnapshot[] | undefined): Record<string, string[]> => {
  const selected: Record<string, string[]> = {};
  for (const option of options || []) {
    const groupId = String(option.group_id || '').trim();
    const optionId = String(option.id || '').trim();
    if (!groupId || !optionId) continue;
    selected[groupId] = [...(selected[groupId] || []), optionId];
  }
  return selected;
};

const selectedMenuOptions = (
  service: AppointmentMenuService | null | undefined,
  selectedOptionIds: Record<string, string[]>,
): MenuOptionSnapshot[] => menuOptionGroups(service).flatMap((group) => {
  const selectedIds = new Set(selectedOptionIds[String(group.id)] || []);
  return group.options.filter((option) => selectedIds.has(String(option.id)) && option.is_visible !== false);
});

const menuServicePriceWithOptions = (
  service: AppointmentMenuService | null | undefined,
  selectedOptionIds: Record<string, string[]>,
): number => {
  if (!service) return 0;
  let price = menuServicePrice(service);
  for (const option of selectedMenuOptions(service, selectedOptionIds)) {
    if (String(option.price_mode || '').toLowerCase() === 'override' && option.price_override !== null && option.price_override !== undefined) {
      price = numberValue(option.price_override);
    } else {
      price += numberValue(option.price_delta);
    }
  }
  return Math.max(0, price);
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
  const [menuServices, setMenuServices] = useState<AppointmentMenuService[]>([]);
  const [isLoadingMenuServices, setIsLoadingMenuServices] = useState(false);
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([{ menuItemId: '', quantity: '1', selectedOptionIds: {} }]);
  const [optionDialogRow, setOptionDialogRow] = useState<number | null>(null);
  const [draftOptionIds, setDraftOptionIds] = useState<Record<string, string[]>>({});
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

  const services = useMemo(
    () => menuServices
      .filter((item) => item.is_visible !== false)
      .sort((left, right) => menuServiceName(left).localeCompare(menuServiceName(right))),
    [menuServices],
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
      setIsLoadingMenuServices(true);
      try {
        const payload = await authFetch.fetch<unknown>(
          `/digital-menu/menu/by_branch/?branch_id=${branchId}`,
          { queueOnFailure: false },
        );
        if (!cancelled) {
          setMenuServices(asCollection<AppointmentMenuService>(payload));
        }
      } catch (error) {
        console.warn('[Appointments] Failed to refresh menu services:', error);
        if (!cancelled) setMenuServices([]);
      } finally {
        if (!cancelled) setIsLoadingMenuServices(false);
      }
    };
    void loadSupportingData();
    return () => {
      cancelled = true;
    };
  }, [activeBranchId]);

  const selectedServicesTotal = useMemo(() => serviceRows.reduce((total, row) => {
    const service = services.find((item) => String(item.id) === row.menuItemId);
    return total + menuServicePriceWithOptions(service, row.selectedOptionIds) * Math.max(numberValue(row.quantity), 0);
  }, 0), [serviceRows, services]);

  const scheduleStart = useMemo(() => startOfWeek(new Date(`${selectedDate}T12:00:00`), { weekStartsOn: 1 }), [selectedDate]);
  const scheduleDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(scheduleStart, index)), [scheduleStart]);

  const resetForm = useCallback((appointment?: Appointment | null) => {
    const next = appointment || null;
    setEditingAppointment(next);
    setCustomerId(next ? String(next.customer) : '');
    setServiceRows(next?.services?.length
      ? next.services.map((service) => ({
        menuItemId: String(
          service.menu_item_id
          || services.find((menu) => String(menu.inventory_item || menu.item_details?.id || '') === String(service.inventory_item_id))?.id
          || '',
        ),
        quantity: String(service.quantity),
        selectedOptionIds: optionIdsFromSnapshot(service.selected_options),
      }))
      : [{ menuItemId: '', quantity: '1', selectedOptionIds: {} }]);
    setAppointmentDate(next ? inputDate(next.scheduled_start) : selectedDate);
    setStartTime(next ? inputTime(next.scheduled_start) : '09:00');
    setEndTime(next ? inputTime(next.scheduled_end) : '10:00');
    setNotes(next?.notes || '');
  }, [selectedDate, services]);

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

  const selectedOptionService = optionDialogRow === null
    ? null
    : services.find((service) => String(service.id) === serviceRows[optionDialogRow]?.menuItemId) || null;

  const openServiceOptions = (rowIndex: number) => {
    const row = serviceRows[rowIndex];
    if (!row) return;
    setDraftOptionIds(row.selectedOptionIds);
    setOptionDialogRow(rowIndex);
  };

  const toggleDraftOption = (group: MenuOptionGroup, optionId: string, checked: boolean) => {
    const groupId = String(group.id);
    const maxSelect = Math.max(1, numberValue(group.max_select) || 1);
    setDraftOptionIds((current) => {
      const selected = current[groupId] || [];
      if (maxSelect === 1) {
        return { ...current, [groupId]: checked ? [optionId] : [] };
      }
      if (!checked) return { ...current, [groupId]: selected.filter((id) => id !== optionId) };
      if (selected.includes(optionId) || selected.length >= maxSelect) return current;
      return { ...current, [groupId]: [...selected, optionId] };
    });
  };

  const saveServiceOptions = () => {
    if (optionDialogRow === null || !selectedOptionService) return;
    const invalidGroup = menuOptionGroups(selectedOptionService).find((group) => {
      const selected = draftOptionIds[String(group.id)] || [];
      const minimum = group.is_required ? Math.max(1, numberValue(group.min_select) || 1) : numberValue(group.min_select);
      const maximum = Math.max(1, numberValue(group.max_select) || 1);
      return selected.length < minimum || selected.length > maximum;
    });
    if (invalidGroup) {
      const minimum = invalidGroup.is_required ? Math.max(1, numberValue(invalidGroup.min_select) || 1) : numberValue(invalidGroup.min_select);
      toast({
        variant: 'destructive',
        title: `Choose ${invalidGroup.name}`,
        description: minimum > 0 ? `Select at least ${minimum} choice${minimum === 1 ? '' : 's'}.` : `Choose up to ${invalidGroup.max_select || 1} choices.`,
      });
      return;
    }
    updateServiceRow(optionDialogRow, { selectedOptionIds: draftOptionIds });
    setOptionDialogRow(null);
    setDraftOptionIds({});
  };

  const submitAppointment = async () => {
    const validServices = serviceRows.filter((row) => row.menuItemId && numberValue(row.quantity) > 0);
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
        services: validServices.map((row) => ({
          menu_item_id: row.menuItemId,
          quantity: row.quantity,
          selected_option_ids: row.selectedOptionIds,
        })),
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
                <div><Label>Services</Label><p className="mt-1 text-xs text-muted-foreground">Choose from Menu Management so each service keeps its configured choices and price.</p></div>
                <Button type="button" size="sm" variant="outline" onClick={() => setServiceRows((current) => [...current, { menuItemId: '', quantity: '1', selectedOptionIds: {} }])}><Plus />Add service</Button>
              </div>
              <div className="space-y-2">
                {serviceRows.map((row, index) => {
                  const selected = services.find((service) => String(service.id) === row.menuItemId);
                  const optionGroups = menuOptionGroups(selected);
                  const selectedOptions = selectedMenuOptions(selected, row.selectedOptionIds);
                  const unitPrice = menuServicePriceWithOptions(selected, row.selectedOptionIds);
                  return (
                    <div className="rounded-md border p-3" key={`${row.menuItemId}-${index}`}>
                      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_2.25rem] items-center gap-2">
                        <Select value={row.menuItemId} onValueChange={(value) => updateServiceRow(index, {
                          menuItemId: value,
                          selectedOptionIds: defaultOptionIds(services.find((service) => String(service.id) === value) || {} as AppointmentMenuService),
                        })}>
                          <SelectTrigger><SelectValue placeholder="Select a menu service" /></SelectTrigger>
                          <SelectContent>{services.map((service) => <SelectItem key={service.id} value={String(service.id)}>{menuServiceName(service)}{menuServiceCategory(service) ? ` · ${menuServiceCategory(service)}` : ''} · {formatCurrency(menuServicePrice(service))}</SelectItem>)}</SelectContent>
                        </Select>
                        <Input aria-label="Service quantity" type="number" min="0.001" step="0.001" value={row.quantity} onChange={(event) => updateServiceRow(index, { quantity: event.target.value })} />
                        <Button type="button" size="icon" variant="ghost" aria-label="Remove service" disabled={serviceRows.length === 1} onClick={() => setServiceRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><X /></Button>
                      </div>
                      {selected && (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                          <div className="min-w-0">
                            {optionGroups.length > 0 ? (
                              <p className="text-xs text-muted-foreground">
                                {selectedOptions.length
                                  ? selectedOptions.map((option) => option.name).join(' · ')
                                  : 'No choices selected'}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">No service choices configured.</p>
                            )}
                            <p className="mt-1 text-xs font-medium">{formatCurrency(unitPrice * Math.max(numberValue(row.quantity), 0))}</p>
                          </div>
                          {optionGroups.length > 0 && (
                            <Button type="button" size="sm" variant="outline" onClick={() => openServiceOptions(index)}>Choose options</Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!isLoadingMenuServices && !services.length && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No menu items are available in this branch. Add the salon service in Menu Management, then configure its choices there.</p>}
              <div className="flex justify-end border-t pt-3 text-sm font-semibold">Appointment total: {formatCurrency(selectedServicesTotal)}</div>
            </section>

            <div className="space-y-2"><Label htmlFor="appointment-notes">Notes</Label><Textarea id="appointment-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional client or service notes" /></div>
          </div>
          <DialogFooter className="border-t px-5 py-4 sm:px-6">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => void submitAppointment()} disabled={isSaving || isLoadingMenuServices || !services.length}>
              {isSaving && <Loader2 className="animate-spin" />}
              {editingAppointment ? 'Save changes' : 'Book appointment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={optionDialogRow !== null} onOpenChange={(open) => {
        if (!open) {
          setOptionDialogRow(null);
          setDraftOptionIds({});
        }
      }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Choose options{selectedOptionService ? ` for ${menuServiceName(selectedOptionService)}` : ''}</DialogTitle>
            <DialogDescription>These choices and their prices are saved with this appointment and sent with the service docket.</DialogDescription>
          </DialogHeader>
          {selectedOptionService && (
            <div className="space-y-4 py-2">
              {menuOptionGroups(selectedOptionService).map((group) => {
                const groupId = String(group.id);
                const selectedIds = draftOptionIds[groupId] || [];
                const maxSelect = Math.max(1, numberValue(group.max_select) || 1);
                const minimum = group.is_required ? Math.max(1, numberValue(group.min_select) || 1) : numberValue(group.min_select);
                return (
                  <section key={groupId} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">{group.name}</p>
                        <p className="text-xs text-muted-foreground">{minimum > 0 ? `Choose ${minimum}${minimum === maxSelect ? '' : `-${maxSelect}`}` : `Optional · choose up to ${maxSelect}`}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{selectedIds.length}/{maxSelect}</span>
                    </div>
                    <div className="space-y-2">
                      {group.options.filter((option) => option.is_visible !== false).map((option) => {
                        const optionId = String(option.id);
                        const checked = selectedIds.includes(optionId);
                        const optionPrice = String(option.price_mode || '').toLowerCase() === 'override' && option.price_override !== null && option.price_override !== undefined
                          ? `Set to ${formatCurrency(numberValue(option.price_override))}`
                          : numberValue(option.price_delta) === 0
                          ? 'Included'
                          : `${numberValue(option.price_delta) > 0 ? '+' : ''}${formatCurrency(numberValue(option.price_delta))}`;
                        return (
                          <label key={optionId} htmlFor={`appointment-option-${groupId}-${optionId}`} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                            <input
                              id={`appointment-option-${groupId}-${optionId}`}
                              type={maxSelect === 1 ? 'radio' : 'checkbox'}
                              name={`appointment-option-group-${groupId}`}
                              checked={checked}
                              onChange={(event) => toggleDraftOption(group, optionId, event.target.checked)}
                              className="mt-1 size-4 accent-primary"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start justify-between gap-3 text-sm font-medium"><span>{option.name}</span><span className="shrink-0 text-muted-foreground">{optionPrice}</span></span>
                              {option.description && <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3">
                <span className="text-sm text-muted-foreground">Price after choices</span>
                <span className="font-semibold">{formatCurrency(menuServicePriceWithOptions(selectedOptionService, draftOptionIds))}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOptionDialogRow(null)}>Cancel</Button>
            <Button type="button" onClick={saveServiceOptions}>Save choices</Button>
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
