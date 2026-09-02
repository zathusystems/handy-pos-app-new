/**
 * Subscription Access Control Utility
 * Provides methods to check feature access based on subscription status and SubscriptionFeature model
 */

import { type Subscription } from './db';

export type FeatureRestriction =
  | 'missing_subscription'
  | 'inactive_subscription'
  | 'feature_disabled'
  | 'insufficient_balance';

export interface FeatureAccessResult {
  allowed: boolean;
  reason?: string;
  requiresUpgrade?: boolean;
  restriction?: FeatureRestriction;
}

export interface SubscriptionFeatureInfo {
  name: string;
  description: string;
}

const FEATURE_INFO: Record<string, SubscriptionFeatureInfo> = {
  expense_management: {
    name: 'Expense Management',
    description: 'Track business expenses, organize spending categories, and review expense history by branch.',
  },
  invoicing: {
    name: 'Invoices & Quotations',
    description: 'Create quotations and invoices, then track customer billing and payment status.',
  },
  staff_management: {
    name: 'Multi-User Access',
    description: 'Allow your staff to run business operations with roles and access controls.',
  },
  tax_management: {
    name: 'Tax Management',
    description: 'Create and maintain tax rates used for sales, invoicing, and compliance workflows.',
  },
  online_menu: {
    name: 'Menu Management',
    description: 'Build a customer-facing menu, add menu images, configure menu branding, and share QR codes.',
  },
  online_ordering: {
    name: 'Online Ordering',
    description: 'Let customers place orders from the public menu for staff confirmation and kitchen preparation.',
  },
  kitchen: {
    name: 'Kitchen Display',
    description: 'Track confirmed orders through preparation, ready, and completed kitchen stages.',
  },
  take_orders: {
    name: 'Take Orders',
    description: 'Create staff or self-service orders before checkout and send them through restaurant workflows.',
  },
};

const formatFeatureName = (featureName: string): string =>
  featureName
    .replace(/^enable_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export function getSubscriptionFeatureInfo(featureName: string): SubscriptionFeatureInfo {
  const normalizedFeatureName = featureName.startsWith('enable_')
    ? featureName.replace(/^enable_/, '')
    : featureName;

  return (
    FEATURE_INFO[normalizedFeatureName] || {
      name: formatFeatureName(normalizedFeatureName),
      description: 'This module is controlled by your subscription features.',
    }
  );
}

/**
 * Check if a subscription is active and can be used
 */
export function isSubscriptionActive(subscription: Subscription | undefined): boolean {
  if (!subscription) return false;
  return subscription.status === 'active';
}

/**
 * Check if a feature is enabled via SubscriptionFeature
 * This checks the local subscriptionFeatures array
 */
export function isFeatureEnabled(
  subscription: Subscription | undefined,
  featureName: string,
  subscriptionFeatures?: Array<{ feature: string; enabled: boolean }>
): boolean {
  if (!subscription) return false;
  const normalizedFeatureName = featureName.startsWith('enable_')
    ? featureName.replace(/^enable_/, '')
    : featureName;
  
  // If subscriptionFeatures array is provided, check it
  if (subscriptionFeatures && Array.isArray(subscriptionFeatures)) {
    const explicitFeature = subscriptionFeatures.find(
      sf => sf.feature === normalizedFeatureName
    );
    if (explicitFeature) {
      return explicitFeature.enabled === true;
    }
  }

  const cachedFeatureAssignments = subscription.enabledFeatures;
  if (Array.isArray(cachedFeatureAssignments)) {
    const explicitFeature = cachedFeatureAssignments.find(
      sf => sf.feature === normalizedFeatureName
    );
    if (explicitFeature) {
      return explicitFeature.enabled === true;
    }
  }
  
  // Fallback to checking enable_* fields on subscription model
  const featureKey = `enable_${normalizedFeatureName}` as keyof Subscription;
  if (featureKey in subscription) {
    return (subscription[featureKey] as any) === true;
  }
  
  return false;
}

/**
 * Check if a feature can be used (enabled + subscription active + sufficient balance)
 */
export function canUseFeature(
  subscription: Subscription | undefined,
  featureName: string,
  subscriptionFeatures?: Array<{ feature: string; enabled: boolean }>
): FeatureAccessResult {
  if (!subscription) {
    return {
      allowed: false,
      reason: 'No subscription found',
      requiresUpgrade: true,
      restriction: 'missing_subscription',
    };
  }

  // Check if subscription is active
  if (!isSubscriptionActive(subscription)) {
    return {
      allowed: false,
      reason: `Subscription is ${subscription.status}`,
      requiresUpgrade: subscription.status === 'cancelled',
      restriction: 'inactive_subscription',
    };
  }

  // Check if feature is enabled via SubscriptionFeature
  if (!isFeatureEnabled(subscription, featureName, subscriptionFeatures)) {
    const feature = getSubscriptionFeatureInfo(featureName);
    return {
      allowed: false,
      reason: `${feature.name} is not enabled in your subscription`,
      requiresUpgrade: true,
      restriction: 'feature_disabled',
    };
  }

  // Check if account has sufficient balance
  if (subscription.account_balance <= 0) {
    return {
      allowed: false,
      reason: 'Insufficient account balance. Please add credits.',
      requiresUpgrade: false,
      restriction: 'insufficient_balance',
    };
  }

  return {
    allowed: true,
  };
}

/**
 * Check if staff management feature is available
 */
export function canManageStaff(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'staff_management');
}

/**
 * Check if inventory management feature is available
 */
export function canManageInventory(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'inventory');
}

/**
 * Check if invoicing feature is available
 */
export function canUseInvoicing(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'invoicing');
}

/**
 * Check if POS feature is available
 */
export function canUsePOS(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'pos');
}

/**
 * Check if waste management feature is available
 */
export function canManageWaste(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'waste_management');
}

/**
 * Check if stock transfers feature is available
 */
export function canTransferStock(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'stock_transfers');
}

/**
 * Check if stock audits feature is available
 */
export function canAuditStock(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'stock_audits');
}

/**
 * Check if supplier management feature is available
 */
export function canManageSuppliers(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'supplier_management');
}

/**
 * Check if purchase orders feature is available
 */
export function canCreatePurchaseOrders(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'purchases');
}

/**
 * Check if expense management feature is available
 */
export function canManageExpenses(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'expense_management');
}

/**
 * Check if customer management feature is available
 */
export function canManageCustomers(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'customer_management');
}

/**
 * Check if analytics feature is available
 */
export function canViewAnalytics(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'analytics');
}

/**
 * Check if reports feature is available
 */
export function canViewReports(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'reports');
}

/**
 * Check if tax management feature is available
 */
export function canManageTaxes(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'tax_management');
}

/**
 * Check if take orders feature is available
 */
export function canTakeOrders(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'take_orders');
}

/**
 * Check if online menu feature is available
 */
export function canUseOnlineMenu(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'online_menu');
}

/**
 * Check if online ordering feature is available
 */
export function canUseOnlineOrdering(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'online_ordering');
}

/**
 * Check if kitchen display system feature is available
 */
export function canUseKitchen(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'kitchen');
}

/**
 * Check if multi-branch feature is available
 */
export function canManageMultipleBranches(subscription: Subscription | undefined): FeatureAccessResult {
  return canUseFeature(subscription, 'multi_branch');
}

/**
 * Get all enabled features for a subscription
 */
export function getEnabledFeatures(subscription: Subscription | undefined): string[] {
  if (!subscription) return [];

  const features: string[] = [];
  const featureFlags = [
    'enable_pos',
    'enable_inventory',
    'enable_invoicing',
    'enable_online_menu',
    'enable_online_ordering',
    'enable_kitchen',
    'enable_expense_management',
    'enable_supplier_management',
    'enable_purchases',
    'enable_low_stock_alerts',
    'enable_expiry_alerts',
    'enable_customer_management',
    'enable_reports',
    'enable_analytics',
    'enable_take_orders',
    'enable_staff_management',
    'enable_waste_management',
    'enable_stock_transfers',
    'enable_stock_audits',
    'enable_tax_management',
    'enable_multi_branch',
  ];

  for (const flag of featureFlags) {
    if (isFeatureEnabled(subscription, flag as keyof Subscription)) {
      features.push(flag);
    }
  }

  return features;
}

/**
 * Get subscription status summary
 */
export function getSubscriptionStatus(subscription: Subscription | undefined) {
  if (!subscription) {
    return {
      isActive: false,
      status: 'No subscription',
      balance: 0,
      daysRemaining: 0,
      isLowBalance: false,
    };
  }

  const daysRemaining = subscription.base_price_per_day > 0
    ? Math.floor(subscription.account_balance / subscription.base_price_per_day)
    : 0;

  return {
    isActive: isSubscriptionActive(subscription),
    status: subscription.status,
    balance: subscription.account_balance,
    daysRemaining,
    isLowBalance: subscription.account_balance < subscription.low_balance_threshold,
    isFreeTrial: subscription.free_trial_credits_applied && subscription.free_trial_end_date
      ? new Date(subscription.free_trial_end_date) > new Date()
      : false,
  };
}
