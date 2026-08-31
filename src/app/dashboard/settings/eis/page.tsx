'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  Terminal as TerminalIcon,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';

type EisEnvironment = 'TEST' | 'PROD';
type TaxpayerType = 'VAT' | 'NON_VAT';

interface EisSettings {
  enableEis: boolean;
  tin: string;
  vatRegistrationNumber: string;
  vatRegistered: boolean;
  mraTaxpayerType: TaxpayerType;
  mraEnrolled: boolean;
  eisEnvironment: EisEnvironment;
  blockSalesIfEisDown: boolean;
  blockSalesIfTaxMappingMissing: boolean;
}

interface Branch {
  id: string;
  name: string;
  address?: string;
}

interface Terminal {
  id: string;
  terminalId: string;
  mraTerminalId?: string;
  deviceSerial?: string;
  mraTaxpayerId?: number;
  terminalPosition?: number;
  status: string;
  isOnline: boolean;
  activatedAt?: string;
  lastSyncAt?: string;
}

interface ConfigurationSummary {
  count: number;
  types: string[];
  lastSyncedAt?: string;
}

const DEFAULT_SETTINGS: EisSettings = {
  enableEis: false,
  tin: '',
  vatRegistrationNumber: '',
  vatRegistered: false,
  mraTaxpayerType: 'NON_VAT',
  mraEnrolled: false,
  eisEnvironment: 'TEST',
  blockSalesIfEisDown: true,
  blockSalesIfTaxMappingMissing: false,
};

const DEFAULT_CONFIG: ConfigurationSummary = { count: 0, types: [] };
const ACTIVE_BRANCH_KEY = 'handypos-active-branch';
const DEVICE_SERIAL_KEY = 'handypos-device-serial';
const LEGACY_DEVICE_SERIAL_KEY = 'handypos-eis-device-serial';
const EIS_POS_NAME = process.env.NEXT_PUBLIC_MRA_EIS_POS_NAME || 'Handy POS';
const CONFIG_TYPES = [
  'global_configuration',
  'terminal_configuration',
  'taxpayer_configuration',
  'tax_rules',
  'receipt_format',
  'product_codes',
  'system_settings',
];

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
};

const asList = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
};

const formatDate = (value?: string): string => {
  if (!value) return 'Not yet synced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet synced';
  return date.toLocaleString();
};

const getDetectedOS = (): string => {
  if (typeof window === 'undefined') return 'Web';
  const userAgent = window.navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'Android';
  if (userAgent.includes('iphone') || userAgent.includes('ipad')) return 'iOS';
  if (userAgent.includes('win')) return 'Windows';
  if (userAgent.includes('mac')) return 'macOS';
  if (userAgent.includes('linux')) return 'Linux';
  return 'Web';
};

const getDeviceSerial = (): string => {
  if (typeof window === 'undefined') return 'handy-pos-device';
  const existing = localStorage.getItem(DEVICE_SERIAL_KEY) || localStorage.getItem(LEGACY_DEVICE_SERIAL_KEY);
  if (existing) return existing;

  const serial = `HANDY-${getDetectedOS().slice(0, 3).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  localStorage.setItem(DEVICE_SERIAL_KEY, serial);
  return serial;
};

const readEisValue = (businessData: any, key: string): unknown => {
  return businessData?.[key] ?? businessData?.settings?.[key];
};

const mapSettings = (businessData: any): EisSettings => {
  const environment = String(readEisValue(businessData, 'eis_environment') || 'TEST').toUpperCase();
  const taxpayerType = String(businessData?.mra_taxpayer_type || 'NON_VAT').toUpperCase();

  return {
    enableEis: toBoolean(readEisValue(businessData, 'enable_eis')),
    tin: String(businessData?.tin || '').trim(),
    vatRegistrationNumber: String(businessData?.vat_registration_number || '').trim(),
    vatRegistered: toBoolean(businessData?.vat_registered),
    mraTaxpayerType: taxpayerType === 'VAT' ? 'VAT' : 'NON_VAT',
    mraEnrolled: toBoolean(businessData?.mra_enrolled),
    eisEnvironment: environment === 'PROD' ? 'PROD' : 'TEST',
    blockSalesIfEisDown: toBoolean(readEisValue(businessData, 'block_sales_if_eis_down'), true),
    blockSalesIfTaxMappingMissing: toBoolean(
      readEisValue(businessData, 'block_sales_if_tax_mapping_missing')
    ),
  };
};

const mapTerminal = (payload: any): Terminal => ({
  id: String(payload?.id || ''),
  terminalId: String(payload?.terminal_id || ''),
  mraTerminalId: String(payload?.mra_terminal_id || ''),
  deviceSerial: String(payload?.device_serial || ''),
  mraTaxpayerId: payload?.mra_taxpayer_id ? Number(payload.mra_taxpayer_id) : undefined,
  terminalPosition: payload?.terminal_position ? Number(payload.terminal_position) : undefined,
  status: String(payload?.status || 'pending_activation'),
  isOnline: toBoolean(payload?.is_online),
  activatedAt: payload?.activated_at,
  lastSyncAt: payload?.last_sync_at,
});

export default function EISSettingsPage() {
  const { business } = useAuth();
  const businessId = String(business?.id || '');
  const [settings, setSettings] = useState<EisSettings>(DEFAULT_SETTINGS);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [configuration, setConfiguration] = useState<ConfigurationSummary>(DEFAULT_CONFIG);
  const [tacCode, setTacCode] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshingTerminal, setIsRefreshingTerminal] = useState(false);
  const [isSyncingConfiguration, setIsSyncingConfiguration] = useState(false);

  const selectedBranch = useMemo(
    () => branches.find((branch) => branch.id === selectedBranchId),
    [branches, selectedBranchId]
  );
  const terminalIsActive = terminal?.status === 'active';
  const terminalIsPending = Boolean(terminal && !terminalIsActive);

  const loadTerminal = useCallback(async (branchId: string) => {
    if (!businessId || !branchId) {
      setTerminal(null);
      return;
    }

    try {
      const response = await authFetch.fetch('/mra-eis/terminals/');
      const branchTerminals = asList(response).filter(
        (item) => String(item?.business || '') === businessId
          && String(item?.branch || '') === String(branchId)
      );
      const deviceSerial = getDeviceSerial().toLowerCase();
      const match = branchTerminals.find(
        (item) => String(item?.device_serial || '').trim().toLowerCase() === deviceSerial
      ) || branchTerminals[0];
      setTerminal(match ? mapTerminal(match) : null);
    } catch (error) {
      console.error('[EIS] Failed to load terminal:', error);
      setTerminal(null);
    }
  }, [businessId]);

  const loadConfiguration = useCallback(async () => {
    if (!businessId) return;

    try {
      const response = await authFetch.fetch(
        `/mra-eis/configurations/?business_id=${encodeURIComponent(businessId)}`
      );
      const rows = asList(response);
      const activeRows = rows.filter((row) => row?.is_active !== false);
      const types = Array.from(
        new Set(activeRows.map((row) => String(row?.config_type || '')).filter(Boolean))
      );
      const latest = activeRows
        .map((row) => row?.fetched_from_mra_at || row?.created_at)
        .filter(Boolean)
        .sort()
        .at(-1);

      setConfiguration({ count: activeRows.length, types, lastSyncedAt: latest });
    } catch (error) {
      console.error('[EIS] Failed to load configuration status:', error);
      setConfiguration(DEFAULT_CONFIG);
    }
  }, [businessId]);

  useEffect(() => {
    if (!businessId) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    const load = async () => {
      setIsLoading(true);
      try {
        const [businessResponse, branchResponse] = await Promise.all([
          authFetch.fetch(`/business/businesses/${businessId}/`),
          authFetch.fetch(`/business/businesses/${businessId}/branches/`),
        ]);

        if (!isMounted) return;
        setSettings(mapSettings(businessResponse));

        const loadedBranches = asList(branchResponse)
          .map((branch) => ({
            id: String(branch?.id || ''),
            name: String(branch?.name || 'Unnamed branch'),
            address: String(branch?.address || ''),
          }))
          .filter((branch) => branch.id);
        setBranches(loadedBranches);

        const storedBranch = localStorage.getItem(ACTIVE_BRANCH_KEY) || '';
        const preferredBranch = loadedBranches.some((branch) => branch.id === storedBranch)
          ? storedBranch
          : loadedBranches[0]?.id || '';
        setSelectedBranchId(preferredBranch);
      } catch (error) {
        console.error('[EIS] Failed to load settings:', error);
        toast({
          title: 'Could not load EIS settings',
          description: errorMessage(error, 'Please try again.'),
          variant: 'destructive',
        });
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    void load();
    return () => {
      isMounted = false;
    };
  }, [businessId]);

  useEffect(() => {
    if (!selectedBranchId) return;
    localStorage.setItem(ACTIVE_BRANCH_KEY, selectedBranchId);
    void loadTerminal(selectedBranchId);
  }, [loadTerminal, selectedBranchId]);

  useEffect(() => {
    if (settings.enableEis) void loadConfiguration();
  }, [loadConfiguration, settings.enableEis]);

  const updateSetting = <K extends keyof EisSettings>(key: K, value: EisSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const saveSettings = async (): Promise<boolean> => {
    if (!businessId) return false;

    setIsSaving(true);
    try {
      const response = await authFetch.fetch(`/business/businesses/${businessId}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          enable_eis: settings.enableEis,
          tin: settings.tin.trim(),
          vat_registration_number: settings.vatRegistered
            ? settings.vatRegistrationNumber.trim()
            : '',
          vat_registered: settings.vatRegistered,
          mra_taxpayer_type: settings.mraTaxpayerType,
          mra_enrolled: settings.mraEnrolled,
          eis_environment: settings.eisEnvironment,
          block_sales_if_eis_down: settings.blockSalesIfEisDown,
          block_sales_if_tax_mapping_missing: settings.blockSalesIfTaxMappingMissing,
        }),
      });

      const nextSettings = mapSettings(response);
      setSettings(nextSettings);
      localStorage.setItem(
        'handypos-business-settings',
        JSON.stringify({
          businessId,
          enable_eis: nextSettings.enableEis,
          eis_environment: nextSettings.eisEnvironment,
          block_sales_if_eis_down: nextSettings.blockSalesIfEisDown,
          block_sales_if_tax_mapping_missing: nextSettings.blockSalesIfTaxMappingMissing,
        })
      );
      toast({ title: 'EIS settings saved' });
      return true;
    } catch (error) {
      toast({
        title: 'Could not save EIS settings',
        description: errorMessage(error, 'Please try again.'),
        variant: 'destructive',
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const connectTerminal = async () => {
    if (!businessId || !selectedBranchId || !tacCode.trim()) {
      toast({
        title: 'Terminal Activation Code required',
        description: 'Choose a branch and enter the TAC issued by MRA.',
        variant: 'destructive',
      });
      return;
    }

    const saved = await saveSettings();
    if (!saved) return;

    setIsConnecting(true);
    try {
      const response = await authFetch.fetch(
        `/mra-eis/terminals/activate/?business_id=${encodeURIComponent(businessId)}&branch_id=${encodeURIComponent(selectedBranchId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            tac_code: tacCode.trim(),
            pos_name: EIS_POS_NAME,
            pos_version: process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0',
            os_type: getDetectedOS(),
            device_serial: getDeviceSerial(),
            mac_address: '',
          }),
        }
      );

      setTerminal(mapTerminal(response));
      setTacCode('');
      toast({ title: 'Branch connected to MRA EIS' });
    } catch (error) {
      toast({
        title: 'Could not connect this branch',
        description: errorMessage(error, 'Check the TAC and try again.'),
        variant: 'destructive',
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const refreshTerminal = async () => {
    if (!terminal?.id) return;
    setIsRefreshingTerminal(true);
    try {
      const response = await authFetch.fetch(`/mra-eis/terminals/${terminal.id}/status/?ping=true`);
      setTerminal((current) => current ? {
        ...current,
        status: String(response?.status || current.status),
        isOnline: toBoolean(response?.is_online, current.isOnline),
        lastSyncAt: response?.last_sync_at || current.lastSyncAt,
      } : current);
      toast({ title: 'Terminal status refreshed' });
    } catch (error) {
      toast({
        title: 'Could not refresh terminal status',
        description: errorMessage(error, 'Please try again.'),
        variant: 'destructive',
      });
    } finally {
      setIsRefreshingTerminal(false);
    }
  };

  const syncConfiguration = async () => {
    if (!businessId || !terminalIsActive) return;
    setIsSyncingConfiguration(true);
    try {
      const params = new URLSearchParams({ business_id: businessId });
      if (terminal?.id) params.set('terminal_id', terminal.id);
      await authFetch.fetch(
        `/mra-eis/configurations/sync_from_mra/?${params.toString()}`,
        {
          method: 'POST',
          body: JSON.stringify({ config_types: CONFIG_TYPES }),
        }
      );
      await loadConfiguration();
      toast({ title: 'MRA configuration synced' });
    } catch (error) {
      toast({
        title: 'Could not sync MRA configuration',
        description: errorMessage(error, 'Connect an active terminal and try again.'),
        variant: 'destructive',
      });
    } finally {
      setIsSyncingConfiguration(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">MRA EIS</h2>
            <Badge variant={settings.enableEis ? 'default' : 'secondary'}>
              {settings.enableEis ? 'Enabled' : 'Not enabled'}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect Handy POS to Malawi Revenue Authority Electronic Invoicing when your business is ready.
          </p>
        </div>
        <Button onClick={saveSettings} disabled={isSaving} className="w-full sm:w-auto">
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save settings
        </Button>
      </div>

      <Card className="border-primary/30">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <p className="font-medium">Enable MRA EIS</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep this off while you are preparing your MRA registration and TAC.
              </p>
            </div>
          </div>
          <Switch
            checked={settings.enableEis}
            onCheckedChange={(checked) => updateSetting('enableEis', checked)}
            aria-label="Enable MRA EIS"
          />
        </CardContent>
      </Card>

      {!settings.enableEis ? (
        <Card className="bg-muted/30">
          <CardContent className="flex items-start gap-3 p-5">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Your normal POS flow is unchanged</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Enable EIS only after you have the business TIN and a Terminal Activation Code from MRA.
                Product mappings will be managed separately in Inventory.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Business details</CardTitle>
              <CardDescription>Use the taxpayer details registered with MRA.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="eis-tin">Taxpayer Identification Number (TIN)</Label>
                <Input
                  id="eis-tin"
                  value={settings.tin}
                  onChange={(event) => updateSetting('tin', event.target.value)}
                  placeholder="Enter your MRA TIN"
                />
              </div>
              <div className="space-y-2">
                <Label>Environment</Label>
                <Select
                  value={settings.eisEnvironment}
                  onValueChange={(value) => updateSetting('eisEnvironment', value as EisEnvironment)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEST">Test / Sandbox</SelectItem>
                    <SelectItem value="PROD">Production</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Use Production only after MRA onboarding is complete.</p>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border p-3 sm:col-span-2">
                <div>
                  <Label htmlFor="vat-registered">VAT registered</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Turn this on only if MRA issued a VAT registration number.</p>
                </div>
                <Switch
                  id="vat-registered"
                  checked={settings.vatRegistered}
                  onCheckedChange={(checked) => {
                    updateSetting('vatRegistered', checked);
                    updateSetting('mraTaxpayerType', checked ? 'VAT' : 'NON_VAT');
                  }}
                  aria-label="VAT registered"
                />
              </div>
              {settings.vatRegistered && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="vat-number">VAT registration number</Label>
                  <Input
                    id="vat-number"
                    value={settings.vatRegistrationNumber}
                    onChange={(event) => updateSetting('vatRegistrationNumber', event.target.value)}
                    placeholder="Enter your VAT registration number"
                  />
                </div>
              )}
              <div className="flex items-center justify-between gap-4 rounded-md border p-3 sm:col-span-2">
                <div>
                  <Label htmlFor="mra-enrolled">Already enrolled with MRA EIS</Label>
                  <p className="mt-1 text-xs text-muted-foreground">This records your MRA enrollment status; it does not replace terminal activation.</p>
                </div>
                <Switch
                  id="mra-enrolled"
                  checked={settings.mraEnrolled}
                  onCheckedChange={(checked) => updateSetting('mraEnrolled', checked)}
                  aria-label="Already enrolled with MRA EIS"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connect a branch</CardTitle>
              <CardDescription>Each branch or device needs the TAC issued by MRA.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Branch</Label>
                  {branches.length > 0 ? (
                    <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                      <SelectTrigger><SelectValue placeholder="Choose a branch" /></SelectTrigger>
                      <SelectContent>
                        {branches.map((branch) => (
                          <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="rounded-md border p-3 text-sm text-muted-foreground">Create a branch before connecting EIS.</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tac-code">Terminal Activation Code (TAC)</Label>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="tac-code"
                      className="pl-9"
                      value={tacCode}
                      onChange={(event) => setTacCode(event.target.value)}
                      placeholder="Paste the TAC from MRA"
                      disabled={terminalIsPending}
                    />
                  </div>
                </div>
              </div>

              {terminalIsActive ? (
                <div className="flex flex-col gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                    <div>
                      <p className="font-medium">{selectedBranch?.name || 'Selected branch'} is connected</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Terminal {terminal?.mraTerminalId || terminal?.terminalId || 'registered'} · {terminal?.isOnline ? 'Online' : 'Offline'}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={refreshTerminal} disabled={isRefreshingTerminal}>
                    {isRefreshingTerminal ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Refresh status
                  </Button>
                </div>
              ) : terminalIsPending ? (
                <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <TerminalIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Terminal activation is pending</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        This device has already submitted its TAC. Refresh the status after MRA confirms the terminal.
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={refreshTerminal} disabled={isRefreshingTerminal}>
                    {isRefreshingTerminal ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Refresh status
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <TerminalIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium">No terminal connected for this device</p>
                      <p className="mt-1 text-sm text-muted-foreground">The TAC connects this Handy POS device to MRA EIS.</p>
                    </div>
                  </div>
                  <Button onClick={connectTerminal} disabled={isConnecting || !selectedBranchId || !tacCode.trim()}>
                    {isConnecting && <Loader2 className="h-4 w-4 animate-spin" />}
                    Connect branch
                  </Button>
                </div>
              )}

              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                Need a TAC? <a className="inline-flex items-center gap-1 underline underline-offset-2" href="https://eis-api.mra.mw/docs/" target="_blank" rel="noreferrer">Open MRA EIS docs <ExternalLink className="h-3 w-3" /></a>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Configuration sync</CardTitle>
              <CardDescription>Fetch the latest MRA rules for this business after a terminal is connected.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Saved configurations</p>
                  <p className="mt-1 text-lg font-semibold">{configuration.count}</p>
                </div>
                <div className="rounded-md border p-3 sm:col-span-2">
                  <p className="text-xs text-muted-foreground">Last sync</p>
                  <p className="mt-1 text-sm font-medium">{formatDate(configuration.lastSyncedAt)}</p>
                </div>
              </div>
              <Button variant="outline" onClick={syncConfiguration} disabled={!terminalIsActive || isSyncingConfiguration}>
                {isSyncingConfiguration ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync MRA configuration
              </Button>
              {configuration.types.length > 0 && (
                <p className="text-xs text-muted-foreground">Available: {configuration.types.join(', ')}</p>
              )}
            </CardContent>
          </Card>

          <details className="rounded-lg border bg-card px-5 py-4">
            <summary className="cursor-pointer font-medium">Optional sales safeguards</summary>
            <div className="mt-4 space-y-4 border-t pt-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Block sales when EIS is unavailable</p>
                  <p className="mt-1 text-xs text-muted-foreground">Use this when your compliance process requires every sale to be submitted immediately.</p>
                </div>
                <Switch
                  checked={settings.blockSalesIfEisDown}
                  onCheckedChange={(checked) => updateSetting('blockSalesIfEisDown', checked)}
                  aria-label="Block sales when EIS is unavailable"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Block sales without product mappings</p>
                  <p className="mt-1 text-xs text-muted-foreground">Turn this on after your MRA product mappings are complete.</p>
                </div>
                <Switch
                  checked={settings.blockSalesIfTaxMappingMissing}
                  onCheckedChange={(checked) => updateSetting('blockSalesIfTaxMappingMissing', checked)}
                  aria-label="Block sales without product mappings"
                />
              </div>
            </div>
          </details>

          <Card className="bg-muted/30">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Package className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium">Product mappings live in Inventory</p>
                  <p className="mt-1 text-sm text-muted-foreground">Map sellable products to MRA codes there without mixing product setup into this connection screen.</p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/inventory">Open Inventory</Link>
              </Button>
            </CardContent>
          </Card>

          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Save your settings before connecting a branch. Test mode is intended for setup; use Production only after your MRA onboarding is complete.</p>
          </div>
        </>
      )}
    </div>
  );
}
