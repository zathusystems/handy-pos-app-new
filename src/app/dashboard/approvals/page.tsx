
'use client';

import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { Check, X, ShieldCheck, Loader2, Info, ChevronDown, ChevronUp, FileText, CreditCard } from 'lucide-react';

import { db, type StockTake, type Expense, type Invoice } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch',
};

const StockAuditApprovalItem = ({ audit }: { audit: StockTake }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { format: formatCurrency } = useCurrency();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConfirming, setIsConfirming] = useState<'approve' | 'reject' | null>(null);

  const handleApprove = async () => {
    if (!user) return;
    setIsProcessing(true);

    try {
        await db.transaction('rw', db.inventory, db.stockTakes, async () => {
            for (const item of audit.items) {
                const countedStock = Number(item.countedStock);
                const inventoryItem = await db.inventory.get(item.itemId);
                if (inventoryItem) {
                    await db.inventory.update(item.itemId, {
                        stockUnits: countedStock,
                        value: countedStock * (inventoryItem.cost || 0),
                    });
                }
            }
            await db.stockTakes.update(audit.id, {
                status: 'Approved',
                approvedBy: user.displayName || user.email,
                approvedAt: new Date().toISOString(),
            });
        });

      toast({
        title: 'Audit Approved',
        description: `Stock levels have been updated based on audit ${audit.id}.`,
      });
    } catch (error) {
      console.error('Failed to approve audit:', error);
      toast({ variant: 'destructive', title: 'Approval Failed' });
    } finally {
      setIsProcessing(false);
      setIsConfirming(null);
    }
  };

  const handleReject = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      await db.stockTakes.update(audit.id, {
        status: 'Rejected',
        approvedBy: user.displayName || user.email,
        approvedAt: new Date().toISOString(),
      });
      toast({ title: 'Audit Rejected', variant: 'destructive' });
    } catch (error) {
      console.error('Failed to reject audit:', error);
      toast({ variant: 'destructive', title: 'Rejection Failed' });
    } finally {
      setIsProcessing(false);
      setIsConfirming(null);
    }
  };
  
  const discrepancyColor = audit.totalDiscrepancyValue > 0 ? 'text-green-600' : 'text-red-600';
  const discrepancySign = audit.totalDiscrepancyValue > 0 ? '+' : '';

  return (
    <>
      <AccordionItem value={audit.id}>
        <AccordionTrigger>
          <div className="flex w-full items-center justify-between pr-4">
            <div className="grid text-left">
              <span className="font-semibold">Stock Audit - {format(new Date(audit.createdAt), 'PP')}</span>
              <span className="text-sm text-muted-foreground">
                Submitted by {audit.createdBy}
              </span>
            </div>
            <div className="hidden sm:block text-right">
                <p className="text-sm">Discrepancy</p>
                <p className={cn("font-semibold", discrepancyColor)}>{discrepancySign}{formatCurrency(audit.totalDiscrepancyValue)}</p>
            </div>
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">System</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Discrepancy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.items.map((item) => (
                  <TableRow key={item.itemId} className={cn(item.discrepancy !== 0 && "bg-muted/50")}>
                    <TableCell>{item.itemName}</TableCell>
                    <TableCell className="text-right">{item.systemStock}</TableCell>
                    <TableCell className="text-right">{item.countedStock}</TableCell>
                    <TableCell className="text-right">
                         <Badge variant={item.discrepancy === 0 ? 'secondary' : (item.discrepancy > 0 ? 'default' : 'destructive')} className={item.discrepancy > 0 ? 'bg-green-600' : ''}>
                            {item.discrepancy > 0 ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
                            {item.discrepancy > 0 ? '+' : ''}{item.discrepancy}
                        </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2 p-4 border-t">
              <Button variant="outline" onClick={() => setIsConfirming('reject')}>Reject</Button>
              <Button onClick={() => setIsConfirming('approve')}>Approve</Button>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
      
      {isConfirming && (
         <Dialog open={!!isConfirming} onOpenChange={() => setIsConfirming(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Confirm {isConfirming === 'approve' ? 'Approval' : 'Rejection'}</DialogTitle>
                    <DialogDescription>
                        {isConfirming === 'approve' ? 
                         'Approving this audit will permanently update your inventory levels. This action cannot be undone.' :
                         'Are you sure you want to reject this audit? It will need to be resubmitted.'
                        }
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => setIsConfirming(null)} disabled={isProcessing}>Cancel</Button>
                    <Button 
                        variant={isConfirming === 'approve' ? 'default' : 'destructive'} 
                        onClick={isConfirming === 'approve' ? handleApprove : handleReject}
                        disabled={isProcessing}
                    >
                         {isProcessing ? <Loader2 className="mr-2 animate-spin" /> : (isConfirming === 'approve' ? <Check className="mr-2" /> : <X className="mr-2" />)}
                        Confirm {isConfirming === 'approve' ? 'Approval' : 'Rejection'}
                    </Button>
                </DialogFooter>
            </DialogContent>
         </Dialog>
      )}
    </>
  );
};


const ExpenseApprovalItem = ({ expense }: { expense: Expense }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { format: formatCurrency } = useCurrency();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleApprove = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      await db.expenses.update(expense.id, {
        status: 'Approved',
        approvedBy: user.displayName || user.email,
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        _dirty: true,
        _operation: 'update',
      });
      toast({ title: 'Expense Approved' });
    } catch (error) {
      console.error('Failed to approve expense:', error);
      toast({ variant: 'destructive', title: 'Approval Failed' });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      await db.expenses.update(expense.id, {
        status: 'Rejected',
        approvedBy: user.displayName || user.email,
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        _dirty: true,
        _operation: 'update',
      });
      toast({ title: 'Expense Rejected', variant: 'destructive' });
    } catch (error) {
      console.error('Failed to reject expense:', error);
      toast({ variant: 'destructive', title: 'Rejection Failed' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{expense.title}</div>
        <div className="text-sm text-muted-foreground">{expense.category}</div>
      </TableCell>
      <TableCell>{format(new Date(expense.date), 'PP')}</TableCell>
      <TableCell className="text-right font-semibold">{formatCurrency(expense.amount)}</TableCell>
      <TableCell>{expense.createdBy}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleReject} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <X className="h-4 w-4" />}
          </Button>
          <Button size="sm" onClick={handleApprove} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <Check className="h-4 w-4" />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
};


const InvoiceApprovalItem = ({ invoice }: { invoice: Invoice }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { format: formatCurrency } = useCurrency();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleApprove = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      await db.invoices.update(invoice.id, {
        status: 'Sent',
      });
      toast({ title: 'Invoice Sent' });
    } catch (error) {
      console.error('Failed to send invoice:', error);
      toast({ variant: 'destructive', title: 'Action Failed' });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      await db.invoices.update(invoice.id, {
        status: 'Void',
      });
      toast({ title: 'Invoice Voided', variant: 'destructive' });
    } catch (error) {
      console.error('Failed to void invoice:', error);
      toast({ variant: 'destructive', title: 'Action Failed' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">Invoice #{invoice.invoiceNumber}</div>
        <div className="text-sm text-muted-foreground">{invoice.customerName}</div>
      </TableCell>
      <TableCell>{format(new Date(invoice.issueDate), 'PP')}</TableCell>
      <TableCell className="text-right font-semibold">{formatCurrency(invoice.total)}</TableCell>
      <TableCell>{format(new Date(invoice.dueDate), 'PP')}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleReject} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <X className="h-4 w-4" />}
          </Button>
          <Button size="sm" onClick={handleApprove} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <Check className="h-4 w-4" />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
};


export default function ApprovalsPage() {
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  
  useEffect(() => {
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) setActiveBranchId(branchId);
  }, []);

  const pendingAudits = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.stockTakes
        .where({ branchId: activeBranchId, status: 'Pending Approval' })
        .sortBy('createdAt')
    },
    [activeBranchId]
  ) || [];

  const pendingExpenses = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.expenses
        .where({ branchId: activeBranchId, status: 'Pending' })
        .sortBy('date')
    },
    [activeBranchId]
  ) || [];

  const pendingInvoices = useLiveQuery(
    () => {
      if (!activeBranchId) return [];
      return db.invoices
        .where({ branchId: activeBranchId, status: 'Draft' })
        .sortBy('issueDate')
    },
    [activeBranchId]
  ) || [];
  
  if (!activeBranchId) {
    return (
        <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approval Requests</h1>
        <p className="text-muted-foreground">
          Review and approve or reject submissions from your team.
        </p>
      </div>

      <Tabs defaultValue="stock-audits">
        <TabsList>
            <TabsTrigger value="stock-audits">
                Stock Audits
                {pendingAudits.length > 0 && <Badge className="ml-2">{pendingAudits.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="expenses">
                Expenses
                {pendingExpenses.length > 0 && <Badge className="ml-2">{pendingExpenses.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="invoices">
                Invoices
                {pendingInvoices.length > 0 && <Badge className="ml-2">{pendingInvoices.length}</Badge>}
            </TabsTrigger>
        </TabsList>
        <TabsContent value="stock-audits">
            <Card>
                <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <FileText />
                    Pending Stock Audits
                </CardTitle>
                <CardDescription>
                    These stock audits are waiting for your approval before inventory levels are updated.
                </CardDescription>
                </CardHeader>
                <CardContent>
                {pendingAudits.length > 0 ? (
                    <Accordion type="multiple" className="w-full">
                    {pendingAudits.map((audit) => (
                        <StockAuditApprovalItem key={audit.id} audit={audit} />
                    ))}
                    </Accordion>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center">
                    <ShieldCheck className="h-12 w-12 text-muted-foreground" />
                    <h2 className="text-xl font-semibold">All Clear!</h2>
                    <p className="text-muted-foreground">
                        There are no pending stock audits that require your approval.
                    </p>
                    </div>
                )}
                </CardContent>
            </Card>
        </TabsContent>
         <TabsContent value="expenses">
            <Card>
                <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <CreditCard />
                    Pending Expenses
                </CardTitle>
                <CardDescription>
                    Approve or reject these expenses submitted by your team. Approved expenses will be reflected in financial reports.
                </CardDescription>
                </CardHeader>
                <CardContent>
                {pendingExpenses.length > 0 ? (
                   <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Expense</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Submitted By</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                        {pendingExpenses.map(expense => (
                            <ExpenseApprovalItem key={expense.id} expense={expense} />
                        ))}
                    </TableBody>
                   </Table>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center">
                    <ShieldCheck className="h-12 w-12 text-muted-foreground" />
                    <h2 className="text-xl font-semibold">All Clear!</h2>
                    <p className="text-muted-foreground">
                        There are no pending expenses that require your approval.
                    </p>
                    </div>
                )}
                </CardContent>
            </Card>
        </TabsContent>
        <TabsContent value="invoices">
            <Card>
                <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <FileText />
                    Draft Invoices
                </CardTitle>
                <CardDescription>
                    Send or void these draft invoices. Sent invoices will be marked as sent and can be tracked for payment.
                </CardDescription>
                </CardHeader>
                <CardContent>
                {pendingInvoices.length > 0 ? (
                   <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead>Issue Date</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead>Due Date</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                        {pendingInvoices.map(invoice => (
                            <InvoiceApprovalItem key={invoice.id} invoice={invoice} />
                        ))}
                    </TableBody>
                   </Table>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center">
                    <ShieldCheck className="h-12 w-12 text-muted-foreground" />
                    <h2 className="text-xl font-semibold">All Clear!</h2>
                    <p className="text-muted-foreground">
                        There are no draft invoices that require your attention.
                    </p>
                    </div>
                )}
                </CardContent>
            </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
