'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, ScanBarcode, LayoutGrid, List, AlertTriangle, Loader2, X, Printer, Barcode, Grid3x3, ListIcon, Camera, Plus, Minus, ClipboardList } from 'lucide-react';

import { db, type InventoryItem, type Order, type Session, type TakeOrder, type TaxRate } from '@/lib/db';
import { isKitchenBusinessType, normalizeBusinessType, type BusinessType } from '@/lib/inventory/config';
import { PharmacyPos } from './pharmacy-pos';
import { RestaurantPos } from './restaurant-pos';
import { BarLiquorPos } from './bar-liquor-pos';
import { SupermarketPos } from './supermarket-pos';
import { GroceryPos } from './grocery-pos';
import { BeautySalonPos } from './beauty-salon-pos';
import type { BuyerDetails } from './generic-pos';
import { ViewOrdersModal } from './view-orders-modal';
import { ScannerConfigModal } from './scanner-config-modal';
import { PrinterConfigModal } from './printer-config-modal';
import { CameraBarcodeScannerModal, type BarcodeDetectionOutcome } from './camera-barcode-scanner-modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { logAuditAction } from '@/lib/audit';
import { barcodeValuesMatch, normalizeBarcodeValue } from '@/lib/barcode';
import { warmBranchMraMappingCache } from '@/lib/mra-mapping-cache';
import { formatQuantityWithUnit, getPortionQuantityDisplay } from '@/lib/quantity-format';
import { safeLocalStorageGetItem, safeLocalStorageSetItem } from '@/lib/safe-local-storage';
import { addTakeOrderToSaleCart } from '@/lib/take-order-sale';
import { markTakeOrdersCompleted } from '@/lib/take-order-status';
import { calculateAppliedCharges, sumAppliedCharges } from '@/lib/business-charges';
import { calculateAppliedMraLevies } from '@/lib/mra-levies';
import { v4 as uuidv4 } from 'uuid';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export type CartItem = InventoryItem & {
  quantity: number;
  price: number;
  notes?: string;
  inventoryItemId?: string;
  selectedOptions?: Array<Record<string, unknown>>;
  selected_options?: Array<Record<string, unknown>>;
};
export type PaymentMethod = Order['paymentMethod'];

type PosCart = {
  id: string;
  title: string;
  items: CartItem[];
};

type PosModalProps = {
  branchId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  processTakeOrderId?: string | null;
  onProcessTakeOrderLoaded?: (orderId: string) => void;
};

const LOCAL_STORAGE_KEYS = {
    ACTIVE_BRANCH: 'handypos-active-branch',
    POS_MODAL_VIEW_MODE: 'handypos-pos-modal-view-mode',
};
const SCAN_FEEDBACK_TOAST_DURATION_MS = 800;

const buildPosCartStorageKey = (businessId?: string | number | null, branchId?: string | null): string => {
  const normalizedBusinessId = String(businessId ?? 'unknown').trim() || 'unknown';
  const normalizedBranchId = normalizeBranchId(branchId);
  return `handypos-pos-carts:${normalizedBusinessId}:${normalizedBranchId || 'unknown'}`;
};

const normalizeBranchId = (value?: string | number | null): string => {
  if (value && typeof value === 'object') {
    const maybeId = (value as any).id ?? (value as any).branch_id ?? (value as any).branchId ?? (value as any).branch;
    if (maybeId !== undefined && maybeId !== value) {
      return normalizeBranchId(maybeId as any);
    }
    return '';
  }

  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (normalized === '[object Object]') return '';

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const toBackendBranchId = (value?: string | number | null): string => {
  return normalizeBranchId(value);
};

const getBranchIdCandidates = (branchId?: string | number | null): string[] => {
  const normalized = normalizeBranchId(branchId);
  if (!normalized) return [];

  const candidates = new Set<string>([normalized, String(branchId ?? '').trim()]);
  if (/^\d+$/.test(normalized)) {
    candidates.add(`BRN-${normalized}`);
    candidates.add(`branch-${normalized}`);
  }

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
};

const normalizeText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const isAllProductType = (value: string): boolean =>
  value === '' || value === 'all' || value === 'all products' || value === 'all items';

const normalizeInventoryReference = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nestedValue =
      obj.id ??
      obj.pk ??
      obj.uuid ??
      obj.inventory_item_id ??
      obj.inventoryItemId;

    return String(nestedValue ?? '').trim();
  }

  return String(value).trim();
};

const resolveMappingInventoryItemId = (mapping: any): string => {
  if (!mapping || typeof mapping !== 'object') {
    return '';
  }

  const candidates = [
    mapping.inventoryItemId,
    mapping.inventory_item_id,
    mapping.inventoryItem,
    mapping.inventory_item,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeInventoryReference(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const resolveCartInventoryItemId = (cartItem: { id?: string; inventoryItemId?: string }): string => {
  const explicitInventoryId = String(cartItem.inventoryItemId || '').trim();
  if (explicitInventoryId) {
    return explicitInventoryId;
  }

  const rawLineId = String(cartItem.id || '').trim();
  if (!rawLineId) {
    return '';
  }

  // Backward compatibility for legacy synthetic line ids like "<inventoryId>::cart::<ts>".
  return rawLineId.split('::cart::')[0] || rawLineId;
};

const getAvailableStockUnits = (item: InventoryItem): number => {
  const explicitAvailable = Number(item.availableStockUnits ?? item.available_stock_units);
  if (Number.isFinite(explicitAvailable)) {
    return Math.max(0, explicitAvailable);
  }

  const stock = Number(item.stockUnits ?? item.stock_units ?? 0);
  const reserved = Number(item.reservedStockUnits ?? item.reserved_stock_units ?? 0);
  return Math.max(0, (Number.isFinite(stock) ? stock : 0) - (Number.isFinite(reserved) ? reserved : 0));
};

const buildCartLineId = (
  inventoryItemId: string,
  options?: {
    isVariablePrice?: boolean;
    notes?: string;
  }
): string => {
  const normalizedInventoryItemId = String(inventoryItemId || '').trim();
  if (!normalizedInventoryItemId) {
    return '';
  }

  const hasNotes = Boolean(String(options?.notes || '').trim());
  if (!options?.isVariablePrice && !hasNotes) {
    return normalizedInventoryItemId;
  }

  return `${normalizedInventoryItemId}::cart::${uuidv4()}`;
};

const mappingStatusRank = (mapping: any): number => {
  if (!mapping) {
    return -1;
  }

  const approved = Boolean(mapping.isApproved ?? mapping.is_approved);
  const synced = Boolean(mapping.mraSynced ?? mapping.mra_synced);

  if (approved && synced) {
    return 3;
  }
  if (approved) {
    return 2;
  }
  if (synced) {
    return 1;
  }
  return 0;
};

const choosePreferredMapping = (current: any, candidate: any): any => {
  if (!current) {
    return candidate;
  }

  const currentRank = mappingStatusRank(current);
  const candidateRank = mappingStatusRank(candidate);
  if (candidateRank > currentRank) {
    return candidate;
  }

  if (candidateRank < currentRank) {
    return current;
  }

  const currentUpdatedAt = new Date(current.updatedAt || current.updated_at || current.lastSyncedAt || current.last_synced_at || current.createdAt || current.created_at || 0).getTime();
  const candidateUpdatedAt = new Date(candidate.updatedAt || candidate.updated_at || candidate.lastSyncedAt || candidate.last_synced_at || candidate.createdAt || candidate.created_at || 0).getTime();

  return candidateUpdatedAt >= currentUpdatedAt ? candidate : current;
};

const buildMappingLookup = (mappings: any[]): Map<string, any> => {
  const lookup = new Map<string, any>();

  for (const mapping of mappings) {
    const mappingItemId = resolveMappingInventoryItemId(mapping);
    if (!mappingItemId) {
      continue;
    }

    const current = lookup.get(mappingItemId);
    lookup.set(mappingItemId, choosePreferredMapping(current, mapping));
  }

  return lookup;
};

const extractMappingsFromResponse = (response: any): any[] => {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.results)) {
    return response.results;
  }

  return [];
};

const formatAvailableStockQuantity = (
  item: Pick<InventoryItem, 'unitType' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>,
  quantity: unknown
): string => {
  const portionsPerUnit = Number(item.portionsPerUnit);
  if (item.isSoldInPortions && Number.isFinite(portionsPerUnit) && portionsPerUnit > 0) {
    const portionDisplay = getPortionQuantityDisplay({
      quantity,
      unitLabel: item.unitType || 'unit',
      portionName: item.portionName,
      portionsPerUnit,
    });

    if (portionDisplay) {
      return portionDisplay.summaryText;
    }
  }

  return formatQuantityWithUnit(quantity, item.unitType || 'unit', {
    maximumFractionDigits: 3,
  });
};

const getCartSaleModeKey = (
  item: Pick<InventoryItem, 'isSoldInPortions' | 'portionsPerUnit'>
): 'portion' | 'unit' => {
  const portionsPerUnit = Number(item.portionsPerUnit);
  return item.isSoldInPortions && Number.isFinite(portionsPerUnit) && portionsPerUnit > 0
    ? 'portion'
    : 'unit';
};

const resolveMappingBranchId = (mapping: any): string => {
  return normalizeBranchId(
    mapping?.branchId ??
    mapping?.branch_id ??
    mapping?.branch
  );
};

const filterMappingsForBranch = (mappings: any[], branchId: string): any[] => {
  const normalizedBranchId = normalizeBranchId(branchId);
  const shouldScopeByBranch =
    Boolean(normalizedBranchId) &&
    !['main', 'main-branch', 'main_branch'].includes(normalizedBranchId.toLowerCase());

  return mappings.filter((mapping) => {
    const mappingBranchId = resolveMappingBranchId(mapping);
    if (!mappingBranchId) {
      return true;
    }
    if (!shouldScopeByBranch) {
      return true;
    }
    return mappingBranchId === normalizedBranchId;
  });
};

const pickPreferredMapping = (mappings: any[]): any => {
  let preferred: any = undefined;
  for (const mapping of mappings) {
    preferred = choosePreferredMapping(preferred, mapping);
  }
  return preferred;
};

export function PosModal({
  branchId,
  isOpen,
  onOpenChange,
  processTakeOrderId,
  onProcessTakeOrderLoaded,
}: PosModalProps) {
  const [currentBusinessType, setCurrentBusinessType] = useState<BusinessType>('Grocery');
  const [resolvedBusinessTypeBusinessId, setResolvedBusinessTypeBusinessId] = useState<string | null>(null);
  const [carts, setCarts] = useState<PosCart[]>([]);
  const [activeCartId, setActiveCartId] = useState<string | null>(null);
  const [takeOrderIdsInCart, setTakeOrderIdsInCart] = useState<string[]>([]);
  const [isCartStateReady, setIsCartStateReady] = useState(false);
  const [isCreateCartOpen, setIsCreateCartOpen] = useState(false);
  const [newCartTitle, setNewCartTitle] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [isViewModeReady, setIsViewModeReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showScannerConfig, setShowScannerConfig] = useState(false);
  const [showPrinterConfig, setShowPrinterConfig] = useState(false);
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [showViewOrdersModal, setShowViewOrdersModal] = useState(false);
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [isLoadingInventory, setIsLoadingInventory] = useState(false);
  const [eisEnabled, setEisEnabled] = useState(false);
  const [blockSalesIfTaxMappingMissing, setBlockSalesIfTaxMappingMissing] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  );
  const [isSearchDropdownOpen, setIsSearchDropdownOpen] = useState(false);
  const [searchResultQuantities, setSearchResultQuantities] = useState<Record<string, number>>({});
  const barcodeBufferRef = React.useRef('');
  const barcodeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const searchDropdownCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickAddHandlerRef = React.useRef<((item: InventoryItem) => boolean | void | Promise<boolean | void>) | null>(null);
  const { toast } = useToast();
  const { user, business } = useAuth();
  const normalizedSearchQuery = searchQuery.toLowerCase().trim();
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const businessTypeReady = Boolean(business?.id) && resolvedBusinessTypeBusinessId === String(business.id).trim();
  const isMultiCartEnabled = isKitchenBusinessType(currentBusinessType);

  const activeCart = useMemo(() => {
    if (!carts.length) return undefined;
    const resolved = carts.find((candidate) => candidate.id === activeCartId) ?? carts[0];
    return resolved;
  }, [carts, activeCartId]);
  const cart = activeCart?.items ?? [];

  useEffect(() => {
    if (carts.length === 0) {
      if (activeCartId !== null) {
        setActiveCartId(null);
      }
      return;
    }

    if (!activeCartId || !carts.some((candidate) => candidate.id === activeCartId)) {
      setActiveCartId(carts[0].id);
    }
  }, [activeCartId, carts]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setIsMobileCartOpen(false);
      setIsSearchDropdownOpen(false);
      setSearchResultQuantities({});
      if (searchDropdownCloseTimeoutRef.current) {
        clearTimeout(searchDropdownCloseTimeoutRef.current);
        searchDropdownCloseTimeoutRef.current = null;
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncViewportMode = () => {
      setIsMobileViewport(window.innerWidth < 1024);
    };

    syncViewportMode();
    window.addEventListener('resize', syncViewportMode);
    return () => window.removeEventListener('resize', syncViewportMode);
  }, []);

  useEffect(() => {
    return () => {
      if (searchDropdownCloseTimeoutRef.current) {
        clearTimeout(searchDropdownCloseTimeoutRef.current);
        searchDropdownCloseTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setIsSearchDropdownOpen(false);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (!hasSearchQuery) {
      setSearchResultQuantities({});
    }
  }, [hasSearchQuery]);

  // Load persisted POS modal view mode once, with mobile-first default.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storedViewMode = safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.POS_MODAL_VIEW_MODE);
    if (storedViewMode === 'grid' || storedViewMode === 'list') {
      setViewMode(storedViewMode);
      setIsViewModeReady(true);
      return;
    }

    if (window.innerWidth < 768) {
      setViewMode('list');
    }

    setIsViewModeReady(true);
  }, []);

  // Persist user preference for grid/list view mode.
  useEffect(() => {
    if (!isViewModeReady || typeof window === 'undefined') return;
    safeLocalStorageSetItem(LOCAL_STORAGE_KEYS.POS_MODAL_VIEW_MODE, viewMode);
  }, [viewMode, isViewModeReady]);

  const toFiniteNumber = useCallback((value: unknown, fallback = 0): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }, []);

  const toPositiveNumber = useCallback((value: unknown, fallback = 0): number => {
    const parsed = toFiniteNumber(value, fallback);
    return parsed > 0 ? parsed : fallback;
  }, [toFiniteNumber]);

  const updateActiveCartItems = useCallback((updater: (items: CartItem[]) => CartItem[]) => {
    setCarts((prevCarts) => {
      if (!prevCarts.length) {
        const nextItems = updater([]);
        if (nextItems.length === 0) {
          return prevCarts;
        }

        return [{
          id: uuidv4(),
          title: 'Cart 1',
          items: nextItems,
        }];
      }
      const resolvedActiveId = activeCartId ?? prevCarts[0].id;
      return prevCarts.map((cart) => (
        cart.id === resolvedActiveId
          ? { ...cart, items: updater(cart.items || []) }
          : cart
      ));
    });
  }, [activeCartId]);

  const clearCartById = useCallback((cartId?: string | null) => {
    setCarts((prevCarts) => {
      if (!prevCarts.length) return prevCarts;

      const resolvedCartId = String(cartId || '').trim() || activeCartId || prevCarts[0]?.id;
      if (!resolvedCartId) return prevCarts;

      return prevCarts.map((cart) => (
        cart.id === resolvedCartId
          ? { ...cart, items: [] }
          : cart
      ));
    });
  }, [activeCartId]);

  const finalizeCartAfterSale = useCallback((cartId?: string | null) => {
    setCarts((prevCarts) => {
      if (!prevCarts.length) return prevCarts;

      const resolvedCartId = String(cartId || '').trim() || activeCartId || prevCarts[0]?.id;
      if (!resolvedCartId) return prevCarts;

      if (isMultiCartEnabled) {
        return prevCarts.filter((cart) => cart.id !== resolvedCartId);
      }

      return prevCarts.map((cart) => (
        cart.id === resolvedCartId
          ? { ...cart, items: [] }
          : cart
      ));
    });
  }, [activeCartId, isMultiCartEnabled]);

  const createCartWithTitle = useCallback((title?: string) => {
    const newCartId = uuidv4();
    setCarts((prevCarts) => {
      const nextIndex = prevCarts.length + 1;
      const normalizedTitle = String(title || '').trim() || `Cart ${nextIndex}`;
      const newCart: PosCart = { id: newCartId, title: normalizedTitle, items: [] };
      return [...prevCarts, newCart];
    });
    setActiveCartId(newCartId);
  }, []);

  const handleCreateCart = useCallback(() => {
    if (!isMultiCartEnabled) return;
    createCartWithTitle(newCartTitle);
    setNewCartTitle('');
    setIsCreateCartOpen(false);
  }, [createCartWithTitle, isMultiCartEnabled, newCartTitle]);

  const toNonNegativeNumber = useCallback((value: unknown, fallback = 0): number => {
    const parsed = toFiniteNumber(value, fallback);
    return parsed >= 0 ? parsed : fallback;
  }, [toFiniteNumber]);

  const toBoolean = useCallback((value: unknown, fallback: boolean): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    return fallback;
  }, []);

  const parseTaxRatePercent = useCallback((value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const raw = String(value ?? '').trim();
    if (!raw) {
      return 0;
    }

    const direct = Number(raw);
    if (Number.isFinite(direct)) {
      return direct;
    }

    const stripped = raw.replace(/[^0-9.-]/g, '');
    const parsed = Number.parseFloat(stripped);
    return Number.isFinite(parsed) ? parsed : 0;
  }, []);

  const toTaxRateDecimal = useCallback((value: unknown): number => {
    const parsedRate = parseTaxRatePercent(value);
    if (parsedRate <= 0) {
      return 0;
    }

    // Accept either percentage format (16.5) or decimal format (0.165).
    return parsedRate > 1 ? parsedRate / 100 : parsedRate;
  }, [parseTaxRatePercent]);

  const normalizeMappedTaxType = useCallback((value: unknown): 'standard' | 'zero' | 'exempt' => {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (
      normalized === 'zero' ||
      normalized === 'zero_rated' ||
      normalized === 'zero-rated' ||
      normalized === 'vat_zero'
    ) {
      return 'zero';
    }
    if (normalized === 'exempt' || normalized === 'vat_exempt') {
      return 'exempt';
    }
    return 'standard';
  }, []);

  const resolveBlockSalesIfTaxMappingMissing = useCallback((source: any): boolean | null => {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const rawBlock = source.blockSalesIfTaxMappingMissing ?? source.block_sales_if_tax_mapping_missing;
    if (rawBlock !== undefined) {
      return toBoolean(rawBlock, false);
    }

    const rawAllow = source.allowSalesWithoutTaxMapping ?? source.allow_sales_without_tax_mapping;
    if (rawAllow !== undefined) {
      return !toBoolean(rawAllow, false);
    }

    return null;
  }, [toBoolean]);

  // Load carts from local storage when branch or business context changes.
  useEffect(() => {
    if (!branchId || !business?.id || !businessTypeReady) {
      return;
    }

    const storageKey = buildPosCartStorageKey(business.id, branchId);
    const rawStored = safeLocalStorageGetItem(storageKey);
    let nextCarts: PosCart[] = [];
    let nextActiveId: string | null = null;

    if (rawStored) {
      try {
        const parsed = JSON.parse(rawStored);
        if (Array.isArray(parsed?.carts)) {
          nextCarts = parsed.carts
            .map((candidate: any) => ({
              id: String(candidate?.id || '').trim(),
              title: String(candidate?.title || '').trim(),
              items: Array.isArray(candidate?.items) ? candidate.items : [],
            }))
            .filter((candidate: PosCart) => candidate.id);
        }
        if (parsed?.activeCartId) {
          nextActiveId = String(parsed.activeCartId || '').trim() || null;
        }
      } catch (error) {
        console.warn('[POS Modal] Failed to parse stored carts:', error);
      }
    }

    if (nextCarts.length === 0) {
      nextCarts = [{ id: uuidv4(), title: 'Cart 1', items: [] }];
      nextActiveId = nextCarts[0].id;
    }

    if (!isMultiCartEnabled) {
      const firstCart = nextCarts[0];
      nextCarts = [{ ...firstCart, title: 'Cart 1' }];
      nextActiveId = nextCarts[0].id;
    }

    if (!nextActiveId || !nextCarts.some((cart) => cart.id === nextActiveId)) {
      nextActiveId = nextCarts[0]?.id ?? null;
    }

    setCarts(nextCarts);
    setActiveCartId(nextActiveId);
    setIsCartStateReady(true);
  }, [branchId, business?.id, businessTypeReady, isMultiCartEnabled]);

  // Persist carts to local storage whenever they change.
  useEffect(() => {
    if (!isCartStateReady || !businessTypeReady || !branchId || !business?.id) return;
    const storageKey = buildPosCartStorageKey(business.id, branchId);
    safeLocalStorageSetItem(storageKey, JSON.stringify({ activeCartId, carts }));
  }, [activeCartId, carts, branchId, business?.id, businessTypeReady, isCartStateReady]);

  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);

  const resolveBranchIntegerId = useCallback((rawBranchId: string): number | null => {
    const branchIdMatch = String(rawBranchId || '').match(/\d+/);
    const parsed = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(rawBranchId, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, []);

  const mapBackendSessionToLocal = useCallback((response: any): Session => {
    return {
      id: String(response.id),
      branchId: String(response.branch ?? response.branch_id ?? branchId),
      userId: String(response.user ?? response.user_id ?? ''),
      userEmail: String(response.user_email ?? response.userEmail ?? '').trim(),
      userName: response.user_name || response.userName || response.user_email || 'Unknown',
      status: String(response.status || '').toLowerCase() === 'closed' ? 'closed' : 'active',
      pumpName: response.pump_name ?? response.pumpName ?? undefined,
      openingFloat: parseFloat(response.opening_float || 0),
      expectedCash: parseFloat(response.expected_cash || 0),
      actualCash: response.actual_cash ? parseFloat(response.actual_cash) : undefined,
      closingFloat: response.closing_float ? parseFloat(response.closing_float) : undefined,
      difference: response.difference ? parseFloat(response.difference) : undefined,
      totalSales: parseFloat(response.total_sales || 0),
      totalCashSales: parseFloat(response.total_cash_sales || 0),
      totalCardSales: parseFloat(response.total_card_sales || 0),
      totalMobileMoneySales: parseFloat(response.total_mobile_money_sales || 0),
      totalBankTransferSales: parseFloat(response.total_bank_transfer_sales || response.totalBankTransferSales || 0),
      totalOnAccountSales: parseFloat(response.total_on_account_sales || 0),
      totalOtherSales: parseFloat(response.total_other_sales || 0),
      totalTips: parseFloat(response.total_tips || 0),
      openingStock: response.opening_stock || [],
      closingStock: response.closing_stock || [],
      startedAt: response.started_at,
      closedAt: response.closed_at,
    };
  }, [branchId]);

  const isSessionOwnedByCurrentUser = useCallback((sessionLike: any): boolean => {
    const currentUserId = String(user?.uid || '').trim();
    const currentUserEmail = String(user?.email || '').trim().toLowerCase();

    const sessionUserId = String(sessionLike?.user ?? sessionLike?.user_id ?? sessionLike?.userId ?? '').trim();
    const sessionUserEmail = String(
      sessionLike?.user_email ?? sessionLike?.userEmail ?? ''
    ).trim().toLowerCase();

    if (currentUserId && sessionUserId && currentUserId === sessionUserId) {
      return true;
    }

    if (currentUserEmail && sessionUserEmail && currentUserEmail === sessionUserEmail) {
      return true;
    }

    return false;
  }, [user?.uid, user?.email]);

  const isSessionActive = useCallback((sessionLike: any): boolean => {
    return String(sessionLike?.status || '').trim().toLowerCase() === 'active';
  }, []);

  const resolveSessionForCheckout = useCallback(async (): Promise<Session | null> => {
    if (!branchId || (!user?.uid && !user?.email)) {
      return null;
    }

    if (activeSession && isSessionActive(activeSession) && isSessionOwnedByCurrentUser(activeSession)) {
      return activeSession;
    }

    const normalizedBranchId = normalizeBranchId(branchId);
    const currentUserId = String(user?.uid || '').trim();
    const currentUserEmail = String(user?.email || '').trim().toLowerCase();
    const activeSessions = await db.sessions.where('status').equals('active').toArray();

    return (
      activeSessions
        .filter((session) => {
          if (normalizeBranchId(session.branchId) !== normalizedBranchId) {
            return false;
          }

          const sessionUserId = String(session.userId || '').trim();
          const sessionUserEmail = String(session.userEmail || '').trim().toLowerCase();
          return (
            (currentUserId && sessionUserId === currentUserId) ||
            (currentUserEmail !== '' && sessionUserEmail === currentUserEmail)
          );
        })
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null
    );
  }, [activeSession, branchId, isSessionActive, isSessionOwnedByCurrentUser, user?.uid, user?.email]);

  const closeStaleLocalActiveSessions = useCallback(async () => {
    if (!branchId || (!user?.uid && !user?.email)) {
      return;
    }

    const normalizedBranchId = normalizeBranchId(branchId);
    const currentUserId = String(user?.uid || '').trim();
    const currentUserEmail = String(user?.email || '').trim().toLowerCase();
    const activeSessions = await db.sessions.where('status').equals('active').toArray();

    const staleSessions = activeSessions.filter((session) => {
      if (normalizeBranchId(session.branchId) !== normalizedBranchId) {
        return false;
      }

      const sessionUserId = String(session.userId || '').trim();
      const sessionUserEmail = String(session.userEmail || '').trim().toLowerCase();
      const matchesUser =
        (currentUserId !== '' && sessionUserId === currentUserId) ||
        (currentUserEmail !== '' && sessionUserEmail === currentUserEmail);

      return matchesUser;
    });

    if (staleSessions.length === 0) {
      return;
    }

    const closedAt = new Date().toISOString();
    await Promise.all(
      staleSessions.map((session) =>
        db.sessions.update(session.id, {
          status: 'closed',
          closedAt: session.closedAt || closedAt,
          _dirty: false,
        })
      )
    );

    console.log('[POS Modal] Marked stale local sessions as closed:', staleSessions.map((s) => s.id));
  }, [branchId, user?.uid, user?.email]);

  // Fetch active session from backend first, then fallback to IndexedDB
  useEffect(() => {
    const fetchActiveSession = async () => {
      if (!user?.uid || !branchId) {
        setIsLoadingSession(false);
        return;
      }

      setIsLoadingSession(true);
      let backendConfirmedNoSessionForCurrentUser = false;

      try {
        const branchIdInt = resolveBranchIntegerId(branchId);
        if (branchIdInt !== null) {
          // First try backend active endpoint
          console.log('[POS Modal] Fetching active session from backend for user:', user.uid, 'branch:', branchIdInt);
          const response = await authFetch.fetch<any>(`/sessions/sessions/active/?branch_id=${branchIdInt}`);
          console.log('[POS Modal] Backend response:', response);

          if (response && response.id) {
            if (isSessionActive(response) && isSessionOwnedByCurrentUser(response)) {
              const mappedSession = mapBackendSessionToLocal(response);
              setActiveSession(mappedSession);
              setIsLoadingSession(false);
              return;
            }

            // If /active returns another user's session, check active_list for current user's session.
            console.warn('[POS Modal] Backend active session belongs to another user. Resolving current-user session from active_list.');
            try {
              const activeListResponse = await authFetch.fetch<any>(`/sessions/sessions/active_list/?branch_id=${branchIdInt}`);
              const activeList = Array.isArray(activeListResponse)
                ? activeListResponse
                : Array.isArray(activeListResponse?.results)
                ? activeListResponse.results
                : [];

              const ownSession = activeList.find(
                (session: any) => isSessionActive(session) && isSessionOwnedByCurrentUser(session)
              );
              if (ownSession && ownSession.id) {
                const mappedSession = mapBackendSessionToLocal(ownSession);
                setActiveSession(mappedSession);
                setIsLoadingSession(false);
                return;
              }

              backendConfirmedNoSessionForCurrentUser = true;
            } catch (activeListError: any) {
              const status = Number(activeListError?.status || 0);
              if (status === 404) {
                backendConfirmedNoSessionForCurrentUser = true;
              } else {
                console.warn('[POS Modal] Failed resolving active_list session for current user:', activeListError);
              }
            }
          } else {
            backendConfirmedNoSessionForCurrentUser = true;
          }
        }
      } catch (error: any) {
        const status = Number(error?.status || 0);
        if (status === 404) {
          // Backend confirms there is no active session for this user/branch.
          backendConfirmedNoSessionForCurrentUser = true;
          console.log('[POS Modal] Backend reports no active session for current user in this branch.');
        } else {
          console.warn('[POS Modal] Failed to fetch session from backend:', error);
        }
      }

      if (backendConfirmedNoSessionForCurrentUser) {
        try {
          await closeStaleLocalActiveSessions();
        } catch (reconcileError) {
          console.warn('[POS Modal] Failed to reconcile stale local sessions:', reconcileError);
        }
        setActiveSession(null);
        setIsLoadingSession(false);
        return;
      }

      // Fallback to IndexedDB
      try {
        console.log('[POS Modal] Falling back to IndexedDB for active session');
        const normalizedBranchId = normalizeBranchId(branchId);
        const currentUserId = String(user?.uid || '');
        const currentUserEmail = String(user?.email || '').trim().toLowerCase();
        const activeSessions = await db.sessions
          .where('status')
          .equals('active')
          .toArray();

        const dbSession = activeSessions
          .filter((session) => {
            if (normalizeBranchId(session.branchId) !== normalizedBranchId) {
              return false;
            }

            const sessionUserId = String(session.userId || '');
            const sessionUserEmail = String(session.userEmail || '').trim().toLowerCase();
            return sessionUserId === currentUserId || (currentUserEmail !== '' && sessionUserEmail === currentUserEmail);
          })
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
        
        if (dbSession) {
          console.log('[POS Modal] Found active session in IndexedDB:', dbSession.id);
          setActiveSession(dbSession);
        } else {
          console.log('[POS Modal] No active session found in IndexedDB');
          setActiveSession(null);
        }
      } catch (error) {
        console.error('[POS Modal] Error fetching from IndexedDB:', error);
        setActiveSession(null);
      }

      setIsLoadingSession(false);
    };

    // Fetch session when modal opens
    if (isOpen) {
      fetchActiveSession();
    }
  }, [
    user?.uid,
    branchId,
    isOpen,
    closeStaleLocalActiveSessions,
    isSessionActive,
    isSessionOwnedByCurrentUser,
    mapBackendSessionToLocal,
    resolveBranchIntegerId,
  ]);

  // Listen for session creation/closure events and refresh immediately
  useEffect(() => {
    const handleSessionCreated = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const { sessionId, branchId: eventBranchId } = customEvent.detail || {};
      
      // Only refresh if it's for the current branch
      if (normalizeBranchId(eventBranchId) === normalizeBranchId(branchId)) {
        console.log('[POS Modal] Session created event received, refreshing active session:', sessionId);
        
        // Try to fetch from backend first
        try {
          const branchIdInt = resolveBranchIntegerId(branchId);
          if (branchIdInt === null) {
            return;
          }
          
          const response = await authFetch.fetch<any>(`/sessions/sessions/active/?branch_id=${branchIdInt}`);
          
          if (response && response.id && isSessionActive(response) && isSessionOwnedByCurrentUser(response)) {
            const mappedSession: Session = mapBackendSessionToLocal(response);
            setActiveSession(mappedSession);
            console.log('[POS Modal] ✓ Active session updated from backend:', mappedSession.id);
          } else {
            console.log('[POS Modal] Session created belongs to another user; keeping current user session state unchanged.');
          }
        } catch (error) {
          console.warn('[POS Modal] Failed to fetch updated session from backend:', error);
          
          // Fallback to IndexedDB
          try {
            const dbSession = await db.sessions.get(sessionId);
            if (dbSession && dbSession.status === 'active' && isSessionOwnedByCurrentUser(dbSession)) {
              setActiveSession(dbSession);
              console.log('[POS Modal] ✓ Active session updated from IndexedDB:', dbSession.id);
            }
          } catch (dbError) {
            console.error('[POS Modal] Error fetching from IndexedDB:', dbError);
          }
        }
      }
    };

    const handleSessionClosed = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const { sessionId, branchId: eventBranchId } = customEvent.detail || {};
      
      // Only refresh if it's for the current branch
      if (normalizeBranchId(eventBranchId) === normalizeBranchId(branchId)) {
        console.log('[POS Modal] Session closed event received, reconciling local session state');
        const isCurrentSessionClosed =
          Boolean(sessionId) &&
          Boolean(activeSession) &&
          String(activeSession.id) === String(sessionId);

        if (sessionId) {
          try {
            await db.sessions.update(String(sessionId), {
              status: 'closed',
              closedAt: new Date().toISOString(),
              _dirty: false,
            });
          } catch (dbError) {
            console.warn('[POS Modal] Failed to update closed session locally:', dbError);
          }
        }

        if (isCurrentSessionClosed || !sessionId) {
          try {
            await closeStaleLocalActiveSessions();
          } catch (reconcileError) {
            console.warn('[POS Modal] Failed to reconcile stale local sessions after close event:', reconcileError);
          }
        }

        setActiveSession((previous) => {
          if (!previous) return null;
          if (sessionId && String(previous.id) !== String(sessionId)) {
            return previous;
          }
          return null;
        });
        console.log('[POS Modal] ✓ Session close reconciliation complete');
      }
    };

    window.addEventListener('sessionCreated', handleSessionCreated);
    window.addEventListener('sessionClosed', handleSessionClosed);
    
    return () => {
      window.removeEventListener('sessionCreated', handleSessionCreated);
      window.removeEventListener('sessionClosed', handleSessionClosed);
    };
  }, [
    activeSession?.id,
    branchId,
    closeStaleLocalActiveSessions,
    isSessionActive,
    isSessionOwnedByCurrentUser,
    mapBackendSessionToLocal,
    resolveBranchIntegerId,
  ]);
  
  const allInventory = useLiveQuery(
    () => {
      if (!branchId) return [];
      const candidates = getBranchIdCandidates(branchId);
      if (candidates.length === 0) return [];
      if (candidates.length === 1) {
        return db.inventory.where({ branchId: candidates[0] }).toArray();
      }
      return db.inventory.where('branchId').anyOf(candidates).toArray();
    },
    [branchId]
  );
  const hasCachedInventory = (allInventory?.length ?? 0) > 0;

  useEffect(() => {
    if (!isOpen || !branchId || (!eisEnabled && !blockSalesIfTaxMappingMissing)) {
      return;
    }

    const inventoryItemIds = (allInventory || [])
      .filter((item) => item.itemType === 'sellable')
      .map((item) => String(item.id || '').trim())
      .filter((itemId) => itemId.length > 0);

    if (inventoryItemIds.length === 0) {
      return;
    }

    let cancelled = false;

    const warmMraCache = async () => {
      const result = await warmBranchMraMappingCache({
        branchId,
        inventoryItemIds,
        logPrefix: '[POS Modal]',
      });

      if (!cancelled && result.refreshed) {
        console.log('[POS Modal] MRA cache warm result:', result);
      }
    };

    void warmMraCache();

    return () => {
      cancelled = true;
    };
  }, [allInventory, blockSalesIfTaxMappingMissing, branchId, eisEnabled, isOpen]);
  
  const defaultTaxRate = useLiveQuery(
    async () => {
      if (!business?.id) return null;

      const taxes = await db.taxes
        .where('businessId')
        .equals(String(business.id))
        .toArray();

      const activeTaxes = taxes.filter((tax) => tax.isActive !== false);
      const defaultTax = activeTaxes.find((tax) => tax.isDefault);
      if (defaultTax) return defaultTax;

      return activeTaxes
        .sort((a, b) => {
          const timeA = Date.parse(a.updatedAt || a.createdAt || '');
          const timeB = Date.parse(b.updatedAt || b.createdAt || '');
          return (Number.isFinite(timeB) ? timeB : 0) - (Number.isFinite(timeA) ? timeA : 0);
        })[0] ?? null;
    },
    [business?.id],
    null
  );

  const activeCharges = useLiveQuery(
    async () => {
      if (!business?.id) return [];

      const charges = await db.charges
        .where('businessId')
        .equals(String(business.id))
        .toArray();

      return charges.filter((charge) => charge.isActive !== false && charge.autoApply !== false);
    },
    [business?.id],
    []
  );

  // Load business type and EIS enabled status from business settings
  useEffect(() => {
    const loadBusinessSettings = async () => {
      const currentBusinessId = String(business?.id || '').trim();
      setResolvedBusinessTypeBusinessId(null);

      if (currentBusinessId) {
        try {
          const businessProfile = await db.business.get(currentBusinessId);
          if (businessProfile) {
            // Load business type - map from backend format to frontend BusinessType
            if (businessProfile.type) {
              const mappedType = normalizeBusinessType(businessProfile.type, 'Grocery');
              console.log('[POS Modal] Setting business type to:', mappedType);
              setCurrentBusinessType(mappedType);
            }
          }
        } catch (error) {
          console.error('[POS Modal] Failed to load business settings:', error);
        } finally {
          setResolvedBusinessTypeBusinessId(currentBusinessId);
        }
        return;
      }

      setResolvedBusinessTypeBusinessId('');
    };
    loadBusinessSettings();
  }, [business?.id]);

  // Load EIS enabled status from business settings
  useEffect(() => {
    const loadEisStatus = async () => {
      if (business?.id && isOpen) {
        try {
          console.log('[POS Modal] Loading EIS status for business:', business.id);

          const applyCachedTaxMappingPolicy = () => {
            if (typeof window === 'undefined') return;
            try {
              const storedSettingsRaw = safeLocalStorageGetItem('handypos-business-settings');
              if (!storedSettingsRaw) return;
              const parsed = JSON.parse(storedSettingsRaw);
              const storedBusinessId = String(parsed?.businessId || '').trim();
              if (storedBusinessId && String(business.id) !== storedBusinessId) {
                return;
              }
              const cachedBlockSetting = resolveBlockSalesIfTaxMappingMissing(parsed);
              if (cachedBlockSetting !== null) {
                setBlockSalesIfTaxMappingMissing(cachedBlockSetting);
              }
            } catch (cacheError) {
              console.warn('[POS Modal] Failed to parse cached tax mapping policy:', cacheError);
            }
          };

          applyCachedTaxMappingPolicy();
          
          // First try to fetch from backend to get latest data
          try {
            const backendBusiness = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
            console.log('[POS Modal] Backend enable_eis:', backendBusiness?.enable_eis);

            if (backendBusiness) {
              const enableEisValue = backendBusiness?.enable_eis === true || backendBusiness?.enable_eis === 'true';
              setEisEnabled(enableEisValue);
              if (enableEisValue) {
                console.log('[POS Modal] EIS is enabled from backend');
              } else {
                console.log('[POS Modal] EIS is disabled from backend');
              }

              const backendBlockSetting =
                resolveBlockSalesIfTaxMappingMissing(backendBusiness) ??
                resolveBlockSalesIfTaxMappingMissing(backendBusiness?.settings);
              if (backendBlockSetting !== null) {
                setBlockSalesIfTaxMappingMissing(backendBlockSetting);
              }
              return;
            }
          } catch (backendError) {
            console.warn('[POS Modal] Failed to fetch from backend, trying IndexedDB:', backendError);
          }
          
          // Fallback to IndexedDB
          const businessProfile = await db.business.get(business.id);
          if (businessProfile) {
            const settings = await db.businessSettings.get(business.id);
            console.log('[POS Modal] IndexedDB enableEis:', settings?.enableEis);
            
            if (settings?.enableEis) {
              console.log('[POS Modal] EIS is enabled from IndexedDB');
              setEisEnabled(true);
            } else {
              console.log('[POS Modal] EIS is disabled');
              setEisEnabled(false);
            }
          }
        } catch (error) {
          console.error('[POS Modal] Failed to load EIS status:', error);
          setEisEnabled(false);
        }
      }
    };
    loadEisStatus();
  }, [business?.id, isOpen, resolveBlockSalesIfTaxMappingMissing]);

  // Fetch inventory from backend when modal opens to ensure we have current branch data
  // Falls back to local DB if offline or backend fails
  useEffect(() => {
    if (!isOpen || !branchId) {
      setIsLoadingInventory(false);
      return;
    }

    if (isOpen && branchId) {
      const fetchInventoryFromBackend = async () => {
        setIsLoadingInventory(true);
        try {
          // Check if online
          if (!navigator.onLine) {
            console.log('[POS Modal] Offline - using cached inventory for branch:', branchId);
            return;
          }

          const backendBranchId = toBackendBranchId(branchId);
          if (!backendBranchId) {
            console.warn('[POS Modal] Missing branch id for backend inventory sync');
            return;
          }
          
          console.log('[POS Modal] Refreshing inventory from backend for branch:', backendBranchId);

          const { syncService } = await import('@/lib/services/sync-service');
          if (eisEnabled) {
            const { refreshInventoryFromMraApprovedProducts } = await import('@/lib/services/inventory-sync');
            const mraRefresh = await refreshInventoryFromMraApprovedProducts(branchId, {
              refreshFromMra: true,
              syncLocal: false,
              businessId: business?.id,
            });
            if (!mraRefresh.ok) {
              console.warn('[POS Modal] EIS product refresh skipped:', mraRefresh.error);
            }
          }
          await syncService.fetchAllInventoryFromBackend(branchId);

          const branchCandidates = getBranchIdCandidates(branchId);
          const refreshedItems = branchCandidates.length > 0
            ? await db.inventory.where('branchId').anyOf(branchCandidates).toArray()
            : await db.inventory.where({ branchId: branchId }).toArray();

          console.log('[POS Modal] Inventory cache now has', refreshedItems.length, 'items for branch:', branchId);
        } catch (error) {
          console.error('[POS Modal] Error fetching inventory from backend:', error);
          console.log('[POS Modal] Falling back to cached inventory for branch:', branchId);
        } finally {
          setIsLoadingInventory(false);
        }
      };
      
      fetchInventoryFromBackend();
    }
  }, [eisEnabled, isOpen, branchId]);

  const allSellableItems = useMemo(
    () => (allInventory || []).filter((item) => item.itemType === 'sellable'),
    [allInventory]
  );

  const sellableItems = useMemo(
    () => {
      if (!normalizedSearchQuery) {
        return [];
      }

      return allSellableItems.filter((item) => (
        item.name?.toLowerCase().includes(normalizedSearchQuery) ||
        item.id?.toLowerCase().includes(normalizedSearchQuery) ||
        item.barcode?.toLowerCase().includes(normalizedSearchQuery) ||
        item.sku?.toLowerCase().includes(normalizedSearchQuery) ||
        item.productCode?.toLowerCase().includes(normalizedSearchQuery) ||
        item.category?.toLowerCase().includes(normalizedSearchQuery) ||
        item.supplier?.toLowerCase().includes(normalizedSearchQuery) ||
        item.manufacturer?.toLowerCase().includes(normalizedSearchQuery) ||
        item.brand?.toLowerCase().includes(normalizedSearchQuery) ||
        item.batch?.toLowerCase().includes(normalizedSearchQuery) ||
        item.unitType?.toLowerCase().includes(normalizedSearchQuery) ||
        item.packSize?.toString().toLowerCase().includes(normalizedSearchQuery)
      ));
    },
    [allSellableItems, normalizedSearchQuery]
  );

  const searchResults = useMemo(
    () => sellableItems.slice(0, 8),
    [sellableItems]
  );

  const getSearchResultQuantity = useCallback((itemId: string) => {
    const value = searchResultQuantities[itemId];
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(1, Math.floor(value));
  }, [searchResultQuantities]);

  const updateSearchResultQuantity = useCallback((itemId: string, nextQuantity: number) => {
    setSearchResultQuantities((prev) => ({
      ...prev,
      [itemId]: Math.max(1, Math.floor(nextQuantity) || 1),
    }));
  }, []);

  const getSearchResultStockState = useCallback((item: InventoryItem) => {
    const isRecipeManagedSaleItem =
      item.itemType === 'sellable' &&
      (Boolean(item.isProduced) || (Array.isArray(item.recipe) && item.recipe.length > 0));

    if (isRecipeManagedSaleItem) {
      return {
        remainingQuantity: null as number | null,
        canQuickAdd: true,
        label: 'Recipe managed',
        toneClassName: 'text-emerald-600',
      };
    }

    const normalizedItemId = String(item.id || '').trim();
    const currentCartQuantity = cart.reduce((total, cartItem) => (
      resolveCartInventoryItemId(cartItem) === normalizedItemId
        ? total + toPositiveNumber(cartItem.quantity, 0)
        : total
    ), 0);

    const remainingQuantity = Math.max(0, getAvailableStockUnits(item) - currentCartQuantity);
    return {
      remainingQuantity,
      canQuickAdd: remainingQuantity > 0,
      label:
        remainingQuantity > 0
          ? `${formatAvailableStockQuantity(item, remainingQuantity)} remaining`
          : 'Out of stock',
      toneClassName: remainingQuantity > 0 ? 'text-emerald-600' : 'text-destructive',
    };
  }, [cart, toPositiveNumber]);

  const registerQuickAddHandler = useCallback((handler: ((item: InventoryItem) => boolean | void | Promise<boolean | void>) | null) => {
    quickAddHandlerRef.current = handler;
  }, []);
  
  const handleAddToCart = useCallback(async (
    item: InventoryItem,
    quantity: number = 1,
    price?: number,
    notes?: string,
    takeOrderId?: string,
    options?: { selectedOptions?: Array<Record<string, unknown>> }
  ) => {
    console.log('[POS Modal] handleAddToCart called:', item.name, 'quantity:', quantity, 'eisEnabled:', eisEnabled);
    const normalizedItemId = String(item.id || '').trim();
    const normalizedNotes = notes?.trim() || undefined;
    const selectedOptions = Array.isArray(options?.selectedOptions)
      ? options.selectedOptions.filter((option) => option && typeof option === 'object')
      : [];
    const isPreparedMenuItem = Boolean(item.isPreparedMenuItem ?? item.is_prepared_menu_item);

    if (!normalizedItemId) {
      toast({
        variant: 'destructive',
        title: 'Invalid product',
        description: 'This product is missing an ID and cannot be added to the cart.',
      });
      return false;
    }

    if (blockSalesIfTaxMappingMissing && !isPreparedMenuItem) {
      // ALWAYS check if product has APPROVED AND SYNCED MRA mapping (regardless of EIS status)
      // Backend requires BOTH is_approved AND mra_synced to be true for sale
      // This is required for MRA compliance - MANDATORY CHECK
      try {
        console.log('[POS Modal] Checking MRA mapping for product:', item.id);
        
        let isReadyForSale = false;
        let mappingStatus = 'unknown';

        // Fast path: local cache first so add-to-cart stays responsive.
        try {
          const itemId = normalizedItemId;
          const directLocalMappings = await db.mraMappings
            .where('inventoryItemId')
            .equals(itemId)
            .toArray();
          let localMapping = pickPreferredMapping(filterMappingsForBranch(directLocalMappings, branchId));

          // Legacy fallback for mappings saved with inventoryItem/inventory_item but missing inventoryItemId.
          if (!localMapping) {
            const allMappings = await db.mraMappings.toArray();
            const scopedMappings = filterMappingsForBranch(allMappings, branchId);
            const lookup = buildMappingLookup(scopedMappings);
            localMapping = lookup.get(itemId);
          }
          
          const localApproved = Boolean(localMapping?.isApproved ?? localMapping?.is_approved);
          const localSynced = Boolean(localMapping?.mraSynced ?? localMapping?.mra_synced);

          if (localMapping && localApproved && localSynced) {
            console.log('[POS Modal] ✓ Found APPROVED & SYNCED MRA mapping in local database for:', item.name);
            isReadyForSale = true;
            mappingStatus = 'ready';
          } else if (localMapping && !localApproved) {
            console.log('[POS Modal] ⚠ MRA mapping found but NOT APPROVED for:', item.name);
            mappingStatus = 'pending';
          } else if (localMapping && !localSynced) {
            console.log('[POS Modal] ⚠ MRA mapping found but NOT SYNCED for:', item.name);
            mappingStatus = 'unsynced';
          } else {
            mappingStatus = 'missing';
          }
        } catch (dbError) {
          console.warn('[POS Modal] Error checking local database:', dbError);
          mappingStatus = 'missing';
        }
        
        // Fallback to API only when local mapping is missing or not ready.
        if (!isReadyForSale && navigator.onLine) {
          try {
            const backendBranchId = toBackendBranchId(branchId);
            let mappings: any[] = [];

            if (backendBranchId) {
              const scopedResponse = await authFetch.fetch<any>(
                `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(normalizedItemId)}&branch_id=${encodeURIComponent(backendBranchId)}`
              );
              mappings = extractMappingsFromResponse(scopedResponse);
            }

            let readyMapping = mappings.find((m) => Boolean(m.is_approved ?? m.isApproved) && Boolean(m.mra_synced ?? m.mraSynced));

            // Some backends return shared/unscoped mappings only without a branch filter.
            if (!readyMapping) {
              const fallbackResponse = await authFetch.fetch<any>(
                `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(normalizedItemId)}`
              );
              const fallbackMappings = extractMappingsFromResponse(fallbackResponse);
              if (fallbackMappings.length > 0) {
                mappings = [...mappings, ...fallbackMappings];
                readyMapping = mappings.find((m) => Boolean(m.is_approved ?? m.isApproved) && Boolean(m.mra_synced ?? m.mraSynced));
              }
            }

            if (mappings.length === 0) {
              mappingStatus = 'missing';
            } else {
              if (readyMapping) {
                isReadyForSale = true;
                mappingStatus = 'ready';

                // Cache backend-verified mapping locally to keep next clicks instant.
                try {
                  const taxType = readyMapping.mra_tax_type === 'zero' || readyMapping.mra_tax_type === 'exempt'
                    ? readyMapping.mra_tax_type
                    : (readyMapping.mraTaxType === 'zero' || readyMapping.mraTaxType === 'exempt' ? readyMapping.mraTaxType : 'standard');
                  const calculationMethod = String(
                    readyMapping.tax_calculation_method ??
                    readyMapping.taxCalculationMethod ??
                    readyMapping.calculation_method ??
                    readyMapping.calculationMethod ??
                    ''
                  ).trim().toLowerCase().startsWith('excl')
                    ? 'exclusive'
                    : 'inclusive';
                  const nowIso = new Date().toISOString();
                  const mappingItemId = resolveMappingInventoryItemId(readyMapping) || normalizedItemId;

                  await db.mraMappings.put({
                    id: String(readyMapping.id || `${mappingItemId}-mapping`),
                    inventoryItemId: mappingItemId,
                    branchId: normalizeBranchId(
                      readyMapping.branch ??
                      readyMapping.branch_id ??
                      backendBranchId
                    ) || undefined,
                    mraProductCode: readyMapping.mra_product_code || readyMapping.mraProductCode || '',
                    mraProductName: readyMapping.mra_product_name || readyMapping.mraProductName || item.name,
                                    mraTaxType: taxType,
                                    mraTaxRate: Number(readyMapping.mra_tax_rate ?? readyMapping.mraTaxRate ?? 0),
                                    mraLevies: Array.isArray(readyMapping.mra_levies ?? readyMapping.mraLevies)
                                      ? (readyMapping.mra_levies ?? readyMapping.mraLevies)
                                      : [],
                                    mraUnitMeasure: readyMapping.mra_unit_measure || readyMapping.mraUnitMeasure || '',
                    taxCalculationMethod: calculationMethod,
                    isApproved: Boolean(readyMapping.is_approved ?? readyMapping.isApproved),
                    approvedAt: readyMapping.approved_at || readyMapping.approvedAt || undefined,
                    mraSynced: Boolean(readyMapping.mra_synced ?? readyMapping.mraSynced),
                    lastSyncedAt: nowIso,
                    createdAt: readyMapping.created_at || readyMapping.createdAt || nowIso,
                    updatedAt: nowIso,
                  });
                } catch (cacheError) {
                  console.warn('[POS Modal] Failed to cache MRA mapping after API check:', cacheError);
                }
              } else {
                const approvedButNotSynced = mappings.find(
                  (m) => Boolean(m.is_approved ?? m.isApproved) && !Boolean(m.mra_synced ?? m.mraSynced)
                );
                mappingStatus = approvedButNotSynced ? 'unsynced' : 'pending';
              }
            }
          } catch (error) {
            console.error('[POS Modal] Error checking MRA mapping from API:', error);
            toast({
              variant: 'destructive',
              title: 'Error',
              description: 'Failed to verify MRA mapping for this product. Please try again.',
            });
            return false;
          }
        }
        
        // Block sale if not ready for sale
        if (!isReadyForSale) {
          let errorTitle = 'MRA Mapping Required';
          let errorDescription = `${item.name} cannot be sold - MRA mapping issue.`;
          
          if (mappingStatus === 'pending') {
            errorTitle = 'MRA Mapping Pending Approval';
            errorDescription = `${item.name} has a pending MRA mapping. Go to Inventory → MRA Mappings to approve it.`;
          } else if (mappingStatus === 'unsynced') {
            errorTitle = 'MRA Mapping Not Synced';
            errorDescription = `${item.name} mapping is approved but not synced to MRA. Please sync it first.`;
          } else if (mappingStatus === 'missing') {
            errorTitle = 'MRA Mapping Missing';
            errorDescription = `${item.name} has no MRA mapping. Go to Inventory → MRA Mappings to create one.`;
          }
          
          toast({
            variant: 'destructive',
            title: errorTitle,
            description: errorDescription,
          });
          console.log('[POS Modal] ✗ BLOCKED add to cart - MRA mapping not ready for:', item.name, '(status:', mappingStatus + ')');
          return false;
        }
      } catch (error) {
        console.error('[POS Modal] Unexpected error checking MRA mapping:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to verify MRA mapping for this product.',
        });
        return false;
      }
    } else {
      console.log('[POS Modal] Tax mapping enforcement disabled, skipping MRA mapping validation for:', item.name);
    }

    const isRecipeManagedSaleItem =
      item.itemType === 'sellable' &&
      (isPreparedMenuItem || Boolean(item.isProduced) || (Array.isArray(item.recipe) && item.recipe.length > 0));

    if (!isRecipeManagedSaleItem) {
      const currentCartQuantity = cart.reduce((acc, cartItem) =>
        resolveCartInventoryItemId(cartItem) === normalizedItemId ? acc + toPositiveNumber(cartItem.quantity, 0) : acc, 0
      );
      const remainingStock = getAvailableStockUnits(item) - currentCartQuantity;

      if (remainingStock <= 0) {
        toast({
          variant: 'destructive',
          title: 'Out of Stock',
          description: `${item.name} is out of stock.`,
        });
        return false;
      }

      if (quantity > remainingStock) {
        toast({
          variant: 'destructive',
          title: 'Insufficient Stock',
          description: `Only ${formatAvailableStockQuantity(item, remainingStock)} remaining for ${item.name}.`,
        });
        return false;
      }
    }

    const saleModeKey = getCartSaleModeKey(item);
    const hasSelectedOptions = selectedOptions.length > 0;
    const shouldMergeIntoExistingLine = !item.isVariablePrice && !normalizedNotes && !hasSelectedOptions;
    const itemPrice = price !== undefined ? price : (item.price || 0);
    const cartLineId = shouldMergeIntoExistingLine
      ? `${normalizedItemId}::sale::${saleModeKey}`
      : buildCartLineId(normalizedItemId, {
          isVariablePrice: item.isVariablePrice,
          notes: normalizedNotes,
        });

    if (!cartLineId) {
      toast({
        variant: 'destructive',
        title: 'Invalid product',
        description: 'This product could not be assigned a cart line ID.',
      });
      return false;
    }

    updateActiveCartItems((prevCart) => {
      const existingItemIndex = shouldMergeIntoExistingLine
        ? prevCart.findIndex((cartItem) => {
            const inventoryItemId = resolveCartInventoryItemId(cartItem);
            return (
              inventoryItemId === normalizedItemId &&
              !cartItem.notes &&
              !cartItem.isVariablePrice &&
              getCartSaleModeKey(cartItem) === saleModeKey
            );
          })
        : -1;

      if (existingItemIndex > -1) {
        const newCart = [...prevCart];
        const oldQuantity = newCart[existingItemIndex].quantity;
        newCart[existingItemIndex].quantity += quantity;
        console.log('[POS Modal] Incremented item:', item.name, 'old quantity:', oldQuantity, 'new quantity:', newCart[existingItemIndex].quantity);
        return newCart;
      }

      console.log('[POS Modal] Added new item:', item.name, 'quantity:', quantity);
      return [
        ...prevCart,
        {
          ...item,
          id: cartLineId,
          inventoryItemId: normalizedItemId,
          menuItemId: item.menuItemId ?? item.menu_item_id,
          menu_item_id: item.menuItemId ?? item.menu_item_id,
          isPreparedMenuItem,
          is_prepared_menu_item: isPreparedMenuItem,
          quantity: quantity,
          price: itemPrice,
          notes: normalizedNotes,
          selectedOptions,
          selected_options: selectedOptions,
        }
      ];
    });

    if (takeOrderId) {
      setTakeOrderIdsInCart((prev) => (
        prev.includes(takeOrderId) ? prev : [...prev, takeOrderId]
      ));
    }

    return true;
  }, [branchId, blockSalesIfTaxMappingMissing, cart, toast, toPositiveNumber, updateActiveCartItems]);

  const handleProcessTakeOrderForSale = useCallback(async (order: TakeOrder): Promise<boolean> => {
    if (!activeSession || !isSessionActive(activeSession) || !isSessionOwnedByCurrentUser(activeSession)) {
      toast({
        variant: 'destructive',
        title: 'Start a session first',
        description: 'A POS session is required before sending a ready order to sale processing.',
      });
      return false;
    }

    if (order.status !== 'Ready') {
      toast({
        variant: 'destructive',
        title: 'Order is not ready',
        description: 'Only ready kitchen orders can be sent to sale processing.',
      });
      return false;
    }

    const result = await addTakeOrderToSaleCart({
      order,
      branchId,
      onAddToCart: handleAddToCart,
    });

    if (result.added === 0) {
      toast({
        variant: 'destructive',
        title: 'Could not process order',
        description: 'No order items were added to the sale cart.',
      });
      return false;
    }

    setShowViewOrdersModal(false);
    setIsMobileCartOpen(true);
    toast({
      title: 'Order ready for checkout',
      description: `Order #${order.orderNumber} has been added to the sale cart.`,
    });
    return true;
  }, [activeSession, branchId, handleAddToCart, isSessionActive, isSessionOwnedByCurrentUser, toast]);

  useEffect(() => {
    if (
      !isOpen ||
      !processTakeOrderId ||
      !activeSession ||
      !isSessionActive(activeSession) ||
      !isSessionOwnedByCurrentUser(activeSession)
    ) {
      return;
    }

    let cancelled = false;
    const orderId = processTakeOrderId;

    const loadOrderForSale = async () => {
      try {
        const { syncService } = require('@/lib/services/sync-service');
        await syncService.fetchAllTakeOrdersFromBackend(branchId);
        if (cancelled) return;

        const order = await db.takeOrders.get(orderId);
        if (!order) {
          toast({
            variant: 'destructive',
            title: 'Order not found',
            description: 'The selected take order could not be found for sale processing.',
          });
          onProcessTakeOrderLoaded?.(orderId);
          return;
        }

        await handleProcessTakeOrderForSale(order);
        if (!cancelled) {
          onProcessTakeOrderLoaded?.(orderId);
        }
      } catch (error) {
        console.error('[POS Modal] Failed to load take order for sale:', error);
        if (!cancelled) {
          toast({
            variant: 'destructive',
            title: 'Could not process order',
            description: error instanceof Error ? error.message : 'Failed to load the order for sale processing.',
          });
          onProcessTakeOrderLoaded?.(orderId);
        }
      }
    };

    void loadOrderForSale();

    return () => {
      cancelled = true;
    };
  }, [
    activeSession,
    branchId,
    handleProcessTakeOrderForSale,
    isOpen,
    isSessionActive,
    isSessionOwnedByCurrentUser,
    onProcessTakeOrderLoaded,
    processTakeOrderId,
    toast,
  ]);

  const handleSearchResultSelect = useCallback(async (item: InventoryItem, quantity: number = 1) => {
    const handler = quickAddHandlerRef.current;
    const normalizedQuantity = Math.max(1, Math.floor(quantity) || 1);
    const requiresInteractiveFlow = item.isVariablePrice || item.isSoldInPortions;

    if (requiresInteractiveFlow && handler) {
      await handler(item);
    } else {
      await handleAddToCart(item, normalizedQuantity);
    }

    setSearchQuery('');
    setIsSearchDropdownOpen(false);
    setSearchResultQuantities((prev) => {
      const next = { ...prev };
      delete next[String(item.id)];
      return next;
    });

    if (searchDropdownCloseTimeoutRef.current) {
      clearTimeout(searchDropdownCloseTimeoutRef.current);
      searchDropdownCloseTimeoutRef.current = null;
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [handleAddToCart]);
  
  const handleUpdateQuantity = (itemId: string, newQuantity: number) => {
    const normalizedItemId = String(itemId || '').trim();
    if (newQuantity <= 0) {
      updateActiveCartItems((prevCart) =>
        prevCart.filter((cartItem) => String(cartItem.id || '').trim() !== normalizedItemId)
      );
    } else {
      updateActiveCartItems((prevCart) =>
        prevCart.map((cartItem) =>
          String(cartItem.id || '').trim() === normalizedItemId
            ? { ...cartItem, quantity: newQuantity }
            : cartItem
        )
      );
    }
  };

  const handleClearCart = useCallback(() => {
    clearCartById(activeCartId);
    setTakeOrderIdsInCart([]);
  }, [activeCartId, clearCartById]);

  const handleCameraBarcodeDetected = useCallback(async (barcode: string): Promise<BarcodeDetectionOutcome> => {
    const normalizedScannedBarcode = normalizeBarcodeValue(barcode);
    if (!normalizedScannedBarcode) {
      return {
        accepted: false,
        message: 'Invalid barcode value.',
      };
    }

    const matchedProduct = allSellableItems.find((item) => {
      return barcodeValuesMatch(item.barcode, normalizedScannedBarcode);
    });

    if (!matchedProduct) {
      toast({
        variant: 'destructive',
        title: 'Product Not Found',
        description: `No product found with barcode: ${barcode}`,
        duration: SCAN_FEEDBACK_TOAST_DURATION_MS,
      });
      return {
        accepted: false,
        message: `No product found with barcode: ${barcode}`,
      };
    }

    const stockState = getSearchResultStockState(matchedProduct);
    if (!stockState.canQuickAdd) {
      toast({
        variant: 'destructive',
        title: 'Out of Stock',
        description: stockState.label,
      });
      return {
        accepted: false,
        message: stockState.label,
      };
    }

    const requiresInteractiveFlow = matchedProduct.isVariablePrice || matchedProduct.isSoldInPortions;
    const quickAddHandler = quickAddHandlerRef.current;

    if (requiresInteractiveFlow) {
      if (quickAddHandler) {
        await quickAddHandler(matchedProduct);
      } else {
        const added = await handleAddToCart(matchedProduct, 1);
        if (!added) {
          return {
            accepted: false,
            message: `Could not add ${matchedProduct.name} to the cart.`,
          };
        }
      }

      return {
        accepted: true,
        productName: matchedProduct.name,
      };
    }

    const added = await handleAddToCart(matchedProduct, 1);
    if (!added) {
      return {
        accepted: false,
        message: `Could not add ${matchedProduct.name} to the cart.`,
      };
    }

    return {
      accepted: true,
      productName: matchedProduct.name,
    };
  }, [allSellableItems, getSearchResultStockState, handleAddToCart, isMobileViewport, toast]);

  // Barcode scanner listener - search product by barcode and auto-add to cart
  useEffect(() => {
    if (!isOpen) {
      barcodeBufferRef.current = '';
      if (barcodeTimeoutRef.current) {
        clearTimeout(barcodeTimeoutRef.current);
        barcodeTimeoutRef.current = null;
      }
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const clearBarcodeBuffer = () => {
        barcodeBufferRef.current = '';
        if (barcodeTimeoutRef.current) {
          clearTimeout(barcodeTimeoutRef.current);
          barcodeTimeoutRef.current = null;
        }
      };

      // Get the active element
      const activeElement = document.activeElement as HTMLElement;
      const isInputFocused = activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA';
      
      // Only process printable characters and Enter
      if (e.key === 'Enter') {
        // Process the barcode buffer
        const normalizedBufferedBarcode = normalizeBarcodeValue(barcodeBufferRef.current);
        if (normalizedBufferedBarcode) {
          console.log('[POS Modal] Processing barcode:', normalizedBufferedBarcode);
          
          // Search for product by barcode
          const product = allSellableItems.find((item) =>
            barcodeValuesMatch(item.barcode, normalizedBufferedBarcode)
          );
          
          if (product) {
            console.log('[POS Modal] Found product by barcode:', product.name);
            handleAddToCart(product, 1);
            toast({
              title: 'Added to Cart',
              description: `${product.name} added to cart`,
            });
          } else {
            console.log('[POS Modal] No product found with barcode:', normalizedBufferedBarcode);
            toast({
              variant: 'destructive',
              title: 'Product Not Found',
              description: `No product found with barcode: ${normalizedBufferedBarcode}`,
              duration: SCAN_FEEDBACK_TOAST_DURATION_MS,
            });
          }
          
          clearBarcodeBuffer();
          
          // Prevent default Enter behavior
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Check if this is a printable character (barcode scanner input)
      // Only capture if not typing in search field or if we already have a barcode buffer
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // If we have a barcode buffer, capture all input
        // Otherwise, only capture if not in search field
        if (barcodeBufferRef.current.length > 0 || !isInputFocused) {
          // Add character to buffer
          barcodeBufferRef.current += e.key;
          const newBuffer = barcodeBufferRef.current;
          console.log('[POS Modal] Barcode buffer:', newBuffer);
          
          // Clear existing timeout
          if (barcodeTimeoutRef.current) {
            clearTimeout(barcodeTimeoutRef.current);
          }
          
          // Set new timeout to clear buffer if no Enter is pressed within 100ms
          // (barcode scanners typically send all characters rapidly followed by Enter)
          barcodeTimeoutRef.current = setTimeout(() => {
            console.log('[POS Modal] Barcode timeout - clearing buffer:', newBuffer);
            barcodeBufferRef.current = '';
            barcodeTimeoutRef.current = null;
          }, 100);

          // Prevent default behavior to stop modal from getting focus
          e.preventDefault();
          e.stopPropagation();
          
          // Blur any focused element to prevent modal focus
          if (activeElement && activeElement !== document.body) {
            activeElement.blur();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (barcodeTimeoutRef.current) {
        clearTimeout(barcodeTimeoutRef.current);
        barcodeTimeoutRef.current = null;
      }
      barcodeBufferRef.current = '';
    };
  }, [isOpen, allInventory, handleAddToCart, toast]);

  const handleCreateOrder = async (paymentMethod: PaymentMethod, tip: number, buyerDetails?: BuyerDetails): Promise<Order | null> => {
    const appliedTip = Math.max(0, toNonNegativeNumber(tip, 0));
    const checkoutCartId = activeCart?.id ?? activeCartId ?? null;
    if (!cart.length) {
      toast({ variant: 'destructive', title: 'Cart is empty' });
      return null;
    }
    if (!branchId) {
       toast({ variant: 'destructive', title: 'No active branch', description: 'Could not determine the active branch.' });
       return null;
    }
    const sessionForOrder = await resolveSessionForCheckout();
    if (!sessionForOrder) {
      toast({ variant: 'destructive', title: 'No active session', description: 'Please start a session to record sales.' });
      return null;
    }

    const buyerName = buyerDetails?.name?.trim();
    const buyerPhone = buyerDetails?.phone?.trim();
    const buyerTin = buyerDetails?.tin?.trim();
    const buyerCustomerId = buyerDetails?.customerId?.trim();
    const laybuyDepositAmount = Number(buyerDetails?.laybuyDeposit ?? 0);
    const laybuyPaymentMethod = buyerDetails?.laybuyPaymentMethod?.trim() || 'Cash';
    const buyerFields: Partial<Order> = {};

    if (buyerCustomerId) {
      buyerFields.customerId = buyerCustomerId;
      buyerFields.customer_id = buyerCustomerId;
    }
    if (buyerName) {
      buyerFields.customerName = buyerName;
      buyerFields.customer_name = buyerName;
    }
    if (buyerPhone) {
      buyerFields.customerPhone = buyerPhone;
      buyerFields.customer_phone = buyerPhone;
    }
    if (buyerTin) {
      buyerFields.customerTin = buyerTin;
      buyerFields.customer_tin = buyerTin;
      buyerFields.buyerTin = buyerTin;
      buyerFields.buyer_tin = buyerTin;
    }
    const buyerAuthorizationCode = buyerDetails?.authorizationCode?.trim();
    if (buyerAuthorizationCode) {
      buyerFields.buyerAuthorizationCode = buyerAuthorizationCode;
      buyerFields.buyer_authorization_code = buyerAuthorizationCode;
    }
    if (buyerDetails?.isExport !== undefined) {
      buyerFields.isExport = buyerDetails.isExport === true;
      buyerFields.is_export = buyerDetails.isExport === true;
    }
    if (buyerDetails?.isReliefSupply !== undefined) {
      buyerFields.isReliefSupply = buyerDetails.isReliefSupply === true;
      buyerFields.is_relief_supply = buyerDetails.isReliefSupply === true;
    }
    const vat5ProjectNumber = buyerDetails?.vat5ProjectNumber?.trim();
    if (vat5ProjectNumber) {
      buyerFields.vat5ProjectNumber = vat5ProjectNumber;
      buyerFields.vat5_project_number = vat5ProjectNumber;
    }
    const vat5CertificateNumber = buyerDetails?.vat5CertificateNumber?.trim();
    if (vat5CertificateNumber) {
      buyerFields.vat5CertificateNumber = vat5CertificateNumber;
      buyerFields.vat5_certificate_number = vat5CertificateNumber;
    }
    const vat5Quantity = Number(buyerDetails?.vat5Quantity ?? 0);
    if (Number.isFinite(vat5Quantity) && vat5Quantity > 0) {
      buyerFields.vat5Quantity = vat5Quantity;
      buyerFields.vat5_quantity = vat5Quantity;
    }
    if (paymentMethod === 'Laybuy' && Number.isFinite(laybuyDepositAmount) && laybuyDepositAmount > 0) {
      buyerFields.laybuyDeposit = laybuyDepositAmount;
      buyerFields.laybuy_deposit = laybuyDepositAmount;
      buyerFields.depositAmount = laybuyDepositAmount;
      buyerFields.deposit_amount = laybuyDepositAmount;
      buyerFields.laybuyPaymentMethod = laybuyPaymentMethod;
      buyerFields.laybuy_payment_method = laybuyPaymentMethod;
    }
    
    // Validate MRA mappings from local snapshot only.
    // Add-to-cart already verifies mapping online and caches it locally.
    const localMappings = filterMappingsForBranch(await db.mraMappings.toArray(), branchId);
    const mappingByItemId = buildMappingLookup(localMappings);

    if (blockSalesIfTaxMappingMissing) {
      const unmappedProducts: string[] = [];
      const unapprovedProducts: string[] = [];
      const unsyncedProducts: string[] = [];

      for (const cartItem of cart) {
        const cartInventoryItemId = resolveCartInventoryItemId(cartItem);
        const localMapping = mappingByItemId.get(cartInventoryItemId);

        if (!localMapping) {
          unmappedProducts.push(cartItem.name);
          continue;
        }

        const isApproved = Boolean(localMapping.isApproved ?? localMapping.is_approved);
        const isSynced = Boolean(localMapping.mraSynced ?? localMapping.mra_synced);

        if (!isApproved) {
          unapprovedProducts.push(cartItem.name);
          continue;
        }

        if (!isSynced) {
          unsyncedProducts.push(cartItem.name);
        }
      }
      
      // Block sale if any products are unmapped or unapproved
      if (unmappedProducts.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Unmapped Products',
          description: `Cannot sell: ${unmappedProducts.join(', ')}. Please map these products to MRA codes first.`,
        });
        return null;
      }
      
      if (unapprovedProducts.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Unapproved Mappings',
          description: `Cannot sell: ${unapprovedProducts.join(', ')}. Please approve the MRA mappings first.`,
        });
        return null;
      }

      if (unsyncedProducts.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Unsynced Mappings',
          description: `Cannot sell: ${unsyncedProducts.join(', ')}. Please sync these mappings first.`,
        });
        return null;
      }
    }
    
    // Build tax snapshot from approved+synced mappings for consistent order math.
    // When mapping enforcement is disabled, fall back to the default tax rate for unmapped items.
    let cartItemTaxRates: Record<string, { rate: number; taxType: 'standard' | 'zero' | 'exempt'; calculationMethod: 'inclusive' | 'exclusive' }> = {};
    const shouldApplyDefaultTax = !blockSalesIfTaxMappingMissing && Boolean(defaultTaxRate);
    const defaultTaxType = defaultTaxRate ? normalizeMappedTaxType(defaultTaxRate.taxType) : 'standard';
    const rawDefaultRate = defaultTaxRate ? toTaxRateDecimal(defaultTaxRate.rate) : 0;
    const normalizedDefaultRate = defaultTaxType === 'zero' || defaultTaxType === 'exempt' ? 0 : rawDefaultRate;

    for (const cartItem of cart) {
      const cartInventoryItemId = resolveCartInventoryItemId(cartItem);
      const mapping = mappingByItemId.get(cartInventoryItemId);
      const mappingReady = Boolean(mapping && (mapping.isApproved ?? mapping.is_approved) && (mapping.mraSynced ?? mapping.mra_synced));

      if (mappingReady) {
        const taxType = normalizeMappedTaxType(mapping.mraTaxType ?? mapping.mra_tax_type);
        const rawRate = mapping.mraTaxRate ?? mapping.mra_tax_rate ?? 0;
        const normalizedRate = taxType === 'zero' || taxType === 'exempt' ? 0 : toTaxRateDecimal(rawRate);
        const calculationMethod = String(mapping.taxCalculationMethod ?? mapping.tax_calculation_method).trim().toLowerCase() === 'exclusive'
          ? 'exclusive'
          : 'inclusive';

        cartItemTaxRates[cartInventoryItemId] = {
          rate: normalizedRate,
          taxType,
          calculationMethod,
        };
        continue;
      }

      if (shouldApplyDefaultTax) {
        cartItemTaxRates[cartInventoryItemId] = {
          rate: normalizedDefaultRate,
          taxType: defaultTaxType,
          calculationMethod: 'inclusive',
        };
      }
    }
    
    // Calculate tax per item using product-specific rates or default
    // CRITICAL: Respect inclusive/exclusive tax calculation method per product
    let subtotal = 0;
    let tax = 0;
    const lineNetAmounts: Record<string, number> = {};
    
    for (const cartItem of cart) {
      const itemPrice = Number(cartItem.price || 0);
      const itemQuantity = Number(cartItem.quantity || 0);
      const itemGross = cartItem.isVariablePrice ? itemPrice : itemPrice * itemQuantity; // Variable-price items store line total in `price`
      const cartInventoryItemId = resolveCartInventoryItemId(cartItem);
      
      // Use product-specific tax rate if available, otherwise use default
      let itemTax = 0;
      let itemSubtotal = itemGross;
      let calculationMethod = 'inclusive'; // Default
      
      if (cartItemTaxRates[cartInventoryItemId]) {
        const { rate, taxType, calculationMethod: method } = cartItemTaxRates[cartInventoryItemId];
        calculationMethod = method;
        
        // Handle different tax types
        if (taxType === 'zero' || taxType === 'exempt') {
          // Zero-rated or exempt items have 0% tax
          itemTax = 0;
          itemSubtotal = itemGross;
          console.log(`[Order] Item: ${cartItem.name}, Gross: ${itemGross}, Tax Type: ${taxType.toUpperCase()}, Tax: 0, Subtotal: ${itemSubtotal}`);
        } else if (calculationMethod === 'exclusive') {
          // Tax exclusive: price excludes tax, so tax is added
          // itemTax = itemGross * rate
          // itemSubtotal = itemGross (price is already net)
          itemTax = itemGross * rate;
          itemSubtotal = itemGross;
          console.log(`[Order] Item: ${cartItem.name}, EXCLUSIVE tax - Subtotal: ${itemSubtotal}, Tax Rate: ${(rate * 100).toFixed(2)}%, Tax: ${itemTax.toFixed(2)}, Gross: ${(itemSubtotal + itemTax).toFixed(2)}`);
        } else {
          // Tax inclusive: price includes tax, so tax is extracted
          // itemTax = itemGross / (1 + rate) * rate
          // itemSubtotal = itemGross - itemTax
          itemTax = itemGross / (1 + rate) * rate;
          itemSubtotal = itemGross - itemTax;
          console.log(`[Order] Item: ${cartItem.name}, INCLUSIVE tax - Gross: ${itemGross}, Tax Rate: ${(rate * 100).toFixed(2)}%, Tax: ${itemTax.toFixed(2)}, Subtotal: ${itemSubtotal.toFixed(2)}`);
        }
      } else {
        // Fallback to default tax rate (assume inclusive)
        const defaultRate = defaultTaxRate ? defaultTaxRate.rate / 100 : 0;
        if (defaultRate > 0) {
          itemTax = itemGross / (1 + defaultRate) * defaultRate;
          itemSubtotal = itemGross - itemTax;
          console.log(`[Order] Item: ${cartItem.name}, INCLUSIVE tax (default) - Gross: ${itemGross}, Tax Rate: ${(defaultRate * 100).toFixed(2)}%, Tax: ${itemTax.toFixed(2)}, Subtotal: ${itemSubtotal.toFixed(2)}`);
        } else {
          itemTax = 0;
          itemSubtotal = itemGross;
          console.log(`[Order] Item: ${cartItem.name}, No tax - Subtotal: ${itemSubtotal}`);
        }
      }
      
      subtotal += itemSubtotal;
      tax += itemTax;
      lineNetAmounts[String(cartItem.id)] = itemSubtotal;
    }
    
    const localAppliedCharges = calculateAppliedCharges({
      charges: (activeCharges || []).filter((charge) => !eisEnabled || charge.chargeType !== 'LEVY'),
      netSubtotal: subtotal,
      grossTotal: subtotal + tax,
    });
    const mraAppliedCharges = eisEnabled
      ? calculateAppliedMraLevies({ cart, mappingByItemId, lineNetAmounts })
      : [];
    const appliedCharges = [...localAppliedCharges, ...mraAppliedCharges];
    const exclusiveChargesTotal = sumAppliedCharges(
      appliedCharges.filter((charge) => charge.calculationMethod === 'exclusive')
    );
    const chargesTotal = sumAppliedCharges(appliedCharges);
    const total = subtotal + tax + exclusiveChargesTotal + appliedTip;
    let orderCogs = 0;
    let finalOrder: Order | null = null;
    const shouldMoveStockImmediately = paymentMethod !== 'Laybuy';
    const getSelectedOptionStockTargets = (cartItem: CartItem, cartQuantity: number): Array<{ id: string; quantity: number }> => {
      const selectedOptions = cartItem.selectedOptions ?? cartItem.selected_options ?? [];
      if (!Array.isArray(selectedOptions) || cartQuantity <= 0) return [];

      return selectedOptions.flatMap((option: Record<string, unknown>) => {
        const optionQuantity = toPositiveNumber(
          (option as any).quantity ?? (option as any).selectedQuantity ?? (option as any).selected_quantity ?? 1,
          1
        );
        const multiplier = cartQuantity * (optionQuantity > 0 ? optionQuantity : 1);
        const targets: Array<{ id: string; quantity: number }> = [];

        const linkedInventoryId = String(
          (option as any).linked_inventory_item ??
          (option as any).linkedInventoryItem ??
          (option as any).linked_inventory_item_id ??
          (option as any).linkedInventoryItemId ??
          ''
        ).trim();
        const linkedQuantity = toPositiveNumber(
          (option as any).linked_inventory_quantity ?? (option as any).linkedInventoryQuantity,
          0
        );
        if (linkedInventoryId && linkedQuantity > 0) {
          targets.push({ id: linkedInventoryId, quantity: linkedQuantity * multiplier });
        }

        const recipe = Array.isArray((option as any).recipe) ? (option as any).recipe : [];
        for (const recipeItem of recipe) {
          const ingredientId = String(
            recipeItem?.ingredientId ??
            recipeItem?.ingredient_id ??
            recipeItem?.inventoryItemId ??
            recipeItem?.inventory_item_id ??
            recipeItem?.linkedInventoryItemId ??
            recipeItem?.linked_inventory_item_id ??
            recipeItem?.id ??
            ''
          ).trim();
          const ingredientQuantity = toPositiveNumber(recipeItem?.quantity, 0);
          if (ingredientId && ingredientQuantity > 0) {
            targets.push({ id: ingredientId, quantity: ingredientQuantity * multiplier });
          }
        }

        return targets;
      });
    };

    try {
      // Track stock recalculation candidates and items that required direct inventory fallback.
      // If fallback is used, recalculation would overwrite the manual decrement when no batch exists.
      const itemsToRecalculateStock = new Set<string>();
      const itemsWithFallbackStockDeduction = new Set<string>();

      await db.transaction('rw', db.inventory, db.orders, db.sessions, db.purchaseHistory, async () => {
        const now = new Date();
        
        if (shouldMoveStockImmediately) {
          for (const cartItem of cart) {
            const originalItemId = resolveCartInventoryItemId(cartItem);
            const cartItemRecipe = Array.isArray((cartItem as any).recipe) ? (cartItem as any).recipe : [];
            const cartItemIsPrepared = Boolean((cartItem as any).isPreparedMenuItem ?? (cartItem as any).is_prepared_menu_item);
            const originalItem = allInventory?.find(i => String(i.id) === String(originalItemId)) || (
              cartItemIsPrepared || cartItemRecipe.length > 0 ? cartItem : undefined
            );

            if (!originalItem) {
              console.warn(`[Order] Item not found in inventory: ${originalItemId}`);
              continue;
            }

            const cartQuantity = toPositiveNumber(cartItem.quantity, 0);
            if (cartQuantity <= 0) {
              console.warn(`[Order] Invalid cart quantity for ${originalItemId}:`, cartItem.quantity);
              continue;
            }

            // Recipe-backed sellables consume their ingredients; other items consume their own stock.
            const isTakeawayPackaging = Boolean((cartItem as any).isTakeawayPackaging ?? (cartItem as any).is_takeaway_packaging);
            const baseItemsToDecrement = (!isTakeawayPackaging && originalItem.itemType === 'sellable' && originalItem.recipe?.length)
                ? originalItem.recipe
                    .map(ri => {
                      const ingredientId = String(
                        ri?.ingredientId ??
                        (ri as any)?.ingredient_id ??
                        (ri as any)?.inventoryItemId ??
                        (ri as any)?.inventory_item_id ??
                        (ri as any)?.id ??
                        ''
                      ).trim();
                      const ingredientQty = toPositiveNumber(ri?.quantity, 0);
                      return {
                        id: ingredientId,
                        quantity: ingredientQty * cartQuantity,
                      };
                    })
                    .filter(entry => entry.id && entry.quantity > 0)
                : [{ id: originalItemId, quantity: cartQuantity }];
            const itemsToDecrement = [
              ...baseItemsToDecrement,
              ...getSelectedOptionStockTargets(cartItem, cartQuantity),
            ];
            
            console.log(`[Order] Processing item: ${originalItem.name}`, {
              isProduced: originalItem.isProduced,
              hasRecipe: !!originalItem.recipe?.length,
              itemsToDecrement: itemsToDecrement.length,
              cartQuantity: cartItem.quantity
            });
            
            for (const itemToDecrement of itemsToDecrement) {
                let quantityToDecrement = toPositiveNumber(itemToDecrement.quantity, 0);
                if (quantityToDecrement <= 0) {
                  console.warn(`[Order] Skipping invalid decrement quantity for ${itemToDecrement.id}:`, itemToDecrement.quantity);
                  continue;
                }

                const inventoryItemToUpdate = await db.inventory
                  .where('branchId')
                  .equals(branchId)
                  .filter(item => String(item.id) === String(itemToDecrement.id))
                  .first();

                if (!inventoryItemToUpdate) {
                  console.warn(`[Order] Inventory item not found for decrement: ${itemToDecrement.id}`);
                  continue;
                }

                // Query batches for this product with remaining quantity.
                // First try indexed lookup, then fallback to normalized id compare (handles string/number mismatches).
                let batches = await db.purchaseHistory
                  .where({ branchId, productId: itemToDecrement.id as any })
                  .and(batch => (batch.quantityRemaining || 0) > 0)
                  .toArray();

                if (batches.length === 0) {
                  batches = await db.purchaseHistory
                    .where('branchId')
                    .equals(branchId)
                    .filter(batch =>
                      String(batch.productId) === String(itemToDecrement.id) &&
                      (batch.quantityRemaining || 0) > 0
                    )
                    .toArray();
                }

                // Sort batches for FIFO with expiry awareness:
                // 1. Expired batches first (to clear them)
                // 2. Then by expiry date (soonest first)
                // 3. Then by received date (oldest first - FIFO)
                const sortedBatches = batches.sort((a, b) => {
                    const aExpiry = a.expiryDate ? new Date(a.expiryDate) : null;
                    const bExpiry = b.expiryDate ? new Date(b.expiryDate) : null;
                    const aReceived = new Date(a.receivedDate);
                    const bReceived = new Date(b.receivedDate);
                    
                    // Check if expired
                    const aIsExpired = aExpiry && aExpiry < now;
                    const bIsExpired = bExpiry && bExpiry < now;
                    
                    // Expired batches first
                    if (aIsExpired && !bIsExpired) return -1;
                    if (!aIsExpired && bIsExpired) return 1;
                    
                    // If both expired or both not expired, sort by expiry date (soonest first)
                    if (aExpiry && bExpiry) {
                        if (aExpiry.getTime() !== bExpiry.getTime()) {
                            return aExpiry.getTime() - bExpiry.getTime();
                        }
                    }
                    
                    // If expiry dates are same or both null, use FIFO (oldest received first)
                    return aReceived.getTime() - bReceived.getTime();
                });

                console.log(`[Order] FIFO sorting for ${itemToDecrement.id}:`, {
                    totalBatches: sortedBatches.length,
                    batches: sortedBatches.map(b => ({
                        id: b.id,
                        batchNumber: b.batchNumber,
                        quantityRemaining: b.quantityRemaining,
                        expiryDate: b.expiryDate,
                        receivedDate: b.receivedDate,
                        isExpired: b.expiryDate ? new Date(b.expiryDate) < now : false
                    }))
                });

                let totalDecrementedFromBatches = 0;
                for (const batch of sortedBatches) {
                    if (quantityToDecrement <= 0) break;

                    const batchQuantityRemaining = toNonNegativeNumber(batch.quantityRemaining, 0);
                    if (batchQuantityRemaining <= 0) {
                      continue;
                    }

                    const decrementAmount = Math.min(quantityToDecrement, batchQuantityRemaining);
                    if (!Number.isFinite(decrementAmount) || decrementAmount <= 0) {
                      continue;
                    }

                    const newQuantityRemaining = Math.max(0, batchQuantityRemaining - decrementAmount);
                    const isBatchFinished = newQuantityRemaining === 0;
                    
                    console.log(`[Order] Batch Deduction - ${batch.batchNumber || batch.id}:`, {
                        batchId: batch.id,
                        batchNumber: batch.batchNumber || 'N/A',
                        quantityNeeded: quantityToDecrement,
                        quantityAvailableInBatch: batchQuantityRemaining,
                        quantityUsedFromBatch: decrementAmount,
                        quantityRemainingAfter: newQuantityRemaining,
                        batchFinished: isBatchFinished,
                        expiryDate: batch.expiryDate || 'No expiry',
                        costPerUnit: batch.costPerUnit,
                        costForThisBatch: decrementAmount * batch.costPerUnit
                    });
                    
                    await db.purchaseHistory.update(batch.id!, {
                        quantityRemaining: newQuantityRemaining,
                    });

                    orderCogs += decrementAmount * toNonNegativeNumber(batch.costPerUnit, 0);
                    quantityToDecrement -= decrementAmount;
                    totalDecrementedFromBatches += decrementAmount;
                }

                // If batch coverage is incomplete, also decrement from inventory directly to keep sale stock movement correct.
                // This protects offline/legacy datasets where purchase batches are missing or partially synced.
                let fallbackInventoryDecrement = 0;
                if (quantityToDecrement > 0) {
                  const currentItemStock = toNonNegativeNumber(inventoryItemToUpdate.stockUnits, 0);
                  const availableAfterBatch = Math.max(
                    0,
                    currentItemStock - totalDecrementedFromBatches
                  );
                  fallbackInventoryDecrement = Math.min(quantityToDecrement, availableAfterBatch);
                  quantityToDecrement -= fallbackInventoryDecrement;

                  if (fallbackInventoryDecrement > 0) {
                    itemsWithFallbackStockDeduction.add(String(itemToDecrement.id));
                    orderCogs += fallbackInventoryDecrement * toNonNegativeNumber(inventoryItemToUpdate.cost, 0);
                    console.warn(`[Order] Used inventory fallback decrement for ${itemToDecrement.id}:`, {
                      fallbackInventoryDecrement,
                      availableAfterBatch
                    });
                  }
                }

                const totalInventoryDecrement = totalDecrementedFromBatches + fallbackInventoryDecrement;
                if (totalInventoryDecrement > 0) {
                  const currentStock = toNonNegativeNumber(inventoryItemToUpdate.stockUnits, 0);
                  const newStock = Math.max(0, currentStock - totalInventoryDecrement);
                  const reorderLevel = inventoryItemToUpdate.reorderLevel || 0;
                  const newStatus =
                    newStock <= 0
                      ? 'Out of Stock'
                      : newStock <= reorderLevel
                        ? 'Low Stock'
                        : 'In Stock';

                  await db.inventory.update(inventoryItemToUpdate.id, {
                    stockUnits: newStock,
                    status: newStatus,
                  });

                  console.log(`[Order] Inventory decremented for ${inventoryItemToUpdate.name}:`, {
                    previousStock: currentStock,
                    decrementedBy: totalInventoryDecrement,
                    newStock
                  });
                }

                if (totalDecrementedFromBatches > 0) {
                  itemsToRecalculateStock.add(String(itemToDecrement.id));
                }

                if (quantityToDecrement > 0) {
                  console.warn(`[Order] Sale consumed more than available tracked stock for ${itemToDecrement.id}. Remaining unmet quantity: ${quantityToDecrement}`);
                }
            }
          }
        } else {
          for (const cartItem of cart) {
            const originalItemId = resolveCartInventoryItemId(cartItem);
            const cartItemRecipe = Array.isArray((cartItem as any).recipe) ? (cartItem as any).recipe : [];
            const cartItemIsPrepared = Boolean((cartItem as any).isPreparedMenuItem ?? (cartItem as any).is_prepared_menu_item);
            const originalItem = allInventory?.find(i => String(i.id) === String(originalItemId)) || (
              cartItemIsPrepared || cartItemRecipe.length > 0 ? cartItem : undefined
            );

            if (!originalItem) {
              console.warn(`[Order] Item not found for laybuy reservation: ${originalItemId}`);
              continue;
            }

            const cartQuantity = toPositiveNumber(cartItem.quantity, 0);
            if (cartQuantity <= 0) {
              console.warn(`[Order] Invalid laybuy reservation quantity for ${originalItemId}:`, cartItem.quantity);
              continue;
            }

            const isTakeawayPackaging = Boolean((cartItem as any).isTakeawayPackaging ?? (cartItem as any).is_takeaway_packaging);
            const baseItemsToReserve = (!isTakeawayPackaging && originalItem.itemType === 'sellable' && originalItem.recipe?.length)
              ? originalItem.recipe
                  .map(ri => {
                    const ingredientId = String(
                      ri?.ingredientId ??
                      (ri as any)?.ingredient_id ??
                      (ri as any)?.inventoryItemId ??
                      (ri as any)?.inventory_item_id ??
                      (ri as any)?.id ??
                      ''
                    ).trim();
                    const ingredientQty = toPositiveNumber(ri?.quantity, 0);
                    return {
                      id: ingredientId,
                      quantity: ingredientQty * cartQuantity,
                    };
                  })
                  .filter(entry => entry.id && entry.quantity > 0)
              : [{ id: originalItemId, quantity: cartQuantity }];
            const itemsToReserve = [
              ...baseItemsToReserve,
              ...getSelectedOptionStockTargets(cartItem, cartQuantity),
            ];

            for (const itemToReserve of itemsToReserve) {
              const quantityToReserve = toPositiveNumber(itemToReserve.quantity, 0);
              if (quantityToReserve <= 0) {
                continue;
              }

              const inventoryItemToUpdate = await db.inventory
                .where('branchId')
                .equals(branchId)
                .filter(item => String(item.id) === String(itemToReserve.id))
                .first();

              if (!inventoryItemToUpdate) {
                console.warn(`[Order] Inventory item not found for laybuy reservation: ${itemToReserve.id}`);
                continue;
              }

              const currentReserved = toNonNegativeNumber(
                inventoryItemToUpdate.reservedStockUnits ?? inventoryItemToUpdate.reserved_stock_units,
                0
              );
              const stockUnits = toNonNegativeNumber(
                inventoryItemToUpdate.stockUnits ?? inventoryItemToUpdate.stock_units,
                0
              );
              const newReserved = currentReserved + quantityToReserve;
              const availableAfterReservation = Math.max(0, stockUnits - newReserved);
              const reorderLevel = inventoryItemToUpdate.reorderLevel || 0;
              const newStatus =
                availableAfterReservation <= 0
                  ? 'Out of Stock'
                  : availableAfterReservation <= reorderLevel
                    ? 'Low Stock'
                    : 'In Stock';

              await db.inventory.update(inventoryItemToUpdate.id, {
                reservedStockUnits: newReserved,
                reserved_stock_units: newReserved,
                availableStockUnits: availableAfterReservation,
                available_stock_units: availableAfterReservation,
                status: newStatus,
              });

              console.log(`[Order] Locally reserved stock for laybuy ${inventoryItemToUpdate.name}:`, {
                previousReserved: currentReserved,
                reservedBy: quantityToReserve,
                newReserved,
                availableAfterReservation,
              });
            }
          }
        }

        const existingBranchOrders = await db.orders.where('branchId').equals(branchId).toArray();
        const maxKnownOrderNumber = existingBranchOrders.reduce((maxValue, orderRecord) => {
          const candidates = [
            Number((orderRecord as any).orderNumber),
            Number((orderRecord as any).order_number),
          ];
          for (const candidate of candidates) {
            if (Number.isFinite(candidate) && candidate > maxValue) {
              maxValue = candidate;
            }
          }
          return maxValue;
        }, 100);
        const nextOrderNumber = maxKnownOrderNumber + 1;
        const isKitchenOrder = isKitchenBusinessType(currentBusinessType);

        const newOrder: Order = {
          id: uuidv4(),
          orderNumber: nextOrderNumber,
          branchId: branchId,
          sessionId: sessionForOrder.id,
          pumpName: sessionForOrder.pumpName,
          orderType: 'sale',
          isTakeaway: cart.some((item) => Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging)),
          is_takeaway: cart.some((item) => Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging)),
          items: cart.map(item => {
            const inventoryItemId = resolveCartInventoryItemId(item) || String(item.id);
            // Get tax information for this specific item
            const itemTaxInfo =
              cartItemTaxRates[inventoryItemId] ||
              cartItemTaxRates[String(item.id)] ||
              { rate: 0, taxType: 'standard', calculationMethod: 'inclusive' };
            const itemLineGross = item.isVariablePrice
              ? Number(item.price || 0)
              : Number(item.price || 0) * Number(item.quantity || 0);
            const unitPriceForStorage =
              item.isVariablePrice && Number(item.quantity || 0) > 0
                ? Number(item.price || 0) / Number(item.quantity || 0)
                : Number(item.price || 0);
            let itemTax = 0;
            let itemSubtotal = itemLineGross;
            
            // Calculate tax for this item based on its tax type and calculation method
            if (itemTaxInfo.taxType === 'zero' || itemTaxInfo.taxType === 'exempt') {
              itemTax = 0;
              itemSubtotal = itemLineGross;
            } else if (itemTaxInfo.calculationMethod === 'exclusive') {
              // Tax exclusive: price excludes tax, so tax is added
              itemTax = itemLineGross * itemTaxInfo.rate;
              itemSubtotal = itemLineGross;
            } else {
              // Tax inclusive: price includes tax, so tax is extracted
              itemTax = itemLineGross / (1 + itemTaxInfo.rate) * itemTaxInfo.rate;
              itemSubtotal = itemLineGross - itemTax;
            }
            
            const snapshotTaxRate = itemTaxInfo.taxType === 'zero' || itemTaxInfo.taxType === 'exempt'
              ? 0
              : itemTaxInfo.rate * 100;

            return {
              id: uuidv4(), // Generate unique ID for each order item
              name: item.name,
              quantity: item.quantity,
              price: unitPriceForStorage, // Persist per-unit price for backend quantity x price recalculation
              notes: item.notes || '',
              selectedOptions: item.selectedOptions ?? item.selected_options ?? [],
              selected_options: item.selectedOptions ?? item.selected_options ?? [],
              recipe: Array.isArray((item as any).recipe) ? (item as any).recipe : [],
              isPreparedMenuItem: Boolean((item as any).isPreparedMenuItem ?? (item as any).is_prepared_menu_item),
              is_prepared_menu_item: Boolean((item as any).isPreparedMenuItem ?? (item as any).is_prepared_menu_item),
              isTakeawayPackaging: Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging),
              is_takeaway_packaging: Boolean((item as any).isTakeawayPackaging ?? (item as any).is_takeaway_packaging),
              menuItemId: (item as any).menuItemId ?? (item as any).menu_item_id ?? undefined,
              menu_item_id: (item as any).menuItemId ?? (item as any).menu_item_id ?? undefined,
              // Store inventory item reference for tracking
              inventoryItemId,
              unitType: item.unitType || undefined,
              unit_type: item.unitType || undefined,
              isSoldInPortions: Boolean(item.isSoldInPortions),
              is_sold_in_portions: Boolean(item.isSoldInPortions),
              portionName: item.portionName || undefined,
              portion_name: item.portionName || undefined,
              portionsPerUnit: Number(item.portionsPerUnit || 0) || undefined,
              portions_per_unit: Number(item.portionsPerUnit || 0) || undefined,
              // Per-item tax information (MRA compliance - Immutable snapshot)
              taxRate: snapshotTaxRate,
              tax_rate: snapshotTaxRate,
              taxType: itemTaxInfo.taxType,
              tax_type: itemTaxInfo.taxType,
              taxCalculationMethod: itemTaxInfo.calculationMethod,
              tax_calculation_method: itemTaxInfo.calculationMethod,
              // Calculated tax amounts (Immutable snapshot for audit trail)
              subtotal: itemSubtotal,
              taxAmount: itemTax,
              total: itemSubtotal + itemTax,
            };
          }),
          status: isKitchenOrder ? 'New' : 'Completed',
          paymentMethod: paymentMethod,
          ...buyerFields,
          subtotal: Number(subtotal),
          tax: Number(tax),
          tip: Number(appliedTip),
          chargesAmount: Number(chargesTotal),
          charges_amount: Number(chargesTotal),
          chargesSnapshot: appliedCharges,
          charges_snapshot: appliedCharges,
          total: Number(total),
          cogs: Number(orderCogs),
          eis_status: eisEnabled ? 'PENDING' : undefined,
          eisStatus: eisEnabled ? 'PENDING' : undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        // Mark order as dirty for sync
        const orderWithSync: Order = {
          ...newOrder,
          _dirty: true,
          _operation: 'create'
        };
        await db.orders.add(orderWithSync);
        finalOrder = orderWithSync;
        console.log('[Sync] Marked order as dirty:', newOrder.id);

        const sessionUpdate: Partial<Session> = {
            totalSales: (sessionForOrder.totalSales || 0) + subtotal,
            totalTips: (sessionForOrder.totalTips || 0) + appliedTip,
        };

        const saleAmount = total;
        switch(paymentMethod) {
            case 'Cash':
                sessionUpdate.totalCashSales = (sessionForOrder.totalCashSales || 0) + saleAmount;
                sessionUpdate.expectedCash = (sessionForOrder.expectedCash || 0) + saleAmount + appliedTip;
                break;
            case 'Card':
                 sessionUpdate.totalCardSales = (sessionForOrder.totalCardSales || 0) + saleAmount;
                 break;
            case 'Mobile Money':
                 sessionUpdate.totalMobileMoneySales = (sessionForOrder.totalMobileMoneySales || 0) + saleAmount;
                 break;
            case 'Bank Transfer':
                 sessionUpdate.totalBankTransferSales = (sessionForOrder.totalBankTransferSales || 0) + saleAmount;
                 break;
            case 'On Account':
                 sessionUpdate.totalOnAccountSales = (sessionForOrder.totalOnAccountSales || 0) + saleAmount;
                 break;
            case 'Laybuy': {
                 const depositAmount = Number((buyerFields as any).laybuyDeposit || 0);
                 if (depositAmount > 0) {
                   if (laybuyPaymentMethod === 'Cash') {
                     sessionUpdate.totalCashSales = (sessionForOrder.totalCashSales || 0) + depositAmount;
                     sessionUpdate.expectedCash = (sessionForOrder.expectedCash || 0) + depositAmount;
                   } else if (laybuyPaymentMethod === 'Card') {
                     sessionUpdate.totalCardSales = (sessionForOrder.totalCardSales || 0) + depositAmount;
                   } else if (laybuyPaymentMethod === 'Mobile Money') {
                     sessionUpdate.totalMobileMoneySales = (sessionForOrder.totalMobileMoneySales || 0) + depositAmount;
                   } else if (laybuyPaymentMethod === 'Bank Transfer') {
                     sessionUpdate.totalBankTransferSales = (sessionForOrder.totalBankTransferSales || 0) + depositAmount;
                   } else {
                     sessionUpdate.totalOtherSales = (sessionForOrder.totalOtherSales || 0) + depositAmount;
                   }
                 }
                 break;
            }
            case 'Other':
                 sessionUpdate.totalOtherSales = (sessionForOrder.totalOtherSales || 0) + saleAmount;
                 break;
        }

        await db.sessions.update(sessionForOrder.id, sessionUpdate);
      });

      if (finalOrder && user) {
        await logAuditAction({
          userId: user.uid,
          userName: user.displayName || user.email || 'System',
          branchId: finalOrder.branchId,
          actionType: 'ORDER_CREATE',
          entityType: 'Order',
          entityId: finalOrder.id,
          details: {
            orderNumber: finalOrder.orderNumber,
            total: finalOrder.total,
            paymentMethod: finalOrder.paymentMethod,
            items: finalOrder.items.length,
          },
        });
      }

      // Recalculate inventory for items fully tracked by batches.
      // Skip items where fallback stock decrement was used, otherwise recalculation can undo the fallback deduction.
      if (itemsToRecalculateStock.size > 0) {
        const { updateInventoryStockUnits } = await import('@/lib/services/stock-calculator');
        for (const itemId of itemsToRecalculateStock) {
          if (itemsWithFallbackStockDeduction.has(itemId)) {
            console.log(`[Order] Skipping stock recalculation for ${itemId} due to inventory fallback deduction`);
            continue;
          }

          try {
            await updateInventoryStockUnits(itemId, branchId, { markDirty: false });
            console.log(`[Order] Updated stock units for item: ${itemId}`);
          } catch (err) {
            console.error(`[Order] Failed to update stock units for item ${itemId}:`, err);
          }
        }
      }

      if (takeOrderIdsInCart.length > 0) {
        try {
          const result = await markTakeOrdersCompleted(takeOrderIdsInCart);
          console.log('[TakeOrder] Marked take orders as completed:', result.completed);
          setTakeOrderIdsInCart([]);
        } catch (error) {
          console.warn('[TakeOrder] Failed to mark take orders as completed:', error);
        }
      }

      if (finalOrder && typeof window !== 'undefined' && navigator.onLine) {
        // Don't block checkout UX on full sync. Sync runs in background.
        void (async () => {
          try {
            const { syncService } = await import('@/lib/services/sync-service');
            await syncService.performFullSync(branchId);
            console.log('[Order] Background sync completed after order creation');
          } catch (err) {
            console.error('[Order] Background sync failed after order creation:', err);
          }
        })();
      }

      const displayOrderNumber = (finalOrder as any)?.orderNumber ?? (finalOrder as any)?.order_number ?? '-';
      toast({
        title: `Order #${displayOrderNumber} Created`,
        description: `${paymentMethod} sale completed for ${total.toFixed(2)}.`,
      });

      // Remove completed table/tab carts instead of leaving empty cart shells behind.
      finalizeCartAfterSale(checkoutCartId);

      let printableOrder: Order | null = finalOrder;
      if (finalOrder?.id) {
        const latestOrder = await db.orders.get(finalOrder.id);
        if (latestOrder) {
          printableOrder = latestOrder as Order;
        }
      }

      return printableOrder;

    } catch (error) {
      console.error('Failed to create order:', error);
      toast({
        variant: 'destructive',
        title: 'Error creating order',
        description: error instanceof Error ? error.message : 'An unknown error occurred.',
      });
      return null;
    }
  };

  const renderPosForBusiness = () => {
    if ((isLoadingInventory && !hasCachedInventory) || !allInventory) {
        return (
          <Card className="flex h-full items-center justify-center">
            <CardContent className="text-center">
              <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-muted-foreground">Loading products...</p>
            </CardContent>
          </Card>
        )
    }
    const hasInventory = (allInventory?.length || 0) > 0;
    const emptyStateTitle = hasSearchQuery
      ? 'No products found'
      : hasInventory
        ? 'Search to show products'
        : 'No products available';
    const emptyStateDescription = hasSearchQuery
      ? undefined
      : hasInventory
        ? undefined
        : undefined;

    // Calculate tax using MRA mappings if EIS is enabled
    let cartTax = 0;
    if (eisEnabled && cart.length > 0) {
      // We'll calculate tax in handleCreateOrder, so pass a placeholder here
      // The actual tax will be calculated when checkout is called
      cartTax = 0; // Will be recalculated in handleCreateOrder
    } else if (defaultTaxRate) {
      const cartTotal = cart.reduce((acc, item) => acc + (item.isVariablePrice ? item.price : item.price * item.quantity), 0);
      const taxRate = defaultTaxRate.rate / 100;
      cartTax = taxRate > 0 ? (cartTotal / (1 + taxRate)) * taxRate : 0;
    }

    const posProps = {
      inventory: allInventory || [],
      displayItems: sellableItems || [],
      emptyStateTitle,
      emptyStateDescription,
      cart,
      cartTitle: activeCart?.title,
      branchId,
      onAddToCart: handleAddToCart,
      onUpdateQuantity: handleUpdateQuantity,
      onClearCart: handleClearCart,
      onCheckout: handleCreateOrder,
      viewMode,
      defaultTaxRate,
      activeCharges: activeCharges || [],
      eisEnabled,
      blockSalesIfTaxMappingMissing,
      hideDefaultMobileCartTrigger: isMultiCartEnabled,
      isMobileCartOpen,
      onMobileCartOpenChange: setIsMobileCartOpen,
      mobileCartDisplay: 'inline' as const,
      registerQuickAddHandler,
    };

    switch (currentBusinessType) {
      case 'Pharmacy':
        return <PharmacyPos {...posProps} />;
      case 'Restaurant':
        return <RestaurantPos {...posProps} />;
      case 'Bar & Liquor':
        return <BarLiquorPos {...posProps} />;
      case 'Supermarket':
      case 'Clothing & Fashion':
      case 'Hardware':
      case 'General Retail':
        return <SupermarketPos {...posProps} />;
      case 'Grocery':
        return <GroceryPos {...posProps} />;
      case 'Beauty Salon and Spa':
        return <BeautySalonPos {...posProps} />;
      default:
        return <p>No POS configuration for this business type.</p>;
    }
  };

  const toolbarQuickActionButtons = (
    <>
      <Button
        variant="outline"
        className="h-10 rounded-full px-4 shadow-sm"
        title="Manage Orders"
        onClick={() => setShowViewOrdersModal(true)}
      >
        <ClipboardList className="h-4 w-4 sm:mr-2" />
        <span className="hidden sm:inline">Orders</span>
      </Button>
      <Button
        variant="outline"
        className="h-10 w-10 rounded-full p-0 shadow-sm lg:hidden"
        title="Scan Barcode with Camera"
        onClick={() => setShowCameraScanner(true)}
      >
        <Camera className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        className="h-10 w-10 rounded-full p-0 shadow-sm"
        title="Configure Printer"
        onClick={() => setShowPrinterConfig(true)}
      >
        <Printer className="h-4 w-4" />
      </Button>
    </>
  );

  const hasUserSession =
    Boolean(activeSession) &&
    isSessionActive(activeSession) &&
    isSessionOwnedByCurrentUser(activeSession);

  if (!hasUserSession) {
    return (
      <>
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
            <DialogHeader>
              <DialogTitle>No Active Session</DialogTitle>
              <DialogDescription>
                A session is required for checkout, but orders can still be managed.
              </DialogDescription>
            </DialogHeader>
            <div className="text-center py-6">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400 mb-4">
                <AlertTriangle />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                <Button variant="outline" onClick={() => setShowViewOrdersModal(true)}>
                  <ClipboardList className="mr-2 h-4 w-4" />
                  Manage Orders
                </Button>
                <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <ViewOrdersModal
          branchId={branchId}
          isOpen={showViewOrdersModal}
          onOpenChange={setShowViewOrdersModal}
          businessType={currentBusinessType}
          currentUserRole={user?.role ?? null}
        />
      </>
    );
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent
          className="tauri-android-sidebar-safe-top left-0 top-0 m-0 flex h-full max-h-full w-full max-w-full translate-x-0 translate-y-0 flex-col rounded-none border-0 p-0 [&>button]:top-[calc(env(safe-area-inset-top,0px)+1rem)] sm:left-[50%] sm:top-[50%] sm:h-[90vh] sm:max-h-[90vh] sm:max-w-[95vw] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:[&>button]:top-4"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="p-3 pb-1 shrink-0">
            <DialogTitle className="text-lg">Point of Sale</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden px-4 pt-4 pb-4 min-h-0">
            <div className="flex flex-col items-stretch gap-4 h-full min-h-0">
              {isMultiCartEnabled && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <div className="min-w-[150px] flex-1 sm:min-w-0 sm:flex-none">
                    <Select
                      value={activeCart?.id ?? ''}
                      onValueChange={(value) => setActiveCartId(value)}
                    >
                      <SelectTrigger className="w-full sm:w-[220px]">
                        <SelectValue placeholder="Select cart" />
                      </SelectTrigger>
                      <SelectContent>
                        {carts.map((cartOption) => (
                          <SelectItem key={cartOption.id} value={cartOption.id}>
                            {cartOption.title || 'Cart'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    className="shrink-0 rounded-full px-4 shadow-sm"
                    onClick={() => {
                      setNewCartTitle('');
                      setIsCreateCartOpen(true);
                    }}
                  >
                    New Cart
                  </Button>
                  <div className="flex shrink-0 items-center gap-2">
                    {toolbarQuickActionButtons}
                  </div>
                </div>
              )}
              <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center shrink-0">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      placeholder={isMobileViewport ? "Search and tap to add..." : "Search products or scan barcode..."}
                      className="w-full pl-10"
                      value={searchQuery}
                      onFocus={() => {
                        if (isMobileViewport && hasSearchQuery) {
                          setIsSearchDropdownOpen(true);
                        }
                      }}
                      onBlur={() => {
                        if (!isMobileViewport) {
                          return;
                        }

                        if (searchDropdownCloseTimeoutRef.current) {
                          clearTimeout(searchDropdownCloseTimeoutRef.current);
                        }

                        searchDropdownCloseTimeoutRef.current = setTimeout(() => {
                          setIsSearchDropdownOpen(false);
                          searchDropdownCloseTimeoutRef.current = null;
                        }, 120);
                      }}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                        setSearchQuery(nextValue);
                        if (isMobileViewport) {
                          setIsSearchDropdownOpen(nextValue.trim().length > 0);
                        }
                      }}
                      onKeyDown={async (e) => {
                        if (!isMobileViewport) {
                          return;
                        }

                        if (e.key === 'Escape') {
                          setIsSearchDropdownOpen(false);
                          return;
                        }

                        if (e.key === 'Enter' && searchResults.length > 0) {
                          e.preventDefault();
                          await handleSearchResultSelect(
                            searchResults[0],
                            getSearchResultQuantity(String(searchResults[0].id))
                          );
                        }
                      }}
                      autoComplete="off"
                    />
                    {isMobileViewport && hasSearchQuery && isSearchDropdownOpen && (
                      <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-2xl border bg-background/95 p-2 shadow-xl backdrop-blur">
                        {searchResults.length > 0 ? (
                          <>
                            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                              {searchResults.map((item) => {
                                const itemId = String(item.id);
                                const dropdownQuantity = getSearchResultQuantity(itemId);
                                const requiresInteractiveFlow = item.isVariablePrice || item.isSoldInPortions;
                                const stockState = getSearchResultStockState(item);
                                const canIncreaseQuantity =
                                  stockState.remainingQuantity === null
                                    ? true
                                    : dropdownQuantity < stockState.remainingQuantity;
                                const canQuickAdd =
                                  stockState.canQuickAdd &&
                                  (stockState.remainingQuantity === null || dropdownQuantity <= stockState.remainingQuantity);

                                return (
                                  <div
                                    key={item.id}
                                    className="rounded-xl border border-border/60 bg-card/90 px-2.5 py-2 shadow-[0_12px_30px_-28px_hsl(var(--foreground)/0.55)]"
                                    onMouseDown={(event) => event.preventDefault()}
                                  >
                                    <div className="flex items-center gap-2">
                                      <div className="min-w-0 flex-1 space-y-1">
                                        <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                                          <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                                          {item.isVariablePrice && (
                                            <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-amber-700">
                                              Measured
                                            </span>
                                          )}
                                          {item.isSoldInPortions && (
                                            <span className="rounded-full bg-sky-100 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-sky-700">
                                              {item.portionName || 'Portion'}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                                          <span className="truncate">
                                            {[
                                              item.category,
                                              item.isVariablePrice
                                                ? `Variable price/${item.unitType || 'unit'}`
                                                : item.isSoldInPortions
                                                  ? `${item.portionName || 'portion'} sale`
                                                  : item.unitType || undefined,
                                            ].filter(Boolean).join(' • ')}
                                          </span>
                                        </div>
                                        <p className={`truncate text-[10px] font-medium ${stockState.toneClassName}`}>
                                          {stockState.label}
                                        </p>
                                      </div>
                                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                                        <span className="shrink-0 text-sm font-semibold text-primary">
                                          {Number(item.price || 0).toFixed(2)}
                                        </span>
                                        {requiresInteractiveFlow ? (
                                          <Button
                                            type="button"
                                            size="sm"
                                            className="h-8 rounded-full px-3 text-xs shadow-sm"
                                            variant="outline"
                                            disabled={!stockState.canQuickAdd}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => void handleSearchResultSelect(item)}
                                          >
                                            Open
                                          </Button>
                                        ) : (
                                          <div className="flex items-center gap-1.5">
                                            <div className="inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-muted/40 p-0.5 shadow-sm">
                                              <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7 rounded-full"
                                                disabled={dropdownQuantity <= 1}
                                                onMouseDown={(event) => event.preventDefault()}
                                                onClick={() => updateSearchResultQuantity(itemId, dropdownQuantity - 1)}
                                              >
                                                <Minus className="h-3.5 w-3.5" />
                                              </Button>
                                              <div className="min-w-[32px] px-1 text-center text-xs font-semibold">
                                                {dropdownQuantity}
                                              </div>
                                              <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7 rounded-full"
                                                disabled={!canIncreaseQuantity}
                                                onMouseDown={(event) => event.preventDefault()}
                                                onClick={() => updateSearchResultQuantity(itemId, dropdownQuantity + 1)}
                                              >
                                                <Plus className="h-3.5 w-3.5" />
                                              </Button>
                                            </div>
                                            <Button
                                              type="button"
                                              size="sm"
                                              className="h-8 rounded-full px-3 text-xs shadow-sm"
                                              disabled={!canQuickAdd}
                                              onMouseDown={(event) => event.preventDefault()}
                                              onClick={() => void handleSearchResultSelect(item, dropdownQuantity)}
                                            >
                                              Add
                                            </Button>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {sellableItems.length > searchResults.length && (
                              <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
                                Showing the first {searchResults.length} matches.
                              </p>
                            )}
                          </>
                        ) : (
                          <div className="px-3 py-4 text-sm text-muted-foreground">
                            No matching products found.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {(!isMultiCartEnabled || !isMobileViewport) && (
                  <div className="flex items-center gap-2">
                    {!isMultiCartEnabled && toolbarQuickActionButtons}
                    {!isMobileViewport && (
                      <Button
                        variant="outline"
                        className="h-10 w-10 rounded-full p-0 shadow-sm"
                        title={viewMode === 'grid' ? 'Switch to List View' : 'Switch to Grid View'}
                        onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                      >
                        {viewMode === 'grid' ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-hidden min-h-0">{renderPosForBusiness()}</div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ScannerConfigModal isOpen={showScannerConfig} onOpenChange={setShowScannerConfig} />
      <CameraBarcodeScannerModal
        isOpen={showCameraScanner}
        onOpenChange={setShowCameraScanner}
        onBarcodeDetected={handleCameraBarcodeDetected}
      />
      <PrinterConfigModal isOpen={showPrinterConfig} onOpenChange={setShowPrinterConfig} />
      <ViewOrdersModal
        branchId={branchId}
        isOpen={showViewOrdersModal}
        onOpenChange={setShowViewOrdersModal}
        onProcessSale={handleProcessTakeOrderForSale}
        businessType={currentBusinessType}
        currentUserRole={user?.role ?? null}
      />
      <Dialog open={isCreateCartOpen} onOpenChange={setIsCreateCartOpen}>
        <DialogContent className="max-w-sm" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>New Cart</DialogTitle>
            <DialogDescription>
              Give this cart a title or leave it blank to use the next default name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="new-cart-title">
              Cart Title
            </label>
            <Input
              id="new-cart-title"
              placeholder="e.g. Table 3"
              value={newCartTitle}
              onChange={(event) => setNewCartTitle(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateCartOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateCart}>
              Create Cart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
