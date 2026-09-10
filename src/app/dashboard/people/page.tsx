'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  BadgeDollarSign,
  BriefcaseBusiness,
  CalendarDays,
  ContactRound,
  Eye,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';

import { authFetch } from '@/lib/auth-fetch';
import { resolveOfflineBusinessId } from '@/lib/business-profile';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { toast } from '@/hooks/use-toast';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { PeopleOperationsPanel } from './operations-panel';

type Branch = {
  id: string;
  name: string;
};

type StaffOption = {
  id: string;
  name: string;
  email: string;
};

type EmploymentTerm = {
  id: string;
  employee: string;
  branch: string;
  branch_name?: string;
  job_title: string;
  department?: string;
  employment_type: 'full_time' | 'part_time' | 'contract' | 'casual';
  pay_frequency: 'monthly' | 'fortnightly' | 'weekly' | 'hourly';
  base_salary: string | number;
  currency: string;
  effective_from: string;
  effective_to?: string | null;
  notes?: string;
};

type Employee = {
  id: string;
  business: string | number;
  staff?: string | number | null;
  staff_name?: string | null;
  employee_number: number;
  employee_code: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email?: string;
  phone?: string;
  address?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  employment_status: 'active' | 'on_leave' | 'terminated';
  started_on?: string | null;
  ended_on?: string | null;
  notes?: string;
  current_employment_term?: EmploymentTerm | null;
  employment_terms: EmploymentTerm[];
};

const employeeSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required.'),
  last_name: z.string().trim().min(1, 'Last name is required.'),
  email: z.string().trim().email('Enter a valid email address.').optional().or(z.literal('')),
  phone: z.string().trim().max(32).optional(),
  staff: z.string().optional(),
  employment_status: z.enum(['active', 'on_leave', 'terminated']),
  started_on: z.string().optional(),
  ended_on: z.string().optional(),
  address: z.string().optional(),
  emergency_contact_name: z.string().optional(),
  emergency_contact_phone: z.string().optional(),
  notes: z.string().optional(),
  branch: z.string().min(1, 'Branch is required.'),
  job_title: z.string().trim().min(1, 'Job title is required.'),
  department: z.string().optional(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'casual']),
  pay_frequency: z.enum(['monthly', 'fortnightly', 'weekly', 'hourly']),
  base_salary: z.coerce.number().min(0, 'Base pay cannot be negative.'),
  currency: z.string().trim().length(3, 'Use a three-letter currency code.'),
  effective_from: z.string().min(1, 'Effective date is required.'),
});

const termSchema = z.object({
  branch: z.string().min(1, 'Branch is required.'),
  job_title: z.string().trim().min(1, 'Job title is required.'),
  department: z.string().optional(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'casual']),
  pay_frequency: z.enum(['monthly', 'fortnightly', 'weekly', 'hourly']),
  base_salary: z.coerce.number().min(0, 'Base pay cannot be negative.'),
  currency: z.string().trim().length(3, 'Use a three-letter currency code.'),
  effective_from: z.string().min(1, 'Effective date is required.'),
  effective_to: z.string().optional(),
  notes: z.string().optional(),
});

type EmployeeFormValues = z.infer<typeof employeeSchema>;
type TermFormValues = z.infer<typeof termSchema>;

const dateInputValue = (value?: string | null) => String(value || '').slice(0, 10);
const todayInputValue = () => format(new Date(), 'yyyy-MM-dd');
const normalizeCollection = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)) {
    return (payload as { results: T[] }).results;
  }
  return [];
};

const titleCase = (value?: string | null) => String(value || '')
  .split('_')
  .filter(Boolean)
  .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
  .join(' ');

const statusVariant = (status: Employee['employment_status']) => {
  if (status === 'active') return 'default' as const;
  if (status === 'on_leave') return 'secondary' as const;
  return 'outline' as const;
};

const termPayload = (values: TermFormValues) => ({
  branch: Number(values.branch),
  job_title: values.job_title.trim(),
  department: values.department?.trim() || '',
  employment_type: values.employment_type,
  pay_frequency: values.pay_frequency,
  base_salary: values.base_salary,
  currency: values.currency.trim().toUpperCase(),
  effective_from: values.effective_from,
  effective_to: values.effective_to || null,
  notes: values.notes?.trim() || '',
});

function EmployeeForm({
  employee,
  branches,
  staff,
  businessId,
  currencyCode,
  onSaved,
}: {
  employee?: Employee | null;
  branches: Branch[];
  staff: StaffOption[];
  businessId: string;
  currencyCode: string;
  onSaved: () => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const currentTerm = employee?.current_employment_term;
  const form = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: {
      first_name: employee?.first_name || '',
      last_name: employee?.last_name || '',
      email: employee?.email || '',
      phone: employee?.phone || '',
      staff: employee?.staff ? String(employee.staff) : '',
      employment_status: employee?.employment_status || 'active',
      started_on: dateInputValue(employee?.started_on) || dateInputValue(currentTerm?.effective_from) || todayInputValue(),
      ended_on: dateInputValue(employee?.ended_on),
      address: employee?.address || '',
      emergency_contact_name: employee?.emergency_contact_name || '',
      emergency_contact_phone: employee?.emergency_contact_phone || '',
      notes: employee?.notes || '',
      branch: String(currentTerm?.branch || branches[0]?.id || ''),
      job_title: currentTerm?.job_title || '',
      department: currentTerm?.department || '',
      employment_type: currentTerm?.employment_type || 'full_time',
      pay_frequency: currentTerm?.pay_frequency || 'monthly',
      base_salary: Number(currentTerm?.base_salary || 0),
      currency: currentTerm?.currency || currencyCode || 'MWK',
      effective_from: dateInputValue(currentTerm?.effective_from) || todayInputValue(),
    },
  });

  const submit = async (values: EmployeeFormValues) => {
    setIsSaving(true);
    try {
      const employeePayload = {
        first_name: values.first_name.trim(),
        last_name: values.last_name.trim(),
        email: values.email?.trim() || '',
        phone: values.phone?.trim() || '',
        staff: values.staff ? Number(values.staff) : null,
        employment_status: values.employment_status,
        started_on: values.started_on || null,
        ended_on: values.ended_on || null,
        address: values.address?.trim() || '',
        emergency_contact_name: values.emergency_contact_name?.trim() || '',
        emergency_contact_phone: values.emergency_contact_phone?.trim() || '',
        notes: values.notes?.trim() || '',
      };

      if (employee) {
        await authFetch.fetch(`/hr/employees/${employee.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(employeePayload),
        });
        toast({ title: 'Employee updated' });
      } else {
        await authFetch.fetch('/hr/employees/', {
          method: 'POST',
          body: JSON.stringify({
            ...employeePayload,
            business_id: businessId,
            initial_employment_term: termPayload({
              branch: values.branch,
              job_title: values.job_title,
              department: values.department,
              employment_type: values.employment_type,
              pay_frequency: values.pay_frequency,
              base_salary: values.base_salary,
              currency: values.currency,
              effective_from: values.effective_from,
            }),
          }),
        });
        toast({ title: 'Employee added' });
      }
      onSaved();
    } catch (error) {
      toast({
        title: 'Could not save employee',
        description: error instanceof Error ? error.message : 'Please review the details and try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isEdit = Boolean(employee);
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-6 py-1">
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Employee profile</h3>
            <p className="text-sm text-muted-foreground">Contact and employment information for this person.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="first_name" render={({ field }) => (
              <FormItem><FormLabel>First name</FormLabel><FormControl><Input autoComplete="given-name" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="last_name" render={({ field }) => (
              <FormItem><FormLabel>Last name</FormLabel><FormControl><Input autoComplete="family-name" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" autoComplete="email" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="phone" render={({ field }) => (
              <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" autoComplete="tel" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="staff" render={({ field }) => (
              <FormItem>
                <FormLabel>Linked app account</FormLabel>
                <Select value={field.value || 'none'} onValueChange={(value) => field.onChange(value === 'none' ? '' : value)}>
                  <FormControl><SelectTrigger><SelectValue placeholder="No app account" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="none">No app account</SelectItem>
                    {staff.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}{member.email ? ` (${member.email})` : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FormDescription>Optional. Employees can exist without POS access.</FormDescription>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="employment_status" render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="on_leave">On leave</SelectItem>
                    <SelectItem value="terminated">Terminated</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="started_on" render={({ field }) => (
              <FormItem><FormLabel>Employment start</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="ended_on" render={({ field }) => (
              <FormItem><FormLabel>Employment end</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
        </div>

        {!isEdit && (
          <div className="border-t pt-5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold">First employment term</h3>
              <p className="text-sm text-muted-foreground">This creates the starting role and pay basis. Future changes are recorded as new terms.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="branch" render={({ field }) => (
                <FormItem><FormLabel>Branch</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger></FormControl><SelectContent>{branches.map((branch) => <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="job_title" render={({ field }) => (
                <FormItem><FormLabel>Job title</FormLabel><FormControl><Input placeholder="e.g. Store supervisor" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="department" render={({ field }) => (
                <FormItem><FormLabel>Department</FormLabel><FormControl><Input placeholder="e.g. Operations" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="employment_type" render={({ field }) => (
                <FormItem><FormLabel>Employment type</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="full_time">Full time</SelectItem><SelectItem value="part_time">Part time</SelectItem><SelectItem value="contract">Contract</SelectItem><SelectItem value="casual">Casual</SelectItem></SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="pay_frequency" render={({ field }) => (
                <FormItem><FormLabel>Pay frequency</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="fortnightly">Fortnightly</SelectItem><SelectItem value="weekly">Weekly</SelectItem><SelectItem value="hourly">Hourly</SelectItem></SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="base_salary" render={({ field }) => (
                <FormItem><FormLabel>Base pay</FormLabel><FormControl><Input type="number" min="0" step="0.01" inputMode="decimal" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="currency" render={({ field }) => (
                <FormItem><FormLabel>Currency</FormLabel><FormControl><Input className="uppercase" maxLength={3} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="effective_from" render={({ field }) => (
                <FormItem><FormLabel>Effective from</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
          </div>
        )}

        <div className="border-t pt-5">
          <div className="mb-3"><h3 className="text-sm font-semibold">Contact and notes</h3></div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="emergency_contact_name" render={({ field }) => (
              <FormItem><FormLabel>Emergency contact</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="emergency_contact_phone" render={({ field }) => (
              <FormItem><FormLabel>Emergency phone</FormLabel><FormControl><Input type="tel" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
          <FormField control={form.control} name="address" render={({ field }) => (
            <FormItem className="mt-4"><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="notes" render={({ field }) => (
            <FormItem className="mt-4"><FormLabel>Internal notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>

        <DialogFooter className="sticky bottom-0 bg-background pt-2">
          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" />}
            {isEdit ? 'Save employee' : 'Add employee'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

function EmploymentTermForm({
  employee,
  branches,
  currencyCode,
  onSaved,
}: {
  employee: Employee;
  branches: Branch[];
  currencyCode: string;
  onSaved: () => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const currentTerm = employee.current_employment_term;
  const form = useForm<TermFormValues>({
    resolver: zodResolver(termSchema),
    defaultValues: {
      branch: String(currentTerm?.branch || branches[0]?.id || ''),
      job_title: currentTerm?.job_title || '',
      department: currentTerm?.department || '',
      employment_type: currentTerm?.employment_type || 'full_time',
      pay_frequency: currentTerm?.pay_frequency || 'monthly',
      base_salary: Number(currentTerm?.base_salary || 0),
      currency: currentTerm?.currency || currencyCode || 'MWK',
      effective_from: todayInputValue(),
      effective_to: '',
      notes: '',
    },
  });

  const submit = async (values: TermFormValues) => {
    setIsSaving(true);
    try {
      await authFetch.fetch('/hr/employment-terms/', {
        method: 'POST',
        body: JSON.stringify({ employee: employee.id, ...termPayload(values) }),
      });
      toast({ title: 'Employment term added', description: 'The previous term remains in the employee history.' });
      onSaved();
    } catch (error) {
      toast({
        title: 'Could not add employment term',
        description: error instanceof Error ? error.message : 'Please review the dates and try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="grid gap-4 py-1 sm:grid-cols-2">
        <FormField control={form.control} name="branch" render={({ field }) => (
          <FormItem><FormLabel>Branch</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger></FormControl><SelectContent>{branches.map((branch) => <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="job_title" render={({ field }) => (
          <FormItem><FormLabel>Job title</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="department" render={({ field }) => (
          <FormItem><FormLabel>Department</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="employment_type" render={({ field }) => (
          <FormItem><FormLabel>Employment type</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="full_time">Full time</SelectItem><SelectItem value="part_time">Part time</SelectItem><SelectItem value="contract">Contract</SelectItem><SelectItem value="casual">Casual</SelectItem></SelectContent></Select><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="pay_frequency" render={({ field }) => (
          <FormItem><FormLabel>Pay frequency</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="fortnightly">Fortnightly</SelectItem><SelectItem value="weekly">Weekly</SelectItem><SelectItem value="hourly">Hourly</SelectItem></SelectContent></Select><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="base_salary" render={({ field }) => (
          <FormItem><FormLabel>Base pay</FormLabel><FormControl><Input type="number" min="0" step="0.01" inputMode="decimal" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="currency" render={({ field }) => (
          <FormItem><FormLabel>Currency</FormLabel><FormControl><Input className="uppercase" maxLength={3} {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="effective_from" render={({ field }) => (
          <FormItem><FormLabel>Effective from</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="effective_to" render={({ field }) => (
          <FormItem><FormLabel>Effective to</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem className="sm:col-span-2"><FormLabel>Reason or notes</FormLabel><FormControl><Textarea rows={2} placeholder="e.g. Promotion to supervisor" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <DialogFooter className="sm:col-span-2">
          <Button type="submit" disabled={isSaving}>{isSaving && <Loader2 className="animate-spin" />}Add employment term</Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

function EmployeeDetails({ employee, formatAmount }: { employee: Employee; formatAmount: (amount: string | number, currency?: string) => string }) {
  const term = employee.current_employment_term;
  return (
    <div className="space-y-5 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{employee.employee_code}</Badge>
        <Badge variant={statusVariant(employee.employment_status)}>{titleCase(employee.employment_status)}</Badge>
        {employee.staff_name && <Badge variant="secondary">Linked to {employee.staff_name}</Badge>}
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div><p className="text-muted-foreground">Contact</p><p className="font-medium">{employee.email || employee.phone || 'Not recorded'}</p></div>
        <div><p className="text-muted-foreground">Emergency contact</p><p className="font-medium">{employee.emergency_contact_name || 'Not recorded'}{employee.emergency_contact_phone ? `, ${employee.emergency_contact_phone}` : ''}</p></div>
        <div><p className="text-muted-foreground">Employment started</p><p className="font-medium">{employee.started_on ? format(new Date(`${employee.started_on}T00:00:00`), 'd MMM yyyy') : 'Not recorded'}</p></div>
        <div><p className="text-muted-foreground">Current role</p><p className="font-medium">{term?.job_title || 'Not recorded'}</p></div>
      </div>
      {term && (
        <div className="border-y py-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{term.job_title}</p>
              <p className="text-sm text-muted-foreground">{term.branch_name || 'Branch'}{term.department ? ` · ${term.department}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold">{formatAmount(term.base_salary, term.currency)}</p>
              <p className="text-xs text-muted-foreground">{titleCase(term.pay_frequency)}</p>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Employment history</h3><span className="text-xs text-muted-foreground">{employee.employment_terms.length} record{employee.employment_terms.length === 1 ? '' : 's'}</span></div>
        <div className="space-y-2">
          {employee.employment_terms.map((historyTerm) => (
            <div key={historyTerm.id} className="grid gap-1 border-b py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
              <div><p className="font-medium">{historyTerm.job_title}</p><p className="text-muted-foreground">{historyTerm.branch_name || 'Branch'} · {titleCase(historyTerm.employment_type)} · from {format(new Date(`${historyTerm.effective_from}T00:00:00`), 'd MMM yyyy')}</p></div>
              <p className="font-medium sm:text-right">{formatAmount(historyTerm.base_salary, historyTerm.currency)} / {historyTerm.pay_frequency}</p>
            </div>
          ))}
        </div>
      </div>
      {employee.notes && <div><p className="text-sm text-muted-foreground">Internal notes</p><p className="mt-1 text-sm">{employee.notes}</p></div>}
    </div>
  );
}

export default function PeoplePage() {
  const { user, business } = useAuth();
  const { accessCheck, isLoading: isLoadingAccess } = useSubscriptionFeatureAccess('staff_management');
  const { currencyCode } = useCurrency();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Employee['employment_status']>('all');
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [termEmployee, setTermEmployee] = useState<Employee | null>(null);
  const [isEmployeeFormOpen, setEmployeeFormOpen] = useState(false);

  const businessId = String(
    user?.businessId || business?.id || resolveOfflineBusinessId() || '',
  ).trim();
  const formatAmount = useCallback((amount: string | number, currency?: string) => {
    const parsed = Number(amount || 0);
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || currencyCode || 'MWK' }).format(parsed);
    } catch {
      return `${currency || currencyCode || 'MWK'} ${parsed.toFixed(2)}`;
    }
  }, [currencyCode]);

  const loadData = useCallback(async () => {
    if (!businessId || !accessCheck.allowed) {
      setEmployees([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [employeesResponse, branchesResponse, staffResponse] = await Promise.all([
        authFetch.fetch(`/hr/employees/?business_id=${encodeURIComponent(businessId)}`),
        authFetch.fetch('/business/branches/'),
        authFetch.fetch('/staff/'),
      ]);
      setEmployees(normalizeCollection<Employee>(employeesResponse));
      setBranches(normalizeCollection<Branch>(branchesResponse).map((branch: any) => ({ id: String(branch.id), name: String(branch.name || 'Branch') })));
      setStaff(normalizeCollection<StaffOption>(staffResponse).map((member: any) => ({ id: String(member.id), name: String(member.name || 'Staff member'), email: String(member.email || '') })));
    } catch (error) {
      console.error('[People] Failed to load employee data:', error);
      toast({
        title: 'Could not load people',
        description: error instanceof Error ? error.message : 'Please refresh and try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [accessCheck.allowed, businessId]);

  useEffect(() => {
    if (isLoadingAccess) return;
    void loadData();
  }, [isLoadingAccess, loadData]);

  const closeEmployeeForm = () => {
    setEmployeeFormOpen(false);
    setEditingEmployee(null);
  };
  const handleEmployeeSaved = async () => {
    closeEmployeeForm();
    await loadData();
  };
  const handleTermSaved = async () => {
    setTermEmployee(null);
    await loadData();
  };

  const displayEmployees = useMemo(() => employees.filter((employee) => {
    const haystack = `${employee.full_name} ${employee.employee_code} ${employee.email || ''} ${employee.current_employment_term?.job_title || ''}`.toLowerCase();
    return (statusFilter === 'all' || employee.employment_status === statusFilter) && haystack.includes(search.trim().toLowerCase());
  }), [employees, search, statusFilter]);
  const activeCount = employees.filter((employee) => employee.employment_status === 'active').length;
  const leaveCount = employees.filter((employee) => employee.employment_status === 'on_leave').length;
  const linkedAccountCount = employees.filter((employee) => employee.staff).length;

  if (isLoadingAccess) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }
  if (!accessCheck.allowed) {
    return (
      <div className="flex flex-col gap-6">
        <div><h1 className="text-2xl font-bold tracking-normal">People</h1><p className="text-muted-foreground">Manage employee profiles and employment records.</p></div>
        <SubscriptionFeatureDisabledCard featureName="staff_management" accessCheck={accessCheck} />
      </div>
    );
  }
  if (!businessId) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Select a business before managing employee records.</div>;
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-normal">People</h1>
          <p className="text-muted-foreground">Employee profiles, employment terms, and salary history.</p>
        </div>
        <Dialog open={isEmployeeFormOpen} onOpenChange={(open) => open ? setEmployeeFormOpen(true) : closeEmployeeForm()}>
          <DialogTrigger asChild><Button><UserRoundPlus /> Add employee</Button></DialogTrigger>
          <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader><DialogTitle>{editingEmployee ? 'Edit employee' : 'Add employee'}</DialogTitle><DialogDescription>{editingEmployee ? 'Update the employee profile. Employment changes are added separately to preserve history.' : 'Create an employee profile and their first employment term.'}</DialogDescription></DialogHeader>
            <EmployeeForm employee={editingEmployee} branches={branches} staff={staff} businessId={businessId} currencyCode={currencyCode} onSaved={() => void handleEmployeeSaved()} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Active employees</p><p className="mt-1 text-2xl font-semibold">{activeCount}</p></div><Users className="h-6 w-6 text-primary" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">On leave</p><p className="mt-1 text-2xl font-semibold">{leaveCount}</p></div><CalendarDays className="h-6 w-6 text-amber-600" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Linked app accounts</p><p className="mt-1 text-2xl font-semibold">{linkedAccountCount}</p></div><ShieldCheck className="h-6 w-6 text-emerald-600" /></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><CardTitle>Employees</CardTitle><CardDescription>Employment terms record changes in role, branch, and base pay over time.</CardDescription></div>
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search employee, code, role, or email" /></div>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}><SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="on_leave">On leave</SelectItem><SelectItem value="terminated">Terminated</SelectItem></SelectContent></Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Current role</TableHead><TableHead>Branch</TableHead><TableHead>Base pay</TableHead><TableHead>Status</TableHead><TableHead className="w-[52px] text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={6} className="h-28 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow> : displayEmployees.length ? displayEmployees.map((employee) => {
                  const term = employee.current_employment_term;
                  return <TableRow key={employee.id}><TableCell><div className="font-medium">{employee.full_name}</div><div className="text-xs text-muted-foreground">{employee.employee_code}{employee.email ? ` · ${employee.email}` : ''}</div></TableCell><TableCell>{term?.job_title || 'Not set'}</TableCell><TableCell>{term?.branch_name || 'Not set'}</TableCell><TableCell>{term ? formatAmount(term.base_salary, term.currency) : 'Not set'}</TableCell><TableCell><Badge variant={statusVariant(employee.employment_status)}>{titleCase(employee.employment_status)}</Badge></TableCell><TableCell className="text-right"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${employee.full_name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setSelectedEmployee(employee)}><Eye /> View profile</DropdownMenuItem><DropdownMenuItem onClick={() => { setEditingEmployee(employee); setEmployeeFormOpen(true); }}><Pencil /> Edit profile</DropdownMenuItem><DropdownMenuItem onClick={() => setTermEmployee(employee)}><BadgeDollarSign /> Add employment term</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell></TableRow>;
                }) : <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No employees match your filters.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-3 md:hidden">
            {isLoading ? <div className="flex h-28 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : displayEmployees.length ? displayEmployees.map((employee) => {
              const term = employee.current_employment_term;
              return <div key={employee.id} className="border-b pb-4 last:border-b-0"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold">{employee.full_name}</p><p className="text-sm text-muted-foreground">{employee.employee_code} · {term?.job_title || 'Role not set'}</p></div><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${employee.full_name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setSelectedEmployee(employee)}><Eye /> View profile</DropdownMenuItem><DropdownMenuItem onClick={() => { setEditingEmployee(employee); setEmployeeFormOpen(true); }}><Pencil /> Edit profile</DropdownMenuItem><DropdownMenuItem onClick={() => setTermEmployee(employee)}><BadgeDollarSign /> Add employment term</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><Badge variant={statusVariant(employee.employment_status)}>{titleCase(employee.employment_status)}</Badge><span className="text-sm font-medium">{term ? formatAmount(term.base_salary, term.currency) : 'Base pay not set'}</span></div></div>;
            }) : <div className="flex h-28 flex-col items-center justify-center text-center text-sm text-muted-foreground"><ContactRound className="mb-2 h-7 w-7 opacity-40" />No employees match your filters.</div>}
          </div>
        </CardContent>
      </Card>

      <PeopleOperationsPanel
        businessId={businessId}
        employees={employees.map((employee) => ({
          id: String(employee.id),
          full_name: employee.full_name,
          employee_code: employee.employee_code,
        }))}
        branches={branches}
      />

      <Dialog open={Boolean(selectedEmployee)} onOpenChange={(open) => !open && setSelectedEmployee(null)}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{selectedEmployee?.full_name}</DialogTitle><DialogDescription>Employee profile and employment history.</DialogDescription></DialogHeader>
          {selectedEmployee && <EmployeeDetails employee={selectedEmployee} formatAmount={formatAmount} />}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(termEmployee)} onOpenChange={(open) => !open && setTermEmployee(null)}>
        <DialogContent className="tauri-android-safe-bottom max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Add employment term</DialogTitle><DialogDescription>{termEmployee ? `Record a new role, branch, or pay basis for ${termEmployee.full_name}. The existing term remains in history.` : ''}</DialogDescription></DialogHeader>
          {termEmployee && <EmploymentTermForm employee={termEmployee} branches={branches} currencyCode={currencyCode} onSaved={() => void handleTermSaved()} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
