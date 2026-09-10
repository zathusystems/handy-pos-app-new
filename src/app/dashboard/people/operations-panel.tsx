'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Clock3, Loader2, Plus, X } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

type EmployeeOption = { id: string; full_name: string; employee_code: string };
type BranchOption = { id: string; name: string };
type Shift = {
  id: string; employee: string; employee_name: string; branch_name: string; work_date: string;
  starts_at: string; ends_at: string; break_minutes: number; scheduled_minutes: number; status: string;
};
type Attendance = {
  id: string; employee: string; employee_name: string; branch_name: string; work_date: string;
  clock_in: string; clock_out?: string | null; worked_minutes?: number | null; status: string; source: string;
};
type LeaveType = { id: string; name: string; code: string; paid: boolean; is_active: boolean };
type LeaveBalance = {
  id: string; employee: string; employee_name: string; leave_type: string; leave_type_name: string;
  year: number; total_days: string | number; approved_days: string | number; available_days: string | number;
};
type LeaveRequest = {
  id: string; employee_name: string; leave_type_name: string; start_date: string; end_date: string;
  requested_days: string | number; status: string; reason?: string;
};
type OvertimeRequest = {
  id: string; employee_name: string; branch_name: string; work_date: string;
  requested_minutes: number; approved_minutes?: number | null; status: string; reason?: string;
};

type Props = { businessId: string; employees: EmployeeOption[]; branches: BranchOption[] };

const normalizeCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)) {
    return (payload as { results: T[] }).results;
  }
  return [];
};

const todayValue = () => new Date().toISOString().slice(0, 10);
const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
const statusVariant = (status: string) => {
  if (status === 'approved' || status === 'scheduled') return 'default' as const;
  if (status === 'rejected' || status === 'cancelled') return 'destructive' as const;
  return 'secondary' as const;
};

export function PeopleOperationsPanel({ businessId, employees, branches }: Props) {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'shift' | 'attendance' | 'leave-type' | 'balance' | null>(null);
  const [shiftForm, setShiftForm] = useState({ employee: '', branch: '', work_date: todayValue(), starts_at: '08:00', ends_at: '17:00', break_minutes: '60', notes: '' });
  const [attendanceForm, setAttendanceForm] = useState({ employee: '', branch: '', work_date: todayValue(), clock_in: '', clock_out: '', break_minutes: '0', notes: '' });
  const [leaveTypeForm, setLeaveTypeForm] = useState({ name: '', code: '', paid: true, annual_allowance_days: '0', requires_approval: true });
  const [balanceForm, setBalanceForm] = useState({ employee: '', leave_type: '', year: String(new Date().getFullYear()), entitlement_days: '0', carried_over_days: '0', adjustment_days: '0', notes: '' });

  const query = `?business_id=${encodeURIComponent(businessId)}`;
  const loadOperations = useCallback(async () => {
    setLoading(true);
    try {
      const responses = await Promise.all([
        authFetch.fetch(`/hr/shifts/${query}`),
        authFetch.fetch(`/hr/attendance/${query}`),
        authFetch.fetch(`/hr/leave-types/${query}`),
        authFetch.fetch(`/hr/leave-balances/${query}`),
        authFetch.fetch(`/hr/leave-requests/${query}`),
        authFetch.fetch(`/hr/overtime-requests/${query}`),
      ]);
      setShifts(normalizeCollection<Shift>(responses[0]));
      setAttendance(normalizeCollection<Attendance>(responses[1]));
      setLeaveTypes(normalizeCollection<LeaveType>(responses[2]));
      setBalances(normalizeCollection<LeaveBalance>(responses[3]));
      setLeaveRequests(normalizeCollection<LeaveRequest>(responses[4]));
      setOvertime(normalizeCollection<OvertimeRequest>(responses[5]));
    } catch (error) {
      toast({ title: 'Could not load People operations', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { void loadOperations(); }, [loadOperations]);

  const closeDialog = () => { setDialog(null); setSaving(false); };
  const submit = async (url: string, body: Record<string, unknown>) => {
    setSaving(true);
    try {
      await authFetch.fetch(url, { method: 'POST', body: JSON.stringify(body), queueOnFailure: false });
      closeDialog();
      await loadOperations();
      toast({ title: 'Saved', description: 'The People record was saved.' });
    } catch (error) {
      toast({ title: 'Could not save record', description: error instanceof Error ? error.message : 'Please check the fields and try again.', variant: 'destructive' });
      setSaving(false);
    }
  };
  const postAction = async (url: string, body: Record<string, unknown> = {}) => {
    try {
      await authFetch.fetch(url, { method: 'POST', body: JSON.stringify(body), queueOnFailure: false });
      await loadOperations();
    } catch (error) {
      toast({ title: 'Action failed', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
    }
  };

  const formatDate = (value: string) => {
    if (!value) return 'Not set';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T00:00:00`));
  };
  const formatDateTime = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Still open';
  const employeeName = (id: string) => employees.find((employee) => employee.id === String(id))?.full_name || 'Employee';
  const pendingLeave = leaveRequests.filter((request) => request.status === 'pending');
  const pendingOvertime = overtime.filter((request) => request.status === 'pending');

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>People operations</CardTitle>
            <CardDescription>Schedule shifts, approve attendance, and keep leave and overtime decisions together.</CardDescription>
          </div>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="attendance">
          <TabsList className="grid h-auto w-full grid-cols-3 sm:inline-flex">
            <TabsTrigger value="attendance" className="gap-2"><Clock3 className="h-4 w-4" /> Attendance</TabsTrigger>
            <TabsTrigger value="leave">Leave {pendingLeave.length > 0 && <Badge variant="secondary" className="ml-1">{pendingLeave.length}</Badge>}</TabsTrigger>
            <TabsTrigger value="overtime">Overtime {pendingOvertime.length > 0 && <Badge variant="secondary" className="ml-1">{pendingOvertime.length}</Badge>}</TabsTrigger>
          </TabsList>

          <TabsContent value="attendance" className="space-y-5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => { setShiftForm((current) => ({ ...current, employee: employees[0]?.id || '', branch: branches[0]?.id || '' })); setDialog('shift'); }}><Plus /> Schedule shift</Button>
              <Button variant="outline" onClick={() => { setAttendanceForm((current) => ({ ...current, employee: employees[0]?.id || '', branch: branches[0]?.id || '', clock_in: `${todayValue()}T08:00` })); setDialog('attendance'); }}>Record attendance</Button>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Upcoming shifts</h3>
              <div className="divide-y rounded-md border">
                {shifts.slice(0, 8).map((shift) => (
                  <div key={shift.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div><p className="font-medium">{shift.employee_name || employeeName(shift.employee)}</p><p className="text-muted-foreground">{formatDate(shift.work_date)} · {shift.starts_at.slice(0, 5)} to {shift.ends_at.slice(0, 5)} · {shift.branch_name}</p></div>
                    <div className="flex items-center gap-2"><span className="text-muted-foreground">{shift.scheduled_minutes} min</span><Badge variant={statusVariant(shift.status)}>{shift.status}</Badge>{shift.status === 'scheduled' && <Button variant="ghost" size="sm" onClick={() => void postAction(`/hr/shifts/${shift.id}/cancel/`)}><X className="mr-1 h-4 w-4" /> Cancel</Button>}</div>
                  </div>
                ))}
                {!loading && shifts.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No shifts scheduled yet.</p>}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Attendance awaiting review</h3>
              <div className="divide-y rounded-md border">
                {attendance.filter((record) => record.status === 'submitted').slice(0, 8).map((record) => (
                  <div key={record.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{record.employee_name || employeeName(record.employee)}</p><p className="text-muted-foreground">{formatDate(record.work_date)} · {formatDateTime(record.clock_in)} to {formatDateTime(record.clock_out)} · {record.worked_minutes ?? 0} minutes</p></div><div className="flex gap-2"><Button size="sm" onClick={() => void postAction(`/hr/attendance/${record.id}/approve/`)}><Check className="mr-1 h-4 w-4" /> Approve</Button><Button size="sm" variant="outline" onClick={() => void postAction(`/hr/attendance/${record.id}/reject/`, { review_note: 'Please correct this attendance record.' })}><X className="mr-1 h-4 w-4" /> Reject</Button></div></div>
                ))}
                {!loading && attendance.filter((record) => record.status === 'submitted').length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No attendance records awaiting review.</p>}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="leave" className="space-y-5">
            <div className="flex flex-col gap-2 sm:flex-row"><Button onClick={() => setDialog('leave-type')}><Plus /> Add leave type</Button><Button variant="outline" onClick={() => { setBalanceForm((current) => ({ ...current, employee: employees[0]?.id || '', leave_type: leaveTypes[0]?.id || '' })); setDialog('balance'); }}>Allocate balance</Button></div>
            <div className="grid gap-3 sm:grid-cols-2">
              {balances.slice(0, 8).map((balance) => <div key={balance.id} className="rounded-md border p-3 text-sm"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{balance.employee_name || employeeName(balance.employee)}</p><p className="text-muted-foreground">{balance.leave_type_name} · {balance.year}</p></div><span className="font-semibold">{balance.available_days} days left</span></div><p className="mt-2 text-xs text-muted-foreground">{balance.approved_days} approved of {balance.total_days} allocated</p></div>)}
              {!loading && balances.length === 0 && <p className="text-sm text-muted-foreground sm:col-span-2">No leave balances allocated yet.</p>}
            </div>
            <div><h3 className="mb-2 text-sm font-semibold">Leave requests</h3><div className="divide-y rounded-md border">{leaveRequests.slice(0, 8).map((request) => <div key={request.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{request.employee_name} · {request.leave_type_name}</p><p className="text-muted-foreground">{formatDate(request.start_date)} to {formatDate(request.end_date)} · {request.requested_days} days</p></div><div className="flex items-center gap-2"><Badge variant={statusVariant(request.status)}>{request.status}</Badge>{request.status === 'pending' && <><Button size="sm" onClick={() => void postAction(`/hr/leave-requests/${request.id}/approve/`)}><Check className="mr-1 h-4 w-4" /> Approve</Button><Button size="sm" variant="outline" onClick={() => void postAction(`/hr/leave-requests/${request.id}/reject/`, { review_note: 'Request declined by management.' })}><X className="mr-1 h-4 w-4" /> Reject</Button></>}</div></div>)}{!loading && leaveRequests.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No leave requests yet.</p>}</div></div>
          </TabsContent>

          <TabsContent value="overtime" className="space-y-4">
            <p className="text-sm text-muted-foreground">Review overtime requests submitted by linked employees. Approved minutes are kept separately from scheduled shift time for payroll.</p>
            <div className="divide-y rounded-md border">{overtime.slice(0, 10).map((request) => <div key={request.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{request.employee_name} · {request.requested_minutes} minutes</p><p className="text-muted-foreground">{formatDate(request.work_date)} · {request.branch_name}{request.reason ? ` · ${request.reason}` : ''}</p></div><div className="flex items-center gap-2"><Badge variant={statusVariant(request.status)}>{request.status}</Badge>{request.status === 'pending' && <><Button size="sm" onClick={() => void postAction(`/hr/overtime-requests/${request.id}/approve/`)}><Check className="mr-1 h-4 w-4" /> Approve</Button><Button size="sm" variant="outline" onClick={() => void postAction(`/hr/overtime-requests/${request.id}/reject/`, { review_note: 'Request declined by management.' })}><X className="mr-1 h-4 w-4" /> Reject</Button></>}</div></div>)}{!loading && overtime.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No overtime requests yet.</p>}</div>
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={dialog === 'shift'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Schedule shift</DialogTitle><DialogDescription>Set the planned hours for one employee. Overnight shifts are not supported yet.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Employee<select className={inputClass} value={shiftForm.employee} onChange={(event) => setShiftForm({ ...shiftForm, employee: event.target.value })}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><label className="text-sm">Branch<select className={inputClass} value={shiftForm.branch} onChange={(event) => setShiftForm({ ...shiftForm, branch: event.target.value })}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label className="text-sm">Date<Input type="date" value={shiftForm.work_date} onChange={(event) => setShiftForm({ ...shiftForm, work_date: event.target.value })} /></label><label className="text-sm">Break minutes<Input type="number" min="0" value={shiftForm.break_minutes} onChange={(event) => setShiftForm({ ...shiftForm, break_minutes: event.target.value })} /></label><label className="text-sm">Starts at<Input type="time" value={shiftForm.starts_at} onChange={(event) => setShiftForm({ ...shiftForm, starts_at: event.target.value })} /></label><label className="text-sm">Ends at<Input type="time" value={shiftForm.ends_at} onChange={(event) => setShiftForm({ ...shiftForm, ends_at: event.target.value })} /></label><label className="text-sm sm:col-span-2">Notes<Textarea value={shiftForm.notes} onChange={(event) => setShiftForm({ ...shiftForm, notes: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={closeDialog}>Cancel</Button><Button disabled={saving} onClick={() => void submit('/hr/shifts/', { ...shiftForm, break_minutes: Number(shiftForm.break_minutes) })}>{saving && <Loader2 className="animate-spin" />} Save shift</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={dialog === 'attendance'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Record attendance</DialogTitle><DialogDescription>Use this for a correction or a paper timesheet. Employees can also clock themselves in and out.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Employee<select className={inputClass} value={attendanceForm.employee} onChange={(event) => setAttendanceForm({ ...attendanceForm, employee: event.target.value })}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><label className="text-sm">Branch<select className={inputClass} value={attendanceForm.branch} onChange={(event) => setAttendanceForm({ ...attendanceForm, branch: event.target.value })}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label className="text-sm">Work date<Input type="date" value={attendanceForm.work_date} onChange={(event) => setAttendanceForm({ ...attendanceForm, work_date: event.target.value })} /></label><label className="text-sm">Break minutes<Input type="number" min="0" value={attendanceForm.break_minutes} onChange={(event) => setAttendanceForm({ ...attendanceForm, break_minutes: event.target.value })} /></label><label className="text-sm">Clock in<Input type="datetime-local" value={attendanceForm.clock_in} onChange={(event) => setAttendanceForm({ ...attendanceForm, clock_in: event.target.value })} /></label><label className="text-sm">Clock out<Input type="datetime-local" value={attendanceForm.clock_out} onChange={(event) => setAttendanceForm({ ...attendanceForm, clock_out: event.target.value })} /></label><label className="text-sm sm:col-span-2">Notes<Textarea value={attendanceForm.notes} onChange={(event) => setAttendanceForm({ ...attendanceForm, notes: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={closeDialog}>Cancel</Button><Button disabled={saving} onClick={() => void submit('/hr/attendance/', { ...attendanceForm, clock_out: attendanceForm.clock_out || null, break_minutes: Number(attendanceForm.break_minutes) })}>{saving && <Loader2 className="animate-spin" />} Save attendance</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={dialog === 'leave-type'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Add leave type</DialogTitle><DialogDescription>Examples: Annual leave, Sick leave, or Unpaid leave. The code is an internal short label such as ANNUAL.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Name<Input value={leaveTypeForm.name} onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, name: event.target.value })} placeholder="Annual leave" /></label><label className="text-sm">Code<Input value={leaveTypeForm.code} onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, code: event.target.value.toUpperCase() })} placeholder="ANNUAL" /></label><label className="text-sm">Default annual days<Input type="number" min="0" step="0.5" value={leaveTypeForm.annual_allowance_days} onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, annual_allowance_days: event.target.value })} /></label><label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={leaveTypeForm.paid} onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, paid: event.target.checked })} /> Paid leave</label></div><DialogFooter><Button variant="outline" onClick={closeDialog}>Cancel</Button><Button disabled={saving} onClick={() => void submit('/hr/leave-types/', { ...leaveTypeForm, business_id: businessId, annual_allowance_days: Number(leaveTypeForm.annual_allowance_days) })}>{saving && <Loader2 className="animate-spin" />} Save leave type</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={dialog === 'balance'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Allocate leave balance</DialogTitle><DialogDescription>Set the days this employee can use for the selected leave type and year.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Employee<select className={inputClass} value={balanceForm.employee} onChange={(event) => setBalanceForm({ ...balanceForm, employee: event.target.value })}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><label className="text-sm">Leave type<select className={inputClass} value={balanceForm.leave_type} onChange={(event) => setBalanceForm({ ...balanceForm, leave_type: event.target.value })}><option value="">Select leave type</option>{leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label className="text-sm">Year<Input type="number" value={balanceForm.year} onChange={(event) => setBalanceForm({ ...balanceForm, year: event.target.value })} /></label><label className="text-sm">Entitlement days<Input type="number" min="0" step="0.5" value={balanceForm.entitlement_days} onChange={(event) => setBalanceForm({ ...balanceForm, entitlement_days: event.target.value })} /></label><label className="text-sm">Carried over days<Input type="number" min="0" step="0.5" value={balanceForm.carried_over_days} onChange={(event) => setBalanceForm({ ...balanceForm, carried_over_days: event.target.value })} /></label><label className="text-sm">Adjustment days<Input type="number" step="0.5" value={balanceForm.adjustment_days} onChange={(event) => setBalanceForm({ ...balanceForm, adjustment_days: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={closeDialog}>Cancel</Button><Button disabled={saving} onClick={() => void submit('/hr/leave-balances/', { ...balanceForm, year: Number(balanceForm.year), entitlement_days: Number(balanceForm.entitlement_days), carried_over_days: Number(balanceForm.carried_over_days), adjustment_days: Number(balanceForm.adjustment_days) })}>{saving && <Loader2 className="animate-spin" />} Save balance</Button></DialogFooter></DialogContent>
      </Dialog>
    </Card>
  );
}
