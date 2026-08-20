
'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { syncService } from '@/lib/services/sync-service';
import { normalizeRole } from '@/lib/rbac/role-utils';
import { clearSessionContextStorage } from '@/lib/session-context-storage';

// Define the shape of the user object and the auth context
export interface User {
  uid: string;
  email?: string;
  phone?: string;
  displayName: string;
  role: 'Admin' | 'Manager' | 'Cashier' | 'Waiter' | 'Kitchen Staff' | 'User';
  photoURL?: string;
  branchId?: string;
  businessId?: string;
  isFuelAttendant?: boolean;
}

export interface Business {
  id: string;
  name: string;
  type: string;
  currency?: string;
  selectedAt: string;
}

interface AuthContextType {
  user: User | null;
  business: Business | null;
  loading: boolean;
  login: (user: User) => void;
  logout: () => void;
  selectBusiness: (business: Business) => void;
}

// Create the context with a default undefined value
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Define the props for the AuthProvider
interface AuthProviderProps {
  children: ReactNode;
}

const AUTH_STORAGE_KEYS = {
  USER: 'handy-pos-user',
  BUSINESS: 'handy-pos-business',
  TOKENS: 'handypos-auth-tokens',
  LEGACY_TOKENS: 'handy-pos-auth-tokens',
  ACTIVE_BRANCH: 'handypos-active-branch',
  BUSINESS_CACHE: 'handypos-business',
  BUSINESS_SETTINGS: 'handypos-business-settings',
} as const;

const readValidAuthTokens = (): { access: string; refresh: string } | null => {
  const primary = localStorage.getItem(AUTH_STORAGE_KEYS.TOKENS);
  const legacy = localStorage.getItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);
  const rawTokens = primary ?? legacy;

  if (!rawTokens) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawTokens);
    const access = typeof parsed?.access === 'string' ? parsed.access : '';
    const refresh = typeof parsed?.refresh === 'string' ? parsed.refresh : '';

    if (!access || !refresh) {
      throw new Error('Invalid token payload');
    }

    // Migrate legacy token key to the canonical key.
    if (!primary && legacy) {
      localStorage.setItem(
        AUTH_STORAGE_KEYS.TOKENS,
        JSON.stringify({ access, refresh })
      );
    }
    localStorage.removeItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);

    return { access, refresh };
  } catch (error) {
    console.error('Failed to parse auth tokens from localStorage', error);
    localStorage.removeItem(AUTH_STORAGE_KEYS.TOKENS);
    localStorage.removeItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);
    return null;
  }
};

const pickFirstString = (...values: Array<unknown>): string => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const parseStoredJson = <T,>(value: string | null): T | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const parseJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const payload = token.split('.')[1];
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = atob(`${normalized}${padding}`);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch (error) {
    console.warn('[Auth] Failed to decode access token payload', error);
    return null;
  }
};

const getStoredBusinessIdFallback = (): string => {
  const storedBusinessId = pickFirstString(localStorage.getItem('handypos-business-id'));
  if (storedBusinessId) {
    return storedBusinessId;
  }

  const storedBusiness = parseStoredJson<{ id?: unknown }>(localStorage.getItem(AUTH_STORAGE_KEYS.BUSINESS));
  const storedSettings = parseStoredJson<{ businessId?: unknown }>(localStorage.getItem(AUTH_STORAGE_KEYS.BUSINESS_SETTINGS));

  return pickFirstString(storedBusiness?.id, storedSettings?.businessId);
};

const buildUserFromToken = (accessToken: string): User | null => {
  const payload = parseJwtPayload(accessToken);
  if (!payload) {
    return null;
  }

  const email = pickFirstString(payload.email);
  const phone = pickFirstString(payload.phone);
  const businessId = pickFirstString(
    payload.business_id,
    payload.businessId,
    payload.business,
    getStoredBusinessIdFallback()
  );
  const branchId = pickFirstString(
    payload.branch_id,
    payload.branchId,
    payload.branch,
    localStorage.getItem(AUTH_STORAGE_KEYS.ACTIVE_BRANCH)
  );
  const uid =
    pickFirstString(
      payload.user_id,
      payload.userId,
      payload.uid,
      payload.sub,
      email,
      phone
    ) || 'authenticated-user';
  const displayName =
    pickFirstString(
      payload.display_name,
      payload.displayName,
      payload.name,
      payload.full_name,
      payload.fullName,
      payload.username
    ) ||
    (email ? email.split('@')[0] : '') ||
    phone ||
    'User';

  return {
    uid,
    email: email || undefined,
    phone: phone || undefined,
    displayName,
    role: normalizeRole(payload.role ?? payload.user_role ?? payload.userRole, {
      fallback: 'User',
      preferAdminForGenericUser: Boolean(businessId),
    }) as User['role'],
    branchId: branchId || undefined,
    businessId: businessId || undefined,
    isFuelAttendant:
      typeof payload.is_fuel_attendant === 'boolean'
        ? payload.is_fuel_attendant
        : typeof payload.isFuelAttendant === 'boolean'
          ? payload.isFuelAttendant
          : undefined,
  };
};

const isRecoverableBootstrapError = (error: unknown): boolean => {
  const status = Number((error as any)?.status);
  if (status === 401 || status === 403) {
    return false;
  }

  const message = String((error as any)?.message ?? '').toLowerCase();
  if (!message) {
    return false;
  }

  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('invalid credentials')
  ) {
    return false;
  }

  return (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('load failed') ||
    message.includes('connection') ||
    (error as any)?.name === 'TypeError'
  );
};

const buildUserFromProfiles = (profile: any, staffProfile: any | null): User | null => {
  const email = pickFirstString(
    profile?.email,
    profile?.user?.email,
    staffProfile?.email,
    staffProfile?.user?.email
  );
  const phone = pickFirstString(
    profile?.phone,
    profile?.user?.phone,
    staffProfile?.phone,
    staffProfile?.user?.phone
  );
  const displayName =
    pickFirstString(
      profile?.display_name,
      profile?.displayName,
      profile?.name,
      profile?.full_name,
      profile?.fullName,
      staffProfile?.name,
      staffProfile?.full_name
    ) ||
    (email ? email.split('@')[0] : '') ||
    phone ||
    'User';
  const rawRole = staffProfile?.role ?? profile?.role;
  const businessId = pickFirstString(
    staffProfile?.business_id,
    staffProfile?.business,
    profile?.business_id,
    profile?.business,
    profile?.businessId
  );
  const branchId = pickFirstString(
    staffProfile?.branch_id,
    staffProfile?.branch,
    staffProfile?.branchId
  );
  const uid = pickFirstString(
    profile?.uid,
    profile?.id,
    profile?.user_id,
    staffProfile?.user_id,
    email,
    phone,
    staffProfile?.id
  );

  if (!uid) {
    return null;
  }

  const normalizedRole = normalizeRole(rawRole, {
    fallback: 'User',
    preferAdminForGenericUser: Boolean(businessId),
  }) as User['role'];

  return {
    uid,
    email: email || undefined,
    phone: phone || undefined,
    displayName,
    role: normalizedRole,
    branchId: branchId || undefined,
    businessId: businessId || undefined,
    isFuelAttendant:
      staffProfile?.is_fuel_attendant ??
      staffProfile?.isFuelAttendant ??
      undefined,
  };
};

// Create a provider component
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [loading, setLoading] = useState(true);

  const clearAuthStorage = () => {
    localStorage.removeItem(AUTH_STORAGE_KEYS.USER);
    localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS);
    localStorage.removeItem(AUTH_STORAGE_KEYS.TOKENS);
    localStorage.removeItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);
    localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS_CACHE);
    localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS_SETTINGS);
    clearSessionContextStorage();

    const authFetch = require('@/lib/auth-fetch').authFetch;
    if (authFetch && authFetch.logout) {
      authFetch.logout();
    }
  };

  useEffect(() => {
    let cancelled = false;

    const bootstrapAuth = async () => {
      // Check for a user and business in localStorage on initial load
      try {
        const tokens = readValidAuthTokens();
        const hasValidTokens = Boolean(tokens);
        const fallbackUserFromToken = tokens ? buildUserFromToken(tokens.access) : null;
        const storedUser = localStorage.getItem(AUTH_STORAGE_KEYS.USER);
        const storedBusiness = localStorage.getItem(AUTH_STORAGE_KEYS.BUSINESS);
        let restoredUser: User | null = null;

        if (storedUser && hasValidTokens) {
          try {
            const parsedUser = JSON.parse(storedUser);
            const normalizedUser: User = {
              ...parsedUser,
              role: normalizeRole(parsedUser?.role, {
                fallback: 'User',
                preferAdminForGenericUser: Boolean(parsedUser?.businessId),
              }) as User['role'],
            };
            restoredUser = normalizedUser;
            if (!cancelled) {
              setUser(normalizedUser);
            }
            localStorage.setItem(AUTH_STORAGE_KEYS.USER, JSON.stringify(normalizedUser));
          } catch (error) {
            console.error('[Auth] Failed to parse stored user, attempting recovery from profile', error);
            localStorage.removeItem(AUTH_STORAGE_KEYS.USER);
          }
        } else if (storedUser) {
          localStorage.removeItem(AUTH_STORAGE_KEYS.USER);
        }

        if (storedBusiness && hasValidTokens) {
          const parsedBusiness = parseStoredJson<Business>(storedBusiness);
          if (parsedBusiness) {
            if (!cancelled) {
              setBusiness(parsedBusiness);
            }
          } else {
            localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS);
          }
        } else if (storedBusiness) {
          localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS);
        }

        if (hasValidTokens && !restoredUser) {
          try {
            const authFetch = require('@/lib/auth-fetch').authFetch as typeof import('@/lib/auth-fetch').authFetch;
            let staffProfile: any = null;
            let profile: any = null;
            let staffProfileError: unknown = null;
            let profileError: unknown = null;

            try {
              staffProfile = await authFetch.fetch<any>('/staff/me/');
            } catch (error) {
              staffProfileError = error;
              console.warn('[Auth] Staff profile not available, falling back to account profile', error);
            }

            try {
              profile = await authFetch.fetch<any>('/accounts/me/');
            } catch (error) {
              profileError = error;
              console.warn('[Auth] Account profile fetch failed', error);
            }

            const restoreErrors = [staffProfileError, profileError].filter(Boolean);
            const recoverableFailure =
              restoreErrors.length > 0 &&
              restoreErrors.every((error) => isRecoverableBootstrapError(error));
            const rebuiltUser = buildUserFromProfiles(profile, staffProfile);
            const nextUser = rebuiltUser ?? (recoverableFailure ? fallbackUserFromToken : null);

            if (nextUser) {
              restoredUser = nextUser;
              localStorage.setItem(AUTH_STORAGE_KEYS.USER, JSON.stringify(nextUser));
              if (!cancelled) {
                setUser(nextUser);
              }
            } else {
              if (recoverableFailure) {
                console.warn('[Auth] Preserving auth session after recoverable bootstrap failure');
              } else {
                console.warn('[Auth] Valid tokens found but no user profile could be restored');
                clearAuthStorage();
              }
            }
          } catch (error) {
            if (fallbackUserFromToken && isRecoverableBootstrapError(error)) {
              restoredUser = fallbackUserFromToken;
              localStorage.setItem(AUTH_STORAGE_KEYS.USER, JSON.stringify(fallbackUserFromToken));
              if (!cancelled) {
                setUser(fallbackUserFromToken);
              }
              console.warn('[Auth] Restored user from token after recoverable bootstrap failure:', error);
            } else {
              console.warn('[Auth] Failed to rebuild user from profile:', error);
              clearAuthStorage();
            }
          }
        }

        if (!hasValidTokens && (storedUser || storedBusiness)) {
          clearAuthStorage();
        }
      } catch (error) {
        console.error('Failed to parse from localStorage', error);
        clearAuthStorage();
      }

      if (!cancelled) {
        setLoading(false);
      }

      // Initialize sync service connectivity listener for offline-first sync
      syncService.setupConnectivityListener();
      console.log('[Auth] Sync service connectivity listener initialized');
    };

    void bootstrapAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = (userData: User) => {
    const normalizedUserData: User = {
      ...userData,
      role: normalizeRole(userData.role, {
        fallback: 'User',
        preferAdminForGenericUser: Boolean(userData.businessId),
      }) as User['role'],
    };

    // Only clear tokens if we're switching users (different uid)
    const storedUser = localStorage.getItem(AUTH_STORAGE_KEYS.USER);
    let currentUser: User | null = null;
    if (storedUser) {
      try {
        currentUser = JSON.parse(storedUser);
      } catch {
        localStorage.removeItem(AUTH_STORAGE_KEYS.USER);
      }
    }
    
    // If switching to a different user, clear user-scoped caches.
    // Do not eagerly clear auth tokens here because authFetch.login/register
    // already replaces tokens, and clearing here can wipe the new session.
    if (currentUser && currentUser.uid !== normalizedUserData.uid) {
      localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS_CACHE);
      localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS_SETTINGS);
      localStorage.removeItem(AUTH_STORAGE_KEYS.BUSINESS);
      setBusiness(null);

      // Only clear tokens if none are stored (e.g., offline/manual user switch).
      const rawTokens =
        localStorage.getItem(AUTH_STORAGE_KEYS.TOKENS) ??
        localStorage.getItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);
      let hasStoredTokens = false;
      if (rawTokens) {
        try {
          const parsedTokens = JSON.parse(rawTokens);
          hasStoredTokens = Boolean(parsedTokens?.access && parsedTokens?.refresh);
        } catch {
          hasStoredTokens = false;
        }
      }

      if (!hasStoredTokens) {
        localStorage.removeItem(AUTH_STORAGE_KEYS.TOKENS);
        localStorage.removeItem(AUTH_STORAGE_KEYS.LEGACY_TOKENS);
        const authFetch = require('@/lib/auth-fetch').authFetch;
        if (authFetch && authFetch.logout) {
          authFetch.logout();
        }
      }
    }
    
    // Now set the new user
    localStorage.setItem(AUTH_STORAGE_KEYS.USER, JSON.stringify(normalizedUserData));
    setUser(normalizedUserData);
  };

  const logout = () => {
    clearAuthStorage();
    setUser(null);
    setBusiness(null);
  };

  const selectBusiness = (businessData: Business) => {
    localStorage.setItem(AUTH_STORAGE_KEYS.BUSINESS, JSON.stringify(businessData));
    setBusiness(businessData);
  };

  const value = { user, business, loading, login, logout, selectBusiness };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Create a custom hook to use the auth context
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
