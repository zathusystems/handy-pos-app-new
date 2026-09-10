'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, LogIn, LogOut, Plus } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/hooks/use-auth';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Attendance = { id: string; work_date: string; clock_in: string; clock_out?: string | null; worked_minutes?: number | null; status: string };
type Shift = { id: string; work_date: string; starts_at: string; ends_at: string; branch_name: string; status: string; scheduled_minutes: number };
type LeaveType = { id: string; name: string; paid: boolean; is_active: boolean };
type LeaveRequest = { id: string; leave_type_name: string; start_date: string; end_date: string; requested_days: string | number; status: string };
type OvertimeRequest = { id: string; work_date: string; requested_minutes: number; approved_minutes?: number | null; status: string };

const normalizeCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)) return (payload as { results: T[] }).results;
  return [];
};
const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
const today = () => new Date().toISOString().slice(0, 10);
const statusVariant = (status: string) => status === 'approved' ? 'default' as const : status === 'rejected' || status === 'cancelled' ? 'destructive' as const : 'secondary' as const;

export default function MyWorkPage() {
  const { user } = useAuth();
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeRequest[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'leave' | 'overtime' | null>(null);
  const [leaveForm, setLeaveForm] = useState({ leave_type: '', start_date: today(), end_date: today(), reason: '' });
  const [overtimeForm, setOvertimeForm] = useState({ branch: '', work_date: today(), requested_minutes: '60', reason: '' });
  const openAttendance = useMemo(() => attendance.find((record) => record.status === 'open' && !record.clock_out), [attendance]);
  const branchId = String(user?.branchId || branches[0]?.id || '');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const responses = await Promise.all([
        authFetch.fetch('/hr/attendance/'),
        authFetch.fetch('/hr/shifts/'),
        authFetch.fetch('/hr/leave-types/'),
        authFetch.fetch('/hr/leave-requests/'),
        authFetch.fetch('/hr/overtime-requests/'),
        authFetch.fetch('/business/branches/'),
      ]);
      setAttendance(normalizeCollection<Attendance>(responses[0]));
      setShifts(normalizeCollection<Shift>(responses[1]));
      setLeaveTypes(normalizeCollection<LeaveType>(responses[2]).filter((type) => type.is_active));
      setLeaveRequests(normalizeCollection<LeaveRequest>(responses[3]));
      setOvertime(normalizeCollection<OvertimeRequest>(responses[4]));
      setBranches(normalizeCollection<{ id: string; name: string }>(responses[5]).map((branch) => ({ id: String(branch.id), name: branch.name })));
    } catch (error) {
      toast({ title: 'Could not load your work details', description: error instanceof Error ? error.message : 'Ask an Administrator to link your employee profile.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const clock = async (action: 'clock-in' | 'clock-out') => {
    setSaving(true);
    try {
      await authFetch.fetch(`/hr/attendance/${action}/`, { method: 'POST', body: JSON.stringify(action === 'clock-in' ? { branch: branchId } : {}), queueOnFailure: false });
      await loadData();
      toast({ title: action === 'clock-in' ? 'Clocked in' : 'Clocked out', description: action === 'clock-in' ? 'Your work time has started.' : 'Your attendance is awaiting review.' });
    } catch (error) {
      toast({ title: 'Could not update attendance', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
    } finally { setSaving(false); }
  };
  const submitRequest = async (url: string, body: Record<string, unknown>) => {
    setSaving(true);
    try {
      await authFetch.fetch(url, { method: 'POST', body: JSON.stringify(body), queueOnFailure: false });
      setDialog(null);
      await loadData();
      toast({ title: 'Request submitted', description: 'Your manager can now review it.' });
    } catch (error) {
      toast({ title: 'Could not submit request', description: error instanceof Error ? error.message : 'Please check the fields and try again.', variant: 'destructive' });
    } finally { setSaving(false); }
  };
  const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T00:00:00`));
  const formatTime = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(value)) : 'Still open';

  return (
    <div className="flex flex-col gap-6 pb-6">
      <div><h1 className="text-2xl font-bold tracking-normal">My work</h1><p className="text-muted-foreground">Clock your hours and send leave or overtime requests from one place.</p></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Today</p><p className="mt-1 font-semibold">{openAttendance ? 'Clocked in' : 'Not clocked in'}</p></div><Clock3 className="h-6 w-6 text-primary" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Upcoming shifts</p><p className="mt-1 text-2xl font-semibold">{shifts.filter((shift) => shift.status === 'scheduled').length}</p></div><CheckCircle2 className="h-6 w-6 text-emerald-600" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Pending requests</p><p className="mt-1 text-2xl font-semibold">{leaveRequests.filter((request) => request.status === 'pending').length + overtime.filter((request) => request.status === 'pending').length}</p></div><Loader2 className={`h-6 w-6 text-amber-600 ${loading ? 'animate-spin' : ''}`} /></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Attendance</CardTitle><CardDescription>Clock in and out from the device assigned to you. Your manager approves completed records.</CardDescription></CardHeader><CardContent className="space-y-4"><Button disabled={saving || loading} onClick={() => void clock(openAttendance ? 'clock-out' : 'clock-in')}>{openAttendance ? <LogOut /> : <LogIn />}{openAttendance ? 'Clock out' : 'Clock in'}</Button><div className="divide-y rounded-md border">{attendance.slice(0, 7).map((record) => <div key={record.id} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{formatDate(record.work_date)}</p><p className="text-muted-foreground">{formatTime(record.clock_in)} to {formatTime(record.clock_out)}{record.worked_minutes != null ? ` · ${record.worked_minutes} minutes` : ''}</p></div><Badge variant={statusVariant(record.status)}>{record.status}</Badge></div>)}{!loading && attendance.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No attendance records yet.</p>}</div></CardContent></Card>
      <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader className="gap-2"><div className="flex items-center justify-between gap-3"><div><CardTitle>Shifts</CardTitle><CardDescription>Your upcoming scheduled hours.</CardDescription></div></div></CardHeader><CardContent className="divide-y rounded-md border p-0">{shifts.slice(0, 7).map((shift) => <div key={shift.id} className="p-3 text-sm"><div className="flex items-center justify-between gap-3"><span className="font-medium">{formatDate(shift.work_date)}</span><Badge variant={statusVariant(shift.status)}>{shift.status}</Badge></div><p className="mt-1 text-muted-foreground">{shift.starts_at.slice(0, 5)} to {shift.ends_at.slice(0, 5)} · {shift.branch_name}</p></div>)}{!loading && shifts.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No shifts scheduled.</p>}</CardContent></Card><Card><CardHeader><CardTitle>Requests</CardTitle><CardDescription>Ask for leave or record approved overtime.</CardDescription></CardHeader><CardContent className="flex flex-col gap-2 sm:flex-row"><Button onClick={() => { setLeaveForm((current) => ({ ...current, leave_type: leaveTypes[0]?.id || '' })); setDialog('leave'); }}><Plus /> Request leave</Button><Button variant="outline" onClick={() => { setOvertimeForm((current) => ({ ...current, branch: branchId })); setDialog('overtime'); }}>Request overtime</Button></CardContent></Card></div>
      <Card><CardHeader><CardTitle>Recent requests</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2"><div className="space-y-2">{leaveRequests.slice(0, 5).map((request) => <div key={request.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"><span>{request.leave_type_name} · {request.requested_days} days</span><Badge variant={statusVariant(request.status)}>{request.status}</Badge></div>)}{leaveRequests.length === 0 && <p className="text-sm text-muted-foreground">No leave requests.</p>}</div><div className="space-y-2">{overtime.slice(0, 5).map((request) => <div key={request.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"><span>{formatDate(request.work_date)} · {request.approved_minutes ?? request.requested_minutes} minutes</span><Badge variant={statusVariant(request.status)}>{request.status}</Badge></div>)}{overtime.length === 0 && <p className="text-sm text-muted-foreground">No overtime requests.</p>}</div></CardContent></Card>

      <Dialog open={dialog === 'leave'} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Request leave</DialogTitle><DialogDescription>Weekends are excluded from the requested day count. Your manager will approve the request.</DialogDescription></DialogHeader><div className="grid gap-3"><label className="text-sm">Leave type<select className={inputClass} value={leaveForm.leave_type} onChange={(event) => setLeaveForm({ ...leaveForm, leave_type: event.target.value })}><option value="">Select leave type</option>{leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}{type.paid ? ' · paid' : ' · unpaid'}</option>)}</select></label><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">From<Input type="date" value={leaveForm.start_date} onChange={(event) => setLeaveForm({ ...leaveForm, start_date: event.target.value })} /></label><label className="text-sm">To<Input type="date" value={leaveForm.end_date} onChange={(event) => setLeaveForm({ ...leaveForm, end_date: event.target.value })} /></label></div><label className="text-sm">Reason (optional)<Textarea value={leaveForm.reason} onChange={(event) => setLeaveForm({ ...leaveForm, reason: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={saving || !leaveForm.leave_type} onClick={() => void submitRequest('/hr/leave-requests/', leaveForm)}>{saving && <Loader2 className="animate-spin" />} Submit request</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={dialog === 'overtime'} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Request overtime</DialogTitle><DialogDescription>Submit the extra time worked so a manager can approve the payable minutes.</DialogDescription></DialogHeader><div className="grid gap-3"><label className="text-sm">Branch<select className={inputClass} value={overtimeForm.branch} onChange={(event) => setOvertimeForm({ ...overtimeForm, branch: event.target.value })}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label className="text-sm">Work date<Input type="date" value={overtimeForm.work_date} onChange={(event) => setOvertimeForm({ ...overtimeForm, work_date: event.target.value })} /></label><label className="text-sm">Minutes<Input type="number" min="1" value={overtimeForm.requested_minutes} onChange={(event) => setOvertimeForm({ ...overtimeForm, requested_minutes: event.target.value })} /></label><label className="text-sm">Reason (optional)<Textarea value={overtimeForm.reason} onChange={(event) => setOvertimeForm({ ...overtimeForm, reason: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={saving || !overtimeForm.branch} onClick={() => void submitRequest('/hr/overtime-requests/', { ...overtimeForm, requested_minutes: Number(overtimeForm.requested_minutes) })}>{saving && <Loader2 className="animate-spin" />} Submit request</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
