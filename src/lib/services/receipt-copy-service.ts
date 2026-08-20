'use client';

const RECEIPT_PRINT_COUNT_STORAGE_KEY = 'handypos-receipt-print-counts-v1';

type ReceiptPrintCountMap = Record<string, number>;

const normalizeOrderId = (orderId?: string | null): string => {
  return String(orderId ?? '').trim();
};

const readPrintCountMap = (): ReceiptPrintCountMap => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = localStorage.getItem(RECEIPT_PRINT_COUNT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ReceiptPrintCountMap;
  } catch (error) {
    console.warn('[ReceiptCopy] Failed to read print count map:', error);
    return {};
  }
};

const writePrintCountMap = (map: ReceiptPrintCountMap): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(RECEIPT_PRINT_COUNT_STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.warn('[ReceiptCopy] Failed to persist print count map:', error);
  }
};

const toNonNegativeInt = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

export const getReceiptPrintCount = (orderId?: string | null): number => {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return 0;

  const map = readPrintCountMap();
  return toNonNegativeInt(map[normalizedOrderId]);
};

export const getNextReceiptCopyNumber = (orderId?: string | null): number => {
  return getReceiptPrintCount(orderId) + 1;
};

export const markReceiptPrinted = (orderId?: string | null, copiesPrinted: number = 1): number => {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return 0;

  const copies = Math.max(1, toNonNegativeInt(copiesPrinted));
  const map = readPrintCountMap();
  const currentCount = toNonNegativeInt(map[normalizedOrderId]);
  const newCount = currentCount + copies;
  map[normalizedOrderId] = newCount;
  writePrintCountMap(map);
  return newCount;
};
