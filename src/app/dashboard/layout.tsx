'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  LayoutDashboard,
  Package,
  Settings,
  ShoppingBag,
  Users,
  Download,
  ChevronDown,
  Bell,
  Plus,
  FileText,
  Truck,
  Building,
  Printer,
  Archive,
  AlertTriangle,
  Pill,
  MonitorPlay,
  BarChart2,
  BookOpen,
  ClipboardList,
  ChefHat,
  Loader2,
  Edit,
  History,
  CreditCard,
  BookUser,
  FileSignature,
  ShieldCheck,
  Lock,
  UserCheck,
  Share2,
  Group,
  Utensils,
  RefreshCw,
  Trash2,
  CheckCircle2,
  ShoppingBasket,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLiveQuery } from 'dexie-react-hooks';
import { format, parseISO, isBefore, addDays } from 'date-fns';

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
  SidebarFooter,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { HandyPosLogo } from '@/components/icons/logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  DashboardHeader,
  OPEN_ORDERS_MODAL_EVENT,
  ORDERS_ATTENTION_COUNT_EVENT,
} from '@/components/dashboard-header';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useSyncStatus } from '@/hooks/use-sync-status';
import { useSubscriptionFeatureAccess } from '@/hooks/use-subscription-feature-access';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { DashboardSubscriptionGuard } from '@/components/dashboard-subscription-guard';
import { AppVersionLabel } from '@/components/app-version-label';
import { syncBusinessBranchesFromServer } from '@/lib/branch-sync';
import { isKitchenBusinessType, normalizeBusinessType } from '@/lib/inventory/config';
import { formatInventoryQuantity, formatNotificationBadgeCount } from '@/lib/quantity-format';
import {
  readStoredBusinessSettingsObject,
  readStoredCustomSalesSectionSettings,
  resolveCustomSalesSectionSettings,
} from '@/lib/custom-sales-section';

// Helper to remove auth sync items from queue
const removeAuthSyncItem = (itemId: string) => {
  const SYNC_QUEUE_KEY = 'handypos-sync-queue';
  try {
    // Remove from localStorage
    const stored = localStorage.getItem(SYNC_QUEUE_KEY);
    if (stored) {
      const queue = JSON.parse(stored);
      const filtered = queue.filter((item: any) => item.id !== itemId);
      localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(filtered));
      console.log('[SyncQueue] Removed auth item from persistent queue:', itemId);
    }
    
    // Also need to clear from authFetch's internal queue
    // Since we can't directly access authFetch's private queue, we'll mark it as cancelled
    // by storing a list of cancelled items
    const CANCELLED_KEY = 'handypos-cancelled-sync-items';
    const cancelled = JSON.parse(localStorage.getItem(CANCELLED_KEY) || '[]');
    if (!cancelled.includes(itemId)) {
      cancelled.push(itemId);
      localStorage.setItem(CANCELLED_KEY, JSON.stringify(cancelled));
    }
  } catch (e) {
    console.error('[SyncQueue] Failed to remove item from queue:', e);
  }
};

const toBackendBranchId = (id: string): string => {
  const normalized = String(id || '').trim();
  if (!normalized) return normalized;

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyBranchMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyBranchMatch) return legacyBranchMatch[1];

  if (/^\d+$/.test(normalized)) return normalized;
  return normalized;
};

const getBranchIdCandidates = (branchId?: string | null): string[] => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return [];

  const backendId = toBackendBranchId(normalized);
  const candidates = new Set<string>([normalized, backendId]);

  if (/^\d+$/.test(backendId)) {
    candidates.add(`BRN-${backendId}`);
    candidates.add(`branch-${backendId}`);
  }

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
};

// Helper to clear all failed order sync items
const clearFailedOrders = () => {
  const SYNC_QUEUE_KEY = 'handypos-sync-queue';
  const CANCELLED_KEY = 'handypos-cancelled-sync-items';
  try {
    const stored = localStorage.getItem(SYNC_QUEUE_KEY);
    if (stored) {
      const queue = JSON.parse(stored);
      // Filter out all failed order items (POST to /sessions/orders/)
      const filtered = queue.filter((item: any) => 
        !item.url?.includes('/sessions/orders/') || item.error === undefined
      );
      
      // Add failed orders to cancelled list
      const failedOrders = queue.filter((item: any) => 
        item.url?.includes('/sessions/orders/') && item.error
      );
      
      const cancelled = JSON.parse(localStorage.getItem(CANCELLED_KEY) || '[]');
      failedOrders.forEach((order: any) => {
        if (!cancelled.includes(order.id)) {
          cancelled.push(order.id);
        }
      });
      
      localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(filtered));
      localStorage.setItem(CANCELLED_KEY, JSON.stringify(cancelled));
      console.log('[SyncQueue] Cleared', failedOrders.length, 'failed orders from queue');
    }
  } catch (e) {
    console.error('[SyncQueue] Failed to clear failed orders:', e);
  }
};
import { useAuth, type User } from '@/hooks/use-auth';
import { useRBAC } from '@/hooks/use-rbac';
import { useToast } from '@/hooks/use-toast';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { db, type Subscription, type InventoryItem, type PurchaseRecord } from '@/lib/db';
import { plans } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/auth-fetch';

import type { Permission } from '@/lib/rbac/permissions';
import { hasPermission as checkPermission } from '@/lib/rbac/permissions';

const ThemeCustomizer = dynamic(
  () => import('@/components/theme-customizer').then((module) => module.ThemeCustomizer),
  {
    ssr: false,
    loading: () => null,
  }
);

const PosModal = dynamic(
  () => import('@/components/pos/pos-modal').then((module) => module.PosModal),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

const navSections = [
  {
    title: 'Workspace',
    items: [
      { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'view_dashboard' as Permission },
      { href: '/dashboard/pos', icon: MonitorPlay, label: 'POS', permission: 'access_pos' as Permission },
      { href: '/dashboard/sessions', icon: History, label: 'Sessions', permission: 'view_sessions' as Permission },
    ],
  },
  {
    title: 'Restaurant',
    items: [
      { href: '/dashboard/menu', icon: BookOpen, label: 'Menu', permission: 'view_menu' as Permission },
      { href: '/dashboard/kitchen', icon: ChefHat, label: 'Kitchen', permission: 'view_kitchen' as Permission },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { href: '/dashboard/inventory', icon: Boxes, label: 'Products & Stock', permission: 'view_inventory' as Permission },
      { href: '/dashboard/inventory/audit', icon: ClipboardList, label: 'Stock Audit', permission: 'view_inventory' as Permission },
      { href: '/dashboard/suppliers', icon: Truck, label: 'Suppliers', permission: 'view_suppliers' as Permission },
    ],
  },
  {
    title: 'Business',
    items: [
      { href: '/dashboard/customers', icon: BookUser, label: 'Customers', permission: 'view_customers' as Permission },
      { href: '/dashboard/invoicing', icon: FileSignature, label: 'Quotations & Invoices', permission: 'view_invoices' as Permission },
      { href: '/dashboard/sales', icon: BarChart2, label: 'Reports', permission: 'view_reports' as Permission },
      { href: '/dashboard/custom-section', icon: Boxes, label: 'Custom Section', permission: 'view_reports' as Permission },
      { href: '/dashboard/expenses', icon: CreditCard, label: 'Expenses', permission: 'view_expenses' as Permission },
      { href: '/dashboard/staff', icon: Users, label: 'Staff', permission: 'manage_staff' as Permission },
    ],
  },
];

const navItems = navSections.flatMap((section) => section.items);

const settingsNav = [
  { href: '/dashboard/settings', icon: Settings, label: 'Settings', permission: 'manage_settings' as Permission },
  { href: '/dashboard/settings/branches', icon: Building, label: 'Branches', permission: 'manage_settings' as Permission },
  { href: '/dashboard/audit', icon: UserCheck, label: 'Audit Log', permission: 'view_audit_log' as Permission },
];

const profileSchema = z.object({
  displayName: z.string().min(2, 'Display name must be at least 2 characters.'),
  email: z.string().email(),
});

type ProfileFormValues = z.infer<typeof profileSchema>;

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters.'),
  confirmPassword: z.string().min(1, 'Please confirm your password.'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match.',
  path: ['confirmPassword'],
});

type PasswordFormValues = z.infer<typeof passwordSchema>;

function UserProfileModal({ user, isOpen, onOpenChange }: { user: User, isOpen: boolean, onOpenChange: (open: boolean) => void }) {
  const { login: updateUser } = useAuth();
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const getInitials = (value?: string) => {
    const text = (value || '').trim();
    if (!text) return 'U';

    const normalized = text.includes('@') ? text.split('@')[0] : text;
    const parts = normalized.replace(/[_\-.]+/g, ' ').split(/\s+/).filter(Boolean);

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  };
  const userInitials = getInitials(user.displayName || user.email);

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: user?.displayName || '',
      email: user?.email || '',
    },
  });

  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });
  
  const { reset } = form;
  const { reset: resetPasswordForm } = passwordForm;
  const canChangePassword = user.role === 'Admin';

  useEffect(() => {
    if (isOpen) {
      reset({
        displayName: user.displayName || '',
        email: user.email || '',
      });
      resetPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    }
  }, [user, isOpen, reset, resetPasswordForm]);

  const onSubmit = (data: ProfileFormValues) => {
    setIsSaving(true);
    // Simulate API call
    setTimeout(() => {
      const updatedUserData = { ...user, ...data };
      updateUser(updatedUserData);
      setIsSaving(false);
      setIsEditing(false);
    }, 1000);
  };

  const onChangePassword = async (data: PasswordFormValues) => {
    if (!canChangePassword) {
      toast({
        variant: 'destructive',
        title: 'Permission denied',
        description: 'Only admins can change passwords.',
      });
      return;
    }

    setIsSavingPassword(true);
    try {
      await authFetch.fetch('/accounts/change-password/', {
        method: 'POST',
        body: JSON.stringify({
          current_password: data.currentPassword,
          new_password: data.newPassword,
          confirm_password: data.confirmPassword,
        }),
      });
      toast({
        title: 'Password updated',
        description: 'Your password has been changed successfully.',
      });
      resetPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
      setIsChangingPassword(false);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Password update failed',
        description: error?.message || 'Could not change password. Please try again.',
      });
    } finally {
      setIsSavingPassword(false);
    }
  };
  
  const handleOpenChange = (open: boolean) => {
      onOpenChange(open);
      if (!open) {
          setIsEditing(false); // Reset edit state when modal closes
          setIsChangingPassword(false);
      }
  }

  if (!user) return null;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>My Profile</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Edit your personal information.' : 'View your personal information.'}
          </DialogDescription>
        </DialogHeader>
        
        {isEditing ? (
          <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="flex flex-col items-center gap-4 py-4">
                <Avatar className="h-24 w-24">
                  <AvatarFallback className="text-2xl font-semibold">{userInitials}</AvatarFallback>
                </Avatar>
              </div>
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Your name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email Address</FormLabel>
                    <FormControl>
                      <Input placeholder="Your email" {...field} readOnly disabled />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter className="pt-4">
                <Button variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Changes
                </Button>
              </DialogFooter>
            </form>
          </FormProvider>
        ) : (
          <div>
            <div className="flex flex-col items-center gap-4 py-4">
              <Avatar className="h-24 w-24">
                <AvatarFallback className="text-2xl font-semibold">{userInitials}</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <h2 className="text-xl font-semibold">{user.displayName || user.email}</h2>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                    <span className="text-muted-foreground">Role:</span>
                    <span className="font-medium">{user.role}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-muted-foreground">Branch:</span>
                    <span className="font-medium">Main Branch</span>
                </div>
                 <div className="flex justify-between">
                    <span className="text-muted-foreground">Last Login:</span>
                    <span className="font-medium">
                      {new Date().toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                </div>
            </div>
            {canChangePassword && (
              <div className="mt-6 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Change Password</p>
                    <p className="text-xs text-muted-foreground">Admin-only action</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsChangingPassword((prev) => !prev)}
                  >
                    {isChangingPassword ? 'Cancel' : 'Change'}
                  </Button>
                </div>
                {isChangingPassword && (
                  <FormProvider {...passwordForm}>
                    <form onSubmit={passwordForm.handleSubmit(onChangePassword)} className="mt-4 space-y-3">
                      <FormField
                        control={passwordForm.control}
                        name="currentPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Current Password</FormLabel>
                            <FormControl>
                              <Input type="password" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={passwordForm.control}
                        name="newPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>New Password</FormLabel>
                            <FormControl>
                              <Input type="password" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={passwordForm.control}
                        name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Confirm Password</FormLabel>
                            <FormControl>
                              <Input type="password" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="pt-2">
                        <Button type="submit" disabled={isSavingPassword}>
                          {isSavingPassword && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Update Password
                        </Button>
                      </div>
                    </form>
                  </FormProvider>
                )}
              </div>
            )}
            <DialogFooter className="pt-6">
              <Button variant="outline" className="w-full" onClick={() => setIsEditing(true)}>
                <Edit className="mr-2 h-4 w-4" /> Edit Profile
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const LOCAL_STORAGE_KEYS = {
    BRANCHES: 'handypos-branches',
    ACTIVE_BRANCH: 'handypos-active-branch',
    CURRENT_BRANCH: 'handypos-current-branch-id',
    AUTH_TOKENS: 'handypos-auth-tokens',
    LEGACY_AUTH_TOKENS: 'handy-pos-auth-tokens',
};

type Branch = { id: string; name: string; address: string; backendId?: string; createdAt?: string; };

const normalizeStoredBranch = (branch: any): Branch | null => {
    const id = String(branch?.id ?? branch?.backendId ?? '').trim();
    if (!id) {
      return null;
    }

    const backendId = String(branch?.backendId ?? '').trim();

    return {
      id,
      name: String(branch?.name ?? '').trim() || 'Branch',
      address: String(branch?.address ?? '').trim(),
      backendId: backendId || undefined,
      createdAt: String(branch?.createdAt ?? branch?.created_at ?? '').trim() || undefined,
    };
};

const isMainBranchName = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'main branch' || normalized.endsWith(' main branch');
};

const getBranchCreatedTimestamp = (branch: Partial<Branch>): number | null => {
  const createdAt = String(branch.createdAt ?? '').trim();
  if (!createdAt) {
    return null;
  }

  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const getBranchNumericOrder = (branch: Pick<Branch, 'id' | 'backendId'>): number | null => {
  const candidates = [branch.backendId, branch.id];

  for (const candidate of candidates) {
    const numericMatch = String(candidate ?? '').trim().match(/\d+/)?.[0];
    if (!numericMatch) {
      continue;
    }

    const numericValue = Number.parseInt(numericMatch, 10);
    if (!Number.isNaN(numericValue)) {
      return numericValue;
    }
  }

  return null;
};

const resolvePrimaryBranch = (branches: Branch[]): Branch | null => {
  if (branches.length === 0) {
    return null;
  }

  return (
    [...branches].sort((left, right) => {
      const leftCreatedAt = getBranchCreatedTimestamp(left);
      const rightCreatedAt = getBranchCreatedTimestamp(right);

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
    })[0] || null
  );
};

const matchesBranchId = (branch: Pick<Branch, 'id' | 'backendId'>, branchId?: string | null): boolean => {
  const targetCandidates = new Set(getBranchIdCandidates(branchId));
  if (targetCandidates.size === 0) {
    return false;
  }

  const branchCandidates = new Set([
    ...getBranchIdCandidates(branch.id),
    ...getBranchIdCandidates(branch.backendId),
  ]);

  for (const candidate of branchCandidates) {
    if (targetCandidates.has(candidate)) {
      return true;
    }
  }

  return false;
};

const getPreferredBranchStorageId = (branch: Pick<Branch, 'id' | 'backendId'>): string => {
  const preferredId = String(branch.backendId ?? '').trim();
  if (preferredId) {
    return preferredId;
  }

  return String(branch.id ?? '').trim();
};

const persistActiveBranchSelection = (branch: Branch) => {
  if (typeof window === 'undefined') {
    return;
  }

  const storageBranchId = getPreferredBranchStorageId(branch);
  localStorage.setItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH, storageBranchId);
  localStorage.setItem(LOCAL_STORAGE_KEYS.CURRENT_BRANCH, storageBranchId);

  try {
    localStorage.setItem(`handypos-branch-${storageBranchId}`, JSON.stringify({
      ...branch,
      id: storageBranchId,
      backendId: branch.backendId || storageBranchId,
    }));
  } catch (error) {
    console.warn('[Header] Failed to cache active branch details:', error);
  }
};

const getStoredPreferredBranchId = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return (
    localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH) ||
    localStorage.getItem(LOCAL_STORAGE_KEYS.CURRENT_BRANCH) ||
    null
  );
};

const getInitialActiveBranch = (): Branch | null => {
  const initialBranches = getInitialBranches();
  const storedBranchId = getStoredPreferredBranchId();

  if (initialBranches.length === 0) {
    return null;
  }

  return (
    initialBranches.find((branch) => matchesBranchId(branch, storedBranchId)) ||
    initialBranches[0] ||
    null
  );
};

const getInitialBranches = (): Branch[] => {
    if (typeof window === 'undefined') {
        return [];
    }

    let branches: Branch[] = [];
    try {
        const storedBranches = localStorage.getItem(LOCAL_STORAGE_KEYS.BRANCHES);
        const parsedBranches = storedBranches ? JSON.parse(storedBranches) : [];
        branches = Array.isArray(parsedBranches)
          ? parsedBranches
              .map((branch) => normalizeStoredBranch(branch))
              .filter((branch): branch is Branch => Boolean(branch))
          : [];
    } catch (e) {
        branches = [];
        console.error("Failed to parse branches from localStorage", e);
    }
    
    return branches;
};

const normalizePath = (path: string): string => {
  if (!path) return '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
};

const isNavItemActive = (pathname: string, href: string): boolean => {
  const currentPath = normalizePath(pathname);
  const targetPath = normalizePath(href);

  if (targetPath === '/dashboard') {
    return currentPath === '/dashboard';
  }

  return currentPath === targetPath || currentPath.startsWith(`${targetPath}/`);
};


function SyncQueueDropdown({ branchId }: { branchId: string | null }) {
  const [syncQueue, setSyncQueue] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { dirtyRecords } = useSyncStatus(branchId);

  useEffect(() => {
    const updateQueue = () => {
      // Get list of cancelled items
      const CANCELLED_KEY = 'handypos-cancelled-sync-items';
      const cancelled = JSON.parse(localStorage.getItem(CANCELLED_KEY) || '[]');
      
      // Authenticated request queue (settings, sessions, etc.)
      const status = authFetch.getSyncQueueStatus();
      const authItems = (status.items || [])
        .filter((item: any) => !cancelled.includes(item.id)) // Filter out cancelled items
        .map((item: any) => {
          // Extract entity type from metadata or URL
          const entityType = item.entityType || item.domain || 'item';
          const entityId = item.entityId || item.url?.split('/').pop() || 'unknown';
          
          return {
            source: 'auth',
            id: item.id,
            method: item.method,
            url: item.url,
            retries: item.retries,
            error: item.error,
            entityType,
            entityId,
            domain: item.domain,
          };
        });

      // Map dirty records to display format
      const dirtyItems = (dirtyRecords || []).map((record: any) => {
        const operationMap: { [key: string]: string } = {
          'create': 'POST',
          'update': 'PUT',
          'delete': 'DELETE',
        };
        
        return {
          source: 'dirty',
          id: record.id,
          method: operationMap[record.operation] || 'UPDATE',
          url: `/api/inventory/${record.type.toLowerCase()}/${record.id}`,
          retries: 0,
          error: null,
          entityType: record.type,
          entityId: record.id,
          name: record.name,
        };
      });

      setSyncQueue([...dirtyItems, ...authItems]);
    };

    updateQueue();
    const interval = setInterval(updateQueue, 1000);
    return () => clearInterval(interval);
  }, [dirtyRecords, branchId]);

  const getActionLabel = (item: any) => {
    const action = item.method?.toUpperCase() || 'UNKNOWN';
    
    // Get entity type label
    let entityLabel = 'Item';
    if (item.entityType) {
      entityLabel = item.entityType;
    } else if (item.domain) {
      entityLabel = item.domain.charAt(0).toUpperCase() + item.domain.slice(1);
    }
    
    // Get entity ID or name
    const entityId = item.entityId || item.url?.split('/').pop() || 'unknown';
    const shortId = entityId.length > 12 ? entityId.substring(0, 12) + '...' : entityId;
    
    return `${action} ${entityLabel} (${shortId})`;
  };

  const getActionIcon = (item: any) => {
    const method = item.method?.toUpperCase();
    switch (method) {
      case 'POST':
        return <Plus className="h-4 w-4 text-green-600" />;
      case 'PUT':
      case 'PATCH':
        return <Edit className="h-4 w-4 text-blue-600" />;
      case 'DELETE':
        return <Trash2 className="h-4 w-4 text-red-600" />;
      default:
        return <RefreshCw className="h-4 w-4 text-gray-600" />;
    }
  };

  const handleRemoveItem = (item: any) => {
    if (item.source === 'auth') {
      // For auth items, completely remove from persistent queue
      console.log('[SyncQueue] Completely removing auth item from queue:', item.id);
      removeAuthSyncItem(item.id);
      // Update local state
      setSyncQueue(prev => prev.filter(i => i.id !== item.id));
    }
  };

  if (syncQueue.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>All changes synced ✓</p>
      </div>
    );
  }

  return (
    <div className="max-h-[min(70dvh,24rem)] overflow-y-auto">
      <DropdownMenuLabel className="px-2 py-1.5">Pending Sync ({syncQueue.length})</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {syncQueue.map((item, index) => (
        <div key={item.id || index} className="group rounded-sm px-2 py-2 text-sm hover:bg-accent">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 shrink-0">{getActionIcon(item)}</div>
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{getActionLabel(item)}</p>
              <p className="break-words text-xs text-muted-foreground sm:truncate">{item.url}</p>
              {item.error && (
                <p className="mt-1 break-words text-xs text-destructive">Error: {item.error}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {item.retries > 0 && (
                <Badge variant="outline" className="text-xs">
                  Retry {item.retries}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                onClick={() => handleRemoveItem(item)}
                title="Remove from queue"
              >
                <X className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


function Header({
  onPosClick,
  onProcessSaleOrder,
  multiBranchEnabled,
}: {
  onPosClick?: () => void;
  onProcessSaleOrder?: (orderId: string) => void;
  multiBranchEnabled: boolean;
}) {
  const { user, logout, business } = useAuth();
  const router = useRouter();
  const [isProfileModalOpen, setProfileModalOpen] = useState(false);
  const subscription = useLiveQuery(() => db.subscriptions.get('sub_main-business'));

  // Debug: log user object
  useEffect(() => {
    console.log('[DEBUG HEADER] User object:', user);
  }, [user]);
  
  const [branches, setBranches] = useState<Branch[]>(() => getInitialBranches());
  const [activeBranchId, setActiveBranchId] = useState<string | null>(() => getStoredPreferredBranchId());
  const [activeBranch, setActiveBranch] = useState<Branch | null>(() => getInitialActiveBranch());
  const [selectedExpiryBatch, setSelectedExpiryBatch] = useState<PurchaseRecord | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [businessName, setBusinessName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem('handypos-business-name');
      return cached || 'Handy POS';
    }
    return 'Handy POS';
  });
  const businessNameLoadedRef = React.useRef(false);
  const { pendingCount } = useSyncStatus(activeBranchId);
  const primaryBranch = useMemo(() => resolvePrimaryBranch(branches), [branches]);
  const primaryBranchId = primaryBranch ? getPreferredBranchStorageId(primaryBranch) : null;

  const isProPlan = subscription?.planId === 'pro' || subscription?.status === 'active' || !subscription;

  // Load business name from IndexedDB - only once
  useEffect(() => {
    if (business?.id && !businessNameLoadedRef.current) {
      businessNameLoadedRef.current = true;
      const loadBusinessName = async () => {
        const businessData = await db.business.get(business.id);
        if (businessData?.name) {
          setBusinessName(businessData.name);
          localStorage.setItem('handypos-business-name', businessData.name);
        }
      };
      loadBusinessName();
    }
  }, [business?.id]);

  // Monitor sync queue handled by useSyncStatus
  // Clear failed orders on mount
  useEffect(() => {
    clearFailedOrders();
  }, []);

  const syncHeaderBranchState = (nextBranches: Branch[], preferredBranchId?: string | null) => {
    if (typeof window === 'undefined') {
      return;
    }

    const normalizedBranches = nextBranches
      .map((branch) => normalizeStoredBranch(branch))
      .filter((branch): branch is Branch => Boolean(branch));
    const nextPrimaryBranch = resolvePrimaryBranch(normalizedBranches);
    const selectableBranches =
      !multiBranchEnabled && nextPrimaryBranch ? [nextPrimaryBranch] : normalizedBranches;
    const storedActiveBranchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    const storedCurrentBranchId = localStorage.getItem(LOCAL_STORAGE_KEYS.CURRENT_BRANCH);
    const resolvedActiveBranch =
      selectableBranches.find((branch) => matchesBranchId(branch, preferredBranchId)) ||
      selectableBranches.find((branch) => matchesBranchId(branch, storedActiveBranchId)) ||
      selectableBranches.find((branch) => matchesBranchId(branch, storedCurrentBranchId)) ||
      (!multiBranchEnabled ? nextPrimaryBranch : null) ||
      selectableBranches[0] ||
      null;
    const fallbackBranchId =
      preferredBranchId ||
      storedActiveBranchId ||
      storedCurrentBranchId ||
      nextPrimaryBranch?.id ||
      selectableBranches[0]?.id ||
      null;
    const resolvedActiveBranchId = resolvedActiveBranch
      ? getPreferredBranchStorageId(resolvedActiveBranch)
      : fallbackBranchId;

    setBranches(normalizedBranches);
    setActiveBranchId(resolvedActiveBranchId);
    setActiveBranch(resolvedActiveBranch);

    if (resolvedActiveBranch) {
      persistActiveBranchSelection(resolvedActiveBranch);
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
        const allBranches = getInitialBranches();
        syncHeaderBranchState(allBranches);

        // Listen for branches updated event
        const handleBranchesUpdated = (event: Event) => {
            const customEvent = event as CustomEvent;
            const updatedBranches = customEvent.detail?.branches;
            if (updatedBranches && Array.isArray(updatedBranches)) {
                console.log('[Header] Branches updated event received:', updatedBranches);
                syncHeaderBranchState(updatedBranches);
            }
        };

        const handleBranchChanged = (event: Event) => {
            const customEvent = event as CustomEvent;
            const nextBranchId = String(customEvent.detail?.branchId || '').trim();
            const nextBranches = getInitialBranches();
            console.log('[Header] Branch changed event received:', nextBranchId);
            syncHeaderBranchState(nextBranches, nextBranchId || undefined);
        };

        window.addEventListener('branchesUpdated', handleBranchesUpdated);
        window.addEventListener('branchChanged', handleBranchChanged);
        return () => {
          window.removeEventListener('branchesUpdated', handleBranchesUpdated);
          window.removeEventListener('branchChanged', handleBranchChanged);
        };
    }
  }, [multiBranchEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined' || !business?.id) {
      return;
    }

    const needsBranchSync =
      branches.length === 0 ||
      (activeBranchId !== null &&
        !branches.some((branch) => matchesBranchId(branch, activeBranchId))) ||
      (!activeBranch && Boolean(activeBranchId));

    if (!needsBranchSync) {
      return;
    }

    let cancelled = false;

    const syncBranches = async () => {
      try {
        const preferredBranchId =
          activeBranchId ||
          getStoredPreferredBranchId() ||
          user?.branchId ||
          undefined;
        const { branches: syncedBranches, activeBranchId: syncedActiveBranchId } =
          await syncBusinessBranchesFromServer(
            business.id,
            preferredBranchId
          );

        if (cancelled) {
          return;
        }

        syncHeaderBranchState(syncedBranches, syncedActiveBranchId);
      } catch (error) {
        console.warn('[Header] Failed to sync branches from server:', error);
      }
    };

    void syncBranches();

    return () => {
      cancelled = true;
    };
  }, [business?.id, user?.branchId, branches, activeBranchId, activeBranch, multiBranchEnabled]);

  const lowStockItems = useLiveQuery(
    async () => {
      const branchCandidates = getBranchIdCandidates(activeBranchId);
      if (branchCandidates.length === 0) return [];

      return db.inventory
        .where('branchId')
        .anyOf(branchCandidates)
        .and((item) => {
          if (item._operation === 'delete') return false;
          if (item.itemType === 'sellable' && item.isProduced) return false;

          const stockUnits = Number(item.stockUnits || 0);
          const reorderLevel = Number(item.reorderLevel || 0);
          const status = String(item.status || '').trim();
          const isLowByStatus = status === 'Low Stock' || status === 'Out of Stock';
          const isLowByQuantity = stockUnits <= reorderLevel;

          return isLowByStatus || isLowByQuantity;
        })
        .toArray();
    },
    [activeBranchId]
  ) || [];

  const expiringItems = useLiveQuery(
    () => {
        const branchCandidates = getBranchIdCandidates(activeBranchId);
        if (branchCandidates.length === 0) return [];
        const ninetyDaysFromNow = addDays(new Date(), 90).toISOString();
        return db.purchaseHistory
            .where('branchId').anyOf(branchCandidates)
            .and(item => (
              item._operation !== 'delete' &&
              !!item.expiryDate &&
              item.expiryDate <= ninetyDaysFromNow &&
              isBefore(new Date(), parseISO(item.expiryDate)) &&
              item.quantityRemaining > 0
            ))
            .toArray();
    },
    [activeBranchId]
  ) || [];

  const totalNotifications = lowStockItems.length + expiringItems.length;
  const notificationBadgeLabel = formatNotificationBadgeCount(totalNotifications);
  const [attentionOrderCount, setAttentionOrderCount] = useState(0);

  useEffect(() => {
    const handleOrderCount = (event: Event) => {
      const customEvent = event as CustomEvent<{ count?: number }>;
      const nextCount = Number(customEvent.detail?.count ?? 0);
      setAttentionOrderCount(Number.isFinite(nextCount) ? nextCount : 0);
    };

    window.addEventListener(ORDERS_ATTENTION_COUNT_EVENT, handleOrderCount);
    return () => {
      window.removeEventListener(ORDERS_ATTENTION_COUNT_EVENT, handleOrderCount);
    };
  }, []);

  const orderBadgeLabel = attentionOrderCount > 99 ? '99+' : String(attentionOrderCount);
  const openOrdersModal = () => {
    window.dispatchEvent(new CustomEvent(OPEN_ORDERS_MODAL_EVENT));
  };

  const renderSyncQueueButton = () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          title={pendingCount > 0 ? `${pendingCount} queued action${pendingCount !== 1 ? 's' : ''}` : 'Sync status'}
        >
          <RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />
          {pendingCount > 0 && (
            <Badge
              className="absolute top-1 right-1 h-4 w-4 justify-center p-0 text-[10px]"
              variant="secondary"
            >
              {pendingCount}
            </Badge>
          )}
          <span className="sr-only">Sync status</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="tauri-android-safe-bottom w-[calc(100vw-1rem)] max-w-80 p-0 sm:w-80">
        <SyncQueueDropdown branchId={activeBranchId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const handleSetBranch = (branch: Branch) => {
    if (!multiBranchEnabled && primaryBranch && !matchesBranchId(branch, primaryBranchId)) {
      return;
    }

    if (matchesBranchId(branch, activeBranchId)) {
      return;
    }

    const storageBranchId = getPreferredBranchStorageId(branch);
    setActiveBranchId(storageBranchId);
    setActiveBranch(branch);
    persistActiveBranchSelection(branch);
    window.dispatchEvent(new CustomEvent('branchChanged', { detail: { branchId: storageBranchId } }));

    console.log('[Header] Branch switched to:', branch.name, '- Reloading page');
    
    // Reload the entire page to refresh all data for the new branch
    window.location.reload();
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };
  
  if (!user) {
      return (
          <DashboardHeader>
              <div className="flex items-center gap-4">
                  <SidebarTrigger className="h-9 w-9 shrink-0" />
                  <div className="hidden lg:flex items-center gap-2">
                  <h1 className="text-xl font-semibold">Handy POS</h1>
                  <div className="w-48 h-9 bg-muted rounded-md animate-pulse" />
                  </div>
              </div>
              <div className="flex flex-1 items-center justify-end gap-2 md:gap-4">
                  <div className="hidden w-full max-w-sm lg:block h-10 bg-muted rounded-md animate-pulse" />
              </div>
          </DashboardHeader>
      );
  }

  return (
    <>
      <DashboardHeader
        branchId={activeBranchId}
        onProcessSaleOrder={onProcessSaleOrder}
        mobileTopActions={user.role !== 'Cashier' ? renderSyncQueueButton() : null}
      >
        <div className="flex items-center gap-4">
          <SidebarTrigger className="h-9 w-9 shrink-0" />
          <div className="hidden lg:flex items-center gap-2">
            <h1 className="text-xl font-semibold">{businessName.toUpperCase()}</h1>
            {user.role === 'Admin' ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex items-center gap-1"
                  >
                    {activeBranch?.name || 'Select Branch'}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                  <DropdownMenuLabel>{multiBranchEnabled ? 'Switch Branch' : 'Primary Branch Only'}</DropdownMenuLabel>
                  {branches.length > 0 ? (
                    branches.map((branch) => {
                      const isDisabled =
                        !multiBranchEnabled &&
                        primaryBranch &&
                        !matchesBranchId(branch, primaryBranchId);

                      return (
                        <DropdownMenuItem
                          key={branch.id}
                          disabled={isDisabled}
                          onSelect={() => handleSetBranch(branch)}
                        >
                          {branch.name}
                        </DropdownMenuItem>
                      );
                    })
                  ) : (
                    <DropdownMenuItem disabled>
                      No branches configured
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Badge variant="secondary">
                {activeBranch?.name}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2 md:gap-4">
          {/* Search field - commented out
          {user.role !== 'Cashier' && (
            <div className="hidden w-full max-w-sm lg:block">
              <form>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="w-full bg-background/50 pl-10"
                    placeholder="Search products, customers, orders..."
                  />
                </div>
              </form>
            </div>
          )}
          */}

          <div className="flex items-center gap-1">
            {user.role !== 'Kitchen Staff' && (
              <Button size="sm" className="px-2 sm:px-3" onClick={() => onPosClick?.()}>
                <MonitorPlay className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">POS</span>
              </Button>
            )}

            {user.role !== 'Cashier' && (
              <div className="hidden items-center gap-2 sm:flex">
                {renderSyncQueueButton()}
              </div>
            )}

            {activeBranchId && (
              <Button
                variant="ghost"
                size="icon"
                className="relative"
                title={
                  attentionOrderCount > 0
                    ? `${attentionOrderCount} order${attentionOrderCount === 1 ? '' : 's'} need attention`
                    : 'Open orders'
                }
                onClick={openOrdersModal}
              >
                <ShoppingBasket className="h-4 w-4" />
                {attentionOrderCount > 0 && (
                  <Badge
                    className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center px-1 text-[10px]"
                    variant="destructive"
                  >
                    {orderBadgeLabel}
                  </Badge>
                )}
                <span className="sr-only">Orders</span>
              </Button>
            )}

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="relative">
                  <Bell />
                  {totalNotifications > 0 && (
                    <Badge
                      className="absolute top-1 right-1 flex h-4 min-w-[1rem] items-center justify-center px-1 text-[10px]"
                      variant="destructive"
                    >
                      {notificationBadgeLabel}
                    </Badge>
                  )}
                  <span className="sr-only">Notifications</span>
                </Button>
              </SheetTrigger>
              <SheetContent className="tauri-android-sidebar-safe-top flex flex-col">
                <SheetHeader>
                  <SheetTitle>Notifications & Alerts</SheetTitle>
                  <SheetDescription>
                    You have {totalNotifications} new critical alerts.
                  </SheetDescription>
                </SheetHeader>
                <div className="mt-4 flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
                  {lowStockItems.map((item) => (
                    <div key={`low-${item.id}`} className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
                      <div className="mt-1 flex h-5 w-5 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-600">
                        <AlertTriangle className="h-3 w-3" />
                      </div>
                      <div>
                        <p className="font-semibold text-sm">
                          Low Stock: {item.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Only {formatInventoryQuantity(item.stockUnits)} {item.unitType} remaining. Reorder level is {formatInventoryQuantity(item.reorderLevel)}.
                        </p>
                        <Button size="xs" variant="outline" className="mt-2 text-xs h-7">
                          Create Purchase Order
                        </Button>
                      </div>
                    </div>
                  ))}
                  {expiringItems.map((item) => (
                     <div key={`exp-${item.id}`} className="flex items-start gap-3 rounded-lg border border-orange-500/50 bg-orange-500/10 p-3">
                        <div className="mt-1 flex h-5 w-5 items-center justify-center rounded-full bg-orange-500/20 text-orange-600">
                            <Pill className="h-3 w-3" />
                        </div>
                        <div>
                            <p className="font-semibold text-sm">Batch Expiring Soon</p>
                            <p className="text-xs text-muted-foreground">
                                {item.productName} (Batch: {item.batchNumber || 'N/A'}) expires on {item.expiryDate ? format(parseISO(item.expiryDate), 'PP') : 'N/A'}.
                            </p>
                             <Button
                               size="xs"
                               variant="outline"
                               className="mt-2 text-xs h-7"
                               onClick={() => setSelectedExpiryBatch(item)}
                             >
                               View Batch
                             </Button>
                        </div>
                    </div>
                  ))}
                   {totalNotifications === 0 && (
                       <div className="text-center text-muted-foreground py-10">
                           <p>No new notifications.</p>
                       </div>
                   )}
                </div>
              </SheetContent>
            </Sheet>
            <Dialog
              open={Boolean(selectedExpiryBatch)}
              onOpenChange={(open) => {
                if (!open) {
                  setSelectedExpiryBatch(null);
                }
              }}
            >
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Batch Details</DialogTitle>
                  <DialogDescription>
                    Expiry alert details for the selected batch.
                  </DialogDescription>
                </DialogHeader>
                {selectedExpiryBatch && (
                  <div className="grid gap-3 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Product</span>
                      <span className="font-medium text-right">{selectedExpiryBatch.productName}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Batch No.</span>
                      <span className="font-medium text-right">{selectedExpiryBatch.batchNumber || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Expiry Date</span>
                      <span className="font-medium text-right">
                        {selectedExpiryBatch.expiryDate
                          ? format(parseISO(selectedExpiryBatch.expiryDate), 'PP')
                          : 'N/A'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Quantity Remaining</span>
                      <span className="font-medium text-right">{formatInventoryQuantity(selectedExpiryBatch.quantityRemaining)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Received Date</span>
                      <span className="font-medium text-right">
                        {selectedExpiryBatch.receivedDate
                          ? format(parseISO(selectedExpiryBatch.receivedDate), 'PP')
                          : 'N/A'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Supplier</span>
                      <span className="font-medium text-right">{selectedExpiryBatch.supplierName || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Cost Per Unit</span>
                      <span className="font-medium text-right">{selectedExpiryBatch.costPerUnit}</span>
                    </div>
                  </div>
                )}
                <DialogFooter className="pt-4">
                  <Button asChild variant="outline">
                    <Link href="/dashboard/inventory?tab=purchases">Go to Purchases</Link>
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="relative h-10 w-10 rounded-full"
              >
                <Avatar className="h-9 w-9 bg-primary text-primary-foreground">
                  <AvatarFallback className="font-semibold">
                    {(user?.displayName || user?.email || 'U')
                      .split(' ')
                      .map((n) => n[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="flex items-center gap-3 px-2 py-3">
                <Avatar className="h-10 w-10 bg-primary text-primary-foreground">
                  <AvatarFallback className="font-semibold">
                    {(user?.displayName || user?.email || 'U')
                      .split(' ')
                      .map((n) => n[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">
                    {user?.displayName || 'User'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.email}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {user?.role}
                  </p>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setProfileModalOpen(true)}>
                Profile
              </DropdownMenuItem>
              {user.role === 'Admin' && (
                <>
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard/settings/billing">Billing</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard/settings">Settings</Link>
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </DashboardHeader>
      {user && (
        <UserProfileModal
          user={user}
          isOpen={isProfileModalOpen}
          onOpenChange={setProfileModalOpen}
        />
      )}
    </>
  );
}


function NavGroup({ title, items, userRole, onPosClick }: { title: string, items: typeof settingsNav, userRole: User['role'], onPosClick?: () => void }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { hasPermission } = useRBAC();
  
  // Restrict operational staff to only see their working screens.
  const isCashierOrWaiter = userRole === 'Cashier' || userRole === 'Waiter';
  const isKitchenStaff = userRole === 'Kitchen Staff';
  if ((isCashierOrWaiter || isKitchenStaff) && title !== 'Point of Sale' && title !== 'Settings') {
    return null;
  }
  
  const filteredItems = items.filter(item => hasPermission(item.permission));

  if (filteredItems.length === 0) {
    return null;
  }
  
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window !== 'undefined') {
        const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
        if(branchId) setActiveBranchId(branchId);
    }
  }, []);

  const pendingStockAudits = useLiveQuery(
    () => {
      if (!activeBranchId) return 0;
      return db.stockTakes.where({ branchId: activeBranchId, status: 'Pending Approval' }).count()
    },
    [activeBranchId]
  );

  const pendingExpenses = useLiveQuery(
    () => {
      if (!activeBranchId) return 0;
      return db.expenses.where({ branchId: activeBranchId, status: 'Pending' }).count()
    },
    [activeBranchId]
  );
  
  const totalPending = (pendingStockAudits || 0) + (pendingExpenses || 0);

  return (
    <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider group-data-[collapsible=icon]:text-center group-data-[collapsible=icon]:[writing-mode:vertical-rl] group-data-[collapsible=icon]:mb-2">{title}</h3>
        <SidebarMenu>
        {filteredItems.map((item) => {
            const isActive = isNavItemActive(pathname, item.href);

            const handleClick = () => {
              setOpenMobile(false);
              if (item.href === '/dashboard/pos' && onPosClick) {
                onPosClick();
              }
            };

            return (
            <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                asChild={item.href !== '/dashboard/pos'}
                isActive={isActive}
                tooltip={item.label}
                aria-current={isActive ? "page" : undefined}
                onClick={handleClick}
                >
                {item.href === '/dashboard/pos' ? (
                  <button className="flex justify-between items-center w-full">
                    <div className="flex items-center gap-3">
                        <item.icon />
                        <span className="group-data-[collapsible=icon]:hidden">{item.label}</span>
                    </div>
                  </button>
                ) : (
                  <Link href={item.href} className="flex justify-between items-center w-full">
                    <div className="flex items-center gap-3">
                        <item.icon />
                        <span className="group-data-[collapsible=icon]:hidden">{item.label}</span>
                    </div>
                    {item.href === '/dashboard/approvals' && totalPending > 0 && (
                        <Badge className="h-5 group-data-[collapsible=icon]:hidden">{totalPending}</Badge>
                    )}
                  </Link>
                )}
                </SidebarMenuButton>
            </SidebarMenuItem>
            );
        })}
        </SidebarMenu>
    </div>
  )
}

function SidebarBranchSwitcher({ multiBranchEnabled }: { multiBranchEnabled: boolean }) {
  const { setOpenMobile } = useSidebar();
  const [branches, setBranches] = useState<Branch[]>(() => getInitialBranches());
  const [activeBranchId, setActiveBranchId] = useState<string | null>(() => getStoredPreferredBranchId());
  const [activeBranch, setActiveBranch] = useState<Branch | null>(() => getInitialActiveBranch());
  const primaryBranch = useMemo(() => resolvePrimaryBranch(branches), [branches]);
  const primaryBranchId = primaryBranch ? getPreferredBranchStorageId(primaryBranch) : null;

  const syncSidebarBranchState = (nextBranches: Branch[], preferredBranchId?: string | null) => {
    const normalizedBranches = nextBranches
      .map((branch) => normalizeStoredBranch(branch))
      .filter((branch): branch is Branch => Boolean(branch));
    const nextPrimaryBranch = resolvePrimaryBranch(normalizedBranches);
    const selectableBranches =
      !multiBranchEnabled && nextPrimaryBranch ? [nextPrimaryBranch] : normalizedBranches;
    const storedActiveBranchId = getStoredPreferredBranchId();
    const resolvedActiveBranch =
      selectableBranches.find((branch) => matchesBranchId(branch, preferredBranchId)) ||
      selectableBranches.find((branch) => matchesBranchId(branch, storedActiveBranchId)) ||
      (!multiBranchEnabled ? nextPrimaryBranch : null) ||
      selectableBranches[0] ||
      null;
    const resolvedActiveBranchId = resolvedActiveBranch
      ? getPreferredBranchStorageId(resolvedActiveBranch)
      : preferredBranchId || storedActiveBranchId || nextPrimaryBranch?.id || selectableBranches[0]?.id || null;

    setBranches(normalizedBranches);
    setActiveBranchId(resolvedActiveBranchId);
    setActiveBranch(resolvedActiveBranch);

    if (resolvedActiveBranch) {
      persistActiveBranchSelection(resolvedActiveBranch);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const initialBranches = getInitialBranches();
    syncSidebarBranchState(initialBranches);

    const handleBranchesUpdated = (event: Event) => {
      const customEvent = event as CustomEvent;
      const updatedBranches = customEvent.detail?.branches;
      if (Array.isArray(updatedBranches)) {
        syncSidebarBranchState(updatedBranches);
      }
    };

    const handleBranchChanged = (event: Event) => {
      const customEvent = event as CustomEvent;
      const nextBranchId = String(customEvent.detail?.branchId || '').trim();
      syncSidebarBranchState(getInitialBranches(), nextBranchId || undefined);
    };

    window.addEventListener('branchesUpdated', handleBranchesUpdated);
    window.addEventListener('branchChanged', handleBranchChanged);

    return () => {
      window.removeEventListener('branchesUpdated', handleBranchesUpdated);
      window.removeEventListener('branchChanged', handleBranchChanged);
    };
  }, [multiBranchEnabled]);

  const handleSetBranch = (branch: Branch) => {
    if (!multiBranchEnabled && primaryBranch && !matchesBranchId(branch, primaryBranchId)) {
      setOpenMobile(false);
      return;
    }

    if (matchesBranchId(branch, activeBranchId)) {
      setOpenMobile(false);
      return;
    }

    const storageBranchId = getPreferredBranchStorageId(branch);
    setActiveBranchId(storageBranchId);
    setActiveBranch(branch);
    persistActiveBranchSelection(branch);
    window.dispatchEvent(new CustomEvent('branchChanged', { detail: { branchId: storageBranchId } }));
    setOpenMobile(false);
    window.location.reload();
  };

  if (branches.length === 0) {
    return null;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              tooltip="Switch Branch"
              className="justify-between group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Building />
                <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium">{activeBranch?.name || 'Select Branch'}</p>
                  <p className="truncate text-xs text-muted-foreground">Switch Branch</p>
                </div>
              </div>
              <ChevronDown className="h-4 w-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{multiBranchEnabled ? 'Switch Branch' : 'Primary Branch Only'}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {branches.map((branch) => {
              const isActive = matchesBranchId(branch, activeBranchId);
              const isDisabled =
                !multiBranchEnabled &&
                primaryBranch &&
                !matchesBranchId(branch, primaryBranchId);

              return (
                <DropdownMenuItem
                  key={branch.id}
                  disabled={isDisabled}
                  onSelect={() => handleSetBranch(branch)}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{branch.name}</span>
                  {isActive && <CheckCircle2 className="h-4 w-4 text-primary" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebar({
  user,
  onPosClick,
  multiBranchEnabled,
  kitchenAvailable,
  customSalesSection,
}: {
  user: User;
  onPosClick?: () => void;
  multiBranchEnabled: boolean;
  kitchenAvailable: boolean;
  customSalesSection: { enabled: boolean; name: string };
}) {
  const pathname = usePathname();
  const { hasPermission } = useRBAC();
  const { setOpenMobile, isMobile } = useSidebar();

  const sidebarSections = React.useMemo(() => navSections.map((section) => {
    return {
      ...section,
      items: section.items.map((item) => (
        item.href === '/dashboard/custom-section'
          ? { ...item, label: customSalesSection.name || item.label }
          : item
      )),
    };
  }), [customSalesSection.enabled, customSalesSection.name]);

  const filteredSections = sidebarSections
	    .map((section) => ({
	      ...section,
	      items: section.items.filter(item => (
	        hasPermission(item.permission) &&
	        (item.href !== '/dashboard/kitchen' || kitchenAvailable) &&
	        (item.href !== '/dashboard/custom-section' || customSalesSection.enabled)
	      )),
	    }))
    .filter((section) => section.items.length > 0);
  const filteredSettingsItems = user.role === 'Admin'
    ? settingsNav.filter(item => hasPermission(item.permission))
    : [];
  const isSettingsActive = filteredSettingsItems.some((item) => isNavItemActive(pathname, item.href));

  return (
    <>
      <SidebarHeader className="border-b border-sidebar-border/70 p-3">
        <div className="flex items-center justify-between rounded-lg px-1 py-1">
          <div className="flex items-center gap-3 group-data-[collapsible=icon]:hidden">
            <HandyPosLogo className="size-8" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold tracking-tight">Handy POS</p>
              <p className="truncate text-xs text-sidebar-foreground/55">Business workspace</p>
            </div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="tauri-android-content-safe-bottom flex-1 space-y-3 px-2 py-3">
        {user.role === 'Admin' && <SidebarBranchSwitcher multiBranchEnabled={multiBranchEnabled} />}
        {user.role === 'Admin' && <SidebarSeparator className="my-1" />}

        {filteredSections.map((section) => (
          <div key={section.title} className="space-y-1">
            <p className="px-3 text-[0.68rem] font-semibold uppercase tracking-wide text-sidebar-foreground/45 group-data-[collapsible=icon]:sr-only">
              {section.title}
            </p>
            <SidebarMenu className="gap-0.5">
              {section.items.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);

                const handleClick = () => {
                  setOpenMobile(false);
                  if (item.href === '/dashboard/pos' && onPosClick) {
                    onPosClick();
                  }
                };

                return (
                  <SidebarMenuItem key={`${item.href}-${item.label}`}>
                    <SidebarMenuButton
                      asChild={item.href !== '/dashboard/pos'}
                      isActive={isActive}
                      tooltip={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={handleClick}
                      className="h-9 rounded-lg text-[0.92rem] font-medium"
                    >
                      {item.href === '/dashboard/pos' ? (
                        <>
                          <item.icon />
                          <span className="group-data-[collapsible=icon]:hidden">{item.label}</span>
                        </>
                      ) : (
                        <Link href={item.href} className="flex items-center gap-3">
                          <item.icon />
                          <span className="group-data-[collapsible=icon]:hidden">{item.label}</span>
                        </Link>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        ))}

        {isMobile && filteredSettingsItems.length > 0 && (
          <div className="space-y-1">
            <p className="px-3 text-[0.68rem] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
              Settings
            </p>
            <SidebarMenu className="gap-0.5">
              {filteredSettingsItems.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);

                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setOpenMobile(false)}
                      className="h-9 rounded-lg text-[0.92rem] font-medium"
                    >
                      <Link href={item.href} className="flex items-center gap-3">
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="tauri-android-safe-bottom border-t border-sidebar-border/70 p-2">
        {!isMobile && filteredSettingsItems.length > 0 && (
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    isActive={isSettingsActive}
                    tooltip="Settings"
                    className="h-9 justify-between rounded-lg text-[0.92rem]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Settings />
                      <span className="truncate group-data-[collapsible=icon]:hidden">Settings</span>
                    </span>
                    <ChevronDown className="h-4 w-4 group-data-[collapsible=icon]:hidden" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" className="w-56">
                  <DropdownMenuLabel>Settings</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {filteredSettingsItems.map((item) => (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link
                        href={item.href}
                        className="flex items-center gap-2"
                        onClick={() => setOpenMobile(false)}
                      >
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <SidebarMenu className="mt-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/documentation'}
              tooltip="Documentation"
              onClick={() => setOpenMobile(false)}
              className="h-9 rounded-lg text-[0.92rem]"
            >
              <Link href="/documentation" className="flex items-center gap-3">
                <FileText />
                <span className="group-data-[collapsible=icon]:hidden">Help & Docs</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <AppVersionLabel variant="plain" tone="sidebar" className="mt-1 px-2 group-data-[collapsible=icon]:hidden" />
      </SidebarFooter>
    </>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, business, loading, logout } = useAuth();
  const {
    accessCheck: multiBranchAccess,
    isLoading: isLoadingMultiBranchAccess,
  } = useSubscriptionFeatureAccess('multi_branch');
  const router = useRouter();
  const pathname = usePathname();
  const [isPosModalOpen, setIsPosModalOpen] = useState(false);
  const [pendingProcessTakeOrderId, setPendingProcessTakeOrderId] = useState<string | null>(null);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(() => getStoredPreferredBranchId());
  const [customSalesSection, setCustomSalesSection] = useState({ enabled: false, name: '' });
  const multiBranchEnabled = isLoadingMultiBranchAccess ? true : multiBranchAccess.allowed;
  const businessRecord = useLiveQuery(
    () => business?.id ? db.business.get(business.id) : undefined,
    [business?.id]
  );
  const currentBusinessType = normalizeBusinessType(businessRecord?.type ?? business?.type, 'General Retail');
  const kitchenAvailable = isKitchenBusinessType(currentBusinessType);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const readCustomSalesSection = async () => {
      const storedSettings = readStoredCustomSalesSectionSettings();

      try {
        if (business?.id) {
          const response = await authFetch.fetch(`/business/businesses/${business.id}/business_settings/`);
          const resolved = resolveCustomSalesSectionSettings(response as Record<string, any>, storedSettings);
          const existing = await db.business.get(business.id);
          if (existing) {
            await db.business.put({
              ...existing,
              enableCustomSalesSection: resolved.enabled,
              enable_custom_sales_section: resolved.enabled,
              customSalesSectionName: resolved.name,
              custom_sales_section_name: resolved.name,
            });
          }
          const cachedSettings = {
            ...readStoredBusinessSettingsObject(),
            enableCustomSalesSection: resolved.enabled,
            enable_custom_sales_section: resolved.enabled,
            customSalesSectionName: resolved.name,
            custom_sales_section_name: resolved.name,
          };
          window.localStorage.setItem('handypos-business-settings', JSON.stringify(cachedSettings));
          setCustomSalesSection(resolved);
          return;
        }
      } catch (error) {
        console.warn('[DashboardLayout] Failed to fetch custom sales section settings:', error);
      }

      const localResolved = resolveCustomSalesSectionSettings(businessRecord as Record<string, any> | null, storedSettings);
      setCustomSalesSection(localResolved);
    };

    void readCustomSalesSection();
    const refreshFromStorage = () => setCustomSalesSection(readStoredCustomSalesSectionSettings());
    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('focus', refreshFromStorage);
    window.addEventListener('handypos-business-settings-changed', refreshFromStorage);
    return () => {
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('focus', refreshFromStorage);
      window.removeEventListener('handypos-business-settings-changed', refreshFromStorage);
    };
  }, [business?.id, businessRecord]);

  const openPosModalForOrder = useCallback((orderId?: string | null) => {
    const normalizedOrderId = String(orderId || '').trim();
    setPendingProcessTakeOrderId(normalizedOrderId || null);
    setIsPosModalOpen(true);
  }, []);

  const handlePosModalOpenChange = useCallback((open: boolean) => {
    setIsPosModalOpen(open);
    if (!open) {
      setPendingProcessTakeOrderId(null);
    }
  }, []);

  const handleProcessTakeOrderLoaded = useCallback((orderId: string) => {
    setPendingProcessTakeOrderId((current) => (current === orderId ? null : current));
  }, []);

  useEffect(() => {
    if (loading) return;

    const rawTokens =
      localStorage.getItem(LOCAL_STORAGE_KEYS.AUTH_TOKENS) ??
      localStorage.getItem(LOCAL_STORAGE_KEYS.LEGACY_AUTH_TOKENS);

    let hasValidTokens = false;
    if (rawTokens) {
      try {
        const parsedTokens = JSON.parse(rawTokens);
        hasValidTokens = Boolean(parsedTokens?.access && parsedTokens?.refresh);
      } catch {
        hasValidTokens = false;
      }
    }

    if (!hasValidTokens) {
      if (user) {
        logout();
      }
      router.replace('/login');
      return;
    }

    // Tokens are present; allow auth bootstrap to finish restoring the user model
    // before treating the session as invalid.
    if (!user) {
      return;
    }
  }, [user, loading, logout, router]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleOpenPosModal = (event: Event) => {
      const customEvent = event as CustomEvent<{ processTakeOrderId?: string | number | null }>;
      openPosModalForOrder(customEvent.detail?.processTakeOrderId ? String(customEvent.detail.processTakeOrderId) : null);
    };

    window.addEventListener('handypos-open-pos-modal', handleOpenPosModal);
    return () => window.removeEventListener('handypos-open-pos-modal', handleOpenPosModal);
  }, [openPosModalForOrder]);

  useEffect(() => {
    if (isLoadingMultiBranchAccess || !multiBranchEnabled) {
      return;
    }

    if (user && user.branchId) {
        if (typeof window !== 'undefined') {
            const storedActiveBranch = getStoredPreferredBranchId();
            if (user.role !== 'Admin' && !matchesBranchId({ id: user.branchId }, storedActiveBranch)) {
                localStorage.setItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH, user.branchId);
                localStorage.setItem(LOCAL_STORAGE_KEYS.CURRENT_BRANCH, user.branchId);
                window.location.reload();
            }
        }
    }
  }, [user, isLoadingMultiBranchAccess, multiBranchEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncActiveBranch = () => {
      const branchId = getStoredPreferredBranchId();
      setActiveBranchId(branchId);
    };

    syncActiveBranch();
    window.addEventListener('branchChanged', syncActiveBranch);
    window.addEventListener('branchesUpdated', syncActiveBranch);

    return () => {
      window.removeEventListener('branchChanged', syncActiveBranch);
      window.removeEventListener('branchesUpdated', syncActiveBranch);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || isLoadingMultiBranchAccess || multiBranchEnabled) {
      return;
    }

    const branchList = getInitialBranches();
    const primaryBranch = resolvePrimaryBranch(branchList);
    if (!primaryBranch) {
      return;
    }

    const primaryBranchId = getPreferredBranchStorageId(primaryBranch);
    const storedBranchId = getStoredPreferredBranchId();
    const storedMatchesPrimary = matchesBranchId(primaryBranch, storedBranchId);
    const activeMatchesPrimary = activeBranchId
      ? matchesBranchId(primaryBranch, activeBranchId)
      : storedMatchesPrimary;

    if (storedMatchesPrimary && activeMatchesPrimary) {
      if (activeBranchId !== primaryBranchId) {
        setActiveBranchId(primaryBranchId);
      }
      return;
    }

    persistActiveBranchSelection(primaryBranch);
    setActiveBranchId(primaryBranchId);
    window.dispatchEvent(new CustomEvent('branchChanged', { detail: { branchId: primaryBranchId } }));
    window.location.reload();
  }, [activeBranchId, isLoadingMultiBranchAccess, multiBranchEnabled]);

  useEffect(() => {
    if (user) {
        const accessibleRoutes = [...navItems, ...settingsNav]
            .filter(item => item.href !== '/dashboard/kitchen' || kitchenAvailable)
            .filter(item => checkPermission(user.role, item.permission))
            .map(item => item.href);
        
        // Allow access to the base dashboard page
        if (pathname === '/dashboard') return;

        // Only enforce redirects when we have a non-empty set of accessible routes
        if (accessibleRoutes.length > 0 && !accessibleRoutes.some(route => pathname.startsWith(route))) {
            // If current route is not accessible, redirect to a default page for that role
            const roleStr = (user.role ?? 'Admin').toLowerCase();
            if (roleStr === 'kitchen staff' && kitchenAvailable) {
                router.replace('/dashboard/kitchen');
            } else if (roleStr === 'cashier' || roleStr === 'waiter') {
                router.replace('/dashboard/pos');
            } else {
                router.replace('/dashboard');
            }
        }
    }
  }, [user, pathname, router, kitchenAvailable]);

  if (loading || !user) {
    return (
        <div className="tauri-android-safe-bottom flex h-[100dvh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="tauri-android-safe-bottom box-border flex h-[100dvh] w-full">
        <Sidebar className="hidden lg:flex lg:flex-col">
           <AppSidebar
             user={user}
	             onPosClick={() => openPosModalForOrder()}
	             multiBranchEnabled={multiBranchEnabled}
	             kitchenAvailable={kitchenAvailable}
	             customSalesSection={customSalesSection}
	           />
        </Sidebar>
        <div className="flex-1 flex flex-col overflow-y-auto">
          <Header
            onPosClick={() => openPosModalForOrder()}
            onProcessSaleOrder={(orderId) => openPosModalForOrder(orderId)}
            multiBranchEnabled={multiBranchEnabled}
          />
          <main className="min-h-0 flex-1 w-full bg-background/95">
            <div className="tauri-android-content-safe-bottom mx-auto flex min-h-full w-full max-w-[1540px] flex-col px-4 py-4 sm:px-6 lg:px-8 xl:py-6 2xl:px-10">
              <DashboardSubscriptionGuard>
                {children}
              </DashboardSubscriptionGuard>
            </div>
          </main>
        </div>
      </div>
      {activeBranchId && (
        <PosModal
          branchId={activeBranchId}
          isOpen={isPosModalOpen}
          onOpenChange={handlePosModalOpenChange}
          processTakeOrderId={pendingProcessTakeOrderId}
          onProcessTakeOrderLoaded={handleProcessTakeOrderLoaded}
        />
      )}
      <ThemeCustomizer />
    </SidebarProvider>
  );
}
