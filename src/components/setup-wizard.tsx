"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  BarChart3,
  Building2,
  Carrot,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ChefHat,
  Calculator,
  Hammer,
  Loader2,
  LogOut,
  Package,
  Pill,
  QrCode,
  ReceiptText,
  Shirt,
  ShoppingCart,
  Store,
  UtensilsCrossed,
  Users,
  Wine,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth-fetch";
import { HandyPosLogo } from "./icons/logo";
import { cn } from "@/lib/utils";
import { db, type Business, type Subscription } from "@/lib/db";
import { plans, type Plan } from "@/lib/subscriptions";
import { addDays } from "date-fns";
import { Textarea } from "./ui/textarea";

const wizardSchema = z.object({
  businessName: z.string().min(2, "Business name must be at least 2 characters."),
  businessType: z.string().min(1, "Please select a business type."),
  country: z.string().min(1, "Please select a country."),
  currency: z.string().default("USD"),
  email: z.string().email('Please enter a valid email.').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  website: z.string().url('Please enter a valid URL.').optional().or(z.literal('')),
  referralCode: z.string().optional().or(z.literal('')),
});

type WizardData = z.infer<typeof wizardSchema>;

type TrialPreviewResponse = {
  currency_code?: string;
  free_trial_days?: number;
  free_trial_credits_amount?: number;
  total_daily_charge?: number;
  base_price_per_day?: number;
  free_trial_end_date?: string;
};

type OnboardingFeature = {
  id: number;
  feature: string;
  feature_display: string;
  price_per_day: number;
  description?: string;
  is_active?: boolean;
};

type BackendSubscriptionResponse = Record<string, any>;

const businessTypes = [
  { id: 'restaurant', label: 'Restaurant', description: 'Tables, orders, kitchen, stock.', icon: UtensilsCrossed },
  { id: 'supermarket', label: 'Supermarket', description: 'Barcode sales and many products.', icon: ShoppingCart },
  { id: 'grocery', label: 'Grocery', description: 'Fresh produce and daily stock.', icon: Carrot },
  { id: 'bar_liquor', label: 'Bar & Liquor', description: 'Bottles, portions, and tabs.', icon: Wine },
  { id: 'clothing', label: 'Clothing & Fashion', description: 'Sizes, colors, SKUs, variants.', icon: Shirt },
  { id: 'hardware', label: 'Hardware', description: 'Tools, materials, meters, parts.', icon: Hammer },
  { id: 'beauty_salon', label: 'Beauty Salon and Spa', description: 'Products, supplies, services.', icon: Store },
  { id: 'pharmacy', label: 'Pharmacy', description: 'Medicine, batches, expiry dates.', icon: Pill },
];

const wizardSteps = ['Business', 'Trial', 'Ready'];

const isRestaurantBusinessType = (businessType: string | undefined): boolean =>
  ['restaurant', 'bar_liquor'].includes(String(businessType || '').trim().toLowerCase());

const currencies = [
  { value: 'USD', label: 'USD - United States Dollar' },
  { value: 'MWK', label: 'MWK - Malawian Kwacha' },
];

type TrialFeaturePresentation = {
  title: string;
  description: string;
  icon: React.ElementType;
};

const OPTIONAL_ADDON_FEATURE_KEYS = new Set([
  'staff_management',
  'multi_branch',
  'expense_management',
  'tax_management',
]);

const RESTAURANT_TRIAL_OUTCOMES: TrialFeaturePresentation[] = [
  {
    title: 'Automatic drink portion tracking',
    description: 'Know what each bottle, glass, and pour is doing to your stock.',
    icon: Wine,
  },
  {
    title: 'Automatic ingredient deduction',
    description: 'Selling a meal can update ingredient stock without extra admin work.',
    icon: UtensilsCrossed,
  },
  {
    title: 'QR code table ordering',
    description: 'Let customers order from their table and send requests to staff faster.',
    icon: QrCode,
  },
  {
    title: 'Real-time stock updates',
    description: 'See stock changes as sales, orders, and kitchen activity happen.',
    icon: Package,
  },
  {
    title: 'End-of-day sales reports',
    description: 'Close the day with clear totals, product movement, and staff activity.',
    icon: BarChart3,
  },
];

const GENERAL_TRIAL_OUTCOMES: TrialFeaturePresentation[] = [
  {
    title: 'Fast checkout and sales tracking',
    description: 'Process sales quickly and keep every transaction organized.',
    icon: ShoppingCart,
  },
  {
    title: 'Real-time stock updates',
    description: 'See stock movement as products are sold, received, or adjusted.',
    icon: Package,
  },
  {
    title: 'Low stock visibility',
    description: 'Spot products that need attention before they slow down sales.',
    icon: CheckCircle,
  },
  {
    title: 'Customer and order records',
    description: 'Keep useful customer, sale, and business activity history in one place.',
    icon: ReceiptText,
  },
  {
    title: 'End-of-day reports',
    description: 'Close the day with clear totals, product movement, and performance insights.',
    icon: BarChart3,
  },
];

const INCLUDED_RESTAURANT_FEATURES: TrialFeaturePresentation[] = [
  {
    title: 'POS',
    description: 'Sell from the counter, bar, or dining floor.',
    icon: ShoppingCart,
  },
  {
    title: 'Ingredient & Stock Tracking',
    description: 'Track menu items, ingredients, and low stock in one place.',
    icon: Package,
  },
  {
    title: 'QR Table Ordering',
    description: 'Customers can browse and order from your QR menu.',
    icon: QrCode,
  },
  {
    title: 'Kitchen Screen',
    description: 'Send orders to the kitchen and update preparation status.',
    icon: ChefHat,
  },
  {
    title: 'Reports',
    description: 'Review daily sales and performance from the dashboard.',
    icon: BarChart3,
  },
];

const INCLUDED_GENERAL_FEATURES: TrialFeaturePresentation[] = [
  {
    title: 'POS',
    description: 'Sell products and services from a simple checkout screen.',
    icon: ShoppingCart,
  },
  {
    title: 'Inventory & Stock Tracking',
    description: 'Track products, quantities, prices, and low-stock items.',
    icon: Package,
  },
  {
    title: 'Sales Records',
    description: 'Keep a clean history of sales and daily business activity.',
    icon: ReceiptText,
  },
  {
    title: 'Reports',
    description: 'Review sales, stock movement, and performance from the dashboard.',
    icon: BarChart3,
  },
];

const OPTIONAL_ADDON_PRESENTATION: Record<string, TrialFeaturePresentation> = {
  staff_management: {
    title: 'Staff Management',
    description: 'Control staff permissions and track cashier activity.',
    icon: Users,
  },
  multi_branch: {
    title: 'Multi-Branch',
    description: 'Manage multiple business locations from one dashboard.',
    icon: Building2,
  },
  expense_management: {
    title: 'Expense Management',
    description: 'Record and monitor daily business expenses.',
    icon: ReceiptText,
  },
  tax_management: {
    title: 'Tax Management',
    description: 'Generate tax-ready reports.',
    icon: Calculator,
  },
};

const isOptionalAddOnFeature = (feature: Pick<OnboardingFeature, 'feature'>): boolean =>
  OPTIONAL_ADDON_FEATURE_KEYS.has(String(feature.feature || ''));

const getOptionalAddOnPresentation = (
  feature: OnboardingFeature,
  useRestaurantCopy: boolean
): TrialFeaturePresentation => {
  if (useRestaurantCopy && feature.feature === 'multi_branch') {
    return {
      ...OPTIONAL_ADDON_PRESENTATION.multi_branch,
      description: 'Manage multiple restaurants from one dashboard.',
    };
  }

  return OPTIONAL_ADDON_PRESENTATION[feature.feature] || {
    title: feature.feature_display || feature.feature,
    description: feature.description || 'Optional add-on for your subscription.',
    icon: CheckCircle,
  };
};

export function SetupWizard() {
  const [current, setCurrent] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showInvalidReferralDialog, setShowInvalidReferralDialog] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [referralName, setReferralName] = useState<string | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState<string | null>(null);
  const [features, setFeatures] = useState<OnboardingFeature[]>([]);
  const [selectedFeatures, setSelectedFeatures] = useState<Record<string, boolean>>({});
  const [featuresLoading, setFeaturesLoading] = useState(true);
  const [trialPreview, setTrialPreview] = useState<TrialPreviewResponse | null>(null);
  const [trialPreviewLoading, setTrialPreviewLoading] = useState(false);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { business, selectBusiness, logout } = useAuth();

  const normalizeBusinessId = (value: unknown): string => String(value ?? "").trim();
  const normalizeCurrency = (value: string): string => {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized === "MWK" ? "MWK" : "USD";
  };
  const toNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const isFreeFeature = (feature: Pick<OnboardingFeature, 'price_per_day'>): boolean =>
    toNumber(feature.price_per_day, 0) === 0;
  const hasFeatureSelection = (
    selection: Record<string, boolean>,
    featureKey: string
  ): boolean => Object.prototype.hasOwnProperty.call(selection, featureKey);
  const isFeatureSelectedForBusiness = (
    feature: Pick<OnboardingFeature, 'feature' | 'price_per_day'>,
    businessType?: string,
    selection: Record<string, boolean> = selectedFeatures
  ): boolean => {
    const featureKey = String(feature.feature || '');
    if (featureKey === 'kitchen') {
      return isRestaurantBusinessType(businessType);
    }
    if (isFreeFeature(feature)) {
      return true;
    }
    if (hasFeatureSelection(selection, featureKey)) {
      return Boolean(selection[featureKey]);
    }
    return true;
  };
  const sortOnboardingFeatures = (items: OnboardingFeature[]): OnboardingFeature[] => (
    [...items]
      .filter((feature) => feature && feature.is_active !== false)
      .sort((left, right) => {
        const leftIsFree = isFreeFeature(left);
        const rightIsFree = isFreeFeature(right);

        if (leftIsFree !== rightIsFree) {
          return leftIsFree ? 1 : -1;
        }

        return String(left.feature_display || left.feature).localeCompare(
          String(right.feature_display || right.feature)
        );
      })
  );
  const buildDefaultFeatureSelection = (
    items: OnboardingFeature[],
    previousSelection: Record<string, boolean> = {},
    businessType?: string
  ): Record<string, boolean> => (
    items.reduce<Record<string, boolean>>((selection, feature) => {
      selection[feature.feature] = isFeatureSelectedForBusiness(feature, businessType, previousSelection);
      return selection;
    }, {})
  );
  const toDateString = (value: unknown, fallback: string): string => {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    return fallback;
  };
  const toOptionalDateString = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    return undefined;
  };
  const toSubscriptionStatus = (value: unknown): Subscription['status'] => {
    if (value === 'paused' || value === 'cancelled') {
      return value;
    }
    return 'active';
  };
  const formatMoney = (value: number, currencyCode: string): string => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: normalizeCurrency(currencyCode),
        minimumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${normalizeCurrency(currencyCode)} ${value.toFixed(2)}`;
    }
  };
  const mapSubscriptionForCache = (
    response: BackendSubscriptionResponse,
    businessId: string,
    planId?: Plan['id']
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
      planId: planId || 'starter',
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
  const fetchCurrentSubscription = async (businessId: string): Promise<BackendSubscriptionResponse> => (
    authFetch.fetch<BackendSubscriptionResponse>(
      `/subscription/subscriptions/current/?business=${encodeURIComponent(businessId)}`
    )
  );
  const fetchTrialPreview = async (businessId: string): Promise<void> => {
    setTrialPreviewLoading(true);
    try {
      const preview = await authFetch.fetch<TrialPreviewResponse>(
        `/subscription/subscriptions/trial-preview/?business=${encodeURIComponent(businessId)}`
      );
      setTrialPreview(preview || null);
    } catch (error) {
      console.warn('[Setup Wizard] Failed to fetch trial preview:', error);
      setTrialPreview(null);
    } finally {
      setTrialPreviewLoading(false);
    }
  };

  const persistBusinessSettingsCache = (businessId: string, currency: string) => {
    localStorage.setItem(
      'handypos-business-settings',
      JSON.stringify({
        businessId,
        currency,
        timezone: 'UTC',
      })
    );
  };

  const getPlanLimits = (plan: Plan) => ({
    maxBranches: plan.id === 'starter' ? 1 : 5,
    maxStaff: plan.id === 'starter' ? 1 : 10,
  });

  const buildDefaultTrialFeaturePayload = (
    businessType?: string
  ): Record<string, boolean> => {
    const enableRestaurantOperations = isRestaurantBusinessType(businessType);

    return {
      enable_pos: true,
      enable_inventory: true,
      enable_invoicing: true,
      enable_online_menu: true,
      enable_online_ordering: true,
      enable_kitchen: enableRestaurantOperations,
      enable_expense_management: true,
      enable_supplier_management: true,
      enable_purchases: true,
      enable_low_stock_alerts: true,
      enable_expiry_alerts: true,
      enable_customer_management: true,
      enable_reports: true,
      enable_analytics: true,
      enable_take_orders: true,
      enable_staff_management: true,
      enable_waste_management: true,
      enable_stock_transfers: true,
      enable_stock_audits: true,
      enable_tax_management: true,
      enable_multi_branch: true,
    };
  };

  const buildSelectedFeaturePayload = (): Record<string, boolean> => (
    features.reduce<Record<string, boolean>>((payload, feature) => {
      const businessType = form.getValues('businessType');
      payload[`enable_${feature.feature}`] = isFeatureSelectedForBusiness(
        feature,
        businessType,
        selectedFeatures
      );
      return payload;
    }, {})
  );

  const buildSubscriptionCreatePayload = (businessId: string, plan: Plan) => {
    const limits = getPlanLimits(plan);
    const businessType = form.getValues('businessType');

    return {
      business: businessId,
      plan: plan.id,
      status: 'trial',
      max_branches: limits.maxBranches,
      max_staff: limits.maxStaff,
      ...buildDefaultTrialFeaturePayload(businessType),
      ...buildSelectedFeaturePayload(),
    };
  };

  const createOrFetchSubscription = async (
    businessId: string,
    plan: Plan
  ): Promise<BackendSubscriptionResponse> => {
    try {
      return await authFetch.fetch<BackendSubscriptionResponse>(
        `/subscription/subscriptions/`,
        {
          method: 'POST',
          body: JSON.stringify(buildSubscriptionCreatePayload(businessId, plan)),
        }
      );
    } catch (error: any) {
      if (error?.message?.includes('already exists')) {
        return fetchCurrentSubscription(businessId);
      }

      throw error;
    }
  };

  const persistBusinessProfile = async (businessId: string, data: WizardData, currency: string) => {
    const businessProfile: Business = {
      id: businessId,
      name: data.businessName,
      type: data.businessType,
      currency,
      email: data.email || '',
      phone: data.phone || '',
      address: data.address || '',
      website: data.website || '',
    };
    await db.business.put(businessProfile);

    selectBusiness({
      id: businessId,
      name: data.businessName,
      type: data.businessType,
      currency,
      selectedAt: new Date().toISOString(),
    });

    localStorage.setItem(
      'handypos-business',
      JSON.stringify({
        id: businessId,
        name: data.businessName,
        type: data.businessType,
        currency,
      })
    );
    persistBusinessSettingsCache(businessId, currency);
  };

  useEffect(() => {
    const clearOldData = async () => {
      try {
        const keysToRemove = [
          'handypos-business',
          'handypos-business-settings',
          'handypos-business-id',
          'handypos-active-branch',
          'handypos-current-branch-id',
          'handypos-branches',
          'handy-pos-business',
          'handypos-auth-tokens',
          'handy-pos-auth-tokens',
        ];
        
        keysToRemove.forEach(key => localStorage.removeItem(key));

        await db.transaction('rw', [db.business, db.subscriptions, db.inventory, db.expenses, db.stockTakes, db.purchaseHistory], async () => {
          await db.business.clear();
          await db.subscriptions.clear();
          await db.inventory.clear();
          await db.expenses.clear();
          await db.stockTakes.clear();
          await db.purchaseHistory.clear();
        });
      } catch (error) {
        console.error('Error clearing old data:', error);
      }
    };

    clearOldData();
  }, []);

  const form = useForm<z.infer<typeof wizardSchema>>({
    resolver: zodResolver(wizardSchema),
    defaultValues: {
      businessName: "",
      currency: "MWK",
      businessType: "",
      country: "Malawi",
      email: "",
      phone: "",
      address: "",
      website: "",
    },
  });

  const country = form.watch('country');
  useEffect(() => {
    if (country) {
      const isMalawi = country.toLowerCase().includes('malawi');
      form.setValue('currency', isMalawi ? 'MWK' : 'USD');
    }
  }, [country, form]);

  useEffect(() => {
    const fetchFeatures = async () => {
      try {
        const response = await authFetch.fetch<any>('/subscription/feature-pricing/');
        let featuresList: OnboardingFeature[] = [];
        
        if (Array.isArray(response)) {
          featuresList = response;
        } else if (response?.results && Array.isArray(response.results)) {
          featuresList = response.results;
        }

        const sortedFeatures = sortOnboardingFeatures(featuresList);
        setFeatures(sortedFeatures);
        const businessType = form.getValues('businessType');
        setSelectedFeatures((previousSelection) => (
          buildDefaultFeatureSelection(sortedFeatures, previousSelection, businessType)
        ));
      } catch (error) {
        setFeatures([]);
        setSelectedFeatures({});
      } finally {
        setFeaturesLoading(false);
      }
    };
    
    fetchFeatures();
  }, []);

  useEffect(() => {
    const businessId = normalizeBusinessId(business?.id);
    if (current !== 1 || !businessId) {
      return;
    }

    fetchTrialPreview(businessId);
  }, [business?.id, current]);

  useEffect(() => {
    const referralCode = form.watch('referralCode');
    
    if (!referralCode || referralCode.trim() === '') {
      setReferralName(null);
      setReferralError(null);
      return;
    }

    const fetchReferralName = async () => {
      setReferralLoading(true);
      setReferralError(null);
      try {
        const response = await authFetch.fetch<any>(
          `/affiliate/affiliates/validate-code/?code=${encodeURIComponent(referralCode)}`
        );
        
        if (response.valid && response.name) {
          setReferralName(response.name);
        } else {
          setReferralName(null);
          setReferralError('Invalid referral code');
        }
      } catch (error) {
        setReferralName(null);
        setReferralError('Invalid referral code');
      } finally {
        setReferralLoading(false);
      }
    };

    const timer = setTimeout(fetchReferralName, 500);
    return () => clearTimeout(timer);
  }, [form.watch('referralCode')]);

  const goNext = async (fieldToValidate?: keyof WizardData | (keyof WizardData)[]) => {
    let isValid = true;
    if (fieldToValidate) {
      isValid = await form.trigger(fieldToValidate as any);
    }
    if (isValid) {
      if (current === 0 && !business?.id) {
        setIsSubmitting(true);
        try {
          const data = form.getValues();
          const selectedCurrency = normalizeCurrency(data.currency);
          
          const businessResponse = await authFetch.fetch<any>(
            '/business/businesses/',
            {
              method: 'POST',
              body: JSON.stringify({
                name: data.businessName,
                business_type: data.businessType,
                country: data.country,
                currency: selectedCurrency,
                email: data.email,
                phone: data.phone,
                address: data.address,
                website: data.website,
              }),
            }
          );

          if (!businessResponse?.id) {
            throw new Error('Failed to create business');
          }

          const businessId = normalizeBusinessId(businessResponse.id);
          await persistBusinessProfile(businessId, data, selectedCurrency);

          // Ensure backend settings are aligned immediately after create.
          await authFetch.fetch<any>(
            `/business/businesses/${businessId}/business_settings/`,
            {
              method: 'PUT',
              body: JSON.stringify({
                currency: selectedCurrency,
              }),
            }
          ).catch((error) => {
            console.warn('[Setup Wizard] Initial currency sync failed (non-blocking):', error);
          });

          const branchesResponse = await authFetch.fetch<any>(
            `/business/businesses/${businessId}/branches/`
          );
          
          let branchesArray: any[] = [];
          if (Array.isArray(branchesResponse)) {
            branchesArray = branchesResponse;
          } else if (branchesResponse?.results && Array.isArray(branchesResponse.results)) {
            branchesArray = branchesResponse.results;
          }
          
          if (branchesArray.length === 0) {
            throw new Error('No branches found for business');
          }
          
          const mainBranch = branchesArray.find((b: any) => {
            const branchName = String(b?.name || '').trim().toLowerCase();
            return branchName === 'main branch' || branchName.endsWith(' main branch');
          }) || branchesArray[0];
          
          if (!mainBranch?.id) {
            throw new Error('Main branch ID not found');
          }
          
          localStorage.setItem('handypos-business-id', businessId);
          localStorage.setItem('handypos-active-branch', mainBranch.id.toString());
          localStorage.setItem('handypos-branches', JSON.stringify(branchesArray));

          await fetchTrialPreview(businessId);

          setCurrent(current + 1);
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: "Error",
            description: error.message || "Failed to create business.",
          });
        } finally {
          setIsSubmitting(false);
        }
      } else {
        setCurrent(current + 1);
      }
    }
  };
  
  const goBack = () => setCurrent(current - 1);

  const onSelectPlan = async (plan: Plan) => {
    setIsSubmitting(true);
    try {
      const data = form.getValues();
      const selectedCurrency = normalizeCurrency(data.currency);

      if (!business?.id) {
        throw new Error('No business selected');
      }
      const businessId = normalizeBusinessId(business.id);

      const updatePayload: any = {
        name: data.businessName,
        business_type: data.businessType,
        email: data.email,
        phone: data.phone,
        address: data.address,
        website: data.website,
      };
      
      if (data.referralCode) {
        updatePayload.referral_code = data.referralCode;
      }

      const updatedBusiness = await authFetch.fetch<any>(
        `/business/businesses/${businessId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(updatePayload),
        }
      );

      if (data.referralCode && updatedBusiness.referral_status && !updatedBusiness.referral_status.valid) {
        setPendingPlan(plan);
        setShowInvalidReferralDialog(true);
        setIsSubmitting(false);
        return;
      }

      if (data.referralCode && referralName) {
        try {
          await authFetch.fetch<any>(
            `/affiliate/affiliates/associate-business/`,
            {
              method: 'POST',
              body: JSON.stringify({
                referral_code: data.referralCode,
                business_id: businessId,
              }),
            }
          );
        } catch (error) {
          console.error('Failed to associate business with affiliate:', error);
        }
      }

      if (data.referralCode && updatedBusiness.referral_status && updatedBusiness.referral_status.valid) {
        toast({
          title: 'Referral Applied',
          description: updatedBusiness.referral_status.message,
        });
      }

      const settingsResponse = await authFetch.fetch<any>(
        `/business/businesses/${businessId}/business_settings/`,
        {
          method: 'PUT',
          body: JSON.stringify({
            currency: selectedCurrency,
          }),
        }
      );
      const resolvedCurrency = normalizeCurrency(settingsResponse?.currency || selectedCurrency);

      const subscriptionResponse = await createOrFetchSubscription(businessId, plan);

      const currentSubscription = await fetchCurrentSubscription(businessId).catch(() => subscriptionResponse);
      const subscriptionToPersist = currentSubscription || subscriptionResponse;

      await db.transaction('rw', db.subscriptions, async () => {
        const subscription: Subscription = mapSubscriptionForCache(subscriptionToPersist, businessId, plan.id);
        await db.subscriptions.put(subscription);
      });

      localStorage.setItem('handypos-business-id', businessId);
      await persistBusinessProfile(businessId, data, resolvedCurrency);

      toast({
        title: 'Setup Complete',
        description: `Welcome to the ${plan.name} plan! Your business has been configured successfully.`,
      });
      
      setCurrent(3);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "An error occurred during setup.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const ProgressDots = () => {
    // Completion uses current=3 while the visible wizard has 3 stages.
    const visibleStep = Math.min(current, 2);

    return (
      <div className="grid grid-cols-3 gap-2">
        {wizardSteps.map((label, i) => (
          <button
            key={i}
            onClick={() => { if (i < visibleStep) setCurrent(i); }}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors",
              i === visibleStep
                ? "border-primary bg-primary/10 text-primary"
                : i < visibleStep
                  ? "border-primary/30 bg-background text-foreground"
                  : "border-border bg-muted/40 text-muted-foreground",
              i > visibleStep && "cursor-not-allowed",
            )}
            aria-label={`Go to step ${i + 1}`}
            disabled={i > visibleStep}
          >
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                i <= visibleStep ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"
              )}
            >
              {i + 1}
            </span>
            <span className="font-medium">{label}</span>
          </button>
        ))}
      </div>
    );
  };

  const previewCurrencyCode = normalizeCurrency(
    String(trialPreview?.currency_code || form.watch('currency') || 'USD')
  );
  const selectedBusinessType = form.watch('businessType');
  const useRestaurantTrialCopy = isRestaurantBusinessType(selectedBusinessType);
  const trialOutcomes = useRestaurantTrialCopy ? RESTAURANT_TRIAL_OUTCOMES : GENERAL_TRIAL_OUTCOMES;
  const includedTrialFeatures = useRestaurantTrialCopy ? INCLUDED_RESTAURANT_FEATURES : INCLUDED_GENERAL_FEATURES;
  const previewDays = toNumber(trialPreview?.free_trial_days, 0);
  const displayTrialDays = previewDays > 0 ? previewDays : null;
  const trialTitle = displayTrialDays
    ? `Your ${displayTrialDays}-Day Free Trial is Ready`
    : 'Your Free Trial is Ready';
  const trialDurationText = displayTrialDays
    ? `for the next ${displayTrialDays} days`
    : 'during your trial';
  const optionalAddOnFeatures = features.filter(isOptionalAddOnFeature);

  useEffect(() => {
    if (features.length === 0) return;
    setSelectedFeatures((previousSelection) => (
      buildDefaultFeatureSelection(features, previousSelection, selectedBusinessType)
    ));
  }, [features, selectedBusinessType]);

  const defaultPreviewFeatureDailyCharge = features.reduce(
    (total, feature) => {
      const featureKey = String(feature.feature || '');
      if (featureKey === 'kitchen' && !isRestaurantBusinessType(selectedBusinessType)) {
        return total;
      }
      return total + toNumber(feature.price_per_day, 0);
    },
    0
  );
  const selectedFeatureDailyCharge = features.reduce((total, feature) => {
    if (!isFeatureSelectedForBusiness(feature, selectedBusinessType, selectedFeatures)) {
      return total;
    }
    return total + toNumber(feature.price_per_day, 0);
  }, 0);
  const previewBaseDailyCharge =
    trialPreview?.base_price_per_day !== undefined && trialPreview?.base_price_per_day !== null
      ? toNumber(trialPreview.base_price_per_day, 0)
      : Math.max(0, toNumber(trialPreview?.total_daily_charge, 0) - defaultPreviewFeatureDailyCharge);
  const liveDailyCharge = previewBaseDailyCharge + selectedFeatureDailyCharge;
  const liveMonthlyCharge = liveDailyCharge * 30;
  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <FormProvider {...form}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-11 w-11 shrink-0">
              <HandyPosLogo className="h-full w-full" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Handy POS</p>
              <p className="text-xs text-muted-foreground">New business setup</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handleLogout}
            disabled={isSubmitting || isDashboardLoading}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
        <Card className="flex flex-col overflow-hidden border bg-background shadow-sm sm:shadow-lg">
          <div className="border-b bg-muted/30 px-4 py-3 sm:px-6">
            <ProgressDots />
          </div>
          {/* Step 1: Business Info */}
          {current === 0 && (
            <>
              <CardHeader className="text-center px-6 py-6">
                <h1 className="font-headline text-2xl font-bold text-primary">Welcome to Handy POS</h1>
                <p className="text-sm text-muted-foreground">Let's get Handy POS set up in a few simple steps.</p>
              </CardHeader>
              <CardContent className="space-y-5 px-4 pb-6 sm:px-6">
                <FormField
                  control={form.control}
                  name="businessName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Business Name</FormLabel>
                      <FormControl><Input placeholder="e.g., The Corner Cafe" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="businessType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>What type of business do you run?</FormLabel>
                      <RadioGroup onValueChange={field.onChange} value={field.value} className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
                        {businessTypes.map(({ id, label, description, icon: Icon }) => (
                          <FormItem key={id}>
                            <RadioGroupItem value={id} id={id} className="sr-only" />
                            <Label
                              htmlFor={id}
                              className={cn(
                                "flex h-full cursor-pointer flex-col items-start gap-3 rounded-lg border p-3 transition-colors",
                                field.value === id
                                  ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/30"
                                  : "border-border bg-background hover:bg-muted/50"
                              )}
                            >
                              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <Icon className={cn("h-5 w-5 transition-transform", field.value === id && "scale-110")} />
                              </span>
                              <span className="grid gap-1">
                                <span className="font-semibold leading-tight">{label}</span>
                                <span className="text-xs font-normal leading-snug text-muted-foreground">{description}</span>
                              </span>
                            </Label>
                          </FormItem>
                        ))}
                      </RadioGroup>
                      <FormMessage className="text-center pt-2" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Country</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select your country" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Malawi">🇲🇼 Malawi</SelectItem>
                          <SelectItem value="United States">🇺🇸 United States</SelectItem>
                          <SelectItem value="United Kingdom">🇬🇧 United Kingdom</SelectItem>
                          <SelectItem value="Canada">🇨🇦 Canada</SelectItem>
                          <SelectItem value="Australia">🇦🇺 Australia</SelectItem>
                          <SelectItem value="Other">Other (Please specify)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact Email (Optional)</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="contact@mybusiness.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact Phone</FormLabel>
                        <FormControl>
                          <Input placeholder="+1 (555) 123-4567" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Business Address</FormLabel>
                      <FormControl>
                        <Textarea placeholder="123 Business Rd, Suite 100, Commerce City, 12345" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Currency</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a currency" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {currencies.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="referralCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Referral Code (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Enter referral code if you have one" {...field} />
                      </FormControl>
                      <FormDescription>
                        If you were referred by an affiliate, enter their referral code here.
                      </FormDescription>
                      {referralLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Validating referral code...</span>
                        </div>
                      )}
                      {referralName && !referralLoading && (
                        <div className="text-sm text-green-600 mt-2">
                          ✓ Referred by: <span className="font-semibold">{referralName}</span>
                        </div>
                      )}
                      {referralError && !referralLoading && (
                        <div className="text-sm text-destructive mt-2">
                          ✗ {referralError}
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </>
          )}

          {/* Step 2: Free Trial */}
          {current === 1 && (
            <>
              <CardHeader className="text-center px-6 py-6">
                <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CheckCircle className="h-7 w-7" />
                </div>
                <CardTitle className="font-headline text-2xl">
                  {trialTitle}
                </CardTitle>
                <CardDescription className="mx-auto max-w-md">
                  {useRestaurantTrialCopy
                    ? 'Reduce stock losses, track every sale, and let customers order from their table, all from one system.'
                    : 'Track sales, manage stock, and understand daily performance, all from one system.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6 px-4 pb-6 sm:px-6">
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                  <p className="text-sm font-semibold text-foreground">
                    Use every selected {useRestaurantTrialCopy ? 'restaurant' : 'business'} feature free {trialDurationText}.
                  </p>
                  <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
                    {['No payment today', 'No setup fees', 'No trial restrictions'].map((message) => (
                      <div key={message} className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 shrink-0 text-primary" />
                        <span>{message}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-sm">During your trial you'll experience</h3>
                    <p className="text-xs text-muted-foreground">
                      {useRestaurantTrialCopy
                        ? 'The restaurant workflows that usually create the biggest daily wins.'
                        : 'The everyday tools that help you run sales, stock, and reporting with less admin.'}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {trialOutcomes.map(({ title, description, icon: Icon }) => (
                      <div key={title} className="flex gap-3 rounded-lg border bg-background p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{title}</p>
                          <p className="text-xs text-muted-foreground">{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-sm">Included Features</h3>
                    <p className="text-xs text-muted-foreground">
                      Core {useRestaurantTrialCopy ? 'restaurant' : 'business'} tools included in your Handy POS trial.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {includedTrialFeatures.map(({ title, description, icon: Icon }) => (
                      <div key={title} className="flex gap-3 rounded-lg border bg-background p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{title}</p>
                            <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                              Included
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-sm">Optional Add-ons</h3>
                    <p className="text-xs text-muted-foreground">
                      These add-ons are selected by default. Remove any you do not want before activating your trial.
                    </p>
                  </div>
                  
                  {featuresLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">Loading add-ons...</span>
                    </div>
                  ) : optionalAddOnFeatures.length > 0 ? (
                    <div className="space-y-2">
                      {optionalAddOnFeatures.map((feature) => {
                        const presentation = getOptionalAddOnPresentation(feature, useRestaurantTrialCopy);
                        const Icon = presentation.icon;
                        const checked = Boolean(selectedFeatures[feature.feature] ?? false);
                        const pricePerDay = toNumber(feature.price_per_day, 0);

                        return (
                          <label
                            key={feature.feature}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-muted/50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedFeatures((previousSelection) => ({
                                  ...previousSelection,
                                  [feature.feature]: event.target.checked,
                                }));
                              }}
                              className="mt-1 h-4 w-4 rounded"
                            />
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                                <p className="text-sm font-medium text-foreground">{presentation.title}</p>
                                <span className="whitespace-nowrap text-xs font-medium text-foreground">
                                  {formatMoney(pricePerDay, previewCurrencyCode)}/day
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground">{presentation.description}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border bg-background p-4 text-center">
                      <p className="text-sm text-muted-foreground">No optional add-ons available right now.</p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border bg-muted/40 p-4">
                  {trialPreviewLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Checking your trial details...</span>
                    </div>
                  ) : trialPreview ? (
                    <p className="text-sm text-muted-foreground">
                      If you decide to continue after your trial, your subscription will be{' '}
                      <span className="font-semibold text-foreground">
                        {formatMoney(liveMonthlyCharge, previewCurrencyCode)}/month
                      </span>{' '}
                      based on the features you've selected.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      If you decide to continue after your trial, your subscription will be based on the features you've selected.
                    </p>
                  )}
                  {trialPreview && selectedFeatureDailyCharge > 0 && (
                    <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-3">
                        <span>Base subscription</span>
                        <span className="font-medium text-foreground">
                          {formatMoney(previewBaseDailyCharge, previewCurrencyCode)}/day
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Selected features</span>
                        <span className="font-medium text-foreground">
                          {formatMoney(selectedFeatureDailyCharge, previewCurrencyCode)}/day
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </>
          )}

          {/* Step 4: Completion */}
          {current === 3 && (
            <>
              <CardHeader className="text-center px-6 py-8">
                <div className="mx-auto mb-2">
                  <CheckCircle className="h-12 w-12 text-green-500" />
                </div>
                <CardTitle className="font-headline text-2xl">Setup Complete!</CardTitle>
                <CardDescription>
                  Your business is all set up. You can now proceed to your dashboard.
                </CardDescription>
              </CardHeader>
            </>
          )}
        </Card>

        <div className="rounded-lg border bg-background px-4 py-4 shadow-sm sm:px-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row">
            {current > 0 && current < 3 && (
              <Button variant="outline" className="w-full sm:w-auto" onClick={goBack}><ChevronLeft /> Back</Button>
            )}
            <div className="flex-grow" />
            {current === 0 && (
              <Button className="w-full sm:w-auto" onClick={() => goNext(['businessName', 'businessType', 'country'])}>Start Free Trial <ChevronRight /></Button>
            )}
            {current === 1 && (
              <Button className="w-full sm:w-auto" onClick={() => onSelectPlan(plans.starter)} disabled={isSubmitting || featuresLoading}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Activate Trial <ChevronRight />
              </Button>
            )}
            {current >= 2 && (
              <Button 
                onClick={() => setIsDashboardLoading(true)}
                disabled={isDashboardLoading}
                className="w-full"
                asChild
              >
                <Link href="/dashboard">
                  {isDashboardLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Go to Dashboard <ChevronRight />
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={showInvalidReferralDialog} onOpenChange={setShowInvalidReferralDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invalid Referral Code</AlertDialogTitle>
            <AlertDialogDescription>
              The referral code you entered is invalid or does not exist. Would you like to continue without a referral code, or go back and try a different code?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setShowInvalidReferralDialog(false);
              setPendingPlan(null);
            }}>
              Go Back
            </AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              if (pendingPlan) {
                setShowInvalidReferralDialog(false);
                setIsSubmitting(true);
                try {
                  const data = form.getValues();
                  const selectedCurrency = normalizeCurrency(data.currency);

                  if (!business?.id) {
                    throw new Error('No business selected');
                  }
                  const businessId = normalizeBusinessId(business.id);

                  const settingsResponse = await authFetch.fetch<any>(
                    `/business/businesses/${businessId}/business_settings/`,
                    {
                      method: 'PUT',
                      body: JSON.stringify({
                        currency: selectedCurrency,
                      }),
                    }
                  );
                  const resolvedCurrency = normalizeCurrency(settingsResponse?.currency || selectedCurrency);

                  const subscriptionResponse = await createOrFetchSubscription(
                    businessId,
                    pendingPlan
                  );

                  const currentSubscription = await fetchCurrentSubscription(businessId).catch(() => subscriptionResponse);
                  const subscriptionToPersist = currentSubscription || subscriptionResponse;

                  await db.transaction('rw', db.subscriptions, async () => {
                    const subscription: Subscription = mapSubscriptionForCache(subscriptionToPersist, businessId, pendingPlan.id);
                    await db.subscriptions.put(subscription);
                  });

                  localStorage.setItem('handypos-business-id', businessId);
                  await persistBusinessProfile(businessId, data, resolvedCurrency);

                  toast({
                    title: 'Setup Complete',
                    description: `Welcome to the ${pendingPlan.name} plan! Your business has been configured successfully.`,
                  });
                  
                  setCurrent(3);
                } catch (error: any) {
                  toast({
                    variant: "destructive",
                    title: "Error",
                    description: error.message || "An error occurred during setup.",
                  });
                } finally {
                  setIsSubmitting(false);
                  setPendingPlan(null);
                }
              }
            }}>
              Continue Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormProvider>
  );
}
