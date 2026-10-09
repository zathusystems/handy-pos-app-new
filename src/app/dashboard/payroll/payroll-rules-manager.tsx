'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Power, ReceiptText } from 'lucide-react';

import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type PayrollRule = {
  id: string;
  name: string;
  code: string;
  kind: 'earning' | 'deduction';
  calculation_method: 'fixed' | 'base_percentage' | 'gross_percentage';
  fixed_amount: string | number;
  percentage_rate: string | number;
  effective_from?: string | null;
  effective_to?: string | null;
  is_active: boolean;
  notes?: string;
};

type RuleForm = {
  name: string;
  code: string;
  kind: PayrollRule['kind'];
  calculation_method: PayrollRule['calculation_method'];
  amount: string;
  effective_from: string;
  effective_to: string;
  is_active: boolean;
  notes: string;
};

const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
const emptyRuleForm = (): RuleForm => ({
  name: '',
  code: '',
  kind: 'deduction',
  calculation_method: 'gross_percentage',
  amount: '',
  effective_from: '',
  effective_to: '',
  is_active: true,
  notes: '',
});

const normalizeCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)) {
    return (payload as { results: T[] }).results;
  }
  return [];
};

const methodLabel = (method: PayrollRule['calculation_method']) => {
  if (method === 'fixed') return 'Fixed amount';
  if (method === 'base_percentage') return '% of base pay';
  return '% of gross pay';
};

export function PayrollRulesManager({ businessId, currencyCode }: { businessId: string; currencyCode: string }) {
  const [rules, setRules] = useState<PayrollRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<PayrollRule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyRuleForm);

  const loadRules = useCallback(async () => {
    if (!businessId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await authFetch.fetch(`/hr/payroll-rules/?business_id=${encodeURIComponent(businessId)}`);
      setRules(normalizeCollection<PayrollRule>(response));
    } catch (error) {
      toast({
        title: 'Could not load payroll rules',
        description: error instanceof Error ? error.message : 'Please refresh and try again.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const openCreate = () => {
    setEditingRule(null);
    setForm(emptyRuleForm());
    setRuleDialogOpen(true);
  };

  const openEdit = (rule: PayrollRule) => {
    setEditingRule(rule);
    setForm({
      name: rule.name,
      code: rule.code || '',
      kind: rule.kind,
      calculation_method: rule.calculation_method,
      amount: String(rule.calculation_method === 'fixed' ? rule.fixed_amount : rule.percentage_rate),
      effective_from: String(rule.effective_from || '').slice(0, 10),
      effective_to: String(rule.effective_to || '').slice(0, 10),
      is_active: rule.is_active,
      notes: rule.notes || '',
    });
    setRuleDialogOpen(true);
  };

  const closeDialog = () => {
    setRuleDialogOpen(false);
    setEditingRule(null);
    setForm(emptyRuleForm());
  };

  const saveRule = async () => {
    const amount = Number(form.amount);
    if (!form.name.trim() || !Number.isFinite(amount) || amount < 0) {
      toast({ title: 'Enter a rule name and a valid amount.', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      const body = {
        business_id: businessId,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        kind: form.kind,
        calculation_method: form.calculation_method,
        fixed_amount: form.calculation_method === 'fixed' ? amount : 0,
        percentage_rate: form.calculation_method === 'fixed' ? 0 : amount,
        effective_from: form.effective_from || null,
        effective_to: form.effective_to || null,
        is_active: form.is_active,
        notes: form.notes.trim(),
      };
      await authFetch.fetch(
        editingRule ? `/hr/payroll-rules/${editingRule.id}/` : '/hr/payroll-rules/',
        {
          method: editingRule ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
          queueOnFailure: false,
        },
      );
      closeDialog();
      await loadRules();
      toast({ title: editingRule ? 'Payroll rule updated' : 'Payroll rule added' });
    } catch (error) {
      toast({
        title: 'Could not save payroll rule',
        description: error instanceof Error ? error.message : 'Please check the rule and try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: PayrollRule) => {
    try {
      await authFetch.fetch(`/hr/payroll-rules/${rule.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !rule.is_active }),
        queueOnFailure: false,
      });
      await loadRules();
    } catch (error) {
      toast({
        title: 'Could not update payroll rule',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Recurring payroll rules</CardTitle>
            <CardDescription>PAYE, allowances, loans, pension, and other regular payroll items.</CardDescription>
          </div>
          <Button type="button" variant="outline" onClick={openCreate} className="w-full sm:w-auto">
            <Plus className="mr-1 h-4 w-4" /> Add rule
          </Button>
        </CardHeader>
        <CardContent>
          <div className="divide-y rounded-md border">
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-col gap-3 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{rule.name}</p>
                    {rule.code && <span className="text-xs text-muted-foreground">{rule.code}</span>}
                    <Badge variant={rule.kind === 'earning' ? 'default' : 'secondary'}>{rule.kind}</Badge>
                    {!rule.is_active && <Badge variant="outline">inactive</Badge>}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {methodLabel(rule.calculation_method)}: {rule.calculation_method === 'fixed'
                      ? `${currencyCode} ${Number(rule.fixed_amount || 0).toFixed(2)}`
                      : `${Number(rule.percentage_rate || 0).toFixed(2)}%`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => openEdit(rule)}>
                    <Pencil className="mr-1 h-4 w-4" /> Edit
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void toggleRule(rule)}>
                    <Power className="mr-1 h-4 w-4" /> {rule.is_active ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              </div>
            ))}
            {!loading && rules.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No recurring payroll rules configured.</p>}
            {loading && <p className="p-6 text-center text-sm text-muted-foreground">Loading payroll rules...</p>}
          </div>
        </CardContent>
      </Card>

      <Dialog open={ruleDialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingRule ? 'Edit payroll rule' : 'Add payroll rule'}</DialogTitle>
            <DialogDescription>Use the approved rate or amount for this business. It is applied when a payroll run is generated.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">Name<Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="PAYE" /></label>
            <label className="text-sm">Code (optional)<Input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} placeholder="PAYE" /></label>
            <label className="text-sm">Type<select className={inputClass} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as PayrollRule['kind'] })}><option value="deduction">Deduction</option><option value="earning">Earning / allowance</option></select></label>
            <label className="text-sm sm:col-span-2">Calculation<select className={inputClass} value={form.calculation_method} onChange={(event) => setForm({ ...form, calculation_method: event.target.value as PayrollRule['calculation_method'] })}><option value="fixed">Fixed amount per payroll run</option><option value="base_percentage">Percentage of base pay</option><option value="gross_percentage">Percentage of gross pay</option></select></label>
            <label className="text-sm sm:col-span-2">{form.calculation_method === 'fixed' ? `Amount (${currencyCode})` : 'Percentage'}<Input type="number" min="0" max={form.calculation_method === 'fixed' ? undefined : 100} step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
            <label className="text-sm">Effective from (optional)<Input type="date" value={form.effective_from} onChange={(event) => setForm({ ...form, effective_from: event.target.value })} /></label>
            <label className="text-sm">Effective to (optional)<Input type="date" value={form.effective_to} onChange={(event) => setForm({ ...form, effective_to: event.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} /> Active for new payroll runs</label>
            <label className="text-sm sm:col-span-2">Notes (optional)<Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={closeDialog}>Cancel</Button><Button type="button" disabled={saving} onClick={() => void saveRule()}><ReceiptText className="mr-1 h-4 w-4" /> {saving ? 'Saving...' : 'Save rule'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
