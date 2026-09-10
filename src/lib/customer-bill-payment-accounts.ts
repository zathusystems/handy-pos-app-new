'use client';

import { safeLocalStorageGetItem } from '@/lib/safe-local-storage';

export const CUSTOMER_BILL_PAYMENT_METHOD_OPTIONS = [
  'Cash',
  'Card',
  'Mobile Money',
  'Bank Transfer',
] as const;

export type CustomerBillPaymentMethod = typeof CUSTOMER_BILL_PAYMENT_METHOD_OPTIONS[number];

export type CustomerBillPaymentAccount = {
  id: string;
  method: CustomerBillPaymentMethod;
  label: string;
  accountDetails: string;
};

const BUSINESS_SETTINGS_STORAGE_KEY = 'handypos-business-settings';

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const createFallbackId = (index: number): string => `payment-account-${index + 1}`;

export const normalizeCustomerBillPaymentAccounts = (
  value: unknown
): CustomerBillPaymentAccount[] => {
  if (!Array.isArray(value)) return [];

  const allowedMethods = new Set<string>(CUSTOMER_BILL_PAYMENT_METHOD_OPTIONS);
  const seenIds = new Set<string>();

  return value.reduce<CustomerBillPaymentAccount[]>((accounts, entry, index) => {
    if (!entry || typeof entry !== 'object') return accounts;

    const raw = entry as Record<string, unknown>;
    const method = toTrimmedString(raw.method);
    const label = toTrimmedString(raw.label ?? raw.account_name ?? raw.accountName);
    const accountDetails = toTrimmedString(
      raw.accountDetails ?? raw.account_details ?? raw.account_number ?? raw.accountNumber ?? raw.instructions
    );
    const id = toTrimmedString(raw.id) || createFallbackId(index);

    if (!allowedMethods.has(method) || !label || !accountDetails || seenIds.has(id)) {
      return accounts;
    }

    seenIds.add(id);
    accounts.push({
      id,
      method: method as CustomerBillPaymentMethod,
      label,
      accountDetails,
    });
    return accounts;
  }, []);
};

export const getCustomerBillPaymentAccountsFromPayload = (
  value: unknown
): CustomerBillPaymentAccount[] => {
  if (!value || typeof value !== 'object') return [];
  const payload = value as Record<string, unknown>;
  const settings = payload.settings && typeof payload.settings === 'object'
    ? payload.settings as Record<string, unknown>
    : null;

  return normalizeCustomerBillPaymentAccounts(
    payload.customer_bill_payment_accounts ??
    payload.customerBillPaymentAccounts ??
    settings?.customer_bill_payment_accounts ??
    settings?.customerBillPaymentAccounts
  );
};

export const hasCustomerBillPaymentAccountsInPayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  const settings = payload.settings && typeof payload.settings === 'object'
    ? payload.settings as Record<string, unknown>
    : null;

  return [
    payload.customer_bill_payment_accounts,
    payload.customerBillPaymentAccounts,
    settings?.customer_bill_payment_accounts,
    settings?.customerBillPaymentAccounts,
  ].some(Array.isArray);
};

export const readCustomerBillPaymentAccounts = (): CustomerBillPaymentAccount[] => {
  if (typeof window === 'undefined') return [];

  try {
    const raw = safeLocalStorageGetItem(BUSINESS_SETTINGS_STORAGE_KEY);
    if (!raw) return [];
    return getCustomerBillPaymentAccountsFromPayload(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const serializeCustomerBillPaymentAccounts = (
  accounts: CustomerBillPaymentAccount[]
): Array<Record<string, string>> => normalizeCustomerBillPaymentAccounts(accounts).map((account) => ({
  id: account.id,
  method: account.method,
  label: account.label,
  account_details: account.accountDetails,
}));
