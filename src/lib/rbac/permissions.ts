import type { Staff } from '@/lib/db';
import { normalizeRole } from '@/lib/rbac/role-utils';

export type Permission = 
  // Dashboard
  | 'view_dashboard'
  | 'view_reports'
  
  // POS
  | 'access_pos'
  | 'view_sessions'
  | 'view_kitchen'
  
  // Inventory
  | 'view_inventory'
  | 'manage_inventory'
  | 'view_suppliers'
  | 'manage_suppliers'
  | 'view_menu'
  | 'manage_menu'
  
  // Business
  | 'view_sales'
  | 'view_expenses'
  | 'manage_expenses'
  | 'view_customers'
  | 'manage_customers'
  | 'view_invoices'
  | 'manage_invoices'
  
  // Staff & Admin
  | 'manage_staff'
  | 'view_audit_log'
  | 'manage_settings'
  | 'view_approvals'
  | 'approve_stock_audits'
  | 'approve_expenses'
  | 'manage_affiliate';

export const rolePermissions: Record<Staff['role'], Permission[]> = {
  Admin: [
    // Dashboard & Reports
    'view_dashboard',
    'view_reports',
    
    // POS
    'access_pos',
    'view_sessions',
    'view_kitchen',
    
    // Inventory
    'view_inventory',
    'manage_inventory',
    'view_suppliers',
    'manage_suppliers',
    'view_menu',
    'manage_menu',
    
    // Business
    'view_sales',
    'view_expenses',
    'manage_expenses',
    'view_customers',
    'manage_customers',
    'view_invoices',
    'manage_invoices',
    
    // Staff & Admin
    'manage_staff',
    'view_audit_log',
    'manage_settings',
    'view_approvals',
    'approve_stock_audits',
    'approve_expenses',
    'manage_affiliate',
  ],
  
  Manager: [
    // Dashboard & Reports
    'view_dashboard',
    'view_reports',
    
    // POS
    'access_pos',
    'view_sessions',
    'view_kitchen',
    
    // Inventory
    'view_inventory',
    'manage_inventory',
    'view_suppliers',
    'manage_suppliers',
    'view_menu',
    'manage_menu',
    
    // Business
    'view_sales',
    'view_expenses',
    'manage_expenses',
    'view_customers',
    'manage_customers',
    'view_invoices',
    'manage_invoices',
    
    // Approvals
    'view_approvals',
    'approve_stock_audits',
    'approve_expenses',
  ],
  
  Cashier: [
    // Dashboard
    'view_dashboard',

    // POS
    'access_pos',
    'view_sessions',
    'view_kitchen',
  ],
  
  Waiter: [
    // Dashboard
    'view_dashboard',

    // POS
    'access_pos',
    'view_kitchen',
  ],

  'Kitchen Staff': [
    // Dashboard
    'view_dashboard',

    // Kitchen
    'view_kitchen',
  ],
};

export function hasPermission(role: Staff['role'] | string | undefined, permission: Permission): boolean {
  const normalizedRole = normalizeRole(role, { fallback: 'User' });
  if (normalizedRole === 'User') {
    return false;
  }
  return rolePermissions[normalizedRole]?.includes(permission) ?? false;
}

export function hasAnyPermission(role: Staff['role'] | string | undefined, permissions: Permission[]): boolean {
  return permissions.some(p => hasPermission(role, p));
}

export function hasAllPermissions(role: Staff['role'] | string | undefined, permissions: Permission[]): boolean {
  return permissions.every(p => hasPermission(role, p));
}
