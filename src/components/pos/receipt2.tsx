'use client';

import React from 'react';
import { format } from 'date-fns';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Business, type Order } from '@/lib/db';
import { getOfflineBusinessProfile } from '@/lib/business-profile';
import { safeLocalStorageGetItem } from '@/lib/safe-local-storage';
import {
  getLocalReceiptNumberStorageKey,
  getOrCreateLocalReceiptNumberFromStorageKey,
  getOrderLocalReceiptNumber,
} from '@/lib/local-receipt-number';
import {
  getDefaultReceiptPaddingX,
  normalizeReceiptBusinessNameFontSize,
  normalizeReceiptFontSize,
  normalizeReceiptFontWeight,
  normalizeReceiptLegalMarkerFontSize,
  normalizeReceiptLineHeight,
  normalizeReceiptPaddingX,
  normalizeReceiptQRCodeSize,
  normalizeReceiptTextScaleX,
  type ReceiptFontWeight,
} from '@/lib/services/printer-service';

interface Receipt2Props {
  order: Order;
  business?: Business;
  currencyFormatter: (amount: number) => string;
  paperWidth?: '80mm' | '58mm';
  showQRCode?: boolean;
  showHeader?: boolean;
  showFooter?: boolean;
  showItemDetails?: boolean;
  showTaxBreakdown?: boolean;
  copyNumber?: number;
  rootId?: string;
  receiptFontSize?: number;
  receiptFontWeight?: ReceiptFontWeight;
  receiptLineHeight?: number;
  receiptPaddingX?: number;
  receiptBusinessNameFontSize?: number;
  receiptBusinessNameFontWeight?: ReceiptFontWeight;
  receiptBusinessNameScaleX?: number;
  receiptHeaderDetailScaleX?: number;
  receiptLegalMarkerFontSize?: number;
  receiptLegalMarkerFontWeight?: ReceiptFontWeight;
  receiptLegalMarkerScaleX?: number;
  receiptQrCodeSize?: number;
  fiscalMode?: boolean;
}

type BranchLike = {
  id?: string;
  backendId?: string;
  name?: string;
  address?: string;
  city?: string;
  mra_branch_code?: string;
  mraBranchCode?: string;
  mra_device_location?: string;
  mraDeviceLocation?: string;
};

type LegalItem = {
  id: string;
  name: string;
  optionLines: string[];
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  taxableAmount: number;
  vatAmount: number;
  taxRate: number;
  taxCategory: string;
};

type TaxBucket = {
  category: string;
  rate: number;
  taxableAmount: number;
  vatAmount: number;
};

type LevyBucket = {
  name: string;
  rate: number;
  amount: number;
};

const LOCAL_STORAGE_KEYS = {
  BRANCHES: 'handypos-branches',
  ACTIVE_BRANCH: 'handypos-active-branch',
  CURRENT_BRANCH: 'handypos-current-branch-id',
};

const toFiniteNumber = (value: unknown, fallback: number = 0): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(/[^0-9.-]/g, '');
    if (!normalized) {
      return fallback;
    }
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toOptionalFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const parsed = toFiniteNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
};

const toTrimmedString = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const parseStoredJson = <T,>(value: string | null): T | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const getBranchIdCandidates = (value: unknown): string[] => {
  const normalized = toTrimmedString(value);
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  const numericMatch = normalized.match(/\d+/)?.[0];
  if (numericMatch) {
    candidates.add(numericMatch);
    candidates.add(`BRN-${numericMatch}`);
  }
  return Array.from(candidates);
};

const matchesBranchId = (branch: BranchLike, value: unknown): boolean => {
  const branchCandidates = new Set([
    ...getBranchIdCandidates(branch.id),
    ...getBranchIdCandidates(branch.backendId),
  ]);

  return getBranchIdCandidates(value).some((candidate) => branchCandidates.has(candidate));
};

const getStoredActiveBranch = (orderBranchId?: unknown): BranchLike | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const preferredBranchId =
    toTrimmedString(orderBranchId) ||
    toTrimmedString(safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH)) ||
    toTrimmedString(safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.CURRENT_BRANCH));

  const branches = parseStoredJson<BranchLike[]>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BRANCHES)
  ) || [];

  const branch =
    branches.find((candidate) => matchesBranchId(candidate, preferredBranchId)) ||
    branches[0] ||
    null;

  if (!branch) {
    return null;
  }

  const rawBranch =
    parseStoredJson<BranchLike>(safeLocalStorageGetItem(`handypos-branch-${branch.id}`)) ||
    parseStoredJson<BranchLike>(safeLocalStorageGetItem(`handypos-branch-${branch.backendId}`));

  return {
    ...branch,
    ...(rawBranch || {}),
  };
};

const resolveBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'vat'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'non_vat', 'non-vat'].includes(normalized)) {
      return false;
    }
  }
  return null;
};

const resolveQrPayload = (rawValue: unknown): string => {
  const raw = toTrimmedString(rawValue);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return parsed.trim();
    }
    if (parsed && typeof parsed === 'object') {
      const nestedPayload =
        (parsed as any).qrCodePayload ||
        (parsed as any).qr_code_payload ||
        (parsed as any).qrPayload ||
        (parsed as any).qr_payload ||
        (parsed as any).validationURL ||
        (parsed as any).validationUrl ||
        (parsed as any).validation_url;
      return toTrimmedString(nestedPayload);
    }
  } catch {
    // Keep the raw value when it is already the MRA payload.
  }

  return raw;
};

const resolveBuyerField = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    const value = toTrimmedString(candidate);
    if (value) {
      return value;
    }
  }
  return '';
};

const formatAmount = (value: unknown): string => {
  const amount = toFiniteNumber(value, 0);
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const formatQuantity = (value: unknown): string => {
  const quantity = toFiniteNumber(value, 1);
  if (Math.abs(quantity - Math.round(quantity)) < 0.0001) {
    return String(Math.round(quantity));
  }
  return quantity.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
};

const normalizeTaxType = (value: unknown): string => {
  return toTrimmedString(value).toLowerCase().replace(/[\s-]+/g, '_');
};

const resolveVatCategory = (item: any, taxRate: number): string => {
  const explicitCategory = toTrimmedString(item.vat_category ?? item.vatCategory);
  const explicitMatch = explicitCategory.match(/[A-Za-z]/);
  if (explicitMatch) {
    return explicitMatch[0].toUpperCase();
  }

  const taxType = normalizeTaxType(item.tax_type ?? item.taxType);
  if (taxType.includes('exempt')) {
    return 'E';
  }
  if (taxType.includes('zero')) {
    return 'B';
  }
  return taxRate > 0 ? 'A' : 'B';
};

const getSelectedOptions = (item: any): Array<Record<string, unknown>> => {
  const selected = item?.selectedOptions ?? item?.selected_options;
  return Array.isArray(selected)
    ? selected.filter((option) => option && typeof option === 'object')
    : [];
};

const formatSelectedOptionLine = (option: Record<string, unknown>): string => {
  const groupName = toTrimmedString(
    option.groupName ??
    option.group_name ??
    option.optionGroupName ??
    option.option_group_name
  );
  const optionName = toTrimmedString(option.name ?? option.label ?? option.optionName ?? option.option_name);
  const quantity = toFiniteNumber(
    option.quantity ?? option.selectedQuantity ?? option.selected_quantity,
    1
  );
  const quantityPrefix = quantity > 1 ? `${formatQuantity(quantity)} X ` : '';

  if (!optionName) {
    return '';
  }

  return groupName ? `${groupName}: ${quantityPrefix}${optionName}` : `${quantityPrefix}${optionName}`;
};

const buildLegalItems = (items: any[]): LegalItem[] => {
  return items.map((item, index) => {
    const quantity = Math.max(1, toFiniteNumber(item.quantity, 1));
    const unitPrice = toFiniteNumber(item.price, 0);
    const taxMethod =
      (item.tax_calculation_method || item.taxCalculationMethod) === 'exclusive'
        ? 'exclusive'
        : 'inclusive';
    const explicitTaxRate = toOptionalFiniteNumber(item.tax_rate ?? item.taxRate);
    const explicitTaxAmount = toOptionalFiniteNumber(item.tax_amount ?? item.taxAmount);
    const explicitSubtotal = toOptionalFiniteNumber(item.subtotal);
    const lineAmount = unitPrice * quantity;
    const grossAmount = toFiniteNumber(
      item.total,
      taxMethod === 'exclusive'
        ? (explicitSubtotal ?? lineAmount) + (explicitTaxAmount ?? 0)
        : lineAmount
    );

    let taxRate = explicitTaxRate ?? 0;
    if (taxRate <= 0 && explicitTaxAmount && explicitSubtotal && explicitSubtotal > 0) {
      taxRate = (explicitTaxAmount / explicitSubtotal) * 100;
    }

    const normalizedRate = Number.isFinite(taxRate) ? Number(taxRate.toFixed(2)) : 0;
    const computedVat =
      explicitTaxAmount ??
      (normalizedRate > 0
        ? taxMethod === 'exclusive'
          ? (explicitSubtotal ?? lineAmount) * (normalizedRate / 100)
          : grossAmount - grossAmount / (1 + normalizedRate / 100)
        : 0);
    const vatAmount = Number.isFinite(computedVat) ? computedVat : 0;
    const taxableAmount =
      explicitSubtotal ??
      (normalizedRate > 0 && taxMethod === 'inclusive'
        ? grossAmount - vatAmount
        : grossAmount);

    return {
      id: toTrimmedString(item.id) || `item-${index}`,
      name: (toTrimmedString(item.name) || 'ITEM').toUpperCase(),
      optionLines: getSelectedOptions(item).map(formatSelectedOptionLine).filter(Boolean),
      quantity,
      unitPrice,
      grossAmount,
      taxableAmount,
      vatAmount,
      taxRate: normalizedRate,
      taxCategory: resolveVatCategory(item, normalizedRate),
    };
  });
};

const buildTaxBuckets = (
  legalItems: LegalItem[],
  fallbackTaxableAmount: number,
  fallbackVatAmount: number,
  fallbackRate: number
): TaxBucket[] => {
  const buckets = new Map<string, TaxBucket>();

  legalItems.forEach((item) => {
    const key = `${item.taxCategory}-${item.taxRate.toFixed(2)}`;
    const existing = buckets.get(key) || {
      category: item.taxCategory,
      rate: item.taxRate,
      taxableAmount: 0,
      vatAmount: 0,
    };

    existing.taxableAmount += item.taxableAmount;
    existing.vatAmount += item.vatAmount;
    buckets.set(key, existing);
  });

  if (buckets.size === 0 && (fallbackTaxableAmount > 0 || fallbackVatAmount > 0)) {
    buckets.set(`A-${fallbackRate.toFixed(2)}`, {
      category: fallbackRate > 0 ? 'A' : 'B',
      rate: fallbackRate,
      taxableAmount: fallbackTaxableAmount,
      vatAmount: fallbackVatAmount,
    });
  }

  return Array.from(buckets.values()).sort((left, right) => {
    if (left.category !== right.category) {
      return left.category.localeCompare(right.category);
    }
    return right.rate - left.rate;
  });
};

const buildLevyBuckets = (order: any): LevyBucket[] => {
  const rawCharges = order?.chargesSnapshot ?? order?.charges_snapshot;
  if (!Array.isArray(rawCharges)) {
    return [];
  }

  const buckets = new Map<string, LevyBucket>();
  rawCharges.forEach((charge) => {
    if (!charge || typeof charge !== 'object') {
      return;
    }
    const value = charge as Record<string, unknown>;
    const chargeType = toTrimmedString(value.chargeType ?? value.charge_type).toUpperCase();
    if (chargeType !== 'LEVY') {
      return;
    }
    const name = toTrimmedString(
      value.levyTypeId ?? value.levy_type_id ?? value.name
    ) || 'LEVY';
    const rate = toFiniteNumber(value.rate ?? value.levyRate ?? value.levy_rate, 0);
    const amount = toFiniteNumber(value.amount ?? value.levyAmount ?? value.levy_amount, 0);
    if (amount <= 0) {
      return;
    }
    const key = `${name.toUpperCase()}:${rate}`;
    const existing = buckets.get(key) || { name, rate, amount: 0 };
    existing.amount += amount;
    buckets.set(key, existing);
  });

  return Array.from(buckets.values());
};

const LegalRow = ({
  left,
  right,
  strong = false,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  strong?: boolean;
}) => (
  <div className={`receipt2-row${strong ? ' receipt2-strong' : ''}`}>
    <span>{left}</span><span>{right}</span>
  </div>
);

export const Receipt2 = ({
  order,
  business,
  currencyFormatter,
  paperWidth = '80mm',
  showHeader = true,
  showFooter = true,
  showItemDetails = true,
  copyNumber = 1,
  rootId = 'receipt-printable-area',
  receiptFontSize,
  receiptFontWeight,
  receiptLineHeight,
  receiptPaddingX,
  receiptBusinessNameFontSize,
  receiptBusinessNameFontWeight,
  receiptBusinessNameScaleX,
  receiptHeaderDetailScaleX,
  receiptLegalMarkerFontSize,
  receiptLegalMarkerFontWeight,
  receiptLegalMarkerScaleX,
  receiptQrCodeSize,
  fiscalMode = false,
}: Receipt2Props) => {
  const offlineBusiness = useLiveQuery(async () => getOfflineBusinessProfile(), []);
  const receiptSession = useLiveQuery(async () => {
    const sessionId = toTrimmedString(
      (order as any).sessionId ??
      (order as any).session_id ??
      (order as any).session
    );
    if (!sessionId) {
      return null;
    }
    return db.sessions.get(sessionId);
  }, [(order as any).sessionId, (order as any).session_id, (order as any).session]);
  const explicitLocalReceiptNumber = getOrderLocalReceiptNumber(order);
  const localReceiptNumberStorageKey = getLocalReceiptNumberStorageKey(order);
  const [generatedLocalReceiptNumber, setGeneratedLocalReceiptNumber] = React.useState(explicitLocalReceiptNumber);

  React.useEffect(() => {
    setGeneratedLocalReceiptNumber(
      getOrCreateLocalReceiptNumberFromStorageKey(
        localReceiptNumberStorageKey,
        explicitLocalReceiptNumber
      )
    );
  }, [explicitLocalReceiptNumber, localReceiptNumberStorageKey]);

  const resolvedBusiness = business || offlineBusiness || undefined;
  const activeBranch = getStoredActiveBranch(
    (order as any).branchId ?? (order as any).branch_id ?? (receiptSession as any)?.branchId
  );

  const businessName = (toTrimmedString(resolvedBusiness?.name) || 'Handy POS').toUpperCase();
  const businessNameLength = businessName.replace(/\s+/g, '').length;
  const branchName = toTrimmedString(activeBranch?.name);
  const businessPhone = toTrimmedString(resolvedBusiness?.phone);
  const businessEmail = toTrimmedString(resolvedBusiness?.email);
  const businessTin = toTrimmedString(
    (resolvedBusiness as any)?.tin ??
    (resolvedBusiness as any)?.taxPin ??
    (resolvedBusiness as any)?.tax_pin
  );
  const branchCity =
    toTrimmedString((activeBranch as any)?.city) ||
    toTrimmedString((activeBranch as any)?.mra_device_location) ||
    toTrimmedString((activeBranch as any)?.mraDeviceLocation);
  const branchOfficeLine = branchCity
    ? (branchCity.toUpperCase().includes('MTO') ? branchCity.toUpperCase() : `${branchCity.toUpperCase()} MTO`)
    : 'BLANTYRE MTO';

  const rawOrderNumber = toTrimmedString((order as any).orderNumber ?? (order as any).order_number);
  const fiscalInvoiceNumber = toTrimmedString(
    (order as any).fiscalInvoiceNumber ?? (order as any).fiscal_invoice_number
  );
  const localReceiptNumber = explicitLocalReceiptNumber || generatedLocalReceiptNumber;
  const receiptNumber = fiscalMode
    ? fiscalInvoiceNumber || rawOrderNumber || '-'
    : localReceiptNumber || rawOrderNumber || '-';
  const orderDateRaw = toTrimmedString((order as any).createdAt ?? (order as any).created_at);
  const parsedOrderDate = orderDateRaw ? new Date(orderDateRaw) : new Date();
  const orderDate = Number.isNaN(parsedOrderDate.getTime()) ? new Date() : parsedOrderDate;
  const buyerName = resolveBuyerField(
    (order as any).customerName,
    (order as any).customer_name,
    (order as any).buyerName,
    (order as any).buyer_name
  );
  const buyerTin = resolveBuyerField(
    (order as any).customerTin,
    (order as any).customer_tin,
    (order as any).buyerTin,
    (order as any).buyer_tin
  );
  const fiscalBuyerName = buyerName || 'WALK-IN CUSTOMER';
  const fiscalBuyerTin = buyerTin || 'N/A';
  const eisStatus = toTrimmedString((order as any).eisStatus ?? (order as any).eis_status).toUpperCase() || 'PENDING';
  const eisUuid = toTrimmedString((order as any).eisUuid ?? (order as any).eis_uuid);
  const digitalSignature = toTrimmedString(
    (order as any).digitalSignature ?? (order as any).digital_signature
  );

  const orderItems = Array.isArray((order as any).items) ? (order as any).items : [];
  const legalItems = buildLegalItems(orderItems);
  const itemVatTotal = legalItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const normalizedOrderNet = toFiniteNumber(
    (order as any).netAmount ?? (order as any).net_amount,
    toFiniteNumber(order.subtotal, 0)
  );
  const normalizedOrderVat = toFiniteNumber(
    (order as any).vatAmount ?? (order as any).vat_amount ?? (order as any).tax,
    itemVatTotal
  );
  const normalizedOrderTotal = toFiniteNumber(
    (order as any).total ?? (order as any).grossAmount ?? (order as any).gross_amount,
    normalizedOrderNet + normalizedOrderVat
  );
  const tipAmount = Math.max(0, toFiniteNumber((order as any).tip, 0));
  const fallbackTaxRate = toFiniteNumber(
    (order as any).taxRateValue ?? (order as any).tax_rate_value,
    normalizedOrderNet > 0 && normalizedOrderVat > 0
      ? (normalizedOrderVat / normalizedOrderNet) * 100
      : 0
  );
  const taxBuckets = buildTaxBuckets(
    legalItems,
    normalizedOrderNet,
    itemVatTotal > 0 ? itemVatTotal : normalizedOrderVat,
    fallbackTaxRate
  );
  const levyBuckets = buildLevyBuckets(order);
  const receiptVatTotal =
    taxBuckets.reduce((sum, bucket) => sum + bucket.vatAmount, 0) || normalizedOrderVat;
  const explicitChangeAmount = toOptionalFiniteNumber(
    (order as any).change ??
    (order as any).changeAmount ??
    (order as any).change_amount
  );
  const tenderedAmount = toOptionalFiniteNumber(
    (order as any).amountTendered ??
    (order as any).amount_tendered ??
    (order as any).amountReceived ??
    (order as any).amount_received ??
    (order as any).cashPaid ??
    (order as any).cash_paid
  );
  const amountTendered = tenderedAmount !== null && tenderedAmount > 0
    ? tenderedAmount
    : normalizedOrderTotal;
  const changeAmount = explicitChangeAmount !== null
    ? explicitChangeAmount
    : Math.max(0, amountTendered - normalizedOrderTotal);

  const explicitVatRegistered = resolveBoolean(
    (resolvedBusiness as any)?.vat_registered ??
    (resolvedBusiness as any)?.vatRegistered ??
    (resolvedBusiness as any)?.mra_taxpayer_type
  );
  const isVatRegistered = explicitVatRegistered ?? receiptVatTotal > 0;

  const resolvedQrPayload = resolveQrPayload(
    (order as any).qrCodePayload ?? (order as any).qr_code_payload
  );
  const fallbackCompliancePayload = [
    'MRA-EIS',
    `RECEIPT:${receiptNumber}`,
    `ORDER:${rawOrderNumber || '-'}`,
    `TIN:${businessTin || 'N/A'}`,
    `STATUS:${eisStatus}`,
    `UUID:${eisUuid || 'N/A'}`,
    `TOTAL:${normalizedOrderTotal.toFixed(2)}`,
    `DATE:${orderDate.toISOString()}`,
    `SIG:${digitalSignature || 'N/A'}`,
  ].join('|');
  const qrPayload =
    resolvedQrPayload && resolvedQrPayload.length <= 512
      ? resolvedQrPayload
      : fiscalMode
        ? ''
        : fallbackCompliancePayload;

  const resolvedPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm';
  const isCompactPaper = resolvedPaperWidth === '58mm';
  const sheetWidth = isCompactPaper ? '218px' : '300px';
  const fontSize = `${normalizeReceiptFontSize(receiptFontSize, resolvedPaperWidth)}px`;
  const fontWeight = normalizeReceiptFontWeight(receiptFontWeight);
  const lineHeight = normalizeReceiptLineHeight(receiptLineHeight);
  const horizontalPadding = normalizeReceiptPaddingX(receiptPaddingX, resolvedPaperWidth);
  const defaultHorizontalPadding = getDefaultReceiptPaddingX(resolvedPaperWidth);
  const printPaddingXmm = Number(
    (
      horizontalPadding *
      (isCompactPaper ? 5 / defaultHorizontalPadding : 6 / defaultHorizontalPadding)
    ).toFixed(2)
  );
  const textMinHeight = `${Math.max(1, lineHeight - 0.06).toFixed(2)}em`;
  const lineWidth = isCompactPaper ? 32 : 38;
  const dotRule = '.'.repeat(lineWidth);
  const qrPixelSize = normalizeReceiptQRCodeSize(receiptQrCodeSize, resolvedPaperWidth);
  const fallbackBusinessNameFontSize = isCompactPaper
    ? businessNameLength > 18 ? 13 : 15
    : businessNameLength > 22 ? 15 : businessNameLength > 18 ? 16 : 18;
  const fallbackBusinessNameScale = businessNameLength > 22 ? 1.02 : businessNameLength > 18 ? 1.12 : 1.28;
  const businessNameFontSize = normalizeReceiptBusinessNameFontSize(
    receiptBusinessNameFontSize ?? fallbackBusinessNameFontSize,
    resolvedPaperWidth
  );
  const businessNameWeight = normalizeReceiptFontWeight(receiptBusinessNameFontWeight ?? 400);
  const businessNameScale = normalizeReceiptTextScaleX(
    receiptBusinessNameScaleX,
    fallbackBusinessNameScale
  );
  const legalMarkerFontSize = normalizeReceiptLegalMarkerFontSize(
    receiptLegalMarkerFontSize,
    resolvedPaperWidth
  );
  const headerDetailScale = normalizeReceiptTextScaleX(receiptHeaderDetailScaleX, 1);
  const legalMarkerWeight = normalizeReceiptFontWeight(receiptLegalMarkerFontWeight);
  const legalMarkerScale = normalizeReceiptTextScaleX(receiptLegalMarkerScaleX, 1);
  const businessNameMaxWidth = `${Math.floor(100 / businessNameScale)}%`;
  const headerDetailMaxWidth = `${Math.floor(100 / headerDetailScale)}%`;
  const legalMarkerMaxWidth = `${Math.floor(100 / legalMarkerScale)}%`;
  const qrCodeUrl =
    `https://api.qrserver.com/v1/create-qr-code/?size=${qrPixelSize}x${qrPixelSize}&ecc=M&margin=0&data=${encodeURIComponent(qrPayload)}`;
  const shouldShowHeader = showHeader;
  // Fiscal output must contain MRA evidence even when ordinary printer
  // preferences hide tax or QR details. Those preferences apply to normal
  // receipts only.
  const shouldShowTaxBreakdown = fiscalMode;
  const shouldShowQRCode = fiscalMode && Boolean(qrPayload);
  const shouldShowFooter = showFooter;
  const startMarker = fiscalMode ? '*** START OF LEGAL RECEIPT ***' : '*** START OF RECEIPT ***';
  const endMarker = fiscalMode ? '*** END OF LEGAL RECEIPT ***' : '*** END OF RECEIPT ***';

  void currencyFormatter;

  return (
    <div id={rootId}>
      <style>{`
        .receipt2-sheet {
          width: ${sheetWidth};
          box-sizing: border-box;
          margin: 0 auto;
          padding: ${isCompactPaper ? 10 : 12}px ${horizontalPadding}px ${isCompactPaper ? 46 : 56}px;
          background: #fff;
          color: #000;
          font-family: "Courier New", "Liberation Mono", "Lucida Console", monospace;
          font-size: ${fontSize};
          font-weight: ${fontWeight};
          line-height: ${lineHeight};
          letter-spacing: 0;
        }
        .receipt2-line,
        .receipt2-center,
        .receipt2-row {
          width: 100%;
          min-height: ${textMinHeight};
          white-space: nowrap;
        }
        .receipt2-center {
          text-align: center;
        }
        .receipt2-legal-marker {
          display: inline-block;
          max-width: ${legalMarkerMaxWidth};
          overflow: hidden;
          text-overflow: clip;
          font-size: ${legalMarkerFontSize}px;
          font-weight: ${legalMarkerWeight};
          line-height: 1.05;
          white-space: nowrap;
          transform: scaleX(${legalMarkerScale});
          transform-origin: center center;
        }
        .receipt2-business {
          margin: 5px 0 2px;
          text-align: center;
          line-height: 1;
          text-transform: none;
          overflow: visible;
          white-space: nowrap;
        }
        .receipt2-business-text {
          display: inline-block;
          max-width: ${businessNameMaxWidth};
          overflow: hidden;
          text-overflow: clip;
          font-family: "Courier New", "Liberation Mono", "Lucida Console", monospace;
          font-size: ${businessNameFontSize}px;
          font-weight: ${businessNameWeight};
          line-height: 1;
          white-space: nowrap;
          transform: scaleX(${businessNameScale});
          transform-origin: center center;
        }
        .receipt2-header-detail {
          display: inline-block;
          max-width: ${headerDetailMaxWidth};
          overflow: hidden;
          text-overflow: clip;
          white-space: nowrap;
          transform: scaleX(${headerDetailScale});
          transform-origin: center center;
        }
        .receipt2-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) max-content;
          column-gap: 8px;
          align-items: start;
        }
        .receipt2-row span:first-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: clip;
        }
        .receipt2-row span:last-child {
          text-align: right;
        }
        .receipt2-option {
          padding-left: 8px;
          font-size: ${Math.max(8, Number.parseFloat(fontSize) - 2)}px;
          min-height: ${textMinHeight};
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .receipt2-break {
          height: 8px;
        }
        .receipt2-rule {
          overflow: hidden;
          white-space: nowrap;
          line-height: 1;
          margin: 4px 0 3px;
        }
        .receipt2-qr-wrap {
          display: flex;
          justify-content: center;
          margin: ${isCompactPaper ? '18px 0 8px' : '22px 0 10px'};
        }
        .receipt2-qr {
          width: ${qrPixelSize}px;
          height: ${qrPixelSize}px;
          image-rendering: pixelated;
        }
        .receipt2-copy {
          margin-top: 2px;
        }
        .receipt2-strong {
          font-weight: 800;
        }
        .receipt2-bottom-space {
          height: ${isCompactPaper ? 46 : 58}px;
        }
        @media print {
          @page {
            size: ${resolvedPaperWidth} auto;
            margin: 0;
          }
          html,
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
          .receipt2-sheet {
            width: ${resolvedPaperWidth};
            margin: 0 auto !important;
            padding: 2mm ${printPaddingXmm}mm ${isCompactPaper ? 16 : 18}mm !important;
          }
        }
      `}</style>

      <div
        className="receipt2-sheet"
        data-receipt-business-name-font-size={businessNameFontSize}
        data-receipt-business-name-font-weight={businessNameWeight}
        data-receipt-business-name-scale-x={businessNameScale}
        data-receipt-header-detail-scale-x={headerDetailScale}
        data-receipt-legal-marker-font-size={legalMarkerFontSize}
        data-receipt-legal-marker-font-weight={legalMarkerWeight}
        data-receipt-legal-marker-scale-x={legalMarkerScale}
        data-receipt-qr-code-size={qrPixelSize}
      >
        <div className="receipt2-center">
          <span className="receipt2-legal-marker">{startMarker}</span>
        </div>
        <div className="receipt2-break" />
        {copyNumber > 1 && (
          <div className="receipt2-center receipt2-copy">*** COPY #{copyNumber} ***</div>
        )}

        {shouldShowHeader && (
          <>
            <div className="receipt2-business">
              <span className="receipt2-business-text">{businessName}</span>
            </div>
            {branchName && (
              <div className="receipt2-center">
                <span className="receipt2-header-detail">{branchName.toUpperCase()}</span>
              </div>
            )}
            <div className="receipt2-center">
              <span className="receipt2-header-detail">MOB: {businessPhone || 'N/A'}</span>
            </div>
            <div className="receipt2-center">
              <span className="receipt2-header-detail">EMAIL: {businessEmail || 'N/A'}</span>
            </div>
            {fiscalMode && (
              <div className="receipt2-center">
                <span className="receipt2-header-detail">TIN: {businessTin || 'N/A'}</span>
              </div>
            )}
            <div className="receipt2-center">
              <span className="receipt2-header-detail">{branchOfficeLine}</span>
            </div>
            {fiscalMode && (
              <>
                <div className="receipt2-break" />
                <div className="receipt2-break" />
                <div className="receipt2-center">**{isVatRegistered ? 'VAT REGISTERED' : 'NON VAT REGISTERED'}**</div>
                <div className="receipt2-break" />
                <div className="receipt2-break" />
              </>
            )}
   
          </>
        )}
        
        
        {fiscalMode && (
          <>
            <div className="receipt2-line">BUYER&apos;S TIN : {fiscalBuyerTin}</div>
            <div className="receipt2-line">BUYER&apos;S NAME : {fiscalBuyerName}</div>
          </>
        )}
        <div className="receipt2-line">{fiscalMode ? 'RECEIPT NUMBER' : 'RECEIPT NO'} : {receiptNumber}</div>

        {showItemDetails && (
          <>
            <div className="receipt2-rule">{dotRule}</div>
            {legalItems.map((item) => (
              <React.Fragment key={item.id}>
                <div className="receipt2-line">
                  {formatQuantity(item.quantity)} X {formatAmount(item.unitPrice)}
                </div>
                <LegalRow
                  left={item.name}
                  right={formatAmount(item.grossAmount)}
                />
                {item.optionLines.map((line, index) => (
                  <div className="receipt2-option" key={`${item.id}-option-${index}`}>
                    + {line.toUpperCase()}
                  </div>
                ))}
              </React.Fragment>
            ))}
          </>
        )}
        
      

        {shouldShowTaxBreakdown && (
          <>
            <div className="receipt2-rule">{dotRule}</div>
            {taxBuckets.map((bucket) => {
              const rateLabel = formatQuantity(bucket.rate);
              return (
                <React.Fragment key={`${bucket.category}-${bucket.rate}`}>
                  <LegalRow
                    left={`TAXABLE ${bucket.category}-${rateLabel}%`}
                    right={formatAmount(bucket.taxableAmount)}
                  />
                  <LegalRow
                    left={`VAT ${bucket.category}=${rateLabel}%`}
                    right={formatAmount(bucket.vatAmount)}
                  />
                </React.Fragment>
              );
            })}
            <LegalRow left="TOTAL VAT" right={formatAmount(receiptVatTotal)} />
            {levyBuckets.map((levy) => (
              <LegalRow
                key={`${levy.name}-${levy.rate}`}
                left={`${levy.name.toUpperCase()} LEVY${levy.rate > 0 ? ` ${formatQuantity(levy.rate)}%` : ''}`}
                right={formatAmount(levy.amount)}
              />
            ))}
          </>
        )}
    
       

        <div className="receipt2-rule">{dotRule}</div>
        <LegalRow left="TOTAL" right={formatAmount(normalizedOrderTotal)} strong />
        {tipAmount > 0 && (
          <LegalRow left="TIP" right={formatAmount(tipAmount)} />
        )}
        <LegalRow left="AMOUNT TENDERED" right={formatAmount(amountTendered)} />
        <LegalRow left="CHANGE" right={formatAmount(changeAmount)} />
      
     

        <div className="receipt2-rule">{dotRule}</div>
        <LegalRow left="DATE" right={format(orderDate, 'dd-MM-yyyy')} />
        <LegalRow left="TIME" right={format(orderDate, 'HH:mm:ss')} />
        <div className="receipt2-rule">{dotRule}</div>
        
        <div className="receipt2-break" />

        {shouldShowQRCode && (
          <div className="receipt2-qr-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeUrl} alt="EIS QR Code" className="receipt2-qr" />
          </div>
        )}

        {shouldShowFooter && (
          <div className="receipt2-center">
            <span className="receipt2-legal-marker">{endMarker}</span>
          </div>
        )}
        <div className="receipt2-bottom-space" />
      </div>
    </div>
  );
};
