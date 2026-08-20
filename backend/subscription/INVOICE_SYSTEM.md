# Subscription Invoice Generation System

## Overview

This system automatically generates monthly invoices for all active pay-as-you-go subscriptions and attempts to auto-pay them using available account balance.

## Features

- **Automatic Invoice Generation**: Generate invoices at the end of each month
- **Auto-Payment**: Automatically pay invoices if sufficient balance is available
- **Feature-Based Pricing**: Charge per-feature daily rates in addition to base subscription fee
- **Balance Tracking**: Track account balance, total spent, and pending invoices
- **Invoice Management**: Full invoice lifecycle management (draft, sent, paid, failed)

## Models

### Subscription
Main subscription model with:
- `base_price_per_day`: Base daily subscription fee
- `account_balance`: Current account credits
- `total_spent`: Lifetime spending
- `last_payment_date`: When credits were last added
- `last_billing_date`: When last invoice was generated

### FeaturePricing
Defines pricing for individual features:
- `feature`: Feature identifier
- `price_per_day`: Daily price for the feature
- `is_active`: Whether the feature pricing is active

### SubscriptionFeature
Links subscriptions to enabled features:
- Tracks which features are enabled per subscription
- Records when each feature was enabled

### UsageCharge
Tracks individual charges:
- `charge_type`: Type of charge (base_daily, feature, transaction, etc.)
- `amount`: Charge amount
- `description`: Charge description

### Invoice
Monthly invoices:
- `invoice_number`: Unique invoice identifier
- `amount`: Total invoice amount
- `status`: draft, sent, paid, or failed
- `billing_period_start/end`: Billing period dates
- `paid_date`: When invoice was paid

## Usage

### Manual Invoice Generation

Generate invoices for a specific month:

```bash
# Generate invoices for current month
python manage.py generate_invoices

# Generate invoices for a specific month
python manage.py generate_invoices --month 12 --year 2024

# Dry run (see what would happen without making changes)
python manage.py generate_invoices --dry-run
```

### Programmatic Usage

```python
from subscription.utils import create_invoice, get_billing_period, process_invoice_payment

# Get billing period
start, end = get_billing_period(month=12, year=2024)

# Create invoice with auto-payment
invoice, paid = create_invoice(subscription, start, end, auto_pay=True)

# Manually process payment
success = process_invoice_payment(invoice)

# Get subscription summary
from subscription.utils import get_subscription_summary
summary = get_subscription_summary(subscription)
print(f"Daily charge: ${summary['daily_charge']}")
print(f"Monthly charge: ${summary['monthly_charge']}")
print(f"Balance: ${summary['account_balance']}")
print(f"Days until insufficient balance: {summary['days_until_insufficient_balance']}")
```

### Celery Tasks (Optional)

If using Celery, schedule these tasks:

```python
# Generate invoices on the last day of each month
from celery.schedules import crontab

CELERY_BEAT_SCHEDULE = {
    'generate-monthly-invoices': {
        'task': 'subscription.tasks.generate_monthly_invoices',
        'schedule': crontab(day_of_month=28),  # Run on 28th (works for all months)
    },
    'retry-failed-invoices': {
        'task': 'subscription.tasks.retry_failed_invoices',
        'schedule': crontab(hour=2, minute=0),  # Run daily at 2 AM
    },
    'check-low-balance': {
        'task': 'subscription.tasks.check_low_balance_subscriptions',
        'schedule': crontab(hour=1, minute=0),  # Run daily at 1 AM
    },
}
```

## Admin Interface

### Subscription Admin
- View subscription details
- Manage account balance and pricing
- Enable/disable features
- View total spent and payment history

### Invoice Admin
- View all invoices with status badges
- Search by invoice number or business name
- Bulk actions:
  - Mark as paid
  - Mark as failed
  - Attempt auto-payment

### Feature Pricing Admin
- Manage per-feature daily pricing
- Enable/disable features globally

### Usage Charge Admin
- View all charges by type
- Track charge history

## Pricing Calculation

### Daily Charges
```
Daily Charge = Base Price Per Day + Sum of Enabled Feature Prices
```

### Monthly Charges
```
Monthly Charge = Daily Charge × 30 days
```

### Example
- Base price: $5.00/day
- POS System: $2.00/day
- Inventory: $1.50/day
- Analytics: $1.00/day

Daily charge: $9.50
Monthly charge: $285.00

## Auto-Payment Logic

When an invoice is generated:

1. Calculate total charges for the month
2. Create invoice with "sent" status
3. Check if subscription has sufficient balance
4. If yes:
   - Deduct amount from account balance
   - Mark invoice as "paid"
   - Record usage charge
5. If no:
   - Leave invoice as "sent"
   - User must manually pay or add credits

## Invoice Lifecycle

```
draft → sent → paid
              ↓
            failed → (retry) → paid
```

## API Endpoints

### Get Subscription Summary
```
GET /api/subscriptions/current/
```

Response includes:
- Current balance
- Daily/monthly charges
- Pending invoices
- Days until insufficient balance

### Get Invoices
```
GET /api/invoices/
```

Returns all invoices for the user's subscriptions.

## Best Practices

1. **Add Credits Regularly**: Encourage users to maintain a balance of at least 2-3 months of charges
2. **Monitor Low Balance**: Set up alerts for subscriptions with low balance
3. **Retry Failed Payments**: Use the retry task to attempt payment for failed invoices
4. **Review Pricing**: Regularly review feature pricing to ensure profitability
5. **Backup Payment Method**: Consider integrating Stripe for automatic credit card charging

## Troubleshooting

### Invoice Not Generated
- Check if subscription status is ACTIVE
- Verify subscription has not already been invoiced for that month
- Check management command logs

### Auto-Payment Failed
- Verify account balance is sufficient
- Check if subscription is active
- Review UsageCharge records for any errors

### Incorrect Charges
- Verify FeaturePricing rates are correct
- Check which features are enabled for the subscription
- Review calculate_monthly_charges() method

## Future Enhancements

- Stripe integration for automatic credit card charging
- Email notifications for invoices and low balance
- Usage-based charges (per transaction, per API call)
- Discount codes and promotional pricing
- Invoice payment history and receipts
- Subscription pause/resume functionality
