import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Controller, useForm } from 'react-hook-form';
import { Loader2, Package } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import { db, type InventoryItem, type Session } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import { logAuditAction } from '@/lib/audit';
import { syncService } from '@/lib/services/sync-service';
import { SHOW_FUEL_FEATURES } from '@/lib/fuel-features';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch',
  BUSINESS_SETTINGS: 'handypos-business-settings',
};

export default function StartSessionForm({ onSessionStarted }: { onSessionStarted: () => void }) {
    const { register, handleSubmit, formState: { errors }, getValues, control } = useForm<{ openingFloat: number; pumpName?: string }>({
        defaultValues: {
            openingFloat: 0,
            pumpName: '',
        },
    });
    const { user } = useAuth();
    const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
    const [step, setStep] = useState(1);
    const [isLoading, setIsLoading] = useState(false);
    const [backendInventory, setBackendInventory] = useState<any[]>([]);
    const [isFetchingInventory, setIsFetchingInventory] = useState(false);
    const [inventoryRefreshProgress, setInventoryRefreshProgress] = useState(0);
    const [inventoryRefreshStage, setInventoryRefreshStage] = useState('');
    const [inventoryRefreshError, setInventoryRefreshError] = useState<string | null>(null);
    const [hasFreshInventorySnapshot, setHasFreshInventorySnapshot] = useState(false);
    const [inventoryRefreshAttempt, setInventoryRefreshAttempt] = useState(0);
    const [availablePumps, setAvailablePumps] = useState<string[]>([]);
    const [backendIsFuelAttendant, setBackendIsFuelAttendant] = useState<boolean | null>(null);
    const staffRecords = useLiveQuery(() => db.staff.toArray(), []);
    const currentUserEmail = (user?.email || '').trim().toLowerCase();
    const currentUserId = String(user?.uid || '').trim();
    const matchedStaff = staffRecords?.find((staff) => {
        const staffEmail = (staff.email || '').trim().toLowerCase();
        if (currentUserEmail && staffEmail) {
            return currentUserEmail === staffEmail;
        }
        if (currentUserId) {
            return String(staff.id) === currentUserId;
        }
        return false;
    });
    const isFuelAttendant = SHOW_FUEL_FEATURES
        ? Boolean(
            backendIsFuelAttendant ??
            user?.isFuelAttendant ??
            matchedStaff?.isFuelAttendant
        )
        : false;
    const showPumpField = SHOW_FUEL_FEATURES && isFuelAttendant;

    const toBackendBranchId = (branchId: string): string => {
        const normalized = String(branchId || '').trim();
        const prefixed = /^BRN-(\d+)$/i.exec(normalized);
        if (prefixed) return prefixed[1];
        const legacy = /^branch-(\d+)$/i.exec(normalized);
        if (legacy) return legacy[1];
        return normalized;
    };

    const getBranchIdCandidates = (branchId: string): string[] => {
        const normalized = String(branchId || '').trim();
        if (!normalized) return [];

        const backendId = toBackendBranchId(normalized);
        const candidates = new Set<string>([normalized, backendId]);

        if (/^\d+$/.test(backendId)) {
            candidates.add(`BRN-${backendId}`);
            candidates.add(`branch-${backendId}`);
        }

        return Array.from(candidates).filter((candidate) => candidate.length > 0);
    };

    const getInventoryItemsForBranch = async (branchId: string): Promise<InventoryItem[]> => {
        const candidates = getBranchIdCandidates(branchId);
        if (candidates.length === 0) {
            return [];
        }

        if (candidates.length === 1) {
            return db.inventory.where('branchId').equals(candidates[0]).toArray();
        }

        return db.inventory.where('branchId').anyOf(candidates).toArray();
    };

    const filterActiveInventory = (items: InventoryItem[]): InventoryItem[] =>
        items.filter((item: any) => item?._operation !== 'delete');

    useEffect(() => {
        const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
        if (branchId) setActiveBranchId(branchId);
    }, []);

    useEffect(() => {
        if (!SHOW_FUEL_FEATURES) {
            setAvailablePumps([]);
            return;
        }

        if (typeof window === 'undefined') return;

        try {
            const rawSettings = localStorage.getItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS);
            if (!rawSettings) {
                setAvailablePumps([]);
                return;
            }

            const parsed = JSON.parse(rawSettings);
            const rawPumps = parsed?.fuelPumps ?? parsed?.fuel_pumps ?? parsed?.pumpNames ?? [];
            if (!Array.isArray(rawPumps)) {
                setAvailablePumps([]);
                return;
            }

            const seen = new Set<string>();
            const normalized = rawPumps
                .map((pump: unknown) => String(pump ?? '').trim())
                .filter((pump: string) => pump.length > 0)
                .filter((pump: string) => {
                    if (seen.has(pump)) return false;
                    seen.add(pump);
                    return true;
                });

            setAvailablePumps(normalized);
        } catch (error) {
            console.warn('[Sessions] Failed to parse fuel pumps from settings cache:', error);
            setAvailablePumps([]);
        }
    }, []);

    useEffect(() => {
        if (!SHOW_FUEL_FEATURES) {
            setBackendIsFuelAttendant(null);
            return;
        }

        let cancelled = false;

        const fetchStaffProfile = async () => {
            if (!user) {
                setBackendIsFuelAttendant(null);
                return;
            }
            try {
                const staffProfile = await authFetch.fetch<any>('/staff/me/');
                if (cancelled) return;
                if (staffProfile) {
                    setBackendIsFuelAttendant(
                        Boolean(
                            staffProfile?.is_fuel_attendant ??
                            staffProfile?.isFuelAttendant
                        )
                    );
                } else {
                    setBackendIsFuelAttendant(false);
                }
            } catch (error) {
                if (!cancelled) {
                    setBackendIsFuelAttendant(null);
                }
            }
        };

        fetchStaffProfile();

        return () => {
            cancelled = true;
        };
    }, [user?.uid]);

    // Listen for branch changes
    useEffect(() => {
        const handleBranchChange = (e: Event) => {
            const customEvent = e as CustomEvent;
            const branchId = customEvent.detail?.branchId;
            if (branchId) {
                setActiveBranchId(branchId);
                console.log('[Sessions] Branch changed to:', branchId);
            }
        };
        window.addEventListener('branchChanged', handleBranchChange);
        return () => window.removeEventListener('branchChanged', handleBranchChange);
    }, []);

    // Fetch inventory from backend when branch changes
    useEffect(() => {
        let cancelled = false;

        if (activeBranchId) {
            const fetchInventoryFromBackend = async () => {
                setIsFetchingInventory(true);
                setHasFreshInventorySnapshot(false);
                setInventoryRefreshError(null);
                setInventoryRefreshProgress(5);
                setInventoryRefreshStage('Loading inventory...');

                try {
                    const localInventory = filterActiveInventory(await getInventoryItemsForBranch(activeBranchId));
                    if (cancelled) return;

                    setBackendInventory(localInventory);
                    setInventoryRefreshProgress(localInventory.length > 0 ? 15 : 10);
                    setInventoryRefreshStage('Refreshing inventory...');

                    console.log('[Sessions] Refreshing inventory cache for branch:', activeBranchId);
                    const refreshed = await syncService.fetchAllInventoryFromBackend(activeBranchId, {
                        onProgress: (progress) => {
                            if (cancelled) return;
                            if (typeof progress.percent === 'number') {
                                setInventoryRefreshProgress(Math.max(0, Math.min(100, Math.round(progress.percent))));
                            }
                        },
                    });

                    if (cancelled) return;

                    const refreshedInventory = filterActiveInventory(await getInventoryItemsForBranch(activeBranchId));
                    if (cancelled) return;

                    console.log('[Sessions] Loaded', refreshedInventory.length, 'inventory items for branch:', activeBranchId);
                    setBackendInventory(refreshedInventory);

                    if (refreshed) {
                        setHasFreshInventorySnapshot(true);
                        setInventoryRefreshError(null);
                        setInventoryRefreshProgress(100);
                        setInventoryRefreshStage('Inventory ready');
                    } else {
                        setHasFreshInventorySnapshot(false);
                        setInventoryRefreshError('Failed to refresh inventory from backend. Retry before starting the session.');
                        setInventoryRefreshStage('Refresh failed');
                    }
                } catch (error) {
                    console.error('[Sessions] Error fetching inventory from backend:', error);
                    if (!cancelled) {
                        setHasFreshInventorySnapshot(false);
                        setInventoryRefreshError('Failed to prepare the inventory snapshot. Retry before starting the session.');
                        setInventoryRefreshStage('Unable to load inventory');
                    }
                } finally {
                    if (!cancelled) {
                        setIsFetchingInventory(false);
                    }
                }
            };

            void fetchInventoryFromBackend();
        } else {
            setBackendInventory([]);
            setIsFetchingInventory(false);
            setInventoryRefreshProgress(0);
            setInventoryRefreshStage('');
            setInventoryRefreshError(null);
            setHasFreshInventorySnapshot(false);
        }

        return () => {
            cancelled = true;
        };
    }, [activeBranchId, inventoryRefreshAttempt]);

    // Use backend inventory for form display (ensures fresh data on session creation)
    const inventory = backendInventory;
    const openingInventory = SHOW_FUEL_FEATURES && isFuelAttendant
        ? inventory.filter((item) => Boolean(item.isFuel))
        : inventory;

    const onFloatSubmit = () => {
        setStep(2);
    };

    const onSubmit = async () => {
        if (!activeBranchId || !user) {
            toast({ variant: 'destructive', title: 'Error', description: 'No active branch or user found.' });
            return;
        }
        if (!hasFreshInventorySnapshot) {
            toast({
                variant: 'destructive',
                title: 'Inventory still syncing',
                description: inventoryRefreshError || 'Wait for the latest backend inventory snapshot before starting the session.',
            });
            return;
        }
        setIsLoading(true);
        const openingFloat = getValues('openingFloat');
        const selectedPump = showPumpField ? getValues('pumpName') : '';

        try {
            const backendBranchId = toBackendBranchId(activeBranchId);
            const branchValue = /^\d+$/.test(backendBranchId)
                ? parseInt(backendBranchId, 10)
                : backendBranchId;

            const sessionData = {
                id: uuidv4(),
                business: user.businessId,
                branch: branchValue,
                opening_float: openingFloat,
                expected_cash: openingFloat,
                total_sales: 0,
                total_cash_sales: 0,
                total_card_sales: 0,
                total_mobile_money_sales: 0,
                total_bank_transfer_sales: 0,
                total_on_account_sales: 0,
                total_other_sales: 0,
                total_tips: 0,
                pump_name: SHOW_FUEL_FEATURES ? (selectedPump || undefined) : undefined,
                opening_stock: openingInventory.map((i) => ({
                    itemId: i.id,
                    name: i.name,
                    quantity: Number(i.stockUnits ?? i.stock_units ?? 0),
                })),
                started_at: new Date().toISOString(),
                status: 'active',
            };

            console.log('[Sessions] Creating session on backend:', sessionData);

            // Create session on backend
            const response = await authFetch.fetch<any>('/sessions/sessions/', {
                method: 'POST',
                body: JSON.stringify(sessionData),
                meta: {
                    domain: 'sessions',
                    entityType: 'Session',
                    entityId: sessionData.id,
                    metadata: { action: 'create', openingFloat: openingFloat }
                }
            });

            console.log('[Sessions] Session created on backend:', response);

            const resolvedSessionId = String(response?.id || sessionData.id);
            const responseUserName =
                response?.user_name ||
                response?.userName ||
                response?.user_email ||
                user.displayName ||
                user.email ||
                'Unknown User';
            const responseUserEmail =
                response?.user_email ||
                response?.userEmail ||
                user.email ||
                '';
            const responseUserId = String(response?.user || response?.user_id || user.uid || '');
            const startedAt = response?.started_at || response?.startedAt || new Date().toISOString();

            // Save to local DB for offline access (use backend user/session details as source of truth)
            await db.sessions.add({
                id: resolvedSessionId,
                branchId: activeBranchId,
                userId: responseUserId,
                userName: responseUserName,
                userEmail: responseUserEmail,
                status: 'active',
                pumpName: SHOW_FUEL_FEATURES ? (selectedPump || undefined) : undefined,
                openingFloat: openingFloat,
                expectedCash: openingFloat,
                openingStock: sessionData.opening_stock,
                totalSales: 0,
                totalCashSales: 0,
                totalCardSales: 0,
                totalMobileMoneySales: 0,
                totalBankTransferSales: 0,
                totalOnAccountSales: 0,
                totalOtherSales: 0,
                totalTips: 0,
                startedAt,
            });

            console.log('[Sessions] Session saved to local DB:', resolvedSessionId);

            // Log audit action
            await logAuditAction({
                userId: responseUserId || user.uid,
                userName: responseUserName || user.displayName || user.email || 'Unknown',
                branchId: activeBranchId,
                actionType: 'SESSION_START',
                entityType: 'Session',
                entityId: resolvedSessionId,
                details: { openingFloat: openingFloat },
            });

            toast({ title: 'Session Started', description: `Your session has been successfully started.` });
            
            // CRITICAL: Immediately refresh active session in POS modal
            // Dispatch custom event to notify POS modal to fetch the new session
            window.dispatchEvent(new CustomEvent('sessionCreated', { 
              detail: { sessionId: resolvedSessionId, branchId: activeBranchId }
            }));
            console.log('[Sessions] Dispatched sessionCreated event for POS modal refresh');
            
            onSessionStarted();
        } catch (error) {
            console.error('[Sessions] Error creating session:', error);
            toast({ 
                variant: 'destructive', 
                title: 'Failed to start session',
                description: error instanceof Error ? error.message : 'Unknown error'
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit(step === 1 ? onFloatSubmit : onSubmit)} className="grid gap-4 py-4">
           {step === 1 && (
               <>
                <div className="grid gap-2">
                    <Label htmlFor="openingFloat">Opening Cash Float</Label>
                    <Input
                        id="openingFloat"
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        {...register('openingFloat', { required: true, valueAsNumber: true, min: 0 })}
                    />
                    {errors.openingFloat && <p className="text-sm text-destructive">Please enter a valid opening float.</p>}
                </div>
                {showPumpField && (
                    <div className="grid gap-2">
                        <Label>Fuel Pump</Label>
                        {availablePumps.length > 0 ? (
                            <Controller
                                control={control}
                                name="pumpName"
                                rules={{
                                    validate: (value) =>
                                        Boolean(value) || 'Please select a pump.',
                                }}
                                render={({ field }) => (
                                    <Select value={field.value || ''} onValueChange={field.onChange}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select pump" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {availablePumps.map((pump) => (
                                                <SelectItem key={pump} value={pump}>
                                                    {pump}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                            />
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                No pumps configured. Add fuel pumps in Settings to enable selection.
                            </p>
                        )}
                        {errors.pumpName && (
                            <p className="text-sm text-destructive">{errors.pumpName.message}</p>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button type="submit">Next: Review Stock</Button>
                </DialogFooter>
               </>
           )}
	           {step === 2 && (
	               <>
	                <div className="space-y-4">
                        <Card>
                            <CardContent className="p-4 space-y-3">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium">Refreshing inventory from backend</p>
                                        <p className="text-xs text-muted-foreground">{inventoryRefreshStage || 'Preparing the latest inventory snapshot...'}</p>
                                    </div>
                                    <span className="text-xs font-medium text-muted-foreground">
                                        {Math.max(0, Math.min(100, Math.round(inventoryRefreshProgress)))}%
                                    </span>
                                </div>
                                <Progress value={Math.max(0, Math.min(100, inventoryRefreshProgress))} />
                                {inventoryRefreshError && (
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-destructive">{inventoryRefreshError}</p>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setInventoryRefreshAttempt((current) => current + 1)}
                                            disabled={isFetchingInventory}
                                        >
                                            Retry Refresh
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
	                    <Card>
	                        <CardHeader className="p-4">
	                           <CardTitle className="text-base flex items-center gap-2"><Package/> Opening Inventory</CardTitle>
	                        </CardHeader>
	                        <CardContent className="p-0">
                            <ScrollArea className="h-64">
                                <Table>
                                    <TableHeader className="sticky top-0 bg-muted">
                                        <TableRow>
                                            <TableHead>Item</TableHead>
                                            <TableHead className="text-right">Quantity</TableHead>
                                        </TableRow>
	                                    </TableHeader>
	                                    <TableBody>
	                                        {openingInventory.length > 0 ? (
	                                            openingInventory.map(item => {
	                                                const quantity = Number(item.stockUnits ?? item.stock_units ?? 0);
	                                                const unitType = item.unitType || item.unit_type || 'unit';

	                                                return (
	                                                    <TableRow key={item.id}>
	                                                        <TableCell className="font-medium">{item.name}</TableCell>
	                                                        <TableCell className="text-right">{quantity} {unitType}</TableCell>
	                                                    </TableRow>
	                                                );
	                                            })
	                                        ) : isFetchingInventory ? (
	                                            <TableRow>
	                                                <TableCell colSpan={2} className="text-center text-muted-foreground py-4">
	                                                    Loading inventory...
	                                                </TableCell>
	                                            </TableRow>
	                                        ) : (
	                                            <TableRow>
	                                                <TableCell colSpan={2} className="text-center text-muted-foreground py-4">
	                                                    No inventory items found for this branch
	                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                        </CardContent>
	                    </Card>
	                </div>
	                <DialogFooter className="pt-4">
	                    <Button variant="ghost" onClick={() => setStep(1)} disabled={isLoading}>Back</Button>
	                    <Button type="submit" disabled={isLoading || isFetchingInventory || !hasFreshInventorySnapshot}>
	                         {isLoading ? <Loader2 className="mr-2 animate-spin" /> : null}
	                        {isLoading
	                            ? 'Starting Session...'
	                            : isFetchingInventory
	                                ? 'Syncing Inventory...'
	                                : !hasFreshInventorySnapshot
	                                    ? 'Waiting for Backend Inventory'
	                                    : 'Confirm & Start Session'}
	                    </Button>
	                </DialogFooter>
	               </>
	           )}
        </form>
    );
};
