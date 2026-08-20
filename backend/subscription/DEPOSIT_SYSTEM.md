# Deposit System Documentation

## Overview

The deposit system allows users to add credits to their subscription account balance. These credits are then used to pay for monthly invoices automatically or can be used for other charges.

## Features

- **Multiple Payment Methods**: Support for Stripe, PayPal, Bank Transfer, and Manual (Admin) deposits
- **Deposit Tracking**: Track all deposits with status (pending, completed, failed, cancelled)
- **Auto-Completion**: Admin can complete deposits to add credits to account
- **Deposit Summary**: View total deposited, pending, and failed amounts
- **Transaction History**: Full audit trail of all deposits

## Models

### Deposit Model

```python
class Deposit(models.Model):
    subscription = ForeignKey(Subscription)
    amount = DecimalField  # Deposit amount
    status = CharField  # pending, completed, failed, cancelled
    payment_method = CharField  # stripe, paypal, bank_transfer, manual
    transaction_id = CharField  # External transaction ID
    stripe_payment_intent_id = CharField  # Stripe payment intent ID
    requested_date = DateTimeField  # When deposit was requested
    completed_date = DateTimeField  # When deposit was completed
    notes = TextField  # Admin notes
```

## API Endpoints

### Create Deposit Request

```
POST /api/deposits/
Content-Type: application/json

{
    "amount": 100.00,
    "payment_method": "stripe",
    "notes": "Monthly subscription top-up"
}
```

Response:
```json
{
    "id": 1,
    "subscription": 1,
    "amount": "100.00",
    "status": "pending",
    "status_display": "Pending",
    "payment_method": "stripe",
    "payment_method_display": "Stripe",
    "transaction_id": "",
    "stripe_payment_intent_id": "",
    "requested_date": "2024-01-15T10:30:00Z",
    "completed_date": null,
    "notes": "Monthly subscription top-up",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
}
```

### List Deposits

```
GET /api/deposits/
```

Returns paginated list of all deposits for the user's subscription.

### Get Deposit Details

```
GET /api/deposits/{id}/
```

### Complete Deposit

```
POST /api/deposits/{id}/complete/
```

Marks deposit as completed and adds credits to subscription account balance.

Response:
```json
{
    "id": 1,
    "status": "completed",
    "completed_date": "2024-01-15T10:35:00Z",
    ...
}
```

### Cancel Deposit

```
POST /api/deposits/{id}/cancel/
```

Cancels a pending deposit.

### Get Deposit Summary

```
GET /api/deposits/summary/
```

Returns deposit summary for the current user:

```json
{
    "total_deposited": 500.00,
    "pending_deposits": 100.00,
    "failed_deposits": 0.00,
    "current_balance": 400.00,
    "total_spent": 150.00,
    "recent_deposits": [
        {
            "id": 1,
            "amount": "100.00",
            "status": "completed",
            "payment_method": "stripe",
            "requested_date": "2024-01-15T10:30:00Z",
            "completed_date": "2024-01-15T10:35:00Z"
        }
    ]
}
```

## Admin Interface

### Deposit Admin

The admin interface provides:

- **List View**: See all deposits with status badges, amounts, and payment methods
- **Search**: Search by business name or transaction ID
- **Filters**: Filter by status, payment method, and date range
- **Bulk Actions**:
  - Complete selected deposits (adds credits to accounts)
  - Cancel selected deposits

### Deposit Details

Edit deposit details including:
- Subscription
- Amount
- Status
- Payment method
- Transaction IDs
- Notes

## Workflow

### User Deposits Credits

1. User requests deposit via API
2. Deposit created with "pending" status
3. User completes payment (via Stripe, PayPal, etc.)
4. Admin receives notification or webhook
5. Admin marks deposit as "completed"
6. Credits added to subscription account balance

### Automatic Invoice Payment

1. Monthly invoice generated
2. System checks account balance
3. If balance >= invoice amount:
   - Deduct from balance
   - Mark invoice as "paid"
   - Record usage charge
4. If balance < invoice amount:
   - Leave invoice as "sent"
   - User must add credits or pay manually

## Programmatic Usage

### Create Deposit

```python
from subscription.models import Deposit, Subscription

subscription = Subscription.objects.get(business_id=1)
deposit = Deposit.objects.create(
    subscription=subscription,
    amount=100.00,
    payment_method='stripe',
    notes='User requested deposit'
)
```

### Complete Deposit

```python
deposit = Deposit.objects.get(id=1)
if deposit.complete_deposit():
    print(f"Deposit completed. New balance: ${deposit.subscription.account_balance}")
else:
    print("Failed to complete deposit")
```

### Cancel Deposit

```python
deposit = Deposit.objects.get(id=1)
if deposit.cancel_deposit():
    print("Deposit cancelled")
```

### Get Deposit Summary

```python
from subscription.utils import get_subscription_summary

subscription = Subscription.objects.get(business_id=1)
summary = get_subscription_summary(subscription)

print(f"Current balance: ${summary['account_balance']}")
print(f"Daily charge: ${summary['daily_charge']}")
print(f"Days until insufficient balance: {summary['days_until_insufficient_balance']}")
```

## Integration with Stripe

### Webhook Handling

When using Stripe for deposits, handle webhooks:

```python
# In your webhook handler
@csrf_exempt
def stripe_webhook(request):
    payload = request.body
    sig_header = request.META.get('HTTP_STRIPE_SIGNATURE')
    
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        return HttpResponse(status=400)
    
    if event['type'] == 'payment_intent.succeeded':
        payment_intent = event['data']['object']
        
        # Find deposit by stripe_payment_intent_id
        deposit = Deposit.objects.get(
            stripe_payment_intent_id=payment_intent['id']
        )
        
        # Complete the deposit
        deposit.complete_deposit()
    
    return HttpResponse(status=200)
```

### Create Payment Intent

```python
import stripe

stripe.api_key = settings.STRIPE_SECRET_KEY

deposit = Deposit.objects.create(
    subscription=subscription,
    amount=100.00,
    payment_method='stripe'
)

intent = stripe.PaymentIntent.create(
    amount=int(deposit.amount * 100),  # Amount in cents
    currency='usd',
    metadata={
        'deposit_id': deposit.id,
        'business_id': subscription.business.id
    }
)

deposit.stripe_payment_intent_id = intent['id']
deposit.save()
```

## Best Practices

1. **Minimum Balance**: Encourage users to maintain at least 2-3 months of charges
2. **Low Balance Alerts**: Send notifications when balance drops below threshold
3. **Auto-Renewal**: Consider implementing automatic credit card charging
4. **Deposit Limits**: Set reasonable min/max deposit amounts
5. **Transaction Records**: Keep detailed records for accounting
6. **Refund Policy**: Define clear refund policy for unused credits

## Troubleshooting

### Deposit Not Completing

- Check deposit status is "pending"
- Verify subscription exists and is active
- Check for any validation errors

### Credits Not Added

- Verify deposit.complete_deposit() returned True
- Check subscription.account_balance was updated
- Review audit logs for any errors

### Payment Intent Not Found

- Verify stripe_payment_intent_id is stored correctly
- Check Stripe webhook is being received
- Review Stripe logs for payment status

## Future Enhancements

- Automatic credit card charging on failed invoices
- Recurring deposits (auto-top-up)
- Deposit expiration dates
- Promotional deposit bonuses
- Deposit analytics and reporting
- Multi-currency support
