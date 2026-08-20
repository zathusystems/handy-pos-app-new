'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { 
  Zap, AlertCircle, CheckCircle2, Clock, RefreshCw, Loader2, 
  Copy, Check, Eye, EyeOff, ChevronDown, ChevronUp, AlertTriangle,
  Terminal, Settings, Package, FileText
} from 'lucide-react';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';

// Schemas
const eisSetupSchema = z.object({
  // Enable/Disable
  enableEis: z.boolean().default(false),
  
  // Taxpayer Information
  tin: z.string().optional(),
  vatRegistrationNumber: z.string().optional(),
  vatRegistered: z.boolean().default(false),
  mraTaxpayerType: z.enum(['VAT', 'NON_VAT']).default('NON_VAT'),
  
  // MRA Enrollment
  mraEnrolled: z.boolean().default(false),
  
  // Environment
  eisEnvironment: z.enum(['TEST', 'PROD']).default('TEST'),
  
  // Safety
  blockSalesIfEisDown: z.boolean().default(true),
  blockSalesIfTaxMappingMissing: z.boolean().default(false),
});

const terminalActivationSchema = z.object({
  activeBranch: z.string().min(1, 'Please select a branch.'),
  tac_code: z.string().min(1, 'Terminal Activation Code is required.'),
  pos_name: z.string().min(1, 'POS name is required.'),
  pos_version: z.string().min(1, 'POS version is required.'),
  os_type: z.string().min(1, 'OS type is required.'),
  device_serial: z.string().min(1, 'Device serial is required.'),
  mac_address: z.string().optional(),
});

type EISSetupFormValues = z.infer<typeof eisSetupSchema>;
type TerminalActivationFormValues = z.infer<typeof terminalActivationSchema>;

interface Terminal {
  id: string;
  business?: string;
  branch?: string;
  terminal_id: string;
  status: 'pending_activation' | 'active' | 'suspended' | 'deactivated';
  is_online: boolean;
  online_invoice_counter: number;
  offline_invoice_counter: number;
  pending_offline_invoices?: number;
  pos_name: string;
  pos_version: string;
  os_type: string;
  activated_at?: string;
  last_sync_at?: string;
  token_expires_at?: string;
}

interface Branch {
  id: string;
  name: string;
  address?: string;
}

const REQUIRED_CONFIG_TYPES = ['tax_rules', 'receipt_format', 'product_codes'] as const;
type RequiredConfigType = typeof REQUIRED_CONFIG_TYPES[number];

interface ConfigurationStatus {
  synced: boolean;
  version: string | null;
}

type ConfigurationStatusMap = Record<RequiredConfigType, ConfigurationStatus>;

const CONFIG_LABELS: Record<RequiredConfigType, string> = {
  tax_rules: 'Tax Rules',
  receipt_format: 'Receipt Format',
  product_codes: 'Product Codes',
};

const createDefaultConfigurationStatus = (): ConfigurationStatusMap => ({
  tax_rules: { synced: false, version: null },
  receipt_format: { synced: false, version: null },
  product_codes: { synced: false, version: null },
});

const isRequiredConfigType = (value: string): value is RequiredConfigType => {
  return REQUIRED_CONFIG_TYPES.includes(value as RequiredConfigType);
};

export default function EISSettingsPage() {
  const ACTIVE_BRANCH_STORAGE_KEY = 'handypos-active-branch';
  const { business } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [isActivatingTerminal, setIsActivatingTerminal] = useState(false);
  const [isLoadingTerminal, setIsLoadingTerminal] = useState(false);
  const [isRefreshingTerminalStatus, setIsRefreshingTerminalStatus] = useState(false);
  const [isRefreshingTerminalToken, setIsRefreshingTerminalToken] = useState(false);
  const [isSyncingConfigurations, setIsSyncingConfigurations] = useState(false);
  const [configurationStatus, setConfigurationStatus] = useState<ConfigurationStatusMap>(createDefaultConfigurationStatus);
  const [isLoadingConfigurationStatus, setIsLoadingConfigurationStatus] = useState(false);
  const [showTacPassword, setShowTacPassword] = useState(false);
  const [copiedTac, setCopiedTac] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    setup: true,
    terminal: true,
    configuration: false,
    products: false,
  });

  const getDetectedOS = (): string => {
    if (typeof window === 'undefined') return 'Web';
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) return 'Windows';
    if (userAgent.includes('mac')) return 'macOS';
    if (userAgent.includes('linux')) return 'Linux';
    if (userAgent.includes('android')) return 'Android';
    if (userAgent.includes('iphone') || userAgent.includes('ipad')) return 'iOS';
    return 'Web';
  };

  const getDeviceSerial = (): string => {
    if (typeof window === 'undefined') return `device-${Date.now()}`;
    const storageKey = 'handypos-device-serial';
    let deviceSerial = localStorage.getItem(storageKey);
    
    if (!deviceSerial) {
      const userAgent = window.navigator.userAgent;
      const language = window.navigator.language;
      const platform = window.navigator.platform;
      const hardwareConcurrency = (window.navigator as any).hardwareConcurrency || 'unknown';
      const deviceMemory = (window.navigator as any).deviceMemory || 'unknown';
      const maxTouchPoints = (window.navigator as any).maxTouchPoints || 0;
      
      const fingerprint = `${userAgent}-${language}-${platform}-${hardwareConcurrency}-${deviceMemory}-${maxTouchPoints}`;
      
      let hash = 0;
      for (let i = 0; i < fingerprint.length; i++) {
        const char = fingerprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      
      const os = getDetectedOS().substring(0, 3).toUpperCase();
      const timestamp = Date.now().toString(36).toUpperCase();
      const hashHex = Math.abs(hash).toString(16).toUpperCase().substring(0, 8);
      
      deviceSerial = `HANDY-${os}-${hashHex}-${timestamp}`;
      localStorage.setItem(storageKey, deviceSerial);
    }
    
    return deviceSerial;
  };

  const getTerminalStorageKey = (businessId: string, branchId: string): string => {
    return `handypos-terminal:${businessId}:${branchId}`;
  };

  const mapTerminalFromApi = (payload: any): Terminal => ({
    id: String(payload?.id || ''),
    business: payload?.business ? String(payload.business) : undefined,
    branch: payload?.branch ? String(payload.branch) : undefined,
    terminal_id: String(payload?.terminal_id || ''),
    status: (payload?.status || 'pending_activation') as Terminal['status'],
    is_online: Boolean(payload?.is_online),
    online_invoice_counter: Number(payload?.online_invoice_counter || 0),
    offline_invoice_counter: Number(payload?.offline_invoice_counter || 0),
    pending_offline_invoices: Number(payload?.pending_offline_invoices || 0),
    pos_name: String(payload?.pos_name || ''),
    pos_version: String(payload?.pos_version || ''),
    os_type: String(payload?.os_type || ''),
    activated_at: payload?.activated_at || undefined,
    last_sync_at: payload?.last_sync_at || undefined,
    token_expires_at: payload?.token_expires_at || undefined,
  });

  const eisForm = useForm<EISSetupFormValues>({
    resolver: zodResolver(eisSetupSchema),
    defaultValues: {
      enableEis: false,
      tin: '',
      vatRegistrationNumber: '',
      vatRegistered: false,
      mraTaxpayerType: 'NON_VAT',
      mraEnrolled: false,
      eisEnvironment: 'TEST',
      blockSalesIfEisDown: true,
      blockSalesIfTaxMappingMissing: false,
    },
  });

  const terminalForm = useForm<TerminalActivationFormValues>({
    resolver: zodResolver(terminalActivationSchema),
    defaultValues: {
      activeBranch: '',
      pos_name: 'Handy POS',
      pos_version: '1.0.0',
      os_type: getDetectedOS(),
      device_serial: getDeviceSerial(),
      mac_address: '',
    },
  });

  const activeBranchId = terminalForm.watch('activeBranch');
  const isEisEnabled = eisForm.watch('enableEis');
  const tinValue = eisForm.watch('tin');
  const eisEnvironment = eisForm.watch('eisEnvironment');
  const tacValue = terminalForm.watch('tac_code');
  const terminalIsActive = terminal?.status === 'active';
  const showActivationForm = !terminal || terminal.status !== 'active';

  const hasTin = Boolean((tinValue || '').trim());
  const hasBranchSelection = Boolean(activeBranchId);
  const hasTacInput = Boolean((tacValue || '').trim());
  const hasRequiredConfigurations = REQUIRED_CONFIG_TYPES.every((type) => configurationStatus[type].synced);
  const isLiveEnvironment = eisEnvironment === 'PROD';
  const isComplianceReady =
    isEisEnabled &&
    hasTin &&
    hasBranchSelection &&
    terminalIsActive &&
    hasRequiredConfigurations &&
    isLiveEnvironment;

  const persistBusinessSettingsCache = useCallback((updates: Record<string, unknown>) => {
    if (typeof window === 'undefined') return;
    let existing: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem('handypos-business-settings');
      if (raw) {
        existing = JSON.parse(raw);
      }
    } catch (error) {
      console.warn('[EIS Settings] Failed to parse cached business settings:', error);
      existing = {};
    }

    const next = { ...existing, ...updates };
    if (business?.id) {
      next.businessId = String(business.id);
    }
    localStorage.setItem('handypos-business-settings', JSON.stringify(next));
  }, [business?.id]);

  const persistTerminalCache = useCallback((branchId: string, value: Terminal | null) => {
    if (!business?.id || !branchId || typeof window === 'undefined') return;
    const cacheKey = getTerminalStorageKey(String(business.id), String(branchId));
    if (value) {
      localStorage.setItem(cacheKey, JSON.stringify(value));
    } else {
      localStorage.removeItem(cacheKey);
    }
  }, [business?.id]);

  const loadTerminalForBranch = useCallback(async (branchId: string) => {
    if (!business?.id || !branchId) {
      setTerminal(null);
      return;
    }

    setIsLoadingTerminal(true);
    try {
      const terminals = await authFetch.fetch<any[]>('/mra-eis/terminals/');
      const selected = Array.isArray(terminals)
        ? terminals.find((item) => String(item?.branch || '') === String(branchId))
        : null;

      if (selected) {
        const mapped = mapTerminalFromApi(selected);
        setTerminal(mapped);
        persistTerminalCache(branchId, mapped);
      } else {
        setTerminal(null);
        persistTerminalCache(branchId, null);
      }
    } catch (error) {
      console.error('Error loading terminal from backend:', error);
      const cacheKey = getTerminalStorageKey(String(business.id), String(branchId));
      const cachedTerminal = localStorage.getItem(cacheKey);
      if (cachedTerminal) {
        try {
          setTerminal(JSON.parse(cachedTerminal));
        } catch {
          setTerminal(null);
        }
      } else {
        setTerminal(null);
      }
    } finally {
      setIsLoadingTerminal(false);
    }
  }, [business?.id, persistTerminalCache]);

  const loadConfigurationStatus = useCallback(async () => {
    if (!business?.id) {
      setConfigurationStatus(createDefaultConfigurationStatus());
      return;
    }

    setIsLoadingConfigurationStatus(true);
    try {
      const response = await authFetch.fetch<any>(`/mra-eis/configurations/?business_id=${business.id}`);
      const configList = Array.isArray(response)
        ? response
        : Array.isArray(response?.results)
          ? response.results
          : [];

      const nextStatus = createDefaultConfigurationStatus();
      for (const item of configList) {
        const configType = String(item?.config_type || '');
        if (!isRequiredConfigType(configType)) continue;
        if (nextStatus[configType].synced) continue;
        nextStatus[configType] = {
          synced: item?.is_active !== false,
          version: item?.config_version ? String(item.config_version) : null,
        };
      }

      setConfigurationStatus(nextStatus);
    } catch (error) {
      console.error('Error loading configuration status:', error);
      setConfigurationStatus(createDefaultConfigurationStatus());
    } finally {
      setIsLoadingConfigurationStatus(false);
    }
  }, [business?.id]);

  // Load business settings
  useEffect(() => {
    if (business?.id) {
      const loadSettings = async () => {
        try {
          const backendBusiness = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
          
          if (backendBusiness) {
            const enableEisValue = backendBusiness.enable_eis === true || backendBusiness.enable_eis === 'true';
            const vatRegisteredValue = backendBusiness.vat_registered === true || backendBusiness.vat_registered === 'true';
            const mraEnrolledValue = backendBusiness.mra_enrolled === true || backendBusiness.mra_enrolled === 'true';
            const blockSalesValue = backendBusiness.block_sales_if_eis_down !== false && backendBusiness.block_sales_if_eis_down !== 'false';
            const rawBlockTaxMapping = backendBusiness.block_sales_if_tax_mapping_missing ?? backendBusiness.blockSalesIfTaxMappingMissing;
            const blockTaxMappingValue = rawBlockTaxMapping === undefined
              ? false
              : rawBlockTaxMapping !== false && rawBlockTaxMapping !== 'false';
            
            eisForm.reset({
              enableEis: enableEisValue,
              tin: backendBusiness.tin || '',
              vatRegistrationNumber: backendBusiness.vat_registration_number || '',
              vatRegistered: vatRegisteredValue,
              mraTaxpayerType: backendBusiness.mra_taxpayer_type || 'NON_VAT',
              mraEnrolled: mraEnrolledValue,
              eisEnvironment: backendBusiness.eis_environment || 'TEST',
              blockSalesIfEisDown: blockSalesValue,
              blockSalesIfTaxMappingMissing: blockTaxMappingValue,
            });
          }
        } catch (error) {
          console.error('Error loading EIS settings:', error);
        }
      };
      loadSettings();
    }
  }, [business?.id, eisForm]);

  // Load branches
  useEffect(() => {
    if (business?.id) {
      const loadBranches = async () => {
        try {
          const response = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
          if (response?.branches && Array.isArray(response.branches)) {
            const mappedBranches: Branch[] = response.branches.map((branch: any) => ({
              id: String(branch.id),
              name: branch.name || 'Branch',
              address: branch.address || '',
            }));
            setBranches(mappedBranches);

            const currentBranch = terminalForm.getValues('activeBranch');
            const storedBranch = localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY) || '';
            const hasCurrent = mappedBranches.some((branch) => branch.id === currentBranch);
            const hasStored = mappedBranches.some((branch) => branch.id === storedBranch);

            const nextBranch = hasCurrent
              ? currentBranch
              : hasStored
                ? storedBranch
                : mappedBranches[0]?.id || '';

            if (nextBranch) {
              terminalForm.setValue('activeBranch', nextBranch, { shouldValidate: true });
            }
          } else {
            setBranches([]);
            terminalForm.setValue('activeBranch', '');
          }
        } catch (error) {
          console.error('Error loading branches:', error);
        }
      };
      loadBranches();
    }
  }, [business?.id, terminalForm, ACTIVE_BRANCH_STORAGE_KEY]);

  useEffect(() => {
    if (!business?.id || !activeBranchId) {
      setTerminal(null);
      return;
    }
    localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, activeBranchId);
    loadTerminalForBranch(activeBranchId);
  }, [business?.id, activeBranchId, loadTerminalForBranch, ACTIVE_BRANCH_STORAGE_KEY]);

  useEffect(() => {
    if (!business?.id || !isEisEnabled) {
      setConfigurationStatus(createDefaultConfigurationStatus());
      return;
    }
    loadConfigurationStatus();
  }, [business?.id, isEisEnabled, terminal?.id, terminal?.status, loadConfigurationStatus]);

  const onEISSetupSubmit = async (data: EISSetupFormValues) => {
    if (!business?.id) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No business selected.',
      });
      return;
    }

    try {
      // Fetch current business data to include required fields
      const currentBusiness = await authFetch.fetch<any>(`/business/businesses/${business.id}/`);
      
      const backendPayload = {
        // Include required fields from current business
        name: currentBusiness?.name || '',
        business_type: currentBusiness?.business_type || 'generic',
        email: currentBusiness?.email || '',
        phone: currentBusiness?.phone || '',
        address: currentBusiness?.address || '',
        website: currentBusiness?.website || '',
        // MRA EIS Fields
        enable_eis: data.enableEis,
        tin: data.tin || '',
        vat_registration_number: data.vatRegistrationNumber || '',
        vat_registered: data.vatRegistered,
        mra_taxpayer_type: data.mraTaxpayerType,
        mra_enrolled: data.mraEnrolled,
        eis_environment: data.eisEnvironment,
        block_sales_if_eis_down: data.blockSalesIfEisDown,
        block_sales_if_tax_mapping_missing: data.blockSalesIfTaxMappingMissing,
      };

      console.log('[EIS Settings] Sending payload:', backendPayload);

      const response = await authFetch.fetch(`/business/businesses/${business.id}/`, {
        method: 'PUT',
        body: JSON.stringify(backendPayload),
      });

      if (response) {
        console.log('[EIS Settings] Response:', response);
        persistBusinessSettingsCache({
          enableEis: data.enableEis,
          eisEnvironment: data.eisEnvironment,
          blockSalesIfEisDown: data.blockSalesIfEisDown,
          blockSalesIfTaxMappingMissing: data.blockSalesIfTaxMappingMissing,
          tin: data.tin || '',
        });
        toast({
          title: 'Settings saved!',
          description: 'Your EIS settings have been updated.',
        });
      }
    } catch (error) {
      console.error('Error saving EIS settings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save settings.',
      });
    }
  };

  const onTerminalActivation = async (data: TerminalActivationFormValues) => {
    if (!business?.id) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Business not selected.',
      });
      return;
    }

    setIsActivatingTerminal(true);
    try {
      const response = await authFetch.fetch<any>(
        `/mra-eis/terminals/activate/?business_id=${business.id}&branch_id=${data.activeBranch}`,
        {
          method: 'POST',
          body: JSON.stringify({
            tac_code: data.tac_code,
            pos_name: data.pos_name,
            pos_version: data.pos_version,
            os_type: data.os_type,
            device_serial: data.device_serial,
            mac_address: data.mac_address || '',
          }),
        }
      );

      if (response?.id) {
        const terminalData = mapTerminalFromApi(response);
        setTerminal(terminalData);
        persistTerminalCache(data.activeBranch, terminalData);

        toast({
          title: terminalData.status === 'active' ? 'Terminal Activated!' : 'Terminal Registered',
          description: terminalData.status === 'active'
            ? `Terminal ${terminalData.terminal_id} has been successfully activated.`
            : `Terminal ${terminalData.terminal_id} is pending activation confirmation.`,
        });

        terminalForm.reset({
          activeBranch: data.activeBranch,
          tac_code: '',
          pos_name: data.pos_name,
          pos_version: data.pos_version,
          os_type: data.os_type,
          device_serial: data.device_serial,
          mac_address: data.mac_address || '',
        });
      }
    } catch (error: any) {
      console.error('Terminal activation error:', error);
      toast({
        variant: 'destructive',
        title: 'Activation Failed',
        description: error.message || 'Failed to activate terminal. Please check your TAC and try again.',
      });
    } finally {
      setIsActivatingTerminal(false);
    }
  };

  const onRefreshTerminalStatus = useCallback(async (options?: { silent?: boolean }) => {
    if (!terminal?.id) return;

    setIsRefreshingTerminalStatus(true);
    try {
      const statusResponse = await authFetch.fetch<any>(`/mra-eis/terminals/${terminal.id}/status/`);
      const refreshedTerminal: Terminal = {
        ...terminal,
        status: (statusResponse?.status || terminal.status) as Terminal['status'],
        is_online: Boolean(statusResponse?.is_online),
        online_invoice_counter: Number(statusResponse?.online_invoice_counter || 0),
        offline_invoice_counter: Number(statusResponse?.offline_invoice_counter || 0),
        pending_offline_invoices: Number(statusResponse?.pending_offline_invoices || 0),
        last_sync_at: statusResponse?.last_sync_at || terminal.last_sync_at,
        token_expires_at: statusResponse?.token_expires_at || terminal.token_expires_at,
      };

      setTerminal(refreshedTerminal);
      if (activeBranchId) {
        persistTerminalCache(activeBranchId, refreshedTerminal);
      }
      if (refreshedTerminal.status === 'active') {
        await loadConfigurationStatus();
      }

      if (!options?.silent) {
        toast({
          title: 'Terminal status refreshed',
          description: `Terminal is ${refreshedTerminal.status.replace('_', ' ')}.`,
        });
      }
    } catch (error: any) {
      console.error('Refresh terminal status error:', error);
      if (!options?.silent) {
        toast({
          variant: 'destructive',
          title: 'Failed to refresh status',
          description: error?.message || 'Could not fetch terminal status.',
        });
      }
    } finally {
      setIsRefreshingTerminalStatus(false);
    }
  }, [terminal, activeBranchId, persistTerminalCache, loadConfigurationStatus, toast]);

  const formatTimestamp = (value?: string) => {
    if (!value) return 'N/A';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'N/A';
    return parsed.toLocaleString();
  };

  useEffect(() => {
    if (!terminal?.id || terminal.status !== 'active') {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      void onRefreshTerminalStatus({ silent: true });
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [terminal?.id, terminal?.status, onRefreshTerminalStatus]);

  const onRefreshTerminalToken = async () => {
    if (!terminal?.id) return;

    setIsRefreshingTerminalToken(true);
    try {
      const response = await authFetch.fetch<any>(`/mra-eis/terminals/${terminal.id}/refresh_token/`, {
        method: 'POST',
      });
      const refreshedTerminal = mapTerminalFromApi(response);
      setTerminal(refreshedTerminal);
      if (activeBranchId) {
        persistTerminalCache(activeBranchId, refreshedTerminal);
      }
      toast({
        title: 'Token refreshed',
        description: 'MRA terminal token has been refreshed.',
      });
    } catch (error: any) {
      console.error('Refresh terminal token error:', error);
      toast({
        variant: 'destructive',
        title: 'Token refresh failed',
        description: error?.message || 'Could not refresh MRA token.',
      });
    } finally {
      setIsRefreshingTerminalToken(false);
    }
  };

  const onSyncConfigurations = async () => {
    if (!business?.id) return;
    if (!terminal) {
      toast({
        variant: 'destructive',
        title: 'Terminal required',
        description: 'Activate a terminal before syncing MRA configurations.',
      });
      return;
    }

    setIsSyncingConfigurations(true);
    try {
      const response = await authFetch.fetch<any>(`/mra-eis/configurations/sync_from_mra/?business_id=${business.id}`, {
        method: 'POST',
        body: JSON.stringify({
          config_types: ['tax_rules', 'receipt_format', 'product_codes'],
        }),
      });

      toast({
        title: 'Configurations synced',
        description: `MRA config sync status: ${String(response?.status || 'success')}.`,
      });

      await onRefreshTerminalStatus();
      await loadConfigurationStatus();
    } catch (error: any) {
      console.error('Sync configuration error:', error);
      toast({
        variant: 'destructive',
        title: 'Configuration sync failed',
        description: error?.message || 'Could not sync configurations from MRA.',
      });
    } finally {
      setIsSyncingConfigurations(false);
    }
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTac(true);
    setTimeout(() => setCopiedTac(false), 2000);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="default">Active</Badge>;
      case 'pending_activation':
        return <Badge variant="secondary">Pending</Badge>;
      case 'suspended':
        return <Badge variant="destructive">Suspended</Badge>;
      case 'deactivated':
        return <Badge variant="outline">Deactivated</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Zap className="h-8 w-8 text-primary" />
          MRA EIS Integration
        </h1>
        <p className="text-muted-foreground mt-2">
          Configure your Malawi Revenue Authority Electronic Invoicing System compliance in one place.
        </p>
      </div>

      {/* Section 1: EIS Setup */}
      <Card>
        <CardHeader 
          className="cursor-pointer hover:bg-muted/50"
          onClick={() => toggleSection('setup')}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>1. EIS Setup</CardTitle>
                <CardDescription>Enable and configure MRA EIS integration</CardDescription>
              </div>
            </div>
            {expandedSections.setup ? <ChevronUp /> : <ChevronDown />}
          </div>
        </CardHeader>

        {expandedSections.setup && (
          <CardContent>
            <FormProvider {...eisForm}>
              <form onSubmit={eisForm.handleSubmit(onEISSetupSubmit)} className="space-y-6">
                {/* Enable/Disable */}
                <div className="p-4 rounded-lg border border-border">
                  <FormField
                    control={eisForm.control}
                    name="enableEis"
                    render={({ field }) => {
                      const isEisEnabled = field.value;
                      
                      if (isEisEnabled) {
                        // Once enabled, show locked status instead of checkbox
                        return (
                          <FormItem>
                            <div className="p-4 rounded-lg border border-border flex items-start gap-3">
                              <CheckCircle2 className="h-6 w-6 text-foreground mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="font-semibold text-sm">MRA EIS is Enabled & Locked</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  Your business is now enrolled in the MRA Electronic Invoicing System. This setting cannot be changed to ensure compliance with MRA requirements and maintain audit trail integrity.
                                </p>
                                <p className="text-xs text-muted-foreground mt-2 font-medium flex items-center gap-1">
                                  <CheckCircle2 className="h-3 w-3" />
                                  Automatic invoice submission to MRA is active
                                </p>
                              </div>
                            </div>
                          </FormItem>
                        );
                      }
                      
                      // Before enabled, show checkbox
                      return (
                        <FormItem className="flex items-center space-x-3">
                          <FormControl>
                            <input
                              type="checkbox"
                              checked={field.value}
                              onChange={field.onChange}
                              className="h-5 w-5 rounded border-input cursor-pointer"
                            />
                          </FormControl>
                          <div>
                            <FormLabel className="mb-0 font-semibold">Enable MRA EIS Integration</FormLabel>
                            <p className="text-sm text-muted-foreground mt-1">
                              Check to enable automatic invoice submission to MRA. This cannot be undone.
                            </p>
                          </div>
                        </FormItem>
                      );
                    }}
                  />
                </div>

                {/* Taxpayer Information - Only if enabled */}
                {eisForm.watch('enableEis') && (
                  <div className="p-4 rounded-lg border border-border space-y-4">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Taxpayer Information
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField
                        control={eisForm.control}
                        name="tin"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm">TIN (Taxpayer ID)</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g., 123456789" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={eisForm.control}
                        name="vatRegistrationNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm">VAT Registration Number</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g., VAT-123456" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                {/* VAT Status - Only if enabled */}
                {eisForm.watch('enableEis') && (
                  <div className="p-4 rounded-lg border border-border space-y-4">
                    <h3 className="font-semibold text-sm">VAT Status</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField
                        control={eisForm.control}
                        name="vatRegistered"
                        render={({ field }) => (
                          <FormItem className="flex items-center space-x-2">
                            <FormControl>
                              <input
                                type="checkbox"
                                checked={field.value}
                                onChange={field.onChange}
                                className="h-4 w-4 rounded border-input"
                              />
                            </FormControl>
                            <FormLabel className="mb-0 text-sm">VAT Registered</FormLabel>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={eisForm.control}
                        name="mraTaxpayerType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm">Taxpayer Type</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="VAT">VAT Registered</SelectItem>
                                <SelectItem value="NON_VAT">Non-VAT Registered</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                {/* Enrollment & Environment - Only if enabled */}
                {eisForm.watch('enableEis') && (
                  <div className="p-4 rounded-lg border border-border space-y-4">
                    <h3 className="font-semibold text-sm">Enrollment & Environment</h3>
                    <div className="space-y-4">
                      <FormField
                        control={eisForm.control}
                        name="mraEnrolled"
                        render={({ field }) => (
                          <FormItem className="flex items-center space-x-2">
                            <FormControl>
                              <input
                                type="checkbox"
                                checked={field.value}
                                onChange={field.onChange}
                                className="h-4 w-4 rounded border-input"
                              />
                            </FormControl>
                            <div>
                              <FormLabel className="mb-0 text-sm">Enrolled in MRA EIS</FormLabel>
                              <p className="text-xs text-muted-foreground">Your business is registered with MRA</p>
                            </div>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={eisForm.control}
                        name="eisEnvironment"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm">Environment</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="TEST">Test/Sandbox (for testing)</SelectItem>
                                <SelectItem value="PROD">Production (live)</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={eisForm.control}
                        name="blockSalesIfEisDown"
                        render={({ field }) => (
                          <FormItem className="flex items-center space-x-2 p-3 rounded border border-border">
                            <FormControl>
                              <input
                                type="checkbox"
                                checked={field.value}
                                onChange={field.onChange}
                                className="h-4 w-4 rounded border-input"
                              />
                            </FormControl>
                            <div>
                              <FormLabel className="mb-0 text-sm font-medium">Block Sales if EIS Down</FormLabel>
                              <p className="text-xs text-muted-foreground">Stop sales if MRA system is unavailable</p>
                            </div>
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                <div className="p-4 rounded-lg border border-border space-y-3">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    POS Enforcement
                  </h3>
                  <FormField
                    control={eisForm.control}
                    name="blockSalesIfTaxMappingMissing"
                    render={({ field }) => (
                      <FormItem className="flex items-center space-x-2 p-3 rounded border border-border">
                        <FormControl>
                          <input
                            type="checkbox"
                            checked={field.value}
                            onChange={field.onChange}
                            className="h-4 w-4 rounded border-input"
                          />
                        </FormControl>
                        <div>
                          <FormLabel className="mb-0 text-sm font-medium">Block sales without tax mapping</FormLabel>
                          <p className="text-xs text-muted-foreground">Require approved & synced MRA mappings before a product can be sold.</p>
                        </div>
                      </FormItem>
                    )}
                  />
                </div>

                {!eisForm.watch('enableEis') && (
                  <div className="p-3 rounded border border-border text-sm text-muted-foreground">
                    Enable MRA EIS above to configure tax compliance settings.
                  </div>
                )}

                <Button type="submit" className="w-full">Save EIS Settings</Button>
              </form>
            </FormProvider>
          </CardContent>
        )}
      </Card>

      {/* Readiness Checklist */}
      {isEisEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Terminal Activation Checklist</CardTitle>
            <CardDescription>Confirm these items before going live on MRA EIS.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">EIS integration enabled</p>
                <p className="text-xs text-muted-foreground">Enable MRA EIS in setup.</p>
              </div>
              <Badge variant={isEisEnabled ? 'default' : 'outline'}>{isEisEnabled ? 'Done' : 'Pending'}</Badge>
            </div>

            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">TIN captured</p>
                <p className="text-xs text-muted-foreground">Required for compliant invoice submission.</p>
              </div>
              <Badge variant={hasTin ? 'default' : 'outline'}>{hasTin ? 'Done' : 'Missing'}</Badge>
            </div>

            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Branch selected</p>
                <p className="text-xs text-muted-foreground">Terminal activation is branch specific.</p>
              </div>
              <Badge variant={hasBranchSelection ? 'default' : 'outline'}>{hasBranchSelection ? 'Done' : 'Missing'}</Badge>
            </div>

            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Terminal active</p>
                <p className="text-xs text-muted-foreground">Terminal must be activated with MRA.</p>
              </div>
              <Badge variant={terminalIsActive ? 'default' : 'outline'}>{terminalIsActive ? 'Active' : 'Pending'}</Badge>
            </div>

            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Configurations synced</p>
                <p className="text-xs text-muted-foreground">
                  {isLoadingConfigurationStatus ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking sync status...
                    </span>
                  ) : (
                    REQUIRED_CONFIG_TYPES.map((type) => {
                      const item = configurationStatus[type];
                      return `${CONFIG_LABELS[type]}: ${item.synced ? `v${item.version || '-'}` : 'missing'}`;
                    }).join(' • ')
                  )}
                </p>
              </div>
              <Badge variant={hasRequiredConfigurations ? 'default' : 'outline'}>
                {hasRequiredConfigurations ? 'Synced' : 'Incomplete'}
              </Badge>
            </div>

            <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Environment set to PROD</p>
                <p className="text-xs text-muted-foreground">Switch from TEST to PROD only when ready.</p>
              </div>
              <Badge variant={isLiveEnvironment ? 'default' : 'outline'}>{isLiveEnvironment ? 'Live' : 'TEST'}</Badge>
            </div>

            {!terminalIsActive && (
              <div className="p-3 rounded-lg border border-border bg-background flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">TAC entered for activation</p>
                  <p className="text-xs text-muted-foreground">Needed to activate this branch terminal.</p>
                </div>
                <Badge variant={hasTacInput ? 'secondary' : 'outline'}>{hasTacInput ? 'Ready' : 'Not Entered'}</Badge>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <div className={`w-full p-3 rounded-lg border text-sm ${isComplianceReady ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : 'border-amber-500/35 bg-amber-500/15 text-amber-900 dark:text-amber-300'}`}>
              {isComplianceReady
                ? 'Compliance checklist complete. This business is ready for MRA EIS live operation.'
                : 'Checklist is incomplete. Complete the pending items before switching to live operation.'}
            </div>
          </CardFooter>
        </Card>
      )}

      {/* Section 2: Terminal Activation */}
      {isEisEnabled && (
        <Card>
          <CardHeader 
            className="cursor-pointer hover:bg-muted/50"
            onClick={() => toggleSection('terminal')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <CardTitle>2. Terminal Activation</CardTitle>
                  <CardDescription>Activate your POS terminal with MRA</CardDescription>
                </div>
              </div>
              {expandedSections.terminal ? <ChevronUp /> : <ChevronDown />}
            </div>
          </CardHeader>

          {expandedSections.terminal && (
            <CardContent className="space-y-6">
              {activeBranchId && (
                <div className="p-3 bg-muted/40 rounded-lg border border-border text-sm">
                  <span className="text-muted-foreground">Selected branch:</span>{' '}
                  <span className="font-medium">
                    {branches.find((branch) => branch.id === activeBranchId)?.name || activeBranchId}
                  </span>
                </div>
              )}

              {isLoadingTerminal && (
                <div className="p-4 rounded-lg border border-border flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading terminal status...
                </div>
              )}

              {/* Terminal Status */}
              {terminal ? (
                <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Terminal Status</h3>
                    {getStatusBadge(terminal.status)}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Terminal ID</p>
                      <p className="font-mono text-xs">{terminal.terminal_id}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">POS Name</p>
                      <p className="font-medium">{terminal.pos_name}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Online Status</p>
                      <p className="font-medium">{terminal.is_online ? '🟢 Online' : '🔴 Offline'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Invoices</p>
                      <p className="font-medium">{terminal.online_invoice_counter + terminal.offline_invoice_counter}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Pending Offline</p>
                      <p className="font-medium">{terminal.pending_offline_invoices ?? 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Last Sync</p>
                      <p className="font-medium text-xs">{formatTimestamp(terminal.last_sync_at)}</p>
                    </div>
                  </div>

                  {terminal.activated_at && (
                    <p className="text-xs text-muted-foreground">
                      Activated: {new Date(terminal.activated_at).toLocaleString()}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void onRefreshTerminalStatus();
                      }}
                      disabled={isRefreshingTerminalStatus}
                    >
                      {isRefreshingTerminalStatus ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Refreshing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Refresh Status
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRefreshTerminalToken}
                      disabled={isRefreshingTerminalToken}
                    >
                      {isRefreshingTerminalToken ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Refreshing Token...
                        </>
                      ) : (
                        <>
                          <Clock className="mr-2 h-4 w-4" />
                          Refresh Token
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-sm text-amber-900 dark:text-amber-300">No Terminal Found for This Branch</p>
                    <p className="text-sm text-amber-800 dark:text-amber-400 mt-1">
                      Activate a terminal below to start using MRA EIS for the selected branch.
                    </p>
                  </div>
                </div>
              )}

              {/* Terminal Activation Form */}
              {showActivationForm && (
                <FormProvider {...terminalForm}>
                  <form onSubmit={terminalForm.handleSubmit(onTerminalActivation)} className="space-y-4">
                    <div className="p-4 rounded-lg border border-sky-500/30 bg-sky-500/10">
                      <p className="text-sm text-sky-900 dark:text-sky-300">
                        <strong>{terminal ? 'Re-activation:' : 'What you need:'}</strong>{' '}
                        Terminal Activation Code (TAC) from MRA
                      </p>
                    </div>

                    {/* Branch Selection */}
                    <FormField
                      control={terminalForm.control}
                      name="activeBranch"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Select Branch</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a branch" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {branches.map(branch => (
                                <SelectItem key={branch.id} value={branch.id}>
                                  {branch.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* TAC Code */}
                    <FormField
                      control={terminalForm.control}
                      name="tac_code"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Terminal Activation Code (TAC)</FormLabel>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input 
                                placeholder="Enter your TAC from MRA" 
                                type={showTacPassword ? "text" : "password"}
                                {...field} 
                              />
                            </FormControl>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => setShowTacPassword(!showTacPassword)}
                            >
                              {showTacPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Your unique activation code from Malawi Revenue Authority
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* POS Details */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField
                        control={terminalForm.control}
                        name="pos_name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>POS Name</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g., Handy POS" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={terminalForm.control}
                        name="pos_version"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>POS Version</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g., 1.0.0" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* Device Details */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField
                        control={terminalForm.control}
                        name="os_type"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Operating System</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="Web">Web Browser</SelectItem>
                                <SelectItem value="Windows">Windows</SelectItem>
                                <SelectItem value="Linux">Linux</SelectItem>
                                <SelectItem value="macOS">macOS</SelectItem>
                                <SelectItem value="Android">Android</SelectItem>
                                <SelectItem value="iOS">iOS</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={terminalForm.control}
                        name="device_serial"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Device Serial</FormLabel>
                            <div className="flex gap-2">
                              <FormControl>
                                <Input placeholder="Device serial" {...field} readOnly className="bg-muted" />
                              </FormControl>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                onClick={() => copyToClipboard(field.value)}
                              >
                                {copiedTac ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* MAC Address */}
                    <FormField
                      control={terminalForm.control}
                      name="mac_address"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>MAC Address (Optional)</FormLabel>
                          <FormControl>
                            <Input placeholder="Device MAC address" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isActivatingTerminal || branches.length === 0 || !activeBranchId}
                    >
                      {isActivatingTerminal ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Activating...
                        </>
                      ) : (
                        <>
                          <Zap className="mr-2 h-4 w-4" />
                          Activate Terminal
                        </>
                      )}
                    </Button>
                  </form>
                </FormProvider>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* Section 3: Configuration Management */}
      {isEisEnabled && (
        <Card>
          <CardHeader 
            className="cursor-pointer hover:bg-muted/50"
            onClick={() => toggleSection('configuration')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                <div>
                  <CardTitle>3. Configuration Management</CardTitle>
                  <CardDescription>MRA configurations and settings</CardDescription>
                </div>
              </div>
              {expandedSections.configuration ? <ChevronUp /> : <ChevronDown />}
            </div>
          </CardHeader>

          {expandedSections.configuration && (
            <CardContent className="space-y-4">
              <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <p className="text-sm text-emerald-900 dark:text-emerald-300">
                  <strong>ℹ️ Info:</strong> MRA configurations are automatically fetched and stored when your terminal is active.
                </p>
              </div>

              <div className="space-y-2">
                {REQUIRED_CONFIG_TYPES.map((type) => (
                  <div key={type} className="p-3 border rounded-lg flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{CONFIG_LABELS[type]}</p>
                      <p className="text-xs text-muted-foreground">
                        {configurationStatus[type].synced
                          ? `v${configurationStatus[type].version || '-'}`
                          : 'Not synced yet'}
                      </p>
                    </div>
                    <Badge variant={configurationStatus[type].synced ? 'default' : 'outline'}>
                      {configurationStatus[type].synced ? 'Synced' : 'Not Synced'}
                    </Badge>
                  </div>
                ))}
              </div>

              {isLoadingConfigurationStatus && (
                <div className="p-3 rounded-lg border border-border text-sm text-muted-foreground inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Refreshing configuration status...
                </div>
              )}

              <Button
                variant="outline"
                className="w-full"
                disabled={!terminalIsActive || isSyncingConfigurations || isLoadingConfigurationStatus}
                onClick={onSyncConfigurations}
              >
                {isSyncingConfigurations ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Syncing Configurations...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Sync Configurations {!terminalIsActive && '(Requires Active Terminal)'}
                  </>
                )}
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {/* Section 4: Product Mapping */}
      {isEisEnabled && (
        <Card>
          <CardHeader 
            className="cursor-pointer hover:bg-muted/50"
            onClick={() => toggleSection('products')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                <div>
                  <CardTitle>4. Product Mapping</CardTitle>
                  <CardDescription>Map products to MRA codes</CardDescription>
                </div>
              </div>
              {expandedSections.products ? <ChevronUp /> : <ChevronDown />}
            </div>
          </CardHeader>

          {expandedSections.products && (
            <CardContent className="space-y-4">
              <div className="p-4 rounded-lg border border-violet-500/30 bg-violet-500/10">
                <p className="text-sm text-violet-900 dark:text-violet-300">
                  <strong>📦 Info:</strong> Map your products to MRA product codes and tax categories in the Inventory section.
                </p>
              </div>

              <div className="text-center py-8 text-muted-foreground">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Go to Inventory → MRA Mappings to map your products</p>
              </div>

              <Button variant="outline" className="w-full" disabled={!terminalIsActive}>
                <Package className="mr-2 h-4 w-4" />
                Manage Product Mappings {!terminalIsActive && '(Requires Active Terminal)'}
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {/* Info Box */}
      {!isEisEnabled && (
        <Card className="border-sky-500/30 bg-sky-500/10">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-sky-600 dark:text-sky-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-sm text-sky-900 dark:text-sky-300">Get Started with MRA EIS</p>
                <p className="text-sm text-sky-800 dark:text-sky-400 mt-1">
                  Enable MRA EIS integration above to configure your business for tax compliance and automatic invoice submission to the Malawi Revenue Authority.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
