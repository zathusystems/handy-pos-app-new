'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, CreditCard, Loader2, ShieldAlert } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { db, type Subscription } from '@/lib/db';
import { buildSubscriptionBillingUrl } from '@/lib/frontend-flags';
import { fetchCurrentSubscription } from '@/lib/subscription-cache';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type GuardReason = 'no_subscription' | 'inactive' | 'insufficient_balance';

interface GuardState {
  isLoading: boolean;
  shouldBlock: boolean;
  reason?: GuardReason;
  status?: string;
  accountBalance?: number;
  currencyCode?: string;
}

interface BackendSubscriptionSnapshot {
  status?: string;
  account_balance?: number;
  currency_code?: string;
}

const BILLING_PATH_PREFIX = '/dashboard/settings/billing';

const isBillingRoute = (pathname: string): boolean =>
  pathname === BILLING_PATH_PREFIX || pathname.startsWith(`${BILLING_PATH_PREFIX}/`);

const buildGuardStateFromSubscription = (
  subscription: BackendSubscriptionSnapshot | Subscription,
  fallbackCurrencyCode = 'USD'
): GuardState => {
  const status = String(subscription?.status || '').trim().toLowerCase();
  const accountBalance = Number(subscription?.account_balance ?? 0);
  const currencyCode =
    'currency_code' in subscription && typeof subscription.currency_code === 'string'
      ? subscription.currency_code
      : fallbackCurrencyCode;

  if (status && status !== 'active') {
    return {
      isLoading: false,
      shouldBlock: true,
      reason: 'inactive',
      status,
      accountBalance,
      currencyCode,
    };
  }

  if (accountBalance <= 0) {
    return {
      isLoading: false,
      shouldBlock: true,
      reason: 'insufficient_balance',
      status: status || 'active',
      accountBalance,
      currencyCode,
    };
  }

  return {
    isLoading: false,
    shouldBlock: false,
    status: status || 'active',
    accountBalance,
    currencyCode,
  };
};

const formatMoney = (amount: number | undefined, currencyCode: string | undefined): string => {
  const value = Number(amount ?? 0);
  const code = String(currencyCode || 'USD').toUpperCase();

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
};

export function DashboardSubscriptionGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const { business, user } = useAuth();
  const pathname = usePathname();
  const [guardState, setGuardState] = useState<GuardState>({
    isLoading: true,
    shouldBlock: false,
  });

  const cachedSubscription = useLiveQuery(() => db.subscriptions.get('sub_main-business'), []);
  const businessId = business?.id || user?.businessId || null;
  const billingRoute = isBillingRoute(pathname);
  const cachedSubscriptionMatchesBusiness = Boolean(
    cachedSubscription &&
      (!businessId || String(cachedSubscription.businessId) === String(businessId))
  );
  const fallbackCurrencyCode = String(business?.currency || 'USD').toUpperCase();

  const fallbackToCachedSubscription = useMemo(() => {
    if (!cachedSubscription || !cachedSubscriptionMatchesBusiness) {
      return null;
    }

    return buildGuardStateFromSubscription(cachedSubscription, fallbackCurrencyCode);
  }, [cachedSubscription, cachedSubscriptionMatchesBusiness, fallbackCurrencyCode]);

  useEffect(() => {
    if (!fallbackToCachedSubscription) {
      return;
    }

    setGuardState(fallbackToCachedSubscription);
  }, [fallbackToCachedSubscription]);

  useEffect(() => {
    if (!user) {
      setGuardState({
        isLoading: false,
        shouldBlock: false,
      });
      return;
    }

    if (!businessId) {
      setGuardState({
        isLoading: false,
        shouldBlock: false,
      });
      return;
    }

    let active = true;

    const syncGuard = async () => {
      if (!fallbackToCachedSubscription) {
        setGuardState((current) => ({
          ...current,
          isLoading: true,
        }));
      }

      try {
        const response = await fetchCurrentSubscription(businessId);

        if (!active) {
          return;
        }

        setGuardState(buildGuardStateFromSubscription(response, fallbackCurrencyCode));
      } catch (error) {
        if (!active) {
          return;
        }

        const statusCode = Number((error as { status?: number } | undefined)?.status);

        if (statusCode === 404) {
          setGuardState({
            isLoading: false,
            shouldBlock: true,
            reason: 'no_subscription',
            currencyCode: fallbackCurrencyCode,
          });
          return;
        }

        if (fallbackToCachedSubscription) {
          setGuardState(fallbackToCachedSubscription);
          return;
        }

        console.warn('[SubscriptionGuard] Subscription check skipped:', error);
        setGuardState({
          isLoading: false,
          shouldBlock: false,
        });
      }
    };

    void syncGuard();

    return () => {
      active = false;
    };
  }, [businessId, fallbackCurrencyCode, fallbackToCachedSubscription, user?.uid]);

  if (billingRoute) {
    return <>{children}</>;
  }

  if (guardState.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!guardState.shouldBlock) {
    return <>{children}</>;
  }

  const isAdminUser = user?.role === 'Admin';
  const title =
    guardState.reason === 'no_subscription'
      ? 'Subscription Setup Required'
      : guardState.reason === 'inactive'
        ? 'Subscription Access Paused'
        : 'Add Credits to Continue';
  const description =
    guardState.reason === 'no_subscription'
      ? 'This business does not have an active subscription yet, so dashboard access is currently blocked.'
      : guardState.reason === 'inactive'
        ? `This business subscription is currently ${guardState.status || 'inactive'}, so dashboard access is paused.`
        : 'This business has no remaining subscription funds, so dashboard access is blocked until credits are added.';
  const billingHref = buildSubscriptionBillingUrl({
    openAddCredit: guardState.reason === 'insufficient_balance',
    subscriptionGuard: true,
  });

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl items-center justify-center">
      <Card className="w-full border-orange-500/30">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-orange-500/10 p-3 text-orange-600">
              {guardState.reason === 'no_subscription' ? (
                <ShieldAlert className="h-6 w-6" />
              ) : (
                <CreditCard className="h-6 w-6" />
              )}
            </div>
            <div>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {guardState.reason !== 'no_subscription' && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Subscription balance</AlertTitle>
              <AlertDescription>
                Remaining funds: {formatMoney(guardState.accountBalance, guardState.currencyCode)}
              </AlertDescription>
            </Alert>
          )}

          {isAdminUser ? (
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link href={billingHref}>
                  {guardState.reason === 'no_subscription' ? 'Open Billing' : 'Add Credits'}
                </Link>
              </Button>
              {guardState.reason === 'no_subscription' && (
                <Button asChild variant="outline">
                  <Link href="/setup">Go to Setup</Link>
                </Button>
              )}
            </div>
          ) : (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Admin action required</AlertTitle>
              <AlertDescription>
                Please contact your administrator to restore subscription access for this business.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
