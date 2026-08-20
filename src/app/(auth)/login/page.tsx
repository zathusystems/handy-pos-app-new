'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AppVersionLabel } from '@/components/app-version-label';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';
import { normalizeRole, type AppRole } from '@/lib/rbac/role-utils';
import { clearSessionContextStorage } from '@/lib/session-context-storage';
import { syncBusinessBranchesFromServer } from '@/lib/branch-sync';
import { fetchCurrentSubscription } from '@/lib/subscription-cache';

const loginSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required.'),
  password: z.string().min(1, 'Password is required.'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

interface Business {
  id: string;
  name: string;
  business_type: string;
  tin?: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
}

interface Branch {
  id: string;
  name: string;
  address?: string;
  createdAt?: string;
}

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const getErrorTitle = (error: unknown, fallback: string): string =>
  (error as any)?.isNetworkError ? 'Connection Problem' : fallback;

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState<string>('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [showBusinessSelect, setShowBusinessSelect] = useState(false);
  const [showBranchSelect, setShowBranchSelect] = useState(false);
  const [loginData, setLoginData] = useState<LoginFormValues | null>(null);
  const [loginUser, setLoginUser] = useState<any | null>(null);
  const [pendingUserRole, setPendingUserRole] = useState<AppRole>('User');
  const [error, setError] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { login, selectBusiness, user } = useAuth();

  // Redirect authenticated users away from login (only if tokens are valid)
  useEffect(() => {
    if (user) {
      // Check if auth tokens exist and are valid
      const tokens = localStorage.getItem('handypos-auth-tokens');
      if (tokens) {
        try {
          const parsedTokens = JSON.parse(tokens);
          if (parsedTokens.access && parsedTokens.refresh) {
            // Tokens exist and are valid, redirect to dashboard
            router.push('/dashboard');
          } else {
            // Tokens exist but are invalid, clear user and stay on login
            localStorage.removeItem('handy-pos-user');
            localStorage.removeItem('handy-pos-business');
            clearSessionContextStorage();
          }
        } catch (e) {
          // Failed to parse tokens, clear user and stay on login
          localStorage.removeItem('handy-pos-user');
          localStorage.removeItem('handy-pos-business');
          clearSessionContextStorage();
        }
      } else {
        // No tokens found, clear user and stay on login
        localStorage.removeItem('handy-pos-user');
        localStorage.removeItem('handy-pos-business');
        clearSessionContextStorage();
      }
    }
  }, [user, router]);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const extractId = (value: any): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && value !== null) {
      const nested = value.id ?? value.pk ?? value.value;
      if (nested !== null && nested !== undefined) {
        return String(nested);
      }
      return null;
    }
    const parsed = String(value).trim();
    return parsed ? parsed : null;
  };

  const normalizeBusiness = (businessResponse: any): Business | null => {
    if (!businessResponse?.id || !businessResponse?.name) return null;
    return {
      id: String(businessResponse.id),
      name: businessResponse.name,
      business_type: businessResponse.business_type || businessResponse.type || 'Business',
      tin: businessResponse.tin || businessResponse.tax_pin || businessResponse.taxPin || '',
      email: businessResponse.email,
      phone: businessResponse.phone,
      address: businessResponse.address,
      website: businessResponse.website,
    };
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

  const getBranchIdCandidates = (value: unknown): string[] => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return [];

    const candidates = new Set<string>([normalized]);
    const numericMatch = normalized.match(/\d+/)?.[0];

    if (numericMatch) {
      candidates.add(numericMatch);
      candidates.add(`BRN-${numericMatch}`);
      candidates.add(`branch-${numericMatch}`);
    }

    return Array.from(candidates);
  };

  const matchesBranchId = (branchId: string, value: unknown): boolean => {
    const branchCandidates = new Set(getBranchIdCandidates(branchId));
    return getBranchIdCandidates(value).some((candidate) => branchCandidates.has(candidate));
  };

  const normalizeStoredBranches = (value: unknown): Branch[] => {
    if (!Array.isArray(value)) return [];

    return value
      .map((branch: any) => ({
        id: String(branch?.id ?? branch?.backendId ?? '').trim(),
        name: String(branch?.name ?? '').trim(),
        address: String(branch?.address ?? '').trim(),
        createdAt: String(branch?.createdAt ?? branch?.created_at ?? '').trim() || undefined,
      }))
      .filter((branch: Branch) => branch.id && branch.name);
  };

  const isMainBranchName = (value: unknown): boolean => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'main branch' || normalized.endsWith(' main branch');
  };

  const getBranchCreatedTimestamp = (branch: Branch, rawBranches: any[]): number | null => {
    const rawBranch = rawBranches.find((candidate) =>
      matchesBranchId(branch.id, candidate?.id ?? candidate?.backendId)
    );
    const createdAt = rawBranch?.created_at ?? rawBranch?.createdAt ?? branch.createdAt;
    if (!createdAt) {
      return null;
    }

    const timestamp = Date.parse(String(createdAt));
    return Number.isFinite(timestamp) ? timestamp : null;
  };

  const getBranchNumericOrder = (branch: Branch): number | null => {
    const candidates = [branch.id];

    for (const candidate of candidates) {
      const numericMatch = String(candidate ?? '').trim().match(/\d+/)?.[0];
      if (!numericMatch) continue;

      const numericValue = Number.parseInt(numericMatch, 10);
      if (!Number.isNaN(numericValue)) {
        return numericValue;
      }
    }

    return null;
  };

  const resolvePrimaryBranch = (branches: Branch[], rawBranches: any[] = []): Branch | null => {
    if (branches.length === 0) {
      return null;
    }

    return [...branches].sort((left, right) => {
      const leftCreatedAt = getBranchCreatedTimestamp(left, rawBranches);
      const rightCreatedAt = getBranchCreatedTimestamp(right, rawBranches);

      if (leftCreatedAt !== null || rightCreatedAt !== null) {
        if (leftCreatedAt === null) return 1;
        if (rightCreatedAt === null) return -1;
        if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
      }

      const leftIsMain = isMainBranchName(left.name);
      const rightIsMain = isMainBranchName(right.name);
      if (leftIsMain !== rightIsMain) {
        return leftIsMain ? -1 : 1;
      }

      const leftNumericOrder = getBranchNumericOrder(left);
      const rightNumericOrder = getBranchNumericOrder(right);
      if (leftNumericOrder !== null || rightNumericOrder !== null) {
        if (leftNumericOrder === null) return 1;
        if (rightNumericOrder === null) return -1;
        if (leftNumericOrder !== rightNumericOrder) return leftNumericOrder - rightNumericOrder;
      }

      return left.name.localeCompare(right.name);
    })[0] || null;
  };

  const collectBranchRefs = (value: unknown, refs: Set<string>) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectBranchRefs(entry, refs));
      return;
    }

    if (value && typeof value === 'object') {
      const nestedId =
        (value as any)?.id ??
        (value as any)?.pk ??
        (value as any)?.value ??
        (value as any)?.branch_id ??
        (value as any)?.branchId;

      if (nestedId !== null && nestedId !== undefined) {
        const normalized = String(nestedId).trim();
        if (normalized) {
          refs.add(normalized);
        }
      }
      return;
    }

    const normalized = String(value ?? '').trim();
    if (normalized) {
      refs.add(normalized);
    }
  };

  const extractAssociatedBranchRefs = (...sources: any[]): string[] => {
    const refs = new Set<string>();

    for (const source of sources) {
      if (!source) continue;

      collectBranchRefs(source?.assigned_branch_ids, refs);
      collectBranchRefs(source?.assignedBranchIds, refs);
      collectBranchRefs(source?.branch_ids, refs);
      collectBranchRefs(source?.branchIds, refs);
      collectBranchRefs(source?.assigned_branches, refs);
      collectBranchRefs(source?.assignedBranches, refs);
      collectBranchRefs(source?.accessible_branches, refs);
      collectBranchRefs(source?.accessibleBranches, refs);
      collectBranchRefs(source?.branches, refs);
    }

    return Array.from(refs);
  };

  const resolveAccessibleBranches = (
    availableBranches: Branch[],
    options: {
      assignedBranchId?: string | null;
      staffProfile?: any;
      responseUser?: any;
    }
  ): Branch[] => {
    if (availableBranches.length === 0) {
      return [];
    }

    const associatedRefs = extractAssociatedBranchRefs(options.staffProfile, options.responseUser);
    const matchRefs = associatedRefs.length > 0 ? associatedRefs : options.assignedBranchId ? [options.assignedBranchId] : [];

    if (matchRefs.length === 0) {
      return availableBranches;
    }

    const filteredBranches = availableBranches.filter((branch) =>
      matchRefs.some((ref) => matchesBranchId(branch.id, ref))
    );

    return filteredBranches.length > 0 ? filteredBranches : availableBranches;
  };

  const buildAuthUser = (
    loginValues: LoginFormValues,
    userRole: AppRole,
    businessId: string,
    branchId?: string | null,
    responseUser?: any,
    staffProfile?: any
  ) => {
    const isEmail = loginValues.identifier.includes('@');
    const responseUserId =
      extractId(responseUser?.id) ||
      extractId(responseUser?.uid) ||
      extractId(responseUser?.user_id);
    const resolvedEmail =
      responseUser?.email ||
      staffProfile?.email ||
      (isEmail ? loginValues.identifier : undefined);
    const resolvedPhone =
      responseUser?.phone ||
      staffProfile?.phone ||
      (!isEmail ? loginValues.identifier : undefined);
    const firstName = responseUser?.first_name || responseUser?.firstName || '';
    const lastName = responseUser?.last_name || responseUser?.lastName || '';
    const nameFromProfile = `${firstName} ${lastName}`.trim();
    const displayName =
      nameFromProfile ||
      responseUser?.display_name ||
      responseUser?.name ||
      staffProfile?.name ||
      staffProfile?.full_name ||
      (resolvedEmail ? resolvedEmail.split('@')[0] : '') ||
      resolvedPhone ||
      loginValues.identifier;

    return {
      uid: responseUserId || staffProfile?.id || loginValues.identifier,
      email: resolvedEmail,
      phone: resolvedPhone,
      displayName,
      role: userRole || 'User',
      businessId,
      branchId:
        branchId ||
        extractId(staffProfile?.branch_id) ||
        extractId(staffProfile?.branch) ||
        undefined,
      isFuelAttendant:
        staffProfile?.is_fuel_attendant ??
      staffProfile?.isFuelAttendant ??
      undefined,
    };
  };

  const syncActiveBranchDetails = (
    branchId: string,
    branchesData: Branch[],
    fetchedBranches: any[]
  ) => {
    if (!branchId || typeof window === 'undefined') return;
    const normalizedBranchId = String(branchId);
    const fetchedBranch = fetchedBranches.find(
      (branch) => String(branch?.id) === normalizedBranchId
    );
    const summaryBranch = branchesData.find(
      (branch) => String(branch?.id) === normalizedBranchId
    );
    const branchToStore = fetchedBranch || summaryBranch;

    if (!branchToStore) {
      window.dispatchEvent(new CustomEvent('branchChanged', { detail: { branchId: normalizedBranchId } }));
      return;
    }

    try {
      localStorage.setItem(
        `handypos-branch-${normalizedBranchId}`,
        JSON.stringify(branchToStore)
      );
    } catch (error) {
      console.warn('[DEBUG LOGIN] Failed to store active branch details:', error);
    }

    const normalizedBranch = {
      id: normalizedBranchId,
      name: String(branchToStore?.name || summaryBranch?.name || ''),
      address: String(branchToStore?.address || summaryBranch?.address || ''),
    };

    try {
      const storedBranchesRaw = localStorage.getItem('handypos-branches');
      const storedBranches = storedBranchesRaw ? JSON.parse(storedBranchesRaw) : [];
      const branchesList = Array.isArray(storedBranches) ? storedBranches : [];
      const matchIndex = branchesList.findIndex(
        (branch: any) =>
          String(branch?.id) === normalizedBranchId ||
          String(branch?.backendId) === normalizedBranchId
      );

      if (matchIndex >= 0) {
        branchesList[matchIndex] = {
          ...branchesList[matchIndex],
          ...normalizedBranch,
        };
      } else if (normalizedBranch.name) {
        branchesList.push(normalizedBranch);
      }

      if (branchesList.length > 0) {
        localStorage.setItem('handypos-branches', JSON.stringify(branchesList));
        window.dispatchEvent(new CustomEvent('branchesUpdated', { detail: { branches: branchesList } }));
      }
    } catch (error) {
      console.warn('[DEBUG LOGIN] Failed to update branches cache:', error);
    }

    window.dispatchEvent(new CustomEvent('branchChanged', { detail: { branchId: normalizedBranchId } }));
  };

  const onSubmit = async (data: LoginFormValues) => {
    setIsLoading(true);
    setError('');
    try {
      // Step 1: Authenticate user
      console.log('[DEBUG LOGIN] Step 1: Authenticating user');
      const response: any = await authFetch.login(data.identifier, data.password);
      
      if (!response.access || !response.refresh) {
        throw new Error('Invalid response from server');
      }
      console.log('[DEBUG LOGIN] Authentication successful');
      setLoginUser(response?.user ?? null);

      // Step 2: Check if user is a staff member or get their profile
      console.log('[DEBUG LOGIN] Step 2: Checking user profile');
      let staffProfile: any = null;
      let userProfile: any = null;
      let userRole: AppRole = 'Admin'; // Default to Admin for business owners
      const responseAssignedBranchId = extractId(response?.assigned_branch_id);
      let assignedBranchId: string | null = null;
      let businessId: string | null = extractId(response?.assigned_business_id);
      let isStaff = Boolean(response?.is_staff_user);

      try {
        staffProfile = await authFetch.fetch<any>('/staff/me/');
        if (staffProfile) {
          isStaff = true;
          userRole = normalizeRole(staffProfile.role, { fallback: 'Cashier' });
          assignedBranchId =
            extractId(staffProfile.branch_id) ||
            extractId(staffProfile.branch) ||
            responseAssignedBranchId;
          businessId =
            extractId(staffProfile.business_id) ||
            extractId(staffProfile.business) ||
            businessId;
          console.log('[DEBUG LOGIN] User is STAFF:', { role: userRole, branch: assignedBranchId, business: businessId });
        }
      } catch (e) {
        console.log('[DEBUG LOGIN] User is not staff member, fetching user profile');
        // Try to get user profile for business owners
        try {
          userProfile = await authFetch.fetch<any>('/accounts/me/');
          if (userProfile) {
            userRole = normalizeRole(userProfile.role, {
              fallback: 'Admin',
              preferAdminForGenericUser: true,
            });
            console.log('[DEBUG LOGIN] User profile fetched:', { role: userRole });
          }
        } catch (profileError) {
          console.log('[DEBUG LOGIN] Could not fetch user profile, defaulting to Admin');
        }
      }

      // Owners/admin users should pick a branch at login when multiple branches exist.
      // Only staff users should inherit a pre-assigned branch automatically.
      if (!isStaff) {
        assignedBranchId = null;
      }

      // Step 3: Get business details
      console.log('[DEBUG LOGIN] Step 3: Fetching business details');
      let selectedBiz: Business | null = null;

      if (isStaff && businessId) {
        // Staff member - use their assigned business
        console.log('[DEBUG LOGIN] Fetching staff assigned business:', businessId);
        try {
          const businessResponse = await authFetch.fetch<any>(`/business/businesses/${businessId}/`);
          selectedBiz = normalizeBusiness(businessResponse);
          if (selectedBiz) {
            console.log('[DEBUG LOGIN] Staff business loaded:', selectedBiz.name);
          } else {
            console.error('[DEBUG LOGIN] Business response is empty for ID:', businessId);
            throw new Error('Business data is empty');
          }
        } catch (e: any) {
          console.error('[DEBUG LOGIN] Failed to fetch staff business:', {
            businessId,
            error: e?.message,
            status: (e as any)?.status,
            data: (e as any)?.data,
          });

          // Fallback: use first accessible business from listing endpoint
          try {
            const accessibleBusinesses = await authFetch.fetch<any>('/business/businesses/');
            const list = Array.isArray(accessibleBusinesses)
              ? accessibleBusinesses
              : accessibleBusinesses?.results || [];
            const matched =
              list.find((b: any) => String(b.id) === String(businessId)) ||
              list[0];
            selectedBiz = normalizeBusiness(matched);
            if (selectedBiz) {
              console.warn('[DEBUG LOGIN] Using fallback accessible business for staff:', selectedBiz.id);
            }
          } catch (fallbackError) {
            console.error('[DEBUG LOGIN] Staff fallback business lookup failed:', fallbackError);
          }

          if (!selectedBiz) {
            throw new Error(`Could not load your assigned business (ID: ${businessId}). Please contact your administrator.`);
          }
        }
      } else if (isStaff && !businessId) {
        // Staff member but no explicit business ID; try accessible business list
        console.warn('[DEBUG LOGIN] Staff member has no direct business ID, attempting accessible business lookup');
        const businessesResponse = await authFetch.fetch<any>('/business/businesses/');
        const businessesList = Array.isArray(businessesResponse)
          ? businessesResponse
          : businessesResponse?.results || [];
        selectedBiz = normalizeBusiness(businessesList[0]);
        if (!selectedBiz) {
          throw new Error('Your staff account does not have a business assigned. Please contact your administrator.');
        }
        businessId = selectedBiz.id;
      } else {
        // Business owner - fetch their businesses
        console.log('[DEBUG LOGIN] Fetching owner businesses');
        const businessesResponse = await authFetch.fetch<any>('/business/businesses/');
        const businessesList = Array.isArray(businessesResponse) 
          ? businessesResponse 
          : businessesResponse?.results || [];
        
        if (!businessesList || businessesList.length === 0) {
          throw new Error('No businesses found for this account. Please contact support.');
        }

        selectedBiz = normalizeBusiness(businessesList[0]);
        if (!selectedBiz) {
          throw new Error('Could not load business details for this account.');
        }
        console.log('[DEBUG LOGIN] Owner business loaded:', selectedBiz.name);
      }

      if (!selectedBiz) {
        throw new Error('Could not determine business. Please try again.');
      }

      // Step 4: Process login with business and branch info
      console.log('[DEBUG LOGIN] Step 4: Processing login');
      setPendingUserRole(userRole);
      await processBusinessSelection(
        selectedBiz,
        data,
        userRole,
        assignedBranchId,
        false,
        response?.user ?? null,
        staffProfile
      );
    } catch (error: any) {
      console.error('Login error:', error);
      const errorMsg = getErrorMessage(error, 'Invalid credentials. Please try again.');
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: getErrorTitle(error, 'Login Failed'),
        description: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const processBusinessSelection = async (
    selectedBiz: Business, 
    loginData: LoginFormValues,
    preloadedUserRole?: AppRole,
    preloadedAssignedBranchId?: string | null,
    isOfflineMode?: boolean,
    responseUser?: any,
    staffProfile?: any
  ) => {
    try {
      setIsLoading(true);
      setError('');
      clearSessionContextStorage();

      // Use preloaded values if provided, otherwise use defaults
      let assignedBranchId = preloadedAssignedBranchId || null;
      let userRole: AppRole = normalizeRole(preloadedUserRole, {
        fallback: pendingUserRole || 'User',
        preferAdminForGenericUser: true,
      });
      let branchesData: Branch[] = [];
      let fetchedBranches: any[] = [];
      let activeBranchId: string | null = assignedBranchId ? String(assignedBranchId) : null;
      let multiBranchEnabled = true;

      // Log the values being used
      console.log('[DEBUG LOGIN] Using staff profile values:', { role: userRole, assignedBranch: assignedBranchId, isOfflineMode });
      setPendingUserRole(userRole);

      // Store business info in localStorage via context
      const businessData = {
        id: selectedBiz.id,
        name: selectedBiz.name,
        type: selectedBiz.business_type,
        selectedAt: new Date().toISOString(),
      };
      selectBusiness(businessData);

      // Store business ID in localStorage for sync queue
      localStorage.setItem('handypos-business-id', selectedBiz.id);

      // Fetch business settings and sync to local DB (skip in offline mode)
      if (!isOfflineMode) {
        let currency = 'USD';
        let fuelPumps: string[] = [];
        try {
          const settingsResponse = await authFetch.fetch<any>(
            `/business/businesses/${selectedBiz.id}/business_settings/`
          );
          
          if (settingsResponse) {
            currency = settingsResponse.currency || 'USD';
            fuelPumps = Array.isArray(settingsResponse.fuel_pumps ?? settingsResponse.fuelPumps)
              ? (settingsResponse.fuel_pumps ?? settingsResponse.fuelPumps)
              : [];
          }
        } catch (e) {
          console.warn('[DEBUG LOGIN] Could not fetch business settings:', e);
        }

        // Store in IndexedDB even when settings fetch fails, so receipt/profile data stays available offline.
        await db.business.put({
          id: selectedBiz.id,
          name: selectedBiz.name,
          type: selectedBiz.business_type,
          currency,
          tin: selectedBiz.tin || '',
          email: selectedBiz.email,
          phone: selectedBiz.phone,
          address: selectedBiz.address,
          website: selectedBiz.website,
        });

        // Also store in localStorage for quick access by hooks and receipt fallback.
        localStorage.setItem('handypos-business-settings', JSON.stringify({
          businessId: selectedBiz.id,
          currency,
          timezone: 'UTC',
          tin: selectedBiz.tin || '',
          fiscalYearStartMonth: 1,
          fuelPumps,
        }));

        // Fetch and sync all branches
        try {
          const { businessResponse, rawBranches, branches, activeBranchId: syncedActiveBranchId } =
            await syncBusinessBranchesFromServer(selectedBiz.id, activeBranchId);

          fetchedBranches = rawBranches;
          branchesData = branches;
          activeBranchId = syncedActiveBranchId;

          if (businessResponse?.tin || businessResponse?.tax_pin || businessResponse?.taxPin) {
            const resolvedTin = businessResponse.tin || businessResponse.tax_pin || businessResponse.taxPin || '';
            selectedBiz.tin = resolvedTin;
            await db.business.update(selectedBiz.id, { tin: resolvedTin });
            let existingSettings: any = {};
            try {
              const existingSettingsRaw = localStorage.getItem('handypos-business-settings');
              existingSettings = existingSettingsRaw ? JSON.parse(existingSettingsRaw) : {};
            } catch {
              existingSettings = {};
            }
            localStorage.setItem('handypos-business-settings', JSON.stringify({
              ...existingSettings,
              businessId: selectedBiz.id,
              tin: resolvedTin,
            }));
          }

          const rawEnableEis =
            businessResponse?.enable_eis ??
            businessResponse?.enableEis ??
            businessResponse?.eis_enabled ??
            businessResponse?.eisEnabled;
          const responseFuelPumps = normalizePumpList(
            businessResponse?.settings?.fuel_pumps ??
            businessResponse?.fuel_pumps ??
            businessResponse?.settings?.fuelPumps ??
            businessResponse?.fuelPumps ??
            []
          );

          if (responseFuelPumps.length > 0) {
            let existingSettings: any = {};
            try {
              const existingSettingsRaw = localStorage.getItem('handypos-business-settings');
              existingSettings = existingSettingsRaw ? JSON.parse(existingSettingsRaw) : {};
            } catch {
              existingSettings = {};
            }
            localStorage.setItem('handypos-business-settings', JSON.stringify({
              ...existingSettings,
              businessId: selectedBiz.id,
              fuelPumps: responseFuelPumps,
            }));
          }

          if (rawEnableEis !== undefined) {
            const enableEisValue = rawEnableEis === true || rawEnableEis === 'true';
            let existingSettings: any = {};
            try {
              const existingSettingsRaw = localStorage.getItem('handypos-business-settings');
              existingSettings = existingSettingsRaw ? JSON.parse(existingSettingsRaw) : {};
            } catch {
              existingSettings = {};
            }
            localStorage.setItem('handypos-business-settings', JSON.stringify({
              ...existingSettings,
              businessId: selectedBiz.id,
              enableEis: enableEisValue,
              fuelPumps: responseFuelPumps.length > 0 ? responseFuelPumps : (existingSettings.fuelPumps || []),
            }));
          }

          const rawBlockTaxMapping = businessResponse?.block_sales_if_tax_mapping_missing ?? businessResponse?.blockSalesIfTaxMappingMissing;
          const rawAllowTaxMapping = businessResponse?.allow_sales_without_tax_mapping ?? businessResponse?.allowSalesWithoutTaxMapping;
          let blockTaxMappingValue: boolean | null = null;
          if (rawBlockTaxMapping !== undefined) {
            blockTaxMappingValue = rawBlockTaxMapping !== false && rawBlockTaxMapping !== 'false';
          } else if (rawAllowTaxMapping !== undefined) {
            blockTaxMappingValue = !(rawAllowTaxMapping === true || rawAllowTaxMapping === 'true');
          }

          if (blockTaxMappingValue !== null) {
            let existingSettings: any = {};
            try {
              const existingSettingsRaw = localStorage.getItem('handypos-business-settings');
              existingSettings = existingSettingsRaw ? JSON.parse(existingSettingsRaw) : {};
            } catch {
              existingSettings = {};
            }
            localStorage.setItem('handypos-business-settings', JSON.stringify({
              ...existingSettings,
              businessId: selectedBiz.id,
              blockSalesIfTaxMappingMissing: blockTaxMappingValue,
              fuelPumps: responseFuelPumps.length > 0 ? responseFuelPumps : (existingSettings.fuelPumps || []),
            }));
          }
          
        } catch (e) {
          console.warn('[DEBUG LOGIN] Could not fetch branches:', e);
        }

        try {
          const currentSubscription = await fetchCurrentSubscription(selectedBiz.id, {
            maxAgeMs: 0,
            force: true,
          });
          multiBranchEnabled = currentSubscription.enable_multi_branch !== false;
        } catch (subscriptionError) {
          console.warn('[DEBUG LOGIN] Could not fetch current subscription for multi-branch access:', subscriptionError);
          const cachedSubscription = await db.subscriptions.get('sub_main-business');
          if (cachedSubscription && String(cachedSubscription.businessId || '') === String(selectedBiz.id)) {
            multiBranchEnabled = cachedSubscription.enable_multi_branch !== false;
          }
        }
      }

      if (activeBranchId && branchesData.length === 0) {
        try {
          const storedBranchesRaw = localStorage.getItem('handypos-branches');
          const storedBranches = storedBranchesRaw ? JSON.parse(storedBranchesRaw) : [];
          branchesData = normalizeStoredBranches(storedBranches);
        } catch (error) {
          console.warn('[DEBUG LOGIN] Could not parse cached branches for assignment validation:', error);
        }
      }

      if (branchesData.length > 0) {
        const storedActiveBranch = localStorage.getItem('handypos-active-branch');
        const storedBranchIsValid = storedActiveBranch
          ? branchesData.some((branch) => matchesBranchId(branch.id, storedActiveBranch))
          : false;

        if (storedActiveBranch && !storedBranchIsValid) {
          localStorage.removeItem('handypos-active-branch');
          localStorage.removeItem('handypos-current-branch-id');
        }
      }

      // Validate assigned branch against business branches; fallback if invalid.
      if (activeBranchId && branchesData.length > 0) {
        const isAssignedBranchValid = branchesData.some(
          (branch) => matchesBranchId(branch.id, activeBranchId)
        );
        if (!isAssignedBranchValid) {
          console.warn(
            '[DEBUG LOGIN] Assigned branch is not part of selected business. Falling back to valid branch.',
            { assignedBranchId: activeBranchId, businessId: selectedBiz.id }
          );
          assignedBranchId = null;
          activeBranchId = null;
        }
      }

      const resolvedResponseUser = responseUser ?? loginUser ?? null;

      const accessibleBranches = resolveAccessibleBranches(branchesData, {
        assignedBranchId,
        staffProfile,
        responseUser: resolvedResponseUser,
      });

      const primaryBranch = resolvePrimaryBranch(branchesData, fetchedBranches);
      const effectiveBranches =
        !multiBranchEnabled && primaryBranch
          ? [primaryBranch]
          : accessibleBranches;

      if (!multiBranchEnabled && primaryBranch) {
        assignedBranchId = primaryBranch.id;
        activeBranchId = primaryBranch.id;
      } else if (effectiveBranches.length === 1) {
        activeBranchId = effectiveBranches[0].id;
      }

      if (effectiveBranches.length > 1) {
        localStorage.removeItem('handypos-active-branch');
        localStorage.removeItem('handypos-current-branch-id');
        setLoginData(loginData);
        setBusinesses([selectedBiz]);
        setSelectedBusiness(selectedBiz.id);
        setBranches(effectiveBranches);
        setSelectedBranch('');
        setShowBusinessSelect(false);
        setShowBranchSelect(true);
        console.log('[DEBUG LOGIN] Multiple accessible branches found, prompting branch selection');
        return;
      }

      if (!activeBranchId) {
        if (branchesData.length === 0) {
          try {
            const storedBranchesRaw = localStorage.getItem('handypos-branches');
            const storedBranches = storedBranchesRaw ? JSON.parse(storedBranchesRaw) : [];
            branchesData = normalizeStoredBranches(storedBranches);
          } catch (error) {
            console.warn('[DEBUG LOGIN] Could not parse cached branches:', error);
          }
        }

        if (branchesData.length === 1) {
          activeBranchId = branchesData[0].id;
        } else {
          const storedBranch = localStorage.getItem('handypos-active-branch');
          if (storedBranch) {
            activeBranchId = storedBranch;
          }
        }
      }

      if (activeBranchId) {
        localStorage.setItem('handypos-active-branch', activeBranchId);
        localStorage.setItem('handypos-current-branch-id', activeBranchId);
        console.log('[DEBUG LOGIN] Active branch set to:', activeBranchId);
        syncActiveBranchDetails(activeBranchId, branchesData, fetchedBranches);
      }

      // Create user session
      const user: any = buildAuthUser(
        loginData,
        userRole || 'User',
        selectedBiz.id,
        activeBranchId || undefined,
        resolvedResponseUser,
        staffProfile
      );

      console.log('[DEBUG LOGIN] User object being set:', user);
      login(user);

      if (staffProfile?.id) {
        try {
          await db.staff.put({
            id: String(staffProfile.id),
            name: staffProfile.name || staffProfile.full_name || user.displayName || '',
            email: staffProfile.email || user.email || '',
            role: staffProfile.role || user.role || 'Cashier',
            branchId:
              extractId(staffProfile.branch_id) ||
              extractId(staffProfile.branch) ||
              activeBranchId ||
              '',
            isFuelAttendant:
              staffProfile.is_fuel_attendant ??
              staffProfile.isFuelAttendant ??
              false,
            password: '',
          });
        } catch (staffStoreError) {
          console.warn('[DEBUG LOGIN] Failed to cache staff profile:', staffStoreError);
        }
      }

      toast({
        title: 'Login Successful',
        description: `Welcome to ${selectedBiz.name}! (Role: ${user.role})`,
      });

      router.replace('/dashboard');

      // Pull all data for the selected business and branch in the background.
      // Login should not wait on sync because slow or hanging network calls here
      // make authentication look flaky even after tokens are stored successfully.
      if (activeBranchId) {
        console.log('[DEBUG LOGIN] Pulling all data for branch:', activeBranchId);
        void import('@/lib/services/sync-service')
          .then(({ syncService }) => syncService.performFullSync(activeBranchId))
          .then(() => {
            console.log('[DEBUG LOGIN] Full sync completed');
          })
          .catch((syncError) => {
            console.error('[DEBUG LOGIN] Sync error (non-blocking):', syncError);
          });
      }
      return;
    } catch (error: any) {
      console.error('Business selection error:', error);
      const errorMsg = getErrorMessage(error, 'Failed to process login. Please try again.');
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: getErrorTitle(error, 'Error'),
        description: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBusinessSelect = async () => {
    if (!selectedBusiness || !loginData) {
      setError('Please select a business.');
      return;
    }

    try {
      setIsLoading(true);
      setError('');

      // Get the selected business details
      const selectedBiz = businesses.find(b => b.id === selectedBusiness);
      if (!selectedBiz) {
        throw new Error('Business not found');
      }

      // Fetch user's staff profile to get assigned branch and role
      console.log('[DEBUG LOGIN] Fetching staff profile for user');
      let assignedBranchId: string | null = null;
      let userRole: AppRole = pendingUserRole || 'User';

      let staffProfile: any = null;
      try {
        const staffResponse = await authFetch.fetch<any>('/staff/me/');
        if (staffResponse) {
          staffProfile = staffResponse;
          userRole = normalizeRole(staffResponse.role, { fallback: userRole });
          assignedBranchId = staffResponse.branch ? String(staffResponse.branch) : null;
          console.log('[DEBUG LOGIN] Staff profile:', { role: userRole, assignedBranch: assignedBranchId });
        }
      } catch (e) {
        console.warn('[DEBUG LOGIN] Could not fetch staff profile:', e);
        // Owner/admin users may not have a staff profile; preserve previously resolved role.
      }

      setPendingUserRole(userRole);

      await processBusinessSelection(
        selectedBiz,
        loginData,
        userRole,
        assignedBranchId,
        false,
        loginUser,
        staffProfile
      );
    } catch (error: any) {
      console.error('Business selection error:', error);
      const errorMsg = getErrorMessage(error, 'Failed to select business. Please try again.');
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: getErrorTitle(error, 'Error'),
        description: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBranchSelect = async () => {
    if (!selectedBranch) {
      setError('Please select a branch.');
      return;
    }

    try {
      setIsLoading(true);
      setError('');

      // Store the selected branch
      localStorage.setItem('handypos-active-branch', selectedBranch);
      localStorage.setItem('handypos-current-branch-id', selectedBranch);
      syncActiveBranchDetails(selectedBranch, branches, []);

      // Get the selected business
      const selectedBiz = businesses.find(b => b.id === selectedBusiness);
      if (!selectedBiz) {
        throw new Error('Business not found');
      }

      // Reuse role resolved during initial login. Staff profile can override if available.
      let userRole: AppRole = pendingUserRole || 'User';

      let staffProfile: any = null;
      try {
        const staffResponse = await authFetch.fetch<any>('/staff/me/');
        if (staffResponse) {
          staffProfile = staffResponse;
          userRole = normalizeRole(staffResponse.role, { fallback: userRole });
        }
      } catch (e) {
        console.warn('[DEBUG LOGIN] Could not fetch staff profile:', e);
        // Keep previously resolved role (owners/admins may not have staff profile).
      }

      // Create user session
      const user: any = buildAuthUser(
        loginData!,
        userRole || 'User',
        selectedBusiness,
        selectedBranch,
        loginUser,
        staffProfile
      );

      console.log('[DEBUG LOGIN] User object being set:', user);
      login(user);

      toast({
        title: 'Login Successful',
        description: `Welcome to ${selectedBiz.name}!`,
      });

      router.replace('/dashboard');

      // Pull all data for the selected branch in the background.
      console.log('[DEBUG LOGIN] Pulling all data for branch:', selectedBranch);
      void import('@/lib/services/sync-service')
        .then(({ syncService }) => syncService.performFullSync(selectedBranch))
        .then(() => {
          console.log('[DEBUG LOGIN] Full sync completed');
        })
        .catch((syncError) => {
          console.error('[DEBUG LOGIN] Sync error (non-blocking):', syncError);
        });
      return;
    } catch (error: any) {
      console.error('Branch selection error:', error);
      const errorMsg = getErrorMessage(error, 'Failed to select branch. Please try again.');
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: getErrorTitle(error, 'Error'),
        description: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setShowBusinessSelect(false);
    setShowBranchSelect(false);
    setLoginData(null);
    setLoginUser(null);
    setBusinesses([]);
    setBranches([]);
    setSelectedBusiness('');
    setSelectedBranch('');
    setPendingUserRole('User');
    setError('');
  };

  if (showBranchSelect) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Select Branch</CardTitle>
          <CardDescription>
            Choose which branch you want to access.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branch">Branch</Label>
            <Select value={selectedBranch} onValueChange={setSelectedBranch}>
              <SelectTrigger id="branch">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                    {branch.address && ` - ${branch.address}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button
            type="button"
            className="w-full"
            onClick={handleBranchSelect}
            disabled={isLoading || !selectedBranch}
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Continue
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleBackToLogin}
            disabled={isLoading}
          >
            Back
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (showBusinessSelect) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Select Business</CardTitle>
          <CardDescription>
            Choose which business you want to access.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="business">Business</Label>
            <Select value={selectedBusiness} onValueChange={setSelectedBusiness}>
              <SelectTrigger id="business">
                <SelectValue placeholder="Select a business" />
              </SelectTrigger>
              <SelectContent>
                {businesses.map((business) => (
                  <SelectItem key={business.id} value={business.id}>
                    {business.name} ({business.business_type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button
            type="button"
            className="w-full"
            onClick={handleBusinessSelect}
            disabled={isLoading || !selectedBusiness}
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Continue
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleBackToLogin}
            disabled={isLoading}
          >
            Back
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm bg-muted/60 border-0">
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardHeader>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>
            Enter your email or phone and password to access your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="identifier">Email or Phone</Label>
            <Input
              id="identifier"
              type="text"
              placeholder="john@example.com or +1 (555) 123-4567"
              {...register('identifier')}
              disabled={isLoading}
            />
            {errors.identifier && (
              <p className="text-sm text-destructive">{errors.identifier.message}</p>
            )}
          </div>
          <div className="grid gap-2">
            <div className="flex items-center">
              <Label htmlFor="password">Password</Label>
              {/* <Link
                href="#"
                className="ml-auto inline-block text-sm underline"
              >
                Forgot your password?
              </Link> */}
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                {...register('password')}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                disabled={isLoading}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {errors.password && (
              <p className="text-sm text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
          <div className="text-center text-sm">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="font-medium underline underline-offset-4">
              Sign up
            </Link>
          </div>
          <Link
            href="/documentation"
            className="text-center text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Read the documentation
          </Link>
          <AppVersionLabel variant="plain" className="w-full" />
        </CardFooter>
      </form>
    </Card>
  );
}
