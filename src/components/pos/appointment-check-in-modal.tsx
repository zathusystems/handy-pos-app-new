'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { CalendarDays, CheckCircle2, Clock3, Loader2, Phone, RefreshCw, Scissors } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { useCurrency } from '@/hooks/use-currency';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type AppointmentOption = {
  name?: string;
};

type AppointmentService = {
  name?: string;
  quantity?: string | number;
  selected_options?: AppointmentOption[];
  selectedOptions?: AppointmentOption[];
};

type Appointment = {
  id: string;
  customer_name: string;
  customer_phone?: string;
  scheduled_start: string;
  scheduled_end: string;
  services: AppointmentService[];
  total: string | number;
  deposit_total?: string | number;
  balance_due?: string | number;
};

type AppointmentCheckInModalProps = {
  branchId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckedIn?: () => void | Promise<void>;
};

const toBackendBranchId = (value: string): string => {
  const normalized = String(value || '').trim();
  const match = /^BRN-(\d+)$/i.exec(normalized) || /^branch-(\d+)$/i.exec(normalized);
  return match ? match[1] : normalized;
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

const selectedOptionNames = (service: AppointmentService): string[] => {
  const selected = service.selected_options || service.selectedOptions || [];
  return selected
    .map((option) => String(option?.name || '').trim())
    .filter(Boolean);
};

const appointmentTime = (value: string): string => {
  try {
    return format(parseISO(value), 'h:mm a');
  } catch {
    return '';
  }
};

export function AppointmentCheckInModal({
  branchId,
  isOpen,
  onOpenChange,
  onCheckedIn,
}: AppointmentCheckInModalProps) {
  const { format: formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [checkingInId, setCheckingInId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadAppointments = useCallback(async () => {
    if (!branchId) {
      setAppointments([]);
      return;
    }

    setIsLoading(true);
    try {
      const backendBranchId = encodeURIComponent(toBackendBranchId(branchId));
      const payload = await authFetch.fetch<unknown>(
        `/appointments/appointments/?branch=${backendBranchId}&date=${selectedDate}&status=booked`,
        { queueOnFailure: false },
      );
      setAppointments(asCollection<Appointment>(payload));
    } catch (error) {
      console.error('[AppointmentCheckInModal] Failed to load appointments:', error);
      toast({
        variant: 'destructive',
        title: 'Could not load appointments',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  }, [branchId, selectedDate, toast]);

  useEffect(() => {
    if (!isOpen) return;
    void loadAppointments();
  }, [isOpen, loadAppointments]);

  const filteredAppointments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return appointments;
    return appointments.filter((appointment) => (
      [appointment.customer_name, appointment.customer_phone]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query))
    ));
  }, [appointments, search]);

  const checkInAppointment = async (appointment: Appointment) => {
    setCheckingInId(appointment.id);
    try {
      const updated = await authFetch.fetch<{ take_order_number?: number | null }>(
        `/appointments/appointments/${appointment.id}/check-in/`,
        { method: 'POST', queueOnFailure: false },
      );
      toast({
        title: 'Appointment checked in',
        description: updated.take_order_number
          ? `Order ${updated.take_order_number} is now in Orders.`
          : 'The appointment is now in Orders.',
      });
      await Promise.all([loadAppointments(), Promise.resolve(onCheckedIn?.())]);
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

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="tauri-android-sidebar-safe-top left-0 top-0 m-0 flex h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[88vh] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border">
        <DialogHeader className="shrink-0 border-b bg-muted/30 px-4 pb-3 pt-5 text-left sm:px-6 sm:pt-6">
          <DialogTitle className="flex items-center gap-2 text-xl sm:text-2xl">
            <CalendarDays className="h-5 w-5 text-primary" />
            Appointments
          </DialogTitle>
          <DialogDescription className="mt-1">
            Check in a booked client to create their service order.
          </DialogDescription>
          <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-2 pt-3 sm:flex">
            <Input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              aria-label="Appointment date"
              className="min-w-0 sm:w-44"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void loadAppointments()}
              disabled={isLoading}
              aria-label="Refresh appointments"
              title="Refresh appointments"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search client name or phone"
            className="mt-2"
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {isLoading && appointments.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading appointments
            </div>
          ) : filteredAppointments.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-center text-muted-foreground">
              <CalendarDays className="mb-3 h-12 w-12 opacity-30" />
              <p className="font-semibold text-foreground">No booked appointments</p>
              <p className="mt-1 text-sm">There are no clients waiting to be checked in for this date.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAppointments.map((appointment) => {
                const depositTotal = numberValue(appointment.deposit_total);
                const balanceDue = numberValue(appointment.balance_due);
                return (
                  <article key={appointment.id} className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="break-words font-semibold text-foreground">{appointment.customer_name}</p>
                          <Badge variant="outline" className="gap-1 border-blue-200 bg-blue-50 text-blue-700">
                            <Clock3 className="h-3 w-3" />
                            {appointmentTime(appointment.scheduled_start)} - {appointmentTime(appointment.scheduled_end)}
                          </Badge>
                        </div>
                        {appointment.customer_phone && (
                          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Phone className="h-3.5 w-3.5" />
                            {appointment.customer_phone}
                          </p>
                        )}
                        <div className="space-y-1.5 text-sm">
                          {appointment.services.map((service, index) => {
                            const options = selectedOptionNames(service);
                            return (
                              <div key={`${appointment.id}-${index}`} className="flex gap-2 text-muted-foreground">
                                <Scissors className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span className="min-w-0 break-words">
                                  {service.name || 'Service'} x{numberValue(service.quantity) || 1}
                                  {options.length > 0 && ` (${options.join(' · ')})`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                        <div className="text-left sm:text-right">
                          <p className="font-semibold">{formatCurrency(numberValue(appointment.total))}</p>
                          {depositTotal > 0 && (
                            <p className="text-xs text-muted-foreground">
                              Deposit {formatCurrency(depositTotal)} · Balance {formatCurrency(balanceDue)}
                            </p>
                          )}
                        </div>
                        <Button
                          onClick={() => void checkInAppointment(appointment)}
                          disabled={checkingInId === appointment.id}
                          className="gap-2"
                        >
                          {checkingInId === appointment.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <CheckCircle2 className="h-4 w-4" />}
                          Check In
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
