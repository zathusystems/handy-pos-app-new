'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { format } from 'date-fns';

import { authFetch } from '@/lib/auth-fetch';
import { useActiveBranch } from '@/hooks/use-active-branch';

export type SalonServiceReportRow = {
  name: string;
  appointments: number;
  quantity: string | number;
  scheduled_value: string | number;
  completed_value: string | number;
};

export type SalonAppointmentReport = {
  range: {
    from_date: string;
    to_date: string;
  };
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
  services: SalonServiceReportRow[];
};

const EMPTY_REPORT: SalonAppointmentReport = {
  range: { from_date: '', to_date: '' },
  totals: {
    appointments: 0,
    booked: 0,
    checked_in: 0,
    in_service: 0,
    ready_for_payment: 0,
    completed: 0,
    cancelled: 0,
    no_show: 0,
    scheduled_value: 0,
    completed_service_value: 0,
    deposits_received: 0,
    outstanding_scheduled_value: 0,
  },
  services: [],
};

const toBackendBranchId = (value: string): string => {
  const normalized = String(value || '').trim();
  const match = /^BRN-(\d+)$/i.exec(normalized) || /^branch-(\d+)$/i.exec(normalized);
  return match ? match[1] : normalized;
};

export function useSalonAppointmentReport(dateRange?: DateRange, enabled = false) {
  const activeBranchId = useActiveBranch();
  const fromDate = useMemo(
    () => (dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : ''),
    [dateRange?.from],
  );
  const toDate = useMemo(
    () => (dateRange?.to || dateRange?.from ? format(dateRange.to || dateRange.from!, 'yyyy-MM-dd') : ''),
    [dateRange?.from, dateRange?.to],
  );
  const [data, setData] = useState<SalonAppointmentReport>(EMPTY_REPORT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled || !activeBranchId || !fromDate || !toDate) {
      setData(EMPTY_REPORT);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    authFetch
      .fetch<SalonAppointmentReport>(
        `/appointments/appointments/summary/?branch=${encodeURIComponent(toBackendBranchId(activeBranchId))}&from_date=${fromDate}&to_date=${toDate}`,
        { queueOnFailure: false },
      )
      .then((response) => {
        if (!cancelled) {
          setData(response);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setData(EMPTY_REPORT);
          setError(requestError instanceof Error ? requestError : new Error('Could not load appointment reports.'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeBranchId, enabled, fromDate, toDate]);

  return { data, loading, error };
}
