'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/db';
import {
  canUseFeature,
  getSubscriptionFeatureInfo,
  type SubscriptionFeatureInfo,
} from '@/lib/subscription-access';
import { fetchCurrentSubscription } from '@/lib/subscription-cache';

export function useSubscriptionFeatureAccess(featureName: string): {
  accessCheck: ReturnType<typeof canUseFeature>;
  feature: SubscriptionFeatureInfo;
  isLoading: boolean;
} {
  const { business, user, loading: isAuthLoading } = useAuth();
  const businessId = String(business?.id || user?.businessId || '').trim();
  const cachedSubscription = useLiveQuery(() => db.subscriptions.get('sub_main-business'), [businessId]);
  const [resolvedBusinessKey, setResolvedBusinessKey] = useState<string>('');
  const [isRefreshingSubscription, setIsRefreshingSubscription] = useState(false);
  const hasMatchingCachedSubscription = Boolean(
    cachedSubscription &&
      (!businessId || String(cachedSubscription.businessId || '').trim() === businessId)
  );

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    let cancelled = false;

    const loadSubscription = async () => {
      if (!user && !businessId) {
        if (!cancelled) {
          setResolvedBusinessKey(businessId);
        }
        return;
      }

      try {
        if (!cancelled) {
          setIsRefreshingSubscription(true);
        }
        await fetchCurrentSubscription(businessId || undefined, { force: true });
      } catch (error) {
        console.warn('[SubscriptionFeatureAccess] Falling back to cached subscription:', error);
      } finally {
        if (!cancelled) {
          setResolvedBusinessKey(businessId);
          setIsRefreshingSubscription(false);
        }
      }
    };

    void loadSubscription();

    return () => {
      cancelled = true;
    };
  }, [businessId, isAuthLoading]);

  const accessCheck = useMemo(
    () => canUseFeature(cachedSubscription, featureName),
    [cachedSubscription, featureName]
  );

  const isLoading =
    isAuthLoading ||
    isRefreshingSubscription ||
    (!hasMatchingCachedSubscription && resolvedBusinessKey !== businessId);

  return {
    accessCheck,
    feature: getSubscriptionFeatureInfo(featureName),
    isLoading,
  };
}
