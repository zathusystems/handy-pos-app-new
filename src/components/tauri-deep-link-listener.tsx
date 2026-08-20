'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { isTauriApp } from '@/lib/tauri-init';

const APP_SCHEME = 'handypos:';
const PAYMENT_HOST = 'subscription-payment';

const buildBillingRedirectUrl = (params: {
  depositId?: string;
  txRef?: string;
  status?: string;
  gatewayReturn?: string;
}) => {
  const search = new URLSearchParams();
  search.set('openAddCredit', '1');
  search.set('gatewayReturn', params.gatewayReturn || 'callback');
  if (params.depositId) search.set('deposit_id', params.depositId);
  if (params.txRef) search.set('tx_ref', params.txRef);
  if (params.status) search.set('status', params.status);

  return `/dashboard/settings/billing/?${search.toString()}`;
};

const parseDepositId = (url: URL): string => {
  if (url.hostname === PAYMENT_HOST) {
    return url.pathname.replace(/^\/+/, '').trim();
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const hostMatches = url.hostname.toLowerCase() === PAYMENT_HOST;
  if (hostMatches && segments.length > 0) {
    return segments[0];
  }
  if (segments.length >= 2 && segments[0].toLowerCase() === PAYMENT_HOST) {
    return segments[1];
  }
  return '';
};

export function TauriDeepLinkListener() {
  const router = useRouter();
  const handledUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isTauriApp()) {
      return;
    }

    let unlisten: (() => void) | undefined;

    const handleUrls = (urls: string[] | null | undefined) => {
      const urlList = Array.isArray(urls) ? urls : [];
      urlList.forEach((rawUrl) => {
        if (typeof rawUrl !== 'string') return;
        if (!rawUrl.startsWith(APP_SCHEME)) return;
        if (handledUrlsRef.current.has(rawUrl)) return;

        let parsed: URL | null = null;
        try {
          parsed = new URL(rawUrl);
        } catch {
          parsed = null;
        }
        if (!parsed) return;

        handledUrlsRef.current.add(rawUrl);

        const depositId = parsed.searchParams.get('deposit_id') || parseDepositId(parsed) || '';
        const txRef = parsed.searchParams.get('tx_ref') || parsed.searchParams.get('reference') || '';
        const status = parsed.searchParams.get('status') || '';
        const gatewayReturn = parsed.searchParams.get('gatewayReturn') || 'callback';

        const targetUrl = buildBillingRedirectUrl({
          depositId,
          txRef,
          status,
          gatewayReturn,
        });

        router.replace(targetUrl);
      });
    };

    const setup = async () => {
      try {
        const plugin = await import('@tauri-apps/plugin-deep-link');
        const currentUrls = await plugin.getCurrent();
        handleUrls(currentUrls);
        unlisten = await plugin.onOpenUrl((event) => {
          handleUrls(event);
        });
      } catch (error) {
        console.warn('[Tauri Deep Link] Listener not available:', error);
      }
    };

    void setup();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [router]);

  return null;
}
