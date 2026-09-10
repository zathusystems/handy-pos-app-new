'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FilePlus2, Loader2, MoreHorizontal, Settings2, ShieldCheck, X } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { resolveOfflineBusinessId } from '@/lib/business-profile';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { toast } from '@/hooks/use-toast';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type PayrollSettings = { id: string; standard_monthly_hours: string | number; overtime_multiplier: string | number };
type PayrollLine = { id: string; payroll_entry: string; kind: 'earning' | 'deduction'; label: string; amount: string | number; notes?: string };
type PayrollEntry = {
  id: string; employee_name: string; employee_code: string; job_title_snapshot: string; pay_frequency_snapshot: string;
  currency: string; base_pay: string | number; overtime_minutes: number; overtime_pay: string | number;
  gross_pay: string | number; deductions_total: string | number; net_pay: string | number; lines: PayrollLine[];
};
type PayrollRun = {
  id: string; period_start: string; period_end: string; pay_date?: string | null; status: string; currency: string;
  notes?: string; total_gross: string | number; total_deductions: string | number; total_net: string | number; entries: PayrollEntry[];
};

const normalizeCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)) return (payload as { results: T[] }).results;
  return [];
};
const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
const statusVariant = (status: string) => status === 'paid' || status === 'approved' ? 'default' as const : status === 'void' ? 'destructive' as const : 'secondary' as const;
const dateValue = () => new Date().toISOString().slice(0, 10);
const monthStart = () => { const date = new Date(); date.setDate(1); return date.toISOString().slice(0, 10); };
const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T00:00:00`)) : 'Not set';

export default function PayrollPage() {
  const { user, business } = useAuth();
  const { accessCheck, isLoading: loadingAccess } = useSubscriptionFeatureAccess('staff_management');
  const { currencyCode } = useCurrency();
  const businessId = String(user?.businessId || business?.id || resolveOfflineBusinessId() || '').trim();
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ standard_monthly_hours: '208', overtime_multiplier: '1.50' });
  const [runForm, setRunForm] = useState({ period_start: monthStart(), period_end: dateValue(), pay_date: dateValue(), currency: currencyCode || 'MWK', notes: '' });
  const [lineForm, setLineForm] = useState({ payroll_entry: '', kind: 'deduction' as 'earning' | 'deduction', label: '', amount: '', notes: '' });
  const [dialog, setDialog] = useState<'settings' | 'run' | 'line' | null>(null);
  const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null);

  useEffect(() => {
    if (currencyCode && !runForm.currency) setRunForm((current) => ({ ...current, currency: currencyCode }));
  }, [currencyCode, runForm.currency]);

  const loadData = useCallback(async () => {
    if (!businessId || !accessCheck.allowed) { setLoading(false); return; }
    setLoading(true);
    try {
      const query = `?business_id=${encodeURIComponent(businessId)}`;
      const [settingsResponse, runsResponse] = await Promise.all([
        authFetch.fetch(`/hr/payroll-settings/${query}`),
        authFetch.fetch(`/hr/payroll-runs/${query}`),
      ]);
      const loadedSettings = normalizeCollection<PayrollSettings>(settingsResponse)[0] || null;
      setSettings(loadedSettings);
      if (loadedSettings) setSettingsForm({ standard_monthly_hours: String(loadedSettings.standard_monthly_hours), overtime_multiplier: String(loadedSettings.overtime_multiplier) });
      setRuns(normalizeCollection<PayrollRun>(runsResponse));
    } catch (error) {
      toast({ title: 'Could not load payroll', description: error instanceof Error ? error.message : 'Please refresh and try again.', variant: 'destructive' });
    } finally { setLoading(false); }
  }, [accessCheck.allowed, businessId]);

  useEffect(() => { if (!loadingAccess) void loadData(); }, [loadingAccess, loadData]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const body = { ...settingsForm, standard_monthly_hours: Number(settingsForm.standard_monthly_hours), overtime_multiplier: Number(settingsForm.overtime_multiplier), business_id: businessId };
      const response = await authFetch.fetch(settings ? `/hr/payroll-settings/${settings.id}/` : '/hr/payroll-settings/', { method: settings ? 'PATCH' : 'POST', body: JSON.stringify(body), queueOnFailure: false });
      setSettings(response);
      setDialog(null);
      toast({ title: 'Payroll settings saved' });
    } catch (error) { toast({ title: 'Could not save settings', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' }); } finally { setSaving(false); }
  };
  const createRun = async () => {
    setSaving(true);
    try {
      const response = await authFetch.fetch('/hr/payroll-runs/', { method: 'POST', body: JSON.stringify({ ...runForm, business_id: businessId }), queueOnFailure: false });
      setRuns((current) => [response, ...current]);
      setDialog(null);
      toast({ title: 'Payroll run created', description: 'Generate it when the period records are ready.' });
    } catch (error) { toast({ title: 'Could not create payroll run', description: error instanceof Error ? error.message : 'Please check the dates.', variant: 'destructive' }); } finally { setSaving(false); }
  };
  const runAction = async (run: PayrollRun, action: 'generate' | 'approve' | 'mark-paid' | 'void') => {
    try {
      const response = await authFetch.fetch(`/hr/payroll-runs/${run.id}/${action}/`, { method: 'POST', body: JSON.stringify(action === 'void' ? { reason: 'Voided by management.' } : {}), queueOnFailure: false });
      setRuns((current) => current.map((item) => item.id === run.id ? response : item));
      if (selectedRun?.id === run.id) setSelectedRun(response);
      toast({ title: action === 'mark-paid' ? 'Payroll marked paid' : `Payroll ${action}d` });
    } catch (error) { toast({ title: 'Payroll action failed', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' }); }
  };
  const addLine = async () => {
    setSaving(true);
    try {
      await authFetch.fetch('/hr/payroll-lines/', { method: 'POST', body: JSON.stringify({ ...lineForm, amount: Number(lineForm.amount) }), queueOnFailure: false });
      const refreshed = await authFetch.fetch(`/hr/payroll-runs/${selectedRun?.id}/`);
      setSelectedRun(refreshed);
      setRuns((current) => current.map((run) => run.id === refreshed.id ? refreshed : run));
      setDialog(null);
      toast({ title: 'Payroll adjustment added' });
    } catch (error) { toast({ title: 'Could not add adjustment', description: error instanceof Error ? error.message : 'Please check the fields.', variant: 'destructive' }); } finally { setSaving(false); }
  };
  const formatMoney = (amount: string | number, currency?: string) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || currencyCode || 'MWK' }).format(Number(amount || 0)); } catch { return `${currency || currencyCode || 'MWK'} ${Number(amount || 0).toFixed(2)}`; }
  };
  const calculatedCount = useMemo(() => runs.filter((run) => run.status === 'calculated').length, [runs]);

  if (loadingAccess) return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  if (!accessCheck.allowed) return <div className="flex flex-col gap-6"><div><h1 className="text-2xl font-bold tracking-normal">Payroll</h1><p className="text-muted-foreground">Prepare, review, and record employee pay.</p></div><SubscriptionFeatureDisabledCard featureName="staff_management" accessCheck={accessCheck} /></div>;
  if (!businessId) return <div className="flex h-full items-center justify-center text-muted-foreground">Select a business before managing payroll.</div>;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-bold tracking-normal">Payroll</h1><p className="text-muted-foreground">Calculate pay from employment terms, approved overtime, and explicit adjustments.</p></div><div className="flex flex-col gap-2 sm:flex-row"><Button variant="outline" onClick={() => setDialog('settings')}><Settings2 /> Payroll settings</Button><Button onClick={() => setDialog('run')}><FilePlus2 /> New payroll run</Button></div></div>
      <div className="grid gap-4 sm:grid-cols-3"><Card><CardContent className="p-5"><p className="text-sm text-muted-foreground">Payroll runs</p><p className="mt-1 text-2xl font-semibold">{runs.length}</p></CardContent></Card><Card><CardContent className="p-5"><p className="text-sm text-muted-foreground">Awaiting approval</p><p className="mt-1 text-2xl font-semibold">{calculatedCount}</p></CardContent></Card><Card><CardContent className="p-5"><p className="text-sm text-muted-foreground">Overtime rate</p><p className="mt-1 text-2xl font-semibold">{settingsForm.overtime_multiplier}×</p></CardContent></Card></div>
      <Card><CardHeader><CardTitle>Payroll runs</CardTitle><CardDescription>Generate a run only after attendance and overtime approvals are complete. Paid runs are locked.</CardDescription></CardHeader><CardContent><div className="hidden overflow-x-auto md:block"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="p-3 font-medium">Period</th><th className="p-3 font-medium">Employees</th><th className="p-3 font-medium">Gross</th><th className="p-3 font-medium">Deductions</th><th className="p-3 font-medium">Net pay</th><th className="p-3 font-medium">Status</th><th className="p-3" /></tr></thead><tbody>{runs.map((run) => <tr key={run.id} className="border-b last:border-0"><td className="p-3"><button className="text-left font-medium hover:underline" onClick={() => setSelectedRun(run)}>{formatDate(run.period_start)} to {formatDate(run.period_end)}</button><p className="text-xs text-muted-foreground">Pay date: {formatDate(run.pay_date)}</p></td><td className="p-3">{run.entries?.length || 0}</td><td className="p-3">{formatMoney(run.total_gross, run.currency)}</td><td className="p-3">{formatMoney(run.total_deductions, run.currency)}</td><td className="p-3 font-semibold">{formatMoney(run.total_net, run.currency)}</td><td className="p-3"><Badge variant={statusVariant(run.status)}>{run.status}</Badge></td><td className="p-3 text-right"><Button variant="ghost" size="icon" aria-label="Payroll actions" onClick={() => setSelectedRun(run)}><MoreHorizontal /></Button></td></tr>)}</tbody></table></div><div className="space-y-3 md:hidden">{runs.map((run) => <div key={run.id} className="rounded-md border p-3"><div className="flex items-start justify-between gap-3"><button className="text-left font-medium" onClick={() => setSelectedRun(run)}>{formatDate(run.period_start)} to {formatDate(run.period_end)}</button><Badge variant={statusVariant(run.status)}>{run.status}</Badge></div><p className="mt-2 text-sm text-muted-foreground">{run.entries?.length || 0} employees · Net {formatMoney(run.total_net, run.currency)}</p></div>)}</div>{!loading && runs.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No payroll runs yet. Create a period when you are ready.</div>}{loading && <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>}</CardContent></Card>

      <Dialog open={Boolean(selectedRun)} onOpenChange={(open) => !open && setSelectedRun(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>Payroll details</DialogTitle><DialogDescription>{selectedRun ? `${formatDate(selectedRun.period_start)} to ${formatDate(selectedRun.period_end)} · ${selectedRun.status}` : ''}</DialogDescription></DialogHeader>{selectedRun && <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Gross pay</p><p className="font-semibold">{formatMoney(selectedRun.total_gross, selectedRun.currency)}</p></div><div><p className="text-xs text-muted-foreground">Deductions</p><p className="font-semibold">{formatMoney(selectedRun.total_deductions, selectedRun.currency)}</p></div><div><p className="text-xs text-muted-foreground">Net pay</p><p className="font-semibold">{formatMoney(selectedRun.total_net, selectedRun.currency)}</p></div></div><div className="flex flex-wrap gap-2">{selectedRun.status === 'draft' && <Button onClick={() => void runAction(selectedRun, 'generate')}><Check /> Generate</Button>}{selectedRun.status === 'calculated' && <Button onClick={() => void runAction(selectedRun, 'approve')}><ShieldCheck /> Approve</Button>}{selectedRun.status === 'approved' && <Button onClick={() => void runAction(selectedRun, 'mark-paid')}><Check /> Mark paid</Button>}{(selectedRun.status === 'draft' || selectedRun.status === 'calculated') && <Button variant="outline" onClick={() => void runAction(selectedRun, 'void')}><X /> Void</Button>}{(selectedRun.status === 'draft' || selectedRun.status === 'calculated') && selectedRun.entries?.length > 0 && <Button variant="outline" onClick={() => { setLineForm((current) => ({ ...current, payroll_entry: selectedRun.entries[0].id })); setDialog('line'); }}>Add adjustment</Button>}</div><div className="divide-y rounded-md border">{selectedRun.entries?.map((entry) => <div key={entry.id} className="p-3 text-sm"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{entry.employee_name} <span className="font-normal text-muted-foreground">({entry.employee_code})</span></p><p className="text-muted-foreground">{entry.job_title_snapshot} · {entry.pay_frequency_snapshot} · {entry.overtime_minutes} overtime minutes</p></div><div className="text-left sm:text-right"><p className="font-semibold">{formatMoney(entry.net_pay, entry.currency)}</p><p className="text-xs text-muted-foreground">Gross {formatMoney(entry.gross_pay, entry.currency)} · Deductions {formatMoney(entry.deductions_total, entry.currency)}</p></div></div>{entry.lines?.length > 0 && <div className="mt-2 space-y-1 border-l-2 pl-3 text-xs text-muted-foreground">{entry.lines.map((line) => <p key={line.id}>{line.kind === 'earning' ? '+' : '-'} {line.label}: {formatMoney(line.amount, entry.currency)}</p>)}</div>}</div>)}{(!selectedRun.entries || selectedRun.entries.length === 0) && <p className="p-8 text-center text-sm text-muted-foreground">Generate this run to create employee payslips.</p>}</div></div>}</DialogContent></Dialog>

      <Dialog open={dialog === 'settings'} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Payroll settings</DialogTitle><DialogDescription>These are calculation settings, not statutory tax rules. Add taxes or other deductions explicitly to each payslip.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Standard monthly hours<Input type="number" min="1" step="0.5" value={settingsForm.standard_monthly_hours} onChange={(event) => setSettingsForm({ ...settingsForm, standard_monthly_hours: event.target.value })} /></label><label className="text-sm">Overtime multiplier<Input type="number" min="0.01" step="0.05" value={settingsForm.overtime_multiplier} onChange={(event) => setSettingsForm({ ...settingsForm, overtime_multiplier: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={saving} onClick={() => void saveSettings()}>{saving && <Loader2 className="animate-spin" />} Save settings</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={dialog === 'run'} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>New payroll run</DialogTitle><DialogDescription>Use one currency per run. The employment term and approved overtime available in this period are snapshotted when generated.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Period starts<Input type="date" value={runForm.period_start} onChange={(event) => setRunForm({ ...runForm, period_start: event.target.value })} /></label><label className="text-sm">Period ends<Input type="date" value={runForm.period_end} onChange={(event) => setRunForm({ ...runForm, period_end: event.target.value })} /></label><label className="text-sm">Pay date<Input type="date" value={runForm.pay_date} onChange={(event) => setRunForm({ ...runForm, pay_date: event.target.value })} /></label><label className="text-sm">Currency<Input maxLength={3} value={runForm.currency} onChange={(event) => setRunForm({ ...runForm, currency: event.target.value.toUpperCase() })} /></label><label className="text-sm sm:col-span-2">Notes<Textarea value={runForm.notes} onChange={(event) => setRunForm({ ...runForm, notes: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={saving} onClick={() => void createRun()}>{saving && <Loader2 className="animate-spin" />} Create run</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={dialog === 'line'} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Add payroll adjustment</DialogTitle><DialogDescription>Use a positive amount. Earnings increase gross pay; deductions reduce net pay. For statutory deductions, use the approved figures for your jurisdiction.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm sm:col-span-2">Employee<select className={inputClass} value={lineForm.payroll_entry} onChange={(event) => setLineForm({ ...lineForm, payroll_entry: event.target.value })}>{selectedRun?.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.employee_name} · {entry.employee_code}</option>)}</select></label><label className="text-sm">Type<select className={inputClass} value={lineForm.kind} onChange={(event) => setLineForm({ ...lineForm, kind: event.target.value as 'earning' | 'deduction' })}><option value="earning">Earning</option><option value="deduction">Deduction</option></select></label><label className="text-sm">Amount<Input type="number" min="0" step="0.01" value={lineForm.amount} onChange={(event) => setLineForm({ ...lineForm, amount: event.target.value })} /></label><label className="text-sm sm:col-span-2">Label<Input value={lineForm.label} onChange={(event) => setLineForm({ ...lineForm, label: event.target.value })} placeholder="Transport allowance or PAYE" /></label><label className="text-sm sm:col-span-2">Notes<Textarea value={lineForm.notes} onChange={(event) => setLineForm({ ...lineForm, notes: event.target.value })} /></label></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={saving || !lineForm.label || !lineForm.amount} onClick={() => void addLine()}>{saving && <Loader2 className="animate-spin" />} Add adjustment</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
