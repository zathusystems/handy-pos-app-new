'use client';

import Link from 'next/link';
import { AlertCircle, CreditCard, Lock } from 'lucide-react';

import { buildSubscriptionBillingUrl } from '@/lib/frontend-flags';
import {
  getSubscriptionFeatureInfo,
  type FeatureAccessResult,
} from '@/lib/subscription-access';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const getBillingCta = (accessCheck: FeatureAccessResult) => {
  if (accessCheck.restriction === 'feature_disabled') {
    return {
      href: buildSubscriptionBillingUrl({ openManageFeatures: true }),
      label: 'Enable in Billing',
    };
  }

  if (accessCheck.restriction === 'insufficient_balance') {
    return {
      href: buildSubscriptionBillingUrl({ openAddCredit: true }),
      label: 'Add Credits',
    };
  }

  return {
    href: buildSubscriptionBillingUrl(),
    label: 'Open Billing',
  };
};

type SubscriptionFeatureDisabledCardProps = {
  featureName: string;
  accessCheck: FeatureAccessResult;
};

export function SubscriptionFeatureDisabledCard({
  featureName,
  accessCheck,
}: SubscriptionFeatureDisabledCardProps) {
  const feature = getSubscriptionFeatureInfo(featureName);
  const billingCta = getBillingCta(accessCheck);

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-100 p-2 text-amber-700">
            {accessCheck.restriction === 'feature_disabled' ? (
              <Lock className="h-5 w-5" />
            ) : accessCheck.restriction === 'insufficient_balance' ? (
              <CreditCard className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
          </div>
          <div className="space-y-1">
            <CardTitle className="text-amber-950">{feature.name} Unavailable</CardTitle>
            <CardDescription className="text-amber-800">
              {feature.description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-amber-900">
          {accessCheck.reason ||
            `${feature.name} is currently unavailable for this subscription.`}
        </p>
        <p className="text-sm text-amber-800">
          {accessCheck.restriction === 'feature_disabled'
            ? 'Enable this feature from Billing > Subscription Features to use this screen.'
            : accessCheck.restriction === 'insufficient_balance'
              ? 'Add credits in Billing to restore access to this feature.'
              : 'Review the business subscription in Billing to restore access.'}
        </p>
        <Button asChild>
          <Link href={billingCta.href}>{billingCta.label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
