
'use client';

import { useState, useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { db, type Business } from '@/lib/db';
import { authFetch } from '@/lib/auth-fetch';
import { SHOW_FUEL_FEATURES } from '@/lib/fuel-features';
import { Loader2, RefreshCw, Clock } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const LOCAL_STORAGE_KEYS = {
    BUSINESS_SETTINGS: 'handypos-business-settings',
    BRANCHES: 'handypos-branches',
    ACTIVE_BRANCH: 'handypos-active-branch',
};

const MONTH_OPTIONS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

const resolveFiscalYearStartMonth = (value: unknown, fallback = 1): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) {
    return Math.trunc(parsed);
  }
  return fallback;
};

const normalizePumpList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const pump = String(entry ?? '').trim();
    if (!pump || seen.has(pump)) continue;
    seen.add(pump);
    normalized.push(pump);
  }
  return normalized;
};

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true';
};

const BUSINESS_TYPE_MAP: Record<string, string> = {
  Pharmacy: 'pharmacy',
  Restaurant: 'restaurant',
  'Bar & Liquor': 'bar_liquor',
  Supermarket: 'supermarket',
  Grocery: 'grocery',
  'Beauty Salon and Spa': 'beauty_salon',
  'Clothing & Fashion': 'clothing',
  Hardware: 'hardware',
  Generic: 'generic',
  'General Retail': 'generic',
};

const BUSINESS_TYPE_REVERSE_MAP: Record<string, string> = {
  pharmacy: 'Pharmacy',
  restaurant: 'Restaurant',
  bar_liquor: 'Bar & Liquor',
  supermarket: 'Supermarket',
  grocery: 'Grocery',
  beauty_salon: 'Beauty Salon and Spa',
  clothing: 'Clothing & Fashion',
  clothing_fashion: 'Clothing & Fashion',
  hardware: 'Hardware',
  generic: 'Generic',
};

const normalizeBusinessTypeForForm = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  return BUSINESS_TYPE_REVERSE_MAP[normalized] || normalized;
};

const normalizeBusinessTypeForBackend = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 'generic';
  return BUSINESS_TYPE_MAP[normalized] || normalized;
};

const resolveBusinessTypeFormValue = (...values: Array<unknown>): string => {
  for (const value of values) {
    const normalized = normalizeBusinessTypeForForm(value);
    if (normalized) {
      return normalized;
    }
  }
  return 'Generic';
};

// Schemas
const businessSettingsSchema = z.object({
  businessName: z.string().min(2, 'Business name must be at least 2 characters.'),
  businessType: z.string().min(1, 'Please select a business type.'),
  currency: z.string().min(1, 'Currency is required.'),
  fiscalYearStartMonth: z.coerce.number().min(1).max(12).default(1),
  email: z.string().email('Please enter a valid email.').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  website: z.string().url('Please enter a valid URL.').optional().or(z.literal('')),
  // MRA EIS Fields
  tin: z.string().optional(),
  vatRegistrationNumber: z.string().optional(),
  vatRegistered: z.boolean().default(false),
  mraTaxpayerType: z.enum(['VAT', 'NON_VAT']).default('NON_VAT'),
  mraEnrolled: z.boolean().default(false),
  enableEis: z.boolean().default(false),
  eisEnvironment: z.enum(['TEST', 'PROD']).default('TEST'),
  blockSalesIfEisDown: z.boolean().default(true),
  blockSalesIfTaxMappingMissing: z.boolean().default(false),
  allowNegativeIngredientStock: z.boolean().default(false),
  fuelPumps: z.array(z.string().trim().min(1)).default([]),
});

type BusinessSettingsFormValues = z.infer<typeof businessSettingsSchema>;


interface Branch {
  id: string;
  name: string;
  address?: string;
}

export default function BusinessSettingsPage() {
  const [isClient, setIsClient] = useState(false);
  const { business, user } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isSyncingBranches, setIsSyncingBranches] = useState(false);
  const [newPumpName, setNewPumpName] = useState('');
  const isAdminUser = user?.role === 'Admin';
  
  useEffect(() => {
    setIsClient(true);
  }, []);

  const businessForm = useForm<BusinessSettingsFormValues>({
    resolver: zodResolver(businessSettingsSchema),
    defaultValues: {
      businessName: '',
      businessType: resolveBusinessTypeFormValue(business?.type),
      currency: 'USD',
      fiscalYearStartMonth: 1,
      email: '',
      phone: '',
      address: '',
      website: '',
      tin: '',
      vatRegistrationNumber: '',
      vatRegistered: false,
      mraTaxpayerType: 'NON_VAT',
      mraEnrolled: false,
      enableEis: false,
      eisEnvironment: 'TEST',
      blockSalesIfEisDown: true,
      blockSalesIfTaxMappingMissing: false,
      allowNegativeIngredientStock: false,
      fuelPumps: [],
    },
  });
  const fuelPumps = businessForm.watch('fuelPumps');

  // Load business settings from backend
  useEffect(() => {
    if (isClient && business?.id) {
        const loadSettings = async () => {
            console.log('[DEBUG SETTINGS] Loading business settings for ID:', business.id);
            let cachedFiscalYearStartMonth = 1;
            let cachedFuelPumps: string[] = [];
            try {
              try {
                const cachedSettingsRaw = localStorage.getItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS);
                if (cachedSettingsRaw) {
                  const cachedSettings = JSON.parse(cachedSettingsRaw);
                  cachedFiscalYearStartMonth = resolveFiscalYearStartMonth(
                    cachedSettings?.fiscalYearStartMonth,
                    cachedFiscalYearStartMonth
                  );
                  cachedFuelPumps = normalizePumpList(
                    cachedSettings?.fuelPumps ?? cachedSettings?.fuel_pumps
                  );
                }
              } catch (cacheError) {
                console.warn('[DEBUG SETTINGS] Failed to parse cached fiscal year start month:', cacheError);
              }

              // Fetch from backend to get all fields including MRA EIS
              const backendBusiness = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
              console.log('[DEBUG SETTINGS] Loaded settings from backend:', backendBusiness);
              
              if (backendBusiness) {
                console.log('[DEBUG SETTINGS] Backend business full response:', JSON.stringify(backendBusiness, null, 2));
                console.log('[DEBUG SETTINGS] enable_eis value:', backendBusiness.enable_eis);
                console.log('[DEBUG SETTINGS] eis_environment value:', backendBusiness.eis_environment);
                console.log('[DEBUG SETTINGS] block_sales_if_eis_down value:', backendBusiness.block_sales_if_eis_down);
                
                // Ensure boolean values are properly converted
                const enableEisValue = toBoolean(backendBusiness.enable_eis);
                const vatRegisteredValue = toBoolean(backendBusiness.vat_registered);
                const mraEnrolledValue = toBoolean(backendBusiness.mra_enrolled);
                const blockSalesValue = backendBusiness.block_sales_if_eis_down !== false && backendBusiness.block_sales_if_eis_down !== 'false';
                const rawBlockTaxMapping = backendBusiness.block_sales_if_tax_mapping_missing ?? backendBusiness.blockSalesIfTaxMappingMissing;
                const blockTaxMappingValue = rawBlockTaxMapping === undefined
                  ? false
                  : rawBlockTaxMapping !== false && rawBlockTaxMapping !== 'false';
                const allowNegativeIngredientStockValue = toBoolean(
                  backendBusiness.allow_negative_ingredient_stock ??
                    backendBusiness.allow_negative_stock ??
                    backendBusiness.allowNegativeIngredientStock ??
                    backendBusiness.allowNegativeStock ??
                    backendBusiness.settings?.allow_negative_ingredient_stock ??
                    backendBusiness.settings?.allow_negative_stock ??
                    backendBusiness.settings?.allowNegativeIngredientStock,
                  false
                );
                
                console.log('[DEBUG SETTINGS] Converted boolean values:', {
                  enableEis: enableEisValue,
                  vatRegistered: vatRegisteredValue,
                  mraEnrolled: mraEnrolledValue,
                  blockSales: blockSalesValue,
                  blockSalesIfTaxMappingMissing: blockTaxMappingValue,
                  allowNegativeIngredientStock: allowNegativeIngredientStockValue,
                });
                
                const formData: BusinessSettingsFormValues = {
                    businessName: backendBusiness.name || '',
                    businessType: resolveBusinessTypeFormValue(backendBusiness.business_type, business?.type),
                    currency: backendBusiness.settings?.currency || 'USD',
                    fiscalYearStartMonth: cachedFiscalYearStartMonth,
                    email: backendBusiness.email || '',
                    phone: backendBusiness.phone || '',
                    address: backendBusiness.address || '',
                    website: backendBusiness.website || '',
                    // MRA EIS Fields - explicitly set boolean values
                    tin: backendBusiness.tin || backendBusiness.tax_pin || backendBusiness.taxPin || '',
                    vatRegistrationNumber: backendBusiness.vat_registration_number || '',
                    vatRegistered: vatRegisteredValue,
                    mraTaxpayerType: backendBusiness.mra_taxpayer_type === 'VAT' ? 'VAT' : 'NON_VAT',
                    mraEnrolled: mraEnrolledValue,
                    enableEis: enableEisValue,
                    eisEnvironment: backendBusiness.eis_environment || 'TEST',
                    blockSalesIfEisDown: blockSalesValue,
                    blockSalesIfTaxMappingMissing: blockTaxMappingValue,
                    allowNegativeIngredientStock: allowNegativeIngredientStockValue,
                    fuelPumps: normalizePumpList(
                      backendBusiness.settings?.fuel_pumps ??
                        backendBusiness.settings?.fuelPumps ??
                        cachedFuelPumps
                    ),
                };
                console.log('[DEBUG SETTINGS] Form data to reset:', formData);
                businessForm.reset(formData);
                console.log('[DEBUG SETTINGS] Form reset completed');
                
                // Verify form values after reset
                setTimeout(() => {
                  console.log('[DEBUG SETTINGS] Form values after reset:', {
                    enableEis: businessForm.getValues('enableEis'),
                    eisEnvironment: businessForm.getValues('eisEnvironment'),
                    blockSalesIfEisDown: businessForm.getValues('blockSalesIfEisDown'),
                    blockSalesIfTaxMappingMissing: businessForm.getValues('blockSalesIfTaxMappingMissing'),
                    allowNegativeIngredientStock: businessForm.getValues('allowNegativeIngredientStock'),
                  });
                }, 100);
              } else {
                console.log('[DEBUG SETTINGS] No settings found from backend for business ID:', business.id);
                // Set defaults
                businessForm.reset({
                    businessName: '',
                    businessType: resolveBusinessTypeFormValue(business?.type),
                    currency: 'USD',
                    fiscalYearStartMonth: cachedFiscalYearStartMonth,
                    email: '',
                    phone: '',
                    address: '',
                    website: '',
                    tin: '',
                    vatRegistrationNumber: '',
                    vatRegistered: false,
                    mraTaxpayerType: 'NON_VAT',
                    mraEnrolled: false,
                    enableEis: false,
                    eisEnvironment: 'TEST',
                    blockSalesIfEisDown: true,
                    blockSalesIfTaxMappingMissing: false,
                    allowNegativeIngredientStock: false,
                    fuelPumps: cachedFuelPumps,
                });
              }
            } catch (error) {
              console.error('[DEBUG SETTINGS] Error loading settings from backend:', error);
              // Fallback to IndexedDB
              let settings = await db.business.get(business.id);
              console.log('[DEBUG SETTINGS] Fallback - Loaded settings from IndexedDB:', settings);
              
              if (settings) {
                const { name, type, currency, email, phone, address, website, tin } = settings;
                const allowNegativeIngredientStockValue = toBoolean(
                  (settings as any).allowNegativeIngredientStock ?? (settings as any).allow_negative_ingredient_stock,
                  false
                );
                const formData: BusinessSettingsFormValues = {
                    businessName: name || '',
                    businessType: resolveBusinessTypeFormValue(type, business?.type),
                    currency: currency || 'USD',
                    fiscalYearStartMonth: cachedFiscalYearStartMonth,
                    email: email || '',
                    phone: phone || '',
                    address: address || '',
                    website: website || '',
                    tin: tin || '',
                    vatRegistrationNumber: '',
                    vatRegistered: false,
                    mraTaxpayerType: 'NON_VAT',
                    mraEnrolled: false,
                    enableEis: false,
                    eisEnvironment: 'TEST',
                    blockSalesIfEisDown: true,
                    blockSalesIfTaxMappingMissing: false,
                    allowNegativeIngredientStock: allowNegativeIngredientStockValue,
                    fuelPumps: cachedFuelPumps,
                };
                businessForm.reset(formData);
              } else {
                businessForm.reset({
                    businessName: '',
                    businessType: resolveBusinessTypeFormValue(business?.type),
                    currency: 'USD',
                    fiscalYearStartMonth: cachedFiscalYearStartMonth,
                    email: '',
                    phone: '',
                    address: '',
                    website: '',
                    tin: '',
                    vatRegistrationNumber: '',
                    vatRegistered: false,
                    mraTaxpayerType: 'NON_VAT',
                    mraEnrolled: false,
                    enableEis: false,
                    eisEnvironment: 'TEST',
                    blockSalesIfEisDown: true,
                    blockSalesIfTaxMappingMissing: false,
                    allowNegativeIngredientStock: false,
                    fuelPumps: cachedFuelPumps,
                });
              }
            }
        }
        loadSettings();
    }
  }, [isClient, business?.id, businessForm]);

  // Load branches from localStorage
  useEffect(() => {
    if (isClient) {
      const storedBranches = localStorage.getItem(LOCAL_STORAGE_KEYS.BRANCHES);
      if (storedBranches) {
        try {
          setBranches(JSON.parse(storedBranches));
          console.log('[DEBUG SETTINGS] Loaded branches from localStorage:', JSON.parse(storedBranches));
        } catch (e) {
          console.error('[DEBUG SETTINGS] Failed to parse branches from localStorage:', e);
        }
      }
    }
  }, [isClient]);

  // Sync branches from backend
  const syncBranchesFromBackend = async () => {
    if (!business?.id) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No business selected.',
      });
      return;
    }

    setIsSyncingBranches(true);
    try {
      console.log('[DEBUG SETTINGS] Syncing branches from backend for business:', business.id);
      
      const response = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
      
      if (response?.branches && Array.isArray(response.branches)) {
        console.log('[DEBUG SETTINGS] Received branches from backend:', response.branches);
        
        // Map backend branches to local format
        const mappedBranches: Branch[] = response.branches.map((branch: any) => ({
          id: String(branch.id), // Ensure ID is a string
          name: branch.name || 'Branch',
          address: branch.address || '',
        }));

        // Save to localStorage
        localStorage.setItem(LOCAL_STORAGE_KEYS.BRANCHES, JSON.stringify(mappedBranches));
        console.log('[DEBUG SETTINGS] Branches saved to localStorage:', mappedBranches);

        // Update state
        setBranches(mappedBranches);

        // Set active branch if not already set
        const activeBranch = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
        if (!activeBranch && mappedBranches.length > 0) {
          localStorage.setItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH, mappedBranches[0].id);
          console.log('[DEBUG SETTINGS] Set active branch to:', mappedBranches[0].id);
        }

        toast({
          title: 'Branches synced!',
          description: `Successfully synced ${mappedBranches.length} branch(es) from the server.`,
        });
      } else {
        console.warn('[DEBUG SETTINGS] No branches found in backend response');
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'No branches found in the server response.',
        });
      }
    } catch (error) {
      console.error('[DEBUG SETTINGS] Error syncing branches:', error);
      toast({
        variant: 'destructive',
        title: 'Sync failed',
        description: error instanceof Error ? error.message : 'Failed to sync branches from the server.',
      });
    } finally {
      setIsSyncingBranches(false);
    }
  };

  const handleAddPump = () => {
    const trimmed = newPumpName.trim();
    if (!trimmed) return;
    const next = normalizePumpList([...(fuelPumps || []), trimmed]);
    businessForm.setValue('fuelPumps', next, { shouldDirty: true });
    setNewPumpName('');
  };

  const handleRemovePump = (pump: string) => {
    const next = (fuelPumps || []).filter((entry) => entry !== pump);
    businessForm.setValue('fuelPumps', next, { shouldDirty: true });
  };

  async function onBusinessSubmit(data: BusinessSettingsFormValues) {
    if (!business?.id) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No business selected.',
      });
      return;
    }

    const resolvedFuelPumps = normalizePumpList(fuelPumps ?? data.fuelPumps);
    const businessData: Business = {
        id: business.id,
        name: data.businessName,
        type: data.businessType,
        currency: data.currency,
        tin: data.tin || '',
        email: data.email || '',
        phone: data.phone || '',
        address: data.address || '',
        website: data.website || '',
        allowNegativeIngredientStock: data.allowNegativeIngredientStock,
    };

    try {
      // Step 1: Save to local IndexedDB immediately
      console.log('[DEBUG SETTINGS] Saving business data to IndexedDB:', businessData);
      await db.business.put(businessData);
      console.log('[DEBUG SETTINGS] Business data saved to IndexedDB successfully');
      
      // Step 2: Update localStorage for immediate reflection in hooks like useCurrency
      localStorage.setItem(
        LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS,
        JSON.stringify({
          ...data,
          fuelPumps: resolvedFuelPumps,
        })
      );

      // Step 3: Attempt to sync with backend
      const isOnline = authFetch.getOnlineStatus();
      console.log('[DEBUG SETTINGS] Online status:', isOnline);

      const backendPayload = {
        name: data.businessName,
        business_type: normalizeBusinessTypeForBackend(data.businessType),
        email: data.email || '',
        phone: data.phone || '',
        address: data.address || '',
        website: data.website || '',
        // MRA EIS Fields
        tin: data.tin || '',
        vat_registration_number: data.vatRegistrationNumber || '',
        vat_registered: data.vatRegistered,
        mra_taxpayer_type: data.mraTaxpayerType,
        mra_enrolled: data.mraEnrolled,
        enable_eis: data.enableEis,
        eis_environment: data.eisEnvironment,
        block_sales_if_eis_down: data.blockSalesIfEisDown,
        block_sales_if_tax_mapping_missing: data.blockSalesIfTaxMappingMissing,
        allow_negative_ingredient_stock: data.allowNegativeIngredientStock,
        allow_negative_stock: data.allowNegativeIngredientStock,
        fuel_pumps: resolvedFuelPumps,
      };

      console.log('[DEBUG SETTINGS] Attempting to sync to backend:', backendPayload);
      console.log('[DEBUG SETTINGS] Online status:', isOnline);

      try {
        console.log('[DEBUG SETTINGS] Making PUT request to:', `/business/businesses/${business.id}/`);
        console.log('[DEBUG SETTINGS] Payload:', JSON.stringify(backendPayload, null, 2));
        
        const response = await authFetch.fetch(`/business/businesses/${business.id}/`, {
          method: 'PUT',
          body: JSON.stringify(backendPayload),
        });

        console.log('[DEBUG SETTINGS] Backend sync successful:', response);
        console.log('[DEBUG SETTINGS] Response enable_eis:', response?.enable_eis);
        console.log('[DEBUG SETTINGS] Response eis_environment:', response?.eis_environment);
        console.log('[DEBUG SETTINGS] Response block_sales_if_eis_down:', response?.block_sales_if_eis_down);
        console.log('[DEBUG SETTINGS] Response block_sales_if_tax_mapping_missing:', response?.block_sales_if_tax_mapping_missing);
        console.log('[DEBUG SETTINGS] Full response JSON:', JSON.stringify(response, null, 2));

        // Reload form with updated values from backend to ensure persistence
        if (response) {
          const enableEisValue = response.enable_eis === true || response.enable_eis === 'true';
          const eisEnvironmentValue = response.eis_environment || 'TEST';
          const blockSalesValue = response.block_sales_if_eis_down !== false;
          const rawBlockTaxMapping = response.block_sales_if_tax_mapping_missing ?? response.blockSalesIfTaxMappingMissing;
          const blockTaxMappingValue = rawBlockTaxMapping === undefined
            ? data.blockSalesIfTaxMappingMissing
            : rawBlockTaxMapping !== false && rawBlockTaxMapping !== 'false';
          const allowNegativeIngredientStockValue = toBoolean(
            response.allow_negative_ingredient_stock ??
              response.allow_negative_stock ??
              response.allowNegativeIngredientStock ??
              response.allowNegativeStock ??
              response.settings?.allow_negative_ingredient_stock ??
              response.settings?.allow_negative_stock ??
              response.settings?.allowNegativeIngredientStock,
            data.allowNegativeIngredientStock
          );
          
            businessForm.reset({
            businessName: response.name || data.businessName,
            businessType: normalizeBusinessTypeForForm(response.business_type || data.businessType),
            currency: response.settings?.currency || data.currency,
            fiscalYearStartMonth: data.fiscalYearStartMonth || 1,
            email: response.email || data.email,
            phone: response.phone || data.phone,
            address: response.address || data.address,
            website: response.website || data.website,
            tin: response.tin || response.tax_pin || response.taxPin || data.tin,
            vatRegistrationNumber: response.vat_registration_number || data.vatRegistrationNumber,
            vatRegistered: response.vat_registered === true || response.vat_registered === 'true',
            mraTaxpayerType: response.mra_taxpayer_type || data.mraTaxpayerType,
            mraEnrolled: response.mra_enrolled === true || response.mra_enrolled === 'true',
            enableEis: enableEisValue,
            eisEnvironment: eisEnvironmentValue,
            blockSalesIfEisDown: blockSalesValue,
            blockSalesIfTaxMappingMissing: blockTaxMappingValue,
            allowNegativeIngredientStock: allowNegativeIngredientStockValue,
            fuelPumps: normalizePumpList(
              response.settings?.fuel_pumps ?? response.fuel_pumps ?? data.fuelPumps
            ),
          });
          console.log('[DEBUG SETTINGS] Form reloaded with backend response values');
        }

        toast({
          title: 'Settings saved!',
          description: 'Your business information has been updated and synced to the server.',
        });
      } catch (error) {
        console.error('[DEBUG SETTINGS] Backend sync error:', error);
        console.error('[DEBUG SETTINGS] Error details:', {
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : 'No stack trace',
        });
        
        // Queue the update for later sync by using offline flag
        console.log('[DEBUG SETTINGS] Queueing backend update for later sync');
        
        try {
          await authFetch.fetch(`/business/businesses/${business.id}/`, {
            method: 'PUT',
            body: JSON.stringify(backendPayload),
            offline: true, // Force queueing
          });
          console.log('[DEBUG SETTINGS] Update queued successfully');
        } catch (queueError) {
          console.error('[DEBUG SETTINGS] Failed to queue update:', queueError);
        }

        toast({
          title: 'Settings saved locally!',
          description: 'Your changes have been saved locally. They will sync to the server when you\'re back online.',
        });
      }
    } catch (error) {
      console.error('[DEBUG SETTINGS] Error saving business settings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save settings. Please try again.',
      });
    }
  }

  return (
    <FormProvider {...businessForm}>
      <form onSubmit={businessForm.handleSubmit(onBusinessSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>Business Profile</CardTitle>
            <CardDescription>
              Update your business name, type, and contact information.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <FormField
              control={businessForm.control}
              name="businessType"
              render={({ field }) => (
                <FormItem className="hidden">
                  <FormControl>
                    <Input type="hidden" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={businessForm.control}
              name="currency"
              render={({ field }) => (
                <FormItem className="hidden">
                  <FormControl>
                    <Input type="hidden" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={businessForm.control}
              name="businessName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Your business name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                    control={businessForm.control}
                    name="email"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Contact Email</FormLabel>
                            <FormControl>
                                <Input type="email" placeholder="contact@mybusiness.com" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={businessForm.control}
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
              control={businessForm.control}
              name="tin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business TIN</FormLabel>
                  <FormControl>
                    <Input placeholder="Taxpayer Identification Number" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
              <FormField
                control={businessForm.control}
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
              control={businessForm.control}
              name="fiscalYearStartMonth"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fiscal Year Start Month</FormLabel>
                  <Select
                    value={String(field.value ?? 1)}
                    onValueChange={(value) => field.onChange(Number(value))}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a start month" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MONTH_OPTIONS.map((month) => (
                        <SelectItem key={month.value} value={String(month.value)}>
                          {month.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="border-t px-6 py-4">
            <Button type="submit">Save Changes</Button>
          </CardFooter>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Stock Rules</CardTitle>
            <CardDescription>
              Control how Handy POS handles stock shortages during sales and orders.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={businessForm.control}
              name="allowNegativeIngredientStock"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <FormLabel>Allow negative stock</FormLabel>
                    <FormDescription>
                      Sales and orders can continue when products or recipe ingredients are short. Stock will show below zero until receiving is corrected.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="border-t px-6 py-4">
            <Button type="submit">Save Stock Rules</Button>
          </CardFooter>
        </Card>

        {/* Branches Section */}
        {SHOW_FUEL_FEATURES && (
        <Card className="mt-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Branches</CardTitle>
                <CardDescription>
                  Manage your business branches. Branch IDs are synced from the server.
                </CardDescription>
              </div>
              <Button
                onClick={syncBranchesFromBackend}
                disabled={isSyncingBranches}
                variant="outline"
                size="sm"
              >
                {isSyncingBranches ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Sync from Server
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {branches.length > 0 ? (
              <div className="space-y-3">
                {branches.map((branch) => (
                  <div
                    key={branch.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-muted/50"
                  >
                    <div className="flex-1">
                      <p className="font-medium">{branch.name}</p>
                      <p className="text-sm text-muted-foreground">
                        ID: <code className="bg-background px-2 py-1 rounded text-xs">{branch.id}</code>
                      </p>
                      {branch.address && (
                        <p className="text-sm text-muted-foreground mt-1">{branch.address}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <p>No branches found. Click "Sync from Server" to load your branches.</p>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {SHOW_FUEL_FEATURES && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Fuel Pumps</CardTitle>
              <CardDescription>
                Add the pump names your attendants can select when starting a session.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isAdminUser ? (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      placeholder="e.g. Pump 1"
                      value={newPumpName}
                      onChange={(event) => setNewPumpName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleAddPump();
                        }
                      }}
                    />
                    <Button type="button" onClick={handleAddPump}>
                      Add Pump
                    </Button>
                  </div>
                  {fuelPumps && fuelPumps.length > 0 ? (
                    <div className="space-y-2">
                      {fuelPumps.map((pump) => (
                        <div
                          key={pump}
                          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                        >
                          <span>{pump}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleRemovePump(pump)}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No pumps added yet.</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    The selected pump is stored on the session and attached to each sale.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only admins can manage fuel pump settings.
                </p>
              )}
            </CardContent>
            {isAdminUser && (
              <CardFooter className="border-t px-6 py-4">
                <Button type="submit">Save Pump Settings</Button>
              </CardFooter>
            )}
          </Card>
        )}

              </form>
    </FormProvider>
  );
}
