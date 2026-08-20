
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm } from 'react-hook-form';
import {
  PlusCircle,
  MoreHorizontal,
  Edit,
  Trash2,
  Calendar as CalendarIcon,
  BarChart2,
  PieChart,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { format } from 'date-fns';

import { db, type Expense } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { SubscriptionFeatureDisabledCard } from '@/components/subscription-feature-disabled-card';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch',
};

const expenseCategories = [
  'Utilities',
  'Rent',
  'Salaries',
  'Supplies',
  'Marketing',
  'Maintenance',
  'Other',
] as const;

type ExpenseFormValues = {
  title: string;
  category: (typeof expenseCategories)[number];
  amount: number;
  date: Date;
  notes?: string;
};

const ExpenseForm = ({
  onFormSubmit,
  defaultValues,
  onExpenseCreated,
}: {
  onFormSubmit: () => void;
  defaultValues?: Partial<Expense> & { date?: Date };
  onExpenseCreated?: () => void;
}) => {
  const [activeBranchId, setActiveBranchId] = useState('main');
  const { user } = useAuth();

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  const form = useForm<ExpenseFormValues>({
    defaultValues: {
      ...defaultValues,
      date: defaultValues?.date || new Date(),
    },
  });

  const onSubmit = async (data: ExpenseFormValues) => {
    if (!user) {
        toast({ variant: 'destructive', title: 'Error', description: 'You must be logged in to create an expense.' });
        return;
    }
    
    // Extract numeric branch ID from format like "BRN-10" -> 10
    const branchIdMatch = activeBranchId.match(/\d+/);
    const branchIdInt = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(activeBranchId, 10);
    
    const expenseData: Omit<Expense, 'id'> = {
      branchId: activeBranchId,
      title: data.title,
      category: data.category,
      amount: data.amount,
      date: data.date.toISOString(),
      notes: data.notes,
      status: defaultValues?.status ?? 'Approved',
      createdBy: user.displayName || user.email,
    };

    try {
      if (defaultValues?.id) {
        // Update existing expense
        console.log('[Expenses] Updating expense:', defaultValues.id);
        
        // Update backend first
        try {
          await authFetch.fetch(`/business/expenses/${defaultValues.id}/`, {
            method: 'PATCH',
            body: JSON.stringify({
              title: data.title,
              category: data.category,
              amount: data.amount,
              date: data.date.toISOString(),
              notes: data.notes,
              branch: branchIdInt,
            }),
          });
          console.log('[Expenses] ✓ Updated expense in backend:', defaultValues.id);
        } catch (backendError) {
          console.warn('[Expenses] Failed to update in backend:', backendError);
        }
        
        // Update local DB
        await db.expenses.update(defaultValues.id, expenseData);
        toast({ title: 'Expense Updated', description: 'Your changes have been saved.' });
      } else {
        // Create new expense
        console.log('[Expenses] Creating new expense for branch:', activeBranchId);
        
        // Save to backend first (backend will generate the ID)
        try {
          const backendResponse = await authFetch.fetch<any>('/business/expenses/', {
            method: 'POST',
            body: JSON.stringify({
              title: data.title,
              category: data.category,
              amount: data.amount,
              date: data.date.toISOString(),
              notes: data.notes,
              branch: branchIdInt,
            }),
          });
          console.log('[Expenses] ✓ Created expense in backend:', backendResponse?.id);
          
          // Use backend-generated ID
          const backendId = String(backendResponse?.id);
          if (!backendId) {
            throw new Error('Backend did not return an expense ID');
          }
          
          const expenseWithId = { ...expenseData, id: backendId } as Expense;
          
          // Save to local DB with backend ID
          await db.expenses.add(expenseWithId);
          toast({ title: 'Expense Added', description: 'Expense saved successfully.' });
          
          // Trigger refresh to fetch latest data from backend
          if (onExpenseCreated) {
            onExpenseCreated();
          }
        } catch (backendError) {
          console.error('[Expenses] Failed to create in backend:', backendError);
          toast({
            variant: 'destructive',
            title: 'Error creating expense',
            description: backendError instanceof Error ? backendError.message : 'Failed to create expense on server',
          });
        }
      }
      onFormSubmit();
      form.reset();
    } catch (error) {
      console.error('[Expenses] Failed to save expense:', error);
      toast({
        variant: 'destructive',
        title: 'Error saving expense',
        description: error instanceof Error ? error.message : 'An unknown error occurred',
      });
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 py-4">
        <FormField
          control={form.control}
          name="title"
          rules={{ required: true }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Monthly Electricity Bill" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="amount"
            rules={{ required: true, min: 0.01 }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    {...field}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="category"
            rules={{ required: true }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a category" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {expenseCategories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Date of Expense</FormLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      variant={'outline'}
                      className={cn(
                        'w-full pl-3 text-left font-normal',
                        !field.value && 'text-muted-foreground'
                      )}
                    >
                      {field.value ? (
                        format(field.value, 'PPP')
                      ) : (
                        <span>Pick a date</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={field.value}
                    onSelect={field.onChange}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (Optional)</FormLabel>
              <FormControl>
                <Textarea placeholder="Add any relevant details..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="submit">
            {defaultValues?.id ? 'Save Changes' : 'Submit for Approval'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
};

export default function ExpensesPage() {
  const { accessCheck, isLoading: isLoadingAccess } = useSubscriptionFeatureAccess('expense_management');
  const [isFormOpen, setFormOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | undefined>(undefined);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [isLoadingExpenses, setIsLoadingExpenses] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const { user } = useAuth();
  const { format: formatCurrency } = useCurrency();

  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  // Fetch expenses from backend first, then fallback to local DB
  useEffect(() => {
    if (isLoadingAccess) {
      return;
    }

    if (!accessCheck.allowed) {
      setIsLoadingExpenses(false);
      return;
    }

    const fetchExpensesFromBackend = async () => {
      if (!activeBranchId) {
        setIsLoadingExpenses(false);
        return;
      }

      setIsLoadingExpenses(true);
      try {
        // Extract numeric branch ID from format like "BRN-10" -> 10
        const branchIdMatch = activeBranchId.match(/\d+/);
        const branchIdInt = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(activeBranchId, 10);

        console.log('[Expenses] Fetching expenses from backend for branch:', branchIdInt);
        const response = await authFetch.fetch<any>(`/business/expenses/?branch=${branchIdInt}`);
        
        // Handle paginated or direct response
        const expensesData = response?.results || response?.data || response || [];
        
        if (Array.isArray(expensesData) && expensesData.length > 0) {
          console.log('[Expenses] Fetched', expensesData.length, 'expenses from backend');
          
          // Map backend expenses to frontend format and sync to local DB
          const mappedExpenses: Expense[] = expensesData.map((e: any) => ({
            id: String(e.id),
            branchId: activeBranchId,
            title: e.title || '',
            category: e.category || 'Other',
            amount: parseFloat(e.amount || 0),
            date: e.date || new Date().toISOString(),
            notes: e.notes || '',
            status: e.status || 'Pending',
            createdBy: e.created_by || e.createdBy || 'Unknown',
          }));
          
          // Sync to local DB
          await db.expenses.clear();
          await db.expenses.bulkAdd(mappedExpenses);
          console.log('[Expenses] ✓ Synced', mappedExpenses.length, 'expenses to local DB');
        } else {
          console.log('[Expenses] No expenses found from backend, clearing local DB');
          // Backend has no data, clear the frontend to stay in sync
          await db.expenses.clear();
        }
      } catch (error) {
        console.error('[Expenses] Error fetching expenses from backend:', error);
        // Fallback to local DB - don't clear it
        try {
          const localExpenses = await db.expenses.where({ branchId: activeBranchId }).toArray();
          console.log('[Expenses] Falling back to local DB with', localExpenses.length, 'expenses');
        } catch (localError) {
          console.error('[Expenses] Error loading from local DB:', localError);
        }
      } finally {
        setIsLoadingExpenses(false);
      }
    };

    fetchExpensesFromBackend();
  }, [accessCheck.allowed, activeBranchId, isLoadingAccess, refreshTrigger]);

  const expenses = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.expenses.where({ branchId: activeBranchId }).reverse().sortBy('date')
    },
    [activeBranchId]
  ) || [];

  const handleEdit = (expense: Expense) => {
    setEditingExpense(expense);
    setFormOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this expense?')) {
      await db.expenses.delete(id);
      toast({ title: 'Expense deleted', variant: 'destructive' });
    }
  };

  const handleFormOpenChange = (open: boolean) => {
    setFormOpen(open);
    if (!open) {
      setEditingExpense(undefined);
    }
  };
  
  const { totalExpenses, categoryBreakdown } = useMemo(() => {
    const approvedExpenses = expenses.filter(exp => exp.status === 'Approved');
    const total = approvedExpenses.reduce((acc, exp) => acc + exp.amount, 0);
    const breakdown = approvedExpenses.reduce((acc, exp) => {
        acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
        return acc;
    }, {} as Record<Expense['category'], number>);
    return { totalExpenses: total, categoryBreakdown: breakdown };
  }, [expenses]);
  
  const statusBadge: Record<Expense['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    Pending: 'outline',
    Approved: 'default',
    Rejected: 'destructive',
  };
   const statusIcon: Record<Expense['status'], React.ElementType> = {
    Pending: Clock,
    Approved: CheckCircle,
    Rejected: XCircle,
  };

  if (isLoadingAccess) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!accessCheck.allowed) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Expense Management</h1>
          <p className="text-muted-foreground">
            Track and categorize all your business expenditures.
          </p>
        </div>
        <SubscriptionFeatureDisabledCard
          featureName="expense_management"
          accessCheck={accessCheck}
        />
      </div>
    );
  }

  if (!activeBranchId) {
    return (
        <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Expense Management</h1>
          <p className="text-muted-foreground">
            Track and categorize all your business expenditures.
          </p>
        </div>
        <Dialog open={isFormOpen} onOpenChange={handleFormOpenChange}>
          <DialogTrigger asChild>
            <Button>
              <PlusCircle className="mr-2 h-4 w-4" /> Add Expense
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingExpense ? 'Edit Expense' : 'Add New Expense'}
              </DialogTitle>
              <DialogDescription>
                {editingExpense
                  ? 'Update the details for this expense.'
                  : 'Record a new business expense.'}
              </DialogDescription>
            </DialogHeader>
            <ExpenseForm
              onFormSubmit={() => handleFormOpenChange(false)}
              defaultValues={editingExpense ? { ...editingExpense, date: new Date(editingExpense.date) } : {}}
              onExpenseCreated={() => setRefreshTrigger(prev => prev + 1)}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Approved Expenses (All Time)</CardTitle>
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                  <div className="text-2xl font-bold">{formatCurrency(totalExpenses)}</div>
              </CardContent>
          </Card>
           <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Breakdown by Category (Approved)</CardTitle>
                  <PieChart className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm pt-2">
                      {Object.entries(categoryBreakdown).sort(([, a], [, b]) => b - a).map(([cat, amount]) => (
                           <div key={cat}>
                               <span className="font-semibold">{cat}:</span>
                               <span className="text-muted-foreground ml-1">{formatCurrency(amount)}</span>
                           </div>
                      ))}
                  </div>
              </CardContent>
          </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expense History</CardTitle>
          <CardDescription>
            A chronological list of all recorded expenses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[50px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.length > 0 ? (
                expenses.map((exp) => {
                    const Icon = statusIcon[exp.status];
                    return(
                  <TableRow key={exp.id}>
                    <TableCell>{format(new Date(exp.date), 'PP')}</TableCell>
                    <TableCell className="font-medium">{exp.title}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{exp.category}</Badge>
                    </TableCell>
                    <TableCell>
                        <Badge variant={statusBadge[exp.status]}>
                           <Icon className="mr-1 h-3 w-3" /> {exp.status}
                        </Badge>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCurrency(exp.amount)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(exp)} disabled={exp.status !== 'Pending'}>
                            <Edit className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => handleDelete(exp.id)}
                            disabled={exp.status !== 'Pending'}
                          >
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                    )
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    No expenses found. Click "Add Expense" to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
