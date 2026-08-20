'use client';

import { useAuth } from '@/hooks/use-auth';
import { hasPermission as checkPermission, hasAnyPermission as checkAnyPermission, hasAllPermissions as checkAllPermissions, type Permission } from '@/lib/rbac/permissions';

export function useRBAC() {
  const { user } = useAuth();
  
  const hasPermission = (permission: Permission): boolean => {
    if (!user) return false;
    return checkPermission(user.role, permission);
  };
  
  const hasAnyPermission = (permissions: Permission[]): boolean => {
    if (!user) return false;
    return checkAnyPermission(user.role, permissions);
  };
  
  const hasAllPermissions = (permissions: Permission[]): boolean => {
    if (!user) return false;
    return checkAllPermissions(user.role, permissions);
  };
  
  return { 
    hasPermission, 
    hasAnyPermission, 
    hasAllPermissions,
    userRole: user?.role,
  };
}
