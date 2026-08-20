'use client';

import { addDays } from 'date-fns';

import { db, type Subscription } from './db';
import { authFetch } from './auth-fetch';
import { withBusinessQuery } from './subscription-api';

type SubscriptionCachePayload = {
  id?: string | number;
  business?: string | number;
  status?: string;
  account_balance?: number;
  currency_code?: string;
  daily_charge?: number;
  monthly_charge?: number;
  total_spent?: number;
  base_price_per_day?: number;
  free_trial_days?: number;
  free_trial_credits_applied?: boolean;
  free_trial_credits_amount?: number;
  free_trial_end_date?: string | null;
  enable_pos?: boolean;
  enable_inventory?: boolean;
  enable_invoicing?: boolean;
  enable_online_menu?: boolean;
  enable_online_ordering?: boolean;
  enable_kitchen?: boolean;
  enable_expense_management?: boolean;
  enable_supplier_management?: boolean;
  enable_purchases?: boolean;
  enable_low_stock_alerts?: boolean;
  enable_expiry_alerts?: boolean;
  enable_customer_management?: boolean;
  enable_reports?: boolean;
  enable_analytics?: boolean;
  enable_take_orders?: boolean;
  enable_staff_management?: boolean;
  enable_waste_management?: boolean;
  enable_stock_transfers?: boolean;
  enable_stock_audits?: boolean;
  enable_tax_management?: boolean;
  enable_multi_branch?: boolean;
  enable_usage_limits?: boolean;
  low_balance_threshold?: number;
  low_balance_notified?: boolean;
  low_balance_notified_date?: string | null;
  enabled_features?: SubscriptionCacheFeaturePayload[];
  start_date?: string | null;
  last_payment_date?: string | null;
  last_billing_date?: string | null;
  last_charge_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type SubscriptionCacheFeaturePayload = {
  feature?: string;
  feature_id?: number;
  feature_name?: string;
  enabled?: boolean;
  included?: boolean;
};

type FetchCurrentSubscriptionOptions = {
  force?: boolean;
  maxAgeMs?: number;
};

type CurrentSubscriptionSnapshot = {
  data: SubscriptionCachePayload;
  fetchedAt: number;
};

const DEFAULT_CURRENT_SUBSCRIPTION_MAX_AGE_MS = 60_000;
const CURRENT_SUBSCRIPTION_DEFAULT_KEY = '__current__';
const currentSubscriptionSnapshots = new Map<string, CurrentSubscriptionSnapshot>();
const inFlightCurrentSubscriptionRequests = new Map<string, Promise<SubscriptionCachePayload>>();

const resolveBusinessId = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (value && typeof value === 'object') {
    const maybeId = (value as { id?: string | number }).id;
    if (typeof maybeId === 'string' || typeof maybeId === 'number') {
      return String(maybeId).trim();
    }
  }

  return '';
};

const normalizeBusinessKey = (businessId?: string | number | null): string =>
  resolveBusinessId(businessId) || CURRENT_SUBSCRIPTION_DEFAULT_KEY;

const resolveResponseBusinessId = (
  response?: SubscriptionCachePayload | null,
  fallbackBusinessId?: string | number | null
): string => resolveBusinessId(response?.business) || resolveBusinessId(fallbackBusinessId);

const setCurrentSubscriptionSnapshot = (
  response: SubscriptionCachePayload,
  businessId?: string | number | null
): void => {
  const fetchedAt = Date.now();
  const primaryKey = normalizeBusinessKey(businessId);

  currentSubscriptionSnapshots.set(primaryKey, {
    data: response,
    fetchedAt,
  });

  const resolvedBusinessId = resolveResponseBusinessId(response, businessId);
  if (resolvedBusinessId) {
    currentSubscriptionSnapshots.set(normalizeBusinessKey(resolvedBusinessId), {
      data: response,
      fetchedAt,
    });
  }
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toSubscriptionStatus = (value: unknown): Subscription['status'] => {
  if (value === 'paused' || value === 'cancelled') {
    return value;
  }
  return 'active';
};

const toDateString = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return fallback;
};

const toOptionalDateString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
};

const mapEnabledFeaturesForCache = (
  features: SubscriptionCacheFeaturePayload[] | undefined
): Subscription['enabledFeatures'] => {
  if (!Array.isArray(features)) {
    return undefined;
  }

  const mappedFeatures: NonNullable<Subscription['enabledFeatures']> = [];

  for (const feature of features) {
    const featureKey = String(feature?.feature || '').trim();
    if (!featureKey) {
      continue;
    }

    mappedFeatures.push({
      feature: featureKey,
      enabled: feature.enabled !== false,
      included: feature.included === true,
      featureId: typeof feature.feature_id === 'number' ? feature.feature_id : undefined,
      featureName: typeof feature.feature_name === 'string' ? feature.feature_name : undefined,
    });
  }

  return mappedFeatures;
};

export const mapSubscriptionForCache = (
  response: SubscriptionCachePayload,
  businessId: string
): Subscription => {
  const nowIso = new Date().toISOString();
  const freeTrialDays = toNumber(response.free_trial_days, 0);
  const freeTrialEndDate = toDateString(
    response.free_trial_end_date,
    addDays(new Date(), freeTrialDays).toISOString()
  );

  return {
    id: 'sub_main-business',
    businessId,
    planId: 'starter',
    status: toSubscriptionStatus(response.status),
    trialEndDate: freeTrialEndDate,
    account_balance: toNumber(response.account_balance, 0),
    total_spent: toNumber(response.total_spent, 0),
    base_price_per_day: toNumber(response.base_price_per_day, 0),
    free_trial_days: freeTrialDays,
    free_trial_credits_applied: response.free_trial_credits_applied === true,
    free_trial_credits_amount: toNumber(response.free_trial_credits_amount, 0),
    free_trial_end_date: freeTrialEndDate,
    enable_pos: response.enable_pos !== false,
    enable_inventory: response.enable_inventory !== false,
    enable_invoicing: response.enable_invoicing !== false,
    enable_online_menu: response.enable_online_menu !== false,
    enable_online_ordering: response.enable_online_ordering !== false,
    enable_kitchen: response.enable_kitchen !== false,
    enable_expense_management: response.enable_expense_management !== false,
    enable_supplier_management: response.enable_supplier_management !== false,
    enable_purchases: response.enable_purchases !== false,
    enable_low_stock_alerts: response.enable_low_stock_alerts !== false,
    enable_expiry_alerts: response.enable_expiry_alerts !== false,
    enable_customer_management: response.enable_customer_management !== false,
    enable_reports: response.enable_reports !== false,
    enable_analytics: response.enable_analytics !== false,
    enable_take_orders: response.enable_take_orders !== false,
    enable_staff_management: response.enable_staff_management !== false,
    enable_waste_management: response.enable_waste_management !== false,
    enable_stock_transfers: response.enable_stock_transfers !== false,
    enable_stock_audits: response.enable_stock_audits !== false,
    enable_tax_management: response.enable_tax_management !== false,
    enable_multi_branch: response.enable_multi_branch !== false,
    enabledFeatures: mapEnabledFeaturesForCache(response.enabled_features),
    enable_usage_limits: response.enable_usage_limits !== false,
    low_balance_threshold: toNumber(response.low_balance_threshold, 10),
    low_balance_notified: response.low_balance_notified === true,
    low_balance_notified_date: toOptionalDateString(response.low_balance_notified_date),
    start_date: toDateString(response.start_date, nowIso),
    last_payment_date: toOptionalDateString(response.last_payment_date),
    last_billing_date: toOptionalDateString(response.last_billing_date),
    last_charge_date: toOptionalDateString(response.last_charge_date),
    created_at: toDateString(response.created_at, nowIso),
    updated_at: toDateString(response.updated_at, nowIso),
  };
};

export const persistSubscriptionToCache = async (
  response: SubscriptionCachePayload | null | undefined,
  businessId?: string | number | null
): Promise<void> => {
  const resolvedBusinessId = resolveResponseBusinessId(response, businessId);
  if (!response || !resolvedBusinessId) {
    return;
  }

  setCurrentSubscriptionSnapshot(response, resolvedBusinessId);
  await db.subscriptions.put(mapSubscriptionForCache(response, resolvedBusinessId));
};

export const fetchCurrentSubscription = async (
  businessId?: string | number | null,
  options: FetchCurrentSubscriptionOptions = {}
): Promise<SubscriptionCachePayload> => {
  const cacheKey = normalizeBusinessKey(businessId);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_CURRENT_SUBSCRIPTION_MAX_AGE_MS);
  const cachedSnapshot = currentSubscriptionSnapshots.get(cacheKey);

  if (
    !options.force &&
    cachedSnapshot &&
    Date.now() - cachedSnapshot.fetchedAt < maxAgeMs
  ) {
    return cachedSnapshot.data;
  }

  const existingRequest = inFlightCurrentSubscriptionRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    const response = await authFetch.fetch<SubscriptionCachePayload>(
      withBusinessQuery('/subscription/subscriptions/current/', businessId || undefined)
    );

    await persistSubscriptionToCache(response, businessId || response.business);
    return response;
  })();

  inFlightCurrentSubscriptionRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    inFlightCurrentSubscriptionRequests.delete(cacheKey);
  }
};
