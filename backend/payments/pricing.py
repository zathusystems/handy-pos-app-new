from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from system_config.models import SystemConfig


MONEY_PRECISION = Decimal('0.01')
MONTHLY_BILLING_DAYS = Decimal('30')
CUSTOM_FUNDING_PERIOD = 'custom'

SUBSCRIPTION_FUNDING_PLANS = {
    'monthly': {
        'days': Decimal('30'),
        'discount_rate': Decimal('0.00'),
    },
    'quarterly': {
        'days': Decimal('90'),
        'discount_rate': Decimal('0.05'),
    },
    'semiannual': {
        'days': Decimal('180'),
        'discount_rate': Decimal('0.10'),
    },
    'yearly': {
        'days': Decimal('360'),
        'discount_rate': Decimal('0.15'),
    },
}


def quantize_money(value):
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        decimal_value = Decimal('0.00')
    return decimal_value.quantize(MONEY_PRECISION, rounding=ROUND_HALF_UP)


def normalize_funding_period(value):
    normalized = str(value or '').strip().lower()
    if normalized in SUBSCRIPTION_FUNDING_PLANS or normalized == CUSTOM_FUNDING_PERIOD:
        return normalized
    return ''


def get_custom_monthly_minimum(subscription):
    daily_charge = quantize_money(subscription.calculate_daily_charges())
    return quantize_money(daily_charge * MONTHLY_BILLING_DAYS)


def get_configured_minimum_deposit_amount():
    return quantize_money(SystemConfig.get_config().minimum_deposit_amount)


def get_effective_custom_payment_minimum(subscription):
    return get_configured_minimum_deposit_amount()


def get_credit_purchase_discount_rate(subscription, default_rate=Decimal('0.00')):
    """Return the subscription-specific credit discount, when one is set.

    Zero means use the regular funding-plan rate. This keeps the override
    explicit and lets an administrator remove it by setting it back to 0.
    """
    try:
        configured_rate = Decimal(str(subscription.custom_credit_discount_percent or 0)) / Decimal('100')
    except (InvalidOperation, TypeError, ValueError):
        configured_rate = Decimal('0.00')

    if configured_rate > 0:
        return min(configured_rate, Decimal('0.99'))
    return Decimal(str(default_rate or 0))


def build_subscription_funding_quote(subscription, funding_period):
    normalized_period = normalize_funding_period(funding_period)
    if normalized_period not in SUBSCRIPTION_FUNDING_PLANS:
        raise ValueError(f'Unsupported funding period: {funding_period}')

    plan = SUBSCRIPTION_FUNDING_PLANS[normalized_period]
    daily_charge = quantize_money(subscription.calculate_daily_charges())
    base_amount = quantize_money(daily_charge * plan['days'])
    discount_rate = get_credit_purchase_discount_rate(subscription, plan['discount_rate'])
    discount_amount = quantize_money(base_amount * discount_rate)
    final_amount = quantize_money(base_amount - discount_amount)

    return {
        'funding_period': normalized_period,
        'days': int(plan['days']),
        'discount_rate': discount_rate,
        'daily_charge': daily_charge,
        'base_amount': base_amount,
        'credit_amount': base_amount,
        'discount_amount': discount_amount,
        'bonus_credit_amount': discount_amount,
        'final_amount': final_amount,
        'minimum_custom_amount': get_effective_custom_payment_minimum(subscription),
    }


def serialize_subscription_funding_quote(quote):
    return {
        'funding_period': quote['funding_period'],
        'days': quote['days'],
        'discount_rate': float(quote['discount_rate']),
        'daily_charge': float(quote['daily_charge']),
        'base_amount': float(quote['base_amount']),
        'credit_amount': float(quote.get('credit_amount', quote['base_amount'])),
        'discount_amount': float(quote['discount_amount']),
        'bonus_credit_amount': float(quote.get('bonus_credit_amount', quote['discount_amount'])),
        'final_amount': float(quote['final_amount']),
        'minimum_custom_amount': float(quote['minimum_custom_amount']),
    }


def validate_subscription_payment_amount(subscription, amount, funding_period=None):
    normalized_period = normalize_funding_period(funding_period)
    normalized_amount = quantize_money(amount)
    configured_minimum_amount = get_configured_minimum_deposit_amount()

    if not normalized_period:
        if normalized_amount <= 0:
            return {
                'is_valid': False,
                'detail': 'A valid amount greater than 0 is required.',
                'funding_period': '',
                'quote': None,
                'normalized_amount': normalized_amount,
            }

        if normalized_amount < configured_minimum_amount:
            return {
                'is_valid': False,
                'detail': (
                    'Deposit amount must be at least the configured minimum deposit amount '
                    f'({configured_minimum_amount}).'
                ),
                'funding_period': '',
                'quote': None,
                'normalized_amount': normalized_amount,
            }

        discount_rate = get_credit_purchase_discount_rate(subscription)
        quote = None
        if discount_rate > 0:
            credit_amount = quantize_money(normalized_amount / (Decimal('1.00') - discount_rate))
            discount_amount = quantize_money(credit_amount - normalized_amount)
            quote = {
                'funding_period': '',
                'days': 0,
                'discount_rate': discount_rate,
                'daily_charge': quantize_money(subscription.calculate_daily_charges()),
                'base_amount': credit_amount,
                'credit_amount': credit_amount,
                'discount_amount': discount_amount,
                'bonus_credit_amount': discount_amount,
                'final_amount': normalized_amount,
                'minimum_custom_amount': get_effective_custom_payment_minimum(subscription),
            }

        return {
            'is_valid': True,
            'detail': '',
            'funding_period': '',
            'quote': quote,
            'normalized_amount': normalized_amount,
        }

    if normalized_period == CUSTOM_FUNDING_PERIOD:
        minimum_custom_amount = get_effective_custom_payment_minimum(subscription)
        discount_rate = get_credit_purchase_discount_rate(subscription)
        credit_amount = (
            quantize_money(normalized_amount / (Decimal('1.00') - discount_rate))
            if discount_rate > 0
            else normalized_amount
        )
        discount_amount = quantize_money(credit_amount - normalized_amount)
        if normalized_amount < minimum_custom_amount:
            return {
                'is_valid': False,
                'detail': (
                    'Custom subscription funding must be at least the configured minimum deposit amount '
                    f'({minimum_custom_amount}).'
                ),
                'funding_period': normalized_period,
                'quote': {
                    'funding_period': normalized_period,
                    'days': int(MONTHLY_BILLING_DAYS),
                    'discount_rate': discount_rate,
                    'daily_charge': quantize_money(subscription.calculate_daily_charges()),
                    'base_amount': credit_amount,
                    'credit_amount': credit_amount,
                    'discount_amount': discount_amount,
                    'bonus_credit_amount': discount_amount,
                    'final_amount': normalized_amount,
                    'minimum_custom_amount': minimum_custom_amount,
                },
                'normalized_amount': normalized_amount,
            }

        return {
            'is_valid': True,
            'detail': '',
            'funding_period': normalized_period,
            'quote': {
                'funding_period': normalized_period,
                'days': int(MONTHLY_BILLING_DAYS),
                'discount_rate': discount_rate,
                'daily_charge': quantize_money(subscription.calculate_daily_charges()),
                'base_amount': credit_amount,
                'credit_amount': credit_amount,
                'discount_amount': discount_amount,
                'bonus_credit_amount': discount_amount,
                'final_amount': normalized_amount,
                'minimum_custom_amount': minimum_custom_amount,
            },
            'normalized_amount': normalized_amount,
        }

    quote = build_subscription_funding_quote(subscription, normalized_period)
    expected_amount = quote['final_amount']
    if expected_amount < configured_minimum_amount:
        return {
            'is_valid': False,
            'detail': (
                f'The selected {normalized_period} funding amount ({expected_amount}) is below the '
                f'configured minimum deposit amount ({configured_minimum_amount}). '
                'Choose a larger bundle or use a custom amount.'
            ),
            'funding_period': normalized_period,
            'quote': quote,
            'normalized_amount': normalized_amount,
        }

    if normalized_amount != expected_amount:
        return {
            'is_valid': False,
            'detail': (
                f'The selected {normalized_period} funding amount must be exactly {expected_amount} '
                'based on the current subscription daily charge.'
            ),
            'funding_period': normalized_period,
            'quote': quote,
            'normalized_amount': normalized_amount,
        }

    return {
        'is_valid': True,
        'detail': '',
        'funding_period': normalized_period,
        'quote': quote,
        'normalized_amount': normalized_amount,
    }
