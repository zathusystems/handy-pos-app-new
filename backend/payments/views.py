import html
import json
import logging
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from django.conf import settings as django_settings
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse, HttpResponseRedirect
from django.urls import reverse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from subscription.models import Deposit, DepositStatus, Subscription
from subscription.serializers import DepositSerializer
from business.access import get_accessible_business_queryset

from .models import PaymentGatewayConfiguration, PaymentWebhookEvent, SubscriptionPaymentAttempt
from .pricing import (
    SUBSCRIPTION_FUNDING_PLANS,
    build_subscription_funding_quote,
    get_effective_custom_payment_minimum,
    serialize_subscription_funding_quote,
    validate_subscription_payment_amount,
)
from .serializers import (
    PaymentGatewayConfigurationAdminSerializer,
    PaymentGatewayConfigurationPublicSerializer,
    PaymentGatewayConfigurationSerializer,
    PaymentWebhookEventSerializer,
    SubscriptionPaymentAttemptSerializer,
)
from .services.paychangu import (
    PAYCHANGU_SIGNATURE_HEADER,
    PayChanguGatewayError,
    evaluate_verification,
    extract_payment_status,
    extract_reference,
    extract_tx_ref,
    initiate_checkout,
    is_valid_webhook_signature,
    map_attempt_status,
    verify_transaction,
)

logger = logging.getLogger(__name__)
ALLOWED_APP_REDIRECT_SCHEMES = {'handypos', 'ulendoapp'}
ACTIVE_ATTEMPT_STATUSES = ['initiated', 'pending', 'awaiting_verification']


class AppSchemeHttpResponseRedirect(HttpResponseRedirect):
    allowed_schemes = HttpResponseRedirect.allowed_schemes + list(ALLOWED_APP_REDIRECT_SCHEMES)


def print_payment_debug(event, request=None, **context):
    debug_payload = {
        'event': event,
        **context,
    }

    if request is not None:
        debug_payload.update({
            'path': getattr(request, 'path', ''),
            'method': getattr(request, 'method', ''),
            'user_id': getattr(getattr(request, 'user', None), 'id', None),
            'is_authenticated': bool(getattr(getattr(request, 'user', None), 'is_authenticated', False)),
        })

    print(f"[PAYMENTS DEBUG] {debug_payload}", flush=True)


def parse_amount(raw_value):
    if raw_value in [None, '']:
        return None
    try:
        return Decimal(str(raw_value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def resolve_credit_bundle_values(pricing_validation):
    if not pricing_validation:
        return '', None

    funding_period = str(pricing_validation.get('funding_period') or '').strip()
    quote = pricing_validation.get('quote') or {}
    credited_amount = quote.get('credit_amount')
    if credited_amount in [None, '']:
        credited_amount = quote.get('base_amount')

    if credited_amount in [None, '']:
        return funding_period, None

    try:
        normalized_credit_amount = Decimal(str(credited_amount))
    except (InvalidOperation, TypeError, ValueError):
        return funding_period, None

    return funding_period, normalized_credit_amount


def is_safe_redirect_url(url):
    if not url:
        return False

    parsed = urlparse(url)
    if not parsed.scheme:
        return False

    blocked_schemes = {'javascript', 'data', 'file'}
    return parsed.scheme.lower() not in blocked_schemes


def is_http_redirect_url(url):
    if not url:
        return False

    return urlparse(url).scheme.lower() in {'http', 'https'}


def is_https_redirect_url(url):
    if not url:
        return False

    return urlparse(url).scheme.lower() == 'https'


def is_allowed_app_redirect_url(url):
    if not is_safe_redirect_url(url):
        return False

    return urlparse(url).scheme.lower() in ALLOWED_APP_REDIRECT_SCHEMES


def render_subscription_redirect_template(url, deposit_id):
    template = str(url or '').strip()
    if not template:
        return ''

    return (
        template
        .replace('{deposit_id}', str(deposit_id))
        .replace('{payment_id}', str(deposit_id))
    )


def build_default_app_redirect_url(deposit_id):
    return f'handypos://subscription-payment/{deposit_id}'


def get_redirect_origin(url):
    parsed = urlparse(str(url or '').strip())
    if parsed.scheme.lower() not in {'http', 'https'} or not parsed.netloc:
        return ''

    return urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))


def get_payment_public_base_url(config=None):
    public_base_url = getattr(django_settings, 'PAYMENT_PUBLIC_BASE_URL', '').strip()
    if public_base_url:
        return public_base_url

    if config is not None:
        for candidate in [getattr(config, 'callback_url', ''), getattr(config, 'return_url', '')]:
            redirect_origin = get_redirect_origin(candidate)
            if redirect_origin:
                return redirect_origin

    return ''


def build_public_absolute_uri(request, path, *, config=None):
    public_base_url = get_payment_public_base_url(config)
    if public_base_url:
        return urljoin(f"{public_base_url.rstrip('/')}/", path.lstrip('/'))

    return request.build_absolute_uri(path)


def build_checkout_redirect_bridge_url(
    request,
    object_id,
    app_redirect_url,
    *,
    target='callback',
    route_name='subscription-checkout-return',
    route_kwarg_name='deposit_id',
    config=None,
):
    path = reverse(route_name, kwargs={route_kwarg_name: object_id})
    if route_name == 'subscription-checkout-return' and path.startswith('/payments/'):
        path = f'/api{path}'
    query_string = urlencode({
        'target': target,
        'app_redirect': app_redirect_url,
    })
    return f'{build_public_absolute_uri(request, path, config=config)}?{query_string}'


def append_redirect_query_params(url, extra_params):
    parsed = urlparse(url)
    query_items = parse_qsl(parsed.query, keep_blank_values=True)
    existing_keys = {key for key, _ in query_items}

    for key, value in extra_params.items():
        if value in [None, ''] or key in existing_keys:
            continue
        query_items.append((key, str(value)))

    return urlunparse(parsed._replace(query=urlencode(query_items)))


def build_subscription_billing_redirect_path(
    deposit_id,
    *,
    tx_ref='',
    status='',
    gateway_return='callback',
):
    query_params = {
        'openAddCredit': '1',
        'gatewayReturn': gateway_return or 'callback',
    }
    if deposit_id:
        query_params['deposit_id'] = deposit_id
    if tx_ref:
        query_params['tx_ref'] = tx_ref
    if status:
        query_params['status'] = status

    return f"/dashboard/settings/billing/?{urlencode(query_params)}"


def render_app_redirect_bridge_page(app_redirect_url, *, billing_redirect_path=''):
    billing_targets = []
    if billing_redirect_path:
        billing_targets = [
            f'http://tauri.localhost{billing_redirect_path}',
            f'tauri://localhost{billing_redirect_path}',
        ]

    title = 'Returning to HandyPOS'
    description = 'Opening HandyPOS...'
    escaped_title = html.escape(title)
    escaped_description = html.escape(description)

    html_content = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escaped_title}</title>
    <style>
      :root {{
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg, #f5f7fb 0%, #e8eefc 100%);
        color: #12223d;
        padding: 24px;
      }}
      .card {{
        width: min(100%, 420px);
        background: rgba(255, 255, 255, 0.98);
        border-radius: 20px;
        box-shadow: 0 18px 60px rgba(0, 35, 90, 0.16);
        padding: 28px 24px;
      }}
      h1 {{
        margin: 0 0 12px;
        font-size: 1.4rem;
      }}
      p {{
        margin: 0;
        line-height: 1.5;
      }}
      .status {{
        margin-top: 18px;
        color: #36507a;
        font-size: 0.95rem;
      }}
      .spinner {{
        width: 42px;
        height: 42px;
        border-radius: 999px;
        border: 4px solid #d9e4fb;
        border-top-color: #1358db;
        margin-bottom: 18px;
        animation: spin 0.9s linear infinite;
      }}
      @keyframes spin {{
        from {{
          transform: rotate(0deg);
        }}
        to {{
          transform: rotate(360deg);
        }}
      }}
    </style>
  </head>
  <body>
    <main class="card">
      <div class="spinner" aria-hidden="true"></div>
      <h1>{escaped_title}</h1>
      <p>{escaped_description}</p>
      <p class="status" data-status>Completing your return to the app...</p>
    </main>
    <script>
      (function () {{
        var appRedirectUrl = {json.dumps(app_redirect_url)};
        var billingTargets = {json.dumps(billing_targets)};
        var userAgent = navigator.userAgent || '';
        var statusNode = document.querySelector('[data-status]');
        var hasNavigatedAway = false;

        function setStatus(message) {{
          if (statusNode) {{
            statusNode.textContent = message;
          }}
        }}

        function isLikelyTauriApp() {{
          return /tauri|wry/i.test(userAgent) || !!window.__TAURI__ || !!window.__TAURI_INTERNALS__;
        }}

        function isLikelyMobileDevice() {{
          return /android|iphone|ipad|ipod/i.test(userAgent);
        }}

        function markNavigatedAway() {{
          hasNavigatedAway = true;
        }}

        function isStillOnBridgePage() {{
          return !hasNavigatedAway && !document.hidden && document.visibilityState !== 'hidden';
        }}

        window.addEventListener('pagehide', markNavigatedAway, {{ once: true }});
        window.addEventListener('beforeunload', markNavigatedAway, {{ once: true }});
        document.addEventListener('visibilitychange', function () {{
          if (document.hidden) {{
            markNavigatedAway();
          }}
        }});

        function tryNavigate(targetUrl) {{
          if (!targetUrl) {{
            return false;
          }}
          try {{
            window.location.replace(targetUrl);
            return true;
          }} catch (_error) {{
            return false;
          }}
        }}

        function tryDeepLink() {{
          if (!appRedirectUrl) {{
            return false;
          }}

          var iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          iframe.src = appRedirectUrl;
          document.body.appendChild(iframe);
          setTimeout(function () {{
            iframe.remove();
          }}, 1500);

          try {{
            var launchLink = document.createElement('a');
            launchLink.href = appRedirectUrl;
            launchLink.rel = 'noopener';
            launchLink.style.display = 'none';
            document.body.appendChild(launchLink);
            launchLink.click();
            launchLink.remove();
          }} catch (_error) {{
            // Ignore and keep trying with the iframe/location strategies.
          }}

          tryNavigate(appRedirectUrl);
          return true;
        }}

        function queueNextAttempt(callback, delayMs) {{
          window.setTimeout(function () {{
            if (!isStillOnBridgePage()) {{
              return;
            }}
            callback();
          }}, delayMs);
        }}

        function tryDeepLinkWithRetry(attemptNumber) {{
          if (!tryDeepLink()) {{
            return;
          }}

          if (attemptNumber >= 1) {{
            return;
          }}

          queueNextAttempt(function () {{
            setStatus('Retrying the HandyPOS app link...');
            tryDeepLinkWithRetry(attemptNumber + 1);
          }}, 900);
        }}

        function buildPreferredBillingTargets() {{
          if (!billingTargets.length) {{
            return [];
          }}

          var mobilePreferred = [billingTargets[0], billingTargets[1]];
          var desktopPreferred = [billingTargets[1], billingTargets[0]];
          var orderedTargets = isLikelyMobileDevice() ? mobilePreferred : desktopPreferred;
          return orderedTargets.filter(function (target, index, collection) {{
            return !!target && collection.indexOf(target) === index;
          }});
        }}

        function tryBillingTargetsSequentially(targets, index) {{
          if (index >= targets.length) {{
            setStatus('Opening HandyPOS...');
            tryDeepLinkWithRetry(0);
            return;
          }}

          setStatus(
            index === 0
              ? 'Returning to billing inside HandyPOS...'
              : 'Retrying the in-app HandyPOS return route...'
          );
          tryNavigate(targets[index]);
          queueNextAttempt(function () {{
            tryBillingTargetsSequentially(targets, index + 1);
          }}, 700);
        }}

        if (isLikelyTauriApp()) {{
          var preferredBillingTargets = buildPreferredBillingTargets();
          if (preferredBillingTargets.length) {{
            tryBillingTargetsSequentially(preferredBillingTargets, 0);
            return;
          }}
        }}

        setStatus('Opening HandyPOS automatically...');
        tryDeepLinkWithRetry(0);
      }})();
    </script>
  </body>
</html>
"""
    return HttpResponse(html_content)


def get_accessible_subscription_queryset(user):
    queryset = Subscription.objects.select_related('business', 'business__owner').order_by('id')
    if getattr(user, 'is_superuser', False):
        return queryset
    return queryset.filter(
        business_id__in=get_accessible_business_queryset(
            user,
            admin_staff_only=True,
        ).values('id')
    )


def resolve_subscription_for_payment(user, business_id=None):
    subscriptions = get_accessible_subscription_queryset(user)
    if business_id:
        subscriptions = subscriptions.filter(business_id=business_id)
    return subscriptions.first()


class SubscriptionFundingPricingView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        business_id = request.query_params.get('business')
        subscription = resolve_subscription_for_payment(request.user, business_id=business_id)
        if subscription is None:
            return Response(
                {'detail': 'No subscription found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        quotes = [
            serialize_subscription_funding_quote(build_subscription_funding_quote(subscription, period))
            for period in SUBSCRIPTION_FUNDING_PLANS.keys()
        ]

        return Response(
            {
                'currency': subscription.get_currency_code(),
                'daily_charge': float(subscription.calculate_daily_charges()),
                'minimum_custom_amount': float(get_effective_custom_payment_minimum(subscription)),
                'quotes': quotes,
            },
            status=status.HTTP_200_OK,
        )


def get_accessible_deposit_queryset(user):
    queryset = Deposit.objects.select_related(
        'subscription',
        'subscription__business',
        'subscription__business__owner',
    )
    if getattr(user, 'is_superuser', False):
        return queryset
    return queryset.filter(
        subscription__business_id__in=get_accessible_business_queryset(
            user,
            admin_staff_only=True,
        ).values('id')
    )


def resolve_deposit_for_payment(user, deposit_reference, *, business_id=None):
    reference = str(deposit_reference or '').strip()
    if not reference:
        return None

    queryset = get_accessible_deposit_queryset(user)
    if business_id:
        queryset = queryset.filter(subscription__business_id=business_id)

    reference_filter = Q(deposit_id=reference)
    if reference.isdigit():
        reference_filter |= Q(pk=int(reference))

    return queryset.filter(reference_filter).order_by('-id').first()


def get_accessible_attempt_queryset(user):
    queryset = SubscriptionPaymentAttempt.objects.select_related(
        'deposit',
        'deposit__subscription',
        'deposit__subscription__business',
        'deposit__subscription__business__owner',
    )
    if getattr(user, 'is_superuser', False):
        return queryset
    return queryset.filter(
        deposit__subscription__business_id__in=get_accessible_business_queryset(
            user,
            admin_staff_only=True,
        ).values('id')
    )


def find_active_subscription_checkout_attempt(subscription):
    if subscription is None:
        return None

    return (
        SubscriptionPaymentAttempt.objects.select_related(
            'deposit',
            'deposit__subscription',
            'deposit__subscription__business',
        )
        .filter(
            deposit__subscription=subscription,
            deposit__status=DepositStatus.PENDING,
            status__in=ACTIVE_ATTEMPT_STATUSES,
        )
        .exclude(checkout_url='')
        .order_by('-created_at')
        .first()
    )


def finalize_verified_subscription_payment(attempt, verification_payload, *, source='manual'):
    verification_result = evaluate_verification(
        verification_payload,
        expected_tx_ref=attempt.tx_ref,
        expected_amount=Decimal(str(attempt.amount)),
        expected_currency=attempt.currency,
    )

    provider_reference = (
        verification_result['reference']
        or verification_result['tx_ref']
        or attempt.tx_ref
    )

    attempt.verification_payload = verification_payload
    attempt.callback_status = verification_result['payment_status'] or attempt.callback_status
    attempt.provider_reference = provider_reference
    attempt.verified_at = timezone.now()

    update_fields = [
        'verification_payload',
        'callback_status',
        'provider_reference',
        'verified_at',
    ]

    if (
        verification_result['is_success']
        and verification_result['tx_ref_matches']
        and verification_result['amount_matches']
        and verification_result['currency_matches']
    ):
        paid_at = (
            parse_datetime(
                verification_payload.get('data', {}).get('authorization', {}).get('completed_at') or ''
            )
            or timezone.now()
        )

        attempt.status = 'successful'
        attempt.paid_at = paid_at
        attempt.last_error = ''
        update_fields.extend(['status', 'paid_at', 'last_error'])

        with transaction.atomic():
            attempt.save(update_fields=update_fields)
            deposit = Deposit.objects.select_for_update().select_related('subscription').get(pk=attempt.deposit_id)
            deposit_update_fields = []

            if deposit.payment_method != 'paychangu':
                deposit.payment_method = 'paychangu'
                deposit_update_fields.append('payment_method')

            if not deposit.transaction_id:
                deposit.transaction_id = provider_reference
                deposit_update_fields.append('transaction_id')

            if not deposit.payment_proof:
                deposit.payment_proof = provider_reference
                deposit_update_fields.append('payment_proof')

            if deposit_update_fields:
                deposit.save(update_fields=deposit_update_fields)

            deposit_status = deposit.status

        if deposit_status == DepositStatus.PENDING:
            if deposit.complete_deposit():
                return True, 'Subscription payment verified successfully and credits added.', verification_result

            deposit.refresh_from_db(fields=['status'])
            if deposit.status == DepositStatus.COMPLETED:
                return True, 'Subscription payment was already completed and credits are available.', verification_result

            attempt.last_error = 'Payment was verified, but credits could not be added automatically.'
            attempt.save(update_fields=['last_error'])
            return False, attempt.last_error, verification_result

        if deposit_status == DepositStatus.COMPLETED:
            return True, 'Subscription payment was already completed and credits are available.', verification_result

        attempt.last_error = (
            f'Payment verified via {source}, but the deposit is no longer pending '
            f'(current status: {deposit_status}).'
        )
        attempt.save(update_fields=['last_error'])
        return False, attempt.last_error, verification_result

    attempt.status = map_attempt_status(verification_result['payment_status']) or 'failed'
    mismatch_reasons = []
    if not verification_result['is_success']:
        mismatch_reasons.append(
            f"PayChangu reports payment status '{verification_result['payment_status'] or 'unknown'}'."
        )
    if not verification_result['tx_ref_matches']:
        mismatch_reasons.append('Verified transaction reference did not match the subscription payment session.')
    if not verification_result['amount_matches']:
        mismatch_reasons.append('Verified amount was lower than the requested credit amount.')
    if not verification_result['currency_matches']:
        mismatch_reasons.append('Verified currency did not match the subscription currency.')

    attempt.last_error = ' '.join(mismatch_reasons).strip() or 'Payment is not confirmed yet.'
    update_fields.extend(['status', 'last_error'])
    attempt.save(update_fields=update_fields)
    return False, attempt.last_error, verification_result


class PaymentGatewayConfigurationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        config = PaymentGatewayConfiguration.get_settings()
        serializer_class = (
            PaymentGatewayConfigurationAdminSerializer
            if request.user.is_staff
            else PaymentGatewayConfigurationPublicSerializer
        )
        return Response(serializer_class(config).data)

    def patch(self, request):
        if not request.user.is_staff:
            return Response(
                {'detail': 'Only system administrators can update payment gateway settings.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        config = PaymentGatewayConfiguration.get_settings()
        serializer = PaymentGatewayConfigurationSerializer(config, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated_config = serializer.save()
        return Response(PaymentGatewayConfigurationAdminSerializer(updated_config).data)

    def put(self, request):
        return self.patch(request)


class SubscriptionPaymentAttemptListView(APIView):
    permission_classes = [IsAuthenticated]

    def get_queryset(self, request):
        return get_accessible_attempt_queryset(request.user)

    def get(self, request):
        queryset = self.get_queryset(request)

        deposit_reference = request.query_params.get('deposit_id') or request.query_params.get('deposit')
        tx_ref = request.query_params.get('tx_ref')

        if deposit_reference:
            deposit = resolve_deposit_for_payment(request.user, deposit_reference)
            if deposit is None:
                queryset = queryset.none()
            else:
                queryset = queryset.filter(deposit=deposit)
        if tx_ref:
            queryset = queryset.filter(tx_ref=tx_ref)

        serializer = SubscriptionPaymentAttemptSerializer(queryset, many=True)
        return Response(serializer.data)


class SubscriptionPaymentAttemptDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get_queryset(self, request):
        return SubscriptionPaymentAttemptListView().get_queryset(request)

    def get(self, request, pk):
        attempt = self.get_queryset(request).filter(pk=pk).first()
        if attempt is None:
            return Response({'detail': 'Payment attempt not found.'}, status=status.HTTP_404_NOT_FOUND)

        serializer = SubscriptionPaymentAttemptSerializer(attempt)
        return Response(serializer.data)


class StartSubscriptionCheckoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        business_id = request.data.get('business') or request.query_params.get('business')
        deposit_reference = request.data.get('deposit_id')
        amount = parse_amount(request.data.get('amount'))
        funding_period = request.data.get('funding_period')
        requested_funding_period = str(funding_period or '').strip()

        print_payment_debug(
            'subscription_checkout_start_received',
            request,
            business_id=business_id,
            deposit_id=deposit_reference,
            amount=str(amount) if amount is not None else None,
            funding_period=funding_period,
            app_callback_url=request.data.get('app_callback_url'),
            app_return_url=request.data.get('app_return_url'),
        )

        deposit = None
        subscription = None
        pricing_validation = None
        if deposit_reference:
            deposit = resolve_deposit_for_payment(request.user, deposit_reference, business_id=business_id)
            if deposit is None:
                return Response({'detail': 'Deposit not found.'}, status=status.HTTP_404_NOT_FOUND)
            subscription = deposit.subscription
            pricing_validation = validate_subscription_payment_amount(
                subscription,
                deposit.amount,
                funding_period=funding_period,
            )
        else:
            if amount is None or amount <= 0:
                return Response({'detail': 'A valid amount greater than 0 is required.'}, status=status.HTTP_400_BAD_REQUEST)

            subscription = resolve_subscription_for_payment(request.user, business_id)
            if subscription is None:
                return Response({'detail': 'No subscription found.'}, status=status.HTTP_404_NOT_FOUND)
            pricing_validation = validate_subscription_payment_amount(
                subscription,
                amount,
                funding_period=funding_period,
            )

        config = PaymentGatewayConfiguration.get_settings()
        if not config.is_active:
            return Response(
                {'detail': 'Subscription gateway payment is not enabled right now.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not config.secret_key:
            return Response(
                {'detail': 'Payment gateway secret key is not configured yet.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        existing_active_attempt = find_active_subscription_checkout_attempt(subscription)
        if existing_active_attempt is not None:
            return Response(
                {
                    'detail': 'A subscription checkout is already in progress. Resume or verify that payment first.',
                    'attempt': SubscriptionPaymentAttemptSerializer(existing_active_attempt).data,
                    'deposit': DepositSerializer(existing_active_attempt.deposit).data,
                    'checkout_url': existing_active_attempt.checkout_url,
                    'tx_ref': existing_active_attempt.tx_ref,
                },
                status=status.HTTP_200_OK,
            )

        if pricing_validation and not pricing_validation['is_valid']:
            error_payload = {'detail': pricing_validation['detail']}
            if pricing_validation['quote']:
                error_payload['pricing'] = serialize_subscription_funding_quote(pricing_validation['quote'])
            return Response(error_payload, status=status.HTTP_400_BAD_REQUEST)

        if deposit is None:
            funding_period_value, credited_amount = resolve_credit_bundle_values(pricing_validation)
            deposit = Deposit.objects.create(
                subscription=subscription,
                amount=pricing_validation['normalized_amount'] if pricing_validation else amount,
                credited_amount=credited_amount,
                funding_period=funding_period_value,
                payment_method='paychangu',
                payment_proof='',
            )
        elif deposit.status == DepositStatus.COMPLETED:
            return Response(
                {
                    'detail': 'This deposit has already been completed.',
                    'deposit': DepositSerializer(deposit).data,
                },
                status=status.HTTP_200_OK,
            )
        elif deposit.status != DepositStatus.PENDING:
            return Response(
                {'detail': f'Cannot start gateway checkout for a deposit with status {deposit.status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        elif deposit.transaction_id and deposit.payment_method != 'paychangu':
            return Response(
                {'detail': 'This deposit already has a manual transaction reference and cannot be sent to the gateway.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        elif deposit.payment_method != 'paychangu':
            deposit.payment_method = 'paychangu'
            deposit.save(update_fields=['payment_method', 'updated_at'])

        if requested_funding_period:
            funding_period_value, credited_amount = resolve_credit_bundle_values(pricing_validation)
            deposit_update_fields = []
            if deposit.funding_period != funding_period_value:
                deposit.funding_period = funding_period_value
                deposit_update_fields.append('funding_period')
            if deposit.credited_amount != credited_amount:
                deposit.credited_amount = credited_amount
                deposit_update_fields.append('credited_amount')
            if deposit_update_fields:
                deposit.save(update_fields=[*deposit_update_fields, 'updated_at'])

        requested_callback_url = (
            request.data.get('app_callback_url')
            or request.data.get('callback_url')
            or config.callback_url
            or build_default_app_redirect_url(deposit.deposit_id)
        )
        requested_return_url = (
            request.data.get('app_return_url')
            or request.data.get('return_url')
            or config.return_url
            or requested_callback_url
        )

        if not is_safe_redirect_url(requested_callback_url) or not is_safe_redirect_url(requested_return_url):
            return Response(
                {'detail': 'Provided callback or return URL is not allowed.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        resolved_callback_target = render_subscription_redirect_template(requested_callback_url, deposit.deposit_id)
        resolved_return_target = render_subscription_redirect_template(requested_return_url, deposit.deposit_id)

        callback_url = (
            resolved_callback_target
            if is_http_redirect_url(resolved_callback_target)
            else build_checkout_redirect_bridge_url(
                request,
                deposit.deposit_id,
                resolved_callback_target,
                target='callback',
                config=config,
            )
        )
        return_url = (
            resolved_return_target
            if is_http_redirect_url(resolved_return_target)
            else build_checkout_redirect_bridge_url(
                request,
                deposit.deposit_id,
                resolved_return_target,
                target='return',
                config=config,
            )
        )

        if not is_http_redirect_url(callback_url) or not is_http_redirect_url(return_url):
            return Response(
                {'detail': 'PayChangu checkout requires valid HTTP or HTTPS callback URLs.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if config.environment == 'live' and (
            not is_https_redirect_url(callback_url) or not is_https_redirect_url(return_url)
        ):
            return Response(
                {
                    'detail': (
                        'Live PayChangu checkout requires public HTTPS callback and return URLs. '
                        'Set PAYMENT_PUBLIC_BASE_URL to your production API domain and retry.'
                    ),
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        active_attempt = deposit.payment_attempts.filter(
            status__in=ACTIVE_ATTEMPT_STATUSES
        ).order_by('-created_at').first()
        if active_attempt and active_attempt.checkout_url:
            return Response(
                {
                    'detail': 'An active subscription checkout session already exists.',
                    'attempt': SubscriptionPaymentAttemptSerializer(active_attempt).data,
                    'deposit': DepositSerializer(deposit).data,
                    'checkout_url': active_attempt.checkout_url,
                    'tx_ref': active_attempt.tx_ref,
                },
                status=status.HTTP_200_OK,
            )

        try:
            checkout_meta = {'initiated_by_user_id': request.user.id}
            if pricing_validation and pricing_validation.get('funding_period'):
                quote = pricing_validation.get('quote') or {}
                checkout_meta.update({
                    'funding_period': pricing_validation['funding_period'],
                    'pricing_days': quote.get('days'),
                    'pricing_discount_rate': str(quote.get('discount_rate', '0')),
                    'pricing_base_amount': str(quote.get('base_amount', deposit.amount)),
                    'pricing_discount_amount': str(quote.get('discount_amount', '0')),
                    'pricing_final_amount': str(quote.get('final_amount', deposit.amount)),
                    'pricing_minimum_custom_amount': str(quote.get('minimum_custom_amount', deposit.amount)),
                })
            checkout_result = initiate_checkout(
                deposit,
                config,
                callback_url=callback_url,
                return_url=return_url,
                extra_meta=checkout_meta,
            )
        except PayChanguGatewayError as exc:
            logger.exception('[PAYMENTS] Failed to initiate PayChangu checkout for deposit %s', deposit.deposit_id)
            return Response(
                {
                    'detail': str(exc),
                    'provider_response': exc.payload,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        attempt = SubscriptionPaymentAttempt.objects.create(
            provider=config.provider,
            deposit=deposit,
            initiated_by=request.user,
            tx_ref=checkout_result['tx_ref'],
            checkout_url=checkout_result['checkout_url'],
            amount=Decimal(str(deposit.amount)),
            currency=deposit.subscription.get_currency_code() or config.default_currency,
            status='pending',
            callback_status=checkout_result.get('callback_status', ''),
            request_payload=checkout_result['request_payload'],
            response_payload=checkout_result['response_payload'],
        )

        return Response(
            {
                'detail': 'Subscription checkout started successfully.',
                'attempt': SubscriptionPaymentAttemptSerializer(attempt).data,
                'deposit': DepositSerializer(deposit).data,
                'checkout_url': attempt.checkout_url,
                'tx_ref': attempt.tx_ref,
                'provider': config.provider,
                'pricing': (
                    serialize_subscription_funding_quote(pricing_validation['quote'])
                    if pricing_validation and pricing_validation.get('quote')
                    else None
                ),
            },
            status=status.HTTP_201_CREATED,
        )


class VerifySubscriptionCheckoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        attempt_id = request.data.get('attempt_id')
        tx_ref = request.data.get('tx_ref')
        deposit_reference = request.data.get('deposit_id')

        print_payment_debug(
            'subscription_checkout_verify_received',
            request,
            attempt_id=attempt_id,
            tx_ref=tx_ref,
            deposit_id=deposit_reference,
        )

        if not any([attempt_id, tx_ref, deposit_reference]):
            return Response(
                {'detail': 'attempt_id, tx_ref, or deposit_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        queryset = get_accessible_attempt_queryset(request.user)
        attempt = None
        if attempt_id:
            attempt = queryset.filter(pk=attempt_id).first()
        elif tx_ref:
            attempt = queryset.filter(tx_ref=tx_ref).order_by('-created_at').first()
        elif deposit_reference:
            deposit = resolve_deposit_for_payment(request.user, deposit_reference)
            if deposit is not None:
                attempt = queryset.filter(deposit=deposit).order_by('-created_at').first()

        if attempt is None:
            if deposit_reference:
                deposit = resolve_deposit_for_payment(request.user, deposit_reference)
                if deposit is not None:
                    return Response(
                        {'detail': 'No subscription checkout session exists for this deposit yet. Start payment first.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            return Response({'detail': 'Subscription payment attempt not found.'}, status=status.HTTP_404_NOT_FOUND)

        deposit = attempt.deposit
        if attempt.status == 'successful' and deposit.status == DepositStatus.COMPLETED:
            return Response(
                {
                    'detail': 'Subscription payment is already verified.',
                    'verified': True,
                    'attempt': SubscriptionPaymentAttemptSerializer(attempt).data,
                    'deposit': DepositSerializer(deposit).data,
                },
                status=status.HTTP_200_OK,
            )

        if deposit.status not in {DepositStatus.PENDING, DepositStatus.COMPLETED}:
            return Response(
                {'detail': f'Cannot verify payment for a deposit with status {deposit.status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        config = PaymentGatewayConfiguration.get_settings()
        if not config.secret_key:
            return Response(
                {'detail': 'Payment gateway secret key is not configured yet.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            verification_payload = verify_transaction(attempt.tx_ref, config)
        except PayChanguGatewayError as exc:
            logger.exception('[PAYMENTS] Failed to verify PayChangu transaction %s', attempt.tx_ref)
            attempt.last_error = str(exc)
            attempt.save(update_fields=['last_error'])
            return Response(
                {
                    'detail': str(exc),
                    'provider_response': exc.payload,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        verified, detail_message, _verification_result = finalize_verified_subscription_payment(
            attempt,
            verification_payload,
            source='frontend_verification',
        )
        refreshed_attempt = get_accessible_attempt_queryset(request.user).get(pk=attempt.pk)
        refreshed_attempt.deposit.refresh_from_db()

        response_status = status.HTTP_200_OK if verified else status.HTTP_202_ACCEPTED
        return Response(
            {
                'detail': detail_message,
                'verified': verified,
                'attempt': SubscriptionPaymentAttemptSerializer(refreshed_attempt).data,
                'deposit': DepositSerializer(refreshed_attempt.deposit).data,
                'provider_status': extract_payment_status(verification_payload),
                'provider_reference': extract_reference(verification_payload),
            },
            status=response_status,
        )


class SubscriptionCheckoutReturnView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, deposit_id):
        config = PaymentGatewayConfiguration.get_settings()
        target = (request.query_params.get('target') or 'callback').strip().lower()
        fallback_redirect_url = (
            config.return_url if target == 'return' and config.return_url else config.callback_url
        )
        requested_app_redirect = request.query_params.get('app_redirect') or fallback_redirect_url

        app_redirect_url = render_subscription_redirect_template(requested_app_redirect, deposit_id)
        if not is_allowed_app_redirect_url(app_redirect_url):
            app_redirect_url = build_default_app_redirect_url(deposit_id)

        redirect_url = append_redirect_query_params(
            app_redirect_url,
            {
                'deposit_id': deposit_id,
                'tx_ref': request.query_params.get('tx_ref') or request.query_params.get('reference'),
                'status': request.query_params.get('status'),
                'gatewayReturn': target,
            },
        )
        billing_redirect_path = build_subscription_billing_redirect_path(
            deposit_id,
            tx_ref=request.query_params.get('tx_ref') or request.query_params.get('reference') or '',
            status=request.query_params.get('status') or '',
            gateway_return=target,
        )
        return render_app_redirect_bridge_page(
            redirect_url,
            billing_redirect_path=billing_redirect_path,
        )


class PaymentWebhookEventListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not request.user.is_staff:
            return Response(
                {'detail': 'Only system administrators can view payment webhook events.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        queryset = PaymentWebhookEvent.objects.select_related('related_attempt')
        serializer = PaymentWebhookEventSerializer(queryset, many=True)
        return Response(serializer.data)


class PayChanguWebhookView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        config = PaymentGatewayConfiguration.get_settings()
        raw_payload = request.body.decode('utf-8')
        payload = request.data if isinstance(request.data, dict) else {}
        signature = request.headers.get(PAYCHANGU_SIGNATURE_HEADER, '')
        tx_ref = extract_tx_ref(payload)
        event_type = payload.get('event_type') or payload.get('event') or ''

        attempt = SubscriptionPaymentAttempt.objects.filter(tx_ref=tx_ref).first()

        event = PaymentWebhookEvent.objects.create(
            provider='paychangu',
            related_attempt=attempt,
            signature=signature,
            event_type=event_type,
            tx_ref=tx_ref,
            payload=payload,
        )

        if not config.webhook_secret:
            event.processed = True
            event.processing_notes = 'Webhook secret is not configured yet.'
            event.processed_at = timezone.now()
            event.save(update_fields=['processed', 'processing_notes', 'processed_at'])
            logger.warning('[PAYMENTS] PayChangu webhook received before webhook secret was configured.')
            return Response({'detail': 'webhook recorded'}, status=status.HTTP_200_OK)

        is_valid_signature = is_valid_webhook_signature(raw_payload, signature, config.webhook_secret)
        event.is_valid_signature = is_valid_signature

        if attempt is not None and is_valid_signature:
            attempt.webhook_payload = payload
            update_fields = ['webhook_payload']

            callback_status = extract_payment_status(payload)
            if callback_status:
                attempt.callback_status = callback_status
                update_fields.append('callback_status')

                mapped_status = map_attempt_status(callback_status)
                if attempt.status != mapped_status:
                    attempt.status = mapped_status
                    update_fields.append('status')

            attempt.save(update_fields=update_fields)

        event.processed = True
        if is_valid_signature:
            if attempt is not None and (extract_payment_status(payload) or '').strip().lower() == 'success':
                try:
                    verification_payload = verify_transaction(attempt.tx_ref, config)
                    _verified, detail_message, _verification_result = finalize_verified_subscription_payment(
                        attempt,
                        verification_payload,
                        source='webhook',
                    )
                    event.processing_notes = detail_message
                except PayChanguGatewayError as exc:
                    event.processing_notes = str(exc)
            else:
                event.processing_notes = 'Webhook accepted and recorded.'
        else:
            event.processing_notes = 'Invalid PayChangu webhook signature.'
        event.processed_at = timezone.now()
        event.save(
            update_fields=[
                'is_valid_signature',
                'processed',
                'processing_notes',
                'processed_at',
            ]
        )

        return Response({'detail': 'webhook recorded'}, status=status.HTTP_200_OK)
