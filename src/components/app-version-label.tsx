'use client';

import React, { useEffect, useState } from 'react';

import { isTauriApp } from '@/lib/tauri-init';
import { FALLBACK_APP_VERSION } from '@/lib/app-version';
import { cn } from '@/lib/utils';

type AppVersionLabelProps = {
  className?: string;
  variant?: 'card' | 'plain';
  tone?: 'default' | 'sidebar' | 'splash';
};

const waitForTauriRuntime = async (timeoutMs: number = 5000): Promise<boolean> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const windowRef = window as any;
    const hasTauriRuntime =
      typeof windowRef.__TAURI__ !== 'undefined' ||
      typeof windowRef.__TAURI_INTERNALS__ !== 'undefined' ||
      typeof windowRef.__TAURI_IPC__ === 'function';

    if (hasTauriRuntime) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
};

export function AppVersionLabel({
  className,
  variant = 'card',
  tone = 'default',
}: AppVersionLabelProps) {
  const [version, setVersion] = useState(FALLBACK_APP_VERSION);

  useEffect(() => {
    let isActive = true;

    const loadVersion = async () => {
      if (!isTauriApp()) {
        return;
      }

      const tauriReady = await waitForTauriRuntime();
      if (!tauriReady || !isActive) {
        return;
      }

      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const runtimeVersion = await getVersion();

        if (isActive && String(runtimeVersion || '').trim()) {
          setVersion(String(runtimeVersion).trim());
        }
      } catch (error) {
        console.warn('[AppVersion] Failed to load runtime app version:', error);
      }
    };

    void loadVersion();

    return () => {
      isActive = false;
    };
  }, []);

  const labelClassName =
    tone === 'splash'
      ? 'text-white/70'
      : tone === 'sidebar'
      ? 'text-sidebar-foreground/55'
      : 'text-muted-foreground/70';
  const valueClassName =
    tone === 'splash'
      ? 'text-white/90'
      : tone === 'sidebar'
      ? 'text-sidebar-foreground/85'
      : 'text-foreground/75';

  if (variant === 'plain') {
    return (
      <div className={cn('group-data-[collapsible=icon]:hidden text-center', className)}>
        <p className={cn('text-sm font-medium', valueClassName)}>v{version}</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group-data-[collapsible=icon]:hidden rounded-lg border px-3 py-2',
        tone === 'sidebar' ? 'border-sidebar-border/70 bg-sidebar-accent/30' : 'border-border/70 bg-muted/50',
        className
      )}
    >
      <p className={cn('text-[10px] font-semibold uppercase tracking-[0.16em]', labelClassName)}>
        App Version
      </p>
      <p className={cn('mt-1 text-sm font-medium', valueClassName)}>v{version}</p>
    </div>
  );
}
