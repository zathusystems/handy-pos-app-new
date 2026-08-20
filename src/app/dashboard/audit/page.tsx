
'use client';

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { FileSearch, Loader2, UserCheck, Code } from 'lucide-react';

import { db, type AuditLog } from '@/lib/db';
import { useActiveBranch } from '@/hooks/use-active-branch';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';


const actionDisplay: Record<AuditLog['actionType'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    SESSION_START: { label: 'Session Start', variant: 'default' },
    SESSION_END: { label: 'Session End', variant: 'destructive' },
    ITEM_CREATE: { label: 'Item Create', variant: 'default' },
    ITEM_UPDATE: { label: 'Item Update', variant: 'secondary' },
    ITEM_DELETE: { label: 'Item Delete', variant: 'destructive' },
    ORDER_CREATE: { label: 'Order Create', variant: 'default' },
    ORDER_STATUS_UPDATE: { label: 'Order Update', variant: 'secondary' },
    ORDER_REFUND: { label: 'Order Refund', variant: 'destructive' },
    ORDER_VOID: { label: 'Order Void', variant: 'destructive' },
    STOCK_RECEIVE: { label: 'Stock Receive', variant: 'default' },
    STOCK_RECEIVE_UPDATE: { label: 'Stock Receive Update', variant: 'secondary' },
    STOCK_RECEIVE_DELETE: { label: 'Stock Receive Delete', variant: 'destructive' },
    STOCK_TRANSFER: { label: 'Stock Transfer', variant: 'secondary' },
    STOCK_WASTE: { label: 'Stock Waste', variant: 'destructive' },
    STOCK_AUDIT_SUBMIT: { label: 'Audit Submit', variant: 'secondary' },
    STOCK_AUDIT_APPROVE: { label: 'Audit Approve', variant: 'default' },
    STOCK_AUDIT_REJECT: { label: 'Audit Reject', variant: 'destructive' },
    EXPENSE_CREATE: { label: 'Expense Create', variant: 'default' },
    EXPENSE_APPROVE: { label: 'Expense Approve', variant: 'secondary' },
    EXPENSE_REJECT: { label: 'Expense Reject', variant: 'destructive' },
    STAFF_CREATE: { label: 'Staff Create', variant: 'default' },
    STAFF_UPDATE: { label: 'Staff Update', variant: 'secondary' },
    STAFF_DELETE: { label: 'Staff Delete', variant: 'destructive' },
    SUPPLIER_CREATE: { label: 'Supplier Create', variant: 'default' },
    SUPPLIER_UPDATE: { label: 'Supplier Update', variant: 'secondary' },
    SUPPLIER_DELETE: { label: 'Supplier Delete', variant: 'destructive' },
};


const DetailsDialog = ({ details, isOpen, onOpenChange }: { details: Record<string, any>, isOpen: boolean, onOpenChange: (open: boolean) => void }) => {
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Action Details</DialogTitle>
                </DialogHeader>
                <pre className="mt-2 w-full overflow-y-auto rounded-lg bg-muted p-4">
                    <code>{JSON.stringify(details, null, 2)}</code>
                </pre>
            </DialogContent>
        </Dialog>
    );
};

export default function AuditLogPage() {
    const [selectedDetails, setSelectedDetails] = useState<Record<string, any> | null>(null);
    const activeBranchId = useActiveBranch();

    const auditLog = useLiveQuery(
        () => {
            if (!activeBranchId) return [];
            return db.auditLog.where({ branchId: activeBranchId }).reverse().sortBy('timestamp');
        },
        [activeBranchId]
    );

    if (!activeBranchId) {
        return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin" /></div>;
    }

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2"><UserCheck /> Audit Log</CardTitle>
                    <CardDescription>A chronological record of all significant actions taken in the system for this branch.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Timestamp</TableHead>
                                <TableHead>User</TableHead>
                                <TableHead>Action</TableHead>
                                <TableHead>Entity</TableHead>
                                <TableHead className="text-right">Details</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {auditLog && auditLog.length > 0 ? (
                                auditLog.map(log => (
                                    <TableRow key={log.id}>
                                        <TableCell>{format(new Date(log.timestamp), 'PPpp')}</TableCell>
                                        <TableCell>{log.userName}</TableCell>
                                        <TableCell>
                                            <Badge variant={actionDisplay[log.actionType]?.variant || 'secondary'}>
                                                {actionDisplay[log.actionType]?.label || log.actionType}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <p className="font-mono text-xs">{log.entityType}</p>
                                            <p className="font-mono text-xs text-muted-foreground">{log.entityId}</p>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {Object.keys(log.details).length > 0 && (
                                                <Button variant="ghost" size="sm" onClick={() => setSelectedDetails(log.details)}>
                                                    <Code className="mr-2 h-4 w-4" /> View
                                                </Button>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={5} className="h-48 text-center">
                                        <div className="flex flex-col items-center justify-center space-y-3">
                                            <FileSearch className="h-12 w-12 text-muted-foreground/30" />
                                            <p>No audit records found for this branch yet.</p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
            {selectedDetails && (
                <DetailsDialog
                    details={selectedDetails}
                    isOpen={!!selectedDetails}
                    onOpenChange={() => setSelectedDetails(null)}
                />
            )}
        </>
    );
}
