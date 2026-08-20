import type { Staff } from '@/lib/db';

export type AppRole = Staff['role'] | 'User';

const ROLE_MAP: Record<string, Staff['role']> = {
  admin: 'Admin',
  administrator: 'Admin',
  owner: 'Admin',
  superadmin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  server: 'Waiter',
  kitchen: 'Kitchen Staff',
  'kitchen staff': 'Kitchen Staff',
  kitchenstaff: 'Kitchen Staff',
  cook: 'Kitchen Staff',
  chef: 'Kitchen Staff',
};

interface NormalizeRoleOptions {
  fallback?: AppRole;
  preferAdminForGenericUser?: boolean;
}

export function normalizeRole(
  rawRole: unknown,
  { fallback = 'User', preferAdminForGenericUser = false }: NormalizeRoleOptions = {}
): AppRole {
  if (typeof rawRole !== 'string') {
    return fallback;
  }

  const normalized = rawRole.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (normalized === 'user') {
    return preferAdminForGenericUser ? 'Admin' : fallback;
  }

  return ROLE_MAP[normalized] ?? fallback;
}

export function isAdminRole(role: unknown): boolean {
  return normalizeRole(role, { fallback: 'User' }) === 'Admin';
}
