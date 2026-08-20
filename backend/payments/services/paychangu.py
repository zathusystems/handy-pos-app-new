import hashlib
import hmac
import uuid
from decimal import Decimal, InvalidOperation

import requests


PAYCHANGU_SIGNATURE_HEADER = 'Signature'
PAYCHANGU_DEFAULT_CHECKOUT_URL = 'https://api.paychangu.com/payment'
PAYCHANGU_DEFAULT_VERIFY_URL_TEMPLATE = 'https://api.paychangu.com/verify-payment/{tx_ref}'


class PayChanguGatewayError(Exception):
    def __init__(self, message, *, payload=None, status_code=None):
        super().__init__(message)
        self.payload = payload or {}
        self.status_code = status_code


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def iter_payload_candidates(payload):
    top_level = _as_dict(payload)
    data = _as_dict(top_level.get('data'))
    nested_data = _as_dict(data.get('data'))

    # Prefer the most specific nested transaction payload first. Some PayChangu
    # verify responses use top-level `status=success` to mean "API request
    # succeeded" while the real payment state lives in `data.status`.
    return (nested_data, data, top_level)


def split_customer_name(full_name):
    name_parts = (full_name or '').strip().split(None, 1)
    first_name = name_parts[0] if name_parts else ''
    last_name = name_parts[1] if len(name_parts) > 1 else ''
    return first_name, last_name


def build_tx_ref(deposit_reference):
    return f'subcredit-{deposit_reference}-{uuid.uuid4().hex[:12]}'


def build_authorization_headers(secret_key):
    return {
        'Accept': 'application/json',
        'Authorization': f'Bearer {secret_key}',
    }


def build_checkout_payload(deposit, config, tx_ref=None, extra_meta=None, callback_url=None, return_url=None):
    subscription = deposit.subscription
    business = subscription.business
    owner = business.owner
    customer_name = f'{owner.first_name} {owner.last_name}'.strip() or business.name
    first_name, last_name = split_customer_name(customer_name)
    currency = subscription.get_currency_code() or config.default_currency
    payload_meta = {
        'deposit_id': deposit.deposit_id,
        'subscription_id': subscription.id,
        'business_id': business.id,
        'payment_category': 'subscription_credit',
    }
    if extra_meta:
        payload_meta.update(extra_meta)

    description_suffix = deposit.deposit_id or f'business-{business.id}'

    return {
        'amount': str(deposit.amount),
        'currency': currency,
        'email': owner.email or '',
        'first_name': first_name,
        'last_name': last_name,
        'callback_url': callback_url or config.callback_url,
        'return_url': return_url or config.return_url or callback_url or config.callback_url,
        'tx_ref': tx_ref or build_tx_ref(deposit.deposit_id or deposit.pk),
        'customization': {
            'title': config.payment_title,
            'description': f'{config.payment_description} - {description_suffix}',
        },
        'meta': payload_meta,
    }


def build_verify_url(tx_ref, config=None):
    template = getattr(config, 'verify_url_template', '') or PAYCHANGU_DEFAULT_VERIFY_URL_TEMPLATE
    return template.format(tx_ref=tx_ref)


def extract_checkout_url(payload):
    return (
        payload.get('data', {}).get('checkout_url')
        or payload.get('checkout_url')
        or ''
    )


def extract_tx_ref(payload):
    for candidate in iter_payload_candidates(payload):
        tx_ref = candidate.get('tx_ref')
        if tx_ref:
            return tx_ref

    for candidate in iter_payload_candidates(payload):
        reference = candidate.get('reference')
        if reference:
            return reference

    return ''


def extract_reference(payload):
    for candidate in iter_payload_candidates(payload):
        reference = candidate.get('reference')
        if reference:
            return reference

    return ''


def extract_payment_status(payload):
    for candidate in iter_payload_candidates(payload):
        payment_status = candidate.get('status')
        if payment_status:
            return payment_status

    return ''


def extract_provider_message(payload):
    return payload.get('message') or payload.get('detail') or ''


def extract_amount(payload):
    raw_amount = '0'
    for candidate in iter_payload_candidates(payload):
        candidate_amount = candidate.get('amount')
        if candidate_amount not in [None, '']:
            raw_amount = candidate_amount
            break

    try:
        return Decimal(str(raw_amount))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal('0.00')


def extract_currency(payload):
    for candidate in iter_payload_candidates(payload):
        currency = candidate.get('currency')
        if currency:
            return currency

    return ''


def safe_json(response):
    try:
        return response.json()
    except ValueError:
        return {}


def initiate_checkout(deposit, config, *, callback_url=None, return_url=None, extra_meta=None, timeout=30):
    payload = build_checkout_payload(
        deposit,
        config,
        extra_meta=extra_meta,
        callback_url=callback_url,
        return_url=return_url,
    )
    headers = build_authorization_headers(config.secret_key)
    try:
        response = requests.post(
            config.checkout_init_url or PAYCHANGU_DEFAULT_CHECKOUT_URL,
            json=payload,
            headers=headers,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise PayChanguGatewayError('Could not reach PayChangu checkout service.') from exc
    response_payload = safe_json(response)

    if response.status_code >= 400:
        raise PayChanguGatewayError(
            extract_provider_message(response_payload) or 'PayChangu checkout initiation failed.',
            payload=response_payload,
            status_code=response.status_code,
        )

    checkout_url = extract_checkout_url(response_payload)
    if not checkout_url:
        raise PayChanguGatewayError(
            'PayChangu did not return a checkout URL.',
            payload=response_payload,
            status_code=response.status_code,
        )

    return {
        'request_payload': payload,
        'response_payload': response_payload,
        'checkout_url': checkout_url,
        'tx_ref': extract_tx_ref(response_payload) or payload['tx_ref'],
        'callback_status': extract_payment_status(response_payload),
    }


def verify_transaction(tx_ref, config, *, timeout=30):
    headers = build_authorization_headers(config.secret_key)
    try:
        response = requests.get(
            build_verify_url(tx_ref, config),
            headers=headers,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise PayChanguGatewayError('Could not reach PayChangu verification service.') from exc
    response_payload = safe_json(response)

    if response.status_code >= 400:
        raise PayChanguGatewayError(
            extract_provider_message(response_payload) or 'PayChangu verification failed.',
            payload=response_payload,
            status_code=response.status_code,
        )

    return response_payload


def evaluate_verification(payload, *, expected_tx_ref, expected_amount, expected_currency):
    payment_status = (extract_payment_status(payload) or '').strip().lower()
    tx_ref = extract_tx_ref(payload)
    currency = (extract_currency(payload) or '').upper()
    amount = extract_amount(payload)
    expected_currency = (expected_currency or '').upper()

    return {
        'payment_status': payment_status,
        'tx_ref_matches': tx_ref == expected_tx_ref,
        'amount_matches': amount >= expected_amount,
        'currency_matches': currency == expected_currency if expected_currency else True,
        'is_success': payment_status == 'success',
        'tx_ref': tx_ref,
        'amount': amount,
        'currency': currency,
        'reference': extract_reference(payload),
    }


def compute_webhook_signature(raw_payload, webhook_secret):
    if isinstance(raw_payload, str):
        raw_payload = raw_payload.encode('utf-8')
    return hmac.new(
        webhook_secret.encode('utf-8'),
        raw_payload,
        hashlib.sha256,
    ).hexdigest()


def is_valid_webhook_signature(raw_payload, provided_signature, webhook_secret):
    if not provided_signature or not webhook_secret:
        return False
    expected_signature = compute_webhook_signature(raw_payload, webhook_secret)
    return hmac.compare_digest(expected_signature, provided_signature)


def map_attempt_status(paychangu_status):
    normalized_status = (paychangu_status or '').strip().lower()
    if normalized_status == 'success':
        return 'awaiting_verification'
    if normalized_status in ['failed', 'fail']:
        return 'failed'
    if normalized_status in ['cancelled', 'canceled']:
        return 'cancelled'
    if normalized_status == 'expired':
        return 'expired'
    if normalized_status == 'pending':
        return 'pending'
    return 'initiated'
