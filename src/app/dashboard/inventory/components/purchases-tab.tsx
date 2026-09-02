'use client';

import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Truck, Loader2, ChevronDown, Cloud, CloudOff, Download, Pencil, Printer, Trash2 } from 'lucide-react';

import { db, type Business as BusinessRecord, type InventoryItem, type PurchaseRecord } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/hooks/use-toast';
import { logAuditAction } from '@/lib/audit';
import { syncService } from '@/lib/services/sync-service';
import { generatePurchaseInvoicePDF, printPurchaseInvoice } from '@/lib/purchase-invoice-pdf';
import { normalizePurchaseBatchQuantities } from '@/lib/purchase-quantity';
import type { EditablePurchaseGroup } from './purchase-editor-types';
import { PaginationControls, usePaginatedItems } from './pagination-controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface PurchasesTabProps {
    purchaseHistoryData: PurchaseRecord[];
    isMobile: boolean;
    searchTerm: string;
    onReceiveStock: () => void;
    onEditPurchase: (purchase: EditablePurchaseGroup) => void;
    branchId: string;
    currency?: string;
}

interface PurchaseGroup {
    groupId: string;
    receivedDate: string;
    displayDate: string;
    dateSortValue: number;
    supplierId: string;
    supplierName: string;
    paymentStatus: string;
    amountDue: number;
    items: PurchaseRecord[];
    totalCost: number;
    totalVat: number;
    totalWithVat: number;
    vatAmount?: number;
}

const parseDateCandidate = (...values: unknown[]): Date | null => {
    for (const value of values) {
        if (value instanceof Date) {
            if (!Number.isNaN(value.getTime())) return value;
            continue;
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            const ms = value < 1_000_000_000_000 ? value * 1000 : value;
            const parsed = new Date(ms);
            if (!Number.isNaN(parsed.getTime())) return parsed;
            continue;
        }

        if (typeof value !== 'string') continue;

        const trimmed = value.trim();
        if (!trimmed) continue;
        if (trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') continue;

        if (/^\d+$/.test(trimmed)) {
            const numericValue = Number(trimmed);
            if (Number.isFinite(numericValue)) {
                const ms = numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
                const parsed = new Date(ms);
                if (!Number.isNaN(parsed.getTime())) return parsed;
            }
        }

        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return null;
};

const formatPurchaseDate = (...values: unknown[]): string => {
    const parsed = parseDateCandidate(...values);
    return parsed ? parsed.toLocaleDateString() : '-';
};

const purchaseDateSortValue = (...values: unknown[]): number => {
    const parsed = parseDateCandidate(...values);
    return parsed ? parsed.getTime() : 0;
};

const normalizeTaxRate = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const resolveTaxMethod = (value: unknown): 'inclusive' | 'exclusive' => {
    return value === 'inclusive' ? 'inclusive' : 'exclusive';
};

const toFiniteNumber = (value: unknown): number | undefined => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveRecordVat = (record: PurchaseRecord): number => {
    const taxRate = normalizeTaxRate(record.taxRate);
    const method = resolveTaxMethod(record.taxCalculationMethod);
    const base = Number(record.totalCost || 0);
    if (!Number.isFinite(base) || base <= 0 || taxRate <= 0) {
        return typeof record.taxAmount === 'number' && Number.isFinite(record.taxAmount) ? record.taxAmount : 0;
    }
    if (method === 'inclusive') {
        return base - base / (1 + taxRate / 100);
    }
    return base * (taxRate / 100);
};

const resolveRecordGross = (record: PurchaseRecord, vatAmount: number): number => {
    const base = Number(record.totalCost || 0);
    if (!Number.isFinite(base)) return 0;
    const method = resolveTaxMethod(record.taxCalculationMethod);
    return method === 'exclusive' ? base + (vatAmount || 0) : base;
};

const resolveGroupVat = (group: Pick<PurchaseGroup, 'totalVat' | 'vatAmount'>): number => {
    const computedVat = toFiniteNumber(group.totalVat) ?? 0;
    if (computedVat > 0) {
        return computedVat;
    }

    return toFiniteNumber(group.vatAmount) ?? 0;
};

const resolveGroupTotalWithVat = (group: Pick<PurchaseGroup, 'totalCost' | 'totalVat' | 'totalWithVat' | 'vatAmount'>): number => {
    const computedVat = toFiniteNumber(group.totalVat) ?? 0;
    const computedTotal = toFiniteNumber(group.totalWithVat) ?? 0;
    const fallbackVat = toFiniteNumber(group.vatAmount) ?? 0;

    if (computedVat > 0 || fallbackVat <= 0) {
        return computedTotal;
    }

    // Some synced purchase orders only preserve VAT on the header, not per-item tax fields.
    // In that case `totalWithVat` matches the subtotal, so add the saved header VAT back in.
    return group.totalCost + fallbackVat;
};

const resolveGroupSubtotal = (group: Pick<PurchaseGroup, 'totalCost' | 'totalVat' | 'totalWithVat' | 'vatAmount'>): number => {
    return Math.max(0, resolveGroupTotalWithVat(group) - resolveGroupVat(group));
};

const resolveGroupStatus = (statuses: string[]): string => {
    if (statuses.includes('Unpaid')) return 'Unpaid';
    if (statuses.includes('Pending')) return 'Pending';
    if (statuses.includes('Partial')) return 'Partial';
    if (statuses.includes('Credit')) return 'Credit';
    return 'Paid';
};

const resolveInventoryStatus = (stockUnits: number, reorderLevel: number): InventoryItem['status'] => {
    if (stockUnits > reorderLevel) return 'In Stock';
    if (stockUnits > 0) return 'Low Stock';
    return 'Out of Stock';
};

const isLocalOnlyPurchaseRecord = (record: PurchaseRecord): boolean => {
    const recordId = String(record.id ?? '').trim();
    return record._operation === 'create' || typeof record.id === 'number' || /^\d+$/.test(recordId);
};

export function PurchasesTab({ purchaseHistoryData, isMobile, searchTerm, onReceiveStock, onEditPurchase, branchId, currency = 'USD' }: PurchasesTabProps) {
    const { user, business } = useAuth();
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
    const [pendingChanges, setPendingChanges] = useState(0);
    const [selectedPurchase, setSelectedPurchase] = useState<PurchaseGroup | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [businessCurrency, setBusinessCurrency] = useState(currency);
    const [businessProfile, setBusinessProfile] = useState<BusinessRecord | null>(null);
    const [isExportingInvoice, setIsExportingInvoice] = useState(false);
    const [isPrintingPurchase, setIsPrintingPurchase] = useState(false);
    const [isDeletingPurchase, setIsDeletingPurchase] = useState(false);
    const normalizedSearchTerm = searchTerm.trim().toLowerCase();

    // Load business currency from IndexedDB
    useEffect(() => {
        const loadCurrency = async () => {
            if (business?.id) {
                try {
                    const businessProfile = await db.business.get(business.id);
                    setBusinessProfile(businessProfile ?? null);
                    if (businessProfile?.currency) {
                        setBusinessCurrency(businessProfile.currency);
                    }
                } catch (error) {
                    console.error('[Purchases] Error loading business currency:', error);
                }
            }
        };
        loadCurrency();
    }, [business?.id]);

    // Count pending changes for this branch
    useEffect(() => {
        const countPendingChanges = async () => {
            try {
                const dirtyRecords = await db.purchaseHistory
                    .where({ branchId })
                    .toArray()
                    .then(records => records.filter(r => r._dirty));
                setPendingChanges(dirtyRecords.length);
            } catch (error) {
                console.error('[Purchases] Error counting pending changes:', error);
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
                description: 'Purchase history synced with backend',
            });
            setTimeout(() => setSyncStatus('idle'), 3000);
        } catch (error) {
            setSyncStatus('error');
            toast({
                variant: 'destructive',
                title: 'Sync Failed',
                description: 'Failed to sync purchase history',
            });
            setTimeout(() => setSyncStatus('idle'), 3000);
        }
    };

    // Group purchases by purchaseOrderId
    const groupedPurchases = React.useMemo(() => {
        const groups: Record<string, PurchaseGroup> = {};
        
        purchaseHistoryData?.forEach((record) => {
            const normalizedQuantities = normalizePurchaseBatchQuantities(
                record.quantityReceived,
                record.quantityRemaining
            );
            const normalizedRecord: PurchaseRecord = {
                ...record,
                quantityReceived: normalizedQuantities.quantityReceived,
                quantityRemaining: normalizedQuantities.quantityRemaining,
            };
            const key = record.purchaseOrderId || `${record.receivedDate}-${record.supplierId}`;
            const recordDisplayDate = formatPurchaseDate(
                record.receivedDate,
                (record as any).createdAt,
                (record as any).updatedAt
            );
            const recordSortDate = purchaseDateSortValue(
                record.receivedDate,
                (record as any).createdAt,
                (record as any).updatedAt
            );
            
            if (!groups[key]) {
                groups[key] = {
                    groupId: key,
                    receivedDate: record.receivedDate,
                    displayDate: recordDisplayDate,
                    dateSortValue: recordSortDate,
                    supplierId: record.supplierId,
                    supplierName: record.supplierName,
                    paymentStatus: record.paymentStatus,
                    amountDue: 0,
                    items: [],
                    totalCost: 0,
                    totalVat: 0,
                    totalWithVat: 0,
                    vatAmount: record.vatAmount,
                };
            } else if (recordSortDate > groups[key].dateSortValue) {
                groups[key].receivedDate = record.receivedDate;
                groups[key].displayDate = recordDisplayDate;
                groups[key].dateSortValue = recordSortDate;
            }

            groups[key].items.push(normalizedRecord);
            const vatAmount = resolveRecordVat(normalizedRecord);
            const grossAmount = resolveRecordGross(normalizedRecord, vatAmount);

            groups[key].totalCost += normalizedRecord.totalCost;
            groups[key].totalVat += vatAmount;
            groups[key].totalWithVat += grossAmount;
            groups[key].amountDue += Number(normalizedRecord.amountDue || 0);
            groups[key].paymentStatus = resolveGroupStatus([
                groups[key].paymentStatus,
                normalizedRecord.paymentStatus,
            ].filter(Boolean));

            if (groups[key].vatAmount === undefined && normalizedRecord.vatAmount !== undefined) {
                groups[key].vatAmount = normalizedRecord.vatAmount;
            }
        });
        
        return Object.values(groups).sort((a, b) => 
            b.dateSortValue - a.dateSortValue
        );
    }, [purchaseHistoryData]);

    const filteredPurchases = React.useMemo(() => {
        if (!normalizedSearchTerm) return groupedPurchases;

        return groupedPurchases.filter((purchase) => {
            const groupMatches = [
                purchase.supplierName,
                purchase.paymentStatus,
                purchase.displayDate,
                purchase.groupId,
            ].some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm));

            if (groupMatches) return true;

            return purchase.items.some((item) =>
                [
                    item.productName,
                    item.referenceNumber,
                    item.batchNumber,
                    item.expiryDate,
                    item.paymentStatus,
                ].some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm))
            );
        });
    }, [groupedPurchases, normalizedSearchTerm]);

    const {
        setCurrentPage,
        totalItems,
        totalPages,
        effectiveCurrentPage,
        pageStartIndex,
        pageEndIndex,
        paginatedItems: paginatedPurchases,
    } = usePaginatedItems(filteredPurchases);

    React.useEffect(() => {
        setCurrentPage(1);
    }, [normalizedSearchTerm, setCurrentPage]);

    const handleViewDetails = (purchase: PurchaseGroup) => {
        setSelectedPurchase(purchase);
        setIsModalOpen(true);
    };

    const handleEditPurchase = React.useCallback((purchase: PurchaseGroup | null) => {
        if (!purchase) {
            return;
        }

        const firstItem = purchase.items[0];
        onEditPurchase({
            groupId: purchase.groupId,
            purchaseOrderId: firstItem?.purchaseOrderId || purchase.groupId,
            receivedDate: purchase.receivedDate,
            supplierId: purchase.supplierId || firstItem?.supplierId,
            supplierName: purchase.supplierName || firstItem?.supplierName || 'No Supplier',
            paymentStatus: (purchase.paymentStatus || 'Paid') as PurchaseRecord['paymentStatus'],
            referenceNumber: firstItem?.referenceNumber,
            vatAmount: purchase.vatAmount,
            items: purchase.items,
        });
        setIsModalOpen(false);
    }, [onEditPurchase]);

    const handleDownloadInvoicePdf = async () => {
        if (!selectedPurchase) {
            toast({
                title: 'Select a purchase',
                description: 'Choose a purchase to export as an invoice.',
            });
            return;
        }

        setIsExportingInvoice(true);
        try {
            await generatePurchaseInvoicePDF({
                purchase: selectedPurchase,
                business: {
                    name: businessProfile?.name || business?.name || 'Business',
                    address: businessProfile?.address,
                    phone: businessProfile?.phone,
                    email: businessProfile?.email,
                    tin: businessProfile?.tin,
                },
                currencyCode: businessCurrency,
            });
            toast({
                title: 'Invoice downloaded',
                description: 'Purchase invoice PDF was downloaded successfully.',
            });
        } catch (error) {
            console.error('[Purchases] Failed to export purchase invoice PDF:', error);
            toast({
                variant: 'destructive',
                title: 'Download failed',
                description: 'Could not generate the purchase invoice PDF. Please try again.',
            });
        } finally {
            setIsExportingInvoice(false);
        }
    };

    const handlePrintPurchase = () => {
        if (!selectedPurchase) {
            toast({
                title: 'Select a purchase',
                description: 'Choose a purchase to print.',
            });
            return;
        }

        setIsPrintingPurchase(true);
        try {
            printPurchaseInvoice({
                purchase: selectedPurchase,
                business: {
                    name: businessProfile?.name || business?.name || 'Business',
                    address: businessProfile?.address,
                    phone: businessProfile?.phone,
                    email: businessProfile?.email,
                    tin: businessProfile?.tin,
                },
                currencyCode: businessCurrency,
            });
        } catch (error) {
            console.error('[Purchases] Failed to print purchase invoice:', error);
            toast({
                variant: 'destructive',
                title: 'Print failed',
                description: error instanceof Error ? error.message : 'Could not print this purchase.',
            });
        } finally {
            setIsPrintingPurchase(false);
        }
    };

    const handleDeletePurchase = async () => {
        if (!selectedPurchase) {
            return;
        }
        if (!user) {
            toast({
                variant: 'destructive',
                title: 'User not found',
            });
            return;
        }

        setIsDeletingPurchase(true);
        let syncFailed = false;

        try {
            const nowIso = new Date().toISOString();
            let clampedRemovalCount = 0;
            let deletedRecordCount = 0;
            let deletedPurchaseOrderId = '';

            await db.transaction('rw', db.inventory, db.purchaseHistory, db.purchaseOrders, async () => {
                const currentRecords: PurchaseRecord[] = [];

                for (const item of selectedPurchase.items) {
                    if (item.id === undefined || item.id === null || String(item.id).trim() === '') {
                        continue;
                    }

                    const currentRecord = await db.purchaseHistory.get(item.id as any);
                    if (currentRecord) {
                        currentRecords.push(currentRecord);
                    }
                }

                if (currentRecords.length === 0) {
                    throw new Error('This purchase could not be found locally anymore.');
                }

                const purchaseOrderCandidates = currentRecords
                    .map((record) => String(record.purchaseOrderId || '').trim())
                    .filter(Boolean);
                const fallbackGroupId = String(selectedPurchase.groupId || '').trim();
                const purchaseOrderId = purchaseOrderCandidates[0] || fallbackGroupId;
                const currentOrder = purchaseOrderId ? await db.purchaseOrders.get(purchaseOrderId) : undefined;
                const allRecordsLocalOnly = currentRecords.every(isLocalOnlyPurchaseRecord);
                const shouldSyncInventoryDecrease = !currentOrder || currentOrder._operation === 'create';

                if (!currentOrder && !allRecordsLocalOnly) {
                    throw new Error('This purchase is missing its order header locally. Please sync first, then try again.');
                }

                for (const currentRecord of currentRecords) {
                    const productId = String(currentRecord.productId || '').trim();
                    const inventoryItem = productId ? await db.inventory.get(productId) : undefined;

                    if (inventoryItem) {
                        const currentStock = Number(inventoryItem.stockUnits || 0);
                        const quantityRemaining = Math.max(0, Number(currentRecord.quantityRemaining || 0));
                        const safeQuantityToRemove = Math.max(0, Math.min(currentStock, quantityRemaining));

                        if (safeQuantityToRemove < quantityRemaining) {
                            clampedRemovalCount += 1;
                        }

                        const nextStock = Math.max(0, currentStock - safeQuantityToRemove);
                        const nextValue = Number.isFinite(nextStock * Number(inventoryItem.cost || 0))
                            ? Number((nextStock * Number(inventoryItem.cost || 0)).toFixed(2))
                            : inventoryItem.value;
                        const inventoryUpdate: any = {
                            stockUnits: nextStock,
                            value: nextValue,
                            status: resolveInventoryStatus(nextStock, Number(inventoryItem.reorderLevel || 0)),
                        };

                        if (shouldSyncInventoryDecrease) {
                            inventoryUpdate.allowStockDecrease = true;
                            inventoryUpdate._dirty = true;
                            inventoryUpdate._operation = inventoryItem._operation === 'create' ? 'create' : 'update';
                        }

                        await db.inventory.update(inventoryItem.id, inventoryUpdate);
                    }

                    await db.purchaseHistory.delete(currentRecord.id as any);
                    deletedRecordCount += 1;
                }

                if (currentOrder) {
                    deletedPurchaseOrderId = currentOrder.id;
                    const itemsSnapshot = currentRecords.map((record) => ({
                        id: record.id ? String(record.id) : undefined,
                        inventoryItemId: record.productId,
                        quantityRemaining: Number(record.quantityRemaining || 0),
                        quantityReceived: Number(record.quantityReceived || 0),
                    }));

                    if (currentOrder._operation === 'create') {
                        await db.purchaseOrders.delete(currentOrder.id);
                    } else {
                        await db.purchaseOrders.update(currentOrder.id, {
                            items: itemsSnapshot as any,
                            _dirty: true,
                            _operation: 'delete',
                            updatedAt: nowIso,
                        });
                    }
                }
            });

            await logAuditAction({
                userId: user.uid,
                userName: user.displayName || user.email || 'Unknown',
                branchId,
                actionType: 'STOCK_RECEIVE_DELETE',
                entityType: 'PurchaseOrder',
                entityId: deletedPurchaseOrderId || selectedPurchase.groupId,
                details: {
                    purchaseRef: selectedPurchase.groupId,
                    supplierName: selectedPurchase.supplierName,
                    deletedItems: deletedRecordCount,
                    removedAvailableStockOnly: true,
                },
            });

            if (typeof window !== 'undefined' && navigator.onLine) {
                try {
                    await syncService.performFullSync(branchId);
                } catch (error) {
                    syncFailed = true;
                    console.error('[Purchases] Failed to sync purchase deletion immediately:', error);
                }
            }

            setIsDeleteDialogOpen(false);
            setIsModalOpen(false);
            setSelectedPurchase(null);

            toast({
                title: 'Purchase deleted',
                description: syncFailed
                    ? 'The purchase was deleted locally. Sync will retry automatically.'
                    : deletedRecordCount > 0 && clampedRemovalCount > 0
                    ? 'Deleted successfully. Only currently available stock was removed for some items.'
                    : 'The purchase and its remaining stock were removed safely.',
            });
        } catch (error) {
            console.error('[Purchases] Failed to delete purchase safely:', error);
            toast({
                variant: 'destructive',
                title: 'Delete failed',
                description: error instanceof Error ? error.message : 'Could not delete this purchase safely.',
            });
        } finally {
            setIsDeletingPurchase(false);
        }
    };

    const getCurrencySymbol = () => {
        return businessCurrency === 'MWK' ? 'MWK' : '$';
    };

    const renderPurchaseCard = (purchase: PurchaseGroup) => {
        const itemCount = purchase.items.length;
        const totalQuantity = purchase.items.reduce((sum, item) => sum + item.quantityReceived, 0);
        const currencySymbol = getCurrencySymbol();
        const resolvedVat = resolveGroupVat(purchase);
        const resolvedTotalWithVat = resolveGroupTotalWithVat(purchase);
        
        return (
            <Card
                key={purchase.groupId}
                className="mobile-data-card mb-4 cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => handleViewDetails(purchase)}
            >
                <CardHeader className="p-4">
                    <div className="flex items-center justify-between">
                        <div className="flex-1">
                            <CardTitle className="text-base">{purchase.supplierName}</CardTitle>
                            <CardDescription>{purchase.displayDate}</CardDescription>
                        </div>
                        <div className="text-right">
                            <p className="font-semibold text-lg">{currencySymbol} {resolvedTotalWithVat.toFixed(2)}</p>
                            {resolvedVat > 0 && (
                                <p className="text-xs text-muted-foreground">VAT: {currencySymbol} {resolvedVat.toFixed(2)}</p>
                            )}
                            <p className="text-xs text-muted-foreground">{itemCount} item{itemCount !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-4 pt-0 text-sm">
                    <Separator className="my-3" />
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-muted-foreground">Total Quantity</p>
                            <p className="font-semibold">{totalQuantity} units</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground">Payment Status</p>
                            <Badge variant={purchase.paymentStatus === 'Paid' ? 'secondary' : 'outline'}>{purchase.paymentStatus}</Badge>
                        </div>
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </div>
                </CardContent>
            </Card>
        );
    };

    return (
        <>
            <CardContent>
                <div className="mb-6">
                    <Button onClick={onReceiveStock}>
                        <Truck className="mr-2 h-4 w-4" /> Receive Stock
                    </Button>
                </div>
                {isMobile ? (
                    filteredPurchases.length > 0 ? (
                        <div>
                            {paginatedPurchases.map(renderPurchaseCard)}
                        </div>
                    ) : (
                        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            {normalizedSearchTerm ? `No purchases match "${searchTerm.trim()}".` : 'No purchases have been recorded.'}
                        </div>
                    )
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Date</TableHead>
                                    <TableHead>Supplier</TableHead>
                                    <TableHead className="text-right">Items</TableHead>
                                    <TableHead className="text-right">Total Qty</TableHead>
                                    <TableHead>Payment</TableHead>
                                    <TableHead className="text-right">Total Cost</TableHead>
                                    <TableHead className="text-right">VAT</TableHead>
                                    <TableHead className="text-right">Total (Incl VAT)</TableHead>
                                    <TableHead className="text-center">Sync Status</TableHead>
                                    <TableHead className="text-center">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredPurchases.length > 0 ? paginatedPurchases.map((purchase) => {
                                    const totalQuantity = purchase.items.reduce((sum, item) => sum + item.quantityReceived, 0);
                                    const currencySymbol = getCurrencySymbol();
                                    const hasPendingSync = purchase.items.some(item => item._dirty);
                                    const hasDeviceOnlyItems = purchase.items.some(isLocalOnlyPurchaseRecord);
                                    const resolvedVat = resolveGroupVat(purchase);
                                    const resolvedTotalWithVat = resolveGroupTotalWithVat(purchase);
                                    
                                    return (
                                        <TableRow key={purchase.groupId} className="cursor-pointer hover:bg-muted/50">
                                            <TableCell>{purchase.displayDate}</TableCell>
                                            <TableCell className="font-medium">{purchase.supplierName}</TableCell>
                                            <TableCell className="text-right">{purchase.items.length}</TableCell>
                                            <TableCell className="text-right">{totalQuantity}</TableCell>
                                            <TableCell><Badge variant={purchase.paymentStatus === 'Paid' ? 'secondary' : 'outline'} className="text-xs">{purchase.paymentStatus}</Badge></TableCell>
                                            <TableCell className="text-right font-semibold">{currencySymbol} {purchase.totalCost.toFixed(2)}</TableCell>
                                            <TableCell className="text-right">{currencySymbol} {resolvedVat.toFixed(2)}</TableCell>
                                            <TableCell className="text-right font-semibold">{currencySymbol} {resolvedTotalWithVat.toFixed(2)}</TableCell>
                                            <TableCell className="text-center">
                                                {hasPendingSync ? (
                                                    <div className="flex items-center justify-center gap-1">
                                                        <CloudOff className="h-4 w-4 text-orange-500" />
                                                        <span className="text-xs text-orange-600">Pending</span>
                                                    </div>
                                                ) : hasDeviceOnlyItems ? (
                                                    <div className="flex items-center justify-center gap-1">
                                                        <CloudOff className="h-4 w-4 text-muted-foreground" />
                                                        <span className="text-xs text-muted-foreground">Device only</span>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center justify-center gap-1">
                                                        <Cloud className="h-4 w-4 text-green-500" />
                                                        <span className="text-xs text-green-600">Synced</span>
                                                    </div>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-center">
                                                <Button 
                                                    variant="ghost" 
                                                    size="sm"
                                                    onClick={() => handleViewDetails(purchase)}
                                                >
                                                    View
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                }) : (
                                    <TableRow>
                                        <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                                            {normalizedSearchTerm ? `No purchases match "${searchTerm.trim()}".` : 'No purchases have been recorded.'}
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
                    itemLabel="purchases"
                />
            </CardContent>

            {/* Purchase Details Modal */}
            <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
                    <DialogHeader className="sticky top-0 bg-background z-10 pt-6 pb-2">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <DialogTitle>Purchase Order Details</DialogTitle>
                                <DialogDescription>
                                    {selectedPurchase && `${selectedPurchase.supplierName} - ${selectedPurchase.displayDate}`}
                                </DialogDescription>
                            </div>
                            <Button
                                variant="outline"
                                onClick={handleDownloadInvoicePdf}
                                disabled={!selectedPurchase || isExportingInvoice || isPrintingPurchase || isDeletingPurchase}
                            >
                                {isExportingInvoice ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <Download className="mr-2 h-4 w-4" />
                                )}
                                Download Invoice PDF
                            </Button>
                            <Button
                                variant="outline"
                                onClick={handlePrintPurchase}
                                disabled={!selectedPurchase || isExportingInvoice || isPrintingPurchase || isDeletingPurchase}
                            >
                                {isPrintingPurchase ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <Printer className="mr-2 h-4 w-4" />
                                )}
                                Print Purchase
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => handleEditPurchase(selectedPurchase)}
                                disabled={!selectedPurchase || isDeletingPurchase || isExportingInvoice || isPrintingPurchase}
                            >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit Purchase
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={() => setIsDeleteDialogOpen(true)}
                                disabled={!selectedPurchase || isDeletingPurchase}
                            >
                                {isDeletingPurchase ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <Trash2 className="mr-2 h-4 w-4" />
                                )}
                                Delete Purchase
                            </Button>
                        </div>
                    </DialogHeader>
                    
                    {selectedPurchase && (
                        <div className="flex-1 overflow-y-auto -mx-6 px-6">
                            {(() => {
                                const resolvedSubtotal = resolveGroupSubtotal(selectedPurchase);
                                const resolvedVat = resolveGroupVat(selectedPurchase);
                                const resolvedTotalWithVat = resolveGroupTotalWithVat(selectedPurchase);

                                return (
                            <>
                            {/* Purchase Summary */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 p-4 bg-muted rounded-lg">
                                <div>
                                    <p className="text-xs text-muted-foreground">Supplier</p>
                                    <p className="font-semibold">{selectedPurchase.supplierName}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Purchase Ref</p>
                                    <p className="font-semibold break-all">{selectedPurchase.groupId}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Date Received</p>
                                    <p className="font-semibold">{selectedPurchase.displayDate}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Payment Status</p>
                                    <Badge variant={selectedPurchase.paymentStatus === 'Paid' ? 'secondary' : 'outline'}>{selectedPurchase.paymentStatus}</Badge>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Subtotal (Excl VAT)</p>
                                    <p className="font-semibold text-lg">
                                        {getCurrencySymbol()} {resolvedSubtotal.toFixed(2)}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">VAT</p>
                                    <p className="font-semibold text-lg">{getCurrencySymbol()} {resolvedVat.toFixed(2)}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Total (Incl VAT)</p>
                                    <p className="font-semibold text-lg">{getCurrencySymbol()} {resolvedTotalWithVat.toFixed(2)}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Amount Due</p>
                                    <p className="font-semibold text-lg">{getCurrencySymbol()} {selectedPurchase.amountDue.toFixed(2)}</p>
                                </div>
                            </div>

                            {/* Items Table */}
                            <div className="mb-4">
                                <h3 className="font-semibold mb-3">Items in this Purchase</h3>
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead className="text-right">Received</TableHead>
                                                <TableHead className="text-right">Remaining</TableHead>
                                                <TableHead className="text-right">Unit Cost</TableHead>
                                                <TableHead className="text-right">Total</TableHead>
                                                <TableHead className="text-right">VAT (Incl/Excl)</TableHead>
                                                <TableHead>Batch No.</TableHead>
                                                <TableHead>Expiry Date</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {selectedPurchase.items.map((item) => {
                                                const isConsumed = item.quantityRemaining === 0;
                                                const percentRemaining = (item.quantityRemaining / item.quantityReceived) * 100;
                                                const currencySymbol = getCurrencySymbol();
                                                const itemVat = resolveRecordVat(item);
                                                const vatMethod = resolveTaxMethod(item.taxCalculationMethod);
                                                const vatLabel = vatMethod === 'inclusive' ? 'Incl' : 'Excl';
                                                return (
                                                    <TableRow key={item.id} className={isConsumed ? 'opacity-60' : ''}>
                                                        <TableCell className="font-medium">{item.productName}</TableCell>
                                                        <TableCell className="text-right">{item.quantityReceived}</TableCell>
                                                        <TableCell className="text-right">
                                                            <div className="flex items-center justify-end gap-2">
                                                                <span className={isConsumed ? 'text-muted-foreground line-through' : 'font-semibold'}>{item.quantityRemaining}</span>
                                                                {percentRemaining > 0 && percentRemaining < 100 && (
                                                                    <div className="w-12 h-2 bg-muted rounded-full overflow-hidden">
                                                                        <div 
                                                                            className={`h-full ${percentRemaining > 50 ? 'bg-green-500' : percentRemaining > 25 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                                                            style={{ width: `${percentRemaining}%` }}
                                                                        />
                                                                    </div>
                                                                )}
                                                                {isConsumed && <Badge variant="outline" className="text-xs">Consumed</Badge>}
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-right">{currencySymbol} {item.costPerUnit.toFixed(2)}</TableCell>
                                                        <TableCell className="text-right font-semibold">{currencySymbol} {item.totalCost.toFixed(2)}</TableCell>
                                                        <TableCell className="text-right">
                                                            {currencySymbol} {itemVat.toFixed(2)} ({vatLabel})
                                                        </TableCell>
                                                        <TableCell className="font-mono text-xs">{item.batchNumber || 'N/A'}</TableCell>
                                                        <TableCell>{item.expiryDate ? formatPurchaseDate(item.expiryDate) : 'N/A'}</TableCell>
                                                    </TableRow>
                                                );
                                            })}
                                        </TableBody>
                                    </Table>
                                </div>
                            </div>
                            </>
                                );
                            })()}
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this purchase?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will delete the purchase and remove only the stock that is still available from its batches.
                            Already consumed stock is not restored. This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeletingPurchase}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(event) => {
                                event.preventDefault();
                                void handleDeletePurchase();
                            }}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {isDeletingPurchase ? 'Deleting...' : 'Delete Purchase'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
