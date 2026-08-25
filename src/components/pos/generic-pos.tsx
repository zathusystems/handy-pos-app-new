'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Plus,
  Minus,
  Trash2,
  X,
  UserPlus,
  CreditCard,
  DollarSign,
  ShoppingBasket,
  Package,
  Wallet,
  Smartphone,
  CheckCircle,
  Loader2,
  Printer,
  Eye,
} from 'lucide-react';
import type { CartItem, PaymentMethod } from '@/app/dashboard/pos/page';
import type { BusinessCharge, Customer, InventoryItem, Order, TaxRate } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { authFetch } from '@/lib/auth-fetch';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { calculateAppliedCharges, sumAppliedCharges } from '@/lib/business-charges';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Receipt2 as Receipt } from './receipt2';
import { PrinterConfigModal } from './printer-config-modal';
import { BillReceipt } from './bill-receipt';
import { db } from '@/lib/db';
import { useToast } from '@/hooks/use-toast';
import { getOfflineBusinessProfile } from '@/lib/business-profile';
import {
  DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
  DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
  DEFAULT_RECEIPT_FONT_WEIGHT,
  DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
  DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT,
  DEFAULT_RECEIPT_LINE_HEIGHT,
  PRINTER_CONFIG_UPDATED_EVENT,
  getDefaultReceiptBusinessNameFontSize,
  getDefaultReceiptFontSize,
  getDefaultReceiptLegalMarkerFontSize,
  getDefaultReceiptPaddingX,
  getDefaultReceiptQRCodeSize,
  normalizeReceiptBusinessNameFontSize,
  normalizeReceiptFontSize,
  normalizeReceiptFontWeight,
  normalizeReceiptLegalMarkerFontSize,
  normalizeReceiptLineHeight,
  normalizeReceiptPaddingX,
  normalizeReceiptQRCodeSize,
  normalizeReceiptTextScaleX,
  type PrinterSettings,
} from '@/lib/services/printer-service';
import { getNextReceiptCopyNumber, markReceiptPrinted } from '@/lib/services/receipt-copy-service';
import { safeLocalStorageGetItem } from '@/lib/safe-local-storage';
import {
  formatInventoryQuantity,
  formatQuantityWithUnit,
  getPortionQuantityDisplay,
} from '@/lib/quantity-format';
import { withLocalReceiptNumber } from '@/lib/local-receipt-number';
import { isKitchenBusinessType, type BusinessType } from '@/lib/inventory/config';


export type BuyerDetails = {
  customerId?: string;
  name?: string;
  phone?: string;
  tin?: string;
  laybuyDeposit?: number;
  laybuyPaymentMethod?: string;
};

export interface PosProps {
  inventory: InventoryItem[];
  displayItems?: InventoryItem[];
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  cart: CartItem[];
  cartTitle?: string;
  onAddToCart: (item: InventoryItem, quantity?: number, price?: number) => boolean | void | Promise<boolean | void>;
  onUpdateQuantity: (itemId: string, quantity: number) => void;
  onClearCart: () => void;
  onCheckout: (paymentMethod: PaymentMethod, tip: number, buyerDetails?: BuyerDetails) => Promise<Order | null>;
  productIcon?: React.ReactNode;
  viewMode?: 'grid' | 'list';
  defaultTaxRate?: TaxRate;
  activeCharges?: BusinessCharge[];
  eisEnabled?: boolean;
  blockSalesIfTaxMappingMissing?: boolean;
  branchId?: string;
  hideDefaultMobileCartTrigger?: boolean;
  isMobileCartOpen?: boolean;
  onMobileCartOpenChange?: (open: boolean) => void;
  checkoutMode?: 'dialog' | 'inline';
  mobileCartDisplay?: 'dialog' | 'inline';
  registerQuickAddHandler?: (handler: ((item: InventoryItem) => boolean | void | Promise<boolean | void>) | null) => void;
  businessType?: BusinessType;
}

type ReceiptDisplaySettings = {
  showHeader: boolean;
  showFooter: boolean;
  showQRCode: boolean;
  showItemDetails: boolean;
  showTaxBreakdown: boolean;
  receiptFontSize: number;
  receiptFontWeight: PrinterSettings['receiptFontWeight'];
  receiptLineHeight: number;
  receiptPaddingX: number;
  receiptBusinessNameFontSize: number;
  receiptBusinessNameFontWeight: PrinterSettings['receiptFontWeight'];
  receiptBusinessNameScaleX: number;
  receiptHeaderDetailScaleX: number;
  receiptLegalMarkerFontSize: number;
  receiptLegalMarkerFontWeight: PrinterSettings['receiptFontWeight'];
  receiptLegalMarkerScaleX: number;
  receiptQrCodeSize: number;
};

const DEFAULT_RECEIPT_DISPLAY_SETTINGS: ReceiptDisplaySettings = {
  showHeader: true,
  showFooter: true,
  showQRCode: true,
  showItemDetails: true,
  showTaxBreakdown: true,
  receiptFontSize: getDefaultReceiptFontSize('80mm'),
  receiptFontWeight: DEFAULT_RECEIPT_FONT_WEIGHT,
  receiptLineHeight: DEFAULT_RECEIPT_LINE_HEIGHT,
  receiptPaddingX: getDefaultReceiptPaddingX('80mm'),
  receiptBusinessNameFontSize: getDefaultReceiptBusinessNameFontSize('80mm'),
  receiptBusinessNameFontWeight: DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
  receiptBusinessNameScaleX: DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
  receiptHeaderDetailScaleX: DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
  receiptLegalMarkerFontSize: getDefaultReceiptLegalMarkerFontSize('80mm'),
  receiptLegalMarkerFontWeight: DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT,
  receiptLegalMarkerScaleX: DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X,
  receiptQrCodeSize: getDefaultReceiptQRCodeSize('80mm'),
};

const normalizeBuyerDetails = (details?: BuyerDetails | null): BuyerDetails | undefined => {
  if (!details) {
    return undefined;
  }

  const customerId = details.customerId?.trim();
  const name = details.name?.trim();
  const phone = details.phone?.trim();
  const tin = details.tin?.trim();
  const laybuyDeposit = Number(details.laybuyDeposit ?? 0);
  const hasLaybuyDeposit = Number.isFinite(laybuyDeposit) && laybuyDeposit > 0;
  const laybuyPaymentMethod = details.laybuyPaymentMethod?.trim();

  if (!customerId && !name && !phone && !tin && !hasLaybuyDeposit) {
    return undefined;
  }

  return {
    customerId: customerId || undefined,
    name: name || undefined,
    phone: phone || undefined,
    tin: tin || undefined,
    laybuyDeposit: hasLaybuyDeposit ? laybuyDeposit : undefined,
    laybuyPaymentMethod: laybuyPaymentMethod || undefined,
  };
};

const extractFiscalInvoiceNumber = (order: Partial<Order> | null | undefined): string => {
  return String((order as any)?.fiscalInvoiceNumber ?? (order as any)?.fiscal_invoice_number ?? '').trim();
};

const hasCompleteFiscalInvoiceNumber = (value: string | null | undefined): boolean => {
  const fiscal = String(value ?? '').trim();
  if (!fiscal) {
    return false;
  }

  const suffix = fiscal.split('-').pop() ?? '';
  if (!/^\d+$/.test(suffix)) {
    return true;
  }

  if (suffix.length < 8) {
    return false;
  }

  return Number.parseInt(suffix, 10) > 0;
};

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

const mappingReadinessRank = (mapping: any): number => {
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

  const currentRank = mappingReadinessRank(current);
  const candidateRank = mappingReadinessRank(candidate);
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
    const key = resolveMappingInventoryItemId(mapping);
    if (!key) {
      continue;
    }

    lookup.set(key, choosePreferredMapping(lookup.get(key), mapping));
  }

  return lookup;
};

const normalizeBranchIdentifier = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const maybeId = (value as any).id ?? (value as any).branch_id ?? (value as any).branchId ?? (value as any).branch;
    if (maybeId !== undefined && maybeId !== value) {
      return normalizeBranchIdentifier(maybeId);
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

type NormalizedTaxType = 'standard' | 'zero' | 'exempt' | 'unmapped';
type NormalizedTaxCalculationMethod = 'inclusive' | 'exclusive' | 'not_applicable' | 'unmapped';
type MappingStatus = 'ready' | 'pending' | 'unmapped';
type TaxCalculationBasis = 'gross_inclusive' | 'net_exclusive' | 'not_applicable' | 'unmapped';

type ProductTaxMappingDetail = {
  rate: number;
  taxAmount: number;
  netAmount: number;
  grossAmount: number;
  lineAmount: number;
  taxType: NormalizedTaxType;
  taxCalculationMethod: NormalizedTaxCalculationMethod;
  taxCalculationBasis: TaxCalculationBasis;
  taxableAmount: number;
  mappingStatus: MappingStatus;
  mappingId?: string;
  mappingBranchId?: string;
  mappingSource?: 'local' | 'default' | 'none';
};

type CartItemTaxDetail = {
  amount: number;
  rate: number;
  taxType: NormalizedTaxType;
  method: NormalizedTaxCalculationMethod;
  status: MappingStatus;
};

const normalizeMappedTaxType = (value: unknown): NormalizedTaxType => {
  const normalized = String(value || '').trim().toLowerCase();
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
};

const normalizeTaxCalculationMethod = (value: unknown): 'inclusive' | 'exclusive' => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('excl') ? 'exclusive' : 'inclusive';
};

const resolveMappingTaxMethod = (mapping: any): 'inclusive' | 'exclusive' => {
  if (!mapping) return 'inclusive';
  return normalizeTaxCalculationMethod(
    mapping.taxCalculationMethod ??
      mapping.tax_calculation_method ??
      mapping.calculationMethod ??
      mapping.calculation_method
  );
};

const formatTaxTypeLabel = (taxType: NormalizedTaxType): string => {
  if (taxType === 'zero') return 'Zero Rated';
  if (taxType === 'exempt') return 'Exempt';
  if (taxType === 'standard') return 'Standard';
  return 'Not Mapped';
};

const formatTaxMethodLabel = (method: NormalizedTaxCalculationMethod): string => {
  if (method === 'inclusive') return 'Inclusive';
  if (method === 'exclusive') return 'Exclusive';
  return 'N/A';
};

const formatTaxBasisLabel = (basis: TaxCalculationBasis): string => {
  if (basis === 'gross_inclusive') return 'Gross Price (Tax Included)';
  if (basis === 'net_exclusive') return 'Net Price (Tax Added)';
  if (basis === 'not_applicable') return 'Not Applicable';
  return 'Not Available';
};

const formatMappingStatusLabel = (status: MappingStatus): string => {
  if (status === 'ready') return 'Ready';
  if (status === 'pending') return 'Pending Approval/Sync';
  return 'No Mapping';
};

const formatTaxConditionLabel = (
  taxType: NormalizedTaxType,
  method: NormalizedTaxCalculationMethod,
  status: MappingStatus
): string => {
  if (status !== 'ready') {
    return formatMappingStatusLabel(status);
  }

  if (taxType === 'standard') {
    return `${formatTaxTypeLabel(taxType)} • ${formatTaxMethodLabel(method)}`;
  }

  return `${formatTaxTypeLabel(taxType)} • N/A`;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeApiCollection = <T,>(payload: any): T[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
};

const normalizeCustomerFromApi = (raw: any, fallbackBranchId: string): Customer | null => {
  const id = String(raw?.id ?? '').trim();
  if (!id) {
    return null;
  }

  const creditLimit = toFiniteNumber(raw?.creditLimit ?? raw?.credit_limit, 0);
  const currentBalance = toFiniteNumber(raw?.currentBalance ?? raw?.current_balance, 0);
  const customerTin = String(raw?.customerTin ?? raw?.customer_tin ?? '').trim();
  const vatRegistered = Boolean(raw?.vatRegistered ?? raw?.vat_registered ?? false);

  return {
    id,
    businessId: String(raw?.businessId ?? raw?.business ?? raw?.business_id ?? '').trim() || undefined,
    branchId: String(raw?.branchId ?? raw?.branch_id ?? raw?.branch ?? fallbackBranchId ?? '').trim() || fallbackBranchId,
    name: String(raw?.name ?? 'Unnamed Customer'),
    email: String(raw?.email ?? ''),
    phone: String(raw?.phone ?? ''),
    address: String(raw?.address ?? ''),
    notes: String(raw?.notes ?? ''),
    isActive: raw?.isActive ?? raw?.is_active ?? true,
    accountEnabled: raw?.accountEnabled ?? raw?.account_enabled ?? true,
    creditLimit,
    currentBalance,
    availableCredit: raw?.availableCredit ?? raw?.available_credit ?? null,
    hasCreditLimit: raw?.hasCreditLimit ?? raw?.has_credit_limit ?? creditLimit > 0,
    customerTin,
    customer_tin: customerTin,
    vatRegistered,
    vat_registered: vatRegistered,
    createdAt: String(raw?.createdAt ?? raw?.created_at ?? new Date().toISOString()),
    updatedAt: String(raw?.updatedAt ?? raw?.updated_at ?? new Date().toISOString()),
    _dirty: false,
    _operation: undefined,
  };
};

const getPortionDisplayForQuantity = (
  item: Pick<InventoryItem, 'unitType' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>,
  quantity: unknown
) => {
  const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);
  if (!item.isSoldInPortions || portionsPerUnit <= 0) {
    return null;
  }

  return getPortionQuantityDisplay({
    quantity,
    unitLabel: item.unitType || 'unit',
    portionName: item.portionName,
    portionsPerUnit,
  });
};

const formatItemQuantitySummary = (
  item: Pick<InventoryItem, 'unitType' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>,
  quantity: unknown
): string => {
  const portionDisplay = getPortionDisplayForQuantity(item, quantity);
  if (portionDisplay) {
    return portionDisplay.summaryText;
  }

  return formatQuantityWithUnit(quantity, item.unitType || 'unit', {
    maximumFractionDigits: 3,
  });
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

const formatItemQuantityControlLabel = (
  item: Pick<InventoryItem, 'unitType' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>,
  quantity: unknown
): string => {
  const portionDisplay = getPortionDisplayForQuantity(item, quantity);
  if (portionDisplay) {
    return portionDisplay.summaryText;
  }

  return formatInventoryQuantity(quantity, {
    maximumFractionDigits: 3,
  });
};

const formatPerUnitPriceLabel = (
  item: Pick<CartItem, 'price' | 'quantity' | 'unitType' | 'isVariablePrice' | 'isSoldInPortions' | 'portionName' | 'portionPrice' | 'portionsPerUnit'>,
  currencyFormatter: (amount: number) => string
): string => {
  const quantity = toFiniteNumber(item.quantity, 0);
  const unitLabel = String(item.unitType || 'unit').trim() || 'unit';
  const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);

  if (item.isSoldInPortions && portionsPerUnit > 0) {
    const portionLabel = String(item.portionName || 'portion').trim() || 'portion';
    const explicitPortionPrice = toFiniteNumber(item.portionPrice, 0);
    const portionPrice =
      explicitPortionPrice > 0
        ? explicitPortionPrice
        : toFiniteNumber(item.price, 0) / portionsPerUnit;

    return `@ ${currencyFormatter(portionPrice)}/${portionLabel}`;
  }

  const resolvedUnitPrice =
    item.isVariablePrice && quantity > 0
      ? toFiniteNumber(item.price, 0) / quantity
      : toFiniteNumber(item.price, 0);

  return `@ ${currencyFormatter(resolvedUnitPrice)}/${unitLabel}`;
};

const roundCartQuantity = (value: number): number => Number(value.toFixed(6));

const getCartItemModeLabel = (
  item: Pick<CartItem, 'isVariablePrice' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>
): string | null => {
  if (item.isVariablePrice) {
    return 'Measured';
  }

  const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);
  if (item.isSoldInPortions && portionsPerUnit > 0) {
    return String(item.portionName || 'Portion').trim() || 'Portion';
  }

  return null;
};

const getCartQuantityControlState = (
  item: Pick<CartItem, 'quantity' | 'unitType' | 'isVariablePrice' | 'isSoldInPortions' | 'portionName' | 'portionsPerUnit'>
) => {
  const quantity = Math.max(0, toFiniteNumber(item.quantity, 0));
  const unitLabel = String(item.unitType || 'unit').trim() || 'unit';
  const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);

  if (item.isSoldInPortions && portionsPerUnit > 0) {
    const portionLabel = String(item.portionName || 'portion').trim() || 'portion';
    const portionCount = Math.max(1, Math.round(quantity * portionsPerUnit));

    return {
      canAdjust: true,
      controlLabel: formatQuantityWithUnit(portionCount, portionLabel, {
        preferWholeNumbers: true,
        maximumFractionDigits: 0,
      }),
      decrementQuantity: portionCount <= 1 ? 0 : roundCartQuantity((portionCount - 1) / portionsPerUnit),
      incrementQuantity: roundCartQuantity((portionCount + 1) / portionsPerUnit),
      helperText: `Adjusts by 1 ${portionLabel}`,
    };
  }

  if (item.isVariablePrice) {
    return {
      canAdjust: false,
      controlLabel: formatItemQuantitySummary(item, quantity),
      decrementQuantity: quantity,
      incrementQuantity: quantity,
      helperText: `Entered by ${unitLabel}`,
    };
  }

  return {
    canAdjust: true,
    controlLabel: formatItemQuantityControlLabel(item, quantity),
    decrementQuantity: Math.max(0, roundCartQuantity(quantity - 1)),
    incrementQuantity: roundCartQuantity(quantity + 1),
    helperText: null,
  };
};

const CartQuantityControl = ({
  label,
  onDecrease,
  onIncrease,
  className,
  dense = false,
}: {
  label: string;
  onDecrease: () => void;
  onIncrease: () => void;
  className?: string;
  dense?: boolean;
}) => (
  <div
    className={cn(
      dense
        ? 'inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-background/95 p-0.5 shadow-sm'
        : 'inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/95 p-1 shadow-sm',
      className
    )}
  >
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        'rounded-full text-muted-foreground hover:bg-muted',
        dense ? 'h-7 w-7' : 'h-8 w-8'
      )}
      onClick={onDecrease}
    >
      <Minus className={cn(dense ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
    </Button>
    <div className={cn('text-center', dense ? 'min-w-[64px] px-1' : 'min-w-[88px] px-2')}>
      <span className={cn('block truncate font-semibold tracking-tight', dense ? 'text-xs' : 'text-sm')}>{label}</span>
    </div>
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        'rounded-full text-muted-foreground hover:bg-muted',
        dense ? 'h-7 w-7' : 'h-8 w-8'
      )}
      onClick={onIncrease}
    >
      <Plus className={cn(dense ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
    </Button>
  </div>
);

const ProductCard = ({
  item,
  onAddToCart,
  productIcon,
  currencyFormatter,
  canAddToCart,
  stockInfo,
  stockTone,
}: {
  item: InventoryItem;
  onAddToCart: (item: InventoryItem) => void;
  productIcon: React.ReactNode;
  currencyFormatter: (amount: number) => string;
  canAddToCart: boolean;
  stockInfo: string;
  stockTone: 'available' | 'warning' | 'out';
}) => {
  const price = item.price || 0;
  
  return (
    <Card
      className={cn(
        "flex cursor-pointer flex-col overflow-hidden transition-all hover:shadow-md",
        !canAddToCart && "opacity-50 cursor-not-allowed"
      )}
      role="button"
    >
      <div className="flex h-24 items-center justify-center bg-muted">
        {productIcon}
      </div>
      <CardContent className="flex-1 p-3">
        <p className="font-semibold">{item.name}</p>
        <p className="text-sm text-muted-foreground">{item.category}</p>
        <p className={cn(
          "text-xs mt-1 font-medium",
          stockTone === 'available'
            ? "text-green-600"
            : stockTone === 'warning'
              ? "text-amber-600"
              : "text-red-600"
        )}>
          {stockInfo}
        </p>
      </CardContent>
      <CardFooter className="flex items-center justify-between p-3 pt-0">
        <p className="text-base font-bold text-primary">
          {currencyFormatter(price)}
          {item.isVariablePrice && <span className="text-xs font-normal text-muted-foreground">/{item.unitType}</span>}
        </p>
        {item.isVariablePrice && <Badge variant="outline">By Weight</Badge>}
      </CardFooter>
    </Card>
  );
};

const CartItemView = ({
  item,
  onUpdateQuantity,
  currencyFormatter,
  taxDetail,
  showTaxStatus,
  layout = 'regular',
}: {
  item: CartItem;
  onUpdateQuantity: (itemId: string, quantity: number) => void;
  currencyFormatter: (amount: number) => string;
  taxDetail?: CartItemTaxDetail;
  showTaxStatus?: boolean;
  layout?: 'regular' | 'compact';
}) => {
  const total = item.isVariablePrice ? item.price : item.price * item.quantity;
  const quantitySummary = formatItemQuantitySummary(item, item.quantity);
  const quantityControlState = getCartQuantityControlState(item);
  const unitPriceLabel = formatPerUnitPriceLabel(item, currencyFormatter);
  const modeLabel = getCartItemModeLabel(item);
  const taxRateLabel = taxDetail && Number.isFinite(taxDetail.rate) ? `${taxDetail.rate.toFixed(2)}%` : '0%';
  const taxMethodLabel =
    taxDetail?.method === 'exclusive'
      ? 'EXC'
      : taxDetail?.method === 'inclusive'
        ? 'INC'
        : 'N/A';
  const taxDescriptor = taxDetail
    ? taxDetail.taxType === 'standard'
      ? `VAT ${taxRateLabel}${taxMethodLabel !== 'N/A' ? ` (${taxMethodLabel})` : ''}`
      : taxDetail.taxType === 'unmapped'
        ? 'Tax'
        : `${formatTaxTypeLabel(taxDetail.taxType)} VAT`
    : '';
  const taxStatusLabel =
    taxDetail && showTaxStatus && taxDetail.status !== 'ready'
      ? ` • ${formatMappingStatusLabel(taxDetail.status)}`
      : '';
  const taxSummary = taxDetail
    ? `${taxDescriptor}${taxStatusLabel}: ${currencyFormatter(taxDetail.amount)}`
    : null;
  const removeButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        'rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
        layout === 'compact' ? 'h-7 w-7' : 'h-8 w-8'
      )}
      onClick={() => onUpdateQuantity(item.id, 0)}
    >
      <Trash2 className={cn(layout === 'compact' ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
    </Button>
  );

  if (layout === 'compact') {
    return (
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="min-w-0 flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold leading-tight">{item.name}</p>
            {modeLabel && (
              <Badge variant="secondary" className="rounded-full px-1.5 py-0 text-[9px] uppercase tracking-[0.1em]">
                {modeLabel}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{quantitySummary}</span>
            <span className="text-muted-foreground/40">•</span>
            <span className="truncate">{unitPriceLabel}</span>
          </div>
          {taxSummary && <p className="truncate text-[10px] text-muted-foreground">{taxSummary}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <p className="shrink-0 text-sm font-semibold leading-tight text-foreground">{currencyFormatter(total)}</p>
          <div className="flex items-center gap-1.5">
            {quantityControlState.canAdjust ? (
              <CartQuantityControl
                dense
                label={quantityControlState.controlLabel}
                onDecrease={() => onUpdateQuantity(item.id, quantityControlState.decrementQuantity)}
                onIncrease={() => onUpdateQuantity(item.id, quantityControlState.incrementQuantity)}
              />
            ) : (
              <div className="inline-flex items-center gap-1 rounded-full border border-amber-200/80 bg-amber-50/80 px-2 py-1 text-[10px] font-medium text-amber-700">
                <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[9px] uppercase tracking-[0.1em]">
                  Measured
                </span>
                <span>{quantityControlState.controlLabel}</span>
              </div>
            )}
            {removeButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2.5 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{item.name}</p>
          {modeLabel && (
            <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px] uppercase tracking-[0.12em]">
              {modeLabel}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground break-words">{quantitySummary}</p>
        <p className="text-xs text-muted-foreground break-words">{unitPriceLabel}</p>
        {taxSummary && <p className="text-xs text-muted-foreground">{taxSummary}</p>}
      </div>
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-1.5">
          <p className="min-w-[96px] text-right font-semibold">{currencyFormatter(total)}</p>
          <div className="flex items-center gap-2">
            {quantityControlState.canAdjust ? (
              <CartQuantityControl
                label={quantityControlState.controlLabel}
                onDecrease={() => onUpdateQuantity(item.id, quantityControlState.decrementQuantity)}
                onIncrease={() => onUpdateQuantity(item.id, quantityControlState.incrementQuantity)}
              />
            ) : (
              <div className="inline-flex min-h-10 items-center gap-2 rounded-full border border-amber-200/80 bg-amber-50/80 px-3 py-1.5 text-xs font-medium text-amber-700">
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                  Measured
                </span>
                <span>{quantityControlState.controlLabel}</span>
              </div>
            )}
            {removeButton}
          </div>
        </div>
      </div>
    </div>
  );
};

const PaymentDialog = ({
    subtotal,
    tax,
    taxLabel,
    defaultTaxRate,
    onCheckout,
    onClose,
    currencyFormatter,
    resetToken,
    cart,
    eisEnabled,
    blockSalesIfTaxMappingMissing,
    branchId,
    onConfigurePrinter,
    displayMode = 'dialog',
    onStepChange,
    businessType,
    activeCharges = [],
}: {
    subtotal: number;
    tax: number;
    taxLabel: string;
    onCheckout: (paymentMethod: PaymentMethod, tip: number, buyerDetails?: BuyerDetails) => Promise<Order | null>;
    onClose: () => void;
    currencyFormatter: (amount: number) => string;
    resetToken: number;
    cart?: CartItem[];
    eisEnabled?: boolean;
    blockSalesIfTaxMappingMissing?: boolean;
    branchId?: string;
    onConfigurePrinter: () => void;
    defaultTaxRate?: TaxRate | null;
    activeCharges?: BusinessCharge[];
    displayMode?: 'dialog' | 'inline';
    onStepChange?: (step: 'payment' | 'confirmation') => void;
    businessType?: BusinessType;
}) => {
    const { toast } = useToast();
    const [step, setStep] = useState<'payment' | 'confirmation'>('payment');
    const [completedOrder, setCompletedOrder] = useState<Order | null>(null);
    const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod | null>(null);
    const [cashPaid, setCashPaid] = useState<number | string>('');
    const [recordChangeAsTip, setRecordChangeAsTip] = useState(false);
    const [laybuyDeposit, setLaybuyDeposit] = useState<number | string>('');
    const [laybuyPaymentMethod, setLaybuyPaymentMethod] = useState('Cash');
    const [showBuyerDetails, setShowBuyerDetails] = useState(false);
    const [selectedCustomerId, setSelectedCustomerId] = useState('');
    const [buyerName, setBuyerName] = useState('');
    const [buyerPhone, setBuyerPhone] = useState('');
    const [buyerTin, setBuyerTin] = useState('');
    const [isLoadingCustomers, setIsLoadingCustomers] = useState(false);
    const [calculatedTax, setCalculatedTax] = useState(tax);
    const [calculatedNetAmount, setCalculatedNetAmount] = useState(subtotal);
    const [calculatedGrossAmount, setCalculatedGrossAmount] = useState(subtotal + tax);
    const [calculatedTaxLabel, setCalculatedTaxLabel] = useState(taxLabel);
    const [productTaxMappings, setProductTaxMappings] = useState<Record<string, ProductTaxMappingDetail>>({});
    const [unmappedProducts, setUnmappedProducts] = useState<string[]>([]);
    const [isProcessingPayment, setIsProcessingPayment] = useState(false);
    const shouldEnforceTaxMapping = eisEnabled && blockSalesIfTaxMappingMissing === true;
    const defaultTaxRateDecimal = defaultTaxRate ? defaultTaxRate.rate / 100 : 0;
    const activeBranchId = useMemo(
        () => branchId ?? safeLocalStorageGetItem('handypos-active-branch') ?? 'main',
        [branchId]
    );
    const normalizedActiveBranchId = useMemo(
        () => normalizeBranchIdentifier(activeBranchId),
        [activeBranchId]
    );
    const accountCustomers = useLiveQuery<Customer[]>(
        () => {
            const branchCandidates = Array.from(new Set(
                [activeBranchId, normalizedActiveBranchId]
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            ));

            return branchCandidates.length > 0
                ? db.customers.where('branchId').anyOf(branchCandidates).toArray()
                : Promise.resolve([]);
        },
        [activeBranchId, normalizedActiveBranchId]
    ) || [];
    const customerFetchAttemptedRef = useRef<Set<string>>(new Set());
    const mappingRefreshAttemptedRef = useRef(false);
    const mappingItemFetchAttemptedRef = useRef(false);
    const taxMethodSummary = useMemo(() => {
        const methods = new Set<'inclusive' | 'exclusive'>();
        Object.values(productTaxMappings).forEach((mapping) => {
            if (mapping.taxCalculationMethod === 'inclusive' || mapping.taxCalculationMethod === 'exclusive') {
                methods.add(mapping.taxCalculationMethod);
            }
        });

        if (methods.size === 1) {
            return methods.has('exclusive') ? 'Exclusive' : 'Inclusive';
        }
        if (methods.size > 1) {
            return 'Mixed';
        }
        if (!shouldEnforceTaxMapping && defaultTaxRateDecimal > 0) {
            return 'Default (Inclusive)';
        }
        return 'N/A';
    }, [productTaxMappings, shouldEnforceTaxMapping, defaultTaxRateDecimal]);
    const customerOptions = useMemo(
        () => accountCustomers
            .filter((customer) => customer.isActive !== false)
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
        [accountCustomers]
    );
    const hideLaybuyPayment = isKitchenBusinessType(businessType);
    const selectedCustomer = useMemo(
        () => accountCustomers.find((customer) => String(customer.id) === selectedCustomerId) || null,
        [accountCustomers, selectedCustomerId]
    );
    const customerRequiredPayment = selectedPaymentMethod === 'On Account' || selectedPaymentMethod === 'Laybuy';
    const isCustomerDetailsOpen = showBuyerDetails || customerRequiredPayment;

    const handleCustomerSelect = useCallback((customerId: string) => {
        setSelectedCustomerId(customerId);

        if (!customerId) {
            return;
        }

        const selectedCustomer = accountCustomers.find((customer) => String(customer.id) === customerId);
        if (!selectedCustomer) {
            return;
        }

        setBuyerName(selectedCustomer.name || '');
        setBuyerPhone(selectedCustomer.phone || '');
        setBuyerTin(selectedCustomer.customerTin || selectedCustomer.customer_tin || '');
    }, [accountCustomers]);

    useEffect(() => {
        setStep('payment');
        setCompletedOrder(null);
        setSelectedPaymentMethod(null);
        setCashPaid('');
        setRecordChangeAsTip(false);
        setLaybuyDeposit('');
        setLaybuyPaymentMethod('Cash');
        setShowBuyerDetails(false);
        setSelectedCustomerId('');
        setBuyerName('');
        setBuyerPhone('');
        setBuyerTin('');
        setCalculatedTax(tax);
        setCalculatedNetAmount(subtotal);
        setCalculatedGrossAmount(subtotal + tax);
        setCalculatedTaxLabel(taxLabel);
        setProductTaxMappings({});
        setUnmappedProducts([]);
        setIsProcessingPayment(false);
        mappingRefreshAttemptedRef.current = false;
        mappingItemFetchAttemptedRef.current = false;
    }, [resetToken, subtotal, tax, taxLabel]);

    useEffect(() => {
        if (!isCustomerDetailsOpen || !normalizedActiveBranchId) {
            return;
        }

        if (customerFetchAttemptedRef.current.has(normalizedActiveBranchId)) {
            return;
        }

        let cancelled = false;
        customerFetchAttemptedRef.current.add(normalizedActiveBranchId);

        const fetchCustomers = async () => {
            setIsLoadingCustomers(true);

            try {
                const response = await authFetch.fetch(
                    `/customers/?branch_id=${encodeURIComponent(normalizedActiveBranchId)}`
                );
                const customers = normalizeApiCollection<any>(response);

                for (const rawCustomer of customers) {
                    if (cancelled) {
                        return;
                    }

                    const normalizedCustomer = normalizeCustomerFromApi(rawCustomer, activeBranchId);
                    if (!normalizedCustomer) {
                        continue;
                    }

                    const existingCustomer = await db.customers.get(normalizedCustomer.id);
                    if (existingCustomer?._dirty) {
                        continue;
                    }

                    await db.customers.put({
                        ...existingCustomer,
                        ...normalizedCustomer,
                    });
                }
            } catch (error) {
                console.warn('[PaymentDialog] Could not refresh customers for checkout', error);
            } finally {
                if (!cancelled) {
                    setIsLoadingCustomers(false);
                }
            }
        };

        void fetchCustomers();

        return () => {
            cancelled = true;
        };
    }, [activeBranchId, isCustomerDetailsOpen, normalizedActiveBranchId]);

    useEffect(() => {
        let cancelled = false;

        const calculateCorrectTax = async () => {
            const effectiveTaxLabel = eisEnabled && shouldEnforceTaxMapping
                ? 'VAT Amount (MRA Rules Applied)'
                : taxLabel;
            console.log('[PaymentDialog] Starting tax calculation, cart items:', cart?.length);
            if (!cart || cart.length === 0) {
                console.log('[PaymentDialog] No cart items, using default tax:', tax);
                if (!cancelled) {
                    setCalculatedTax(tax);
                    setCalculatedNetAmount(subtotal);
                    setCalculatedGrossAmount(subtotal + tax);
                    setCalculatedTaxLabel(effectiveTaxLabel);
                    setProductTaxMappings({});
                    setUnmappedProducts([]);
                }
                return;
            }

            try {
                const shouldScopeByBranch =
                    Boolean(normalizedActiveBranchId) &&
                    !['main', 'main-branch', 'main_branch'].includes(normalizedActiveBranchId.toLowerCase());
                const localMappings = await db.mraMappings.toArray();
                const scopedMappings = localMappings.filter((mapping) => {
                    const mappingBranchId = normalizeBranchIdentifier(
                        (mapping as any).branchId ??
                        (mapping as any).branch_id ??
                        (mapping as any).branch
                    );

                    // Backward compatibility: keep unscoped local mappings,
                    // but prefer branch-scoped mappings when metadata exists.
                    if (!mappingBranchId) {
                        return true;
                    }
                    if (!shouldScopeByBranch) {
                        return true;
                    }
                    return mappingBranchId === normalizedActiveBranchId;
                });

                let mappingByItemId = buildMappingLookup(scopedMappings);
                const missingMappingKeys: string[] = [];

                for (const cartItem of cart) {
                    const primaryInventoryItemId = String(cartItem.inventoryItemId || '').trim();
                    const fallbackInventoryItemId = resolveCartInventoryItemId(cartItem) || String(cartItem.id || '').trim();
                    const preferredMappingKey = primaryInventoryItemId || fallbackInventoryItemId;
                    let localMapping = mappingByItemId.get(preferredMappingKey);
                    if (!localMapping && fallbackInventoryItemId && fallbackInventoryItemId !== preferredMappingKey) {
                        localMapping = mappingByItemId.get(fallbackInventoryItemId);
                    }
                    if (!localMapping && preferredMappingKey) {
                        missingMappingKeys.push(preferredMappingKey);
                    }
                }

                if (
                    missingMappingKeys.length > 0 &&
                    !mappingRefreshAttemptedRef.current &&
                    typeof navigator !== 'undefined' &&
                    navigator.onLine &&
                    branchId
                ) {
                    mappingRefreshAttemptedRef.current = true;
                    try {
                        const backendBranchId = normalizeBranchIdentifier(branchId);
                        if (backendBranchId) {
                            const mappingsResponse = await authFetch.fetch<any>(
                                `/inventory/mra-mappings/?branch_id=${encodeURIComponent(backendBranchId)}`
                            );
                            const refreshedMappings = Array.isArray(mappingsResponse)
                                ? mappingsResponse
                                : Array.isArray(mappingsResponse?.results)
                                    ? mappingsResponse.results
                                    : [];
                            const nowIso = new Date().toISOString();

                            for (const rawMapping of refreshedMappings) {
                                const mappingItemId = resolveMappingInventoryItemId(rawMapping);
                                if (!mappingItemId) {
                                    continue;
                                }

                                const rawTaxType = rawMapping.mra_tax_type ?? rawMapping.mraTaxType;
                                const taxType =
                                    rawTaxType === 'zero' || rawTaxType === 'exempt'
                                        ? rawTaxType
                                        : 'standard';
                                const calculationMethod = resolveMappingTaxMethod(rawMapping);

                                await db.mraMappings.put({
                                    id: String(rawMapping.id || `${mappingItemId}-mapping`),
                                    inventoryItemId: mappingItemId,
                                    branchId: normalizeBranchIdentifier(
                                        rawMapping.branch ??
                                        rawMapping.branch_id ??
                                        backendBranchId
                                    ) || undefined,
                                    mraProductCode: rawMapping.mra_product_code || rawMapping.mraProductCode || '',
                                    mraProductName: rawMapping.mra_product_name || rawMapping.mraProductName || '',
                                    mraTaxType: taxType,
                                    mraTaxRate: Number(rawMapping.mra_tax_rate ?? rawMapping.mraTaxRate ?? 0),
                                    mraUnitMeasure: rawMapping.mra_unit_measure || rawMapping.mraUnitMeasure || '',
                                    taxCalculationMethod: calculationMethod,
                                    isApproved: Boolean(rawMapping.is_approved ?? rawMapping.isApproved),
                                    approvedAt: rawMapping.approved_at || rawMapping.approvedAt || undefined,
                                    mraSynced: Boolean(rawMapping.mra_synced ?? rawMapping.mraSynced),
                                    lastSyncedAt: rawMapping.last_synced_at || rawMapping.lastSyncedAt || undefined,
                                    createdAt: rawMapping.created_at || rawMapping.createdAt || nowIso,
                                    updatedAt: nowIso,
                                    _dirty: false,
                                    _synced_at: nowIso,
                                });
                            }

                            const refreshedLocalMappings = await db.mraMappings.toArray();
                            const refreshedScopedMappings = refreshedLocalMappings.filter((mapping) => {
                                const mappingBranchId = normalizeBranchIdentifier(
                                    (mapping as any).branchId ??
                                    (mapping as any).branch_id ??
                                    (mapping as any).branch
                                );

                                if (!mappingBranchId) {
                                    return true;
                                }
                                if (!shouldScopeByBranch) {
                                    return true;
                                }
                                return mappingBranchId === normalizedActiveBranchId;
                            });
                            mappingByItemId = buildMappingLookup(refreshedScopedMappings);
                        }
                    } catch (refreshError) {
                        console.warn('[PaymentDialog] Failed to refresh MRA mappings:', refreshError);
                    }
                }

                if (
                    missingMappingKeys.length > 0 &&
                    !mappingItemFetchAttemptedRef.current &&
                    typeof navigator !== 'undefined' &&
                    navigator.onLine &&
                    branchId
                ) {
                    mappingItemFetchAttemptedRef.current = true;
                    try {
                        const backendBranchId = normalizeBranchIdentifier(branchId);
                        if (backendBranchId) {
                            const unresolvedKeys: string[] = [];
                            for (const cartItem of cart) {
                                const primaryInventoryItemId = String(cartItem.inventoryItemId || '').trim();
                                const fallbackInventoryItemId = resolveCartInventoryItemId(cartItem) || String(cartItem.id || '').trim();
                                const preferredMappingKey = primaryInventoryItemId || fallbackInventoryItemId;
                                let localMapping = mappingByItemId.get(preferredMappingKey);
                                if (!localMapping && fallbackInventoryItemId && fallbackInventoryItemId !== preferredMappingKey) {
                                    localMapping = mappingByItemId.get(fallbackInventoryItemId);
                                }
                                if (!localMapping && preferredMappingKey) {
                                    unresolvedKeys.push(preferredMappingKey);
                                }
                            }

                            for (const inventoryItemId of unresolvedKeys) {
                                try {
                                    const response = await authFetch.fetch<any>(
                                        `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(inventoryItemId)}&branch_id=${encodeURIComponent(backendBranchId)}`
                                    );
                                    const mappings = Array.isArray(response)
                                        ? response
                                        : Array.isArray(response?.results)
                                            ? response.results
                                            : [];
                                    if (!mappings.length) {
                                        continue;
                                    }

                                    const readyMapping =
                                        mappings.find((m: any) => Boolean(m.is_approved ?? m.isApproved) && Boolean(m.mra_synced ?? m.mraSynced)) ||
                                        mappings[0];

                                    const rawTaxType = readyMapping.mra_tax_type ?? readyMapping.mraTaxType;
                                    const taxType =
                                        rawTaxType === 'zero' || rawTaxType === 'exempt'
                                            ? rawTaxType
                                            : 'standard';
                                    const calculationMethod = resolveMappingTaxMethod(readyMapping);
                                    const nowIso = new Date().toISOString();

                                    await db.mraMappings.put({
                                        id: String(readyMapping.id || `${inventoryItemId}-mapping`),
                                        inventoryItemId,
                                        branchId: normalizeBranchIdentifier(
                                            readyMapping.branch ??
                                            readyMapping.branch_id ??
                                            backendBranchId
                                        ) || undefined,
                                        mraProductCode: readyMapping.mra_product_code || readyMapping.mraProductCode || '',
                                        mraProductName: readyMapping.mra_product_name || readyMapping.mraProductName || '',
                                        mraTaxType: taxType,
                                        mraTaxRate: Number(readyMapping.mra_tax_rate ?? readyMapping.mraTaxRate ?? 0),
                                        mraUnitMeasure: readyMapping.mra_unit_measure || readyMapping.mraUnitMeasure || '',
                                        taxCalculationMethod: calculationMethod,
                                        isApproved: Boolean(readyMapping.is_approved ?? readyMapping.isApproved),
                                        approvedAt: readyMapping.approved_at || readyMapping.approvedAt || undefined,
                                        mraSynced: Boolean(readyMapping.mra_synced ?? readyMapping.mraSynced),
                                        lastSyncedAt: readyMapping.last_synced_at || readyMapping.lastSyncedAt || undefined,
                                        createdAt: readyMapping.created_at || readyMapping.createdAt || nowIso,
                                        updatedAt: nowIso,
                                        _dirty: false,
                                        _synced_at: nowIso,
                                    });
                                } catch (itemError) {
                                    console.warn('[PaymentDialog] Failed to fetch mapping for item:', inventoryItemId, itemError);
                                }
                            }

                            const refreshedLocalMappings = await db.mraMappings.toArray();
                            const refreshedScopedMappings = refreshedLocalMappings.filter((mapping) => {
                                const mappingBranchId = normalizeBranchIdentifier(
                                    (mapping as any).branchId ??
                                    (mapping as any).branch_id ??
                                    (mapping as any).branch
                                );

                                if (!mappingBranchId) {
                                    return true;
                                }
                                if (!shouldScopeByBranch) {
                                    return true;
                                }
                                return mappingBranchId === normalizedActiveBranchId;
                            });
                            mappingByItemId = buildMappingLookup(refreshedScopedMappings);
                        }
                    } catch (refreshError) {
                        console.warn('[PaymentDialog] Failed to fetch per-item MRA mappings:', refreshError);
                    }
                }

                const perItemFetchedMappings = new Map<string, any>();
                let totalTax = 0;
                let totalNet = 0;
                let totalGross = 0;
                const mappings: Record<string, ProductTaxMappingDetail> = {};
                const unmapped: string[] = [];
                
                for (const cartItem of cart) {
                    const itemId = String(cartItem.id);
                    const primaryInventoryItemId = String(cartItem.inventoryItemId || '').trim();
                    const fallbackInventoryItemId = resolveCartInventoryItemId(cartItem) || String(cartItem.id || '').trim();

                    // Prefer the canonical inventory item id from cart metadata,
                    // then fall back to cart line id for legacy entries.
                    const preferredMappingKey = primaryInventoryItemId || fallbackInventoryItemId;
                    let localMapping = mappingByItemId.get(preferredMappingKey);
                    if (!localMapping && fallbackInventoryItemId && fallbackInventoryItemId !== preferredMappingKey) {
                        localMapping = mappingByItemId.get(fallbackInventoryItemId);
                    }
                    if (!localMapping && preferredMappingKey && perItemFetchedMappings.has(preferredMappingKey)) {
                        localMapping = perItemFetchedMappings.get(preferredMappingKey);
                    }
                    if (!localMapping && preferredMappingKey && typeof navigator !== 'undefined' && navigator.onLine && branchId) {
                        try {
                            const backendBranchId = normalizeBranchIdentifier(branchId);
                            const response = await authFetch.fetch<any>(
                                `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(preferredMappingKey)}&branch_id=${encodeURIComponent(backendBranchId)}`
                            );
                            const fetchedMappings = Array.isArray(response)
                                ? response
                                : Array.isArray(response?.results)
                                    ? response.results
                                    : [];
                            if (fetchedMappings.length) {
                                const readyMapping =
                                    fetchedMappings.find((m: any) => Boolean(m.is_approved ?? m.isApproved) && Boolean(m.mra_synced ?? m.mraSynced)) ||
                                    fetchedMappings[0];
                                perItemFetchedMappings.set(preferredMappingKey, readyMapping);
                                localMapping = readyMapping;
                            }
                        } catch (fetchError) {
                            console.warn('[PaymentDialog] Failed to fetch mapping for cart item:', preferredMappingKey, fetchError);
                        }
                    }
                    const lineAmount = cartItem.isVariablePrice
                        ? Number(cartItem.price || 0)
                        : Number(cartItem.price || 0) * Number(cartItem.quantity || 0);
                    let itemTax = 0;
                    let itemNet = lineAmount;
                    let itemGross = lineAmount;
                    let taxRate = 0;
                    let taxCalculationBasis: TaxCalculationBasis = 'not_applicable';
                    const isApproved = Boolean(localMapping?.isApproved ?? localMapping?.is_approved);
                    const isSynced = Boolean(localMapping?.mraSynced ?? localMapping?.mra_synced);
                    
                    if (localMapping && isApproved && isSynced) {
                        const taxType = normalizeMappedTaxType(localMapping.mraTaxType || localMapping.mra_tax_type);
                        taxRate = Number(localMapping.mraTaxRate ?? localMapping.mra_tax_rate ?? 0);
                        const normalizedRate = Number.isFinite(taxRate) ? taxRate : 0;
                        let taxCalculationMethod: NormalizedTaxCalculationMethod = 'not_applicable';

                        if (taxType === 'zero' || taxType === 'exempt') {
                            itemTax = 0;
                            itemNet = lineAmount;
                            itemGross = lineAmount;
                            taxCalculationBasis = 'not_applicable';
                            console.log(`[PaymentDialog] ✓ Product ${cartItem.name} is ${taxType.toUpperCase()} - no tax applied`);
                        } else {
                            taxCalculationMethod = resolveMappingTaxMethod(localMapping);
                            const effectiveTaxRate = normalizedRate / 100;
                            
                            if (taxCalculationMethod === 'exclusive') {
                                itemTax = lineAmount * effectiveTaxRate;
                                itemNet = lineAmount;
                                itemGross = lineAmount + itemTax;
                                taxCalculationBasis = 'net_exclusive';
                                console.log(`[PaymentDialog] ✓ Using EXCLUSIVE tax for ${cartItem.name}: ${normalizedRate}% (added tax: ${itemTax})`);
                            } else {
                                itemTax = effectiveTaxRate > 0
                                    ? lineAmount * effectiveTaxRate / (1 + effectiveTaxRate)
                                    : 0;
                                itemGross = lineAmount;
                                itemNet = lineAmount - itemTax;
                                taxCalculationBasis = 'gross_inclusive';
                                console.log(`[PaymentDialog] ✓ Using INCLUSIVE tax for ${cartItem.name}: ${normalizedRate}% (extracted tax: ${itemTax})`);
                            }
                        }
                        
                        totalTax += itemTax;
                        totalNet += itemNet;
                        totalGross += itemGross;
                        mappings[itemId] = {
                            rate: normalizedRate,
                            taxAmount: itemTax,
                            netAmount: itemNet,
                            grossAmount: itemGross,
                            lineAmount,
                            taxType,
                            taxCalculationMethod,
                            taxCalculationBasis,
                            taxableAmount: itemNet,
                            mappingStatus: 'ready',
                            mappingId: localMapping?.id ? String(localMapping.id) : undefined,
                            mappingBranchId: String(
                                localMapping?.branchId ??
                                localMapping?.branch_id ??
                                localMapping?.branch ??
                                ''
                            ).trim() || undefined,
                            mappingSource: 'local',
                        };
                    } else {
                        const hasLocalMapping = Boolean(localMapping);
                        const mappingStatus: MappingStatus = hasLocalMapping ? 'pending' : 'unmapped';
                        const reasonSuffix = hasLocalMapping ? ' (mapping pending approval/sync)' : '';
                        console.log(`[PaymentDialog] ✗ Mapping not ready for ${cartItem.name}${reasonSuffix}`);
                        if (shouldEnforceTaxMapping) {
                            unmapped.push(`${cartItem.name}${reasonSuffix}`);
                        }
                        const fallbackTaxType = hasLocalMapping
                            ? normalizeMappedTaxType(localMapping.mraTaxType || localMapping.mra_tax_type)
                            : 'standard';
                        const fallbackRate = hasLocalMapping
                            ? Number(localMapping.mraTaxRate ?? localMapping.mra_tax_rate ?? 0)
                            : 0;
                        const normalizedFallbackRate = Number.isFinite(fallbackRate) ? fallbackRate : 0;
                        const fallbackMethod = hasLocalMapping
                            ? resolveMappingTaxMethod(localMapping)
                            : 'inclusive';

                        if (!shouldEnforceTaxMapping && hasLocalMapping && (fallbackTaxType === 'zero' || fallbackTaxType === 'exempt')) {
                            itemTax = 0;
                            itemNet = lineAmount;
                            itemGross = lineAmount;
                            taxCalculationBasis = 'not_applicable';
                            totalNet += itemNet;
                            totalGross += itemGross;
                            mappings[itemId] = {
                                rate: normalizedFallbackRate,
                                taxAmount: 0,
                                netAmount: itemNet,
                                grossAmount: itemGross,
                                lineAmount,
                                taxType: fallbackTaxType,
                                taxCalculationMethod: 'not_applicable',
                                taxCalculationBasis,
                                taxableAmount: itemNet,
                                mappingStatus,
                                mappingId: localMapping?.id ? String(localMapping.id) : undefined,
                                mappingBranchId: String(
                                    localMapping?.branchId ??
                                    localMapping?.branch_id ??
                                    localMapping?.branch ??
                                    ''
                                ).trim() || undefined,
                                mappingSource: 'local',
                            };
                        } else if (!shouldEnforceTaxMapping && hasLocalMapping && normalizedFallbackRate > 0) {
                            const effectiveTaxRate = normalizedFallbackRate / 100;
                            if (fallbackMethod === 'exclusive') {
                                itemTax = lineAmount * effectiveTaxRate;
                                itemNet = lineAmount;
                                itemGross = lineAmount + itemTax;
                                taxCalculationBasis = 'net_exclusive';
                            } else {
                                itemTax = effectiveTaxRate > 0
                                    ? lineAmount * effectiveTaxRate / (1 + effectiveTaxRate)
                                    : 0;
                                itemGross = lineAmount;
                                itemNet = lineAmount - itemTax;
                                taxCalculationBasis = 'gross_inclusive';
                            }
                            totalTax += itemTax;
                            totalNet += itemNet;
                            totalGross += itemGross;
                            mappings[itemId] = {
                                rate: normalizedFallbackRate,
                                taxAmount: itemTax,
                                netAmount: itemNet,
                                grossAmount: itemGross,
                                lineAmount,
                                taxType: fallbackTaxType,
                                taxCalculationMethod: fallbackMethod,
                                taxCalculationBasis,
                                taxableAmount: itemNet,
                                mappingStatus,
                                mappingId: localMapping?.id ? String(localMapping.id) : undefined,
                                mappingBranchId: String(
                                    localMapping?.branchId ??
                                    localMapping?.branch_id ??
                                    localMapping?.branch ??
                                    ''
                                ).trim() || undefined,
                                mappingSource: 'local',
                            };
                        } else if (!shouldEnforceTaxMapping && defaultTaxRateDecimal > 0) {
                            itemTax = lineAmount * defaultTaxRateDecimal / (1 + defaultTaxRateDecimal);
                            itemGross = lineAmount;
                            itemNet = lineAmount - itemTax;
                            taxCalculationBasis = 'gross_inclusive';
                            totalTax += itemTax;
                            totalNet += itemNet;
                            totalGross += itemGross;
                            mappings[itemId] = {
                                rate: defaultTaxRateDecimal * 100,
                                taxAmount: itemTax,
                                netAmount: itemNet,
                                grossAmount: itemGross,
                                lineAmount,
                                taxType: 'standard',
                                taxCalculationMethod: 'inclusive',
                                taxCalculationBasis,
                                taxableAmount: itemNet,
                                mappingStatus,
                                mappingSource: 'default',
                            };
                        } else {
                            totalNet += lineAmount;
                            totalGross += lineAmount;
                            mappings[itemId] = {
                                rate: 0, 
                                taxAmount: 0,
                                netAmount: lineAmount,
                                grossAmount: lineAmount,
                                lineAmount,
                                taxType: 'unmapped',
                                taxCalculationMethod: 'unmapped',
                                taxCalculationBasis: 'unmapped',
                                taxableAmount: lineAmount,
                                mappingStatus,
                                mappingSource: 'none',
                            };
                        }
                    }
                }
                console.log('[PaymentDialog] FINAL CALCULATED TAX:', totalTax);
                console.log('[PaymentDialog] FINAL NET/GROSS:', { totalNet, totalGross });
                console.log('[PaymentDialog] Tax breakdown by product:', mappings);
                console.log('[PaymentDialog] Unmapped products:', unmapped);
                if (!cancelled) {
                    setCalculatedTax(totalTax);
                    setCalculatedNetAmount(totalNet);
                    setCalculatedGrossAmount(totalGross);
                    setCalculatedTaxLabel(effectiveTaxLabel);
                    setProductTaxMappings(mappings);
                    setUnmappedProducts(shouldEnforceTaxMapping ? unmapped : []);
                }
            } catch (error) {
                console.error('[PaymentDialog] Error calculating tax:', error);
                if (!cancelled) {
                    setCalculatedTax(tax);
                    setCalculatedNetAmount(subtotal);
                    setCalculatedGrossAmount(subtotal + tax);
                    setCalculatedTaxLabel(effectiveTaxLabel);
                    setProductTaxMappings({});
                    setUnmappedProducts([]);
                }
            }
        };

        calculateCorrectTax();

        return () => {
            cancelled = true;
        };
    }, [cart, subtotal, tax, taxLabel, eisEnabled, shouldEnforceTaxMapping, defaultTaxRateDecimal, branchId, normalizedActiveBranchId]);

    const appliedCharges = useMemo(() => (
        calculateAppliedCharges({
            charges: activeCharges,
            netSubtotal: calculatedNetAmount,
            grossTotal: calculatedGrossAmount,
        })
    ), [activeCharges, calculatedGrossAmount, calculatedNetAmount]);
    const exclusiveChargesTotal = useMemo(
        () => sumAppliedCharges(appliedCharges.filter((charge) => charge.calculationMethod === 'exclusive')),
        [appliedCharges]
    );
    const chargesTotal = useMemo(() => sumAppliedCharges(appliedCharges), [appliedCharges]);
    const total = calculatedGrossAmount + exclusiveChargesTotal;
    const hasBlockingUnmapped = shouldEnforceTaxMapping && unmappedProducts.length > 0;
    const businessSettings = useLiveQuery(async () => getOfflineBusinessProfile(), []);
    const allowNegativeIngredientStock =
        (businessSettings as any)?.allowNegativeIngredientStock === true ||
        (businessSettings as any)?.allow_negative_ingredient_stock === true;
    const change = typeof cashPaid === 'number' && cashPaid > 0 ? cashPaid - total : 0;
    const tipFromChange = selectedPaymentMethod === 'Cash' && recordChangeAsTip
        ? Math.max(0, change)
        : 0;
    const displayedChange = selectedPaymentMethod === 'Cash' && recordChangeAsTip
        ? 0
        : Math.max(0, change);
    const selectedCustomerCreditLimit = toFiniteNumber(selectedCustomer?.creditLimit, 0);
    const selectedCustomerCurrentBalance = toFiniteNumber(selectedCustomer?.currentBalance, 0);
    const selectedCustomerAvailableCredit = Math.max(0, selectedCustomerCreditLimit - selectedCustomerCurrentBalance);
    const onAccountCreditLimitExceeded =
        selectedPaymentMethod === 'On Account' &&
        !!selectedCustomer &&
        selectedCustomerCreditLimit > 0 &&
        selectedCustomerCurrentBalance + total > selectedCustomerCreditLimit;
    const normalizedLaybuyDeposit =
        typeof laybuyDeposit === 'number'
            ? laybuyDeposit
            : Number.parseFloat(String(laybuyDeposit ?? ''));
    const laybuyDepositInvalid =
        selectedPaymentMethod === 'Laybuy' &&
        (!Number.isFinite(normalizedLaybuyDeposit) || normalizedLaybuyDeposit <= 0 || normalizedLaybuyDeposit > total);
    const customerRequiredMissing =
        customerRequiredPayment &&
        !selectedCustomerId &&
        !buyerName.trim() &&
        !buyerPhone.trim();
    const receiptStyleTaxBreakdown = useMemo(() => {
        const breakdown = new Map<string, {
            rate: number;
            method: 'inclusive' | 'exclusive' | 'not_applicable';
            taxableValue: number;
            vatAmount: number;
            count: number;
        }>();

        for (const item of cart || []) {
            const mapping = productTaxMappings[String(item.id)];
            if (!mapping || mapping.taxCalculationMethod === 'unmapped') {
                continue;
            }

            const rate = Number.isFinite(mapping.rate) ? mapping.rate : 0;
            const method: 'inclusive' | 'exclusive' | 'not_applicable' =
                mapping.taxCalculationMethod === 'exclusive'
                    ? 'exclusive'
                    : mapping.taxCalculationMethod === 'inclusive'
                        ? 'inclusive'
                        : 'not_applicable';
            const key = `${rate}-${method}`;
            const taxableValue = Number.isFinite(mapping.taxableAmount)
                ? mapping.taxableAmount
                : mapping.netAmount;

            const existing = breakdown.get(key);
            if (existing) {
                existing.taxableValue += taxableValue;
                existing.vatAmount += mapping.taxAmount;
                existing.count += 1;
                continue;
            }

            breakdown.set(key, {
                rate,
                method,
                taxableValue,
                vatAmount: mapping.taxAmount,
                count: 1,
            });
        }

        return Array.from(breakdown.values()).sort((a, b) => b.rate - a.rate);
    }, [cart, productTaxMappings]);

    const taxMethodRateSummary = useMemo(() => {
        if (receiptStyleTaxBreakdown.length === 0) return '';
        return receiptStyleTaxBreakdown
            .map((tax) => {
                const methodShortLabel =
                    tax.method === 'exclusive'
                        ? 'EXC'
                        : tax.method === 'inclusive'
                            ? 'INC'
                            : 'N/A';
                const displayTaxRate = (Number.isFinite(tax.rate) ? tax.rate : 0).toFixed(2);
                const countLabel = tax.count > 1 ? ` (x${tax.count})` : '';
                return `${methodShortLabel} ${displayTaxRate}%${countLabel}`;
            })
            .join(' · ');
    }, [receiptStyleTaxBreakdown]);

    const handlePayment = async (method: PaymentMethod) => {
        if (isProcessingPayment) {
            return;
        }

        const methodRequiresCustomer = method === 'On Account' || method === 'Laybuy';
        if (method === 'Laybuy' && hideLaybuyPayment) {
            toast({
                variant: 'destructive',
                title: 'Laybuy unavailable',
                description: 'Laybuy is hidden for restaurant and bar sales.',
            });
            return;
        }

        if (methodRequiresCustomer && !selectedCustomerId && !buyerName.trim() && !buyerPhone.trim()) {
            setShowBuyerDetails(true);
            toast({
                variant: 'destructive',
                title: 'Customer required',
                description: method === 'Laybuy'
                    ? 'Select or enter a customer before creating a laybuy.'
                    : 'Add a customer name or phone number before selling on account.',
            });
            return;
        }

        if (method === 'On Account' && selectedCustomer) {
            const creditLimit = toFiniteNumber(selectedCustomer.creditLimit, 0);
            const currentBalance = toFiniteNumber(selectedCustomer.currentBalance, 0);
            const projectedBalance = currentBalance + total;

            if (selectedCustomer.accountEnabled === false) {
                toast({
                    variant: 'destructive',
                    title: 'Credit account disabled',
                    description: `${selectedCustomer.name || 'This customer'} is not enabled for on-account sales.`,
                });
                return;
            }

            if (creditLimit > 0 && projectedBalance > creditLimit) {
                const availableCredit = Math.max(0, creditLimit - currentBalance);
                toast({
                    variant: 'destructive',
                    title: 'Credit limit exceeded',
                    description: `Available credit is ${currencyFormatter(availableCredit)}. This sale is ${currencyFormatter(total)}.`,
                });
                return;
            }
        }

        if (method === 'Laybuy' && laybuyDepositInvalid) {
            toast({
                variant: 'destructive',
                title: 'Deposit required',
                description: 'Enter a laybuy deposit greater than zero and not above the cart total.',
            });
            return;
        }

        setIsProcessingPayment(true);
        try {
            const buyerDetails = normalizeBuyerDetails({
                customerId: selectedCustomerId,
                name: buyerName,
                phone: buyerPhone,
                tin: buyerTin,
                laybuyDeposit: method === 'Laybuy' ? normalizedLaybuyDeposit : undefined,
                laybuyPaymentMethod: method === 'Laybuy' ? laybuyPaymentMethod : undefined,
            });
            const checkoutTip = method === 'Cash' ? tipFromChange : 0;
            const order = await onCheckout(method, checkoutTip, buyerDetails);
            if (order) {
                const orderWithLocalReceiptNumber = withLocalReceiptNumber(order);
                const normalizedCashPaid =
                    typeof cashPaid === 'number'
                        ? cashPaid
                        : Number.parseFloat(String(cashPaid ?? ''));
                const hasCashPaid = Number.isFinite(normalizedCashPaid) && normalizedCashPaid > 0;
                const cashChange = hasCashPaid ? Math.max(0, normalizedCashPaid - total) : 0;
                const cashTip = method === 'Cash' && recordChangeAsTip ? cashChange : 0;
                const displayedCashChange = cashTip > 0 ? 0 : cashChange;

                const orderWithPaymentDetails: Order =
                    method === 'Cash' && hasCashPaid
                        ? ({
                              ...orderWithLocalReceiptNumber,
                              chargesAmount: chargesTotal,
                              charges_amount: chargesTotal,
                              chargesSnapshot: appliedCharges,
                              charges_snapshot: appliedCharges,
                              tip: cashTip,
                              cashPaid: normalizedCashPaid,
                              cash_paid: normalizedCashPaid,
                              amountTendered: normalizedCashPaid,
                              amount_tendered: normalizedCashPaid,
                              amountReceived: normalizedCashPaid,
                              amount_received: normalizedCashPaid,
                              change: displayedCashChange,
                              changeAmount: displayedCashChange,
                              change_amount: displayedCashChange,
                          } as Order)
                        : ({
                              ...orderWithLocalReceiptNumber,
                              chargesAmount: chargesTotal,
                              charges_amount: chargesTotal,
                              chargesSnapshot: appliedCharges,
                              charges_snapshot: appliedCharges,
                          } as Order);

                if ((method === 'Cash' && hasCashPaid) || chargesTotal > 0) {
                    try {
                        const paymentUpdate: Record<string, unknown> = {
                            chargesAmount: chargesTotal,
                            charges_amount: chargesTotal,
                            chargesSnapshot: appliedCharges,
                            charges_snapshot: appliedCharges,
                        };

                        if (method === 'Cash' && hasCashPaid) {
                            Object.assign(paymentUpdate, {
                                tip: cashTip,
                                cashPaid: normalizedCashPaid,
                                cash_paid: normalizedCashPaid,
                                amountTendered: normalizedCashPaid,
                                amount_tendered: normalizedCashPaid,
                                amountReceived: normalizedCashPaid,
                                amount_received: normalizedCashPaid,
                                change: displayedCashChange,
                                changeAmount: displayedCashChange,
                                change_amount: displayedCashChange,
                            });
                        }

                        await db.orders.update(order.id, paymentUpdate as any);
                    } catch (paymentMetaError) {
                        console.warn('[PaymentDialog] Failed to persist cash payment metadata on order:', paymentMetaError);
                    }
                }

                setCompletedOrder(orderWithPaymentDetails);
                setStep('confirmation');
            }
        } finally {
            setIsProcessingPayment(false);
        }
    }
    
    const [isPrinting, setIsPrinting] = useState(false);
    const [autoPrintHandled, setAutoPrintHandled] = useState(false);
    const [isAutoPrintRunning, setIsAutoPrintRunning] = useState(false);
    const [hasDefaultPrinter, setHasDefaultPrinter] = useState<boolean | null>(null);
    const [receiptPaperWidth, setReceiptPaperWidth] = useState<'80mm' | '58mm'>('80mm');
    const [receiptDisplaySettings, setReceiptDisplaySettings] = useState<ReceiptDisplaySettings>(DEFAULT_RECEIPT_DISPLAY_SETTINGS);
    const [receiptCopyNumber, setReceiptCopyNumber] = useState(1);
    const [isReceiptPreviewOpen, setIsReceiptPreviewOpen] = useState(false);
    const isPrintBusy = isPrinting || isAutoPrintRunning;
    const autoPrintOrderRef = useRef<string | null>(null);
    const printJobLockRef = useRef(false);
    const onCloseRef = useRef(onClose);
    const isInlineDisplay = displayMode === 'inline';

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        onStepChange?.(step);
    }, [onStepChange, step]);

    useEffect(() => {
        setHasDefaultPrinter(null);
        autoPrintOrderRef.current = null;
        setReceiptPaperWidth('80mm');
        setReceiptDisplaySettings(DEFAULT_RECEIPT_DISPLAY_SETTINGS);
        setReceiptCopyNumber(1);
        setIsReceiptPreviewOpen(false);
    }, [resetToken]);

    const applyPrinterSettingsToReceipt = useCallback(
        (
            settings?: Partial<PrinterSettings> | null,
            fallbackPaperWidth: '80mm' | '58mm' = '80mm'
        ): '80mm' | '58mm' => {
            const resolvedPaperWidth: '80mm' | '58mm' =
                settings?.receiptPaperWidth === '58mm' || settings?.receiptPaperWidth === '80mm'
                    ? settings.receiptPaperWidth
                    : fallbackPaperWidth;

            setReceiptPaperWidth(resolvedPaperWidth);
            setReceiptDisplaySettings({
                showHeader: settings?.printHeader ?? true,
                showFooter: settings?.printFooter ?? true,
                showQRCode: settings?.printQRCode ?? true,
                showItemDetails: settings?.printItemDetails ?? true,
                showTaxBreakdown: settings?.printTaxBreakdown ?? true,
                receiptFontSize: normalizeReceiptFontSize(
                    settings?.receiptFontSize,
                    resolvedPaperWidth
                ),
                receiptFontWeight: normalizeReceiptFontWeight(settings?.receiptFontWeight),
                receiptLineHeight: normalizeReceiptLineHeight(settings?.receiptLineHeight),
                receiptPaddingX: normalizeReceiptPaddingX(
                    settings?.receiptPaddingX,
                    resolvedPaperWidth
                ),
                receiptBusinessNameFontSize: normalizeReceiptBusinessNameFontSize(
                    settings?.receiptBusinessNameFontSize,
                    resolvedPaperWidth
                ),
                receiptBusinessNameFontWeight: normalizeReceiptFontWeight(
                    settings?.receiptBusinessNameFontWeight ?? DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT
                ),
                receiptBusinessNameScaleX: normalizeReceiptTextScaleX(
                    settings?.receiptBusinessNameScaleX,
                    DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
                ),
                receiptHeaderDetailScaleX: normalizeReceiptTextScaleX(
                    settings?.receiptHeaderDetailScaleX,
                    DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
                ),
                receiptLegalMarkerFontSize: normalizeReceiptLegalMarkerFontSize(
                    settings?.receiptLegalMarkerFontSize,
                    resolvedPaperWidth
                ),
                receiptLegalMarkerFontWeight: normalizeReceiptFontWeight(
                    settings?.receiptLegalMarkerFontWeight ?? DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT
                ),
                receiptLegalMarkerScaleX: normalizeReceiptTextScaleX(
                    settings?.receiptLegalMarkerScaleX,
                    DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X
                ),
                receiptQrCodeSize: normalizeReceiptQRCodeSize(
                    settings?.receiptQrCodeSize,
                    resolvedPaperWidth
                ),
            });

            return resolvedPaperWidth;
        },
        []
    );

    const refreshPrinterState = useCallback(async () => {
        const { printerService } = await import('@/lib/services/printer-service');
        const [defaultPrinter, currentSettings] = await Promise.all([
            printerService.getDefaultPrinter(activeBranchId),
            printerService.getPrinterSettings(activeBranchId),
        ]);

        setHasDefaultPrinter(!!defaultPrinter);
        applyPrinterSettingsToReceipt(
            currentSettings,
            (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
        );
    }, [activeBranchId, applyPrinterSettingsToReceipt]);

    const waitForFiscalInvoiceNumber = useCallback(
        async (orderToPrint: Order, timeoutMs: number = 15000): Promise<Order> => {
            if (!orderToPrint?.id) {
                return orderToPrint;
            }

            if (hasCompleteFiscalInvoiceNumber(extractFiscalInvoiceNumber(orderToPrint))) {
                return orderToPrint;
            }

            const startedAt = Date.now();
            let latestKnownOrder: Order = orderToPrint;

            while (Date.now() - startedAt < timeoutMs) {
                const latestOrder = await db.orders.get(orderToPrint.id);
                if (latestOrder) {
                    latestKnownOrder = latestOrder as Order;
                    if (hasCompleteFiscalInvoiceNumber(extractFiscalInvoiceNumber(latestKnownOrder))) {
                        return latestKnownOrder;
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            return latestKnownOrder;
        },
        []
    );

    const handlePrintReceipt = useCallback(
        async (
            options: {
                suppressMissingPrinterToast?: boolean;
            } = {}
        ): Promise<boolean> => {
        if (printJobLockRef.current) {
            console.log('[Print] Print job already running, skipping duplicate trigger');
            return false;
        }

        printJobLockRef.current = true;
        try {
            setIsPrinting(true);
            const { printerService } = await import('@/lib/services/printer-service');
            const { silentPrintService } = await import('@/lib/services/silent-print-service');

            const activeOrder = completedOrder as Order | null;
            if (!activeOrder) {
                toast({
                    variant: 'destructive',
                    title: 'Print Failed',
                    description: 'No completed order found to print.',
                });
                return false;
            }
            const activeOrderId = String((activeOrder as any)?.id ?? '').trim();

            if (eisEnabled) {
                const currentFiscal = extractFiscalInvoiceNumber(activeOrder);
                if (!hasCompleteFiscalInvoiceNumber(currentFiscal)) {
                    toast({
                        title: 'Preparing Fiscal Receipt',
                        description: 'Waiting for fiscal invoice number assignment...',
                    });

                    const latestOrder = await waitForFiscalInvoiceNumber(activeOrder);
                    const resolvedFiscal = extractFiscalInvoiceNumber(latestOrder);

                    if (!hasCompleteFiscalInvoiceNumber(resolvedFiscal)) {
                        toast({
                            variant: 'destructive',
                            title: 'Fiscal Number Pending',
                            description: 'Invoice number is not assigned yet. Please try printing again in a moment.',
                        });
                        return false;
                    }

                    setCompletedOrder(latestOrder);
                    // Give React a moment to render updated receipt data before capturing HTML.
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }
            }

            const [settings, defaultPrinter] = await Promise.all([
                printerService.getPrinterSettings(activeBranchId),
                printerService.getDefaultPrinter(activeBranchId),
            ]);
            const selectedPaperWidth = applyPrinterSettingsToReceipt(
                settings,
                (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
            );
            
            if (!defaultPrinter) {
                console.error('No default printer configured');
                if (!options.suppressMissingPrinterToast) {
                    toast({
                        variant: 'destructive',
                        title: 'No Printer Configured',
                        description: 'Configure a printer from the POS printer button or in Settings → Printers.',
                    });
                }
                return false;
            }

            const configuredCopies = Number.isFinite(Number(settings.printCopies))
                ? Number(settings.printCopies)
                : 1;
            const copiesToPrint = Math.max(1, Math.floor(configuredCopies));
            const startingCopyNumber = getNextReceiptCopyNumber(activeOrderId);
            const isBluetoothPrinter =
                defaultPrinter.connectionType === 'bluetooth' ||
                String(defaultPrinter.id || '').toLowerCase().startsWith('bt:');
            const printAttemptTimeoutMs = isBluetoothPrinter ? 45000 : 20000;

            toast({
                title: 'Printing...',
                description: `Sending ${copiesToPrint} receipt${copiesToPrint > 1 ? 's' : ''} to ${defaultPrinter.name}`,
            });

            // Try silent printing first (works with Tauri/Electron or auto-submit)
            const availableMethods = silentPrintService.getAvailableMethods();
            console.log('[Print] Available print methods:', availableMethods);

            let printedCopies = 0;
            let failedResult: { timedOut: boolean } | null = null;

            for (let copyIndex = 0; copyIndex < copiesToPrint; copyIndex += 1) {
                const currentCopyNumber = startingCopyNumber + copyIndex;
                setReceiptCopyNumber(currentCopyNumber);

                // Wait for receipt component to re-render with updated ORIGINAL/COPY marker.
                await new Promise((resolve) => setTimeout(resolve, 100));

                const receiptElement = document.getElementById('receipt-printable-area');
                const printContents = receiptElement?.innerHTML;

                if (!printContents || printContents.trim().length === 0) {
                    console.error('Receipt content not found or empty');
                    failedResult = { timedOut: false };
                    break;
                }

                const printOptions = {
                    printerName: defaultPrinter.name,
                    printerId: defaultPrinter.id,
                    copies: 1,
                    paperSize: selectedPaperWidth,
                    printerPaperSize: defaultPrinter.paperWidth as '80mm' | '58mm',
                };

                // Never keep the UI busy forever if native printing hangs.
                const printAttempt = Promise.race([
                    silentPrintService
                        .printSilentlyViaSystem(printContents, printOptions)
                        .then((success) => ({ success, timedOut: false })),
                    new Promise<{ success: false; timedOut: true }>((resolve) =>
                        setTimeout(() => resolve({ success: false, timedOut: true }), printAttemptTimeoutMs)
                    ),
                ]);

                const result = await printAttempt;
                if (!result.success) {
                    failedResult = { timedOut: result.timedOut };
                    break;
                }

                printedCopies += 1;
            }

            if (printedCopies > 0) {
                markReceiptPrinted(activeOrderId, printedCopies);
            }

            const isCompleteSuccess = printedCopies === copiesToPrint && failedResult === null;
            if (isCompleteSuccess) {
                const printedTypeLabel = startingCopyNumber > 1 ? 'Receipt copy printed' : 'Original receipt printed';
                toast({
                    title: 'Print Successful',
                    description: copiesToPrint > 1
                        ? `${printedCopies} receipts sent to ${defaultPrinter.name}`
                        : `${printedTypeLabel} to ${defaultPrinter.name}`,
                });
                return true;
            }

            console.warn('Print failed');
            const failedDescription = failedResult?.timedOut
                ? 'Printer did not respond in time. Check printer connection and try again.'
                : 'Failed to send receipt to printer. Please try again.';
            toast({
                variant: 'destructive',
                title: failedResult?.timedOut ? 'Print Timed Out' : 'Print Failed',
                description: printedCopies > 0
                    ? `${printedCopies} receipt${printedCopies > 1 ? 's were' : ' was'} printed, then printing stopped. ${failedDescription}`
                    : failedDescription,
            });
            return false;
        } catch (error) {
            console.error('Error printing receipt:', error);
            toast({
                variant: 'destructive',
                title: 'Print Error',
                description: error instanceof Error ? error.message : 'An unknown error occurred',
            });
            return false;
        } finally {
            setIsPrinting(false);
            printJobLockRef.current = false;
        }
        },
        [activeBranchId, toast, applyPrinterSettingsToReceipt, completedOrder, eisEnabled, waitForFiscalInvoiceNumber]
    );

    useEffect(() => {
        if (step !== 'confirmation' || !completedOrder || autoPrintHandled) {
            return;
        }

        const orderId = String((completedOrder as any)?.id || '');
        if (!orderId) {
            return;
        }

        // Guard against effect re-runs (StrictMode + parent re-renders): auto-print once per order.
        if (autoPrintOrderRef.current === orderId) {
            return;
        }
        autoPrintOrderRef.current = orderId;

        let cancelled = false;

        const maybeAutoPrint = async () => {
            try {
                setIsAutoPrintRunning(true);
                const { printerService } = await import('@/lib/services/printer-service');
                const [settings, defaultPrinter] = await Promise.all([
                    printerService.getPrinterSettings(activeBranchId),
                    printerService.getDefaultPrinter(activeBranchId),
                ]);

                if (cancelled) {
                    return;
                }
                setHasDefaultPrinter(Boolean(defaultPrinter));
                applyPrinterSettingsToReceipt(
                    settings,
                    (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
                );

                if (settings.autoprint) {
                    if (!defaultPrinter) {
                        return;
                    }

                    const success = await handlePrintReceipt({ suppressMissingPrinterToast: true });
                    if (success && !cancelled) {
                        onCloseRef.current();
                    }
                }
            } catch (error) {
                console.error('[Print] Failed to evaluate auto-print settings:', error);
            } finally {
                // Always clear busy state, even if this run was cancelled by a re-render.
                setIsAutoPrintRunning(false);
                if (!cancelled) {
                    setAutoPrintHandled(true);
                }
            }
        };

        maybeAutoPrint();

        return () => {
            cancelled = true;
        };
    }, [step, completedOrder, autoPrintHandled, handlePrintReceipt, applyPrinterSettingsToReceipt, activeBranchId]);

    useEffect(() => {
        if (step === 'payment') {
            setAutoPrintHandled(false);
            setIsAutoPrintRunning(false);
            autoPrintOrderRef.current = null;
        }
    }, [step]);

    useEffect(() => {
        if (step !== 'confirmation' || !completedOrder) {
            return;
        }

        let cancelled = false;

        const checkDefaultPrinter = async () => {
            try {
                await refreshPrinterState();
            } catch (error) {
                console.warn('[Print] Failed to check default printer:', error);
                if (!cancelled) {
                    setHasDefaultPrinter(null);
                }
            }
        };

        checkDefaultPrinter();

        return () => {
            cancelled = true;
        };
    }, [step, completedOrder, refreshPrinterState, activeBranchId]);

    useEffect(() => {
        if (step !== 'confirmation' || !completedOrder) {
            return;
        }

        const handlePrinterUpdate = (event: Event) => {
            const customEvent = event as CustomEvent<{ branchId?: string }>;
            const updatedBranchId = String(customEvent.detail?.branchId || '').trim();
            if (updatedBranchId && updatedBranchId !== activeBranchId) {
                return;
            }

            void refreshPrinterState().catch((error) => {
                console.warn('[Print] Failed to refresh printer state after settings update:', error);
            });
        };

        window.addEventListener(PRINTER_CONFIG_UPDATED_EVENT, handlePrinterUpdate);
        return () => window.removeEventListener(PRINTER_CONFIG_UPDATED_EVENT, handlePrinterUpdate);
    }, [step, completedOrder, refreshPrinterState, activeBranchId]);
    
    if (step === 'confirmation' && completedOrder) {
        const displayOrderNumber = (completedOrder as any).orderNumber ?? (completedOrder as any).order_number ?? '-';

        // Ensure completedOrder has all tax data from cart items
        const sourceItems = Array.isArray((completedOrder as any).items) ? (completedOrder as any).items : [];
        const enrichedOrder = {
            ...completedOrder,
            orderNumber: (completedOrder as any).orderNumber ?? (completedOrder as any).order_number,
            createdAt: (completedOrder as any).createdAt ?? (completedOrder as any).created_at,
            sessionId: (completedOrder as any).sessionId ?? (completedOrder as any).session_id ?? (completedOrder as any).session,
            paymentMethod: (completedOrder as any).paymentMethod ?? (completedOrder as any).payment_method,
            subtotal: (completedOrder as any).subtotal ?? (completedOrder as any).net_amount ?? 0,
            total: (completedOrder as any).total ?? (completedOrder as any).gross_amount ?? 0,
            fiscalInvoiceNumber: (completedOrder as any).fiscalInvoiceNumber ?? (completedOrder as any).fiscal_invoice_number,
            eisStatus: (completedOrder as any).eisStatus ?? (completedOrder as any).eis_status,
            eisUuid: (completedOrder as any).eisUuid ?? (completedOrder as any).eis_uuid,
            eisSubmittedAt: (completedOrder as any).eisSubmittedAt ?? (completedOrder as any).eis_submitted_at,
            qrCodePayload: (completedOrder as any).qrCodePayload ?? (completedOrder as any).qr_code_payload,
            digitalSignature: (completedOrder as any).digitalSignature ?? (completedOrder as any).digital_signature,
            items: sourceItems.map((item: any) => ({
                ...item,
                // Ensure all tax fields are present
                tax_rate: item.tax_rate || item.taxRate || 0,
                tax_type: item.tax_type || item.taxType || 'standard',
                tax_calculation_method: item.tax_calculation_method || item.taxCalculationMethod || 'inclusive',
                subtotal: item.subtotal || 0,
                tax_amount: item.tax_amount || item.taxAmount || 0,
                total: item.total || 0,
            })) || []
        };
        const successActionButtonClass = "w-full justify-center sm:w-auto sm:min-w-[136px]";
        const successPrimaryButtonClass = cn(successActionButtonClass, "bg-blue-600 hover:bg-blue-700");

        const confirmationContent = (
            <>
                {!isInlineDisplay && (
                    <DialogHeader>
                        <DialogTitle className="flex items-center justify-center text-center">
                            <CheckCircle className="h-12 w-12 text-green-500" />
                        </DialogTitle>
                    </DialogHeader>
                )}
                <div className={cn("text-center", isInlineDisplay ? "space-y-3 py-1" : "py-4")}>
                    {isInlineDisplay && (
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-950/40 dark:text-green-400">
                            <CheckCircle className="h-7 w-7" />
                        </div>
                    )}
                    <div className="space-y-1">
                        <h2 className="text-xl font-semibold">Payment Successful</h2>
                        <p className="text-muted-foreground">Order #{displayOrderNumber} has been created.</p>
                    </div>
                    {hasDefaultPrinter === false && (
                        <p className="text-sm text-amber-700">
                            No default printer configured. Configure one to print receipts.
                        </p>
                    )}
                </div>
                <div className="hidden">
                    <Receipt
                        order={enrichedOrder}
                        business={businessSettings}
                        currencyFormatter={currencyFormatter}
                        paperWidth={receiptPaperWidth}
                        showHeader={receiptDisplaySettings.showHeader}
                        showFooter={receiptDisplaySettings.showFooter}
                        showQRCode={receiptDisplaySettings.showQRCode}
                        showItemDetails={receiptDisplaySettings.showItemDetails}
                        showTaxBreakdown={receiptDisplaySettings.showTaxBreakdown}
                        receiptFontSize={receiptDisplaySettings.receiptFontSize}
                        receiptFontWeight={receiptDisplaySettings.receiptFontWeight}
                        receiptLineHeight={receiptDisplaySettings.receiptLineHeight}
                        receiptPaddingX={receiptDisplaySettings.receiptPaddingX}
                        receiptBusinessNameFontSize={receiptDisplaySettings.receiptBusinessNameFontSize}
                        receiptBusinessNameFontWeight={receiptDisplaySettings.receiptBusinessNameFontWeight}
                        receiptBusinessNameScaleX={receiptDisplaySettings.receiptBusinessNameScaleX}
                        receiptHeaderDetailScaleX={receiptDisplaySettings.receiptHeaderDetailScaleX}
                        receiptLegalMarkerFontSize={receiptDisplaySettings.receiptLegalMarkerFontSize}
                        receiptLegalMarkerFontWeight={receiptDisplaySettings.receiptLegalMarkerFontWeight}
                        receiptLegalMarkerScaleX={receiptDisplaySettings.receiptLegalMarkerScaleX}
                        receiptQrCodeSize={receiptDisplaySettings.receiptQrCodeSize}
                        copyNumber={receiptCopyNumber}
                    />
                </div>
                <Dialog open={isReceiptPreviewOpen} onOpenChange={setIsReceiptPreviewOpen}>
                    <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-md gap-0 overflow-hidden p-0">
                        <DialogHeader className="border-b px-4 py-3 pr-10">
                            <DialogTitle>Receipt</DialogTitle>
                        </DialogHeader>
                        <div className="max-h-[calc(92dvh-4rem)] overflow-y-auto bg-muted/40 px-3 py-4">
                            <Receipt
                                order={enrichedOrder}
                                business={businessSettings}
                                currencyFormatter={currencyFormatter}
                                paperWidth={receiptPaperWidth}
                                showHeader={receiptDisplaySettings.showHeader}
                                showFooter={receiptDisplaySettings.showFooter}
                                showQRCode={receiptDisplaySettings.showQRCode}
                                showItemDetails={receiptDisplaySettings.showItemDetails}
                                showTaxBreakdown={receiptDisplaySettings.showTaxBreakdown}
                                receiptFontSize={receiptDisplaySettings.receiptFontSize}
                                receiptFontWeight={receiptDisplaySettings.receiptFontWeight}
                                receiptLineHeight={receiptDisplaySettings.receiptLineHeight}
                                receiptPaddingX={receiptDisplaySettings.receiptPaddingX}
                                receiptBusinessNameFontSize={receiptDisplaySettings.receiptBusinessNameFontSize}
                                receiptBusinessNameFontWeight={receiptDisplaySettings.receiptBusinessNameFontWeight}
                                receiptBusinessNameScaleX={receiptDisplaySettings.receiptBusinessNameScaleX}
                                receiptHeaderDetailScaleX={receiptDisplaySettings.receiptHeaderDetailScaleX}
                                receiptLegalMarkerFontSize={receiptDisplaySettings.receiptLegalMarkerFontSize}
                                receiptLegalMarkerFontWeight={receiptDisplaySettings.receiptLegalMarkerFontWeight}
                                receiptLegalMarkerScaleX={receiptDisplaySettings.receiptLegalMarkerScaleX}
                                receiptQrCodeSize={receiptDisplaySettings.receiptQrCodeSize}
                                copyNumber={1}
                                rootId="receipt-preview-area"
                            />
                        </div>
                    </DialogContent>
                </Dialog>
                {isInlineDisplay ? (
                    <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:justify-center">
                        <Button variant="outline" onClick={onClose} disabled={isPrintBusy} className={successActionButtonClass}>New Order</Button>
                        <Button variant="secondary" onClick={() => setIsReceiptPreviewOpen(true)} disabled={isPrintBusy} className={successActionButtonClass}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Receipt
                        </Button>
                        {hasDefaultPrinter === false && (
                            <Button variant="secondary" onClick={onConfigurePrinter} disabled={isPrintBusy} className={successActionButtonClass}>
                                <Printer className="mr-2 h-4 w-4" />
                                Configure Printer
                            </Button>
                        )}
                        <Button onClick={() => void handlePrintReceipt()} disabled={isPrintBusy || hasDefaultPrinter === false} className={successPrimaryButtonClass}>
                            {isPrintBusy ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Printing...
                                </>
                            ) : (
                                <>
                                    <DollarSign className="mr-2 h-4 w-4" />
                                    Print Receipt
                                </>
                            )}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:justify-center">
                        <Button variant="outline" onClick={onClose} disabled={isPrintBusy} className={successActionButtonClass}>New Order</Button>
                        <Button variant="secondary" onClick={() => setIsReceiptPreviewOpen(true)} disabled={isPrintBusy} className={successActionButtonClass}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Receipt
                        </Button>
                        {hasDefaultPrinter === false && (
                            <Button variant="secondary" onClick={onConfigurePrinter} disabled={isPrintBusy} className={successActionButtonClass}>
                                <Printer className="mr-2 h-4 w-4" />
                                Configure Printer
                            </Button>
                        )}
                        <Button onClick={() => void handlePrintReceipt()} disabled={isPrintBusy || hasDefaultPrinter === false} className={successPrimaryButtonClass}>
                            {isPrintBusy ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Printing...
                                </>
                            ) : (
                                <>
                                    <DollarSign className="mr-2 h-4 w-4" />
                                    Print Receipt
                                </>
                            )}
                        </Button>
                    </div>
                )}
            </>
        );

        if (isInlineDisplay) {
            return <div className="space-y-4 rounded-lg border bg-background p-4">{confirmationContent}</div>;
        }

        return <DialogContent className="w-[calc(100vw-1rem)] max-w-xl p-4 sm:p-6">{confirmationContent}</DialogContent>;
    }

    const paymentContent = (
        <>
            {isInlineDisplay ? (
                <div className="space-y-1">
                    <h3 className="text-lg font-semibold">Complete Payment</h3>
                    <p className="text-sm text-muted-foreground">Select the payment method</p>
                </div>
            ) : (
                <DialogHeader>
                    <DialogTitle className="text-xl">Complete Payment</DialogTitle>
                    <DialogDescription>Select the payment method</DialogDescription>
                </DialogHeader>
            )}
            <div className={cn(
                "space-y-4 overflow-y-auto hide-scrollbar",
                isInlineDisplay ? "max-h-[24rem] pr-1" : "flex-1 py-3"
            )}>
                <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
                    <div className="flex justify-between text-xs"><span>Net Amount (Before VAT)</span><span>{currencyFormatter(calculatedNetAmount)}</span></div>
                    <div className="flex justify-between text-xs"><span>{calculatedTaxLabel || 'VAT Amount'}</span><span className="text-green-600 font-semibold">{currencyFormatter(calculatedTax)}</span></div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>Tax Method</span>
                        <span>{taxMethodSummary}</span>
                    </div>
                    {taxMethodRateSummary && (
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>Methods & Rates</span>
                            <span className="text-right">{taxMethodRateSummary}</span>
                        </div>
                    )}
                    <div className="flex justify-between text-sm font-semibold"><span>Gross Amount (Including VAT)</span><span>{currencyFormatter(calculatedGrossAmount)}</span></div>
                    {chargesTotal > 0 && (
                        <div className="flex justify-between text-xs">
                            <span>Charges & Levies{exclusiveChargesTotal <= 0 ? ' (included)' : ''}</span>
                            <span>{currencyFormatter(exclusiveChargesTotal > 0 ? exclusiveChargesTotal : chargesTotal)}</span>
                        </div>
                    )}
                    <Separator className="my-1" />
                    <div className="flex justify-between text-lg font-bold text-primary"><span>Total Amount Due</span><span>{currencyFormatter(total)}</span></div>
                </div>

                {Object.keys(productTaxMappings).length > 0 && cart && cart.length > 0 && (
                    <div className="rounded-lg border bg-amber-50 dark:bg-amber-950/20 p-3">
                        <h4 className="text-sm font-semibold mb-2 text-amber-900 dark:text-amber-100">MRA Tax Details</h4>
                        <div className="space-y-2 text-xs">
                            {cart?.map((item) => {
                                const mapping = productTaxMappings[String(item.id)];
                                if (!mapping) return null;
                                const taxRate = Number.isFinite(mapping.rate) ? mapping.rate : 0;
                                const statusLabel = formatMappingStatusLabel(mapping.mappingStatus);
                                const taxTypeLabel = formatTaxTypeLabel(mapping.taxType);
                                const taxMethodLabel = formatTaxMethodLabel(mapping.taxCalculationMethod);
                                const taxBasisLabel = formatTaxBasisLabel(mapping.taxCalculationBasis);
                                const rateLabel =
                                    mapping.mappingStatus === 'ready'
                                        ? (mapping.taxType === 'standard' ? `${taxRate.toFixed(2)}%` : '0%')
                                        : 'N/A';
                                const amountLabel = mapping.mappingStatus === 'ready'
                                    ? currencyFormatter(mapping.taxAmount)
                                    : 'Blocked';
                                return (
                                    <div key={item.id} className="rounded border border-amber-200/80 bg-white/70 p-2 dark:bg-transparent dark:border-amber-900/50">
                                        <div className="flex justify-between items-center gap-2">
                                            <span className="font-medium text-amber-900 dark:text-amber-100">
                                                {item.name}
                                            </span>
                                            <span
                                                className={cn(
                                                    "font-semibold",
                                                    mapping.mappingStatus === 'ready'
                                                        ? "text-amber-900 dark:text-amber-100"
                                                        : "text-red-700 dark:text-red-300"
                                                )}
                                            >
                                                {amountLabel}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-amber-800 dark:text-amber-200">
                                            <span>Type: {taxTypeLabel}</span>
                                            <span>Method: {taxMethodLabel}</span>
                                            <span>Basis: {taxBasisLabel}</span>
                                            <span>Rate: {rateLabel}</span>
                                            <span>Status: {statusLabel}</span>
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-amber-900 dark:text-amber-100">
                                            <span>Net: {currencyFormatter(mapping.netAmount)}</span>
                                            <span>Tax: {currencyFormatter(mapping.taxAmount)}</span>
                                            <span>Gross: {currencyFormatter(mapping.grossAmount)}</span>
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                            <span>Mapping: {mapping.mappingId || 'none'}</span>
                                            <span>Branch: {mapping.mappingBranchId || 'any'}</span>
                                            <span>Source: {mapping.mappingSource || 'unknown'}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {receiptStyleTaxBreakdown.length > 0 && (
                            <div className="mt-3 border-t border-amber-200/70 pt-2 space-y-1 text-xs">
                                <p className="font-semibold text-amber-900 dark:text-amber-100">Tax Summary</p>
                                {receiptStyleTaxBreakdown.map((tax, index) => {
                                    const methodShortLabel =
                                        tax.method === 'exclusive'
                                            ? 'EXC'
                                            : tax.method === 'inclusive'
                                                ? 'INC'
                                                : 'N/A';
                                    const displayTaxRate = (Number.isFinite(tax.rate) ? tax.rate : 0).toFixed(2);

                                    return (
                                        <div key={`${displayTaxRate}-${tax.method}-${index}`} className="space-y-0.5 text-amber-900 dark:text-amber-100">
                                            <div className="flex items-center justify-between gap-3">
                                                <span>VAT {displayTaxRate}% ({methodShortLabel})</span>
                                                <span className="font-semibold">{currencyFormatter(tax.vatAmount)}</span>
                                            </div>
                                            <div className="flex items-center justify-between gap-3 text-[11px] text-amber-800 dark:text-amber-200 pl-2">
                                                <span>Taxable:</span>
                                                <span>{currencyFormatter(tax.taxableValue)}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                            <Label htmlFor="toggle-buyer-details" className="text-sm font-medium">
                                {selectedPaymentMethod === 'Laybuy'
                                    ? 'Laybuy Customer Details'
                                    : selectedPaymentMethod === 'On Account'
                                        ? 'Customer Account Details'
                                        : 'Buyer Details'}
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                {selectedPaymentMethod === 'Laybuy'
                                    ? 'Required so deposits and installments stay attached to the right customer.'
                                    : selectedPaymentMethod === 'On Account'
                                    ? 'Required for credit sales so the balance is attached to the right customer.'
                                    : 'Turn this on only if you want to add customer information to the sale.'}
                            </p>
                        </div>
                        <Switch
                            id="toggle-buyer-details"
                            checked={isCustomerDetailsOpen}
                            onCheckedChange={setShowBuyerDetails}
                            disabled={isProcessingPayment || customerRequiredPayment}
                        />
                    </div>
                    {isCustomerDetailsOpen && (
                        <>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Saved Customer</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                    value={selectedCustomerId}
                                    onChange={(event) => handleCustomerSelect(event.target.value)}
                                    disabled={isProcessingPayment}
                                >
                                    <option value="">
                                        {customerRequiredPayment
                                            ? 'Select customer or enter details'
                                            : 'Walk-in / new customer'}
                                    </option>
                                    {customerOptions.map((customer) => {
                                        const balance = toFiniteNumber(customer.currentBalance, 0);
                                        const disabledForCredit =
                                            selectedPaymentMethod === 'On Account' && customer.accountEnabled === false;
                                        const contact = customer.phone || customer.email;
                                        const balanceLabel = balance > 0
                                            ? ` - owes ${currencyFormatter(balance)}`
                                            : '';

                                        return (
                                            <option
                                                key={customer.id}
                                                value={String(customer.id)}
                                                disabled={disabledForCredit}
                                            >
                                                {customer.name}
                                                {contact ? ` (${contact})` : ''}
                                                {balanceLabel}
                                                {disabledForCredit ? ' - credit off' : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                                <p className="text-[11px] text-muted-foreground">
                                    {isLoadingCustomers
                                        ? 'Refreshing saved customers...'
                                        : selectedPaymentMethod === 'Laybuy'
                                            ? 'Laybuy sales need a saved customer or enough details to create one.'
                                            : selectedPaymentMethod === 'On Account'
                                            ? 'Credit sales need a saved account or enough customer details to create one.'
                                            : 'Select a customer to attach this sale to their history and loyalty.'}
                                </p>
                                {onAccountCreditLimitExceeded && (
                                    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                                        {selectedCustomer?.name || 'This customer'} only has {currencyFormatter(selectedCustomerAvailableCredit)} available credit.
                                        This sale is {currencyFormatter(total)}.
                                    </div>
                                )}
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-muted-foreground">Customer Name</label>
                                    <Input
                                        placeholder="Enter customer name"
                                        value={buyerName}
                                        onChange={(e) => setBuyerName(e.target.value)}
                                        disabled={isProcessingPayment}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-muted-foreground">Phone</label>
                                    <Input
                                        placeholder="Enter phone number"
                                        value={buyerPhone}
                                        onChange={(e) => setBuyerPhone(e.target.value)}
                                        disabled={isProcessingPayment}
                                        inputMode="tel"
                                    />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Buyer TIN</label>
                                <Input
                                    placeholder="Enter buyer TIN"
                                    value={buyerTin}
                                    onChange={(e) => setBuyerTin(e.target.value)}
                                    disabled={isProcessingPayment}
                                />
                            </div>
                        </>
                    )}
                </div>

                <div>
                    <h4 className="text-sm font-medium mb-2">Payment Method</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                       <Button size="default" variant={selectedPaymentMethod === 'Cash' ? 'default' : 'outline'} onClick={() => setSelectedPaymentMethod('Cash')} className="text-sm h-11" disabled={isProcessingPayment}><Wallet className="mr-1 h-4 w-4"/>Cash</Button>
                       <Button size="default" variant={selectedPaymentMethod === 'Card' ? 'default' : 'outline'} onClick={() => setSelectedPaymentMethod('Card')} className="text-sm h-11" disabled={isProcessingPayment}><CreditCard className="mr-1 h-4 w-4"/>Card</Button>
                       <Button size="default" variant={selectedPaymentMethod === 'Mobile Money' ? 'default' : 'outline'} onClick={() => setSelectedPaymentMethod('Mobile Money')} className="text-sm h-11" disabled={isProcessingPayment}><Smartphone className="mr-1 h-4 w-4"/>Mobile</Button>
                       <Button
                         size="default"
                         variant={selectedPaymentMethod === 'On Account' ? 'default' : 'outline'}
                         onClick={() => {
                           setSelectedPaymentMethod('On Account');
                           setShowBuyerDetails(true);
                         }}
                         className="text-sm h-11"
                         disabled={isProcessingPayment}
                       >
                         <UserPlus className="mr-1 h-4 w-4"/>Account
                       </Button>
                       {!hideLaybuyPayment && (
                         <Button
                           size="default"
                           variant={selectedPaymentMethod === 'Laybuy' ? 'default' : 'outline'}
                           onClick={() => {
                             setSelectedPaymentMethod('Laybuy');
                             setShowBuyerDetails(true);
                           }}
                           className="text-sm h-11"
                           disabled={isProcessingPayment}
                         >
                           <ShoppingBasket className="mr-1 h-4 w-4"/>Laybuy
                         </Button>
                       )}
                    </div>
                </div>

                {shouldEnforceTaxMapping && unmappedProducts.length > 0 && (
                    <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3">
                        <h4 className="text-sm font-semibold mb-2 text-red-900 dark:text-red-100">⚠️ Unmapped / Inactive Mappings</h4>
                        <p className="text-xs text-red-800 dark:text-red-200 mb-2">
                            The following products are missing mapping or not yet approved/synced and cannot be sold:
                        </p>
                        <ul className="text-xs text-red-800 dark:text-red-200 space-y-1">
                            {unmappedProducts.map((productName, idx) => (
                                <li key={idx}>• {productName}</li>
                            ))}
                        </ul>
                        <p className="text-xs text-red-700 dark:text-red-300 mt-2 font-medium">
                            Please map these items, approve/sync mappings, or remove them from cart before proceeding.
                        </p>
                    </div>
                )}

                {selectedPaymentMethod === 'Cash' && (
                    <div className="space-y-3 rounded-lg border bg-blue-50 dark:bg-blue-950/30 p-4">
                        <div>
                            <label className="text-sm font-medium">Cash Paid</label>
                            <Input 
                                type="number" 
                                step="0.01" 
                                placeholder="Enter amount paid" 
                                value={cashPaid} 
                                onChange={(e) => setCashPaid(e.target.value ? parseFloat(e.target.value) : '')}
                                className="mt-2 text-lg font-semibold h-11"
                                disabled={hasBlockingUnmapped || isProcessingPayment}
                            />
                        </div>
                        <Separator />
                        <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                                <span>Amount Due</span>
                                <span className="font-semibold">{currencyFormatter(total)}</span>
                            </div>
                            <div className={cn("flex justify-between text-lg font-bold", change >= 0 ? 'text-green-600' : 'text-red-600')}>
                                <span>Change</span>
                                <span>{currencyFormatter(displayedChange)}</span>
                            </div>
                            {change > 0 && (
                                <div className="rounded-md border bg-background p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="space-y-1">
                                            <Label htmlFor="record-change-tip" className="text-sm font-medium">
                                                Record change as tip
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                Tip: {currencyFormatter(tipFromChange)}
                                            </p>
                                        </div>
                                        <Switch
                                            id="record-change-tip"
                                            checked={recordChangeAsTip}
                                            onCheckedChange={setRecordChangeAsTip}
                                            disabled={hasBlockingUnmapped || isProcessingPayment}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                        <Button 
                            size="lg" 
                            className="w-full bg-green-600 hover:bg-green-700 text-base h-12" 
                            onClick={() => handlePayment('Cash')} 
                            disabled={typeof cashPaid !== 'number' || cashPaid < total || hasBlockingUnmapped || isProcessingPayment}
                            title={hasBlockingUnmapped ? 'Cannot complete payment: unmapped products in cart' : ''}
                        >
                            {isProcessingPayment ? (
                                <>
                                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                    Processing Payment...
                                </>
                            ) : (
                                <>
                                    <CreditCard className="mr-2 h-5 w-5" />
                                    Complete Payment
                                </>
                            )}
                        </Button>
                    </div>
                )}

                {selectedPaymentMethod === 'Laybuy' && (
                    <div className="space-y-3 rounded-lg border bg-amber-50 p-4 dark:bg-amber-950/20">
                        <div>
                            <label className="text-sm font-medium">Deposit Received</label>
                            <Input
                                type="number"
                                step="0.01"
                                min="0"
                                max={total}
                                placeholder="Enter deposit amount"
                                value={laybuyDeposit}
                                onChange={(e) => setLaybuyDeposit(e.target.value ? parseFloat(e.target.value) : '')}
                                className="mt-2 text-lg font-semibold h-11"
                                disabled={hasBlockingUnmapped || isProcessingPayment}
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Deposit Method</label>
                            <select
                                value={laybuyPaymentMethod}
                                onChange={(event) => setLaybuyPaymentMethod(event.target.value)}
                                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                disabled={hasBlockingUnmapped || isProcessingPayment}
                            >
                                <option>Cash</option>
                                <option>Card</option>
                                <option>Mobile Money</option>
                                <option>Bank Transfer</option>
                                <option>Other</option>
                            </select>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Remaining after deposit</span>
                            <span className="font-semibold">
                                {currencyFormatter(Math.max(0, total - (Number.isFinite(normalizedLaybuyDeposit) ? normalizedLaybuyDeposit : 0)))}
                            </span>
                        </div>
                    </div>
                )}

                {selectedPaymentMethod && selectedPaymentMethod !== 'Cash' && (
                    <Button 
                        size="lg" 
                        className="w-full bg-green-600 hover:bg-green-700 text-base h-12" 
                        onClick={() => handlePayment(selectedPaymentMethod)} 
                        disabled={
                            hasBlockingUnmapped ||
                            customerRequiredMissing ||
                            laybuyDepositInvalid ||
                            onAccountCreditLimitExceeded ||
                            isProcessingPayment
                        }
                        title={
                            hasBlockingUnmapped
                                ? 'Cannot complete payment: unmapped products in cart'
                                : customerRequiredMissing
                                    ? 'Customer name or phone is required'
                                    : laybuyDepositInvalid
                                        ? 'Enter a valid laybuy deposit'
                                        : onAccountCreditLimitExceeded
                                            ? 'This sale exceeds the selected customer credit limit'
                                            : ''
                        }
                    >
                        {isProcessingPayment ? (
                            <>
                                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                Processing Payment...
                            </>
                        ) : (
                            <>
                                <CreditCard className="mr-2 h-5 w-5" />
                                Complete Payment
                            </>
                        )}
                    </Button>
                )}
            </div>
        </>
    );

    if (isInlineDisplay) {
        return <div className="space-y-4">{paymentContent}</div>;
    }

    return (
        <DialogContent className="max-h-[90vh] flex flex-col">
            {paymentContent}
        </DialogContent>
    )
}

export const GenericPos = ({
  inventory,
  displayItems,
  emptyStateTitle = 'No products found',
  emptyStateDescription = '',
  cart,
  onAddToCart,
  onUpdateQuantity,
  onClearCart,
  onCheckout,
  productIcon = <Package className="h-8 w-8 text-muted-foreground" />,
  viewMode = 'grid',
  defaultTaxRate,
  activeCharges = [],
  eisEnabled = false,
  blockSalesIfTaxMappingMissing = false,
  branchId,
  hideDefaultMobileCartTrigger = false,
  isMobileCartOpen,
  onMobileCartOpenChange,
  checkoutMode = 'dialog',
  mobileCartDisplay = 'dialog',
  registerQuickAddHandler,
  businessType,
}: PosProps) => {
  const [isPaymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [showPrinterConfig, setShowPrinterConfig] = useState(false);
  const [paymentSessionId, setPaymentSessionId] = useState(0);
  const [internalMobileCartOpen, setInternalMobileCartOpen] = useState(false);
  const [inlineCheckoutState, setInlineCheckoutState] = useState<'payment' | 'confirmation'>('payment');
  const [isPrintingBill, setIsPrintingBill] = useState(false);
  const [billPaperWidth, setBillPaperWidth] = useState<'80mm' | '58mm'>('80mm');
  const [billDisplaySettings, setBillDisplaySettings] = useState<ReceiptDisplaySettings>(DEFAULT_RECEIPT_DISPLAY_SETTINGS);
  const [billNumber, setBillNumber] = useState('');
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  );
  const { format: formatCurrency } = useCurrency();
  const { toast } = useToast();
  const billPrintLockRef = useRef(false);
  const shouldEnforceTaxMapping = eisEnabled && blockSalesIfTaxMappingMissing === true;
  const isInlineCheckout = checkoutMode === 'inline' && isMobileViewport;
  const isInlineMobileCart = mobileCartDisplay === 'inline' && isMobileViewport;
  const mobileCartOpen = isMobileCartOpen ?? internalMobileCartOpen;
  const setMobileCartOpen = onMobileCartOpenChange ?? setInternalMobileCartOpen;
  const activeBranchId = useMemo(
    () => branchId ?? safeLocalStorageGetItem('handypos-active-branch') ?? 'main',
    [branchId]
  );
  const normalizedActiveBranchId = useMemo(
    () => normalizeBranchIdentifier(activeBranchId),
    [activeBranchId]
  );

  useEffect(() => {
    if (!registerQuickAddHandler) {
      return;
    }

    registerQuickAddHandler((item) => onAddToCart(item));
    return () => registerQuickAddHandler(null);
  }, [onAddToCart, registerQuickAddHandler]);

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
  
  const defaultTaxRateDecimal = defaultTaxRate ? defaultTaxRate.rate / 100 : 0;
  const taxLabel = defaultTaxRate ? `${defaultTaxRate.name} (${defaultTaxRate.rate}%)` : 'Tax';

  const offlineBusinessProfile = useLiveQuery(async () => getOfflineBusinessProfile(), []);
  const allowNegativeStock =
    (offlineBusinessProfile as any)?.allowNegativeIngredientStock === true ||
    (offlineBusinessProfile as any)?.allow_negative_ingredient_stock === true;

  const mraMappings = useLiveQuery(() => db.mraMappings.toArray());

  // Log all MRA mappings and their status for debugging
  useEffect(() => {
    if (mraMappings && mraMappings.length > 0) {
      console.log('[POS] ========== LOCAL DB MRA MAPPINGS STATUS ==========');
      console.log(`[POS] Total mappings in local DB: ${mraMappings.length}`);
      
      mraMappings.forEach((mapping, index) => {
        console.log(`[POS] Mapping ${index + 1}:`);
        console.log(`  - ID: ${mapping.id}`);
        console.log(`  - Product ID: ${mapping.inventoryItemId}`);
        console.log(`  - Product Name: ${mapping.mraProductName}`);
        console.log(`  - MRA Code: ${mapping.mraProductCode}`);
        console.log(`  - Is Approved: ${mapping.isApproved}`);
        console.log(`  - MRA Synced: ${mapping.mraSynced}`);
        console.log(`  - Tax Type: ${mapping.mraTaxType}`);
        console.log(`  - Tax Rate: ${mapping.mraTaxRate}%`);
        console.log(`  - Valid for Sale: ${mapping.isApproved && mapping.mraSynced ? '✓ YES' : '✗ NO'}`);
      });
      
      const approved = mraMappings.filter(m => m.isApproved).length;
      const synced = mraMappings.filter(m => m.mraSynced).length;
      const valid = mraMappings.filter(m => m.isApproved && m.mraSynced).length;
      
      console.log(`[POS] ========== SUMMARY ==========`);
      console.log(`[POS] Approved: ${approved}/${mraMappings.length}`);
      console.log(`[POS] Synced: ${synced}/${mraMappings.length}`);
      console.log(`[POS] Valid for Sale: ${valid}/${mraMappings.length}`);
      console.log(`[POS] ====================================`);
    } else {
      console.log('[POS] No MRA mappings found in local database');
    }
  }, [mraMappings]);

  const mappingByItemId = useMemo(() => {
    const shouldScopeByBranch =
      Boolean(normalizedActiveBranchId) &&
      !['main', 'main-branch', 'main_branch'].includes(normalizedActiveBranchId.toLowerCase());

    const scopedMappings = (mraMappings || []).filter((mapping) => {
      const mappingBranchId = normalizeBranchIdentifier(
        (mapping as any).branchId ??
        (mapping as any).branch_id ??
        (mapping as any).branch
      );

      if (!mappingBranchId) {
        return true;
      }
      if (!shouldScopeByBranch) {
        return true;
      }
      return mappingBranchId === normalizedActiveBranchId;
    });

    return buildMappingLookup(scopedMappings);
  }, [mraMappings, normalizedActiveBranchId]);

  const cartSummary = useMemo(() => {
    if (!cart || cart.length === 0) {
      return {
        net: 0,
        tax: 0,
        gross: 0,
        methodSummary: 'N/A' as const,
        perItemTax: {} as Record<string, CartItemTaxDetail>,
      };
    }

    let totalTax = 0;
    let totalNet = 0;
    let totalGross = 0;
    const methods = new Set<'inclusive' | 'exclusive'>();
    const perItemTax: Record<string, CartItemTaxDetail> = {};

    for (const cartItem of cart) {
      const itemKey = String(cartItem.id || '');
      const primaryInventoryItemId = String(cartItem.inventoryItemId || '').trim();
      const fallbackInventoryItemId = resolveCartInventoryItemId(cartItem) || String(cartItem.id || '').trim();
      const preferredMappingKey = primaryInventoryItemId || fallbackInventoryItemId;
      let localMapping = mappingByItemId.get(preferredMappingKey);
      if (!localMapping && fallbackInventoryItemId && fallbackInventoryItemId !== preferredMappingKey) {
        localMapping = mappingByItemId.get(fallbackInventoryItemId);
      }

      const lineAmount = cartItem.isVariablePrice
        ? Number(cartItem.price || 0)
        : Number(cartItem.price || 0) * Number(cartItem.quantity || 0);
      let itemTax = 0;
      let itemNet = lineAmount;
      let itemGross = lineAmount;
      let taxType: NormalizedTaxType = 'unmapped';
      let method: NormalizedTaxCalculationMethod = 'unmapped';
      let ratePercent = 0;
      let status: MappingStatus = 'unmapped';

      const hasMapping = Boolean(localMapping);
      const isApproved = Boolean(localMapping?.isApproved ?? localMapping?.is_approved);
      const isSynced = Boolean(localMapping?.mraSynced ?? localMapping?.mra_synced);
      const fallbackTaxType = hasMapping
        ? normalizeMappedTaxType(localMapping.mraTaxType || localMapping.mra_tax_type)
        : 'standard';
      const fallbackRate = hasMapping
        ? Number(localMapping.mraTaxRate ?? localMapping.mra_tax_rate ?? 0)
        : 0;
      const normalizedFallbackRate = Number.isFinite(fallbackRate) ? fallbackRate : 0;
      const fallbackMethod = hasMapping ? resolveMappingTaxMethod(localMapping) : 'inclusive';

      if (hasMapping) {
        status = isApproved && isSynced ? 'ready' : 'pending';
      }

      if (hasMapping && isApproved && isSynced) {
        taxType = normalizeMappedTaxType(localMapping.mraTaxType || localMapping.mra_tax_type);
        const rawRate = Number(localMapping.mraTaxRate ?? localMapping.mra_tax_rate ?? 0);
        const normalizedRate = Number.isFinite(rawRate) ? rawRate : 0;
        ratePercent = normalizedRate;
        if (taxType === 'zero' || taxType === 'exempt' || normalizedRate <= 0) {
          itemTax = 0;
          itemNet = lineAmount;
          itemGross = lineAmount;
          method = 'not_applicable';
        } else {
          method = resolveMappingTaxMethod(localMapping);
          const effectiveRate = normalizedRate / 100;
          methods.add(method);
          if (method === 'exclusive') {
            itemTax = lineAmount * effectiveRate;
            itemNet = lineAmount;
            itemGross = lineAmount + itemTax;
          } else {
            itemTax = effectiveRate > 0 ? lineAmount * effectiveRate / (1 + effectiveRate) : 0;
            itemGross = lineAmount;
            itemNet = lineAmount - itemTax;
          }
        }
      } else if (!shouldEnforceTaxMapping) {
        taxType = fallbackTaxType;
        ratePercent = normalizedFallbackRate;
        if (hasMapping && (fallbackTaxType === 'zero' || fallbackTaxType === 'exempt')) {
          itemTax = 0;
          itemNet = lineAmount;
          itemGross = lineAmount;
          method = 'not_applicable';
        } else if (hasMapping && normalizedFallbackRate > 0) {
          const effectiveRate = normalizedFallbackRate / 100;
          methods.add(fallbackMethod);
          method = fallbackMethod;
          if (fallbackMethod === 'exclusive') {
            itemTax = lineAmount * effectiveRate;
            itemNet = lineAmount;
            itemGross = lineAmount + itemTax;
          } else {
            itemTax = effectiveRate > 0 ? lineAmount * effectiveRate / (1 + effectiveRate) : 0;
            itemGross = lineAmount;
            itemNet = lineAmount - itemTax;
          }
        } else if (defaultTaxRateDecimal > 0) {
          taxType = 'standard';
          ratePercent = defaultTaxRateDecimal * 100;
          method = 'inclusive';
          itemTax = lineAmount * defaultTaxRateDecimal / (1 + defaultTaxRateDecimal);
          itemGross = lineAmount;
          itemNet = lineAmount - itemTax;
        } else {
          itemTax = 0;
          itemNet = lineAmount;
          itemGross = lineAmount;
          taxType = 'unmapped';
          method = 'unmapped';
          ratePercent = 0;
        }
      } else if (hasMapping) {
        taxType = fallbackTaxType;
        ratePercent = normalizedFallbackRate;
        method = (fallbackTaxType === 'zero' || fallbackTaxType === 'exempt')
          ? 'not_applicable'
          : fallbackMethod;
      }

      totalTax += itemTax;
      totalNet += itemNet;
      totalGross += itemGross;
      if (itemKey) {
        perItemTax[itemKey] = {
          amount: itemTax,
          rate: ratePercent,
          taxType,
          method,
          status,
        };
      }
    }

    let methodSummary: 'Inclusive' | 'Exclusive' | 'Mixed' | 'Default (Inclusive)' | 'N/A' = 'N/A';
    if (methods.size === 1) {
      methodSummary = methods.has('exclusive') ? 'Exclusive' : 'Inclusive';
    } else if (methods.size > 1) {
      methodSummary = 'Mixed';
    } else if (!shouldEnforceTaxMapping && defaultTaxRateDecimal > 0) {
      methodSummary = 'Default (Inclusive)';
    }

    return {
      net: totalNet,
      tax: totalTax,
      gross: totalGross,
      methodSummary,
      perItemTax,
    };
  }, [cart, mappingByItemId, defaultTaxRateDecimal, shouldEnforceTaxMapping]);

  const subtotal = cartSummary.net;
  const tax = cartSummary.tax;
  const appliedCartCharges = useMemo(() => (
    calculateAppliedCharges({
      charges: activeCharges,
      netSubtotal: subtotal,
      grossTotal: cartSummary.gross,
    })
  ), [activeCharges, cartSummary.gross, subtotal]);
  const exclusiveCartChargesTotal = useMemo(
    () => sumAppliedCharges(appliedCartCharges.filter((charge) => charge.calculationMethod === 'exclusive')),
    [appliedCartCharges]
  );
  const cartChargesTotal = useMemo(() => sumAppliedCharges(appliedCartCharges), [appliedCartCharges]);
  const total = cartSummary.gross + exclusiveCartChargesTotal;
  const cartTaxLabel = shouldEnforceTaxMapping ? 'VAT Amount (MRA Rules Applied)' : (taxLabel || 'VAT Amount');
  const hasItemsInCart = cart.length > 0;
  const shouldShowDesktopCart = hasItemsInCart || (isInlineCheckout && inlineCheckoutState === 'confirmation');

  const applyBillPrinterSettings = useCallback(
    (
      settings?: Partial<PrinterSettings> | null,
      fallbackPaperWidth: '80mm' | '58mm' = '80mm'
    ): '80mm' | '58mm' => {
      const resolvedPaperWidth: '80mm' | '58mm' =
        settings?.receiptPaperWidth === '58mm' || settings?.receiptPaperWidth === '80mm'
          ? settings.receiptPaperWidth
          : fallbackPaperWidth;

      setBillPaperWidth(resolvedPaperWidth);
      setBillDisplaySettings({
        showHeader: true,
        showFooter: true,
        showQRCode: false,
        showItemDetails: true,
        showTaxBreakdown: true,
        receiptFontSize: normalizeReceiptFontSize(settings?.receiptFontSize, resolvedPaperWidth),
        receiptFontWeight: normalizeReceiptFontWeight(settings?.receiptFontWeight),
        receiptLineHeight: normalizeReceiptLineHeight(settings?.receiptLineHeight),
        receiptPaddingX: normalizeReceiptPaddingX(settings?.receiptPaddingX, resolvedPaperWidth),
        receiptBusinessNameFontSize: normalizeReceiptBusinessNameFontSize(
          settings?.receiptBusinessNameFontSize,
          resolvedPaperWidth
        ),
        receiptBusinessNameFontWeight: normalizeReceiptFontWeight(
          settings?.receiptBusinessNameFontWeight ?? DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT
        ),
        receiptBusinessNameScaleX: normalizeReceiptTextScaleX(
          settings?.receiptBusinessNameScaleX,
          DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
        ),
        receiptHeaderDetailScaleX: normalizeReceiptTextScaleX(
          settings?.receiptHeaderDetailScaleX,
          DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
        ),
        receiptLegalMarkerFontSize: normalizeReceiptLegalMarkerFontSize(
          settings?.receiptLegalMarkerFontSize,
          resolvedPaperWidth
        ),
        receiptLegalMarkerFontWeight: normalizeReceiptFontWeight(
          settings?.receiptLegalMarkerFontWeight ?? DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT
        ),
        receiptLegalMarkerScaleX: normalizeReceiptTextScaleX(
          settings?.receiptLegalMarkerScaleX,
          DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X
        ),
        receiptQrCodeSize: normalizeReceiptQRCodeSize(settings?.receiptQrCodeSize, resolvedPaperWidth),
      });

      return resolvedPaperWidth;
    },
    []
  );

  const createBillNumber = useCallback((): string => {
    return '';
  }, []);

  const handlePrintBill = useCallback(async (): Promise<void> => {
    if (billPrintLockRef.current) {
      return;
    }

    if (cart.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Nothing to print',
        description: 'Add items to the cart before printing a bill.',
      });
      return;
    }

    billPrintLockRef.current = true;
    setIsPrintingBill(true);

    try {
      const { printerService } = await import('@/lib/services/printer-service');
      const { silentPrintService } = await import('@/lib/services/silent-print-service');
      const [settings, defaultPrinter] = await Promise.all([
        printerService.getPrinterSettings(activeBranchId),
        printerService.getDefaultPrinter(activeBranchId),
      ]);
      const selectedPaperWidth = applyBillPrinterSettings(
        settings,
        (defaultPrinter?.paperWidth as '80mm' | '58mm') || '80mm'
      );

      if (!defaultPrinter) {
        toast({
          variant: 'destructive',
          title: 'No Printer Configured',
          description: 'Configure a default printer before printing customer bills.',
        });
        return;
      }

      setBillNumber(createBillNumber());
      await new Promise((resolve) => setTimeout(resolve, 150));

      const billElement = document.getElementById('bill-printable-area');
      const printContents = billElement?.innerHTML;
      if (!printContents || printContents.trim().length === 0) {
        toast({
          variant: 'destructive',
          title: 'Print Failed',
          description: 'Bill content was not ready. Please try again.',
        });
        return;
      }

      const isBluetoothPrinter =
        defaultPrinter.connectionType === 'bluetooth' ||
        String(defaultPrinter.id || '').toLowerCase().startsWith('bt:');
      const printAttemptTimeoutMs = isBluetoothPrinter ? 45000 : 20000;

      toast({
        title: 'Printing Bill',
        description: `Sending customer bill to ${defaultPrinter.name}`,
      });

      const printAttempt = Promise.race([
        silentPrintService
          .printSilentlyViaSystem(printContents, {
            printerName: defaultPrinter.name,
            printerId: defaultPrinter.id,
            copies: 1,
            paperSize: selectedPaperWidth,
            printerPaperSize: defaultPrinter.paperWidth as '80mm' | '58mm',
          })
          .then((success) => ({ success, timedOut: false })),
        new Promise<{ success: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ success: false, timedOut: true }), printAttemptTimeoutMs)
        ),
      ]);

      const result = await printAttempt;
      if (!result.success) {
        toast({
          variant: 'destructive',
          title: result.timedOut ? 'Print Timed Out' : 'Print Failed',
          description: result.timedOut
            ? 'Printer did not respond in time. Check the connection and try again.'
            : 'Failed to send the customer bill to the printer.',
        });
        return;
      }

      toast({
        title: 'Bill Printed',
        description: 'The cart is still open for payment.',
      });
    } catch (error) {
      console.error('[Bill Print] Failed to print bill:', error);
      toast({
        variant: 'destructive',
        title: 'Print Error',
        description: error instanceof Error ? error.message : 'An unknown error occurred.',
      });
    } finally {
      setIsPrintingBill(false);
      billPrintLockRef.current = false;
    }
  }, [
    activeBranchId,
    applyBillPrinterSettings,
    cart,
    createBillNumber,
    toast,
  ]);

  useEffect(() => {
    if (!isInlineCheckout || inlineCheckoutState !== 'confirmation' || !hasItemsInCart) {
      return;
    }

    setPaymentSessionId((id) => id + 1);
    setInlineCheckoutState('payment');
  }, [hasItemsInCart, inlineCheckoutState, isInlineCheckout]);

  const getMRAMappingStatus = useCallback((itemId: string): {
    hasMapping: boolean;
    isApproved: boolean;
    isSynced: boolean;
    isValid: boolean;
    mapping?: any;
  } => {
    const mapping = mappingByItemId.get(String(itemId));
    if (!mapping) {
      return {
        hasMapping: false,
        isApproved: false,
        isSynced: false,
        isValid: false,
      };
    }

    const isApproved = Boolean(mapping.isApproved ?? mapping.is_approved);
    const isSynced = Boolean(mapping.mraSynced ?? mapping.mra_synced);
    return {
      hasMapping: true,
      isApproved,
      isSynced,
      isValid: isApproved && isSynced,
      mapping,
    };
  }, [mappingByItemId]);

  const hasValidMRAMapping = (itemId: string): boolean => {
    const status = getMRAMappingStatus(itemId);

    if (!status.hasMapping) {
      console.log(`[POS] Product ${itemId} has NO MRA mapping`);
      return false;
    }

    if (!status.isValid) {
      console.log(`[POS] Product ${itemId} mapping found but NOT valid:`, {
        isApproved: status.isApproved,
        mraSynced: status.isSynced,
        reason: !status.isApproved ? 'Not approved' : 'Not synced'
      });
      return false;
    }

    console.log(`[POS] Product ${itemId} has VALID MRA mapping:`, {
      mraProductCode: status.mapping?.mraProductCode || status.mapping?.mra_product_code,
      isApproved: status.isApproved,
      mraSynced: status.isSynced
    });
    return true;
  };

  const canProduceItem = (item: InventoryItem): boolean => {
    if (!item.recipe || item.recipe.length === 0) {
      return true;
    }
    
    const canProduce = item.recipe.every((recipeItem: any) => {
      const ingredientId = recipeItem.ingredientId;
      const requiredQuantity = recipeItem.quantity || 0;
      
      const ingredient = inventory.find(i => i.id === ingredientId);
      
      if (!ingredient) {
        console.warn(`Ingredient not found in inventory: ${recipeItem.name} (ID: ${ingredientId})`);
        return false;
      }
      
      const availableStock = getAvailableStockUnits(ingredient);
      const hasSufficientStock = availableStock >= requiredQuantity;
      
      return allowNegativeStock || hasSufficientStock;
    });
    
    return canProduce;
  };

  const getStockInfo = (
    item: InventoryItem
  ): {
    text: string;
    canAddToCart: boolean;
    hasMRAMapping: boolean;
    stockTone: 'available' | 'warning' | 'out';
  } => {
    // First check stock/availability regardless of MRA mapping
    let stockText = '';
    let hasStock = false;
    
    if (item.itemType === 'sellable' && item.recipe && item.recipe.length > 0) {
      const available = canProduceItem(item);
      stockText = available ? '✓ Available' : '✗ Out of Stock';
      hasStock = available;
    } else {
      const remaining = getAvailableStockUnits(item);
      hasStock = allowNegativeStock || remaining > 0;
      stockText = `${formatItemQuantitySummary(item, remaining)} remaining`;
    }
    
    if (!shouldEnforceTaxMapping) {
      return {
        text: stockText,
        canAddToCart: hasStock,
        hasMRAMapping: true,
        stockTone: hasStock ? 'available' : 'out',
      };
    }

    // Then check MRA mapping (only when enforcement is enabled)
    const mraStatus = getMRAMappingStatus(item.id);
    const hasMRAMapping = mraStatus.isValid;

    if (!hasMRAMapping) {
      const mappingWarning = !mraStatus.hasMapping
        ? '⚠️ No MRA Mapping'
        : (!mraStatus.isApproved ? '⚠️ MRA Pending Approval' : '⚠️ MRA Not Synced');
      return {
        text: mappingWarning,
        // Let the add-to-cart handler do the final backend-aware validation.
        // This avoids dead product clicks when the local mapping cache is stale.
        canAddToCart: hasStock,
        hasMRAMapping: false,
        stockTone: hasStock ? 'warning' : 'out',
      };
    }
    
    // If has MRA mapping, show stock info
    return {
      text: stockText,
      canAddToCart: hasStock,
      hasMRAMapping: true,
      stockTone: hasStock ? 'available' : 'out',
    };
  };

  const renderProductGrid = () => {
    const itemsToDisplay = displayItems || inventory.filter(item => item.itemType === 'sellable');

    if (itemsToDisplay.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <Package className="h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">{emptyStateTitle}</p>
          {emptyStateDescription ? (
            <p className="mt-2 text-sm text-muted-foreground">{emptyStateDescription}</p>
          ) : null}
        </div>
      );
    }
    
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {itemsToDisplay.map((item) => {
          const { text: stockInfo, canAddToCart, stockTone } = getStockInfo(item);
          return (
            <div
              key={item.id}
              onClick={async (e) => {
                e.stopPropagation();
                if (canAddToCart) {
                  await onAddToCart(item);
                }
              }}
              role="button"
              tabIndex={0}
              onKeyDown={async (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && canAddToCart) {
                  e.preventDefault();
                  await onAddToCart(item);
                }
              }}
            >
              <ProductCard
                item={item}
                onAddToCart={() => {}}
                productIcon={productIcon}
                currencyFormatter={formatCurrency}
                canAddToCart={canAddToCart}
                stockInfo={stockInfo}
                stockTone={stockTone}
              />
            </div>
          );
        })}
      </div>
    );
  };

  const renderProductList = () => {
    const itemsToDisplay = displayItems || inventory.filter(item => item.itemType === 'sellable');

    if (itemsToDisplay.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <Package className="h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">{emptyStateTitle}</p>
          {emptyStateDescription ? (
            <p className="mt-2 text-sm text-muted-foreground">{emptyStateDescription}</p>
          ) : null}
        </div>
      );
    }
    
    return (
      <div className="space-y-2">
        {itemsToDisplay.map((item) => {
          const { text: stockInfo, canAddToCart, stockTone } = getStockInfo(item);
          return (
            <div 
              key={item.id} 
              className={cn(
                "flex items-center gap-4 rounded-md border p-2 cursor-pointer hover:bg-muted",
                !canAddToCart && "opacity-50 cursor-not-allowed"
              )} 
              onClick={async () => canAddToCart && await onAddToCart(item)}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted/50">
                 {productIcon}
              </div>
              <div className="flex-1">
                <p className="font-semibold">{item.name}</p>
                <p className="text-sm text-muted-foreground">{item.category}</p>
                <p className={cn(
                  "text-xs mt-1 font-medium",
                  stockTone === 'available'
                    ? "text-green-600"
                    : stockTone === 'warning'
                      ? "text-amber-600"
                      : "text-red-600"
                )}>
                  {stockInfo}
                </p>
              </div>
              <p className="font-bold text-primary">{formatCurrency(item.price || 0)}</p>
            </div>
          );
        })}
      </div>
    );
  };

  const renderCartItems = (variant: 'plain' | 'cards' = 'plain') => {
    if (cart.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center text-center h-full">
          {isInlineCheckout && inlineCheckoutState === 'confirmation' ? (
            <>
              <CheckCircle className="h-16 w-16 text-green-500/70" />
              <p className="mt-4 font-medium text-foreground">Sale completed successfully.</p>
              <p className="mt-2 text-sm text-muted-foreground">Receipt actions are ready below.</p>
            </>
          ) : (
            <>
              <ShoppingBasket className="h-16 w-16 text-muted-foreground/30" />
              <p className="mt-4 text-muted-foreground">Select products to start a new sale.</p>
            </>
          )}
        </div>
      );
    }
    return (
      <div className={variant === 'cards' ? 'space-y-2' : 'space-y-2'}>
        {cart.map((item) => (
          variant === 'cards' ? (
            <div
              key={item.id}
              className="rounded-xl border border-border/70 bg-card/95 px-2.5 py-2 shadow-[0_14px_35px_-28px_hsl(var(--foreground)/0.45)] backdrop-blur"
            >
              <CartItemView
                item={item}
                onUpdateQuantity={onUpdateQuantity}
                currencyFormatter={formatCurrency}
                taxDetail={cartSummary.perItemTax[String(item.id)]}
                showTaxStatus={shouldEnforceTaxMapping}
                layout="compact"
              />
            </div>
          ) : (
            <CartItemView
              key={item.id}
              item={item}
              onUpdateQuantity={onUpdateQuantity}
              currencyFormatter={formatCurrency}
              taxDetail={cartSummary.perItemTax[String(item.id)]}
              showTaxStatus={shouldEnforceTaxMapping}
            />
          )
        ))}
      </div>
    );
  };

  const renderCartFooter = () => (
    <div className="flex flex-col gap-4 bg-muted/50 p-4">
      {isInlineCheckout ? (
        <PaymentDialog
          subtotal={subtotal}
          tax={tax}
          taxLabel={taxLabel}
          defaultTaxRate={defaultTaxRate}
          activeCharges={activeCharges}
          onCheckout={onCheckout}
          onClose={() => {
            setPaymentSessionId((id) => id + 1);
            setInlineCheckoutState('payment');
            setMobileCartOpen(false);
          }}
          onStepChange={setInlineCheckoutState}
          currencyFormatter={formatCurrency}
          resetToken={paymentSessionId}
          cart={cart}
          eisEnabled={eisEnabled}
          blockSalesIfTaxMappingMissing={blockSalesIfTaxMappingMissing}
          branchId={branchId}
          onConfigurePrinter={() => setShowPrinterConfig(true)}
          displayMode="inline"
          businessType={businessType}
        />
      ) : (
        <>
          <div className="space-y-1 text-sm">
            <div className="flex w-full items-center justify-between gap-2">
              <span className="flex-shrink-0 text-muted-foreground">Subtotal (Excl VAT)</span>
              <span className="flex-shrink-0 text-right">{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex w-full items-center justify-between gap-2">
              <span className="flex-shrink-0 text-muted-foreground">{cartTaxLabel}</span>
              <span className="flex-shrink-0 text-right font-semibold text-green-600">{formatCurrency(tax)}</span>
            </div>
            {cartChargesTotal > 0 && (
              <div className="flex w-full items-center justify-between gap-2">
                <span className="flex-shrink-0 text-muted-foreground">
                  Charges & Levies{exclusiveCartChargesTotal <= 0 ? ' (included)' : ''}
                </span>
                <span className="flex-shrink-0 text-right">{formatCurrency(exclusiveCartChargesTotal > 0 ? exclusiveCartChargesTotal : cartChargesTotal)}</span>
              </div>
            )}
          </div>
          <div className="flex w-full items-center justify-between gap-2 text-lg font-bold">
            <span className="flex-shrink-0">Total (Incl VAT)</span>
            <span className="flex-shrink-0 text-right">{formatCurrency(total)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              size="lg"
              variant="outline"
              onClick={() => void handlePrintBill()}
              disabled={isPrintingBill || cart.length === 0}
            >
              {isPrintingBill ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Printing...
                </>
              ) : (
                <>
                  <Printer className="mr-2 h-5 w-5" />
                  Print Bill
                </>
              )}
            </Button>
            <Button size="lg" className="bg-green-600 hover:bg-green-700" onClick={() => { setPaymentSessionId((id) => id + 1); setPaymentDialogOpen(true); }}>
              <CreditCard className="mr-2 h-5 w-5" /> Payment
            </Button>
          </div>
        </>
      )}
    </div>
  );

  const renderMobileInlineCart = () => (
    <div className="flex min-h-0 flex-1 flex-col lg:hidden">
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {renderCartItems('cards')}
      </div>
      <div className="border-t bg-background">
        {renderCartFooter()}
      </div>
    </div>
  );

  const renderDesktopCart = () => (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b p-2 shrink-0">
        <CardTitle className="text-base">Current Order</CardTitle>
        <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-muted-foreground h-8 w-8"><UserPlus className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="text-destructive h-8 w-8" onClick={onClearCart}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </CardHeader>
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full overflow-y-scroll hide-scrollbar p-4">
          {renderCartItems()}
        </div>
      </div>
      <div className="shrink-0 border-t">{renderCartFooter()}</div>
    </Card>
  );

  const mobileCartBadgeCount = cart.reduce((count, item) => {
    if (item.isVariablePrice) {
      return count + 1;
    }

    const quantity = Math.max(0, toFiniteNumber(item.quantity, 0));
    const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);
    if (item.isSoldInPortions && portionsPerUnit > 0) {
      return count + Math.max(1, Math.round(quantity * portionsPerUnit));
    }

    return count + Math.max(1, Math.round(quantity));
  }, 0);

  const renderMobileCartDialog = () => (
    <Dialog open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
      {!hideDefaultMobileCartTrigger && (
        <DialogTrigger asChild>
          <Button
            size="lg"
            className="tauri-android-floating-bottom fixed bottom-4 right-4 z-10 h-14 w-auto rounded-full border border-border/70 bg-background/95 px-3 shadow-[0_18px_45px_-24px_hsl(var(--foreground)/0.55)] backdrop-blur lg:hidden"
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">
                {mobileCartBadgeCount}
              </span>
              <span className="flex flex-col items-start leading-tight">
                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Cart</span>
                <span className="text-sm font-semibold">View order</span>
              </span>
            </span>
            <Separator orientation="vertical" className="mx-3 h-7" />
            <span className="font-bold">{formatCurrency(total)}</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        showCloseButton={false}
        className="tauri-android-sidebar-safe-top m-0 flex h-full max-h-full w-full max-w-full flex-col gap-0 p-0 sm:max-w-full"
      >
        <DialogHeader className="border-b px-4 pb-4 pt-5 sm:pt-4">
          <div className="flex items-center justify-between">
            <DialogTitle>Current Order</DialogTitle>
            <div className="flex items-center gap-1">
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClearCart}
                  aria-label="Delete cart"
                >
                  <Trash2 className="text-destructive" />
                </Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close current order">
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            </div>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-3">{renderCartItems('cards')}</div>
        <div className="mt-auto border-t">{renderCartFooter()}</div>
      </DialogContent>
    </Dialog>
  );
  
  const handlePaymentDialogClose = () => {
    setPaymentDialogOpen(false);
  }

  return (
    <>
    <div
      className={cn(
        'grid h-full w-full grid-cols-1 gap-6 transition-all duration-300 min-h-0',
        shouldShowDesktopCart && 'lg:grid-cols-[1fr_420px]'
      )}
    >
      {isInlineMobileCart ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {renderMobileInlineCart()}
        </div>
      ) : (
        <Card className="h-full w-full overflow-hidden min-h-0">
          <CardContent className="h-full w-full overflow-y-scroll overflow-x-hidden hide-scrollbar p-4 min-h-0">
            {viewMode === 'grid' ? renderProductGrid() : renderProductList()}
          </CardContent>
        </Card>
      )}
      
      {shouldShowDesktopCart && (
        <div className="hidden lg:flex lg:flex-col h-full w-full min-h-0">
          {renderDesktopCart()}
        </div>
      )}

      {!isInlineMobileCart && (hasItemsInCart || hideDefaultMobileCartTrigger || mobileCartOpen) && renderMobileCartDialog()}
    </div>
    {!isInlineCheckout && (
      <Dialog open={isPaymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
          <PaymentDialog
              subtotal={subtotal}
              tax={tax}
              taxLabel={taxLabel}
              defaultTaxRate={defaultTaxRate}
              activeCharges={activeCharges}
              onCheckout={onCheckout}
              onClose={handlePaymentDialogClose}
              currencyFormatter={formatCurrency}
              resetToken={paymentSessionId}
              cart={cart}
              eisEnabled={eisEnabled}
              blockSalesIfTaxMappingMissing={blockSalesIfTaxMappingMissing}
              branchId={branchId}
              onConfigurePrinter={() => setShowPrinterConfig(true)}
              businessType={businessType}
          />
      </Dialog>
    )}
    {hasItemsInCart && (
      <div className="hidden">
        <BillReceipt
          cart={cart}
          currencyFormatter={formatCurrency}
          subtotal={subtotal}
          tax={tax}
          charges={cartChargesTotal}
          total={total}
          taxLabel={cartTaxLabel}
          billNumber={billNumber}
          paperWidth={billPaperWidth}
          receiptFontSize={billDisplaySettings.receiptFontSize}
          receiptFontWeight={billDisplaySettings.receiptFontWeight}
          receiptLineHeight={billDisplaySettings.receiptLineHeight}
          receiptPaddingX={billDisplaySettings.receiptPaddingX}
          receiptBusinessNameFontSize={billDisplaySettings.receiptBusinessNameFontSize}
          receiptBusinessNameFontWeight={billDisplaySettings.receiptBusinessNameFontWeight}
          receiptBusinessNameScaleX={billDisplaySettings.receiptBusinessNameScaleX}
          receiptHeaderDetailScaleX={billDisplaySettings.receiptHeaderDetailScaleX}
        />
      </div>
    )}
    <PrinterConfigModal isOpen={showPrinterConfig} onOpenChange={setShowPrinterConfig} />
    </>
  );
};
