
'use client';

import React from 'react';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { format } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

import { db, type InventoryItem, type PurchaseRecord, type WasteRecord } from '@/lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { toast } from '@/hooks/use-toast';
import { logAuditAction } from '@/lib/audit';
import { syncService } from '@/lib/services/sync-service';
import { authFetch } from '@/lib/auth-fetch';
import { SHOW_FUEL_FEATURES } from '@/lib/fuel-features';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const wasteReasons = ['Expired', 'Damaged', 'Spoilage', 'Error', 'Other'] as const;
type WasteReason = typeof wasteReasons[number];

type WasteFormValues = {
    itemId: string;
    batchId: number;
    quantity: number;
    reason: WasteReason;
    notes?: string;
};

const getBatchReceivedLabel = (batch: PurchaseRecord): string => {
    const rawReceivedDate =
        (batch as PurchaseRecord & { received_date?: unknown }).receivedDate ??
        (batch as PurchaseRecord & { received_date?: unknown }).received_date ??
        (batch as PurchaseRecord & { createdAt?: unknown }).createdAt ??
        (batch as PurchaseRecord & { created_at?: unknown }).created_at ??
        (batch as PurchaseRecord & { updatedAt?: unknown }).updatedAt ??
        (batch as PurchaseRecord & { updated_at?: unknown }).updated_at;

    if (rawReceivedDate === undefined || rawReceivedDate === null || rawReceivedDate === '') {
        return 'N/A';
    }

    const parsedDate = new Date(rawReceivedDate as string | number | Date);
    if (Number.isNaN(parsedDate.getTime())) {
        return String(rawReceivedDate);
    }

    return format(parsedDate, 'MMM dd');
};

const normalizeBranchId = (value?: string | number | null): string => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';

    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];

    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];

    return normalized;
};

const toBackendBranchId = (branchId: string): string => {
    const normalized = normalizeBranchId(branchId);
    return normalized || branchId;
};

type SessionChoice = {
    id: string;
    label: string;
    sortValue: number;
    hasPump: boolean;
    pumpName?: string;
};

const parseSessionDate = (value: unknown): Date | null => {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value < 1_000_000_000_000 ? value * 1000 : value;
        const parsed = new Date(ms);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) {
            const numericValue = Number(trimmed);
            const ms = numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
            const parsed = new Date(ms);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        }
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
};

const getSessionPumpName = (session: any): string => {
    const raw = session?.pump_name ?? session?.pumpName ?? session?.pump ?? '';
    return String(raw ?? '').trim();
};

const getSessionHasPump = (session: any): boolean => {
    return Boolean(getSessionPumpName(session));
};

const buildSessionChoice = (session: any): SessionChoice | null => {
    if (!session) return null;
    const id = String(session?.id ?? '').trim();
    if (!id) return null;

    const userLabel = String(
        session?.user_name ??
        session?.userName ??
        session?.user_email ??
        session?.userEmail ??
        session?.user ??
        ''
    ).trim();
    const displayUser = userLabel || 'Unknown User';

    const startedAtRaw =
        session?.started_at ??
        session?.startedAt ??
        session?.created_at ??
        session?.createdAt ??
        session?.opened_at ??
        session?.openedAt;
    const startedAtDate = parseSessionDate(startedAtRaw);
    const startedAtLabel = startedAtDate ? format(startedAtDate, 'PPpp') : '';
    const pumpName = SHOW_FUEL_FEATURES ? getSessionPumpName(session) : '';
    const hasPump = SHOW_FUEL_FEATURES ? Boolean(pumpName) : false;
    const pumpLabel = SHOW_FUEL_FEATURES
        ? (hasPump ? ` • Pump: ${pumpName}` : ' • No Pump')
        : '';

    const label = startedAtLabel
        ? `${displayUser} • ${startedAtLabel}${pumpLabel}`
        : `${displayUser}${pumpLabel}`;
    const sortValue = startedAtDate ? startedAtDate.getTime() : 0;

    return { id, label, sortValue, hasPump, pumpName: pumpName || undefined };
};

const getSessionChoicesFromResponse = (response: any): SessionChoice[] => {
    const rawSessions = Array.isArray(response?.results)
        ? response.results
        : Array.isArray(response)
        ? response
        : [];

    const uniqueChoices = new Map<string, SessionChoice>();
    for (const session of rawSessions) {
        const choice = buildSessionChoice(session);
        if (choice) {
            uniqueChoices.set(choice.id, choice);
        }
    }

    return Array.from(uniqueChoices.values()).sort((a, b) => b.sortValue - a.sortValue);
};

export const RecordWasteForm = ({
  branchId,
  inventoryItems,
  onFormSubmit,
  sessionId: propSessionId,
}: {
  branchId: string;
  inventoryItems: InventoryItem[];
  onFormSubmit: () => void;
  sessionId?: string; // NEW: Session ID to link waste to session
}) => {
    const { user } = useAuth();
    const { format: formatCurrency } = useCurrency();
    const formMethods = useForm<WasteFormValues>();
    const { handleSubmit, control, watch, formState: { errors }, setValue } = formMethods;
    const normalizedUserRole = String(user?.role || '').toLowerCase();
    const isAdminUser = normalizedUserRole === 'admin' || normalizedUserRole === 'owner' || normalizedUserRole === 'administrator';
    const manualSessionSelectionRef = React.useRef(false);

    const hasFuelItems = React.useMemo(
        () => (SHOW_FUEL_FEATURES ? inventoryItems.some((item) => Boolean(item.isFuel)) : false),
        [inventoryItems]
    );
    const hasNonFuelItems = React.useMemo(
        () => (SHOW_FUEL_FEATURES ? inventoryItems.some((item) => !Boolean(item.isFuel)) : true),
        [inventoryItems]
    );
    const canToggleFuelMode = SHOW_FUEL_FEATURES && hasFuelItems && hasNonFuelItems;
    const [isFuelMode, setIsFuelMode] = React.useState<boolean>(SHOW_FUEL_FEATURES && hasFuelItems && !hasNonFuelItems);

    React.useEffect(() => {
        if (!SHOW_FUEL_FEATURES) {
            return;
        }

        if (isFuelMode && !hasFuelItems && hasNonFuelItems) {
            setIsFuelMode(false);
        } else if (!isFuelMode && !hasNonFuelItems && hasFuelItems) {
            setIsFuelMode(true);
        }
    }, [hasFuelItems, hasNonFuelItems, isFuelMode]);

    const handleFuelModeToggle = React.useCallback((checked: boolean) => {
        if (!canToggleFuelMode) return;
        setIsFuelMode(checked);
        setValue('itemId', '');
        setValue('batchId', 0);
    }, [setValue, canToggleFuelMode]);

    // NEW: Get active session ID from Dexie if not provided as prop
    const [sessionId, setSessionId] = React.useState<string | undefined>(propSessionId);
    const [resolvedSessionHasPump, setResolvedSessionHasPump] = React.useState<boolean | null>(null);
    const [availableSessions, setAvailableSessions] = React.useState<SessionChoice[]>([]);
    const [isLoadingSessionChoices, setIsLoadingSessionChoices] = React.useState(false);
    
    React.useEffect(() => {
        let isCancelled = false;
        manualSessionSelectionRef.current = false;

        if (propSessionId) {
            setSessionId(propSessionId);
            setAvailableSessions([]);
            setIsLoadingSessionChoices(false);
            db.sessions
                .get(propSessionId)
                .then((session) => {
                    if (!isCancelled) {
                        setResolvedSessionHasPump(session ? getSessionHasPump(session) : null);
                    }
                })
                .catch(() => {
                    if (!isCancelled) {
                        setResolvedSessionHasPump(null);
                    }
                });
            return;
        }

        const fetchActiveSession = async () => {
            try {
                if (!branchId) {
                    if (!isCancelled) {
                        setSessionId(undefined);
                        setResolvedSessionHasPump(null);
                    }
                    return;
                }

                const backendBranchId = toBackendBranchId(branchId);
                let resolvedSessionId: string | undefined;
                let resolvedSessionHasPumpValue: boolean | null = null;

                try {
                    const backendSession = await authFetch.fetch<any>(
                        `/sessions/sessions/active/?branch_id=${encodeURIComponent(backendBranchId)}`
                    );

                    if (backendSession?.id) {
                        console.log('[Waste Form] Found active session from backend:', backendSession.id);
                        resolvedSessionId = String(backendSession.id);
                        resolvedSessionHasPumpValue = getSessionHasPump(backendSession);
                    }
                } catch (backendError) {
                    console.warn('[Waste Form] Backend active session fetch failed, falling back to Dexie:', backendError);
                }

                if (!resolvedSessionId) {
                    const normalizedBranchId = normalizeBranchId(branchId);
                    const currentUserId = String(user?.uid || '');
                    const currentUserEmail = String(user?.email || '').trim().toLowerCase();
                    const activeSessions = await db.sessions
                        .where('status')
                        .equals('active')
                        .toArray();

                    const activeSession = activeSessions
                        .filter((session) => {
                            if (normalizeBranchId(session.branchId) !== normalizedBranchId) {
                                return false;
                            }

                            const sessionUserId = String(session.userId || '');
                            const sessionUserEmail = String(session.userEmail || '').trim().toLowerCase();
                            return sessionUserId === currentUserId || (currentUserEmail !== '' && sessionUserEmail === currentUserEmail);
                        })
                        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
                    
                    if (activeSession?.id) {
                        console.log('[Waste Form] Found active session in Dexie:', activeSession.id);
                        resolvedSessionId = activeSession.id;
                        resolvedSessionHasPumpValue = getSessionHasPump(activeSession);
                    } else {
                        console.log('[Waste Form] No active session found in Dexie');
                    }
                }

                if (resolvedSessionId) {
                    if (!isCancelled && !manualSessionSelectionRef.current) {
                        setSessionId(resolvedSessionId);
                        setResolvedSessionHasPump(resolvedSessionHasPumpValue);
                    }
                    if (!isAdminUser) {
                        return;
                    }
                }

                if (!isAdminUser) {
                    if (!isCancelled) {
                        setSessionId(undefined);
                        setResolvedSessionHasPump(null);
                        setAvailableSessions([]);
                    }
                    return;
                }

                if (!isCancelled) {
                    setIsLoadingSessionChoices(true);
                }

                let resolvedChoices: SessionChoice[] = [];

                try {
                    const businessQuery = user?.businessId
                        ? `&business_id=${encodeURIComponent(String(user.businessId))}`
                        : '';
                    const activeListResponse = await authFetch.fetch<any>(
                        `/sessions/sessions/active_list/?branch_id=${encodeURIComponent(backendBranchId)}${businessQuery}`
                    );
                    resolvedChoices = getSessionChoicesFromResponse(activeListResponse);
                } catch (activeListError) {
                    console.warn('[Waste Form] Backend active_list fetch failed:', activeListError);
                }

                if (resolvedChoices.length === 0) {
                    try {
                        const normalizedBranchId = normalizeBranchId(branchId);
                        const activeSessions = await db.sessions
                            .where('status')
                            .equals('active')
                            .toArray();
                        const branchSessions = activeSessions.filter(
                            (session) => normalizeBranchId(session.branchId) === normalizedBranchId
                        );
                        resolvedChoices = getSessionChoicesFromResponse(branchSessions);
                    } catch (localError) {
                        console.warn('[Waste Form] Local active session lookup failed:', localError);
                    }
                }

                if (!isCancelled) {
                    setAvailableSessions(resolvedChoices);
                    if (!manualSessionSelectionRef.current && !resolvedSessionId) {
                        if (resolvedChoices.length === 1) {
                            setSessionId(resolvedChoices[0].id);
                            setResolvedSessionHasPump(resolvedChoices[0].hasPump);
                        } else {
                            setSessionId(undefined);
                            setResolvedSessionHasPump(null);
                        }
                    }
                    setIsLoadingSessionChoices(false);
                }
            } catch (error) {
                console.warn('[Waste Form] Failed to resolve session info:', error);
                if (!isCancelled) {
                    setSessionId(undefined);
                    setResolvedSessionHasPump(null);
                    setAvailableSessions([]);
                    setIsLoadingSessionChoices(false);
                }
            }
        };
        
        fetchActiveSession();

        return () => {
            isCancelled = true;
        };
    }, [propSessionId, branchId, user?.uid, user?.email, user?.businessId, isAdminUser]);

    const selectedItemId = watch("itemId");
    const filteredItems = React.useMemo(
        () => SHOW_FUEL_FEATURES ? inventoryItems.filter((item) => Boolean(item.isFuel) === isFuelMode) : inventoryItems,
        [inventoryItems, isFuelMode]
    );

    const batches = useLiveQuery(
        () => {
            if (!selectedItemId || !branchId) return [];
            return db.purchaseHistory
                .where('branchId')
                .equals(branchId)
                .filter(batch => batch.productId === selectedItemId && batch.quantityRemaining > 0)
                .toArray();
        },
        [selectedItemId, branchId]
    );

    const selectedBatchId = watch("batchId");
    const selectedBatch = batches?.find(b => b.id === selectedBatchId);
    const selectedItem = React.useMemo(() => {
        if (!selectedBatch) return undefined;
        return inventoryItems.find((item) => item.id === selectedBatch.productId);
    }, [selectedBatch, inventoryItems]);

    const requiredSessionKind: 'pump' | 'no_pump' = SHOW_FUEL_FEATURES && isFuelMode ? 'pump' : 'no_pump';

    const applicableSessions = React.useMemo(() => {
        if (!SHOW_FUEL_FEATURES) {
            return availableSessions;
        }
        const requiresPump = requiredSessionKind === 'pump';
        return availableSessions.filter((session) => session.hasPump === requiresPump);
    }, [availableSessions, requiredSessionKind]);

    const sessionHasPump = React.useMemo(() => {
        if (!sessionId) return null;
        const found = availableSessions.find((session) => session.id === sessionId);
        if (found) return found.hasPump;
        return resolvedSessionHasPump;
    }, [sessionId, availableSessions, resolvedSessionHasPump]);

    const hasSessionChoices = applicableSessions.length > 0;
    const shouldEnforceSessionMatch = isAdminUser ? hasSessionChoices : Boolean(sessionId);
    const sessionMatchesRequired = SHOW_FUEL_FEATURES
        ? sessionHasPump !== null && (requiredSessionKind === 'pump' ? sessionHasPump : !sessionHasPump)
        : true;
    const sessionMismatch = SHOW_FUEL_FEATURES
        ? Boolean(shouldEnforceSessionMatch && sessionId && !sessionMatchesRequired)
        : false;
    const needsSessionSelection =
        isAdminUser && Boolean(requiredSessionKind) && hasSessionChoices && !sessionId;
    const isWaitingForSessionChoices =
        isAdminUser && Boolean(requiredSessionKind) && hasSessionChoices && !sessionId && isLoadingSessionChoices;
    const shouldShowSessionSelector =
        isAdminUser && Boolean(requiredSessionKind) && hasSessionChoices && (isLoadingSessionChoices || needsSessionSelection || sessionMismatch);
    const shouldWarnNoSessions =
        isAdminUser && Boolean(requiredSessionKind) && !hasSessionChoices && !isLoadingSessionChoices;
    const sessionIdForSubmit =
        sessionId && (isAdminUser ? (hasSessionChoices ? sessionMatchesRequired : false) : sessionMatchesRequired)
            ? sessionId
            : undefined;
    const canSubmit =
        Boolean(selectedBatch) &&
        Boolean(selectedItem) &&
        !sessionMismatch &&
        !needsSessionSelection &&
        !isWaitingForSessionChoices;

    const onSubmit = async (data: WasteFormValues) => {
        if (!user) {
            toast({ variant: 'destructive', title: 'Not authenticated' });
            return;
        }
        if (!selectedBatch) {
            toast({ variant: 'destructive', title: 'Invalid batch selected' });
            return;
        }
        if (sessionMismatch) {
            toast({
                variant: 'destructive',
                title: 'Session type mismatch',
                description: SHOW_FUEL_FEATURES
                    ? (requiredSessionKind === 'pump'
                        ? 'Select a session with a pump for fuel items.'
                        : 'Select a session without a pump for non-fuel items.')
                    : 'Select a valid active session for this waste record.',
            });
            return;
        }
        if (needsSessionSelection) {
            toast({ variant: 'destructive', title: 'Select a session', description: 'Choose an active session to attribute this waste record.' });
            return;
        }
        if (!selectedItem) {
             toast({ variant: 'destructive', title: 'Invalid item selected' });
            return;
        }
        if (SHOW_FUEL_FEATURES && Boolean(selectedItem.isFuel) !== isFuelMode) {
            toast({
                variant: 'destructive',
                title: 'Item type mismatch',
                description: isFuelMode
                    ? 'Switch to non-fuel mode or choose a fuel item.'
                    : 'Switch to fuel mode or choose a non-fuel item.',
            });
            return;
        }

        const quantityWasted = Number(data.quantity);
        if (quantityWasted > selectedBatch.quantityRemaining) {
            toast({ variant: 'destructive', title: 'Not enough stock in batch', description: `Only ${selectedBatch.quantityRemaining} units available to waste in this batch.` });
            return;
        }

        try {
            // Use offline-first pattern: save locally first, sync later
            await db.transaction('rw', db.inventory, db.wasteLog, db.purchaseHistory, async () => {
                // 1. Decrement the specific batch with sync flags
                // Optimistically update local batch remaining without marking dirty (backend will adjust authoritatively)
                await db.purchaseHistory.update(selectedBatch.id!, {
                    quantityRemaining: selectedBatch.quantityRemaining - quantityWasted,
                });
                
                // 2. Decrement main inventory item's total stock with sync flags
                const newStock = (selectedItem.stockUnits || 0) - quantityWasted;
                // Optimistically update local inventory stock without marking dirty (avoid pushing duplicate decrement)
                await db.inventory.update(selectedItem.id, { 
                    stockUnits: newStock,
                });

                // 3. Create waste record with sync flags using UUID
                const wasteRecordId = uuidv4();
                const wasteRecord: WasteRecord = {
                    id: wasteRecordId,
                    branchId,
                    sessionId: sessionIdForSubmit, // Link waste to session if available
                    itemId: selectedItem.id,
                    itemName: selectedItem.name,
                    batchId: selectedBatch.id as any, // Track which batch was wasted for FIFO
                    quantity: quantityWasted,
                    unit: selectedItem.unitType,
                    cost: quantityWasted * selectedBatch.costPerUnit,
                    reason: data.reason,
                    notes: data.notes,
                    recordedBy: user.displayName || user.email,
                    recordedAt: new Date().toISOString(),
                    _dirty: true,
                    _operation: 'create'
                };
                
                console.log('[Waste] Waste record with batchId:', wasteRecordId, 'batchId:', selectedBatch.id);

                // Add waste record directly to database
                await db.wasteLog.add(wasteRecord);
                console.log('[Waste] Created waste record:', wasteRecordId);
                console.log('[Waste] Waste record data:', wasteRecord);
                console.log('[Waste] Waste record _dirty:', wasteRecord._dirty);
                console.log('[Waste] Waste record _operation:', wasteRecord._operation);

                // Log audit action
                await logAuditAction({
                    userId: user.uid,
                    userName: user.displayName || user.email || 'Unknown',
                    branchId: branchId,
                    actionType: 'STOCK_WASTE',
                    entityType: 'Waste',
                    entityId: wasteRecordId,
                    details: {
                        itemName: selectedItem.name,
                        quantity: quantityWasted,
                        reason: data.reason,
                        cost: quantityWasted * selectedBatch.costPerUnit,
                    },
                });
            });

            // Show success message
            const isOnline = typeof window !== 'undefined' && navigator.onLine;
            if (isOnline) {
                toast({ 
                    title: 'Waste Recorded', 
                    description: `${quantityWasted} ${selectedItem.unitType} of ${selectedItem.name} recorded as waste and syncing...` 
                });
                
                // Trigger sync AFTER transaction completes and success toast is shown
                console.log('[Waste] Triggering sync after waste recording');
                try {
                    await syncService.performFullSync(branchId);
                } catch (syncError) {
                    console.error('[Waste] Sync error (non-blocking):', syncError);
                    // Don't show error - sync errors are non-blocking
                }
            } else {
                toast({ 
                    title: 'Waste Recorded (Offline)', 
                    description: `${quantityWasted} ${selectedItem.unitType} of ${selectedItem.name} recorded. Will sync when online.` 
                });
                console.log('[Waste] Offline - waste record queued for sync');
            }
            
            onFormSubmit();
        } catch (error) {
            console.error('Failed to record waste:', error);
            toast({ variant: 'destructive', title: 'Error recording waste' });
        }
    };

    return (
        <FormProvider {...formMethods}>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-h-[70vh] overflow-y-auto scrollbar-hide pr-2">
                {SHOW_FUEL_FEATURES && (
                    <div className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-4">
                            <div className="space-y-1">
                                <p className="text-sm font-medium">Product Type</p>
                                <p className="text-xs text-muted-foreground">
                                    {isFuelMode
                                        ? 'Fuel items require a pump session.'
                                        : 'Non-fuel items require a non-pump session.'}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className={`text-xs ${!isFuelMode ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                    Non-fuel
                                </span>
                                <Switch
                                    checked={isFuelMode}
                                    onCheckedChange={handleFuelModeToggle}
                                    disabled={!canToggleFuelMode}
                                />
                                <span className={`text-xs ${isFuelMode ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                    Fuel
                                </span>
                            </div>
                        </div>
                        {!canToggleFuelMode && (
                            <p className="text-xs text-muted-foreground mt-2">
                                {hasFuelItems ? 'Only fuel items are available.' : 'Only non-fuel items are available.'}
                            </p>
                        )}
                    </div>
                )}
                {shouldShowSessionSelector && (
                    <FormItem>
                        <FormLabel>Assign to Session</FormLabel>
                        <Select
                            onValueChange={(value) => {
                                manualSessionSelectionRef.current = true;
                                setSessionId(value);
                                const selectedSession = applicableSessions.find((session) => session.id === value);
                                setResolvedSessionHasPump(selectedSession ? selectedSession.hasPump : null);
                            }}
                            value={sessionId || ''}
                        >
                            <FormControl>
                                <SelectTrigger disabled={isLoadingSessionChoices}>
                                    <SelectValue placeholder={isLoadingSessionChoices ? 'Loading sessions...' : 'Select an active session'} />
                                </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                                {applicableSessions.length > 0 ? (
                                    applicableSessions.map((session) => (
                                        <SelectItem key={session.id} value={session.id}>
                                            {session.label}
                                        </SelectItem>
                                    ))
                                ) : (
                                    <SelectItem value="loading" disabled>
                                        {isLoadingSessionChoices ? 'Loading sessions...' : 'No active sessions'}
                                    </SelectItem>
                                )}
                            </SelectContent>
                        </Select>
                        {needsSessionSelection && (
                            <p className="text-xs text-destructive">Select an active session to continue.</p>
                        )}
                        {sessionMismatch && (
                            <p className="text-xs text-destructive">
                                {requiredSessionKind === 'pump'
                                    ? 'Current session has no pump. Select a pump session.'
                                    : 'Current session has a pump. Select a non-pump session.'}
                            </p>
                        )}
                    </FormItem>
                )}
                {shouldWarnNoSessions && (
                    <div className="text-xs text-muted-foreground">
                        {SHOW_FUEL_FEATURES
                            ? (requiredSessionKind === 'pump'
                                ? 'No active pump sessions found for this branch.'
                                : 'No active non-pump sessions found for this branch.')
                            : 'No active sessions found for this branch.'}
                    </div>
                )}
                 <FormField
                    control={control}
                    name="itemId"
                    rules={{ required: "Please select an item." }}
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Item to Waste</FormLabel>
                            <Select onValueChange={(value) => {
                                field.onChange(value);
                                setValue("batchId", 0); // Reset batch selection
                            }}>
                                <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select an item" /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                                    {filteredItems.length > 0 ? (
                                        filteredItems.map(item => (
                                            <SelectItem key={item.id} value={item.id}>
                                                {item.name} (Available: {item.stockUnits || 0} {item.unitType})
                                            </SelectItem>
                                        ))
                                    ) : (
                                        <SelectItem value="no-items" disabled>
                                            No items available
                                        </SelectItem>
                                    )}
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
                            <FormLabel>Select Batch to Discard</FormLabel>
                            {!selectedItemId ? (
                                <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded border">
                                    Please select an item first
                                </div>
                            ) : !batches || batches.length === 0 ? (
                                <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded border">
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
                                                                <p className="text-foreground font-semibold">
                                                                    {getBatchReceivedLabel(batch)}
                                                                </p>
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
                        rules={{ required: "Quantity is required.", min: { value: 1, message: "Quantity must be at least 1."} }}
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Quantity Wasted</FormLabel>
                                <FormControl><Input type="number" step="1" min="1" max={selectedBatch?.quantityRemaining} {...field} /></FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                     <FormField
                        control={control}
                        name="reason"
                        rules={{ required: "Reason is required."}}
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Reason for Waste</FormLabel>
                                <Select onValueChange={field.onChange} defaultValue={field.value}>
                                    <FormControl><SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                        {wasteReasons.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>
                 <FormField
                    control={control}
                    name="notes"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Notes (Optional)</FormLabel>
                            <FormControl><Textarea placeholder="Add any extra details..." {...field} /></FormControl>
                        </FormItem>
                    )}
                />
                <DialogFooter>
                    <Button type="submit" disabled={!canSubmit}>Record Waste</Button>
                </DialogFooter>
            </form>
        </FormProvider>
    );
};
