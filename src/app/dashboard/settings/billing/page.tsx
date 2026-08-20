'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Loader2,
  AlertCircle,
  Calendar,
  CreditCard,
  DollarSign,
  ExternalLink,
  Plus,
  RefreshCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { authFetch } from '@/lib/auth-fetch';
import { buildSubscriptionBillingUrl } from '@/lib/frontend-flags';
import { persistSubscriptionToCache } from '@/lib/subscription-cache';
import { withBusinessPayload, withBusinessQuery } from '@/lib/subscription-api';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { isTauriApp } from '@/lib/tauri-init';

interface SubscriptionData {
  id: number;
  business: number;
  status: string;
  account_balance: number;
  total_spent: number;
  base_price_per_day: number;
  daily_charge: number;
  monthly_charge: number;
  last_payment_date: string | null;
  last_billing_date: string | null;
  last_charge_date?: string | null;
  start_date: string;
  created_at: string;
  updated_at: string;
  currency_code?: string;
  free_trial_days?: number;
  free_trial_credits_applied?: boolean;
  free_trial_credits_amount?: number;
  free_trial_end_date?: string | null;
  is_free_trial_active?: boolean;
  free_trial_days_remaining?: number;
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
}

interface Deposit {
  id: number;
  deposit_id: string;
  amount: number;
  credited_amount?: number | null;
  bonus_credit_amount?: number | null;
  funding_period?: string;
  status: string;
  payment_method: string;
  transaction_id?: string | null;
  payment_proof?: string;
  requested_date: string;
  completed_date: string | null;
}

interface PaymentMethod {
  id: number;
  currency: string;
  payment_method: string;
  payment_method_display: string;
  is_enabled: boolean;
  display_order: number;
}

interface BankTransferDetails {
  id: number;
  currency: string;
  account_holder: string;
  bank_name: string;
  account_number: string;
  routing_number: string;
  swift_code: string;
  iban: string;
  instructions: string;
}

interface MobileMoneyProvider {
  id: number;
  provider: string;
  is_enabled: boolean;
  account_number: string;
  account_name: string;
  instructions: string;
  display_order: number;
}

interface Feature {
  id: number;
  feature: string;
  feature_display: string;
  price_per_day: number;
  default_price_per_day?: number;
  description: string;
  is_active?: boolean;
  is_premium?: boolean;
}

interface SubscriptionFeature {
  id: number;
  feature: number;
  feature_id: number;
  feature_name: string;
  feature_price: number;
  enabled: boolean;
  enabled_date: string;
}

interface PaymentGatewayConfig {
  provider: string;
  display_name: string;
  is_active: boolean;
  environment: string;
  checkout_flow: string;
  default_currency: string;
  payment_title: string;
  payment_description: string;
  is_ready: boolean;
}

interface SubscriptionPaymentAttempt {
  id: number;
  provider: string;
  deposit: number;
  deposit_reference: string;
  subscription: number;
  business: number;
  tx_ref: string;
  checkout_url: string;
  amount: number;
  credited_amount?: number | null;
  currency: string;
  funding_period?: string;
  status: string;
  provider_reference?: string;
  callback_status?: string;
  last_error?: string;
  paid_at?: string | null;
  verified_at?: string | null;
  deposit_status?: string;
  created_at: string;
  updated_at: string;
}

type FundingPlanId = 'monthly' | 'quarterly' | 'semiannual' | 'yearly' | 'custom';

interface FundingPlanPreset {
  id: Exclude<FundingPlanId, 'custom'>;
  label: string;
  description: string;
  days: number;
  discountRate: number;
}

interface FundingPlanQuote extends FundingPlanPreset {
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
}

interface FundingPricingQuote {
  funding_period: Exclude<FundingPlanId, 'custom'> | 'custom';
  days: number;
  discount_rate: number;
  daily_charge: number;
  base_amount: number;
  credit_amount: number;
  discount_amount: number;
  bonus_credit_amount: number;
  final_amount: number;
  minimum_custom_amount: number;
}

interface SubscriptionFundingPricingResponse {
  currency: string;
  daily_charge: number;
  minimum_custom_amount: number;
  quotes: FundingPricingQuote[];
}

interface SystemConfigResponse {
  minimum_deposit_amount?: number;
}

interface PaginatedCollection<T> {
  items: T[];
  count: number;
  next: string | null;
  previous: string | null;
  totalPages: number;
  currentPage: number;
}

const MONTHLY_BILLING_DAYS = 30;
const DEPOSITS_PAGE_SIZE = 10;
const PENDING_SUBSCRIPTION_PAYMENT_KEY = 'handypos-pending-subscription-payment';
const TERMINAL_ATTEMPT_STATUSES = new Set(['successful', 'failed', 'cancelled', 'expired']);
const ACTIVE_ATTEMPT_STATUSES = new Set(['initiated', 'pending', 'awaiting_verification']);
const DELETABLE_DEPOSIT_STATUSES = new Set(['pending', 'failed', 'cancelled']);
const FUNDING_PLAN_PRESETS: FundingPlanPreset[] = [
  {
    id: 'monthly',
    label: 'Monthly',
    description: 'Approx. 30 days of credits at today\'s rate',
    days: 30,
    discountRate: 0,
  },
  {
    id: 'quarterly',
    label: 'Quarterly',
    description: 'Approx. 90 days of credits at today\'s rate',
    days: 90,
    discountRate: 0.05,
  },
  {
    id: 'semiannual',
    label: '6 Months',
    description: 'Approx. 180 days of credits at today\'s rate',
    days: 180,
    discountRate: 0.1,
  },
  {
    id: 'yearly',
    label: 'Yearly',
    description: 'Approx. 360 days of credits at today\'s rate',
    days: 360,
    discountRate: 0.15,
  },
];

const toCurrencyAmount = (value: number): number => Math.round(value * 100) / 100;
const isFreeFeature = (feature: Feature | null | undefined): boolean =>
  Number(feature?.price_per_day ?? feature?.default_price_per_day ?? 0) <= 0;

const normalizeCollection = <T,>(response: any): T[] => {
  if (Array.isArray(response?.results)) {
    return response.results;
  }
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === 'object') {
    return [response];
  }
  return [];
};

const normalizePaginatedCollection = <T,>(
  response: any,
  requestedPage: number,
  pageSize: number
): PaginatedCollection<T> => {
  const items = normalizeCollection<T>(response);
  const count = typeof response?.count === 'number' ? response.count : items.length;
  const next = typeof response?.next === 'string' && response.next.trim() ? response.next : null;
  const previous =
    typeof response?.previous === 'string' && response.previous.trim() ? response.previous : null;

  return {
    items,
    count,
    next,
    previous,
    totalPages: Math.max(1, Math.ceil(count / Math.max(pageSize, 1))),
    currentPage: Math.max(1, requestedPage),
  };
};

const isProbablyLocalHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  );
};

export default function BillingPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { business, user } = useAuth();
  const openedFromSubscriptionGuard = searchParams.get('subscriptionGuard') === '1';
  const businessId = business?.id || user?.businessId || null;
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [depositsPage, setDepositsPage] = useState(1);
  const [depositsTotalCount, setDepositsTotalCount] = useState(0);
  const [depositsTotalPages, setDepositsTotalPages] = useState(1);
  const [depositsHasNextPage, setDepositsHasNextPage] = useState(false);
  const [depositsHasPreviousPage, setDepositsHasPreviousPage] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [bankTransferDetails, setBankTransferDetails] = useState<BankTransferDetails | null>(null);
  const [mobileMoneyProviders, setMobileMoneyProviders] = useState<MobileMoneyProvider[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [subscriptionFeatures, setSubscriptionFeatures] = useState<SubscriptionFeature[]>([]);
  const [paymentGatewayConfig, setPaymentGatewayConfig] = useState<PaymentGatewayConfig | null>(null);
  const [paymentAttempts, setPaymentAttempts] = useState<SubscriptionPaymentAttempt[]>([]);
  const [fundingPricing, setFundingPricing] = useState<SubscriptionFundingPricingResponse | null>(null);
  const [configuredMinimumDepositAmount, setConfiguredMinimumDepositAmount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isDepositsLoading, setIsDepositsLoading] = useState(false);
  const [isCreatingDeposit, setIsCreatingDeposit] = useState(false);
  const [depositIdsBeingDeleted, setDepositIdsBeingDeleted] = useState<number[]>([]);
  const [isStartingGatewayCheckout, setIsStartingGatewayCheckout] = useState(false);
  const [isVerifyingGatewayPayment, setIsVerifyingGatewayPayment] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMethod, setDepositMethod] = useState('');
  const [depositTransactionId, setDepositTransactionId] = useState('');
  const [depositNotes, setDepositNotes] = useState('');
  const [selectedFundingPlan, setSelectedFundingPlan] = useState<FundingPlanId>('monthly');
  const [showDepositDialog, setShowDepositDialog] = useState(false);
  const [showPauseDialog, setShowPauseDialog] = useState(false);
  const [showFeaturesDialog, setShowFeaturesDialog] = useState(false);
  const [hasAppliedOpenAddCredit, setHasAppliedOpenAddCredit] = useState(false);
  const [hasAppliedOpenManageFeatures, setHasAppliedOpenManageFeatures] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isUpdatingFeatures, setIsUpdatingFeatures] = useState(false);
  const [pendingCheckoutRedirectUrl, setPendingCheckoutRedirectUrl] = useState('');
  const handledGatewayReturnRef = useRef('');
  const pendingCheckoutWindowRef = useRef<Window | null>(null);
  const { format: formatCurrency, currencyCode } = useCurrency();

  const formatMoney = (value: number) => {
    const code = subscription?.currency_code || currencyCode;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
    } catch {
      return formatCurrency(value);
    }
  };

  const refreshFundingPricing = useCallback(
    async (targetBusinessId?: string | number | null) => {
      try {
        const pricingResponse = await authFetch.fetch<SubscriptionFundingPricingResponse>(
          withBusinessQuery('/payments/subscription/pricing/', targetBusinessId ?? businessId)
        );
        setFundingPricing(pricingResponse);
        return pricingResponse;
      } catch (error) {
        console.warn('[Billing] Funding pricing is unavailable, falling back to local calculations:', error);
        return null;
      }
    },
    [businessId]
  );

  const minimumDepositAmount = useMemo(() => {
    if (
      fundingPricing &&
      Number.isFinite(Number(fundingPricing.minimum_custom_amount)) &&
      Number(fundingPricing.minimum_custom_amount) > 0
    ) {
      return toCurrencyAmount(Number(fundingPricing.minimum_custom_amount));
    }

    if (Number.isFinite(configuredMinimumDepositAmount) && configuredMinimumDepositAmount > 0) {
      return toCurrencyAmount(configuredMinimumDepositAmount);
    }

    return 0;
  }, [configuredMinimumDepositAmount, fundingPricing]);

  const fundingPlanQuotes = useMemo<FundingPlanQuote[]>(() => {
    const serverQuotes = new Map(
      (fundingPricing?.quotes || []).map((quote) => [quote.funding_period, quote] as const)
    );
    const dailyCharge = Number(fundingPricing?.daily_charge ?? subscription?.daily_charge ?? 0);
    return FUNDING_PLAN_PRESETS.map((preset) => {
      const serverQuote = serverQuotes.get(preset.id);
      if (serverQuote) {
        return {
          ...preset,
          baseAmount: toCurrencyAmount(Number(serverQuote.base_amount || 0)),
          discountAmount: toCurrencyAmount(Number(serverQuote.discount_amount || 0)),
          finalAmount: toCurrencyAmount(Number(serverQuote.final_amount || 0)),
        };
      }

      const baseAmount = toCurrencyAmount(dailyCharge * preset.days);
      const discountAmount = toCurrencyAmount(baseAmount * preset.discountRate);
      return {
        ...preset,
        baseAmount,
        discountAmount,
        finalAmount: toCurrencyAmount(baseAmount - discountAmount),
      };
    });
  }, [fundingPricing?.daily_charge, fundingPricing?.quotes, subscription?.daily_charge]);

  const selectedFundingQuote = useMemo(
    () => fundingPlanQuotes.find((option) => option.id === selectedFundingPlan) || null,
    [fundingPlanQuotes, selectedFundingPlan]
  );

  const paymentGatewayReady = Boolean(paymentGatewayConfig?.is_active && paymentGatewayConfig?.is_ready);
  const hostedPaymentsEnabled = Boolean(paymentGatewayConfig?.is_active);
  const showHostedPaymentFlow = hostedPaymentsEnabled;
  const showManualPaymentFlow = !hostedPaymentsEnabled;
  const latestPaymentAttempt = paymentAttempts[0] || null;
  const activePaymentAttempt =
    paymentAttempts.find((attempt) => ACTIVE_ATTEMPT_STATUSES.has(String(attempt.status).toLowerCase())) ||
    null;
  const activePaymentDeposit = useMemo(
    () =>
      activePaymentAttempt?.deposit_reference
        ? deposits.find((deposit) => deposit.deposit_id === activePaymentAttempt.deposit_reference) || null
        : null,
    [activePaymentAttempt?.deposit_reference, deposits]
  );
  const latestPaymentDeposit = useMemo(
    () =>
      latestPaymentAttempt?.deposit_reference
        ? deposits.find((deposit) => deposit.deposit_id === latestPaymentAttempt.deposit_reference) || null
        : null,
    [deposits, latestPaymentAttempt?.deposit_reference]
  );
  const depositAmountValue = Number.parseFloat(depositAmount || '0');

  const clearGatewayReturnParams = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('tx_ref');
    nextParams.delete('reference');
    nextParams.delete('status');
    nextParams.delete('deposit_id');
    nextParams.delete('gatewayReturn');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const buildDepositsPath = useCallback(
    (page = 1) => {
      const basePath = withBusinessQuery('/subscription/deposits/', businessId);
      const [pathnamePart, queryString = ''] = basePath.split('?');
      const params = new URLSearchParams(queryString);
      params.set('page', String(page));
      params.set('page_size', String(DEPOSITS_PAGE_SIZE));
      return `${pathnamePart}?${params.toString()}`;
    },
    [businessId]
  );

  const applyDepositsResponse = useCallback((response: any, requestedPage: number) => {
    const normalizedDeposits = normalizePaginatedCollection<Deposit>(
      response,
      requestedPage,
      DEPOSITS_PAGE_SIZE
    );

    setDeposits(normalizedDeposits.items);
    setDepositsPage(normalizedDeposits.currentPage);
    setDepositsTotalCount(normalizedDeposits.count);
    setDepositsTotalPages(normalizedDeposits.totalPages);
    setDepositsHasNextPage(Boolean(normalizedDeposits.next));
    setDepositsHasPreviousPage(Boolean(normalizedDeposits.previous));
  }, []);

  const fetchDepositsPage = useCallback(
    async (page = 1) => {
      const depositsResponse = await authFetch.fetch(buildDepositsPath(page));
      applyDepositsResponse(depositsResponse, page);
    },
    [applyDepositsResponse, buildDepositsPath]
  );

  const refreshSubscriptionAndDeposits = useCallback(async (page = depositsPage) => {
    const [subResponse, depositsResponse] = await Promise.all([
      authFetch.fetch<SubscriptionData>(withBusinessQuery('/subscription/subscriptions/current/', businessId)),
      authFetch.fetch(buildDepositsPath(page)),
    ]);

    setSubscription(subResponse);
    if (subResponse) {
      await persistSubscriptionToCache(subResponse, businessId || subResponse.business);
    }
    applyDepositsResponse(depositsResponse, page);
  }, [applyDepositsResponse, buildDepositsPath, businessId, depositsPage]);

  const refreshOptionalPaymentsData = useCallback(async () => {
    try {
      const configResponse = await authFetch.fetch<PaymentGatewayConfig>('/payments/gateway/configuration/');
      setPaymentGatewayConfig(configResponse);

      try {
        const attemptsResponse = await authFetch.fetch(
          withBusinessQuery('/payments/subscription-attempts/', businessId)
        );
        const nextAttempts = normalizeCollection<SubscriptionPaymentAttempt>(attemptsResponse).sort(
          (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
        );
        setPaymentAttempts(nextAttempts);

        const latestTrackedAttempt = nextAttempts[0];
        if (
          latestTrackedAttempt &&
          TERMINAL_ATTEMPT_STATUSES.has(String(latestTrackedAttempt.status).toLowerCase())
        ) {
          localStorage.removeItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
        }
      } catch (attemptError) {
        console.warn('[Billing] Payment attempts are unavailable:', attemptError);
        setPaymentAttempts([]);
      }
    } catch (configError) {
      console.warn('[Billing] Payments gateway is unavailable, keeping manual deposit flow:', configError);
      setPaymentGatewayConfig(null);
      setPaymentAttempts([]);
      localStorage.removeItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
    }
  }, [businessId]);

  const loadBillingData = useCallback(async () => {
    setIsLoading(true);
    try {
      console.log('[Billing] Starting fresh data fetch...');

      localStorage.removeItem('subscription-features');
      sessionStorage.removeItem('subscription-features');

      const currentSubscriptionPath = withBusinessQuery('/subscription/subscriptions/current/', businessId);
      const depositsPath = buildDepositsPath(1);
      const subscriptionFeaturesPath = withBusinessQuery('/subscription/subscription-features/', businessId);
      const systemConfigPromise = authFetch
        .fetch<SystemConfigResponse>('/config/system-config/current/')
        .catch((error) => {
          console.warn('[Billing] System config is unavailable:', error);
          return null;
        });

      const [
        subResponse,
        depositsResponse,
        paymentMethodsResponse,
        bankTransferResponse,
        mobileMoneyResponse,
        featuresResponse,
        subscriptionFeaturesResponse,
        systemConfigResponse,
      ] = await Promise.all([
        authFetch.fetch<SubscriptionData>(currentSubscriptionPath),
        authFetch.fetch(depositsPath),
        authFetch.fetch('/config/payment-methods/'),
        authFetch.fetch('/config/bank-transfers/'),
        authFetch.fetch('/config/mobile-money/'),
        authFetch.fetch('/subscription/feature-pricing/'),
        authFetch.fetch(subscriptionFeaturesPath),
        systemConfigPromise,
      ]);

      setSubscription(subResponse);
      if (subResponse) {
        await persistSubscriptionToCache(subResponse, businessId || subResponse.business);
      }
      applyDepositsResponse(depositsResponse, 1);

      const businessCurrency = subResponse.currency_code || currencyCode;
      const availableMethods = normalizeCollection<PaymentMethod>(paymentMethodsResponse)
        .filter((method) => method.currency === businessCurrency && method.is_enabled)
        .sort((a, b) => a.display_order - b.display_order);
      setPaymentMethods(availableMethods);

      if (availableMethods.length > 0) {
        setDepositMethod((currentMethod) => currentMethod || availableMethods[0].payment_method);
      }

      const bankDetails = normalizeCollection<BankTransferDetails>(bankTransferResponse).find(
        (bank) => bank.currency === businessCurrency
      );
      setBankTransferDetails(bankDetails || null);

      const providers = normalizeCollection<MobileMoneyProvider>(mobileMoneyResponse)
        .filter((provider) => provider.is_enabled)
        .sort((a, b) => a.display_order - b.display_order);
      setMobileMoneyProviders(providers);

      const allFeatures = normalizeCollection<Feature>(featuresResponse).filter((feature) => feature && feature.id);
      setFeatures(allFeatures);

      const enabledFeatures = normalizeCollection<SubscriptionFeature>(subscriptionFeaturesResponse);
      const validEnabledFeatures = enabledFeatures.filter((subscriptionFeature) =>
        allFeatures.some((feature) => feature.id === subscriptionFeature.feature_id)
      );
      setSubscriptionFeatures(validEnabledFeatures);
      setConfiguredMinimumDepositAmount(
        toCurrencyAmount(Number(systemConfigResponse?.minimum_deposit_amount || 0))
      );

      if (validEnabledFeatures.length > 0) {
        localStorage.setItem('subscription-features', JSON.stringify(validEnabledFeatures));
      }

      await refreshFundingPricing(businessId || subResponse.business);
      await refreshOptionalPaymentsData();
    } catch (error) {
      console.error('Error fetching billing data:', error);
      localStorage.removeItem('subscription-features');
      sessionStorage.removeItem('subscription-features');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load billing information',
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    applyDepositsResponse,
    buildDepositsPath,
    businessId,
    currencyCode,
    refreshFundingPricing,
    refreshOptionalPaymentsData,
  ]);

  useEffect(() => {
    void loadBillingData();
  }, [loadBillingData]);

  useEffect(() => {
    if (!showDepositDialog || !subscription) {
      return;
    }

    if (selectedFundingPlan === 'custom') {
      if (!depositAmount) {
        setDepositAmount(minimumDepositAmount > 0 ? minimumDepositAmount.toFixed(2) : '');
      }
      return;
    }

    if (selectedFundingQuote) {
      setDepositAmount(selectedFundingQuote.finalAmount.toFixed(2));
    }
  }, [
    depositAmount,
    minimumDepositAmount,
    selectedFundingPlan,
    selectedFundingQuote,
    showDepositDialog,
    subscription,
  ]);

  useEffect(() => {
    if (!showDepositDialog || selectedFundingPlan === 'custom' || !selectedFundingQuote) {
      return;
    }

    if (selectedFundingQuote.finalAmount >= minimumDepositAmount) {
      return;
    }

    const nextEligibleQuote = fundingPlanQuotes.find((quote) => quote.finalAmount >= minimumDepositAmount);
    setSelectedFundingPlan(nextEligibleQuote?.id ?? 'custom');
  }, [
    fundingPlanQuotes,
    minimumDepositAmount,
    selectedFundingPlan,
    selectedFundingQuote,
    showDepositDialog,
  ]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshOptionalPaymentsData();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [refreshOptionalPaymentsData]);

  useEffect(() => {
    const shouldAutoOpenAddCredit = searchParams.get('openAddCredit') === '1';
    if (!shouldAutoOpenAddCredit || hasAppliedOpenAddCredit) {
      return;
    }

    setShowDepositDialog(true);
    setHasAppliedOpenAddCredit(true);

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('openAddCredit');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [hasAppliedOpenAddCredit, pathname, router, searchParams]);

  useEffect(() => {
    const shouldAutoOpenManageFeatures = searchParams.get('openManageFeatures') === '1';
    if (!shouldAutoOpenManageFeatures || hasAppliedOpenManageFeatures) {
      return;
    }

    setShowFeaturesDialog(true);
    setHasAppliedOpenManageFeatures(true);

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('openManageFeatures');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [hasAppliedOpenManageFeatures, pathname, router, searchParams]);

  const resolveSelectedDepositAmount = useCallback(() => {
    if (selectedFundingPlan === 'custom') {
      return toCurrencyAmount(depositAmountValue);
    }
    return toCurrencyAmount(selectedFundingQuote?.finalAmount || 0);
  }, [depositAmountValue, selectedFundingPlan, selectedFundingQuote]);

  const resolveSelectedCreditAmount = useCallback(() => {
    if (selectedFundingPlan === 'custom') {
      return toCurrencyAmount(depositAmountValue);
    }
    return toCurrencyAmount(selectedFundingQuote?.baseAmount || 0);
  }, [depositAmountValue, selectedFundingPlan, selectedFundingQuote]);

  const resolveSelectedBonusCreditAmount = useCallback(() => {
    return toCurrencyAmount(Math.max(resolveSelectedCreditAmount() - resolveSelectedDepositAmount(), 0));
  }, [resolveSelectedCreditAmount, resolveSelectedDepositAmount]);

  const validateSelectedDepositAmount = useCallback(() => {
    const resolvedAmount = resolveSelectedDepositAmount();
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      return 'Please choose a valid payment amount.';
    }

    if (resolvedAmount < minimumDepositAmount) {
      if (selectedFundingPlan === 'custom') {
        return `Custom credit payments must be at least ${formatMoney(minimumDepositAmount)}.`;
      }

      return `Payments must be at least ${formatMoney(minimumDepositAmount)}. Choose a larger bundle or switch to Custom.`;
    }

    return null;
  }, [formatMoney, minimumDepositAmount, resolveSelectedDepositAmount, selectedFundingPlan]);

  const isDepositDeletable = useCallback((deposit?: Deposit | null) => {
    if (!deposit) {
      return false;
    }

    return DELETABLE_DEPOSIT_STATUSES.has(String(deposit.status || '').toLowerCase());
  }, []);

  const buildGatewayReturnUrl = useCallback(
    (target: 'callback' | 'return') => {
      if (typeof window === 'undefined') {
        return '';
      }

      if (isTauriApp()) {
        return 'handypos://subscription-payment/{deposit_id}';
      }

      const redirectUrl = new URL(
        buildSubscriptionBillingUrl({
          openAddCredit: true,
          subscriptionGuard: openedFromSubscriptionGuard,
        }),
        window.location.origin
      );
      redirectUrl.searchParams.set('gatewayReturn', target);

      const scheme = redirectUrl.protocol.toLowerCase();
      if (scheme !== 'http:' && scheme !== 'https:') {
        return '';
      }

      if (
        paymentGatewayConfig?.environment === 'live' &&
        (scheme !== 'https:' || isProbablyLocalHost(redirectUrl.hostname))
      ) {
        return '';
      }

      return redirectUrl.toString();
    },
    [openedFromSubscriptionGuard, paymentGatewayConfig?.environment]
  );

  const openCheckoutUrl = useCallback((checkoutUrl: string, existingWindow?: Window | null) => {
    if (isTauriApp()) {
      window.location.assign(checkoutUrl);
      return;
    }

    if (existingWindow && !existingWindow.closed) {
      existingWindow.location.href = checkoutUrl;
      return;
    }

    const openedWindow = window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
      window.location.assign(checkoutUrl);
    }
  }, []);

  useEffect(() => {
    if (!pendingCheckoutRedirectUrl || showDepositDialog) {
      return;
    }

    const pendingWindow = pendingCheckoutWindowRef.current;
    const redirectTimer = window.setTimeout(() => {
      pendingCheckoutWindowRef.current = null;
      openCheckoutUrl(pendingCheckoutRedirectUrl, pendingWindow);
      setPendingCheckoutRedirectUrl('');
    }, 75);

    return () => window.clearTimeout(redirectTimer);
  }, [openCheckoutUrl, pendingCheckoutRedirectUrl, showDepositDialog]);

  const continueToCheckout = useCallback(
    (checkoutUrl: string, existingWindow?: Window | null) => {
      if (!checkoutUrl) {
        return;
      }

      if (isTauriApp() && showDepositDialog) {
        pendingCheckoutWindowRef.current = existingWindow || null;
        setPendingCheckoutRedirectUrl(checkoutUrl);
        setShowDepositDialog(false);
        return;
      }

      openCheckoutUrl(checkoutUrl, existingWindow);
      if (showDepositDialog) {
        setShowDepositDialog(false);
      }
    },
    [openCheckoutUrl, showDepositDialog]
  );

  const handleVerifyGatewayPayment = useCallback(
    async ({
      attemptId,
      txRef,
      depositId,
      clearReturnParams = false,
      successTitle = 'Payment Verified',
    }: {
      attemptId?: number;
      txRef?: string;
      depositId?: string;
      clearReturnParams?: boolean;
      successTitle?: string;
    }) => {
      if (!attemptId && !txRef && !depositId) {
        return null;
      }

      setIsVerifyingGatewayPayment(true);
      try {
        const response = await authFetch.fetch<any>('/payments/subscription/checkout/verify/', {
          method: 'POST',
          queueOnFailure: false,
          body: JSON.stringify(
            withBusinessPayload(
              {
                ...(attemptId ? { attempt_id: attemptId } : {}),
                ...(txRef ? { tx_ref: txRef } : {}),
                ...(depositId ? { deposit_id: depositId } : {}),
              },
              businessId || subscription?.business
            )
          ),
        });

        const nextAttempt: SubscriptionPaymentAttempt | undefined = response?.attempt;
        const normalizedAttemptStatus = String(nextAttempt?.status || '').toLowerCase();
        if (nextAttempt?.tx_ref) {
          if (TERMINAL_ATTEMPT_STATUSES.has(normalizedAttemptStatus)) {
            localStorage.removeItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
          } else {
            localStorage.setItem(
              PENDING_SUBSCRIPTION_PAYMENT_KEY,
              JSON.stringify({
                attemptId: nextAttempt.id,
                txRef: nextAttempt.tx_ref,
                depositId: nextAttempt.deposit_reference,
                checkoutUrl: nextAttempt.checkout_url,
              })
            );
          }
        }

        if (response?.verified) {
          await refreshSubscriptionAndDeposits(1);
          await refreshOptionalPaymentsData();
          toast({
            title: successTitle,
            description: response?.detail || 'Credits were added to your balance successfully.',
          });
        } else {
          await refreshOptionalPaymentsData();
          toast({
            title: 'Payment Pending',
            description:
              response?.detail || 'Payment has not been confirmed yet. You can try again in a moment.',
          });
        }

        return response;
      } catch (error) {
        console.error('[Billing] Failed to verify gateway payment:', error);
        toast({
          variant: 'destructive',
          title: 'Verification Failed',
          description: error instanceof Error ? error.message : 'Could not confirm your payment yet.',
        });
        return null;
      } finally {
        if (clearReturnParams) {
          clearGatewayReturnParams();
        }
        setIsVerifyingGatewayPayment(false);
      }
    },
    [
      businessId,
      clearGatewayReturnParams,
      refreshOptionalPaymentsData,
      refreshSubscriptionAndDeposits,
      subscription?.business,
    ]
  );

  useEffect(() => {
    const txRef = searchParams.get('tx_ref') || searchParams.get('reference') || '';
    const depositId = searchParams.get('deposit_id') || '';
    const gatewayReturn = searchParams.get('gatewayReturn') || '';
    const status = searchParams.get('status') || '';
    const returnKey = [txRef, depositId, gatewayReturn, status].join('::');

    if (!txRef && !depositId && !gatewayReturn && !status) {
      return;
    }
    if (!txRef && !depositId) {
      clearGatewayReturnParams();
      return;
    }
    if (handledGatewayReturnRef.current === returnKey) {
      return;
    }

    handledGatewayReturnRef.current = returnKey;
    void handleVerifyGatewayPayment({
      txRef: txRef || undefined,
      depositId: depositId || undefined,
      clearReturnParams: true,
      successTitle: status.toLowerCase() === 'success' ? 'Payment Completed' : 'Payment Checked',
    });
  }, [clearGatewayReturnParams, handleVerifyGatewayPayment, searchParams]);

  const handleStartGatewayCheckout = async () => {
    const amountError = validateSelectedDepositAmount();
    if (amountError) {
      toast({
        variant: 'destructive',
        title: 'Invalid Amount',
        description: amountError,
      });
      return;
    }

    if (!paymentGatewayReady) {
      toast({
        variant: 'destructive',
        title: 'Online Payment Unavailable',
        description: 'Hosted checkout is not configured yet. You can still submit a manual deposit below.',
      });
      return;
    }

    if (activePaymentAttempt?.checkout_url) {
      localStorage.setItem(
        PENDING_SUBSCRIPTION_PAYMENT_KEY,
        JSON.stringify({
          attemptId: activePaymentAttempt.id,
          txRef: activePaymentAttempt.tx_ref,
          depositId: activePaymentAttempt.deposit_reference,
          checkoutUrl: activePaymentAttempt.checkout_url,
        })
      );
      continueToCheckout(activePaymentAttempt.checkout_url);
      toast({
        title: 'Checkout In Progress',
        description: `You already have a payment in progress for ${formatMoney(
          Number(activePaymentAttempt.amount || 0)
        )}. Resuming that checkout instead.`,
      });
      return;
    }

    let checkoutWindow: Window | null = null;
    if (!isTauriApp()) {
      try {
        checkoutWindow = window.open('', '_blank', 'noopener,noreferrer');
      } catch {
        checkoutWindow = null;
      }
    }

    setIsStartingGatewayCheckout(true);
    try {
      const appRedirectUrl = isTauriApp() ? buildGatewayReturnUrl('callback') : '';
      const callbackUrl = !isTauriApp() ? buildGatewayReturnUrl('callback') : '';
      const returnUrl = !isTauriApp() ? buildGatewayReturnUrl('return') : '';
      const response = await authFetch.fetch<any>('/payments/subscription/checkout/start/', {
        method: 'POST',
        queueOnFailure: false,
        body: JSON.stringify(
          withBusinessPayload(
            {
              amount: resolveSelectedDepositAmount(),
              funding_period: selectedFundingPlan,
              ...(appRedirectUrl ? { app_callback_url: appRedirectUrl } : {}),
              ...(appRedirectUrl ? { app_return_url: appRedirectUrl } : {}),
              ...(callbackUrl ? { callback_url: callbackUrl } : {}),
              ...(returnUrl ? { return_url: returnUrl } : {}),
            },
            businessId || subscription?.business
          )
        ),
      });

      const nextAttempt: SubscriptionPaymentAttempt | undefined = response?.attempt;
      const nextDeposit: Deposit | undefined = response?.deposit;
      const checkoutUrl = response?.checkout_url || nextAttempt?.checkout_url || '';
      if (nextAttempt?.tx_ref) {
        localStorage.setItem(
          PENDING_SUBSCRIPTION_PAYMENT_KEY,
          JSON.stringify({
            attemptId: nextAttempt.id,
            txRef: nextAttempt.tx_ref,
            depositId: nextAttempt.deposit_reference,
            checkoutUrl,
          })
        );
      }

      if (nextDeposit) {
        void fetchDepositsPage(1);
      }

      if (checkoutUrl) {
        continueToCheckout(checkoutUrl, checkoutWindow);
      } else if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.close();
        setShowDepositDialog(false);
      } else {
        setShowDepositDialog(false);
      }
      toast({
        title: checkoutUrl ? 'Checkout Ready' : 'Checkout Pending',
        description: checkoutUrl
          ? response?.detail || 'Continue the payment in the opened checkout window.'
          : 'The payment session was created, but the checkout link is not available yet. Use Resume Checkout in a moment.',
      });

      void refreshOptionalPaymentsData();
    } catch (error) {
      if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.close();
      }

      await refreshFundingPricing(businessId || subscription?.business);
      console.error('[Billing] Failed to start gateway checkout:', error);
      toast({
        variant: 'destructive',
        title: 'Checkout Failed',
        description: error instanceof Error ? error.message : 'Could not start the hosted payment flow.',
      });
    } finally {
      setIsStartingGatewayCheckout(false);
    }
  };

  const handleResumeGatewayCheckout = useCallback(
    (attempt?: SubscriptionPaymentAttempt | null) => {
      const nextAttempt = attempt || activePaymentAttempt || latestPaymentAttempt;
      if (!nextAttempt?.checkout_url) {
        toast({
          variant: 'destructive',
          title: 'Checkout Link Missing',
          description: 'There is no active hosted checkout link to resume.',
        });
        return;
      }

      localStorage.setItem(
        PENDING_SUBSCRIPTION_PAYMENT_KEY,
        JSON.stringify({
          attemptId: nextAttempt.id,
          txRef: nextAttempt.tx_ref,
          depositId: nextAttempt.deposit_reference,
          checkoutUrl: nextAttempt.checkout_url,
        })
      );
      continueToCheckout(nextAttempt.checkout_url);
    },
    [activePaymentAttempt, continueToCheckout, latestPaymentAttempt]
  );

  const handleDeleteDeposit = useCallback(
    async (deposit: Deposit) => {
      if (!isDepositDeletable(deposit)) {
        toast({
          variant: 'destructive',
          title: 'Cannot Delete Deposit',
          description: 'Only pending, failed, or cancelled deposits can be removed.',
        });
        return;
      }

      if (depositIdsBeingDeleted.includes(deposit.id)) {
        return;
      }

      setDepositIdsBeingDeleted((current) => [...current, deposit.id]);
      try {
        await authFetch.fetch(withBusinessQuery(`/subscription/deposits/${deposit.id}/`, businessId), {
          method: 'DELETE',
        });

        try {
          const trackedAttemptRaw = localStorage.getItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
          if (trackedAttemptRaw) {
            const trackedAttempt = JSON.parse(trackedAttemptRaw);
            if (String(trackedAttempt?.depositId || '').trim() === deposit.deposit_id) {
              localStorage.removeItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
            }
          }
        } catch {
          localStorage.removeItem(PENDING_SUBSCRIPTION_PAYMENT_KEY);
        }

        const nextDepositsPage = deposits.length === 1 && depositsPage > 1 ? depositsPage - 1 : depositsPage;
        await refreshSubscriptionAndDeposits(nextDepositsPage);
        await refreshOptionalPaymentsData();
        await refreshFundingPricing(businessId || subscription?.business);

        toast({
          title: 'Deposit Deleted',
          description: 'The unfinished deposit was removed. You can start a new payment now.',
        });
      } catch (error) {
        console.error('[Billing] Failed to delete deposit:', error);
        toast({
          variant: 'destructive',
          title: 'Delete Failed',
          description: error instanceof Error ? error.message : 'Could not delete that deposit.',
        });
      } finally {
        setDepositIdsBeingDeleted((current) => current.filter((item) => item !== deposit.id));
      }
    },
    [
      businessId,
      deposits.length,
      depositsPage,
      depositIdsBeingDeleted,
      fetchDepositsPage,
      isDepositDeletable,
      refreshFundingPricing,
      refreshOptionalPaymentsData,
      refreshSubscriptionAndDeposits,
      subscription?.business,
    ]
  );

  const isTrialFeatureLockActive = Boolean(subscription?.is_free_trial_active);
  const trialFeatureLockDaysRemaining = Number(subscription?.free_trial_days_remaining || 0);
  const trialFeatureLockMessage =
    trialFeatureLockDaysRemaining > 0
      ? `Features stay selected for the free trial. You can remove them after the trial ends in ${trialFeatureLockDaysRemaining} day${trialFeatureLockDaysRemaining === 1 ? '' : 's'}. Added credits remain on your balance.`
      : 'Features stay selected while the free trial is active. Added credits remain on your balance, and feature removal opens after the trial ends.';

  const handleToggleFeature = async (
    featureId: number,
    isChecked: boolean,
  ) => {
    if (isUpdatingFeatures) {
      return;
    }

    if (!isChecked && isTrialFeatureLockActive) {
      toast({
        title: 'Trial Features Locked',
        description: trialFeatureLockMessage,
      });
      return;
    }

    setIsUpdatingFeatures(true);
    try {
      const selectedFeature = features.find((feature) => feature.id === featureId) || null;
      if (!selectedFeature) {
        throw new Error('Feature details could not be found.');
      }

      if (isFreeFeature(selectedFeature) && !isChecked) {
        toast({
          title: 'Included Feature',
          description: `${selectedFeature.feature_display} is included and cannot be disabled.`,
        });
        return;
      }

      const subscriptionFeature = subscriptionFeatures.find((sf) => sf.feature_id === featureId);

      if (isChecked && subscriptionFeature) {
        setIsUpdatingFeatures(false);
        return;
      }

      if (!isChecked && !subscriptionFeature) {
        setIsUpdatingFeatures(false);
        return;
      }

      let backendSuccess = false;
      try {
        if ((isChecked && !subscriptionFeature) || (!isChecked && subscriptionFeature)) {
          await authFetch.fetch(withBusinessQuery('/subscription/subscription-features/toggle_feature/', businessId), {
            method: 'POST',
            body: JSON.stringify(
              withBusinessPayload(
                {
                  feature: featureId,
                  enabled: isChecked,
                },
                businessId
              )
            ),
          });
          backendSuccess = true;
        }
      } catch (backendError) {
        console.error('[Feature Toggle] Backend update failed:', backendError);
        throw new Error(
          `Backend error: ${backendError instanceof Error ? backendError.message : 'Unknown error'}`
        );
      }

      if (backendSuccess) {
        const [subResponse, subscriptionFeaturesResponse] = await Promise.all([
          authFetch.fetch<SubscriptionData>(withBusinessQuery('/subscription/subscriptions/current/', businessId)),
          authFetch.fetch(withBusinessQuery('/subscription/subscription-features/', businessId)),
        ]);

        const updatedFeatures = normalizeCollection<SubscriptionFeature>(subscriptionFeaturesResponse);

        if (subResponse) {
          await persistSubscriptionToCache(subResponse, businessId || subResponse.business);
        }
        setSubscription(subResponse);
        setSubscriptionFeatures(updatedFeatures);
        await refreshFundingPricing(businessId || subResponse.business);

        toast({
          title: 'Success',
          description: `Feature ${isChecked ? 'added' : 'removed'} successfully`,
        });
        setShowFeaturesDialog(false);
      }
    } catch (error) {
      console.error('[Feature Toggle] Error updating feature:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to update feature. Backend connection required.',
      });
    } finally {
      setIsUpdatingFeatures(false);
    }
  };

  const handleCreateDeposit = async () => {
    const amountError = validateSelectedDepositAmount();
    if (amountError) {
      toast({
        variant: 'destructive',
        title: 'Invalid Amount',
        description: amountError,
      });
      return;
    }

    if (!depositMethod) {
      toast({
        variant: 'destructive',
        title: 'Payment Method Required',
        description: 'Please select a payment method',
      });
      return;
    }

    if (!depositTransactionId.trim()) {
      toast({
        variant: 'destructive',
        title: 'Transaction ID Required',
        description: 'Enter the payment transaction/reference ID used for this deposit.',
      });
      return;
    }

    setIsCreatingDeposit(true);
    try {
      await authFetch.fetch(withBusinessQuery('/subscription/deposits/', businessId), {
        method: 'POST',
        body: JSON.stringify(
          withBusinessPayload(
            {
              amount: resolveSelectedDepositAmount(),
              funding_period: selectedFundingPlan,
              payment_method: depositMethod,
              transaction_id: depositTransactionId.trim(),
              payment_proof: depositNotes.trim() || depositTransactionId.trim(),
            },
            businessId
          )
        ),
      });

      setSelectedFundingPlan('monthly');
      setDepositAmount('');
      setDepositTransactionId('');
      setDepositNotes('');
      setShowDepositDialog(false);
      toast({
        title: 'Deposit Submitted',
        description: 'Your payment proof was submitted successfully and is pending verification.',
      });

      await fetchDepositsPage(1);
    } catch (error) {
      await refreshFundingPricing(businessId || subscription?.business);
      console.error('Error creating deposit:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create deposit',
      });
    } finally {
      setIsCreatingDeposit(false);
    }
  };

  const handleDepositsPageChange = useCallback(
    async (nextPage: number) => {
      if (
        isDepositsLoading ||
        nextPage < 1 ||
        nextPage > depositsTotalPages ||
        nextPage === depositsPage
      ) {
        return;
      }

      setIsDepositsLoading(true);
      try {
        await fetchDepositsPage(nextPage);
      } catch (error) {
        console.error('[Billing] Failed to change deposit page:', error);
        toast({
          variant: 'destructive',
          title: 'Could Not Load Deposits',
          description: error instanceof Error ? error.message : 'Failed to load deposit history.',
        });
      } finally {
        setIsDepositsLoading(false);
      }
    },
    [depositsPage, depositsTotalPages, fetchDepositsPage, isDepositsLoading]
  );

  const handlePauseSubscription = async () => {
    setIsPausing(true);
    try {
      await authFetch.fetch('/subscription/subscriptions/pause/', {
        method: 'POST',
        body: JSON.stringify(withBusinessPayload({}, businessId)),
      });

      toast({
        title: 'Subscription Paused',
        description: 'Your subscription has been paused. You can resume it anytime.',
      });

      setShowPauseDialog(false);
      await refreshSubscriptionAndDeposits();
    } catch (error) {
      console.error('Error pausing subscription:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to pause subscription',
      });
    } finally {
      setIsPausing(false);
    }
  };

  const handleResumeSubscription = async () => {
    try {
      await authFetch.fetch('/subscription/subscriptions/resume/', {
        method: 'POST',
        body: JSON.stringify(withBusinessPayload({}, businessId)),
      });

      toast({
        title: 'Subscription Resumed',
        description: 'Your subscription is now active.',
      });

      await refreshSubscriptionAndDeposits();
    } catch (error) {
      console.error('Error resuming subscription:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to resume subscription',
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-600">Active</Badge>;
      case 'paused':
        return <Badge className="bg-yellow-600">Paused</Badge>;
      case 'cancelled':
        return <Badge className="bg-red-600">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getDepositStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge className="bg-yellow-600">Pending</Badge>;
      case 'completed':
        return <Badge className="bg-green-600">Completed</Badge>;
      case 'failed':
        return <Badge className="bg-red-600">Failed</Badge>;
      case 'cancelled':
        return <Badge className="bg-gray-600">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getPaymentAttemptStatusBadge = (status: string) => {
    switch (String(status).toLowerCase()) {
      case 'pending':
      case 'awaiting_verification':
      case 'initiated':
        return <Badge className="bg-yellow-600">In Progress</Badge>;
      case 'successful':
        return <Badge className="bg-green-600">Successful</Badge>;
      case 'failed':
        return <Badge className="bg-red-600">Failed</Badge>;
      case 'cancelled':
        return <Badge className="bg-gray-600">Cancelled</Badge>;
      case 'expired':
        return <Badge className="bg-gray-700">Expired</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const formatPaymentMethodLabel = (method: string) => method.replace(/_/g, ' ');

  const sortedAvailableFeatures = useMemo(
    () => [...features].sort((left, right) => left.feature_display.localeCompare(right.feature_display)),
    [features]
  );

  const enabledFeatureDetails = useMemo(
    () =>
      subscriptionFeatures
        .map((subscriptionFeature) => {
          const feature = features.find((entry) => entry.id === subscriptionFeature.feature_id);
          if (!feature) {
            return null;
          }

          return {
            feature,
            subscriptionFeature,
            isIncludedFeature: isFreeFeature(feature),
          };
        })
        .filter(
          (
            detail
          ): detail is {
            feature: Feature;
            subscriptionFeature: SubscriptionFeature;
            isIncludedFeature: boolean;
          } => Boolean(detail)
        )
        .sort((left, right) => left.feature.feature_display.localeCompare(right.feature.feature_display)),
    [features, subscriptionFeatures]
  );

  const enabledFeaturesDailyTotal = useMemo(
    () =>
      enabledFeatureDetails.reduce(
        (sum, detail) => sum + Number(detail.subscriptionFeature.feature_price || 0),
        0
      ),
    [enabledFeatureDetails]
  );

  const daysUntilInsufficientBalance =
    subscription && subscription.daily_charge > 0
      ? Math.floor(subscription.account_balance / subscription.daily_charge)
      : null;

  const depositsStartIndex =
    depositsTotalCount === 0 ? 0 : (depositsPage - 1) * DEPOSITS_PAGE_SIZE + 1;
  const depositsEndIndex =
    depositsTotalCount === 0 ? 0 : Math.min(depositsPage * DEPOSITS_PAGE_SIZE, depositsTotalCount);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <div className="grid gap-6">
        {openedFromSubscriptionGuard && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Subscription access is currently restricted. Update billing, resume the subscription,
              or add credits to restore full dashboard access.
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Billing</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <p className="mb-4 text-muted-foreground">No subscription information found.</p>
            <p className="mb-6 text-muted-foreground">Please complete the setup process.</p>
            <Button asChild>
              <Link href="/setup">Go to Setup</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {openedFromSubscriptionGuard && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Subscription access is currently restricted. Update billing, resume the subscription,
            or add credits to restore full dashboard access.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Account Balance</CardTitle>
              <CardDescription>Pay-as-you-go subscription model</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Dialog open={showDepositDialog} onOpenChange={setShowDepositDialog}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Credits
                  </Button>
                </DialogTrigger>
                <DialogContent className="scrollbar-hide max-h-[90vh] w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6">
                  <DialogHeader>
                    <DialogTitle>Add Credits to Account</DialogTitle>
                    <DialogDescription>
                      {showHostedPaymentFlow
                        ? 'Choose a credit bundle, then complete the payment in hosted checkout.'
                        : 'Choose a credit bundle, pay using your preferred method, then submit the payment proof for approval.'}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label>Credit Bundle</Label>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {fundingPlanQuotes.map((quote) => {
                          const isSelected = selectedFundingPlan === quote.id;
                          const isBelowMinimum = quote.finalAmount < minimumDepositAmount;
                          return (
                            <button
                              key={quote.id}
                              type="button"
                              onClick={() => setSelectedFundingPlan(quote.id)}
                              disabled={isBelowMinimum}
                              className={cn(
                                'rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                                isSelected
                                  ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                  : 'border-border hover:border-primary/40 hover:bg-muted/40',
                                isBelowMinimum && 'border-dashed'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-semibold">{quote.label}</p>
                                  <p className="text-xs text-muted-foreground">{quote.description}</p>
                                </div>
                                {isBelowMinimum ? (
                                  <Badge variant="outline">Below minimum</Badge>
                                ) : quote.discountAmount > 0 && (
                                  <Badge className="bg-green-600">
                                    {Math.round(quote.discountRate * 100)}% off
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-3 text-lg font-bold">Pay {formatMoney(quote.finalAmount)}</p>
                              <p className="text-xs font-medium text-foreground/80">
                                Receive {formatMoney(quote.baseAmount)} credits
                              </p>
                              {quote.discountAmount > 0 ? (
                                <p className="text-xs text-muted-foreground">
                                  Bonus credits worth {formatMoney(quote.discountAmount)}
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground">Standard bundle with no bonus credits</p>
                              )}
                              {isBelowMinimum && (
                                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                  This bundle is below the current minimum payment of {formatMoney(minimumDepositAmount)}.
                                </p>
                              )}
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() => setSelectedFundingPlan('custom')}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-colors',
                            selectedFundingPlan === 'custom'
                              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                              : 'border-border hover:border-primary/40 hover:bg-muted/40'
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold">Custom</p>
                              <p className="text-xs text-muted-foreground">
                                Choose how much to pay and receive the same amount in credits
                              </p>
                            </div>
                            <Badge variant="outline">Min {formatMoney(minimumDepositAmount)}</Badge>
                          </div>
                          <p className="mt-3 text-lg font-bold">
                            Pay{' '}
                            {depositAmountValue > 0
                              ? formatMoney(depositAmountValue)
                              : formatMoney(minimumDepositAmount)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Custom payments credit the exact amount paid.
                          </p>
                        </button>
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="amount">Amount to Pay ({subscription?.currency_code || currencyCode})</Label>
                      <div className="mt-2 flex gap-2">
                        <Input
                          id="amount"
                          type="number"
                          placeholder="0.00"
                          value={depositAmount}
                          onChange={(event) => setDepositAmount(event.target.value)}
                          step="0.01"
                          min="0"
                          readOnly={selectedFundingPlan !== 'custom'}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedFundingPlan === 'custom'
                          ? `Enter any amount from ${formatMoney(minimumDepositAmount)} and above.`
                          : selectedFundingQuote?.discountAmount
                            ? `This bundle includes a ${Math.round(
                                selectedFundingQuote.discountRate * 100
                              )}% bonus.`
                            : 'This bundle credits the same amount you pay.'}
                      </p>
                    </div>

                    <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">You Pay</p>
                        <p className="mt-1 text-lg font-semibold">{formatMoney(resolveSelectedDepositAmount())}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Credits Added</p>
                        <p className="mt-1 text-lg font-semibold">{formatMoney(resolveSelectedCreditAmount())}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Bonus Credits</p>
                        <p className="mt-1 text-lg font-semibold">
                          {formatMoney(resolveSelectedBonusCreditAmount())}
                        </p>
                      </div>
                    </div>

                    {showHostedPaymentFlow && paymentGatewayConfig && (
                      <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="flex items-center gap-2 font-semibold">
                              <CreditCard className="h-4 w-4" />
                              {paymentGatewayConfig.payment_title || 'Pay Online'}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {paymentGatewayConfig.payment_description ||
                                'Open a secure hosted checkout to pay instantly.'}
                            </p>
                          </div>
                          <Badge variant={paymentGatewayReady ? 'default' : 'outline'}>
                            {paymentGatewayReady ? paymentGatewayConfig.display_name : 'Not ready'}
                          </Badge>
                        </div>

                        {paymentGatewayReady ? (
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button
                              onClick={handleStartGatewayCheckout}
                              disabled={isStartingGatewayCheckout || isVerifyingGatewayPayment}
                              className="sm:flex-1"
                            >
                              {isStartingGatewayCheckout && (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              )}
                              {!isStartingGatewayCheckout && (
                                <ExternalLink className="mr-2 h-4 w-4" />
                              )}
                              Pay {formatMoney(resolveSelectedDepositAmount())} Online
                            </Button>
                            {activePaymentAttempt?.checkout_url && (
                              <Button
                                variant="outline"
                                onClick={() => handleResumeGatewayCheckout(activePaymentAttempt)}
                                className="sm:flex-1"
                              >
                                Resume Checkout
                              </Button>
                            )}
                            {(activePaymentAttempt || latestPaymentAttempt) && (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  const nextAttempt = activePaymentAttempt || latestPaymentAttempt;
                                  void handleVerifyGatewayPayment({
                                    attemptId: nextAttempt?.id,
                                    txRef: nextAttempt?.tx_ref,
                                    depositId: nextAttempt?.deposit_reference,
                                  });
                                }}
                                disabled={isVerifyingGatewayPayment}
                                className="sm:flex-1"
                              >
                                {isVerifyingGatewayPayment && (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                )}
                                {!isVerifyingGatewayPayment && (
                                  <RefreshCcw className="mr-2 h-4 w-4" />
                                )}
                                Check Payment Status
                              </Button>
                            )}
                            {activePaymentDeposit && isDepositDeletable(activePaymentDeposit) && (
                              <Button
                                variant="outline"
                                onClick={() => void handleDeleteDeposit(activePaymentDeposit)}
                                disabled={depositIdsBeingDeleted.includes(activePaymentDeposit.id)}
                                className="border-destructive/30 text-destructive hover:bg-destructive/10 sm:flex-1"
                              >
                                {depositIdsBeingDeleted.includes(activePaymentDeposit.id) ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="mr-2 h-4 w-4" />
                                )}
                                Delete Pending Deposit
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Alert>
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>
                              Hosted checkout is enabled but not fully configured yet. Add the gateway keys
                              and webhook settings in Payments admin to start accepting online payments.
                            </AlertDescription>
                          </Alert>
                        )}

                        {activePaymentAttempt && (
                          <div className="space-y-2 rounded-lg border border-border bg-background/80 p-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Latest hosted payment</span>
                              {getPaymentAttemptStatusBadge(activePaymentAttempt.status)}
                            </div>
                            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                              <span>
                                Paid: {formatMoney(Number(activePaymentAttempt.amount || 0))}
                              </span>
                              <span>
                                Credits:{' '}
                                {formatMoney(Number(activePaymentAttempt.credited_amount ?? activePaymentAttempt.amount ?? 0))}
                              </span>
                              <span>Reference: {activePaymentAttempt.tx_ref}</span>
                              {activePaymentAttempt.last_error && (
                                <span className="text-red-600 dark:text-red-400">
                                  {activePaymentAttempt.last_error}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {showManualPaymentFlow && (
                      <div className="flex items-center gap-3 text-xs uppercase tracking-[0.24em] text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        <span>Manual Payment Proof</span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    )}

                    {showManualPaymentFlow && (
                    <div>
                      <Label htmlFor="method">Payment Method</Label>
                      {paymentMethods.length > 0 ? (
                        <Select value={depositMethod} onValueChange={setDepositMethod}>
                          <SelectTrigger id="method">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {paymentMethods.map((method) => (
                              <SelectItem key={method.id} value={method.payment_method}>
                                {method.payment_method_display}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="rounded border border-border bg-muted/40 p-2 text-sm text-muted-foreground">
                          No manual payment methods are available for your currency right now.
                        </div>
                      )}
                    </div>
                    )}

                    {showManualPaymentFlow && depositMethod === 'stripe' && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3">
                        <p className="mb-2 text-sm font-semibold">Stripe:</p>
                        <div className="space-y-1 text-sm">
                          <p className="text-muted-foreground">
                            Use this if you already completed a Stripe payment elsewhere.
                          </p>
                          <p className="mt-2 text-muted-foreground">
                            Enter the Stripe transaction/reference ID below.
                          </p>
                        </div>
                      </div>
                    )}

                    {showManualPaymentFlow && depositMethod === 'paypal' && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3">
                        <p className="mb-2 text-sm font-semibold">PayPal:</p>
                        <div className="space-y-1 text-sm">
                          <p className="text-muted-foreground">
                            Use this if you already completed a PayPal payment elsewhere.
                          </p>
                          <p className="mt-2 text-muted-foreground">
                            Enter the PayPal transaction/reference ID below.
                          </p>
                        </div>
                      </div>
                    )}

                    {showManualPaymentFlow && depositMethod === 'bank_transfer' && bankTransferDetails && (
                      <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
                        <p className="text-sm font-semibold">Bank Transfer Details:</p>
                        <div className="space-y-2 rounded border border-border bg-card p-2 text-sm">
                          <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-muted-foreground">Account Holder:</span>
                            <span className="font-semibold">{bankTransferDetails.account_holder}</span>
                          </div>
                          <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-muted-foreground">Bank Name:</span>
                            <span className="font-semibold">{bankTransferDetails.bank_name}</span>
                          </div>
                          <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-muted-foreground">Account Number:</span>
                            <span className="break-all font-mono text-xs font-semibold sm:text-sm">
                              {bankTransferDetails.account_number}
                            </span>
                          </div>
                          {bankTransferDetails.routing_number && (
                            <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                              <span className="text-muted-foreground">Routing Number:</span>
                              <span className="break-all font-mono text-xs font-semibold sm:text-sm">
                                {bankTransferDetails.routing_number}
                              </span>
                            </div>
                          )}
                          {bankTransferDetails.swift_code && (
                            <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                              <span className="text-muted-foreground">SWIFT Code:</span>
                              <span className="break-all font-mono text-xs font-semibold sm:text-sm">
                                {bankTransferDetails.swift_code}
                              </span>
                            </div>
                          )}
                          {bankTransferDetails.iban && (
                            <div className="flex flex-col gap-1 border-b pb-2 sm:flex-row sm:items-center sm:justify-between">
                              <span className="text-muted-foreground">IBAN:</span>
                              <span className="break-all font-mono text-xs font-semibold sm:text-sm">
                                {bankTransferDetails.iban}
                              </span>
                            </div>
                          )}
                        </div>
                        {bankTransferDetails.instructions && (
                          <div className="rounded border border-border bg-muted/60 p-2">
                            <p className="mb-1 text-xs font-semibold text-muted-foreground">
                              Instructions:
                            </p>
                            <p className="text-xs">{bankTransferDetails.instructions}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {showManualPaymentFlow && depositMethod === 'mobile_money' && mobileMoneyProviders.length > 0 && (
                      <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                        <p className="mb-2 text-sm font-semibold">Mobile Money Providers:</p>
                        {mobileMoneyProviders.map((provider) => (
                          <div key={provider.id} className="rounded border border-border bg-card p-2">
                            <p className="mb-2 text-sm font-semibold">{provider.provider}</p>
                            <div className="space-y-1 text-sm">
                              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                <span className="text-muted-foreground">Account Number:</span>
                                <span className="break-all font-mono text-xs font-semibold sm:text-sm">
                                  {provider.account_number}
                                </span>
                              </div>
                              {provider.account_name && (
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                  <span className="text-muted-foreground">Account Name:</span>
                                  <span className="font-semibold">{provider.account_name}</span>
                                </div>
                              )}
                            </div>
                            {provider.instructions && (
                              <div className="mt-2 rounded border border-border bg-muted/60 p-2">
                                <p className="mb-1 text-xs font-semibold text-muted-foreground">
                                  Instructions:
                                </p>
                                <p className="text-xs">{provider.instructions}</p>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {showManualPaymentFlow && (
                    <div>
                      <Label htmlFor="transactionId">Transaction ID / Reference Number</Label>
                      <Input
                        id="transactionId"
                        placeholder="e.g. MPAM-123456789, CHRG_xxx, PAYPAL-xxx"
                        value={depositTransactionId}
                        onChange={(event) => setDepositTransactionId(event.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Required for manual deposits. Use the exact reference from your payment receipt or SMS.
                      </p>
                    </div>
                    )}

                    {showManualPaymentFlow && (
                    <div>
                      <Label htmlFor="notes">Additional Payment Details (Optional)</Label>
                      <Textarea
                        id="notes"
                        placeholder="Any extra context for verification (payer name, timestamp, etc.)"
                        value={depositNotes}
                        onChange={(event) => setDepositNotes(event.target.value)}
                        rows={3}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Optional notes to help verify your payment faster.
                      </p>
                    </div>
                    )}

                    {showManualPaymentFlow && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Manual submissions are reviewed first. Approved bundle payments add the full bundle
                        credits shown above, not just the paid amount.
                      </AlertDescription>
                    </Alert>
                    )}

                    {showManualPaymentFlow && (
                    <Button
                      onClick={handleCreateDeposit}
                      disabled={isCreatingDeposit || !depositMethod || !depositTransactionId.trim()}
                      className="w-full"
                    >
                      {isCreatingDeposit && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Submit Manual Deposit
                    </Button>
                    )}
                  </div>
                </DialogContent>
              </Dialog>

              {subscription.status === 'active' ? (
                <Dialog open={showPauseDialog} onOpenChange={setShowPauseDialog}>
                  <DialogTrigger asChild>
                    <Button variant="outline">Pause Subscription</Button>
                  </DialogTrigger>
                  <DialogContent className="w-[calc(100vw-1rem)] p-4 sm:max-w-md sm:p-6">
                    <DialogHeader>
                      <DialogTitle>Pause Subscription</DialogTitle>
                      <DialogDescription>
                        Pausing your subscription will stop all charges. You can resume anytime.
                      </DialogDescription>
                    </DialogHeader>
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        While paused, you won&apos;t have access to the system, but your data will be
                        preserved.
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <Button variant="outline" onClick={() => setShowPauseDialog(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handlePauseSubscription}
                        disabled={isPausing}
                      >
                        {isPausing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Pause Subscription
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              ) : (
                <Button onClick={handleResumeSubscription} variant="outline">
                  Resume Subscription
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-blue-100 dark:border-blue-800 dark:from-blue-950 dark:to-blue-900">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-blue-900 dark:text-blue-100">
                Current Balance
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-2xl font-bold text-blue-900 dark:text-blue-100">
                {formatMoney(subscription.account_balance)}
              </div>
              <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">Available credits</p>
            </CardContent>
          </Card>

          <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-purple-100 dark:border-purple-800 dark:from-purple-950 dark:to-purple-900">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-purple-900 dark:text-purple-100">
                Daily Charge
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-2xl font-bold text-purple-900 dark:text-purple-100">
                {formatMoney(subscription.daily_charge)}
              </div>
              <p className="mt-1 text-xs text-purple-700 dark:text-purple-300">Per day</p>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'bg-gradient-to-br border-2',
              daysUntilInsufficientBalance && daysUntilInsufficientBalance > 30
                ? 'border-green-200 from-green-50 to-green-100 dark:border-green-800 dark:from-green-950 dark:to-green-900'
                : daysUntilInsufficientBalance && daysUntilInsufficientBalance > 7
                  ? 'border-yellow-200 from-yellow-50 to-yellow-100 dark:border-yellow-800 dark:from-yellow-950 dark:to-yellow-900'
                  : 'border-red-200 from-red-50 to-red-100 dark:border-red-800 dark:from-red-950 dark:to-red-900'
            )}
          >
            <CardHeader className="pb-2">
              <CardTitle
                className={cn(
                  'text-xs font-medium',
                  daysUntilInsufficientBalance && daysUntilInsufficientBalance > 30
                    ? 'text-green-900 dark:text-green-100'
                    : daysUntilInsufficientBalance && daysUntilInsufficientBalance > 7
                      ? 'text-yellow-900 dark:text-yellow-100'
                      : 'text-red-900 dark:text-red-100'
                )}
              >
                Days Until Low Balance
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div
                className={cn(
                  'text-2xl font-bold',
                  daysUntilInsufficientBalance && daysUntilInsufficientBalance > 30
                    ? 'text-green-900 dark:text-green-100'
                    : daysUntilInsufficientBalance && daysUntilInsufficientBalance > 7
                      ? 'text-yellow-900 dark:text-yellow-100'
                      : 'text-red-900 dark:text-red-100'
                )}
              >
                {daysUntilInsufficientBalance ?? '∞'}
              </div>
              <p
                className={cn(
                  'mt-1 text-xs',
                  daysUntilInsufficientBalance && daysUntilInsufficientBalance > 30
                    ? 'text-green-700 dark:text-green-300'
                    : daysUntilInsufficientBalance && daysUntilInsufficientBalance > 7
                      ? 'text-yellow-700 dark:text-yellow-300'
                      : 'text-red-700 dark:text-red-300'
                )}
              >
                {daysUntilInsufficientBalance && daysUntilInsufficientBalance <= 7
                  ? '⚠️ Add credits soon'
                  : 'Estimated days'}
              </p>
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      {showHostedPaymentFlow &&
        paymentGatewayConfig &&
        latestPaymentAttempt &&
        String(latestPaymentAttempt.status).toLowerCase() !== 'successful' && (
          <Card className="border-primary/20">
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Payment Activity</CardTitle>
                  <CardDescription>
                    Track your latest hosted checkout and confirm it once payment is done.
                  </CardDescription>
                </div>
                {getPaymentAttemptStatusBadge(latestPaymentAttempt.status)}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Paid</p>
                  <p className="mt-1 font-semibold">
                    {formatMoney(Number(latestPaymentAttempt.amount || 0))}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Credits</p>
                  <p className="mt-1 font-semibold">
                    {formatMoney(Number(latestPaymentAttempt.credited_amount ?? latestPaymentAttempt.amount ?? 0))}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Reference</p>
                  <p className="mt-1 break-all font-mono text-xs">{latestPaymentAttempt.tx_ref}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Deposit</p>
                  <p className="mt-1 font-semibold">{latestPaymentAttempt.deposit_reference}</p>
                </div>
              </div>

              {latestPaymentAttempt.last_error && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{latestPaymentAttempt.last_error}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                {latestPaymentAttempt.checkout_url &&
                  ACTIVE_ATTEMPT_STATUSES.has(String(latestPaymentAttempt.status).toLowerCase()) && (
                    <Button
                      onClick={() => handleResumeGatewayCheckout(latestPaymentAttempt)}
                      className="sm:flex-1"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Resume Checkout
                    </Button>
                  )}
                <Button
                  variant="outline"
                  onClick={() => {
                    void handleVerifyGatewayPayment({
                      attemptId: latestPaymentAttempt.id,
                      txRef: latestPaymentAttempt.tx_ref,
                      depositId: latestPaymentAttempt.deposit_reference,
                    });
                  }}
                  disabled={isVerifyingGatewayPayment}
                  className="sm:flex-1"
                >
                  {isVerifyingGatewayPayment && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {!isVerifyingGatewayPayment && <RefreshCcw className="mr-2 h-4 w-4" />}
                  Refresh Payment Status
                </Button>
                {latestPaymentDeposit && isDepositDeletable(latestPaymentDeposit) && (
                  <Button
                    variant="outline"
                    onClick={() => void handleDeleteDeposit(latestPaymentDeposit)}
                    disabled={depositIdsBeingDeleted.includes(latestPaymentDeposit.id)}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 sm:flex-1"
                  >
                    {depositIdsBeingDeleted.includes(latestPaymentDeposit.id) ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Delete Deposit
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

      <Card>
        <CardHeader>
          <CardTitle>Subscription Status</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Status</p>
            <div className="flex items-center gap-2">
              {getStatusBadge(subscription.status)}
              <span className="text-sm font-medium capitalize">{subscription.status}</span>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Monthly Charge</p>
            <p className="text-lg font-semibold">{formatMoney(subscription.monthly_charge)}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Total Spent</p>
            <p className="text-lg font-semibold">{formatMoney(subscription.total_spent)}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Member Since</p>
            <p className="text-lg font-semibold">
              {format(parseISO(subscription.start_date), 'MMM d, yyyy')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="features" className="space-y-4">
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">Subscription Details</p>
            <p className="text-sm text-muted-foreground">
              Review enabled features, credit history, and how your daily billing is calculated.
            </p>
          </div>
          <TabsList className="grid h-auto w-full grid-cols-3 sm:inline-flex sm:w-auto">
            <TabsTrigger value="features" className="px-3 py-2 text-xs sm:text-sm">
              Features
            </TabsTrigger>
            <TabsTrigger value="deposits" className="px-3 py-2 text-xs sm:text-sm">
              Deposits
            </TabsTrigger>
            <TabsTrigger value="pricing" className="px-3 py-2 text-xs sm:text-sm">
              Pricing
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="features" className="mt-0">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Subscription Features</CardTitle>
                  <CardDescription>
                    {enabledFeatureDetails.length > 0
                      ? `${enabledFeatureDetails.length} feature${
                          enabledFeatureDetails.length !== 1 ? 's' : ''
                        } enabled`
                      : 'No features enabled yet'}
                  </CardDescription>
                </div>
                <Dialog open={showFeaturesDialog} onOpenChange={setShowFeaturesDialog}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Plus className="mr-2 h-4 w-4" />
                      Manage Features
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="scrollbar-hide max-h-[90vh] w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6">
                    <DialogHeader>
                      <DialogTitle>Manage Subscription Features</DialogTitle>
                      <DialogDescription>
                        Enable or disable features to customize your subscription. Each feature has its own
                        daily charge.
                      </DialogDescription>
                    </DialogHeader>
                    {isTrialFeatureLockActive && (
                      <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{trialFeatureLockMessage}</AlertDescription>
                      </Alert>
                    )}
                    <div className="space-y-4">
                      {sortedAvailableFeatures.length === 0 ? (
                        <p className="py-8 text-center text-muted-foreground">No features available</p>
                      ) : (
                        <div className="space-y-3">
                          {sortedAvailableFeatures.map((feature) => {
                            const isEnabled = subscriptionFeatures.some(
                              (subscriptionFeature) =>
                                subscriptionFeature.feature_id === feature.id && subscriptionFeature.enabled
                            );
                            const isIncludedFeature = isFreeFeature(feature);
                            const isTrialLockedEnabledFeature = isTrialFeatureLockActive && isEnabled;
                            return (
                              <div
                                key={feature.id}
                                className={cn(
                                  'flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors',
                                  isEnabled || isIncludedFeature
                                    ? 'border-primary/20 bg-primary/5'
                                    : 'border-border bg-card hover:bg-muted/40'
                                )}
                              >
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold">{feature.feature_display}</p>
                                    {feature.is_premium && <Badge variant="secondary">Premium</Badge>}
                                    {isIncludedFeature && (
                                      <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                                        Included
                                      </Badge>
                                    )}
                                  </div>
                                  {feature.description && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {feature.description}
                                    </p>
                                  )}
                                  <p
                                    className={cn(
                                      'mt-2 text-sm font-medium',
                                      isIncludedFeature
                                        ? 'text-emerald-700 dark:text-emerald-300'
                                        : 'text-foreground'
                                    )}
                                  >
                                    {isIncludedFeature
                                      ? `Included (${formatMoney(
                                          feature.price_per_day || feature.default_price_per_day || 0
                                        )} / day)`
                                      : `${formatMoney(
                                          feature.price_per_day || feature.default_price_per_day || 0
                                        )} / day`}
                                  </p>
                                </div>
                                <div className="ml-4 flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={isIncludedFeature || isEnabled}
                                    onChange={(event) => handleToggleFeature(feature.id, event.target.checked)}
                                    disabled={
                                      isUpdatingFeatures ||
                                      isIncludedFeature ||
                                      isTrialLockedEnabledFeature
                                    }
                                    className="h-5 w-5 cursor-pointer rounded disabled:cursor-not-allowed"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="mt-6 rounded-lg bg-muted p-4">
                      <p className="mb-2 text-sm font-semibold">Current Daily Charge:</p>
                      <p className="text-2xl font-bold">
                        {subscription && formatMoney(subscription.daily_charge)}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        This includes the base subscription fee plus all enabled features.
                      </p>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {enabledFeatureDetails.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-muted-foreground">No features enabled yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {enabledFeatureDetails.map(({ feature, subscriptionFeature, isIncludedFeature }) => (
                      <div
                        key={subscriptionFeature.id}
                        className={cn(
                          'flex flex-col gap-3 rounded-xl border p-4 transition-colors sm:flex-row sm:items-start sm:justify-between',
                          isIncludedFeature
                            ? 'border-emerald-500/20 bg-emerald-500/10'
                            : 'border-primary/20 bg-primary/5'
                        )}
                      >
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-semibold">{feature.feature_display}</p>
                            {feature.is_premium && <Badge variant="secondary">Premium</Badge>}
                          </div>
                          {feature.description && (
                            <p className="text-sm text-muted-foreground">{feature.description}</p>
                          )}
                        </div>
                        <div className="flex min-w-fit flex-col items-start gap-1 sm:items-end">
                          <Badge
                            className={cn(
                              isIncludedFeature
                                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'border-primary/20 bg-primary/10 text-primary'
                            )}
                          >
                            {isIncludedFeature ? 'Included' : 'Enabled'}
                          </Badge>
                          <span
                            className={cn(
                              'text-sm font-medium',
                              isIncludedFeature
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-foreground'
                            )}
                          >
                            {isIncludedFeature
                              ? `Included (${formatMoney(
                                  feature.price_per_day || feature.default_price_per_day || 0
                                )} / day)`
                              : `${formatMoney(
                                  feature.price_per_day || feature.default_price_per_day || 0
                                )} / day`}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            Enabled {format(parseISO(subscriptionFeature.enabled_date), 'MMM d, yyyy')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {enabledFeatureDetails.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    <p className="text-sm text-foreground">
                      <strong>Features Total:</strong> {formatMoney(enabledFeaturesDailyTotal)} / day
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deposits" className="mt-0">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Recent Deposits</CardTitle>
                  <CardDescription>Track payments and credits added to your account</CardDescription>
                </div>
                {isDepositsLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Updating deposit history...
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {deposits.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  <p>No deposits yet. Add credits to get started.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-3 md:hidden">
                    {deposits.map((deposit) => (
                      <div
                        key={deposit.id}
                        className="mobile-data-card space-y-2 rounded-lg border border-border bg-card p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="break-all font-mono text-xs">{deposit.deposit_id}</p>
                          {getDepositStatusBadge(deposit.status)}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Paid</span>
                          <span className="font-semibold">{formatMoney(deposit.amount)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Credits</span>
                          <span className="font-semibold">
                            {formatMoney(Number(deposit.credited_amount ?? deposit.amount ?? 0))}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Method</span>
                          <span className="text-sm capitalize">
                            {formatPaymentMethodLabel(deposit.payment_method)}
                          </span>
                        </div>
                        {deposit.funding_period && (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-muted-foreground">Bundle</span>
                            <span className="text-sm capitalize">
                              {formatPaymentMethodLabel(deposit.funding_period)}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Transaction ID</span>
                          <span className="break-all text-right font-mono text-xs">
                            {deposit.transaction_id || deposit.payment_proof || '-'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Date</span>
                          <span className="text-sm">
                            {format(parseISO(deposit.requested_date), 'MMM d, yyyy')}
                          </span>
                        </div>
                        {isDepositDeletable(deposit) && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleDeleteDeposit(deposit)}
                            disabled={depositIdsBeingDeleted.includes(deposit.id)}
                            className="w-full border-destructive/30 text-destructive hover:bg-destructive/10"
                          >
                            {depositIdsBeingDeleted.includes(deposit.id) ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="mr-2 h-4 w-4" />
                            )}
                            Delete Deposit
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Deposit ID</TableHead>
                          <TableHead>Paid</TableHead>
                          <TableHead>Credits</TableHead>
                          <TableHead>Bundle</TableHead>
                          <TableHead>Method</TableHead>
                          <TableHead>Transaction ID</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deposits.map((deposit) => (
                          <TableRow key={deposit.id}>
                            <TableCell className="break-all font-mono text-sm">
                              {deposit.deposit_id}
                            </TableCell>
                            <TableCell className="font-semibold">{formatMoney(deposit.amount)}</TableCell>
                            <TableCell className="font-semibold">
                              {formatMoney(Number(deposit.credited_amount ?? deposit.amount ?? 0))}
                            </TableCell>
                            <TableCell className="capitalize">
                              {deposit.funding_period ? formatPaymentMethodLabel(deposit.funding_period) : '-'}
                            </TableCell>
                            <TableCell className="capitalize">
                              {formatPaymentMethodLabel(deposit.payment_method)}
                            </TableCell>
                            <TableCell className="break-all font-mono text-xs">
                              {deposit.transaction_id || deposit.payment_proof || '-'}
                            </TableCell>
                            <TableCell>{getDepositStatusBadge(deposit.status)}</TableCell>
                            <TableCell className="text-sm">
                              {format(parseISO(deposit.requested_date), 'MMM d, yyyy')}
                            </TableCell>
                            <TableCell className="text-right">
                              {isDepositDeletable(deposit) ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleDeleteDeposit(deposit)}
                                  disabled={depositIdsBeingDeleted.includes(deposit.id)}
                                  className="border-destructive/30 text-destructive hover:bg-destructive/10"
                                >
                                  {depositIdsBeingDeleted.includes(deposit.id) ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="mr-2 h-4 w-4" />
                                  )}
                                  Delete
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="mt-6 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted-foreground">
                      Showing {depositsStartIndex}-{depositsEndIndex} of {depositsTotalCount} deposits
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDepositsPageChange(depositsPage - 1)}
                        disabled={!depositsHasPreviousPage || isDepositsLoading}
                      >
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        Page {depositsPage} of {depositsTotalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDepositsPageChange(depositsPage + 1)}
                        disabled={!depositsHasNextPage || isDepositsLoading}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pricing" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle>Pricing Information</CardTitle>
              <CardDescription>How your subscription charges are calculated</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Zap className="h-4 w-4" />
                <AlertDescription>
                  You&apos;re on a pay-as-you-go plan. You&apos;re charged daily based on your base
                  subscription fee and enabled features.
                </AlertDescription>
              </Alert>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-4">
                  <p className="flex items-center gap-2 font-semibold">
                    <DollarSign className="h-4 w-4" />
                    Daily Charge
                  </p>
                  <p className="text-2xl font-bold">{formatMoney(subscription.daily_charge)}</p>
                  <p className="text-sm text-muted-foreground">Includes base fee + enabled features</p>
                </div>

                <div className="space-y-2 rounded-lg border p-4">
                  <p className="flex items-center gap-2 font-semibold">
                    <Calendar className="h-4 w-4" />
                    Monthly Estimate
                  </p>
                  <p className="text-2xl font-bold">{formatMoney(subscription.monthly_charge)}</p>
                  <p className="text-sm text-muted-foreground">Based on 30 days</p>
                </div>
              </div>

              <div className="rounded-lg bg-muted p-4">
                <p className="mb-2 text-sm text-muted-foreground">
                  Your daily charge includes your base subscription fee plus any enabled premium features.
                  Credits are automatically deducted daily to cover these charges.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
