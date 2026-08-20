'use client';

import React from 'react';
import { useForm, FormProvider, useFieldArray, useWatch } from 'react-hook-form';
import { format } from 'date-fns';
import { Plus, X, Calendar as CalendarIcon, Loader2, ChevronsUpDown, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';

import { db, type InventoryItem, type PurchaseRecord, type Supplier, type MRAMapping } from '@/lib/db';
import { type BusinessType } from '@/lib/inventory/config';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { logAuditAction } from '@/lib/audit';
import { syncService } from '@/lib/services/sync-service';
import { authFetch } from '@/lib/auth-fetch';
import { SHOW_FUEL_FEATURES } from '@/lib/fuel-features';
import { normalizePurchaseBatchQuantities } from '@/lib/purchase-quantity';
import { useAuth } from '@/hooks/use-auth';
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
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import type { EditablePurchaseGroup } from './purchase-editor-types';

type ReceiveStockFormValues = {
  supplierId?: string;
  referenceNumber?: string;
  vatAmount?: number;
  paymentStatus?: 'Paid' | 'Unpaid';
  items: {
    purchaseRecordId?: string;
    originalQuantityReceived?: number;
    originalQuantityRemaining?: number;
    originalSessionId?: string;
    productId: string;
    quantity: number | '';
    cost: number | '';
    sellingPrice?: number;
    taxRate?: number;
    taxCalculationMethod?: 'inclusive' | 'exclusive';
    batchNumber?: string;
    expiryDate?: Date;
  }[];
};

type ReceiveStockDraft = {
    supplierId?: string;
    referenceNumber?: string;
    paymentStatus?: 'Paid' | 'Unpaid';
    isFuelMode?: boolean;
    items?: {
        productId: string;
        quantity: number | '';
        cost: number | '';
        sellingPrice?: number;
        taxRate?: number;
        taxCalculationMethod?: 'inclusive' | 'exclusive';
        batchNumber?: string;
        expiryDate?: string;
    }[];
};

type ReceiveStockDraftItem = NonNullable<ReceiveStockDraft['items']>[number];

const RECEIVE_STOCK_DRAFT_STORAGE_KEY_PREFIX = 'handypos-receive-stock-draft';

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

const normalizeTaxRate = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const resolveTaxMethod = (value: unknown): 'inclusive' | 'exclusive' => {
    return value === 'inclusive' ? 'inclusive' : 'exclusive';
};

const toOptionalNumber = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const toNumberOrBlank = (value: unknown, fallback: number): number | '' => {
    if (value === '') {
        return '';
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOptionalDate = (value: unknown): Date | undefined => {
    if (!value) {
        return undefined;
    }
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const createEmptyReceiveStockItem = (): ReceiveStockFormValues['items'][number] => ({
    productId: '',
    quantity: 1,
    cost: 0,
    sellingPrice: undefined,
    taxRate: 0,
    taxCalculationMethod: 'exclusive',
    batchNumber: '',
});

const createDefaultReceiveStockValues = (): ReceiveStockFormValues => ({
    supplierId: '',
    referenceNumber: '',
    vatAmount: undefined,
    paymentStatus: 'Paid',
    items: [createEmptyReceiveStockItem()],
});

const normalizeDraftItem = (item: ReceiveStockDraft['items'][number] | undefined): ReceiveStockFormValues['items'][number] => ({
    productId: String(item?.productId || '').trim(),
    quantity: toNumberOrBlank(item?.quantity, 1),
    cost: toNumberOrBlank(item?.cost, 0),
    sellingPrice: toOptionalNumber(item?.sellingPrice),
    taxRate: normalizeTaxRate(item?.taxRate),
    taxCalculationMethod: resolveTaxMethod(item?.taxCalculationMethod),
    batchNumber: typeof item?.batchNumber === 'string' ? item.batchNumber : '',
    expiryDate: parseOptionalDate(item?.expiryDate),
});

const serializeDraftItem = (item: ReceiveStockFormValues['items'][number] | undefined): ReceiveStockDraftItem => ({
    productId: String(item?.productId || '').trim(),
    quantity: item?.quantity === '' ? '' : toNumberOrBlank(item?.quantity, 1),
    cost: item?.cost === '' ? '' : toNumberOrBlank(item?.cost, 0),
    sellingPrice: toOptionalNumber(item?.sellingPrice),
    taxRate: normalizeTaxRate(item?.taxRate),
    taxCalculationMethod: resolveTaxMethod(item?.taxCalculationMethod),
    batchNumber: typeof item?.batchNumber === 'string' ? item.batchNumber : '',
    expiryDate: item?.expiryDate ? item.expiryDate.toISOString() : undefined,
});

const normalizeReceiveStockDraft = (draft: ReceiveStockDraft | null | undefined): ReceiveStockFormValues => ({
    supplierId: typeof draft?.supplierId === 'string' ? draft.supplierId : '',
    referenceNumber: typeof draft?.referenceNumber === 'string' ? draft.referenceNumber : '',
    vatAmount: undefined,
    paymentStatus: draft?.paymentStatus === 'Unpaid' ? 'Unpaid' : 'Paid',
    items: Array.isArray(draft?.items) && draft.items.length > 0
        ? draft.items.map((item) => normalizeDraftItem(item))
        : [createEmptyReceiveStockItem()],
});

const normalizeSupplierMatchValue = (value: unknown): string => {
    return String(value || '').trim().toLowerCase();
};

const resolveSupplierNameForPurchase = (purchase: EditablePurchaseGroup): string => {
    const firstItem = purchase.items[0];
    const candidates = [purchase.supplierName, firstItem?.supplierName]
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0 && value.toLowerCase() !== 'no supplier');

    return candidates[0] || '';
};

const resolveSupplierIdForPurchase = (
    purchase: EditablePurchaseGroup,
    suppliers: Supplier[]
): string => {
    const purchaseSupplierId = String(purchase.supplierId || '').trim();
    if (purchaseSupplierId && suppliers.some((supplier) => String(supplier.id) === purchaseSupplierId)) {
        return purchaseSupplierId;
    }

    const firstItem = purchase.items[0];
    const itemSupplierId = String(firstItem?.supplierId || '').trim();
    if (itemSupplierId && suppliers.some((supplier) => String(supplier.id) === itemSupplierId)) {
        return itemSupplierId;
    }

    const supplierNameCandidates = [
        resolveSupplierNameForPurchase(purchase),
    ]
        .map((value) => normalizeSupplierMatchValue(value))
        .filter((value) => value && value !== 'no supplier');

    const matchedSupplier = supplierNameCandidates.length > 0
        ? suppliers.find((supplier) =>
            supplierNameCandidates.includes(normalizeSupplierMatchValue(supplier.name))
        )
        : undefined;

    if (matchedSupplier) {
        return String(matchedSupplier.id);
    }

    return purchaseSupplierId || itemSupplierId || '';
};

const buildSupplierFieldValueForPurchase = (
    purchase: EditablePurchaseGroup,
    suppliers: Supplier[]
): string => {
    const resolvedSupplierId = resolveSupplierIdForPurchase(purchase, suppliers);
    if (resolvedSupplierId) {
        return resolvedSupplierId;
    }

    const supplierName = resolveSupplierNameForPurchase(purchase);
    return supplierName ? `editing-supplier:${supplierName}` : '';
};

const buildReceiveStockValuesFromPurchase = (
    purchase: EditablePurchaseGroup,
    inventoryItems: InventoryItem[],
    suppliers: Supplier[]
): ReceiveStockFormValues => {
    const inventoryById = new Map(inventoryItems.map((item) => [String(item.id), item]));
    const resolvedSupplierId = buildSupplierFieldValueForPurchase(purchase, suppliers);
    const paymentStatus: 'Paid' | 'Unpaid' = purchase.paymentStatus === 'Paid' ? 'Paid' : 'Unpaid';
    const items = purchase.items.length > 0
        ? purchase.items.map((item) => {
            const normalizedQuantities = normalizePurchaseBatchQuantities(
                item.quantityReceived,
                item.quantityRemaining
            );

            return {
                purchaseRecordId: item.id ? String(item.id) : undefined,
                originalQuantityReceived: normalizedQuantities.quantityReceived,
                originalQuantityRemaining: normalizedQuantities.quantityRemaining,
                originalSessionId: item.sessionId,
                productId: String(item.productId || '').trim(),
                quantity: toNumberOrBlank(normalizedQuantities.quantityReceived, 1),
                cost: toNumberOrBlank(item.costPerUnit, 0),
                sellingPrice: toOptionalNumber(inventoryById.get(String(item.productId || '').trim())?.price),
                taxRate: normalizeTaxRate(item.taxRate),
                taxCalculationMethod: resolveTaxMethod(item.taxCalculationMethod),
                batchNumber: typeof item.batchNumber === 'string' ? item.batchNumber : '',
                expiryDate: parseOptionalDate(item.expiryDate),
            };
        })
        : [createEmptyReceiveStockItem()];

    return {
        supplierId: resolvedSupplierId,
        referenceNumber: purchase.referenceNumber || '',
        vatAmount: toOptionalNumber(purchase.vatAmount),
        paymentStatus,
        items,
    };
};

const getReceiveStockDraftStorageKey = (branchId: string, businessType: BusinessType): string => {
    const normalizedBranchId = normalizeBranchId(branchId) || String(branchId || 'default').trim() || 'default';
    return `${RECEIVE_STOCK_DRAFT_STORAGE_KEY_PREFIX}:${normalizedBranchId}:${businessType}`;
};

const isPriceLocked = (item?: InventoryItem | null): boolean => {
    return Boolean(item?.price_locked ?? item?.priceLocked);
};

const isTaxLocked = (item?: InventoryItem | null): boolean => {
    return Boolean(item?.tax_locked ?? item?.taxLocked);
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

const calculateItemVat = (
    costPerUnit: number,
    quantity: number,
    taxRate: number,
    method: 'inclusive' | 'exclusive'
): number => {
    const rate = normalizeTaxRate(taxRate);
    const base = Number(costPerUnit || 0) * Number(quantity || 0);
    if (!Number.isFinite(base) || base <= 0 || rate <= 0) return 0;
    if (method === 'inclusive') {
        return base - base / (1 + rate / 100);
    }
    return base * (rate / 100);
};

const calculateItemGross = (
    costPerUnit: number,
    quantity: number,
    vatAmount: number,
    method: 'inclusive' | 'exclusive'
): number => {
    const base = Number(costPerUnit || 0) * Number(quantity || 0);
    if (!Number.isFinite(base)) return 0;
    return method === 'exclusive' ? base + (vatAmount || 0) : base;
};

const purchaseRecordSortValue = (record: PurchaseRecord): number => {
    const candidates = [
        record.receivedDate,
        (record as any)?.createdAt,
        (record as any)?.updatedAt
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.getTime();
        }
    }

    return 0;
};

const mappingReadinessRank = (mapping: MRAMapping): number => {
    let score = 0;
    if (mapping.isApproved) score += 2;
    if (mapping.mraSynced) score += 1;
    return score;
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

export const ReceiveStockForm = ({
    branchId,
    businessType,
    inventoryItems,
    suppliers,
    onFormSubmit,
    editingPurchase,
}: {
    branchId: string;
    businessType: BusinessType;
    inventoryItems: InventoryItem[];
    suppliers: Supplier[];
    onFormSubmit: () => void;
    editingPurchase?: EditablePurchaseGroup | null;
}) => {
    const { user } = useAuth();
    const isEditMode = Boolean(editingPurchase);
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const isSubmittingRef = React.useRef(false);
    const normalizedUserRole = String(user?.role || '').toLowerCase();
    const isAdminUser = normalizedUserRole === 'admin' || normalizedUserRole === 'owner' || normalizedUserRole === 'administrator';
    const manualSessionSelectionRef = React.useRef(false);
    const shouldAutoOpenNewProductPickerRef = React.useRef(false);
    const productSearchInputRefs = React.useRef<Record<string, HTMLInputElement | null>>({});
    const hasHydratedDraftRef = React.useRef(false);
    
    // NEW: Get active session ID from Dexie (same pattern as waste form)
    const [sessionId, setSessionId] = React.useState<string | undefined>(undefined);
    const [resolvedSessionHasPump, setResolvedSessionHasPump] = React.useState<boolean | null>(null);
    const [availableSessions, setAvailableSessions] = React.useState<SessionChoice[]>([]);
    const [isLoadingSessionChoices, setIsLoadingSessionChoices] = React.useState(false);
    const [productSearchTerms, setProductSearchTerms] = React.useState<Record<string, string>>({});
    const [productPickerOpen, setProductPickerOpen] = React.useState<Record<string, boolean>>({});
    const editingSessionId = React.useMemo(
        () =>
            editingPurchase?.items
                .map((item) => String(item.sessionId || '').trim())
                .find((value) => value.length > 0),
        [editingPurchase]
    );
    const editingRequiresFuelSession = React.useMemo(
        () =>
            Boolean(
                editingPurchase?.items.some((item) => {
                    const product = inventoryItems.find(
                        (candidate) => String(candidate.id) === String(item.productId || '').trim()
                    );
                    return Boolean(product?.isFuel);
                })
            ),
        [editingPurchase, inventoryItems]
    );
    
    React.useEffect(() => {
        let isCancelled = false;
        manualSessionSelectionRef.current = false;
        setAvailableSessions([]);
        setIsLoadingSessionChoices(false);

        const fetchActiveSession = async () => {
            try {
                if (!branchId) {
                    if (!isCancelled) {
                        setSessionId(undefined);
                        setResolvedSessionHasPump(null);
                    }
                    return;
                }

                if (editingPurchase) {
                    if (!isCancelled) {
                        manualSessionSelectionRef.current = true;
                        setSessionId(editingSessionId || undefined);
                        setResolvedSessionHasPump(editingSessionId ? editingRequiresFuelSession : null);
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
                        console.log('[ReceiveStockForm] Found active session from backend:', backendSession.id);
                        resolvedSessionId = String(backendSession.id);
                        resolvedSessionHasPumpValue = getSessionHasPump(backendSession);
                    }
                } catch (backendError) {
                    console.warn('[ReceiveStockForm] Backend active session fetch failed, falling back to Dexie:', backendError);
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
                        console.log('[ReceiveStockForm] Found active session in Dexie:', activeSession.id);
                        resolvedSessionId = activeSession.id;
                        resolvedSessionHasPumpValue = getSessionHasPump(activeSession);
                    } else {
                        console.log('[ReceiveStockForm] No active session found in Dexie');
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
                    console.warn('[ReceiveStockForm] Backend active_list fetch failed:', activeListError);
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
                        console.warn('[ReceiveStockForm] Local active session lookup failed:', localError);
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
                console.warn('[ReceiveStockForm] Failed to resolve session info:', error);
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
    }, [
        branchId,
        user?.uid,
        user?.email,
        user?.businessId,
        isAdminUser,
        editingPurchase,
        editingSessionId,
        editingRequiresFuelSession,
    ]);
    
    // Log suppliers received
    React.useEffect(() => {
        console.log('[ReceiveStockForm] Suppliers received:', suppliers.length);
        console.log('[ReceiveStockForm] Suppliers data:', suppliers);
    }, [suppliers]);
    
    const form = useForm<ReceiveStockFormValues>({
        defaultValues: createDefaultReceiveStockValues(),
    });
    const { control, handleSubmit, setValue, getValues, reset } = form;
    const { fields, append, remove, replace } = useFieldArray({
        control,
        name: "items",
    });

    React.useEffect(() => {
        if (!shouldAutoOpenNewProductPickerRef.current || fields.length === 0) {
            return;
        }

        const newestFieldId = fields[fields.length - 1]?.id;
        if (!newestFieldId) {
            shouldAutoOpenNewProductPickerRef.current = false;
            return;
        }

        shouldAutoOpenNewProductPickerRef.current = false;
        setProductSearchTerms((current) => ({
            ...current,
            [newestFieldId]: '',
        }));
        setProductPickerOpen((current) => ({
            ...current,
            [newestFieldId]: true,
        }));
    }, [fields]);

    const supplierId = useWatch({ control, name: "supplierId" });
    const watchedItems = useWatch({ control, name: "items" }) || [];
    const hasFuelItems = React.useMemo(
        () => (SHOW_FUEL_FEATURES ? inventoryItems.some((item) => Boolean(item.isFuel)) : false),
        [inventoryItems]
    );
    const hasNonFuelItems = React.useMemo(
        () => (SHOW_FUEL_FEATURES ? inventoryItems.some((item) => !Boolean(item.isFuel)) : true),
        [inventoryItems]
    );
    const canToggleFuelMode = SHOW_FUEL_FEATURES && hasFuelItems && hasNonFuelItems;
    const defaultFuelMode = SHOW_FUEL_FEATURES ? (hasFuelItems && !hasNonFuelItems) : false;
    const defaultFuelModeRef = React.useRef(defaultFuelMode);
    const [isFuelMode, setIsFuelMode] = React.useState<boolean>(defaultFuelMode);
    const draftStorageKey = React.useMemo(
        () => getReceiveStockDraftStorageKey(branchId, businessType),
        [branchId, businessType]
    );
    const referenceNumberValue = useWatch({ control, name: "referenceNumber" });
    const paymentStatusValue = useWatch({ control, name: "paymentStatus" });
    const supplierOptions = React.useMemo(() => {
        if (!editingPurchase) {
            return suppliers;
        }

        const supplierFieldValue = buildSupplierFieldValueForPurchase(editingPurchase, suppliers);
        const supplierName = resolveSupplierNameForPurchase(editingPurchase);
        if (!supplierFieldValue || !supplierName) {
            return suppliers;
        }

        const alreadyPresent = suppliers.some((supplier) => {
            const supplierId = String(supplier.id || '').trim();
            return (
                supplierId === supplierFieldValue ||
                normalizeSupplierMatchValue(supplier.name) === normalizeSupplierMatchValue(supplierName)
            );
        });

        if (alreadyPresent) {
            return suppliers;
        }

        return [
            {
                id: supplierFieldValue,
                name: supplierName,
                businessId: user?.businessId || undefined,
                branchId: branchId || undefined,
            } as Supplier,
            ...suppliers,
        ];
    }, [editingPurchase, suppliers, user?.businessId, branchId]);
    const editingPurchaseSupplierName = React.useMemo(
        () => (editingPurchase ? resolveSupplierNameForPurchase(editingPurchase) : ''),
        [editingPurchase]
    );
    const hasOpenProductPicker = React.useMemo(
        () => Object.values(productPickerOpen).some(Boolean),
        [productPickerOpen]
    );

    React.useEffect(() => {
        defaultFuelModeRef.current = defaultFuelMode;
    }, [defaultFuelMode]);

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

    const clearDraft = React.useCallback(() => {
        if (typeof window === 'undefined') {
            return;
        }

        localStorage.removeItem(draftStorageKey);
    }, [draftStorageKey]);

    const saveDraft = React.useCallback((showToast = false) => {
        if (isEditMode) {
            return false;
        }

        if (typeof window === 'undefined') {
            return false;
        }

        try {
            const values = getValues();
            const draftItems = Array.isArray(values.items) && values.items.length > 0
                ? values.items.map((item) => serializeDraftItem(item))
                : [serializeDraftItem(createEmptyReceiveStockItem())];
            const draftPayload: ReceiveStockDraft = {
                supplierId: typeof values.supplierId === 'string' ? values.supplierId : '',
                referenceNumber: typeof values.referenceNumber === 'string' ? values.referenceNumber : '',
                paymentStatus: values.paymentStatus === 'Unpaid' ? 'Unpaid' : 'Paid',
                isFuelMode,
                items: draftItems,
            };

            localStorage.setItem(draftStorageKey, JSON.stringify(draftPayload));

            if (showToast) {
                toast({
                    title: 'Draft saved',
                    description: 'Receive stock draft saved locally.',
                });
            }

            return true;
        } catch (error) {
            console.error('[ReceiveStockForm] Failed to save draft:', error);

            if (showToast) {
                toast({
                    variant: 'destructive',
                    title: 'Failed to save draft',
                    description: 'Your receive stock draft could not be saved.',
                });
            }

            return false;
        }
    }, [draftStorageKey, getValues, isFuelMode, isEditMode]);

    React.useEffect(() => {
        const shouldPreserveCurrentValues =
            hasHydratedDraftRef.current && (form.formState.isDirty || hasOpenProductPicker);

        if (shouldPreserveCurrentValues) {
            return;
        }

        hasHydratedDraftRef.current = false;

        try {
            if (editingPurchase) {
                reset(buildReceiveStockValuesFromPurchase(editingPurchase, inventoryItems, suppliers));
                setIsFuelMode(editingRequiresFuelSession);
                return;
            }

            const rawDraft = typeof window !== 'undefined'
                ? localStorage.getItem(draftStorageKey)
                : null;

            if (rawDraft) {
                const parsedDraft = JSON.parse(rawDraft) as ReceiveStockDraft;
                reset(normalizeReceiveStockDraft(parsedDraft));
                if (typeof parsedDraft.isFuelMode === 'boolean') {
                    setIsFuelMode(parsedDraft.isFuelMode);
                } else {
                    setIsFuelMode(defaultFuelModeRef.current);
                }
            } else {
                reset(createDefaultReceiveStockValues());
                setIsFuelMode(defaultFuelModeRef.current);
            }
        } catch (error) {
            console.error('[ReceiveStockForm] Failed to restore draft:', error);
            reset(createDefaultReceiveStockValues());
            setIsFuelMode(defaultFuelModeRef.current);
        } finally {
            hasHydratedDraftRef.current = true;
        }
    }, [
        draftStorageKey,
        reset,
        editingPurchase,
        inventoryItems,
        suppliers,
        editingRequiresFuelSession,
        form.formState.isDirty,
        hasOpenProductPicker,
    ]);

    React.useEffect(() => {
        if (!hasHydratedDraftRef.current || isSubmitting || typeof window === 'undefined' || isEditMode) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            saveDraft(false);
        }, 400);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [supplierId, referenceNumberValue, paymentStatusValue, watchedItems, isFuelMode, isSubmitting, saveDraft, isEditMode]);

    const canToggleFuelModeInForm = canToggleFuelMode && !isEditMode;

    const handleFuelModeToggle = React.useCallback((checked: boolean) => {
        if (!canToggleFuelModeInForm) return;
        setIsFuelMode(checked);
        replace([createEmptyReceiveStockItem()]);
    }, [replace, canToggleFuelModeInForm]);

    const supplierFilteredProducts = supplierId 
        ? inventoryItems.filter(item => {
            // Match by supplier ID or supplier name
            const itemSupplier = supplierOptions.find(s => String(s.id) === String(supplierId));
            const matches = item.supplier === itemSupplier?.name || item.supplier === itemSupplier?.id;
            console.log('[ReceiveStockForm] Checking item:', item.name, 'supplier:', item.supplier, 'matches:', matches, 'isProduced:', item.isProduced);
            return matches && !item.isProduced;
          })
        : inventoryItems.filter(item => !item.isProduced);

    const filteredProducts = SHOW_FUEL_FEATURES
        ? supplierFilteredProducts.filter((item) => Boolean(item.isFuel) === isFuelMode)
        : supplierFilteredProducts;

    const mraMappings = useLiveQuery(
        async () => {
            const allMappings = await db.mraMappings.toArray();
            const normalizedBranchId = normalizeBranchId(branchId);
            return allMappings.filter((mapping) => {
                if (!mapping.branchId) return true;
                return normalizeBranchId(mapping.branchId) === normalizedBranchId;
            });
        },
        [branchId],
        []
    ) || [];

    const mappingByItemId = React.useMemo(() => {
        const map = new Map<string, MRAMapping>();
        for (const mapping of mraMappings) {
            const existing = map.get(mapping.inventoryItemId);
            if (!existing || mappingReadinessRank(mapping) > mappingReadinessRank(existing)) {
                map.set(mapping.inventoryItemId, mapping);
            }
        }
        return map;
    }, [mraMappings]);

    const lastPurchaseByProduct = useLiveQuery(
        async () => {
            const normalizedBranchId = normalizeBranchId(branchId);
            const allRecords = await db.purchaseHistory.toArray();
            const latestByProduct = new Map<string, PurchaseRecord>();

            for (const record of allRecords) {
                if (!record?.productId) continue;
                if (normalizeBranchId(record.branchId) !== normalizedBranchId) continue;

                const existing = latestByProduct.get(record.productId);
                if (!existing) {
                    latestByProduct.set(record.productId, record);
                    continue;
                }

                if (purchaseRecordSortValue(record) > purchaseRecordSortValue(existing)) {
                    latestByProduct.set(record.productId, record);
                }
            }

            return latestByProduct;
        },
        [branchId],
        new Map<string, PurchaseRecord>()
    );

    const getDefaultTaxForProduct = React.useCallback(
        (productId: string) => {
            const mapping = mappingByItemId.get(productId);
            const lastPurchase = lastPurchaseByProduct?.get(productId);
            const lastPurchaseMethod = lastPurchase?.taxCalculationMethod
                ? resolveTaxMethod(lastPurchase.taxCalculationMethod)
                : undefined;
            const hasLastPurchaseRate = lastPurchase?.taxRate !== undefined && lastPurchase?.taxRate !== null;
            const lastPurchaseRate = hasLastPurchaseRate
                ? normalizeTaxRate(lastPurchase?.taxRate)
                : undefined;

            if (!mapping) {
                return {
                    taxRate: lastPurchaseRate ?? 0,
                    taxCalculationMethod: lastPurchaseMethod ?? 'exclusive'
                };
            }

            return {
                taxRate: lastPurchaseRate ?? normalizeTaxRate(mapping.mraTaxRate),
                taxCalculationMethod: lastPurchaseMethod ?? resolveTaxMethod(mapping.taxCalculationMethod)
            };
        },
        [mappingByItemId, lastPurchaseByProduct]
    );

    const selectedProductIds = React.useMemo(() => {
        const selected = new Set<string>();
        for (const item of watchedItems) {
            const productId = String(item?.productId || '').trim();
            if (productId) {
                selected.add(productId);
            }
        }
        return selected;
    }, [watchedItems]);

    const getAvailableProductsForRow = React.useCallback((rowIndex: number) => {
        const currentProductId = String(watchedItems?.[rowIndex]?.productId || '').trim();
        const currentProduct = inventoryItems.find((product) => product.id === currentProductId);
        const rowProducts = currentProduct && !filteredProducts.some((product) => product.id === currentProductId)
            ? [currentProduct, ...filteredProducts]
            : filteredProducts;

        return rowProducts.filter((product) => {
            if (product.id === currentProductId) return true;
            return !selectedProductIds.has(product.id);
        });
    }, [filteredProducts, inventoryItems, selectedProductIds, watchedItems]);

    const filterProductsBySearch = React.useCallback((products: InventoryItem[], searchTerm: string) => {
        const normalizedSearch = String(searchTerm || '').trim().toLowerCase();
        if (!normalizedSearch) {
            return products;
        }

        return products.filter((product) =>
            [
                product.name,
                product.category,
                product.supplier,
                product.productCode,
                product.sku,
                product.barcode,
            ]
                .map((value) => String(value || '').toLowerCase())
                .some((value) => value.includes(normalizedSearch))
        );
    }, []);

    const handleProductSelect = React.useCallback((
        rowIndex: number,
        rowFieldId: string,
        productId: string,
        availableProducts: InventoryItem[],
        onChange: (value: string) => void
    ) => {
        const product = availableProducts.find((item) => item.id === productId);
        onChange(productId);

        if (product) {
            setValue(`items.${rowIndex}.cost`, Number(product.cost || 0), {
                shouldDirty: true,
                shouldTouch: true,
            });
            setValue(
                `items.${rowIndex}.sellingPrice`,
                toOptionalNumber(product.price) ?? 0,
                {
                    shouldDirty: true,
                    shouldTouch: true,
                }
            );
            const taxDefaults = getDefaultTaxForProduct(product.id);
            setValue(`items.${rowIndex}.taxRate`, taxDefaults.taxRate, {
                shouldDirty: true,
                shouldTouch: true,
            });
            setValue(`items.${rowIndex}.taxCalculationMethod`, taxDefaults.taxCalculationMethod, {
                shouldDirty: true,
                shouldTouch: true,
            });
        }

        const currentQty = Number(getValues(`items.${rowIndex}.quantity`) || 0);
        if (!currentQty || currentQty <= 0) {
            setValue(`items.${rowIndex}.quantity`, 1, {
                shouldDirty: true,
                shouldTouch: true,
            });
        }

        setProductSearchTerms((current) => ({
            ...current,
            [rowFieldId]: '',
        }));
        setProductPickerOpen((current) => ({
            ...current,
            [rowFieldId]: false,
        }));
    }, [getDefaultTaxForProduct, getValues, setValue]);

    const handleAddItem = React.useCallback(() => {
        shouldAutoOpenNewProductPickerRef.current = true;
        append(createEmptyReceiveStockItem());
    }, [append]);

    const liveTotals = React.useMemo(() => {
        const items = (watchedItems || []).filter(
            (item) => item?.productId && String(item.productId).trim() !== ''
        );
        const totalItems = items.length;
        const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        const totalCost = items.reduce(
            (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.cost) || 0),
            0
        );
        const totalVat = items.reduce((sum, item) => {
            const rate = normalizeTaxRate(item.taxRate);
            const method = resolveTaxMethod(item.taxCalculationMethod);
            return sum + calculateItemVat(Number(item.cost || 0), Number(item.quantity || 0), rate, method);
        }, 0);
        const totalWithVat = items.reduce((sum, item) => {
            const rate = normalizeTaxRate(item.taxRate);
            const method = resolveTaxMethod(item.taxCalculationMethod);
            const vatAmount = calculateItemVat(Number(item.cost || 0), Number(item.quantity || 0), rate, method);
            return sum + calculateItemGross(Number(item.cost || 0), Number(item.quantity || 0), vatAmount, method);
        }, 0);
        return { totalItems, totalQuantity, totalCost, totalVat, totalWithVat };
    }, [watchedItems]);

    React.useEffect(() => {
        const roundedVat = Math.round(liveTotals.totalVat * 100) / 100;
        setValue('vatAmount', Number.isFinite(roundedVat) ? roundedVat : 0, {
            shouldDirty: false,
            shouldTouch: false,
        });
    }, [liveTotals.totalVat, setValue]);

    const requiredSessionKind: 'pump' | 'no_pump' = SHOW_FUEL_FEATURES && isFuelMode ? 'pump' : 'no_pump';

    const applicableSessions = React.useMemo(() => {
        if (!SHOW_FUEL_FEATURES) {
            return availableSessions;
        }
        const requiresPump = requiredSessionKind === 'pump';
        return availableSessions.filter((session) => session.hasPump === requiresPump);
    }, [availableSessions, requiredSessionKind]);

    const enforceSessionKind = !isEditMode;

    const sessionHasPump = React.useMemo(() => {
        if (!sessionId) return null;
        const found = availableSessions.find((session) => session.id === sessionId);
        if (found) return found.hasPump;
        return resolvedSessionHasPump;
    }, [sessionId, availableSessions, resolvedSessionHasPump]);

    const hasSessionChoices = applicableSessions.length > 0;
    const shouldEnforceSessionMatch = enforceSessionKind && (isAdminUser ? hasSessionChoices : Boolean(sessionId));
    const sessionMatchesRequired = SHOW_FUEL_FEATURES
        ? sessionHasPump !== null && (requiredSessionKind === 'pump' ? sessionHasPump : !sessionHasPump)
        : true;
    const sessionMismatch = SHOW_FUEL_FEATURES
        ? Boolean(shouldEnforceSessionMatch && sessionId && !sessionMatchesRequired)
        : false;
    const needsSessionSelection =
        isAdminUser && enforceSessionKind && hasSessionChoices && !sessionId;
    const isWaitingForSessionChoices =
        isAdminUser && enforceSessionKind && hasSessionChoices && !sessionId && isLoadingSessionChoices;
    const shouldShowSessionSelector =
        isAdminUser && enforceSessionKind && hasSessionChoices && (isLoadingSessionChoices || needsSessionSelection || sessionMismatch);
    const shouldWarnNoSessions =
        isAdminUser && enforceSessionKind && !hasSessionChoices && !isLoadingSessionChoices;
    const sessionIdForSubmit =
        isEditMode
            ? (sessionId || editingSessionId)
            : sessionId && (isAdminUser ? (hasSessionChoices ? sessionMatchesRequired : false) : sessionMatchesRequired)
                ? sessionId
                : undefined;
    const isSubmitDisabled =
        isSubmitting ||
        sessionMismatch ||
        needsSessionSelection ||
        isWaitingForSessionChoices;
    
    // Log for debugging
    React.useEffect(() => {
        console.log('[ReceiveStockForm] supplierId:', supplierId);
        console.log('[ReceiveStockForm] inventoryItems:', inventoryItems.length);
        console.log('[ReceiveStockForm] inventoryItems sample:', inventoryItems.slice(0, 3).map(i => ({ id: i.id, name: i.name, supplier: i.supplier })));
    }, [supplierId, inventoryItems]);
    
    React.useEffect(() => {
        console.log('[ReceiveStockForm] filteredProducts:', filteredProducts.length);
        console.log('[ReceiveStockForm] filteredProducts:', filteredProducts.map(p => ({ id: p.id, name: p.name, supplier: p.supplier })));
    }, [filteredProducts]);

    const onSubmit = async (data: ReceiveStockFormValues) => {
        if (!user) {
            toast({ variant: 'destructive', title: "User not found" });
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
                    : 'Select a valid active session for this receipt.',
            });
            return;
        }

        if (needsSessionSelection) {
            toast({ variant: 'destructive', title: 'Select a session', description: 'Choose an active session to attribute this stock receipt.' });
            return;
        }

        if (SHOW_FUEL_FEATURES) {
            const mismatchedItems = (data.items || []).filter((item) => {
                const productId = String(item?.productId || '').trim();
                if (!productId) return false;
                const product = inventoryItems.find((candidate) => String(candidate.id) === productId);
                if (!product) return false;
                return Boolean(product.isFuel) !== isFuelMode;
            });
            if (mismatchedItems.length > 0) {
                toast({
                    variant: 'destructive',
                    title: 'Item type mismatch',
                    description: isFuelMode
                        ? 'Switch to non-fuel mode or remove non-fuel items from this receipt.'
                        : 'Switch to fuel mode or remove fuel items from this receipt.',
                });
                return;
            }
        }

        if (isSubmittingRef.current) {
            return;
        }
        isSubmittingRef.current = true;
        setIsSubmitting(true);

        const selectedSupplier = data.supplierId
            ? supplierOptions.find((s) => String(s.id) === String(data.supplierId))
            : null;
        const isSyntheticEditingSupplier = Boolean(
            selectedSupplier?.id && String(selectedSupplier.id).startsWith('editing-supplier:')
        );
        const editingPurchaseFirstItem = editingPurchase?.items[0];
        const selectedSupplierId = selectedSupplier
            ? isSyntheticEditingSupplier
                ? String(editingPurchase?.supplierId || editingPurchaseFirstItem?.supplierId || '').trim() || undefined
                : String(selectedSupplier.id)
            : undefined;
        const selectedSupplierName = selectedSupplier?.name
            || editingPurchaseSupplierName
            || 'No Supplier';
        const paymentStatus: 'Paid' | 'Unpaid' = data.paymentStatus === 'Unpaid' ? 'Unpaid' : 'Paid';
        const referenceNumber = data.referenceNumber?.trim() || undefined;

        try {
            // Filter out items with empty productId
            const validItems = data.items.filter(item => item.productId && item.productId.trim() !== '');
            
            if (validItems.length === 0) {
                toast({ variant: 'destructive', title: 'Please add at least one item' });
                return;
            }

            const purchaseRecordIds: string[] = [];
            const totalCost = validItems.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.cost)), 0);
            const totalVat = validItems.reduce((sum, item) => {
                const mappingDefaults = getDefaultTaxForProduct(item.productId);
                const taxRate = normalizeTaxRate(item.taxRate ?? mappingDefaults.taxRate);
                const taxMethod = resolveTaxMethod(item.taxCalculationMethod ?? mappingDefaults.taxCalculationMethod);
                return sum + calculateItemVat(Number(item.cost || 0), Number(item.quantity || 0), taxRate, taxMethod);
            }, 0);
            const totalWithVat = validItems.reduce((sum, item) => {
                const mappingDefaults = getDefaultTaxForProduct(item.productId);
                const taxRate = normalizeTaxRate(item.taxRate ?? mappingDefaults.taxRate);
                const taxMethod = resolveTaxMethod(item.taxCalculationMethod ?? mappingDefaults.taxCalculationMethod);
                const itemVat = calculateItemVat(Number(item.cost || 0), Number(item.quantity || 0), taxRate, taxMethod);
                return sum + calculateItemGross(Number(item.cost || 0), Number(item.quantity || 0), itemVat, taxMethod);
            }, 0);
            const vatAmount = Number.isFinite(totalVat) ? totalVat : 0;
            const amountPaid = paymentStatus === 'Paid' ? totalWithVat : 0;
            const amountDue = paymentStatus === 'Paid' ? 0 : totalWithVat;
            const nowIso = new Date().toISOString();
            const poId = editingPurchase?.purchaseOrderId || editingPurchase?.groupId || uuidv4();
            const baseReceivedAt = Date.now();
            const deletedLineWarnings: string[] = [];
            let purchaseOrderSyncOperation: 'create' | 'update' = isEditMode ? 'update' : 'create';
            
            console.log('[Purchases] Form submission - validItems:', validItems);
            console.log('[Purchases] Calculated totalCost:', totalCost);
            console.log('[Purchases] Calculated totalItems:', validItems.length);

            const applyInventoryPurchaseUpdate = async ({
                product,
                stockDelta,
                nextCostPerUnit,
                nextSellingPrice,
                updateSellingPrice,
            }: {
                product: InventoryItem;
                stockDelta: number;
                nextCostPerUnit: number;
                nextSellingPrice?: number;
                updateSellingPrice: boolean;
            }) => {
                const currentStock = Number(product.stockUnits || 0);
                const nextStock = currentStock + stockDelta;

                if (nextStock < -0.0001) {
                    throw new Error(`Not enough stock available to update ${product.name}.`);
                }

                const safeNextStock = Math.max(0, nextStock);
                const nextValue = Number.isFinite(safeNextStock * nextCostPerUnit)
                    ? Number((safeNextStock * nextCostPerUnit).toFixed(2))
                    : product.value;
                const inventoryUpdate: Partial<InventoryItem> = {
                    stockUnits: safeNextStock,
                    cost: nextCostPerUnit,
                    value: nextValue,
                    status: resolveInventoryStatus(safeNextStock, Number(product.reorderLevel || 0)),
                    _purchaseSyncPending: true,
                };

                if (updateSellingPrice && nextSellingPrice !== undefined) {
                    inventoryUpdate.price = nextSellingPrice;
                }

                await db.inventory.update(product.id, inventoryUpdate);
            };

            await db.transaction('rw', db.inventory, db.purchaseHistory, db.purchaseOrders, async () => {
                const currentOrder = isEditMode ? await db.purchaseOrders.get(poId) : undefined;
                const currentRecords = new Map<string, PurchaseRecord>();
                const retainedRecordIds = new Set<string>();
                const itemSnapshots: Array<{
                    id: string;
                    inventoryItemId: string;
                    quantityOrdered: number;
                    quantityRemaining: number;
                    quantityReceived: number;
                    costPerUnit: number;
                }> = [];

                if (editingPurchase) {
                    for (const originalRecord of editingPurchase.items) {
                        const recordId = String(originalRecord.id || '').trim();
                        if (!recordId) {
                            continue;
                        }

                        const currentRecord = await db.purchaseHistory.get(originalRecord.id as any);
                        if (currentRecord) {
                            currentRecords.set(recordId, currentRecord);
                        }
                    }
                }

                for (const [index, item] of validItems.entries()) {
                    const submittedProductId = String(item.productId || '').trim();
                    const quantityReceived = Number(item.quantity);
                    if (!submittedProductId || !Number.isFinite(quantityReceived) || quantityReceived <= 0) {
                        throw new Error('Each purchase line needs a product and a quantity greater than zero.');
                    }

                    const product = await db.inventory.get(submittedProductId);
                    if (!product) {
                        throw new Error('One of the selected products could not be found locally. Please refresh inventory and try again.');
                    }

                    const costPerUnit = Number(item.cost);
                    const itemTotalCost = quantityReceived * costPerUnit;
                    const taxDefaults = getDefaultTaxForProduct(product.id);
                    const taxRate = normalizeTaxRate(item.taxRate ?? taxDefaults.taxRate);
                    const taxMethod = resolveTaxMethod(item.taxCalculationMethod ?? taxDefaults.taxCalculationMethod);
                    const itemVatAmount = calculateItemVat(costPerUnit, quantityReceived, taxRate, taxMethod);
                    const itemGross = calculateItemGross(costPerUnit, quantityReceived, itemVatAmount, taxMethod);
                    const normalizedCostPerUnit = Number.isFinite(costPerUnit)
                        ? Number(costPerUnit.toFixed(4))
                        : Number(product.cost || 0);
                    const submittedSellingPrice = Number(item.sellingPrice);
                    const hasSubmittedSellingPrice =
                        item.sellingPrice !== undefined &&
                        item.sellingPrice !== null &&
                        Number.isFinite(submittedSellingPrice) &&
                        submittedSellingPrice >= 0;
                    const normalizedSellingPrice = hasSubmittedSellingPrice
                        ? Number(submittedSellingPrice.toFixed(2))
                        : undefined;
                    const currentSellingPrice = toOptionalNumber(product.price);
                    const productPriceLocked = isPriceLocked(product);
                    const receivedDate = new Date(baseReceivedAt + index).toISOString();
                    const purchaseRecordId = String(item.purchaseRecordId || '').trim();
                    const existingRecord = purchaseRecordId ? currentRecords.get(purchaseRecordId) : undefined;

                    if (existingRecord) {
                        retainedRecordIds.add(purchaseRecordId);

                        if (String(existingRecord.productId || '').trim() !== submittedProductId) {
                            throw new Error('Existing purchase lines keep their original product. Remove the line and add a new one if you need a different product.');
                        }

                        const currentQuantityRemaining = Math.max(0, Number(existingRecord.quantityRemaining || 0));
                        const currentQuantityReceived = Math.max(0, Number(existingRecord.quantityReceived || 0));
                        const consumedQuantity = Math.max(0, currentQuantityReceived - currentQuantityRemaining);

                        if (quantityReceived < consumedQuantity) {
                            throw new Error(`You cannot reduce ${product.name} below ${consumedQuantity} because some of the batch has already been consumed.`);
                        }

                        const nextQuantityRemaining = Math.max(0, quantityReceived - consumedQuantity);
                        const quantityDelta = nextQuantityRemaining - currentQuantityRemaining;

                        await applyInventoryPurchaseUpdate({
                            product,
                            stockDelta: quantityDelta,
                            nextCostPerUnit: normalizedCostPerUnit,
                            nextSellingPrice: normalizedSellingPrice,
                            updateSellingPrice:
                                !productPriceLocked &&
                                normalizedSellingPrice !== undefined &&
                                normalizedSellingPrice !== currentSellingPrice,
                        });

                        const nextOperation = existingRecord._operation === 'create' ? 'create' : 'update';
                        await db.purchaseHistory.update(existingRecord.id as any, {
                            productId: product.id,
                            productName: product.name,
                            supplierId: selectedSupplierId || '',
                            supplierName: selectedSupplierName,
                            branchId: branchId,
                            sessionId: sessionIdForSubmit || existingRecord.sessionId || item.originalSessionId,
                            referenceNumber: referenceNumber,
                            vatAmount: vatAmount,
                            taxRate: taxRate,
                            taxCalculationMethod: taxMethod,
                            taxAmount: itemVatAmount,
                            quantityReceived: quantityReceived,
                            quantityRemaining: nextQuantityRemaining,
                            costPerUnit: costPerUnit,
                            totalCost: itemTotalCost,
                            sellingPrice: normalizedSellingPrice,
                            paymentStatus: paymentStatus,
                            amountDue: paymentStatus === 'Paid' ? 0 : itemGross,
                            batchNumber: item.batchNumber,
                            expiryDate: item.expiryDate ? format(item.expiryDate, 'yyyy-MM-dd') : undefined,
                            receivedDate: existingRecord.receivedDate || receivedDate,
                            purchaseOrderId: poId,
                            updatedAt: nowIso,
                            allowQuantityDecrease: nextQuantityRemaining < currentQuantityRemaining ? true : undefined,
                            _dirty: true,
                            _operation: nextOperation,
                        });
                        purchaseRecordIds.push(purchaseRecordId);
                        itemSnapshots.push({
                            id: purchaseRecordId,
                            inventoryItemId: product.id,
                            quantityOrdered: quantityReceived,
                            quantityRemaining: nextQuantityRemaining,
                            quantityReceived: quantityReceived,
                            costPerUnit: costPerUnit,
                        });
                        await syncService.markAsDirty('PurchaseRecord', purchaseRecordId, nextOperation);
                        continue;
                    }

                    // Create a new batch record (PurchaseRecord) for this purchase with sync flags
                    // This maps to PurchaseOrderItem on the backend
                    await applyInventoryPurchaseUpdate({
                        product,
                        stockDelta: quantityReceived,
                        nextCostPerUnit: normalizedCostPerUnit,
                        nextSellingPrice: normalizedSellingPrice,
                        updateSellingPrice:
                            !productPriceLocked &&
                            normalizedSellingPrice !== undefined &&
                            normalizedSellingPrice !== currentSellingPrice,
                    });

                    const newPurchaseRecordId = uuidv4();
                    const purchaseRecord: Omit<PurchaseRecord, 'id'> = {
                        productId: product.id,
                        productName: product.name,
                        supplierId: selectedSupplierId || '',
                        supplierName: selectedSupplierName,
                        branchId: branchId,
                        sessionId: sessionIdForSubmit || item.originalSessionId,  // Link to active session if available
                        referenceNumber: referenceNumber,
                        vatAmount: vatAmount,
                        taxRate: taxRate,
                        taxCalculationMethod: taxMethod,
                        taxAmount: itemVatAmount,
                        quantityReceived: quantityReceived,
                        quantityRemaining: quantityReceived,
                        costPerUnit: costPerUnit,
                        totalCost: itemTotalCost,
                        sellingPrice: normalizedSellingPrice,
                        paymentStatus: paymentStatus,
                        amountDue: paymentStatus === 'Paid' ? 0 : itemGross,
                        batchNumber: item.batchNumber,
                        expiryDate: item.expiryDate ? format(item.expiryDate, 'yyyy-MM-dd') : undefined,
                        receivedDate: receivedDate,
                        purchaseOrderId: poId,  // Link to the PO
                        _dirty: true,
                        _operation: 'create'
                    };
                    
                    // Add to database with UUID as ID
                    await db.purchaseHistory.put({
                        ...purchaseRecord,
                        id: newPurchaseRecordId
                    } as PurchaseRecord);
                    purchaseRecordIds.push(newPurchaseRecordId);
                    itemSnapshots.push({
                        id: newPurchaseRecordId,
                        inventoryItemId: product.id,
                        quantityOrdered: quantityReceived,
                        quantityRemaining: quantityReceived,
                        quantityReceived: quantityReceived,
                        costPerUnit: costPerUnit,
                    });
                    console.log('[Purchases] Created purchase record with UUID:', newPurchaseRecordId);
                    
                    // Mark purchase record for sync (this will create PurchaseOrderItem on backend)
                    await syncService.markAsDirty('PurchaseRecord', newPurchaseRecordId, 'create');
                }

                if (editingPurchase) {
                    for (const currentRecord of currentRecords.values()) {
                        const currentRecordId = String(currentRecord.id || '').trim();
                        if (!currentRecordId || retainedRecordIds.has(currentRecordId)) {
                            continue;
                        }

                        const inventoryItem = await db.inventory.get(String(currentRecord.productId || '').trim());
                        if (inventoryItem) {
                            const currentStock = Math.max(0, Number(inventoryItem.stockUnits || 0));
                            const quantityRemaining = Math.max(0, Number(currentRecord.quantityRemaining || 0));
                            const safeQuantityToRemove = Math.max(0, Math.min(currentStock, quantityRemaining));
                            const normalizedInventoryCost = Number.isFinite(Number(inventoryItem.cost || 0))
                                ? Number(Number(inventoryItem.cost || 0).toFixed(4))
                                : 0;

                            await applyInventoryPurchaseUpdate({
                                product: inventoryItem,
                                stockDelta: -safeQuantityToRemove,
                                nextCostPerUnit: normalizedInventoryCost,
                                nextSellingPrice: toOptionalNumber(inventoryItem.price),
                                updateSellingPrice: false,
                            });

                            if (safeQuantityToRemove < quantityRemaining) {
                                deletedLineWarnings.push(inventoryItem.name);
                            }
                        }

                        if (isLocalOnlyPurchaseRecord(currentRecord)) {
                            await db.purchaseHistory.delete(currentRecord.id as any);
                            continue;
                        }

                        await db.purchaseHistory.update(currentRecord.id as any, {
                            updatedAt: nowIso,
                            allowQuantityDecrease: true,
                            _dirty: true,
                            _operation: 'delete',
                        });
                        await syncService.markAsDirty('PurchaseRecord', currentRecordId, 'delete');
                    }
                }

                const purchaseOrderOperation = isEditMode
                    ? currentOrder?._operation === 'create'
                        ? 'create'
                        : 'update'
                    : 'create';
                purchaseOrderSyncOperation = purchaseOrderOperation;

                await db.purchaseOrders.put({
                    ...(currentOrder || {}),
                    id: poId,
                    orderNumber: currentOrder?.orderNumber || poId,
                    supplierId: selectedSupplierId,
                    supplierName: selectedSupplierName,
                    status: 'Received',
                    totalItems: validItems.length,
                    totalCost: totalCost,
                    referenceNumber: referenceNumber,
                    vatAmount: vatAmount,
                    paymentStatus: paymentStatus,
                    amountPaid: amountPaid,
                    amountDue: amountDue,
                    notes: `Stock received from ${selectedSupplierName}`,
                    createdBy: currentOrder?.createdBy || user.displayName || user.email || 'System',
                    branchId: branchId,
                    items: itemSnapshots,
                    createdAt: currentOrder?.createdAt || nowIso,
                    updatedAt: nowIso,
                    
                    // MRA Compliance Fields
                    supplierTin: selectedSupplier?.supplierTin || undefined,
                    supplierVatRegistered: selectedSupplier?.vatRegistered || false,
                    
                    // EIS Tracking Fields
                    eisSynced: currentOrder?.eisSynced || false,
                    eisSyncedAt: currentOrder?.eisSyncedAt,
                    
                    // Approval Workflow
                    approvedBy: currentOrder?.approvedBy,
                    approvedAt: currentOrder?.approvedAt,
                    
                    _dirty: true,
                    _operation: purchaseOrderOperation,
                });
                console.log('[Purchases] Upserted purchase order header:', poId);
            });

            // Mark PurchaseOrder for sync (header only, items come from PurchaseRecord)
            await syncService.markAsDirty(
                'PurchaseOrder',
                poId,
                purchaseOrderSyncOperation
            );

            // Log audit action for stock receipt
            await logAuditAction({
                userId: user.uid,
                userName: user.displayName || user.email || 'Unknown',
                branchId: branchId,
                actionType: isEditMode ? 'STOCK_RECEIVE_UPDATE' : 'STOCK_RECEIVE',
                entityType: isEditMode ? 'PurchaseOrder' : 'Purchase',
                entityId: isEditMode ? poId : purchaseRecordIds[0]?.toString() || 'unknown',
                details: {
                    supplier: selectedSupplierName,
                    itemsCount: validItems.length,
                    totalCost: totalCost,
                    referenceNumber: referenceNumber,
                    vatAmount: vatAmount,
                    paymentStatus: paymentStatus,
                    purchaseOrderId: poId,
                    deletedLineWarnings,
                },
            });

            console.log('[Purchases] Marked for sync and logged audit action');
            
            // Trigger sync immediately
            const activeBranchId = localStorage.getItem('handypos-active-branch');
            if (activeBranchId) {
                console.log('[Purchases] Triggering sync after stock receipt');
                await syncService.performFullSync(activeBranchId);
            }
            
            if (!isEditMode) {
                clearDraft();
            }
            toast({
                title: isEditMode ? 'Purchase updated successfully' : 'Stock Received Successfully',
                description: deletedLineWarnings.length > 0
                    ? 'Some removed lines only deducted stock that is still available locally.'
                    : undefined,
            });
            onFormSubmit();
        } catch (error) {
            console.error('Failed to receive stock:', error);
            toast({
                variant: 'destructive',
                title: isEditMode ? 'Error updating purchase' : 'Error receiving stock',
                description: error instanceof Error ? error.message : undefined,
            });
        } finally {
            isSubmittingRef.current = false;
            setIsSubmitting(false);
        }
    };

    return (
        <FormProvider {...form}>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                <fieldset disabled={isSubmitting} className={cn(isSubmitting && 'opacity-70')}>
                <div className="grid grid-cols-1 gap-4">
                    <FormField
                        control={control}
                        name="supplierId"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Supplier (Optional)</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value || ''}>
                                    <FormControl><SelectTrigger disabled={isSubmitting}><SelectValue placeholder="Select a supplier (optional)" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                        {supplierOptions.map((supplier) => (
                                            <SelectItem key={String(supplier.id)} value={String(supplier.id)}>
                                                {supplier.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <FormField
                            control={control}
                            name="referenceNumber"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Reference Number</FormLabel>
                                    <FormControl>
                                        <Input placeholder="Supplier invoice/reference" {...field} disabled={isSubmitting} />
                                    </FormControl>
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={control}
                            name="vatAmount"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>VAT Amount (Auto)</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="number"
                                            step="0.01"
                                            placeholder="VAT amount"
                                            value={field.value ?? ''}
                                            readOnly
                                            disabled={isSubmitting}
                                            className="bg-muted"
                                        />
                                    </FormControl>
                                </FormItem>
                            )}
                        />
                    </div>
                    <FormField
                        control={control}
                        name="paymentStatus"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Payment Status</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value || 'Paid'}>
                                    <FormControl>
                                        <SelectTrigger disabled={isSubmitting}>
                                            <SelectValue placeholder="Select payment status" />
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        <SelectItem value="Paid">Paid</SelectItem>
                                        <SelectItem value="Unpaid">Unpaid</SelectItem>
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
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
                                    <span className={cn('text-xs', !isFuelMode ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                                        Non-fuel
                                    </span>
                                    <Switch
                                        checked={isFuelMode}
                                        onCheckedChange={handleFuelModeToggle}
                                        disabled={!canToggleFuelModeInForm}
                                    />
                                    <span className={cn('text-xs', isFuelMode ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                                        Fuel
                                    </span>
                                </div>
                            </div>
                            {!canToggleFuelModeInForm && (
                                <p className="text-xs text-muted-foreground mt-2">
                                    {isEditMode
                                        ? 'Product type stays fixed while editing an existing purchase.'
                                        : hasFuelItems
                                            ? 'Only fuel items are available.'
                                            : 'Only non-fuel items are available.'}
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
                                    <SelectTrigger disabled={isSubmitting || isLoadingSessionChoices}>
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
                </div>
                
                <Separator />

                <div>
                    <h3 className="text-lg font-medium mb-2">Items Received</h3>
                    <div className="space-y-4">
                        {fields.map((field, index) => {
                            const availableProducts = getAvailableProductsForRow(index);
                            const productSearchTerm = productSearchTerms[field.id] || '';
                            const searchableProducts = filterProductsBySearch(availableProducts, productSearchTerm);
                            const rowItem = watchedItems?.[index];
                            const selectedProductId = String(rowItem?.productId || '').trim();
                            const selectedProduct = inventoryItems.find((item) => item.id === selectedProductId);
                            const isExistingPurchaseLine = Boolean(rowItem?.purchaseRecordId);
                            const rowQuantity = Number(rowItem?.quantity || 0);
                            const rowCost = Number(rowItem?.cost || 0);
                            const rowRate = normalizeTaxRate(rowItem?.taxRate);
                            const rowMethod = resolveTaxMethod(rowItem?.taxCalculationMethod);
                            const rowVat = calculateItemVat(rowCost, rowQuantity, rowRate, rowMethod);
                            const rowTotalInclVat = calculateItemGross(rowCost, rowQuantity, rowVat, rowMethod);
                            const rowSubtotalExVat = rowTotalInclVat - rowVat;
                            return (
                            <div key={field.id} className="p-4 border rounded-lg space-y-4">
                                <div className="grid grid-cols-12 gap-2 items-start">
                                    <div className="col-span-11 grid grid-cols-1 sm:grid-cols-6 gap-2">
                                        <FormField
                                            control={control}
                                            name={`items.${index}.productId`}
                                            rules={{ required: true }}
                                            render={({ field: selectField }) => (
                                                <FormItem>
                                                    <FormLabel className="text-xs">Product</FormLabel>
                                                    <Popover
                                                        open={Boolean(productPickerOpen[field.id])}
                                                        onOpenChange={(open) =>
                                                            setProductPickerOpen((current) => ({
                                                                ...current,
                                                                [field.id]: open,
                                                            }))
                                                        }
                                                    >
                                                        <PopoverTrigger asChild>
                                                            <FormControl>
                                                                <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    role="combobox"
                                                                    className={cn(
                                                                        'w-full justify-between',
                                                                        productPickerOpen[field.id] && 'ring-2 ring-ring ring-offset-2',
                                                                        !selectField.value && 'text-muted-foreground'
                                                                    )}
                                                                    disabled={isSubmitting || isExistingPurchaseLine}
                                                                >
                                                                    <span className="truncate">
                                                                        {availableProducts.find((product) => product.id === selectField.value)?.name ||
                                                                            filteredProducts.find((product) => product.id === selectField.value)?.name ||
                                                                            'Select product'}
                                                                    </span>
                                                                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                                                </Button>
                                                            </FormControl>
                                                        </PopoverTrigger>
                                                        <PopoverContent
                                                            className="w-[320px] p-0"
                                                            align="start"
                                                            onOpenAutoFocus={(event) => {
                                                                event.preventDefault();
                                                                productSearchInputRefs.current[field.id]?.focus();
                                                            }}
                                                        >
                                                            <div className="border-b p-2">
                                                                <Input
                                                                    ref={(node) => {
                                                                        productSearchInputRefs.current[field.id] = node;
                                                                    }}
                                                                    placeholder="Search products..."
                                                                    value={productSearchTerm}
                                                                    onChange={(e) =>
                                                                        setProductSearchTerms((current) => ({
                                                                            ...current,
                                                                            [field.id]: e.target.value,
                                                                        }))
                                                                    }
                                                                    disabled={isSubmitting}
                                                                />
                                                            </div>
                                                            <div className="max-h-60 overflow-y-auto py-1">
                                                                {searchableProducts.length > 0 ? (
                                                                    searchableProducts.map((product) => (
                                                                        <button
                                                                            key={product.id}
                                                                            type="button"
                                                                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                                                                            onClick={() =>
                                                                                handleProductSelect(
                                                                                    index,
                                                                                    field.id,
                                                                                    product.id,
                                                                                    availableProducts,
                                                                                    selectField.onChange
                                                                                )
                                                                            }
                                                                            disabled={isSubmitting}
                                                                        >
                                                                            <div className="min-w-0">
                                                                                <p className="truncate text-sm font-medium">{product.name}</p>
                                                                                <p className="truncate text-xs text-muted-foreground">
                                                                                    {product.category || 'Uncategorized'}
                                                                                </p>
                                                                            </div>
                                                                            <Check
                                                                                className={cn(
                                                                                    'h-4 w-4 shrink-0',
                                                                                    selectField.value === product.id ? 'opacity-100' : 'opacity-0'
                                                                                )}
                                                                            />
                                                                        </button>
                                                                    ))
                                                                ) : (
                                                                    <div className="px-3 py-4 text-sm text-muted-foreground">
                                                                        No matching products
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>
                                                    {isExistingPurchaseLine && (
                                                        <p className="text-[11px] text-muted-foreground">
                                                            Existing purchase lines keep their original product.
                                                        </p>
                                                    )}
                                                </FormItem>
                                            )}
                                        />
                                        <FormField control={control} name={`items.${index}.quantity`} rules={{ required: true, min: 1 }} render={({ field }) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">Quantity</FormLabel>
                                                <FormControl>
                                                    <Input
                                                        type="number"
                                                        placeholder="Quantity"
                                                        value={field.value ?? ''}
                                                        onChange={(e) =>
                                                            field.onChange(
                                                                e.target.value === '' ? '' : Number(e.target.value)
                                                            )
                                                        }
                                                        disabled={isSubmitting}
                                                    />
                                                </FormControl>
                                            </FormItem>
                                        )} />
                                        <FormField control={control} name={`items.${index}.cost`} rules={{ required: true, min: 0 }} render={({ field }) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">Cost/Unit</FormLabel>
                                                <FormControl>
                                                    <Input
                                                        type="number"
                                                        step="0.01"
                                                        placeholder="Cost"
                                                        value={field.value ?? ''}
                                                        onChange={(e) =>
                                                            field.onChange(
                                                                e.target.value === '' ? '' : Number(e.target.value)
                                                            )
                                                        }
                                                        disabled={isSubmitting}
                                                    />
                                                </FormControl>
                                            </FormItem>
                                        )} />
                                        <FormField
                                            control={control}
                                            name={`items.${index}.sellingPrice`}
                                            rules={{ min: 0 }}
                                            render={({ field }) => (
                                                <FormItem>
                                                    <FormLabel className="text-xs">Selling Price</FormLabel>
                                                    <FormControl>
                                                        <Input
                                                            type="number"
                                                            step="0.01"
                                                            placeholder="Selling price"
                                                            value={field.value ?? ''}
                                                            onChange={(e) =>
                                                                field.onChange(
                                                                    e.target.value === '' ? undefined : Number(e.target.value)
                                                                )
                                                            }
                                                            disabled={isSubmitting || isPriceLocked(selectedProduct)}
                                                        />
                                                    </FormControl>
                                                    {isPriceLocked(selectedProduct) && (
                                                        <p className="text-[11px] text-muted-foreground">
                                                            Selling price is locked for this product.
                                                        </p>
                                                    )}
                                                </FormItem>
                                            )}
                                        />
                                        <FormField
                                            control={control}
                                            name={`items.${index}.taxRate`}
                                            rules={{ min: 0 }}
                                            render={({ field }) => (
                                                <FormItem>
                                                    <FormLabel className="text-xs">Tax Rate (%)</FormLabel>
                                                    <FormControl>
                                                        <Input
                                                            type="number"
                                                            step="0.01"
                                                            placeholder="VAT %"
                                                            value={field.value ?? 0}
                                                            onChange={(e) => field.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                                                            disabled={isSubmitting || isTaxLocked(selectedProduct)}
                                                        />
                                                    </FormControl>
                                                    {isTaxLocked(selectedProduct) && (
                                                        <p className="text-[11px] text-muted-foreground">
                                                            Tax rate is locked for this product.
                                                        </p>
                                                    )}
                                                </FormItem>
                                            )}
                                        />
                                        <FormField
                                            control={control}
                                            name={`items.${index}.taxCalculationMethod`}
                                            render={({ field }) => (
                                                <FormItem>
                                                    <FormLabel className="text-xs">Tax Method</FormLabel>
                                                    <Select onValueChange={field.onChange} value={field.value || 'exclusive'}>
                                                        <FormControl>
                                                            <SelectTrigger disabled={isSubmitting || isTaxLocked(selectedProduct)}>
                                                                <SelectValue placeholder="Method" />
                                                            </SelectTrigger>
                                                        </FormControl>
                                                        <SelectContent>
                                                            <SelectItem value="exclusive">Exclusive</SelectItem>
                                                            <SelectItem value="inclusive">Inclusive</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </FormItem>
                                            )}
                                        />
                                    </div>
                                    <div className="col-span-1 flex items-center justify-end pt-6">
                                        <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} className="text-destructive" disabled={isSubmitting}><X className="h-4 w-4" /></Button>
                                    </div>
                                </div>
                                <div className="rounded-md border bg-muted/30 p-3">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                                        <div>
                                            <p className="text-xs text-muted-foreground">Subtotal (Excl VAT)</p>
                                            <p className="font-semibold">{rowSubtotalExVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground">
                                                VAT ({rowMethod === 'inclusive' ? 'Incl' : 'Excl'})
                                            </p>
                                            <p className="font-semibold">{rowVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground">Total (Incl VAT)</p>
                                            <p className="font-semibold">{rowTotalInclVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                     <FormField control={control} name={`items.${index}.batchNumber`} render={({ field }) => (
                                        <FormItem><FormLabel className="text-xs">Batch No. (Optional)</FormLabel><FormControl><Input placeholder="Batch number" {...field} disabled={isSubmitting} /></FormControl></FormItem>
                                    )} />
                                     <FormField
                                        control={control}
                                        name={`items.${index}.expiryDate`}
                                        render={({ field }) => (
                                            <FormItem className="flex flex-col">
                                            <FormLabel className="text-xs">Expiry Date (Optional)</FormLabel>
                                                <Popover>
                                                    <PopoverTrigger asChild>
                                                    <FormControl>
                                                        <Button
                                                        type="button"
                                                        variant={'outline'}
                                                        className={cn('pl-3 text-left font-normal', !field.value && 'text-muted-foreground')}
                                                        disabled={isSubmitting}
                                                        >
                                                        {field.value ? (format(field.value, 'PPP')) : (<span>Pick a date</span>)}
                                                        <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                                                        </Button>
                                                    </FormControl>
                                                    </PopoverTrigger>
                                                    <PopoverContent className="w-auto p-0" align="start">
                                                    <Calendar mode="single" selected={field.value} onSelect={field.onChange} initialFocus/>
                                                    </PopoverContent>
                                                </Popover>
                                            </FormItem>
                                        )}
                                    />
                                </div>
                            </div>
                            );
                        })}
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleAddItem}
                            disabled={isSubmitting}
                        >
                            <Plus className="mr-2 h-4 w-4" /> Add Item
                        </Button>
                        <div className="rounded-lg border bg-muted/30 p-4">
                            <h4 className="text-sm font-medium mb-3">Live Totals</h4>
                            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                                <div>
                                    <p className="text-xs text-muted-foreground">Products</p>
                                    <p className="font-semibold">{liveTotals.totalItems}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Total Quantity</p>
                                    <p className="font-semibold">{liveTotals.totalQuantity}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Subtotal (Excl VAT)</p>
                                    <p className="font-semibold">
                                        {(liveTotals.totalWithVat - liveTotals.totalVat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Total VAT</p>
                                    <p className="font-semibold">{liveTotals.totalVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Total (Incl VAT)</p>
                                    <p className="font-semibold">{liveTotals.totalWithVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    {!isEditMode && (
                        <Button type="button" variant="outline" onClick={() => saveDraft(true)} disabled={isSubmitting}>
                            Save Draft
                        </Button>
                    )}
                    <Button type="submit" disabled={isSubmitDisabled}>
                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {isSubmitting ? 'Submitting...' : isEditMode ? 'Update Purchase' : 'Receive Stock'}
                    </Button>
                </DialogFooter>
                </fieldset>
            </form>
        </FormProvider>
    );
};
