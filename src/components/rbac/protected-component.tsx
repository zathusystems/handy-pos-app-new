'use client';

import React from 'react';
import { useRBAC } from '@/hooks/use-rbac';
import type { Permission } from '@/lib/rbac/permissions';

interface ProtectedComponentProps {
  permission?: Permission | Permission[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function ProtectedComponent({ 
  permission, 
  children, 
  fallback = null 
}: ProtectedComponentProps) {
  const { hasPermission, hasAnyPermission } = useRBAC();
  
  if (!permission) {
    return children;
  }
  
  const hasAccess = Array.isArray(permission)
    ? hasAnyPermission(permission)
    : hasPermission(permission);
  
  return hasAccess ? children : fallback;
}

interface AccessDeniedProps {
  message?: string;
}

export function AccessDenied({ message = 'You do not have permission to access this resource.' }: AccessDeniedProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground mt-2">{message}</p>
      </div>
    </div>
  );
}
