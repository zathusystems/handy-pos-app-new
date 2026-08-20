import { safeLocalStorageGetItem, safeLocalStorageSetItem } from './safe-local-storage';

export type LocalReceiptNumberFields = {
  localReceiptNumber: string;
  local_receipt_number: string;
  receiptNumber: string;
  receipt_number: string;
};

const STORAGE_PREFIX = 'handypos-local-receipt-number';
const RECEIPT_PREFIX = 'CrL';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const randomIndex = (max: number): number => {
  if (max <= 0) {
    return 0;
  }

  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const values = new Uint32Array(1);
    cryptoApi.getRandomValues(values);
    return values[0] % max;
  }

  return Math.floor(Math.random() * max);
};

const randomChar = (alphabet: string): string => alphabet[randomIndex(alphabet.length)] || alphabet[0];

export const generateLocalReceiptNumber = (): string => {
  const middle = `${randomChar(UPPERCASE)}${randomChar(UPPERCASE)}${randomChar(DIGITS)}${randomChar(LOWERCASE)}`;
  return `${RECEIPT_PREFIX}-${randomChar(UPPERCASE)}-${middle}-${randomChar(UPPERCASE)}`;
};

export const buildLocalReceiptNumberFields = (receiptNumber: string): LocalReceiptNumberFields => ({
  localReceiptNumber: receiptNumber,
  local_receipt_number: receiptNumber,
  receiptNumber,
  receipt_number: receiptNumber,
});

export const getOrderLocalReceiptNumber = (order: unknown): string => {
  if (!order || typeof order !== 'object') {
    return '';
  }

  const source = order as Record<string, unknown>;
  return (
    toTrimmedString(source.localReceiptNumber) ||
    toTrimmedString(source.local_receipt_number) ||
    toTrimmedString(source.receiptNumber) ||
    toTrimmedString(source.receipt_number)
  );
};

export const getLocalReceiptNumberStorageKey = (order: unknown): string => {
  if (!order || typeof order !== 'object') {
    return '';
  }

  const source = order as Record<string, unknown>;
  const id = toTrimmedString(source.id);
  if (id) {
    return `${STORAGE_PREFIX}:${id}`;
  }

  const branchId = toTrimmedString(source.branchId ?? source.branch_id ?? source.branch);
  const orderNumber = toTrimmedString(source.orderNumber ?? source.order_number);
  const createdAt = toTrimmedString(source.createdAt ?? source.created_at);
  const fallbackKey = [branchId, orderNumber, createdAt].filter(Boolean).join(':');
  return fallbackKey ? `${STORAGE_PREFIX}:${fallbackKey}` : '';
};

export const getOrCreateLocalReceiptNumberFromStorageKey = (
  storageKey: string,
  explicitReceiptNumber?: string
): string => {
  if (explicitReceiptNumber) {
    return explicitReceiptNumber;
  }

  if (storageKey) {
    const storedReceiptNumber = toTrimmedString(safeLocalStorageGetItem(storageKey));
    if (storedReceiptNumber) {
      return storedReceiptNumber;
    }
  }

  const generatedReceiptNumber = generateLocalReceiptNumber();
  if (storageKey) {
    safeLocalStorageSetItem(storageKey, generatedReceiptNumber);
  }
  return generatedReceiptNumber;
};

export const getOrCreateLocalReceiptNumber = (order: unknown): string => {
  return getOrCreateLocalReceiptNumberFromStorageKey(
    getLocalReceiptNumberStorageKey(order),
    getOrderLocalReceiptNumber(order)
  );
};

export const withLocalReceiptNumber = <T extends object>(order: T): T & LocalReceiptNumberFields => {
  const receiptNumber = getOrCreateLocalReceiptNumber(order);
  return {
    ...order,
    ...buildLocalReceiptNumberFields(receiptNumber),
  };
};
