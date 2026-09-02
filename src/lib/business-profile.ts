'use client';

import { db, type Business } from '@/lib/db';
import { safeLocalStorageGetItem } from '@/lib/safe-local-storage';

const LOCAL_STORAGE_KEYS = {
  AUTH_BUSINESS: 'handy-pos-business',
  BUSINESS_SETTINGS: 'handypos-business-settings',
  BUSINESS_ID: 'handypos-business-id',
  AUTH_USER: 'handy-pos-user',
};

function parseStoredJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeBusinessId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function normalizeTin(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function getStoredBusinessTin(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const settings = parseStoredJson<{ tin?: unknown; tax_pin?: unknown; taxPin?: unknown }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS)
  );
  return (
    normalizeTin(settings?.tin) ||
    normalizeTin(settings?.tax_pin) ||
    normalizeTin(settings?.taxPin)
  );
}

function getStoredAllowNegativeIngredientStock(): boolean | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const settings = parseStoredJson<{
    allowNegativeIngredientStock?: unknown;
    allow_negative_ingredient_stock?: unknown;
  }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS)
  );
  const value = settings?.allowNegativeIngredientStock ?? settings?.allow_negative_ingredient_stock;
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return value === true || value === 'true';
}

function getStoredEnableEis(): boolean | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const settings = parseStoredJson<{
    enableEis?: unknown;
    enable_eis?: unknown;
    eisEnabled?: unknown;
    eis_enabled?: unknown;
  }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS)
  );
  const value =
    settings?.enableEis ??
    settings?.enable_eis ??
    settings?.eisEnabled ??
    settings?.eis_enabled;
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return value === true || value === 'true';
}

function mergeStoredBusinessSettings(business: Business, storedTin: string): Business {
  const allowNegativeIngredientStock = getStoredAllowNegativeIngredientStock();
  const enableEis = getStoredEnableEis();
  const mergedBusiness = {
    ...business,
    ...(normalizeTin((business as any).tin) || !storedTin ? {} : { tin: storedTin }),
    ...(allowNegativeIngredientStock === undefined ? {} : { allowNegativeIngredientStock }),
    ...(enableEis === undefined ? {} : { enableEis }),
  };

  if (JSON.stringify(mergedBusiness) !== JSON.stringify(business)) {
    void db.business.put(mergedBusiness as Business);
  }

  return mergedBusiness as Business;
}

export function resolveOfflineBusinessId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const directId = normalizeBusinessId(safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BUSINESS_ID));
  if (directId) {
    return directId;
  }

  const authBusiness = parseStoredJson<{ id?: string | number }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.AUTH_BUSINESS)
  );
  const authBusinessId = normalizeBusinessId(authBusiness?.id);
  if (authBusinessId) {
    return authBusinessId;
  }

  const businessSettings = parseStoredJson<{ businessId?: string | number }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS)
  );
  const settingsBusinessId = normalizeBusinessId(businessSettings?.businessId);
  if (settingsBusinessId) {
    return settingsBusinessId;
  }

  const authUser = parseStoredJson<{ businessId?: string | number }>(
    safeLocalStorageGetItem(LOCAL_STORAGE_KEYS.AUTH_USER)
  );
  const authUserBusinessId = normalizeBusinessId(authUser?.businessId);
  if (authUserBusinessId) {
    return authUserBusinessId;
  }

  return null;
}

export async function getOfflineBusinessProfile(): Promise<Business | null> {
  const storedTin = getStoredBusinessTin();
  const businessId = resolveOfflineBusinessId();
  if (businessId) {
    const business = await db.business.get(businessId);
    if (business) {
      return mergeStoredBusinessSettings(business, storedTin);
    }
  }

  const legacyBusiness = await db.business.get('main-business');
  if (legacyBusiness) {
    return mergeStoredBusinessSettings(legacyBusiness, storedTin);
  }

  const anyBusiness = await db.business.toCollection().first();
  return anyBusiness ? mergeStoredBusinessSettings(anyBusiness, storedTin) : null;
}
