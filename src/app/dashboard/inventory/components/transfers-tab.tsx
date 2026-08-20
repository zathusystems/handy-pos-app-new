
'use client';

import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Repeat, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import { db, type StockTransfer } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/hooks/use-toast';
import { syncService } from '@/lib/services/sync-service';
import { PaginationControls, usePaginatedItems } from './pagination-controls';

interface TransfersTabProps {
    stockTransfersData: StockTransfer[];
    isMobile: boolean;
    searchTerm: string;
    onTransferStock: () => void;
    branchId: string;
}

export function TransfersTab({ stockTransfersData, isMobile, searchTerm, onTransferStock, branchId }: TransfersTabProps) {
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
    const [pendingChanges, setPendingChanges] = useState(0);
    const normalizedSearchTerm = searchTerm.trim().toLowerCase();

    const filteredTransfersData = React.useMemo(() => {
        if (!normalizedSearchTerm) return stockTransfersData || [];

        return (stockTransfersData || []).filter((transfer) =>
            [
                transfer.itemName,
                transfer.fromBranchName,
                transfer.toBranchName,
                transfer.initiatedBy,
                transfer.quantity,
            ].some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm))
        );
    }, [normalizedSearchTerm, stockTransfersData]);

    const {
        setCurrentPage,
        totalItems,
        totalPages,
        effectiveCurrentPage,
        pageStartIndex,
        pageEndIndex,
        paginatedItems: paginatedTransfersData,
    } = usePaginatedItems(filteredTransfersData);

    React.useEffect(() => {
        setCurrentPage(1);
    }, [normalizedSearchTerm, setCurrentPage]);

    // Count pending changes for this branch
    useEffect(() => {
        const countPendingChanges = async () => {
            try {
                const dirtyRecords = await db.stockTransfers
                    .where('fromBranchId')
                    .equals(branchId)
                    .toArray()
                    .then(records => records.filter(r => r._dirty));
                setPendingChanges(dirtyRecords.length);
            } catch (error) {
                console.error('[Transfers] Error counting pending changes:', error);
            }
        };

        countPendingChanges();
        const interval = setInterval(countPendingChanges, 5000); // Check every 5 seconds
        return () => clearInterval(interval);
    }, [branchId]);

    const handleSyncNow = async () => {
        setSyncStatus('syncing');
        try {
            await syncService.performFullSync(branchId);
            setSyncStatus('synced');
            toast({
                title: 'Sync Complete',
                description: 'Stock transfers synced with backend',
            });
            setTimeout(() => setSyncStatus('idle'), 3000);
        } catch (error) {
            setSyncStatus('error');
            toast({
                variant: 'destructive',
                title: 'Sync Failed',
                description: 'Failed to sync stock transfers',
            });
            setTimeout(() => setSyncStatus('idle'), 3000);
        }
    };

    return (
        <CardContent>
            <div className="mb-6 flex flex-wrap items-center gap-2">
                <Button onClick={onTransferStock}>
                    <Repeat className="mr-2 h-4 w-4" /> Transfer Stock
                </Button>
                <Button
                    onClick={handleSyncNow}
                    disabled={syncStatus === 'syncing'}
                    variant={pendingChanges > 0 ? 'default' : 'outline'}
                    size="sm"
                    title="Sync transfers with backend"
                >
                    {syncStatus === 'syncing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {syncStatus === 'synced' && <CheckCircle2 className="mr-2 h-4 w-4 text-green-600" />}
                    {syncStatus === 'error' && <AlertCircle className="mr-2 h-4 w-4 text-red-600" />}
                    Sync
                </Button>
                {pendingChanges > 0 && (
                    <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
                        {pendingChanges} pending
                    </span>
                )}
            </div>
            {isMobile ? (
                filteredTransfersData.length > 0 ? (
                <div className="space-y-3">
                    {paginatedTransfersData.map((transfer) => (
                        <div key={transfer.id} className="mobile-data-card rounded-lg border bg-card p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="font-semibold leading-tight">{transfer.itemName}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {format(new Date(transfer.createdAt), 'PPpp')}
                                    </p>
                                </div>
                                <p className="text-sm font-semibold">{transfer.quantity}</p>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                <div>
                                    <p className="text-xs text-muted-foreground">From</p>
                                    <p className="font-medium">{transfer.fromBranchName}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">To</p>
                                    <p className="font-medium">{transfer.toBranchName}</p>
                                </div>
                                <div className="col-span-2">
                                    <p className="text-xs text-muted-foreground">Initiated By</p>
                                    <p>{transfer.initiatedBy}</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                        {normalizedSearchTerm ? `No transfers match "${searchTerm.trim()}".` : 'No stock transfers have been recorded.'}
                    </div>
                )
            ) : (
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Item</TableHead>
                                <TableHead className="text-right">Quantity</TableHead>
                                <TableHead>From</TableHead>
                                <TableHead>To</TableHead>
                                <TableHead>Initiated By</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredTransfersData.length > 0 ? paginatedTransfersData.map((transfer) => (
                                <TableRow key={transfer.id}>
                                    <TableCell>{format(new Date(transfer.createdAt), 'PPpp')}</TableCell>
                                    <TableCell className="font-medium">{transfer.itemName}</TableCell>
                                    <TableCell className="text-right">{transfer.quantity}</TableCell>
                                    <TableCell>{transfer.fromBranchName}</TableCell>
                                    <TableCell>{transfer.toBranchName}</TableCell>
                                    <TableCell>{transfer.initiatedBy}</TableCell>
                                </TableRow>
                            )) : (
                                <TableRow>
                                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                                        {normalizedSearchTerm ? `No transfers match "${searchTerm.trim()}".` : 'No stock transfers have been recorded.'}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            )}
            <PaginationControls
                currentPage={effectiveCurrentPage}
                totalItems={totalItems}
                totalPages={totalPages}
                pageStartIndex={pageStartIndex}
                pageEndIndex={pageEndIndex}
                onPageChange={setCurrentPage}
                itemLabel="transfers"
            />
        </CardContent>
    );
}
