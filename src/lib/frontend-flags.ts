export interface SubscriptionBillingUrlOptions {
  openAddCredit?: boolean;
  openManageFeatures?: boolean;
  subscriptionGuard?: boolean;
}

export const buildSubscriptionBillingUrl = (
  options: SubscriptionBillingUrlOptions = {}
): string => {
  const params = new URLSearchParams();

  if (options.openAddCredit) {
    params.set('openAddCredit', '1');
  }

  if (options.openManageFeatures) {
    params.set('openManageFeatures', '1');
  }

  if (options.subscriptionGuard) {
    params.set('subscriptionGuard', '1');
  }

  const query = params.toString();
  return query ? `/dashboard/settings/billing/?${query}` : '/dashboard/settings/billing/';
};
