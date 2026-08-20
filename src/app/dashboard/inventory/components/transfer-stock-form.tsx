
'use client';

import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { format } from 'date-fns';

import { db, type InventoryItem, type StockTransfer, type PurchaseRecord } from '@/lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { logAuditAction } from '@/lib/audit';
import { syncService } from '@/lib/services/sync-service';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Branch = { id: string; name: string; address: string; };

type TransferFormValues = {
    itemId: string;
    batchId: number;
    quantity: number;
    toBranchId: string;
};

export const TransferStockForm = ({
  branchId,
  branches,
  inventoryItems,
  onFormSubmit,
}: {
  branchId: string;
  branches: Branch[];
  inventoryItems: InventoryItem[];
  onFormSubmit: () => void;
}) => {
    const { user } = useAuth();
    const { format: formatCurrency } = useCurrency();
    const formMethods = useForm<TransferFormValues>();
    const { handleSubmit, control, watch, setValue, formState: { errors } } = formMethods;
    
    const selectedItemId = watch("itemId");
    const selectedItem = inventoryItems.find(item => item.id === selectedItemId);

    const batches = useLiveQuery(
        () => {
            if (!selectedItemId || !branchId) return [];
            return db.purchaseHistory
                .where({ branchId: branchId, productId: selectedItemId })
                .and(batch => batch.quantityRemaining > 0)
                .toArray();
        },
        [selectedItemId, branchId]
    );

    const selectedBatchId = watch("batchId");
    const selectedBatch = batches?.find(b => b.id === selectedBatchId);

    const onSubmit = async (data: TransferFormValues) => {
        if (!selectedItem) {
            toast({ variant: 'destructive', title: 'Invalid item selected.' });
            return;
        }

        if (!selectedBatch) {
            toast({ variant: 'destructive', title: 'Invalid batch selected.' });
            return;
        }

        if (!user) {
            toast({ variant: 'destructive', title: 'User not found' });
            return;
        }

        const quantity = Number(data.quantity);
        if (quantity > selectedBatch.quantityRemaining) {
            toast({ variant: 'destructive', title: 'Not enough stock in batch', description: `Only ${selectedBatch.quantityRemaining} units available in this batch.` });
            return;
        }

        const fromBranch = branches.find(b => b.id === branchId);
        const toBranch = branches.find(b => b.id === data.toBranchId);

        if (!fromBranch || !toBranch) {
            toast({ variant: 'destructive', title: 'Invalid branch selection.' });
            return;
        }

        try {
            let transferId = '';
            let destinationItemId = '';

            await db.transaction('rw', db.inventory, db.stockTransfers, db.purchaseHistory, async () => {
                // 1. Decrement batch quantity with sync flags
                await db.purchaseHistory.update(selectedBatch.id!, {
                    quantityRemaining: selectedBatch.quantityRemaining - quantity,
                    _dirty: true,
                    _operation: 'update'
                });
                console.log('[Transfers] Decremented batch quantity');

                // 2. Decrement main inventory item's total stock with sync flags
                const newStock = (selectedItem.stockUnits || 0) - quantity;
                await db.inventory.update(selectedItem.id, {
                    stockUnits: newStock,
                    _dirty: true,
                    _operation: 'update'
                });
                console.log('[Transfers] Decremented source branch stock');

                // 3. Find and increment stock at destination branch (or create if not exists)
                const destinationItem = await db.inventory.where({ branchId: data.toBranchId, name: selectedItem.name }).first();
                
                if (destinationItem) {
                    await db.inventory.update(destinationItem.id, {
                        stockUnits: (destinationItem.stockUnits || 0) + quantity,
                        _dirty: true,
                        _operation: 'update'
                    });
                    destinationItemId = destinationItem.id;
                    console.log('[Transfers] Incremented destination branch stock for existing item');
                } else {
                    // Item doesn't exist at destination, so create it with sync flags
                    const newItem = { 
                        ...selectedItem, 
                        id: `${selectedItem.name.replace(/\s+/g, '')}-${data.toBranchId}`, 
                        branchId: data.toBranchId, 
                        stockUnits: quantity,
                        _dirty: true,
                        _operation: 'create' as const
                    };
                    await db.inventory.add(newItem);
                    destinationItemId = newItem.id;
                    console.log('[Transfers] Created new item at destination branch');
                }

                // 4. Create transfer record with sync flags
                const transferRecord: StockTransfer = {
                    id: `TXF-${Date.now()}`,
                    fromBranchId: branchId,
                    fromBranchName: fromBranch.name,
                    toBranchId: data.toBranchId,
                    toBranchName: toBranch.name,
                    itemId: selectedItem.id,
                    itemName: selectedItem.name,
                    quantity: quantity,
                    initiatedBy: user?.displayName || 'System',
                    createdAt: new Date().toISOString(),
                    _dirty: true,
                    _operation: 'create'
                };
                await db.stockTransfers.add(transferRecord);
                transferId = transferRecord.id;
                console.log('[Transfers] Created transfer record:', transferId);
            });

            // Mark items for sync
            await syncService.markAsDirty('InventoryItem', selectedItem.id, 'update');
            if (destinationItemId) {
                await syncService.markAsDirty('InventoryItem', destinationItemId, 'update');
            }
            
            // Mark transfer for sync
            await syncService.markAsDirty('StockTransfer', transferId, 'create');

            // Log audit action for stock transfer
            await logAuditAction({
                userId: user.uid,
                userName: user.displayName || user.email || 'Unknown',
                branchId: branchId,
                actionType: 'STOCK_TRANSFER',
                entityType: 'StockTransfer',
                entityId: transferId,
                details: {
                    fromBranch: fromBranch.name,
                    toBranch: toBranch.name,
                    itemName: selectedItem.name,
                    batchNumber: selectedBatch.batchNumber,
                    quantity: quantity,
                },
            });

            console.log('[Transfers] Marked for sync and logged audit action');
            toast({ title: 'Stock Transferred Successfully' });
            onFormSubmit();
        } catch (error) {
            console.error('Stock transfer failed:', error);
            toast({ variant: 'destructive', title: 'Transfer Failed' });
        }
    };

    return (
        <FormProvider {...formMethods}>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-h-[70vh] overflow-y-auto scrollbar-hide pr-2">
                <FormField
                    control={control}
                    name="itemId"
                    rules={{ required: 'Please select an item to transfer.' }}
                    render={({ field }) => (
                    <FormItem>
                        <FormLabel>Item to Transfer</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select an item" /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                                {inventoryItems.map(item => (
                                    <SelectItem key={item.id} value={item.id}>
                                        {item.name} (Available: {item.stockUnits || 0})
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FormMessage />
                    </FormItem>
                    )}
                />

                <FormField
                    control={control}
                    name="batchId"
                    rules={{ required: "Please select a batch.", min: { value: 1, message: "Please select a batch." } }}
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel className="text-base font-semibold">Select Batch to Transfer</FormLabel>
                            {!selectedItemId ? (
                                <div className="text-sm text-muted-foreground p-4 bg-muted rounded-lg border border-border flex items-center justify-center h-24">
                                    Please select an item first
                                </div>
                            ) : !batches || batches.length === 0 ? (
                                <div className="text-sm text-muted-foreground p-4 bg-muted rounded-lg border border-border flex items-center justify-center h-24">
                                    No available batches for this item
                                </div>
                            ) : (
                                <div className="space-y-3 max-h-72 overflow-y-auto pr-2">
                                    {batches.map(batch => {
                                        const isSelected = field.value === batch.id;
                                        const expiryDate = batch.expiryDate ? new Date(batch.expiryDate) : null;
                                        const today = new Date();
                                        today.setHours(0, 0, 0, 0);
                                        const isExpired = expiryDate && expiryDate < today;
                                        const daysUntilExpiry = expiryDate 
                                            ? Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
                                            : null;
                                        
                                        return (
                                            <button
                                                key={batch.id}
                                                type="button"
                                                onClick={() => field.onChange(batch.id)}
                                                className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-200 ${
                                                    isSelected
                                                        ? 'border-primary bg-primary/5 shadow-md'
                                                        : 'border-border bg-card hover:border-primary/50 hover:shadow-sm'
                                                }`}
                                            >
                                                <div className="flex justify-between items-start gap-3">
                                                    <div className="flex-1 space-y-3">
                                                        <div className="flex items-center justify-between">
                                                            <div className="font-semibold text-sm text-foreground">
                                                                Batch: {batch.batchNumber || 'N/A'}
                                                            </div>
                                                            <div className={`text-xs font-medium px-2 py-1 rounded-full ${
                                                                isExpired 
                                                                    ? 'bg-destructive/10 text-destructive' 
                                                                    : daysUntilExpiry && daysUntilExpiry <= 7 
                                                                    ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500'
                                                                    : 'bg-green-500/10 text-green-700 dark:text-green-500'
                                                            }`}>
                                                                {isExpired ? 'EXPIRED' : daysUntilExpiry ? `${daysUntilExpiry}d` : 'No expiry'}
                                                            </div>
                                                        </div>
                                                        
                                                        <div className="grid grid-cols-2 gap-3 text-xs">
                                                            <div className="space-y-1">
                                                                <p className="text-muted-foreground font-medium">Stock</p>
                                                                <p className="text-foreground font-semibold">{batch.quantityRemaining} {batch.quantityRemaining === 1 ? 'unit' : 'units'}</p>
                                                            </div>
                                                            <div className="space-y-1">
                                                                <p className="text-muted-foreground font-medium">Cost/Unit</p>
                                                                <p className="text-foreground font-semibold">{formatCurrency(batch.costPerUnit)}</p>
                                                            </div>
                                                            <div className="space-y-1">
                                                                <p className="text-muted-foreground font-medium">Received</p>
                                                                <p className="text-foreground font-semibold">{format(new Date(batch.receivedDate), 'MMM dd')}</p>
                                                            </div>
                                                            {expiryDate && (
                                                                <div className="space-y-1">
                                                                    <p className="text-muted-foreground font-medium">Expires</p>
                                                                    <p className={`font-semibold ${isExpired ? 'text-destructive' : daysUntilExpiry && daysUntilExpiry <= 7 ? 'text-yellow-700 dark:text-yellow-500' : 'text-foreground'}`}>
                                                                        {format(expiryDate, 'MMM dd')}
                                                                    </p>
                                                                </div>
                                                            )}
                                                        </div>

                                                        {batch.supplierName && (
                                                            <div className="pt-2 border-t border-border">
                                                                <p className="text-xs text-muted-foreground font-medium">Supplier</p>
                                                                <p className="text-sm text-foreground font-medium">{batch.supplierName}</p>
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="flex-shrink-0 pt-1">
                                                        <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                                                            isSelected 
                                                                ? 'border-primary bg-primary' 
                                                                : 'border-border bg-background'
                                                        }`}>
                                                            {isSelected && (
                                                                <svg className="w-4 h-4 text-primary-foreground" fill="currentColor" viewBox="0 0 20 20">
                                                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                                                </svg>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            <FormMessage />
                        </FormItem>
                    )}
                />
                
                 <div className="grid grid-cols-2 gap-4">
                    <FormField
                        control={control}
                        name="quantity"
                        rules={{ required: true, min: 1 }}
                        render={({ field }) => (
                            <FormItem>
                            <FormLabel>Quantity</FormLabel>
                            <FormControl>
                                <Input
                                    type="number"
                                    placeholder="0"
                                    {...field}
                                    max={selectedItem?.stockUnits || 0}
                                />
                            </FormControl>
                            <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={control}
                        name="toBranchId"
                        rules={{ required: 'Please select a destination.' }}
                        render={({ field }) => (
                            <FormItem>
                            <FormLabel>To Branch</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl>
                                    <SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    {branches.filter(b => b.id !== branchId).map(branch => (
                                        <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>
                
                <DialogFooter>
                    <Button type="submit">Confirm Transfer</Button>
                </DialogFooter>
            </form>
        </FormProvider>
    );
};
