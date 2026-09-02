"""
MRA EIS services.

This module keeps the app fully integrated with the official MRA EIS contract
while supporting a safe dry-run mode for rollout.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import base64
import uuid
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

import requests
from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.utils import IntegrityError
from django.db.models import Max, Sum
from django.utils.dateparse import parse_datetime
from django.utils import timezone

from .models import (
    ConfigurationSyncLog,
    FiscalInvoiceSequence,
    InvoiceAuditLog,
    MRAAPIError,
    MRAConfiguration,
    MRAInvoice,
    MRAProductMapping,
    OfflineAuditLog,
    OfflineInvoiceQueue,
    Receipt,
    SyncRetryQueue,
    Terminal,
    TerminalActivationCode,
    TerminalAuditLog,
)

logger = logging.getLogger(__name__)


class MRAIntegrationError(Exception):
    """Raised when MRA integration operations fail."""

    retryable = True

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        endpoint: str = '',
        endpoint_key: str = '',
        response_data: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
        self.endpoint_key = endpoint_key
        self.response_data = response_data or {}


class MRAResponseError(MRAIntegrationError):
    """Raised when MRA responds successfully but rejects the request."""

    retryable = False

    def __init__(self, message: str, *, endpoint_key: str = '', response_data: dict[str, Any] | None = None):
        super().__init__(message, endpoint_key=endpoint_key, response_data=response_data)


def _extract_mra_response_errors(response_data: Any) -> list[str]:
    """Extract validation errors returned in a successful HTTP response."""
    if not isinstance(response_data, dict):
        return []

    errors: list[str] = []
    raw_status = response_data.get('statusCode', response_data.get('status_code'))
    raw_http_status = response_data.get('httpStatusCode', response_data.get('http_status_code'))
    status_failed = False
    try:
        status_failed = int(raw_status) < 0
    except (TypeError, ValueError):
        status_failed = str(raw_status or response_data.get('status') or '').strip().lower() in {
            'error', 'failed', 'failure', 'rejected'
        }
    try:
        status_failed = status_failed or int(raw_http_status) >= 400
    except (TypeError, ValueError):
        pass

    def add_error(value: Any) -> None:
        if value in (None, ''):
            return
        if isinstance(value, dict):
            value = value.get('errorMessage') or value.get('message') or value.get('remark') or value
        errors.append(str(value))

    raw_errors = response_data.get('errors')
    if isinstance(raw_errors, list):
        for error in raw_errors:
            add_error(error)
    else:
        add_error(raw_errors)

    add_error(response_data.get('error'))
    add_error(response_data.get('errorMessage') or response_data.get('error_message'))
    if status_failed:
        add_error(
            response_data.get('remark')
            or response_data.get('message')
            or response_data.get('statusDescription')
            or response_data.get('status_description')
        )

    data = response_data.get('data') if isinstance(response_data.get('data'), dict) else {}
    validation_errors = data.get('validationErrors') or data.get('validation_errors')
    if isinstance(validation_errors, list):
        for error in validation_errors:
            add_error(error)
    else:
        add_error(validation_errors)

    return errors


def _raise_for_mra_response(
    endpoint_key: str,
    response_data: Any,
    *,
    ok: bool = True,
) -> None:
    """Turn an MRA business rejection into a non-retryable integration error."""
    response_errors = _extract_mra_response_errors(response_data)
    if ok and not response_errors:
        return

    detail = '; '.join(response_errors) or 'MRA did not accept the request.'
    raise MRAResponseError(
        f'MRA rejected {endpoint_key}: {detail}',
        endpoint_key=endpoint_key,
        response_data=response_data if isinstance(response_data, dict) else {},
    )


def is_business_eis_enabled(business) -> bool:
    """Return the persisted per-business EIS opt-in state.

    Missing settings are intentionally treated as disabled. This keeps older
    businesses and normal POS activity outside the EIS pipeline until an owner
    explicitly enables it.
    """
    if business is None:
        return False

    try:
        return bool(getattr(business.settings, 'enable_eis', False))
    except ObjectDoesNotExist:
        return False


def ensure_business_eis_enabled(business):
    """Stop an EIS-only operation when the business has not opted in."""
    if not is_business_eis_enabled(business):
        raise MRAIntegrationError(
            'MRA EIS is not enabled for this business. Enable it in Settings before using EIS features.'
        )


@dataclass
class MRACallResult:
    ok: bool
    dry_run: bool
    status_code: int
    endpoint: str
    data: dict[str, Any]
    headers: dict[str, str] | None = None


@dataclass
class OfflineLimitPolicy:
    max_transaction_age_hours: int | None = None
    max_cumulative_amount: Decimal | None = None
    source: str | None = None


class MRAEISClient:
    """Thin HTTP/signing wrapper around official MRA EIS endpoints."""

    def __init__(self, terminal: Terminal | None = None):
        self.terminal = terminal
        self.base_url = settings.MRA_EIS_BASE_URL.rstrip('/')
        self.timeout = settings.MRA_EIS_TIMEOUT_SECONDS
        self.verify_ssl = bool(getattr(settings, 'MRA_EIS_VERIFY_SSL', True))
        self.endpoints: dict[str, str] = settings.MRA_EIS_ENDPOINTS

    @property
    def http_enabled(self) -> bool:
        return bool(getattr(settings, 'MRA_EIS_ENABLE_HTTP_CALLS', False))

    @property
    def dry_run(self) -> bool:
        return bool(getattr(settings, 'MRA_EIS_DRY_RUN', True))

    @property
    def allow_live_submission(self) -> bool:
        return bool(getattr(settings, 'MRA_EIS_ALLOW_LIVE_SUBMISSION', False))

    def _resolve_endpoint(self, key: str) -> str:
        path = self.endpoints.get(key)
        if not path:
            raise MRAIntegrationError(f"MRA endpoint '{key}' is not configured")
        path = path if path.startswith('/') else f'/{path}'
        return f"{self.base_url}{path}"

    @staticmethod
    def _canonical_json(payload: dict[str, Any] | None) -> str:
        if payload is None:
            return '{}'
        return json.dumps(payload, separators=(',', ':'), sort_keys=True, default=str)

    @staticmethod
    def _compact_json(payload: dict[str, Any] | None) -> str:
        if payload is None:
            return '{}'
        return json.dumps(payload, separators=(',', ':'), sort_keys=False, default=str)

    @staticmethod
    def _raw_json(payload: dict[str, Any] | None) -> str:
        if payload is None:
            return '{}'
        return json.dumps(payload, sort_keys=False, default=str)

    @staticmethod
    def _sha256_text(value: str) -> str:
        return hashlib.sha256(value.encode('utf-8')).hexdigest()

    @staticmethod
    def _hmac_sha512_base64(message: str, secret: str) -> str:
        if not message or not secret:
            return ''
        digest = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha512).digest()
        return base64.b64encode(digest).decode('utf-8')

    def _terminal_secret(self) -> str:
        return str(
            getattr(self.terminal, 'mra_api_key', '') or getattr(settings, 'MRA_EIS_SECRET_KEY', '') or ''
        ).strip()

    @staticmethod
    def _authorization_header_value(token: Any) -> str:
        token_value = str(token or '').strip()
        if token_value.lower().startswith('authorization:'):
            token_value = token_value.split(':', 1)[1].strip()
        while token_value.lower().startswith('bearer '):
            token_value = token_value.split(' ', 1)[1].strip()
        return f'Bearer {token_value}' if token_value else ''

    @staticmethod
    def _requires_message_hash(endpoint_key: str) -> bool:
        return endpoint_key not in {'activate_terminal', 'confirm_terminal'}

    def _validate_security_requirements(
        self,
        endpoint_key: str,
        *,
        x_signature_text: str | None = None,
    ) -> None:
        """Fail closed for missing credentials on real MRA calls."""
        if not getattr(settings, 'MRA_EIS_IS_LIVE', False) or endpoint_key == 'activate_terminal':
            return

        if endpoint_key == 'confirm_terminal' and not x_signature_text:
            raise MRAIntegrationError(
                "MRA activation confirmation requires x-signature text from the TAC.",
                endpoint_key=endpoint_key,
            )

        token = self._authorization_header_value(
            getattr(self.terminal, 'mra_token', '') if self.terminal else ''
        )
        if not token:
            raise MRAIntegrationError(
                f"MRA endpoint '{endpoint_key}' requires a terminal Bearer authorization token.",
                endpoint_key=endpoint_key,
            )

        if endpoint_key == 'confirm_terminal' or self._requires_message_hash(endpoint_key):
            if not self._terminal_secret():
                raise MRAIntegrationError(
                    f"MRA endpoint '{endpoint_key}' requires the terminal secret key.",
                    endpoint_key=endpoint_key,
                )

    def _message_hash_input(self, payload: dict[str, Any] | None) -> tuple[str, str]:
        mode = str(getattr(settings, 'MRA_EIS_MESSAGE_HASH_INPUT_MODE', 'canonical_json') or '').lower()
        if mode == 'compact_json':
            return self._compact_json(payload), mode
        if mode == 'raw_json':
            return self._raw_json(payload), mode
        return self._canonical_json(payload), 'canonical_json'

    def _build_message_hash(self, payload: dict[str, Any] | None) -> str:
        message, _source = self._message_hash_input(payload)
        return self._hmac_sha512_base64(message, self._terminal_secret())

    def _json_request_body(self, payload: dict[str, Any] | None) -> str:
        message, _source = self._message_hash_input(payload)
        return message

    def _build_signature(self, payload: dict[str, Any] | None) -> str:
        secret = (getattr(settings, 'MRA_EIS_SECRET_KEY', '') or '').encode('utf-8')
        if not secret:
            return ''
        message = self._canonical_json(payload).encode('utf-8')
        return hmac.new(secret, message, hashlib.sha256).hexdigest()

    def _build_headers(self, endpoint_key: str, payload: dict[str, Any] | None) -> dict[str, str]:
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/plain',
        }

        # MRA's initial activation request is TAC-based and unauthenticated.
        # The live contract uses the terminal Bearer token and the official
        # HMAC message hash. Keep legacy gateway headers only for test/legacy
        # deployments so they cannot alter the certified live request shape.
        if endpoint_key != 'activate_terminal':
            if not getattr(settings, 'MRA_EIS_IS_LIVE', False):
                access_key = getattr(settings, 'MRA_EIS_ACCESS_KEY', '') or ''
                if access_key:
                    headers['x-access-key'] = access_key

                signature = self._build_signature(payload)
                if signature:
                    headers['x-signature'] = signature

            if endpoint_key != 'confirm_terminal':
                message_hash = self._build_message_hash(payload)
                if message_hash:
                    headers['x-eis-message-hash'] = message_hash

        if endpoint_key != 'activate_terminal' and self.terminal:
            authorization = self._authorization_header_value(self.terminal.mra_token)
            if authorization:
                headers['Authorization'] = authorization

        return headers

    @staticmethod
    def _normalize_response_data(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if value in (None, ''):
            return {}
        return {'raw': value}

    @staticmethod
    def _payload_shape(value: Any) -> Any:
        if isinstance(value, dict):
            return {str(key): MRAEISClient._payload_shape(child) for key, child in value.items()}
        if isinstance(value, list):
            return f'list[{len(value)}]'
        return type(value).__name__

    def _record_hash_evidence(
        self,
        endpoint_key: str,
        endpoint: str,
        payload: dict[str, Any] | None,
        headers: dict[str, str],
        *,
        method: str = 'POST',
        status_code: int | None = None,
        ok: bool | None = None,
        error: str = '',
    ) -> None:
        if not self.terminal or not getattr(self.terminal, 'pk', None):
            return
        if not bool(getattr(settings, 'MRA_EIS_RECORD_MESSAGE_HASH_EVIDENCE', True)):
            return
        message, mode = self._message_hash_input(payload)
        details: dict[str, Any] = {
            'source': 'mra_request_signature',
            'endpoint_key': endpoint_key,
            'endpoint': endpoint,
            'method': str(method or 'POST').upper(),
            'hash_algorithm': 'HMAC-SHA512',
            'hash_encoding': 'base64',
            'hash_input_mode': mode,
            'hash_input_sha256': self._sha256_text(message),
            'hash_input_length': len(message),
            'payload_sha256': self._sha256_text(self._canonical_json(payload)),
            'payload_shape': self._payload_shape(payload or {}),
            'x_eis_message_hash_present': bool(headers.get('x-eis-message-hash')),
            'x_signature_present': bool(headers.get('x-signature')),
        }
        if status_code is not None:
            details['status_code'] = status_code
        if ok is not None:
            details['ok'] = bool(ok)
        if error:
            details['error'] = str(error)[:1000]
        if bool(getattr(settings, 'MRA_EIS_LOG_MESSAGE_HASH_INPUT', False)):
            details['hash_input_text'] = message
        try:
            TerminalAuditLog.objects.create(terminal=self.terminal, action='mra_request_signed', details=details)
        except Exception:
            logger.debug('Could not persist MRA signing evidence', exc_info=True)

    def _dry_run_result(
        self,
        endpoint_key: str,
        payload: dict[str, Any] | None,
        *,
        reason: str,
    ) -> MRACallResult:
        endpoint = self._resolve_endpoint(endpoint_key)
        return MRACallResult(
            ok=True,
            dry_run=True,
            status_code=202,
            endpoint=endpoint,
            data={
                'status': 'prepared',
                'reason': reason,
                'endpoint_key': endpoint_key,
                'payload': payload or {},
                'prepared_at': timezone.now().isoformat(),
            },
            headers={},
        )

    def call(
        self,
        endpoint_key: str,
        payload: dict[str, Any] | None = None,
        *,
        method: str = 'POST',
        mutating: bool = True,
        x_signature_text: str | None = None,
        params: dict[str, Any] | None = None,
        send_json: bool = True,
        record_connectivity: bool = True,
    ) -> MRACallResult:
        """
        Execute a request against MRA EIS.

        Mutating calls are guarded by dry-run + live-submission flags.
        """
        if not self.http_enabled:
            return self._dry_run_result(endpoint_key, payload, reason='http_calls_disabled')

        if self.dry_run:
            return self._dry_run_result(endpoint_key, payload, reason='dry_run_enabled')

        if mutating and not self.allow_live_submission:
            return self._dry_run_result(endpoint_key, payload, reason='live_submission_disabled')

        endpoint = self._resolve_endpoint(endpoint_key)
        self._validate_security_requirements(endpoint_key, x_signature_text=x_signature_text)
        headers = self._build_headers(endpoint_key, payload)
        if x_signature_text:
            signature = self._hmac_sha512_base64(x_signature_text, self._terminal_secret())
            if signature:
                headers['x-signature'] = signature

        method_name = method.upper()
        request_body = None
        if method_name not in {'GET', 'HEAD'} and (send_json or payload is not None):
            request_body = self._json_request_body(payload or {})
        request_kwargs: dict[str, Any] = {
            'method': method_name,
            'url': endpoint,
            'headers': headers,
            'timeout': self.timeout,
            'verify': self.verify_ssl,
        }
        if params:
            request_kwargs['params'] = params
        if request_body is not None:
            request_kwargs['data'] = request_body

        try:
            response = requests.request(**request_kwargs)
            if record_connectivity and self.terminal:
                self.terminal.is_online = True
                self.terminal.last_sync_at = timezone.now()
                self.terminal.save(update_fields=['is_online', 'last_sync_at', 'updated_at'])
            response_data: dict[str, Any] = {}
            if response.content:
                try:
                    response_data = self._normalize_response_data(response.json())
                except ValueError:
                    # Some MRA endpoints return a plain-text body even when
                    # the request succeeded. Preserve it for audit/diagnostics.
                    response_data = {'raw': response.text}

            if not response.ok:
                self._record_hash_evidence(
                    endpoint_key,
                    endpoint,
                    payload,
                    headers,
                    method=method_name,
                    status_code=response.status_code,
                    ok=False,
                )
                raise MRAIntegrationError(
                    f'MRA request failed ({endpoint_key}): {response.status_code} {response.reason}'.strip(),
                    status_code=response.status_code,
                    endpoint=endpoint,
                    endpoint_key=endpoint_key,
                    response_data=response_data,
                )

            self._record_hash_evidence(
                endpoint_key,
                endpoint,
                payload,
                headers,
                method=method_name,
                status_code=response.status_code,
                ok=True,
            )
            _raise_for_mra_response(endpoint_key, response_data)

            raw_headers = getattr(response, 'headers', {}) or {}
            response_headers = (
                {str(key): str(value) for key, value in raw_headers.items()}
                if hasattr(raw_headers, 'items')
                else {}
            )
            return MRACallResult(
                ok=True,
                dry_run=False,
                status_code=response.status_code,
                endpoint=endpoint,
                data=response_data,
                headers=response_headers,
            )
        except requests.RequestException as exc:
            if record_connectivity and self.terminal:
                try:
                    self.terminal.is_online = False
                    self.terminal.save(update_fields=['is_online', 'updated_at'])
                except Exception:
                    pass
            self._record_hash_evidence(
                endpoint_key,
                endpoint,
                payload,
                headers,
                method=method_name,
                ok=False,
                error=str(exc),
            )
            raise MRAIntegrationError(
                f"MRA request failed ({endpoint_key}): {exc}",
                endpoint=endpoint,
                endpoint_key=endpoint_key,
            ) from exc


class TerminalService:
    """Terminal management and onboarding."""

    @staticmethod
    def normalize_device_serial(value: Any) -> str:
        return str(value or '').strip()

    @staticmethod
    def device_serials_match(left: Any, right: Any) -> bool:
        left_serial = TerminalService.normalize_device_serial(left)
        right_serial = TerminalService.normalize_device_serial(right)
        return bool(left_serial and right_serial and left_serial.casefold() == right_serial.casefold())

    @staticmethod
    def extract_request_device_serial(request) -> str:
        """Read the stable device identity sent by the web or desktop client."""
        if request is None:
            return ''
        try:
            headers = request.headers
            return TerminalService.normalize_device_serial(
                headers.get('X-HandyPOS-Device-Serial')
                or headers.get('X-Handypos-Device-Serial')
            )
        except Exception:
            meta = getattr(request, 'META', {}) or {}
            return TerminalService.normalize_device_serial(
                meta.get('HTTP_X_HANDYPOS_DEVICE_SERIAL')
                or meta.get('HTTP_X_HANDY_POS_DEVICE_SERIAL')
            )

    @staticmethod
    def enforce_terminal_device_binding(
        terminal: Terminal,
        request_device_serial: Any,
        *,
        operation: str = 'sale',
    ) -> None:
        """Ensure a live fiscal operation comes from the activated device."""
        if not bool(getattr(settings, 'MRA_EIS_ENFORCE_TERMINAL_DEVICE_BINDING', False)):
            return

        incoming_serial = TerminalService.normalize_device_serial(request_device_serial)
        if not incoming_serial:
            raise MRAIntegrationError(
                'This device is not identified as an activated MRA EIS terminal. '
                'Open EIS Settings on this device and activate it before making fiscal sales.'
            )

        terminal_serial = TerminalService.normalize_device_serial(
            getattr(terminal, 'device_serial', '')
        )
        if not terminal_serial:
            # Older active terminals may not have a stored identity. Bind them
            # on their first authenticated fiscal request.
            terminal.device_serial = incoming_serial
            terminal.save(update_fields=['device_serial', 'updated_at'])
            return

        if not TerminalService.device_serials_match(terminal_serial, incoming_serial):
            raise MRAIntegrationError(
                'This device is not the activated MRA EIS terminal for this branch. '
                f'The active terminal is bound to device serial {terminal_serial}. '
                f'Activate this device with its own TAC before {operation}.'
            )

    @staticmethod
    def _dict_get_any(mapping: dict[str, Any] | None, *keys: str) -> Any:
        if not isinstance(mapping, dict):
            return None

        for key in keys:
            if key in mapping:
                return mapping[key]

        lowered_keys = {str(key).lower(): value for key, value in mapping.items()}
        for key in keys:
            if key.lower() in lowered_keys:
                return lowered_keys[key.lower()]
        return None

    @staticmethod
    def _find_nested_value(value: Any, *keys: str) -> Any:
        if isinstance(value, dict):
            found = TerminalService._dict_get_any(value, *keys)
            if found not in (None, ''):
                return found
            for child in value.values():
                found = TerminalService._find_nested_value(child, *keys)
                if found not in (None, ''):
                    return found
        elif isinstance(value, list):
            for child in value:
                found = TerminalService._find_nested_value(child, *keys)
                if found not in (None, ''):
                    return found
        return None

    @staticmethod
    def _response_data(response: dict[str, Any]) -> dict[str, Any]:
        data = TerminalService._dict_get_any(response, 'data')
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _response_inner(response: Any) -> dict[str, Any]:
        """Return the useful MRA payload whether it is wrapped in ``data`` or not."""
        if not isinstance(response, dict):
            return {}
        data = TerminalService._dict_get_any(response, 'data')
        return data if isinstance(data, dict) else response

    @staticmethod
    def _response_value(response: Any, *keys: str) -> Any:
        """Read a response field from MRA's envelope or its nested data object."""
        if not isinstance(response, dict):
            return None

        inner = TerminalService._response_inner(response)
        value = TerminalService._dict_get_any(inner, *keys)
        if value in (None, '') and inner is not response:
            value = TerminalService._dict_get_any(response, *keys)
        return value

    @staticmethod
    def _optional_bool(value: Any) -> bool | None:
        """Parse MRA's boolean fields without treating an unknown value as false."""
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        normalized = str(value or '').strip().lower()
        if normalized in {'true', '1', 'yes', 'y', 'on'}:
            return True
        if normalized in {'false', '0', 'no', 'n', 'off'}:
            return False
        return None

    @staticmethod
    def _terminal_id_payload(terminal: Terminal) -> dict[str, str]:
        terminal_id = str(terminal.mra_terminal_id or terminal.terminal_id or '').strip()
        if not terminal_id:
            raise MRAIntegrationError('The terminal is missing its MRA terminal ID.')
        return {'terminalId': terminal_id}

    @staticmethod
    def _extract_blocking_status(response_data: Any) -> dict[str, Any]:
        inner = TerminalService._response_inner(response_data)
        raw_is_blocked = TerminalService._dict_get_any(
            inner, 'isBlocked', 'is_blocked', 'blocked'
        )
        if raw_is_blocked is None and inner is not response_data:
            raw_is_blocked = TerminalService._dict_get_any(
                response_data, 'isBlocked', 'is_blocked', 'blocked'
            )

        reason = TerminalService._dict_get_any(
            inner,
            'blockingReason', 'blocking_reason', 'message', 'remark', 'reason'
        )
        if reason in (None, '') and isinstance(response_data, dict):
            reason = TerminalService._dict_get_any(
                response_data, 'blockingReason', 'blocking_reason', 'message', 'remark', 'reason'
            )

        blocked_at = TerminalService._dict_get_any(
            inner, 'blockedAt', 'blocked_at'
        )
        if blocked_at in (None, '') and isinstance(response_data, dict):
            blocked_at = TerminalService._dict_get_any(response_data, 'blockedAt', 'blocked_at')

        return {
            'is_blocked': TerminalService._optional_bool(raw_is_blocked),
            'blocking_reason': str(reason or '').strip(),
            'blocked_at': blocked_at,
        }

    @staticmethod
    def _extract_unblock_status(response_data: Any) -> dict[str, Any]:
        inner = TerminalService._response_inner(response_data)
        raw_is_unblocked = TerminalService._dict_get_any(
            inner, 'isUnblocked', 'is_unblocked', 'unblocked'
        )
        if raw_is_unblocked is None and inner is not response_data:
            raw_is_unblocked = TerminalService._dict_get_any(
                response_data, 'isUnblocked', 'is_unblocked', 'unblocked'
            )

        remark = TerminalService._dict_get_any(
            inner, 'remark', 'message', 'reason', 'blockingReason', 'blocking_reason'
        )
        if remark in (None, '') and isinstance(response_data, dict):
            remark = TerminalService._dict_get_any(
                response_data, 'remark', 'message', 'reason', 'blockingReason', 'blocking_reason'
            )

        return {
            'is_unblocked': TerminalService._optional_bool(raw_is_unblocked),
            'remark': str(remark or '').strip(),
        }

    @staticmethod
    def _is_network_failure(exc: Exception) -> bool:
        """Identify failures where cached terminal state can safely be used."""
        if isinstance(exc, MRAResponseError):
            return False
        message = str(exc or '').lower()
        return any(
            marker in message
            for marker in (
                'request failed',
                'connection',
                'network',
                'timeout',
                'timed out',
                'unreachable',
                'max retries',
                'name or service not known',
                'connection refused',
                'temporary mra outage',
                'mra outage',
            )
        )

    @staticmethod
    def get_cached_blocking_status(terminal: Terminal) -> dict[str, Any] | None:
        """Read the latest MRA block decision from the terminal audit trail."""
        for audit in terminal.audit_logs.order_by('-created_at')[:25]:
            details = audit.details if isinstance(audit.details, dict) else {}
            source = str(details.get('source') or '')
            if source not in {
                'mra_terminal_blocking_message',
                'mra_terminal_unblock_status',
                'mra_sale_response_terminal_block',
            }:
                continue

            blocking_status = details.get('blocking_status')
            if isinstance(blocking_status, dict) and blocking_status.get('is_blocked') is not None:
                return {
                    **blocking_status,
                    'source': source,
                    'checked_at': audit.created_at.isoformat(),
                }

            if 'is_unblocked' in details and details.get('is_unblocked') is not None:
                is_unblocked = bool(details.get('is_unblocked'))
                return {
                    'is_blocked': not is_unblocked,
                    'is_unblocked': is_unblocked,
                    'blocking_reason': details.get('remark') or '',
                    'source': source,
                    'checked_at': audit.created_at.isoformat(),
                }

        if terminal.status == 'suspended':
            return {
                'is_blocked': True,
                'blocking_reason': (
                    'Terminal is suspended locally. Check MRA for the official blocking reason.'
                ),
                'source': 'local_terminal_status',
                'checked_at': None,
            }
        return None

    @staticmethod
    def record_terminal_blocked(
        terminal: Terminal,
        *,
        reason: str,
        source: str,
        response_data: dict[str, Any] | None = None,
        blocking_status: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        status_payload = {
            'is_blocked': True,
            'blocking_reason': str(reason or 'MRA requested terminal block').strip(),
            'blocked_at': None,
            **(blocking_status or {}),
        }
        terminal.status = 'suspended'
        terminal.save(update_fields=['status', 'updated_at'])
        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='suspended',
            details={
                'source': source,
                'blocking_status': status_payload,
                'response': response_data or {},
            },
        )
        return status_payload

    @staticmethod
    def get_terminal_blocking_message(terminal: Terminal) -> dict[str, Any]:
        """Fetch and persist MRA's current terminal block decision."""
        ensure_business_eis_enabled(terminal.business)
        payload = TerminalService._terminal_id_payload(terminal)
        result = MRAEISClient(terminal=terminal).call(
            'get_terminal_blocking_message',
            payload=payload,
            method='POST',
            mutating=False,
        )
        response_data = result.data if isinstance(result.data, dict) else {}
        response_errors = _extract_mra_response_errors(response_data)
        parsed_status = TerminalService._extract_blocking_status(response_data)

        if result.dry_run:
            return {
                'checked': False,
                'dry_run': True,
                'terminal_id': payload['terminalId'],
                **parsed_status,
                'response': response_data,
            }

        if response_errors:
            raise MRAResponseError(
                'MRA rejected get_terminal_blocking_message: ' + '; '.join(response_errors),
                endpoint_key='get_terminal_blocking_message',
                response_data=response_data,
            )

        if parsed_status.get('is_blocked') is True:
            TerminalService.record_terminal_blocked(
                terminal,
                reason=parsed_status.get('blocking_reason') or 'MRA reports this terminal is blocked.',
                source='mra_terminal_blocking_message',
                response_data=response_data,
                blocking_status=parsed_status,
            )
        else:
            TerminalAuditLog.objects.create(
                terminal=terminal,
                action='configuration_updated',
                details={
                    'source': 'mra_terminal_blocking_message',
                    'blocking_status': parsed_status,
                    'response': response_data,
                },
            )

        return {
            'checked': True,
            'dry_run': False,
            'terminal_id': payload['terminalId'],
            **parsed_status,
            'response': response_data,
        }

    @staticmethod
    def ensure_terminal_not_blocked_for_sale(terminal: Terminal) -> dict[str, Any]:
        """Prevent new fiscal sales on an MRA-blocked terminal.

        A temporary MRA outage does not stop an otherwise healthy terminal from
        using the existing offline flow. A cached or locally suspended terminal
        remains blocked even while offline.
        """
        ensure_business_eis_enabled(terminal.business)
        try:
            blocking = TerminalService.get_terminal_blocking_message(terminal)
        except MRAResponseError:
            raise
        except MRAIntegrationError as exc:
            cached = TerminalService.get_cached_blocking_status(terminal) or {}
            if TerminalService._is_network_failure(exc):
                if terminal.status == 'suspended' or cached.get('is_blocked') is True:
                    reason = (
                        cached.get('blocking_reason')
                        or 'Terminal is suspended locally. Check MRA block status when online.'
                    )
                    raise MRAIntegrationError(f'MRA terminal is blocked: {reason}') from exc
                return {
                    'checked': False,
                    'dry_run': False,
                    'is_blocked': False,
                    'source': 'cached_terminal_state',
                    'reason': 'mra_network_unreachable',
                    'error': str(exc),
                    'cached_blocking_status': cached,
                }
            raise MRAIntegrationError(
                'Could not verify MRA terminal block status. Connect to the internet and retry.'
            ) from exc

        terminal.refresh_from_db()
        if blocking.get('dry_run'):
            return blocking

        if blocking.get('is_blocked') is None:
            raise MRAIntegrationError(
                'Could not verify MRA terminal block status: MRA returned no block decision.'
            )

        if blocking.get('is_blocked') is True or terminal.status == 'suspended':
            cached = TerminalService.get_cached_blocking_status(terminal) or {}
            reason = (
                blocking.get('blocking_reason')
                or cached.get('blocking_reason')
                or 'MRA reports this terminal is blocked.'
            )
            raise MRAIntegrationError(f'MRA terminal is blocked: {reason}')

        return blocking

    @staticmethod
    def ensure_terminal_ready_for_sale(
        terminal: Terminal,
        *,
        is_online: bool,
    ) -> dict[str, Any]:
        """Apply the terminal block rule to any fiscal sale entry point."""
        cached_blocking = TerminalService.get_cached_blocking_status(terminal) or {}
        if terminal.status == 'suspended' or cached_blocking.get('is_blocked') is True:
            reason = (
                cached_blocking.get('blocking_reason')
                or 'MRA terminal is blocked. Check the terminal status before making a sale.'
            )
            raise MRAIntegrationError(f'MRA terminal is blocked: {reason}')

        client = MRAEISClient(terminal=terminal)
        if is_online and not client.dry_run:
            return TerminalService.ensure_terminal_not_blocked_for_sale(terminal)

        return {
            'checked': False,
            'dry_run': client.dry_run,
            'is_blocked': False,
            'source': 'local_terminal_state',
        }

    @staticmethod
    def _normalize_ping_server_time(value: Any) -> str:
        raw = str(value or '').strip()
        if not raw:
            return ''
        try:
            if ',' in raw and (raw[:3].isalpha() or 'GMT' in raw.upper()):
                parsed = parsedate_to_datetime(raw)
            else:
                parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
            if timezone.is_naive(parsed):
                parsed = timezone.make_aware(parsed, datetime_timezone.utc)
            return parsed.isoformat()
        except (TypeError, ValueError, OverflowError):
            return raw

    @staticmethod
    def _extract_ping_server_time(
        response_data: Any,
        headers: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        server_time_keys = (
            'serverTime', 'server_time', 'serverDateTime', 'server_date_time',
            'serverDate', 'server_date', 'dateTime', 'date_time', 'datetime',
            'timestamp', 'time', 'date',
        )
        found = TerminalService._find_nested_value(response_data, *server_time_keys)
        source = 'response'
        if found in (None, ''):
            headers = headers or {}
            found = TerminalService._dict_get_any(headers, 'Date', 'date')
            source = 'http_date_header'
        if found in (None, ''):
            return {'server_time': None, 'server_time_raw': None, 'server_time_source': None}
        return {
            'server_time': TerminalService._normalize_ping_server_time(found),
            'server_time_raw': str(found),
            'server_time_source': source,
        }

    @staticmethod
    def _parse_server_time(value: Any) -> datetime | None:
        normalized = TerminalService._normalize_ping_server_time(value)
        if not normalized:
            return None
        try:
            parsed = datetime.fromisoformat(normalized.replace('Z', '+00:00'))
        except (TypeError, ValueError):
            return None
        if timezone.is_naive(parsed):
            parsed = timezone.make_aware(parsed, datetime_timezone.utc)
        return parsed

    @staticmethod
    def record_server_time_sync(
        terminal: Terminal,
        *,
        server_time: Any,
        checked_at: datetime | None = None,
        source: str = 'mra_ping',
        response_data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        parsed_server_time = TerminalService._parse_server_time(server_time)
        if parsed_server_time is None:
            return None
        checked_at = checked_at or timezone.now()
        details = {
            'source': 'mra_server_time_sync',
            'ping_source': source,
            'server_time': parsed_server_time.isoformat(),
            'checked_at': checked_at.isoformat(),
            'response': response_data or {},
        }
        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='online_status_changed',
            details=details,
        )
        return details

    @staticmethod
    def get_latest_server_time_sync(terminal: Terminal) -> dict[str, Any] | None:
        for audit in terminal.audit_logs.filter(action='online_status_changed').order_by('-created_at')[:50]:
            details = audit.details if isinstance(audit.details, dict) else {}
            if details.get('source') != 'mra_server_time_sync':
                continue
            server_time = TerminalService._parse_server_time(details.get('server_time'))
            checked_at = TerminalService._parse_server_time(details.get('checked_at')) or audit.created_at
            if server_time:
                return {
                    'server_time': server_time,
                    'checked_at': checked_at,
                    'source': details.get('ping_source') or 'mra_ping',
                }
        return None

    @staticmethod
    def resolve_mra_transaction_time(
        terminal: Terminal,
        *,
        require_live_ping: bool,
        allow_cached: bool = True,
    ) -> tuple[datetime, dict[str, Any]]:
        max_age_hours = float(getattr(settings, 'MRA_EIS_SERVER_TIME_MAX_AGE_HOURS', 24) or 24)
        now = timezone.now()
        sync = TerminalService.get_latest_server_time_sync(terminal) if allow_cached else None
        if sync:
            age_hours = max((now - sync['checked_at']).total_seconds() / 3600, 0)
            if age_hours <= max_age_hours:
                adjusted = sync['server_time'] + (now - sync['checked_at'])
                return adjusted, {
                    'source': 'cached_mra_server_time',
                    'checked_at': sync['checked_at'].isoformat(),
                    'server_time': sync['server_time'].isoformat(),
                    'adjusted_time': adjusted.isoformat(),
                    'age_hours': round(age_hours, 4),
                    'max_age_hours': max_age_hours,
                }

        if require_live_ping:
            health = TerminalService.check_terminal_health(terminal)
            if health.get('is_online') is True:
                server_time = TerminalService._parse_server_time(
                    health.get('server_time') or health.get('server_time_raw')
                )
                if server_time:
                    return server_time, {
                        'source': health.get('server_time_source') or 'mra_ping',
                        'checked_at': health.get('checked_at'),
                        'server_time': server_time.isoformat(),
                        'live_ping': True,
                    }
            raise MRAIntegrationError('MRA server time unavailable. Connect to internet and retry.')

        if sync:
            raise MRAIntegrationError('MRA server time sync expired. Connect to internet and ping MRA first.')
        raise MRAIntegrationError('MRA server time not synced. Connect to internet and ping MRA first.')

    @staticmethod
    def check_terminal_health(terminal: Terminal) -> dict[str, Any]:
        """Ping MRA and persist the server clock used by fiscal transactions."""
        checked_at = timezone.now()
        client = MRAEISClient(terminal=terminal)
        endpoint = client._resolve_endpoint('ping')
        last_error: Exception | None = None
        for method in ('POST', 'GET'):
            try:
                result = client.call(
                    'ping',
                    payload=None,
                    method=method,
                    mutating=False,
                    send_json=False,
                    record_connectivity=False,
                )
                response_data = result.data if isinstance(result.data, dict) else {}
                time_details = TerminalService._extract_ping_server_time(response_data, result.headers)
                if result.dry_run:
                    return {
                        'checked': False,
                        'dry_run': True,
                        'is_online': terminal.is_online,
                        'endpoint': endpoint,
                        'status_code': result.status_code,
                        'checked_at': checked_at.isoformat(),
                        **time_details,
                    }
                errors = _extract_mra_response_errors(response_data)
                is_online = 200 <= int(result.status_code or 0) < 300 and not errors
                terminal.is_online = is_online
                if is_online:
                    terminal.last_sync_at = checked_at
                    terminal.save(update_fields=['is_online', 'last_sync_at', 'updated_at'])
                    TerminalService.record_server_time_sync(
                        terminal,
                        server_time=time_details.get('server_time'),
                        checked_at=checked_at,
                        source=time_details.get('server_time_source') or 'mra_ping',
                        response_data=response_data,
                    )
                else:
                    terminal.save(update_fields=['is_online', 'updated_at'])
                return {
                    'checked': True,
                    'dry_run': False,
                    'is_online': is_online,
                    'endpoint': endpoint,
                    'method': method,
                    'status_code': result.status_code,
                    'errors': errors,
                    'response': response_data,
                    'checked_at': checked_at.isoformat(),
                    **time_details,
                }
            except MRAIntegrationError as exc:
                last_error = exc
                if getattr(exc, 'status_code', None) not in (404, 405):
                    break

        terminal.is_online = False
        terminal.save(update_fields=['is_online', 'updated_at'])
        return {
            'checked': True,
            'dry_run': False,
            'is_online': False,
            'endpoint': getattr(last_error, 'endpoint', '') or endpoint,
            'status_code': getattr(last_error, 'status_code', None),
            'error': str(last_error or 'MRA ping failed'),
            'checked_at': checked_at.isoformat(),
        }

    @staticmethod
    def check_terminal_unblock_status(terminal: Terminal) -> dict[str, Any]:
        """Check whether MRA has released a previously blocked terminal."""
        ensure_business_eis_enabled(terminal.business)
        payload = TerminalService._terminal_id_payload(terminal)
        previous_status = terminal.status
        result = MRAEISClient(terminal=terminal).call(
            'check_terminal_unblock_status',
            payload=payload,
            method='POST',
            mutating=False,
        )
        response_data = result.data if isinstance(result.data, dict) else {}
        response_errors = _extract_mra_response_errors(response_data)
        parsed_status = TerminalService._extract_unblock_status(response_data)

        if result.dry_run:
            return {
                'checked': False,
                'dry_run': True,
                'terminal_id': payload['terminalId'],
                **parsed_status,
                'response': response_data,
            }

        if response_errors:
            raise MRAResponseError(
                'MRA rejected check_terminal_unblock_status: ' + '; '.join(response_errors),
                endpoint_key='check_terminal_unblock_status',
                response_data=response_data,
            )

        is_unblocked = parsed_status.get('is_unblocked')
        if is_unblocked is True and terminal.status == 'suspended':
            terminal.status = 'active'
            terminal.save(update_fields=['status', 'updated_at'])

        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='online_status_changed' if is_unblocked is True else 'suspended',
            details={
                'source': 'mra_terminal_unblock_status',
                'previous_status': previous_status,
                'current_status': terminal.status,
                **parsed_status,
                'blocking_status': {
                    'is_blocked': False if is_unblocked is True else terminal.status == 'suspended',
                    'is_unblocked': is_unblocked,
                    'blocking_reason': parsed_status.get('remark') or '',
                },
                'response': response_data,
            },
        )

        return {
            'checked': True,
            'dry_run': False,
            'terminal_id': payload['terminalId'],
            **parsed_status,
            'previous_status': previous_status,
            'current_status': terminal.status,
            'response': response_data,
            'errors': response_errors,
        }

    @staticmethod
    def _extract_activation_terminal(response: dict[str, Any]) -> dict[str, Any]:
        data = TerminalService._response_data(response)
        terminal = TerminalService._dict_get_any(
            data,
            'activatedTerminal',
            'ActivatedTerminal',
            'activated_terminal',
        )
        if isinstance(terminal, dict):
            return terminal
        return data if data else response

    @staticmethod
    def _to_positive_int(value: Any) -> int | None:
        if value in (None, ''):
            return None
        try:
            parsed = int(str(value).strip())
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    @staticmethod
    def _build_activation_payload(
        *,
        tac_code: str,
        pos_version: str,
        os_type: str,
        mac_address: str,
    ) -> dict[str, Any]:
        """Build the official MRA activation request without sending credentials."""
        product_id = str(getattr(settings, 'MRA_EIS_PRODUCT_ID', '') or 'HandyPOS')[:50]
        os_name = str(os_type or 'Unknown')[:50]
        return {
            'terminalActivationCode': str(tac_code or '').strip(),
            'environment': {
                'platform': {
                    'osName': os_name,
                    'osVersion': os_name,
                    'osBuild': '',
                    'macAddress': (mac_address or '00-00-00-00-00-00')[:17],
                },
                'pos': {
                    'productID': product_id,
                    'productVersion': str(pos_version or '1.0.0')[:50],
                },
            },
        }

    @staticmethod
    def _upsert_terminal(
        *,
        business,
        branch,
        pos_name: str,
        pos_version: str,
        os_type: str,
        device_serial: str,
        mac_address: str,
    ) -> Terminal:
        incoming_serial = TerminalService.normalize_device_serial(device_serial)
        if not incoming_serial:
            raise ValueError('Device serial is required to activate a terminal.')

        business_terminals = Terminal.objects.select_for_update().filter(business=business)
        existing_binding = (
            business_terminals
            .filter(device_serial__iexact=incoming_serial)
            .exclude(branch=branch)
            .select_related('branch')
            .order_by('-updated_at')
            .first()
        )
        if existing_binding:
            raise ValueError(
                f'This device is already assigned to {existing_binding.branch.name}. '
                'Use a different device or activate it for that branch instead.'
            )

        terminals = business_terminals.filter(branch=branch)
        terminal = terminals.filter(device_serial__iexact=incoming_serial).order_by('-updated_at').first()

        if terminal:
            terminal.device_serial = incoming_serial or terminal.device_serial
            terminal.mac_address = mac_address
            terminal.pos_name = pos_name
            terminal.pos_version = pos_version
            terminal.os_type = os_type
            terminal.save(
                update_fields=['device_serial', 'mac_address', 'pos_name', 'pos_version', 'os_type', 'updated_at']
            )
            return terminal

        local_terminal_id = f"TRM-{branch.id}-{uuid.uuid4().hex[:8].upper()}"
        return Terminal.objects.create(
            business=business,
            branch=branch,
            terminal_id=local_terminal_id,
            device_serial=incoming_serial,
            mac_address=mac_address,
            pos_name=pos_name,
            pos_version=pos_version,
            os_type=os_type,
            mra_terminal_id=local_terminal_id,
            mra_api_key='',
            status='pending_activation',
        )

    @staticmethod
    @transaction.atomic
    def activate_terminal(
        business,
        branch,
        tac_code,
        pos_name,
        pos_version,
        os_type,
        device_serial,
        mac_address=None,
    ):
        """
        Activate terminal in an onboarding-ready way.

        - Keeps local TAC compatibility.
        - Calls official onboarding endpoint when live submission is enabled.
        - In dry-run mode, payload is prepared and stored but not sent.
        """
        ensure_business_eis_enabled(business)
        local_tac = TerminalActivationCode.objects.filter(code=tac_code, business=business).first()
        if local_tac and not local_tac.is_valid():
            raise ValueError('TAC is invalid or expired')

        if getattr(settings, 'MRA_EIS_REQUIRE_LOCAL_TAC', False) and not local_tac:
            raise ValueError('TAC is not registered locally. Create/import TAC first.')

        terminal = TerminalService._upsert_terminal(
            business=business,
            branch=branch,
            pos_name=pos_name,
            pos_version=pos_version,
            os_type=os_type,
            device_serial=device_serial,
            mac_address=mac_address or '',
        )

        payload = TerminalService._build_activation_payload(
            tac_code=tac_code,
            pos_version=pos_version,
            os_type=os_type,
            mac_address=mac_address or '',
        )

        client = MRAEISClient(terminal=terminal)
        try:
            result = client.call('activate_terminal', payload=payload, method='POST', mutating=True)
        except Exception as exc:
            if client.http_enabled and not client.dry_run and client.allow_live_submission:
                logger.warning('Live MRA terminal activation failed: %s', exc)
                raise MRAIntegrationError(f'MRA terminal activation failed: {exc}') from exc

            logger.warning('Terminal activation call failed in safe mode, keeping it pending: %s', exc)
            result = MRACallResult(
                ok=False,
                dry_run=True,
                status_code=0,
                endpoint=client._resolve_endpoint('activate_terminal'),
                data={'status': 'pending_activation', 'error': str(exc)},
            )
        response_data = result.data or {}
        if not result.ok and not result.dry_run:
            raise MRAIntegrationError('MRA did not accept the terminal activation request.')

        response_errors = _extract_mra_response_errors(response_data)
        if response_errors and not result.dry_run:
            raise MRAIntegrationError(f'MRA rejected terminal activation: {"; ".join(response_errors)}')

        activated_terminal = TerminalService._extract_activation_terminal(response_data)
        terminal_credentials = TerminalService._dict_get_any(
            activated_terminal,
            'terminalCredentials',
            'TerminalCredentials',
            'terminal_credentials',
        ) or {}
        if not isinstance(terminal_credentials, dict):
            terminal_credentials = {}

        # Support common API response shape variants.
        mra_terminal_id = (
            TerminalService._dict_get_any(
                activated_terminal,
                'terminalId', 'terminalID', 'terminal_id', 'mra_terminal_id',
                'deviceId', 'deviceID',
            )
            or TerminalService._find_nested_value(
                response_data,
                'terminalId', 'terminalID', 'terminal_id', 'mra_terminal_id',
                'deviceId', 'deviceID',
            )
            or terminal.mra_terminal_id
            or tac_code
        )

        token = (
            TerminalService._dict_get_any(
                terminal_credentials,
                'jwtToken', 'JWTToken', 'jwt_token', 'token', 'accessToken', 'access_token',
            )
            or TerminalService._find_nested_value(
                response_data,
                'jwtToken', 'JWTToken', 'jwt_token', 'token', 'accessToken', 'access_token',
            )
            or ''
        )
        access_key = (
            TerminalService._dict_get_any(
                terminal_credentials,
                'secretKey', 'SecretKey', 'secret_key', 'accessKey', 'access_key',
                'apiKey', 'api_key',
            )
            or TerminalService._find_nested_value(
                response_data,
                'secretKey', 'SecretKey', 'secret_key', 'accessKey', 'access_key',
                'apiKey', 'api_key',
            )
            or terminal.mra_api_key
            or ''
        )

        taxpayer_id = TerminalService._to_positive_int(
            TerminalService._find_nested_value(
                response_data,
                'taxpayerId', 'TaxpayerId', 'taxpayerID', 'TaxpayerID',
                'taxpayer_id', 'businessId', 'BusinessId',
            )
        )
        terminal_position = TerminalService._to_positive_int(
            TerminalService._find_nested_value(
                response_data,
                'terminalPosition', 'TerminalPosition', 'terminal_position',
                'position', 'Position',
            )
        )

        # If dry-run or confirmation is required, stay pending activation.
        status_value = str(
            response_data.get('status')
            or ('pending_activation' if result.dry_run else 'active')
        ).lower()
        if status_value not in {'pending_activation', 'active', 'suspended', 'deactivated'}:
            status_value = 'pending_activation' if result.dry_run else 'active'

        terminal.mra_terminal_id = mra_terminal_id
        if taxpayer_id:
            terminal.mra_taxpayer_id = taxpayer_id
        if terminal_position:
            terminal.terminal_position = terminal_position
        terminal.mra_api_key = access_key
        terminal.mra_token = token
        terminal.token_expires_at = timezone.now() + timedelta(hours=24) if token else None
        terminal.status = status_value
        terminal.activated_at = timezone.now() if status_value == 'active' else terminal.activated_at
        terminal.save()

        if local_tac:
            if local_tac.status == 'unused':
                local_tac.mark_as_used(terminal)
            elif local_tac.used_by_terminal_id != terminal.id:
                raise ValueError('TAC has already been used by another terminal')

        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='activated',
            details={
                'dry_run': result.dry_run,
                'request_payload': payload,
                'response': response_data,
            },
        )

        return terminal

    @staticmethod
    def refresh_token(terminal):
        """Request a fresh terminal JWT using MRA's token endpoint."""
        ensure_business_eis_enabled(terminal.business)
        if not str(getattr(terminal, 'mra_token', '') or '').strip():
            raise MRAIntegrationError(
                'Terminal JWT token is missing. Activate the terminal before refreshing its token.'
            )
        client = MRAEISClient(terminal=terminal)
        result = client.call(
            'request_new_terminal_token',
            payload=None,
            method='POST',
            mutating=False,
        )

        response_data = result.data if isinstance(result.data, dict) else {}
        inner_data = response_data.get('data')
        inner_data = inner_data if isinstance(inner_data, dict) else {}

        token = (
            inner_data.get('jwtToken')
            or inner_data.get('token')
            or inner_data.get('accessToken')
            or inner_data.get('access_token')
            or response_data.get('jwtToken')
            or response_data.get('token')
            or response_data.get('accessToken')
            or response_data.get('access_token')
            or ''
        )

        if token:
            terminal.mra_token = token
            terminal.token_expires_at = timezone.now() + timedelta(hours=24)
            terminal.save(update_fields=['mra_token', 'token_expires_at', 'updated_at'])

        if not token and not result.dry_run:
            raise MRAIntegrationError(
                'MRA token refresh succeeded without returning a terminal JWT token.'
            )

        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='token_refreshed',
            details={
                'dry_run': result.dry_run,
                'response': response_data,
            },
        )

        return terminal

    @staticmethod
    def update_online_status(terminal, is_online):
        """Update online/offline status with audit trail."""
        if terminal.is_online != is_online:
            terminal.is_online = is_online
            terminal.save(update_fields=['is_online', 'updated_at'])

            event_type = 'online_detected' if is_online else 'offline_detected'
            OfflineAuditLog.objects.create(
                terminal=terminal,
                event_type=event_type,
                details={'timestamp': timezone.now().isoformat()},
            )

            TerminalAuditLog.objects.create(
                terminal=terminal,
                action='online_status_changed',
                details={'is_online': is_online},
            )

            # Best effort: when connectivity is restored, immediately try
            # syncing queued offline invoices in sequence.
            if is_online and is_business_eis_enabled(terminal.business):
                try:
                    InvoiceService.sync_offline_invoices(terminal)
                    RetryService.process_retry_queue()
                except Exception as exc:
                    logger.warning(
                        'Automatic offline sync on reconnect failed for terminal %s: %s',
                        terminal.terminal_id,
                        exc,
                    )


class ConfigurationService:
    """MRA configuration sync and retrieval."""

    DEFAULT_CONFIG_TYPES = [
        'global_configuration',
        'terminal_configuration',
        'taxpayer_configuration',
        'tax_rules',
        'receipt_format',
        'product_codes',
        'system_settings',
    ]

    @staticmethod
    def _unwrap_response_data(data: Any) -> dict[str, Any]:
        """Return the MRA payload regardless of data/Data wrapping."""
        if not isinstance(data, dict):
            return {}

        wrapped = TerminalService._dict_get_any(data, 'data')
        return wrapped if isinstance(wrapped, dict) else data

    @staticmethod
    def _extract_config_data(data: dict[str, Any], config_type: str) -> dict[str, Any]:
        data = ConfigurationService._unwrap_response_data(data)
        if not data:
            return {'source': 'dry_run', 'config_type': config_type}

        official_map = {
            'global_configuration': 'globalConfiguration',
            'terminal_configuration': 'terminalConfiguration',
            'taxpayer_configuration': 'taxpayerConfiguration',
            # MRA supplies tax rules as part of the global configuration.
            'tax_rules': 'globalConfiguration',
            'receipt_format': 'terminalConfiguration',
            'product_codes': 'terminalSiteProducts',
            'terminal_site_products': 'terminalSiteProducts',
            'system_settings': None,
        }

        for key in (config_type, official_map.get(config_type)):
            if not key:
                continue
            value = TerminalService._dict_get_any(data, key)
            if isinstance(value, dict):
                return value
            if isinstance(value, list):
                return {'items': value}

        configurations = TerminalService._dict_get_any(data, 'configurations')
        if isinstance(configurations, dict):
            found = TerminalService._dict_get_any(configurations, config_type)
            if isinstance(found, dict):
                return found

        if config_type == 'system_settings':
            return data

        return {'raw': data, 'config_type': config_type}

    @staticmethod
    def _config_version(config_data: dict[str, Any], config_type: str, *, dry_run: bool = False) -> str:
        """Read MRA's version, with a stable fallback for gateways without one."""
        version = TerminalService._dict_get_any(
            config_data,
            'versionNo', 'version', 'configVersion', 'configurationVersion',
        )
        if version not in (None, ''):
            return str(version)[:50]

        if dry_run:
            return f'dry-run-{config_type}'[:50]

        canonical = json.dumps(config_data, sort_keys=True, separators=(',', ':'), default=str)
        digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]
        return f'sync-{config_type}-{digest}'[:50]

    @staticmethod
    def _normalize_config_types(config_types: Any) -> list[str]:
        if config_types is None:
            return list(ConfigurationService.DEFAULT_CONFIG_TYPES)
        if not isinstance(config_types, list):
            raise ValueError('config_types must be a list')

        allowed = {choice[0] for choice in MRAConfiguration.CONFIG_TYPES}
        normalized = list(dict.fromkeys(str(value).strip() for value in config_types if str(value).strip()))
        invalid = [value for value in normalized if value not in allowed]
        if invalid:
            raise ValueError(f'Unsupported MRA configuration type(s): {", ".join(invalid)}')
        if not normalized:
            raise ValueError('At least one MRA configuration type is required')
        return normalized

    @staticmethod
    def _normalize_product_catalog_item(item: Any) -> dict[str, Any] | None:
        """Normalize one product from MRA's terminal-site catalog.

        MRA has used a few casing and naming variants for this payload. Keep
        that translation in the service layer so mapping validation and the
        catalog endpoint cannot disagree about what a product code means.
        """
        if not isinstance(item, dict):
            return None

        code = TerminalService._dict_get_any(
            item,
            'code', 'mra_product_code', 'product_code', 'productCode',
            'item_code', 'itemCode', 'hs_code', 'hsCode',
        )
        if code in (None, ''):
            return None
        code = str(code).strip().upper()
        if not code:
            return None

        name = TerminalService._dict_get_any(
            item,
            'name', 'mra_product_name', 'product_name', 'productName',
            'description', 'productDescription',
        )
        name = str(name or code).strip() or code

        category = TerminalService._dict_get_any(
            item,
            'category', 'product_category', 'productCategory', 'group',
            'group_name', 'groupName',
        )
        category = str(category or 'General').strip() or 'General'

        tax_node = TerminalService._dict_get_any(
            item, 'tax', 'taxConfiguration', 'tax_configuration', 'vat',
        )
        tax_node = tax_node if isinstance(tax_node, dict) else {}
        raw_tax_type = TerminalService._dict_get_any(
            item,
            'default_tax_type', 'defaultTaxType', 'tax_type', 'taxType',
            'vat_type', 'vatType', 'vat_category', 'vatCategory',
        )
        if raw_tax_type in (None, ''):
            raw_tax_type = TerminalService._dict_get_any(
                tax_node, 'type', 'taxType', 'vatType', 'category',
            )
        raw_tax_rate = TerminalService._dict_get_any(
            item,
            'default_tax_rate', 'defaultTaxRate', 'tax_rate', 'taxRate',
            'vat_rate', 'vatRate',
        )
        if raw_tax_rate in (None, ''):
            raw_tax_rate = TerminalService._dict_get_any(
                tax_node, 'rate', 'taxRate', 'vatRate',
            )

        normalized_tax_type = str(raw_tax_type or '').strip().lower()
        if normalized_tax_type in {'zero', 'zero_rated', 'zero-rated', 'vat_zero', 'vat-zero', '0'}:
            normalized_tax_type = 'zero'
        elif normalized_tax_type in {'exempt', 'vat_exempt', 'vat-exempt'}:
            normalized_tax_type = 'exempt'
        else:
            normalized_tax_type = 'standard'

        if raw_tax_rate in (None, ''):
            normalized_tax_rate = 0.0 if normalized_tax_type in {'zero', 'exempt'} else 16.5
        else:
            try:
                normalized_tax_rate = max(float(str(raw_tax_rate).replace('%', '').strip()), 0.0)
            except (TypeError, ValueError):
                normalized_tax_rate = 0.0 if normalized_tax_type in {'zero', 'exempt'} else 16.5

        raw_unit = TerminalService._dict_get_any(
            item,
            'unit_measure', 'unitMeasure', 'unit_of_measure', 'unitOfMeasure',
            'measurementUnit', 'uom',
        )
        unit_measure = str(raw_unit or '').strip().lower()
        unit_measure = {'piece': 'unit', 'pieces': 'unit', 'litre': 'liter'}.get(
            unit_measure, unit_measure
        )

        raw_calculation_method = TerminalService._dict_get_any(
            item,
            'tax_calculation_method', 'taxCalculationMethod',
            'calculation_method', 'calculationMethod',
        )
        calculation_method = str(raw_calculation_method or '').strip().lower()
        calculation_method = 'exclusive' if calculation_method.startswith('excl') else 'inclusive'

        raw_levies = TerminalService._dict_get_any(
            item,
            'levies', 'activatedLevies', 'activated_levies',
            'productLevies', 'product_levies', 'levyTypes', 'levy_types',
            'levyBreakDown', 'levyBreakdown',
        )

        return {
            'code': code,
            'name': name,
            'category': category,
            'default_tax_type': normalized_tax_type,
            'default_tax_rate': normalized_tax_rate,
            'unit_measure': unit_measure,
            'tax_calculation_method': calculation_method,
            'levies': raw_levies or [],
            '_tax_type_provided': raw_tax_type not in (None, ''),
            '_tax_rate_provided': raw_tax_rate not in (None, ''),
            '_unit_measure_provided': raw_unit not in (None, ''),
            '_calculation_method_provided': raw_calculation_method not in (None, ''),
        }

    @staticmethod
    def extract_product_catalog(config_data: Any) -> list[dict[str, Any]]:
        """Extract unique product codes from any stored MRA config shape."""
        if not config_data:
            return []

        queue: list[Any] = [config_data]
        extracted: list[dict[str, Any]] = []
        seen_codes: set[str] = set()
        while queue:
            current = queue.pop(0)
            if isinstance(current, list):
                queue.extend(current)
                continue
            if not isinstance(current, dict):
                continue

            normalized_item = ConfigurationService._normalize_product_catalog_item(current)
            if normalized_item:
                code = normalized_item['code']
                if code not in seen_codes:
                    seen_codes.add(code)
                    extracted.append(normalized_item)

            queue.extend(value for value in current.values() if isinstance(value, (dict, list)))

        return extracted

    @staticmethod
    def get_product_catalog(business) -> tuple[list[dict[str, Any]], MRAConfiguration | None]:
        """Return the active terminal-site product catalog and its snapshot."""
        for config_type in ('product_codes', 'terminal_site_products'):
            config = ConfigurationService.get_active_configuration(business, config_type)
            if not config:
                continue
            products = ConfigurationService.extract_product_catalog(config.config_data)
            if products:
                return products, config
        return [], None

    @staticmethod
    def get_terminal_site_id(business, branch=None) -> str:
        """Resolve the MRA site identifier used by stock and sales endpoints."""
        if branch is not None:
            site_id = getattr(branch, 'mra_site_id', None)
            if site_id:
                return str(site_id).strip()
            branch_code = getattr(branch, 'mra_branch_code', None)
            if branch_code:
                return str(branch_code).strip()

        config = ConfigurationService.get_active_configuration(business, 'terminal_configuration')
        config_data = config.config_data if config else {}
        site_id = TerminalService._find_nested_value(
            config_data,
            'siteId', 'siteID', 'site_id', 'terminalSiteId', 'terminal_site_id',
        )
        return str(site_id).strip() if site_id not in (None, '') else ''

    @staticmethod
    def find_product_catalog_item(business, product_code: Any) -> dict[str, Any] | None:
        normalized_code = str(product_code or '').strip().upper()
        if not normalized_code:
            return None
        products, _config = ConfigurationService.get_product_catalog(business)
        return next((product for product in products if product['code'] == normalized_code), None)

    @staticmethod
    def _truthy(value: Any) -> bool | None:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {'true', '1', 'yes', 'y'}:
                return True
            if normalized in {'false', '0', 'no', 'n'}:
                return False
        return None

    @staticmethod
    def _apply_taxpayer_configuration(business, config_data: dict[str, Any]) -> None:
        """Mirror explicit taxpayer identity values returned by MRA.

        MRA remains the source of truth. Missing values never clear local data,
        and a conflicting unique TIN is left untouched rather than breaking a
        successful configuration sync.
        """
        if not isinstance(config_data, dict):
            return

        tin = TerminalService._dict_get_any(
            config_data,
            'tin', 'taxpayerTin', 'taxpayerTIN', 'taxIdentificationNumber',
            'taxIdentificationNo', 'taxpayerIdentificationNumber',
        )
        vat_number = TerminalService._dict_get_any(
            config_data,
            'vatRegistrationNumber', 'vatRegistrationNo', 'vatNumber',
            'vat_registration_number',
        )
        vat_registered = TerminalService._dict_get_any(
            config_data,
            'isVATRegistered', 'vatRegistered', 'isVatRegistered',
            'vat_registered',
        )
        taxpayer_type = TerminalService._dict_get_any(
            config_data,
            'taxpayerType', 'taxPayerType', 'mraTaxpayerType',
        )

        update_fields: list[str] = []
        clean_tin = str(tin).strip() if tin not in (None, '') else ''
        if clean_tin and (not business.tin or str(business.tin).strip() == clean_tin):
            business.tin = clean_tin
            update_fields.append('tin')

        clean_vat_number = str(vat_number).strip() if vat_number not in (None, '') else ''
        if clean_vat_number:
            business.vat_registration_number = clean_vat_number
            update_fields.append('vat_registration_number')

        parsed_vat = ConfigurationService._truthy(vat_registered)
        if parsed_vat is not None:
            business.vat_registered = parsed_vat
            update_fields.append('vat_registered')

        normalized_type = str(taxpayer_type or '').strip().upper().replace('-', '_')
        if normalized_type in {'VAT', 'NON_VAT', 'NONVAT', 'NON_VAT_REGISTERED'}:
            business.mra_taxpayer_type = 'VAT' if normalized_type == 'VAT' else 'NON_VAT'
            update_fields.append('mra_taxpayer_type')

        if update_fields:
            try:
                business.save(update_fields=list(dict.fromkeys(update_fields + ['updated_at'])))
            except IntegrityError:
                logger.warning(
                    'MRA returned a TIN already assigned to another business; taxpayer snapshot was kept locally.'
                )

    @staticmethod
    def _replace_active_config(
        business,
        config_type: str,
        config_data: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> MRAConfiguration:
        """Store one immutable version and switch active state atomically."""
        config_version = ConfigurationService._config_version(
            config_data,
            config_type,
            dry_run=dry_run,
        )
        now = timezone.now()

        with transaction.atomic():
            existing = (
                MRAConfiguration.objects.select_for_update()
                .filter(
                    business=business,
                    config_type=config_type,
                    config_version=config_version,
                )
                .first()
            )
            if existing:
                # The payload is a snapshot. Refresh only the fetch timestamp;
                # never rewrite data under an already-issued MRA version.
                MRAConfiguration.objects.filter(
                    business=business,
                    config_type=config_type,
                    is_active=True,
                ).exclude(pk=existing.pk).update(is_active=False, effective_to=now)
                if not existing.is_active or existing.effective_to is not None:
                    existing.is_active = True
                    existing.effective_to = None
                    existing.save(update_fields=['is_active', 'effective_to', 'fetched_from_mra_at'])
                else:
                    existing.fetched_from_mra_at = now
                    existing.save(update_fields=['fetched_from_mra_at'])
                return existing

            # Do not deactivate the prior version until the new row exists.
            try:
                created = MRAConfiguration.objects.create(
                    business=business,
                    config_type=config_type,
                    config_version=config_version,
                    config_data=config_data,
                    effective_from=now,
                    fetched_from_mra_at=now,
                    is_active=True,
                )
            except IntegrityError:
                existing = MRAConfiguration.objects.select_for_update().get(
                    business=business,
                    config_type=config_type,
                    config_version=config_version,
                )
                return existing

            MRAConfiguration.objects.filter(
                business=business,
                config_type=config_type,
                is_active=True,
            ).exclude(pk=created.pk).update(is_active=False, effective_to=now)
            return created

    @staticmethod
    def store_configuration_response(
        business,
        response_data: dict[str, Any],
        *,
        config_types: list[str] | None = None,
        dry_run: bool = False,
    ) -> list[MRAConfiguration]:
        """Normalize and persist the selected configuration snapshots."""
        ensure_business_eis_enabled(business)
        config_types = ConfigurationService._normalize_config_types(config_types)
        stored: list[MRAConfiguration] = []
        for config_type in config_types:
            config_data = ConfigurationService._extract_config_data(response_data, config_type)
            stored.append(
                ConfigurationService._replace_active_config(
                    business,
                    config_type,
                    config_data,
                    dry_run=dry_run,
                )
            )
            if config_type == 'taxpayer_configuration':
                ConfigurationService._apply_taxpayer_configuration(business, config_data)
        return stored

    @staticmethod
    def _normalize_config_key(key: Any) -> str:
        return ''.join(ch for ch in str(key or '').lower() if ch.isalnum())

    @staticmethod
    def _extract_offline_limit_node(config_data: Any) -> dict[str, Any] | None:
        if not config_data:
            return None

        queue: list[Any] = [config_data]
        while queue:
            current = queue.pop(0)

            if isinstance(current, list):
                queue.extend(current)
                continue

            if not isinstance(current, dict):
                continue

            normalized_map = {
                ConfigurationService._normalize_config_key(key): value
                for key, value in current.items()
            }

            offline_node = normalized_map.get('offlinelimit') or normalized_map.get('offlinelimits')
            if isinstance(offline_node, dict):
                return offline_node

            age_keys = {
                'maxtransactionageinhours',
                'maxofflinetransactionageinhours',
                'maxtransactionage',
            }
            cumulative_keys = {
                'maxcummulativeamount',  # MRA docs spelling
                'maxcumulativeamount',
                'maxofflinecummulativeamount',
                'maxofflinecumulativeamount',
            }
            if age_keys.intersection(normalized_map.keys()) or cumulative_keys.intersection(normalized_map.keys()):
                return current

            for value in current.values():
                if isinstance(value, (dict, list)):
                    queue.append(value)

        return None

    @staticmethod
    def _to_positive_int(value: Any) -> int | None:
        if value in (None, ''):
            return None
        try:
            parsed = int(str(value).strip())
            return parsed if parsed > 0 else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_positive_decimal(value: Any) -> Decimal | None:
        if value in (None, ''):
            return None
        try:
            parsed = Decimal(str(value).strip())
            if not parsed.is_finite() or parsed <= 0:
                return None
            return parsed
        except (TypeError, ValueError, InvalidOperation):
            return None

    @staticmethod
    def get_offline_limits(business) -> OfflineLimitPolicy:
        """
        Resolve offline policy from the latest active MRA configuration.

        Supports the MRA naming variants observed in documentation:
        - maxTransactionAgeInHours
        - maxCummulativeAmount (doc spelling)
        - maxCumulativeAmount
        """
        if not business:
            return OfflineLimitPolicy()

        active_configs = list(
            MRAConfiguration.objects.filter(
                business=business,
                is_active=True,
            ).order_by('-effective_from')
        )
        if not active_configs:
            return OfflineLimitPolicy()

        # Prefer system settings when available, then scan the rest.
        prioritized = sorted(
            active_configs,
            key=lambda cfg: (0 if cfg.config_type == 'system_settings' else 1, -cfg.effective_from.timestamp()),
        )

        for config in prioritized:
            node = ConfigurationService._extract_offline_limit_node(config.config_data)
            if not isinstance(node, dict):
                continue

            normalized_map = {
                ConfigurationService._normalize_config_key(key): value
                for key, value in node.items()
            }
            max_age_hours = (
                ConfigurationService._to_positive_int(normalized_map.get('maxtransactionageinhours'))
                or ConfigurationService._to_positive_int(normalized_map.get('maxofflinetransactionageinhours'))
                or ConfigurationService._to_positive_int(normalized_map.get('maxtransactionage'))
            )
            max_cumulative_amount = (
                ConfigurationService._to_positive_decimal(normalized_map.get('maxcummulativeamount'))
                or ConfigurationService._to_positive_decimal(normalized_map.get('maxcumulativeamount'))
                or ConfigurationService._to_positive_decimal(normalized_map.get('maxofflinecummulativeamount'))
                or ConfigurationService._to_positive_decimal(normalized_map.get('maxofflinecumulativeamount'))
            )

            if max_age_hours is None and max_cumulative_amount is None:
                continue

            return OfflineLimitPolicy(
                max_transaction_age_hours=max_age_hours,
                max_cumulative_amount=max_cumulative_amount,
                source=f"{config.config_type}:{config.config_version}",
            )

        return OfflineLimitPolicy()

    @staticmethod
    def fetch_and_store_configuration(business, config_types=None, terminal=None):
        ensure_business_eis_enabled(business)
        config_types = ConfigurationService._normalize_config_types(config_types)

        sync_log = ConfigurationSyncLog.objects.create(
            business=business,
            status='pending',
            config_types=config_types,
            started_at=timezone.now(),
        )

        try:
            if terminal is not None and terminal.business_id != business.id:
                raise ValueError('The selected terminal does not belong to this business')

            client = MRAEISClient(terminal=terminal)
            if terminal is None:
                terminal = (
                    Terminal.objects.filter(business=business, status='active')
                    .order_by('-updated_at')
                    .first()
                )
                client = MRAEISClient(terminal=terminal)
                if not client.dry_run and terminal is None:
                    raise MRAIntegrationError('An active MRA terminal is required to sync configuration')
            elif not client.dry_run and terminal.status != 'active':
                raise MRAIntegrationError('The selected MRA terminal is not active')

            result = client.call('get_latest_config', payload=None, method='POST', mutating=False)
            response_data = result.data or {}

            if not result.ok and not result.dry_run:
                raise MRAIntegrationError('MRA did not return a valid configuration response')
            response_errors = _extract_mra_response_errors(response_data)
            if response_errors and not result.dry_run:
                raise MRAIntegrationError(f'MRA configuration was rejected: {"; ".join(response_errors)}')
            if not isinstance(response_data, dict) or not response_data:
                raise MRAIntegrationError('MRA returned an empty configuration response')

            self_stored = ConfigurationService.store_configuration_response(
                business,
                response_data,
                config_types=config_types,
                dry_run=result.dry_run,
            )

            sync_log.status = 'success'
            sync_log.completed_at = timezone.now()
            sync_log.save(update_fields=['status', 'completed_at'])
            if terminal is not None:
                terminal.last_sync_at = sync_log.completed_at
                terminal.save(update_fields=['last_sync_at', 'updated_at'])
                TerminalAuditLog.objects.create(
                    terminal=terminal,
                    action='configuration_updated',
                    details={
                        'config_types': config_types,
                        'stored_configurations': [
                            {
                                'config_type': config.config_type,
                                'config_version': config.config_version,
                            }
                            for config in self_stored
                        ],
                        'dry_run': result.dry_run,
                    },
                )
            # Attach non-persistent details for API/command callers without a
            # schema change to the historical sync log table.
            sync_log.stored_configurations = [
                {
                    'config_type': config.config_type,
                    'config_version': config.config_version,
                }
                for config in self_stored
            ]
            return sync_log
        except Exception as exc:
            sync_log.status = 'failed'
            sync_log.error_message = str(exc)
            sync_log.completed_at = timezone.now()
            sync_log.save(update_fields=['status', 'error_message', 'completed_at'])
            raise

    @staticmethod
    def get_active_configuration(business, config_type):
        configs = (
            MRAConfiguration.objects.filter(
                business=business,
                config_type=config_type,
                is_active=True,
            )
            .order_by('-effective_from')
        )

        for config in configs:
            if config.is_current():
                return config
        return None

    @staticmethod
    def configuration_readiness(business, config_types=None) -> dict[str, Any]:
        """Describe whether the local MRA configuration is safe for a sale."""
        required_types = ConfigurationService._normalize_config_types(config_types)
        now = timezone.now()
        max_age_hours = float(getattr(settings, 'MRA_EIS_CONFIG_MAX_AGE_HOURS', 24) or 24)
        cutoff = now - timedelta(hours=max_age_hours)
        missing: list[str] = []
        stale: list[str] = []

        for config_type in required_types:
            config = ConfigurationService.get_active_configuration(business, config_type)
            if config is None:
                missing.append(config_type)
                continue
            fetched_at = config.fetched_from_mra_at
            if fetched_at is None or fetched_at < cutoff:
                stale.append(config_type)

        return {
            'ready': not missing and not stale,
            'required_types': required_types,
            'missing': missing,
            'stale': stale,
            'max_age_hours': max_age_hours,
            'checked_at': now.isoformat(),
        }

    @staticmethod
    def ensure_fresh_configuration(business, terminal=None) -> dict[str, Any]:
        """Refresh MRA configuration before live fiscal sales when required."""
        if (
            not getattr(settings, 'MRA_EIS_IS_LIVE', False)
            or not getattr(settings, 'MRA_EIS_REQUIRE_FRESH_CONFIG_FOR_SALES', False)
        ):
            return {'checked': False, 'reason': 'fresh_configuration_check_disabled'}

        readiness = ConfigurationService.configuration_readiness(business)
        if readiness['ready']:
            return {'checked': True, 'refreshed': False, **readiness}

        try:
            ConfigurationService.fetch_and_store_configuration(
                business,
                config_types=readiness['required_types'],
                terminal=terminal,
            )
        except Exception as exc:
            raise MRAIntegrationError(
                'MRA configuration is missing or stale. Refresh configuration before issuing a fiscal sale.'
            ) from exc

        refreshed = ConfigurationService.configuration_readiness(business, readiness['required_types'])
        if not refreshed['ready']:
            raise MRAIntegrationError(
                'MRA configuration could not be refreshed completely. Fiscal sale blocked until configuration is current.'
            )
        return {'checked': True, 'refreshed': True, **refreshed}


class ProductMappingService:
    """MRA product mapping helpers."""

    @staticmethod
    def _catalog_first(item: dict[str, Any] | None, fields: list[str]) -> Any:
        if not isinstance(item, dict):
            return None
        return TerminalService._dict_get_any(item, *fields)

    @staticmethod
    def _catalog_key(value: Any) -> str:
        return ''.join(str(value or '').strip().upper().split())

    @staticmethod
    def _catalog_decimal(value: Any, decimal_places: str, fallback: Decimal = Decimal('0')) -> Decimal:
        if value in (None, ''):
            return fallback.quantize(Decimal(decimal_places))
        try:
            parsed = Decimal(str(value).replace(',', '').strip())
            if not parsed.is_finite() or parsed < 0:
                return fallback.quantize(Decimal(decimal_places))
            return parsed.quantize(Decimal(decimal_places))
        except (InvalidOperation, TypeError, ValueError):
            return fallback.quantize(Decimal(decimal_places))

    @staticmethod
    def _truthy_catalog_value(value: Any, default: bool = False) -> bool:
        if value in (None, ''):
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float, Decimal)):
            return value != 0
        return str(value).strip().lower() in {'true', '1', 'yes', 'y', 'active', 'approved'}

    @staticmethod
    def _iter_catalog_nodes(value: Any):
        """Yield nested dictionaries while tolerating MRA wrapper variants."""
        queue = [value]
        seen: set[int] = set()
        while queue:
            current = queue.pop(0)
            if isinstance(current, list):
                queue.extend(current)
                continue
            if not isinstance(current, dict):
                continue
            current_id = id(current)
            if current_id in seen:
                continue
            seen.add(current_id)
            yield current
            queue.extend(child for child in current.values() if isinstance(child, (dict, list)))

    @staticmethod
    def _normalize_terminal_site_product(item: dict[str, Any], business=None) -> dict[str, Any] | None:
        """Normalize a product returned by MRA's terminal-site endpoint."""
        code = ProductMappingService._catalog_first(
            item,
            ['code', 'productCode', 'product_code', 'mraProductCode', 'mra_product_code',
             'barCode', 'barcode', 'productId', 'product_id'],
        )
        code = ProductMappingService._catalog_key(code)
        if not code:
            return None

        base = ConfigurationService._normalize_product_catalog_item(item) or {}
        name = str(
            ProductMappingService._catalog_first(
                item,
                ['name', 'productName', 'product_name', 'mraProductName', 'mra_product_name',
                 'description', 'productDescription'],
            )
            or code
        ).strip()[:255] or code
        raw_approved = ProductMappingService._catalog_first(
            item, ['isApproved', 'is_approved', 'approved', 'isActive', 'active', 'approvalStatus', 'status']
        )
        raw_is_product = ProductMappingService._catalog_first(item, ['isProduct', 'is_product'])
        raw_unit = ProductMappingService._catalog_first(
            item, ['unit', 'unitMeasure', 'unit_measure', 'unitOfMeasure', 'mra_unit_measure', 'uom']
        )
        unit_measure = str(raw_unit or base.get('unit_measure') or 'unit').strip().lower()
        unit_measure = {
            'piece': 'unit',
            'pieces': 'unit',
            'litre': 'liter',
            'litres': 'liter',
        }.get(unit_measure, unit_measure)
        if unit_measure not in {'unit', 'kg', 'liter', 'meter', 'box', 'pack', 'bottle', 'can', 'carton'}:
            unit_measure = 'unit'

        return {
            'code': code,
            'display_code': str(code).strip()[:100],
            'name': name,
            'description': str(
                ProductMappingService._catalog_first(item, ['description', 'productDescription', 'product_description'])
                or ''
            ).strip(),
            'tax_type': base.get('default_tax_type') or 'standard',
            'tax_rate': ProductMappingService._catalog_decimal(
                ProductMappingService._catalog_first(item, ['default_tax_rate', 'defaultTaxRate', 'tax_rate', 'taxRate', 'vatRate'])
                if ProductMappingService._catalog_first(item, ['default_tax_rate', 'defaultTaxRate', 'tax_rate', 'taxRate', 'vatRate']) not in (None, '')
                else base.get('default_tax_rate'),
                '0.01',
                Decimal('0.00') if base.get('default_tax_type') in {'zero', 'exempt'} else Decimal('16.50'),
            ),
            'tax_calculation_method': base.get('tax_calculation_method') or 'inclusive',
            'unit_measure': unit_measure,
            'quantity': ProductMappingService._catalog_decimal(
                ProductMappingService._catalog_first(item, ['quantity', 'quantityInStock', 'stockQuantity', 'currentQuantity', 'stock_units']),
                '0.001',
            ),
            'price': ProductMappingService._catalog_decimal(
                ProductMappingService._catalog_first(item, ['price', 'sellingPrice', 'unitPrice', 'retailPrice']),
                '0.01',
            ),
            'minimum_stock': ProductMappingService._catalog_decimal(
                ProductMappingService._catalog_first(item, ['minimumStockLevel', 'minimum_stock_level', 'reorderLevel']),
                '0.001',
            ),
            'is_product': ProductMappingService._truthy_catalog_value(raw_is_product, True),
            'is_approved': ProductMappingService._truthy_catalog_value(raw_approved, True),
            'levies': ProductMappingService.normalize_levies(
                ProductMappingService._catalog_first(
                    item,
                    ['levies', 'activatedLevies', 'activated_levies', 'productLevies', 'product_levies',
                     'levyTypes', 'levy_types', 'levyBreakDown', 'levyBreakdown'],
                ),
                business=business,
            ),
            'raw': item,
        }

    @staticmethod
    def _extract_terminal_site_products(response_data: Any, business=None) -> list[dict[str, Any]]:
        products: dict[str, dict[str, Any]] = {}
        for node in ProductMappingService._iter_catalog_nodes(response_data):
            normalized = ProductMappingService._normalize_terminal_site_product(node, business=business)
            if normalized:
                products.setdefault(normalized['code'], normalized)
        return list(products.values())

    @staticmethod
    def _extract_warehouse_stocks(response_data: Any) -> list[dict[str, Any]]:
        if isinstance(response_data, dict) and isinstance(response_data.get('raw'), list):
            response_data = response_data['raw']
        if isinstance(response_data, list):
            return [row for row in response_data if isinstance(row, dict)]
        if not isinstance(response_data, dict):
            return []

        direct_data = response_data.get('data')
        if isinstance(direct_data, list):
            return [row for row in direct_data if isinstance(row, dict)]

        data = ConfigurationService._unwrap_response_data(response_data)
        if isinstance(data, dict):
            for key in (
                'stocks', 'stock', 'items', 'products', 'results',
                'warehouseInventory', 'warehouse_inventory',
            ):
                value = data.get(key)
                if isinstance(value, list):
                    return [row for row in value if isinstance(row, dict)]
        return []

    @staticmethod
    def _inventory_status(quantity: Decimal, reorder_level: Decimal) -> str:
        if quantity <= 0:
            return 'Out of Stock'
        if reorder_level > 0 and quantity <= reorder_level:
            return 'Low Stock'
        return 'In Stock'

    @staticmethod
    def _find_inventory_item_for_catalog_product(business, branch, product: dict[str, Any]):
        from inventory.models import InventoryItem

        display_code = str(product.get('display_code') or product.get('code') or '').strip()
        name = str(product.get('name') or '').strip()
        for field in ('product_code', 'barcode', 'sku'):
            for candidate in (display_code, product.get('code')):
                if not candidate:
                    continue
                item = InventoryItem.objects.filter(
                    business=business,
                    branch=branch,
                    **{field: str(candidate).strip()},
                ).first()
                if item:
                    return item, field
        if name:
            item = InventoryItem.objects.filter(
                business=business,
                branch=branch,
                name__iexact=name,
            ).first()
            if item:
                return item, 'name'
        return None, ''

    @staticmethod
    def _update_branch_site_mapping(branch, site_id: str, source: str = 'terminal-site-products') -> None:
        if not branch or not site_id:
            return
        site_id = str(site_id).strip()
        fields = []
        if not getattr(branch, 'mra_site_id', ''):
            branch.mra_site_id = site_id
            fields.append('mra_site_id')
        if not getattr(branch, 'mra_branch_code', ''):
            branch.mra_branch_code = site_id
            fields.append('mra_branch_code')
        if not getattr(branch, 'mra_site_name', ''):
            branch.mra_site_name = branch.name
            fields.append('mra_site_name')
        if getattr(branch, 'eis_mapping_source', '') != source:
            branch.eis_mapping_source = source
            fields.append('eis_mapping_source')
        if fields:
            branch.eis_mapping_updated_at = timezone.now()
            fields.extend(['eis_mapping_updated_at', 'updated_at'])
            branch.save(update_fields=list(dict.fromkeys(fields)))

    @staticmethod
    def sync_terminal_site_products(business, terminal: Terminal | None = None) -> dict[str, Any]:
        """Fetch the portal-approved products available at a terminal site."""
        ensure_business_eis_enabled(business)
        if terminal is None:
            terminal = Terminal.objects.filter(
                business=business,
                status='active',
            ).order_by('-updated_at').first()
        if terminal is None:
            raise ValueError('An active MRA terminal is required before fetching site products.')
        if terminal.business_id != business.id:
            raise ValueError('Terminal does not belong to this business')
        if terminal.status != 'active':
            raise ValueError('Terminal must be active before fetching site products')

        site_id = ConfigurationService.get_terminal_site_id(business, terminal.branch)
        payload = {'tin': str(getattr(business, 'tin', '') or ''), 'siteId': site_id}
        result = MRAEISClient(terminal=terminal).call(
            'get_terminal_site_products',
            payload=payload,
            method='POST',
            mutating=False,
        )
        response_data = result.data or {}
        response_errors = _extract_mra_response_errors(response_data)
        if response_errors and not result.dry_run:
            raise MRAIntegrationError(
                f'MRA rejected terminal site product sync: {"; ".join(response_errors)}',
                status_code=result.status_code,
                endpoint=result.endpoint,
                endpoint_key='get_terminal_site_products',
                response_data=response_data,
            )

        config_data = response_data if isinstance(response_data, dict) else {'items': response_data}
        ConfigurationService._replace_active_config(
            business,
            'product_codes',
            config_data,
            dry_run=result.dry_run,
        )
        ConfigurationService._replace_active_config(
            business,
            'terminal_site_products',
            config_data,
            dry_run=result.dry_run,
        )

        response_site_id = TerminalService._find_nested_value(
            config_data,
            'siteId', 'siteID', 'site_id', 'terminalSiteId', 'terminal_site_id',
        )
        ProductMappingService._update_branch_site_mapping(
            terminal.branch,
            str(response_site_id or site_id or '').strip(),
        )
        terminal.last_sync_at = timezone.now()
        terminal.save(update_fields=['last_sync_at', 'updated_at'])
        return {
            'synced': True,
            'dry_run': result.dry_run,
            'endpoint': result.endpoint,
            'request_payload': payload,
            'product_count': len(ProductMappingService._extract_terminal_site_products(config_data, business)),
            'response': response_data,
        }

    @staticmethod
    @transaction.atomic
    def pull_approved_products_to_inventory(
        *,
        business,
        terminal: Terminal,
        user=None,
        refresh_from_mra: bool = True,
    ) -> dict[str, Any]:
        """Materialize MRA-approved site products as local POS sellable items."""
        ensure_business_eis_enabled(business)
        if not terminal or terminal.business_id != business.id:
            raise ValueError('An active MRA terminal is required')
        if terminal.status != 'active':
            raise ValueError('Terminal must be active before pulling approved products')
        if not terminal.branch_id:
            raise ValueError('Terminal must be linked to a branch before pulling approved products')

        product_sync = (
            ProductMappingService.sync_terminal_site_products(business, terminal)
            if refresh_from_mra else None
        )
        active_config = ConfigurationService.get_active_configuration(
            business, 'terminal_site_products'
        ) or ConfigurationService.get_active_configuration(business, 'product_codes')
        config_data = active_config.config_data if active_config else {}
        products = [
            product
            for product in ProductMappingService._extract_terminal_site_products(
                config_data,
                business,
            )
            if product.get('is_approved') and product.get('is_product', True)
        ]
        from inventory.models import InventoryItem, MRAProductMapping as InventoryMRAProductMapping

        branch = terminal.branch
        created_count = 0
        updated_count = 0
        mappings_created = 0
        mappings_updated = 0
        imported_items = []
        now = timezone.now()

        for product in products:
            item, match_reason = ProductMappingService._find_inventory_item_for_catalog_product(
                business, branch, product
            )
            display_code = str(product.get('display_code') or product.get('code') or '').strip()[:100]
            quantity = product.get('quantity') or Decimal('0.000')
            reorder_level = product.get('minimum_stock') or Decimal('0.000')
            existing_cost = getattr(item, 'cost', None) if item else None
            item_data = {
                'business': business,
                'branch': branch,
                'name': str(product.get('name') or display_code).strip()[:255] or display_code,
                'category': 'EIS Products',
                'item_type': 'sellable',
                'stock_units': quantity,
                'unit_type': str(product.get('unit_measure') or 'unit')[:50] or 'unit',
                'reorder_level': reorder_level,
                'status': ProductMappingService._inventory_status(quantity, reorder_level),
                'price': product.get('price') or Decimal('0.00'),
                'value': (quantity * (existing_cost or Decimal('0.00'))).quantize(Decimal('0.01')),
                'barcode': display_code,
                'sku': display_code,
                'price_locked': True,
                'tax_locked': True,
                'is_dirty': False,
            }
            if item is None:
                if not InventoryItem.objects.filter(product_code=display_code).exists():
                    item_data['product_code'] = display_code
                item = InventoryItem.objects.create(**item_data)
                created_count += 1
            else:
                if not InventoryItem.objects.filter(product_code=display_code).exclude(id=item.id).exists():
                    item_data['product_code'] = display_code
                for field, value in item_data.items():
                    if field not in {'business', 'branch'}:
                        setattr(item, field, value)
                item.save()
                updated_count += 1

            mapping, created = InventoryMRAProductMapping.objects.update_or_create(
                inventory_item=item,
                defaults={
                    'branch': branch,
                    'mra_product_code': display_code,
                    'mra_product_name': str(product.get('name') or item.name)[:255],
                    'mra_tax_type': product.get('tax_type') or 'standard',
                    'mra_tax_rate': product.get('tax_rate') or Decimal('16.50'),
                    'mra_unit_measure': product.get('unit_measure') or 'unit',
                    'tax_calculation_method': product.get('tax_calculation_method') or 'inclusive',
                    'mra_levies': product.get('levies') or [],
                    'is_approved': True,
                    'approved_at': getattr(mapping, 'approved_at', None) if not created else now,
                    'mra_synced': True,
                    'last_synced_at': now,
                },
            )
            if created:
                mappings_created += 1
            else:
                mappings_updated += 1
            imported_items.append({
                'id': str(item.id),
                'name': item.name,
                'mra_product_code': mapping.mra_product_code,
                'stock_units': str(item.stock_units),
                'price': str(item.price or ''),
                'created': created,
                'match_reason': match_reason or 'created',
            })

        terminal.last_sync_at = now
        terminal.save(update_fields=['last_sync_at', 'updated_at'])
        return {
            'pulled': True,
            'product_count': len(products),
            'created': created_count,
            'updated': updated_count,
            'mappings_created': mappings_created,
            'mappings_updated': mappings_updated,
            'branch_id': str(branch.id),
            'product_sync': product_sync,
            'inventory_items': imported_items,
        }

    @staticmethod
    def fetch_warehouse_inventory(
        *,
        business,
        terminal: Terminal | None = None,
        page_size: int = 200,
        max_pages: int = 25,
    ) -> dict[str, Any]:
        """Fetch paginated official EIS warehouse stock."""
        ensure_business_eis_enabled(business)
        if terminal is None:
            terminal = Terminal.objects.filter(
                business=business,
                status='active',
            ).order_by('-updated_at').first()
        if terminal is None:
            raise ValueError('An active MRA terminal is required before reading warehouse stock')

        client = MRAEISClient(terminal=terminal)
        all_stocks: list[dict[str, Any]] = []
        responses: list[Any] = []
        endpoint = ''
        dry_run = False
        for page in range(1, max_pages + 1):
            result = client.call(
                'warehouse_inventory',
                payload=None,
                method='GET',
                mutating=False,
                params={'page': page, 'pageSize': page_size},
            )
            dry_run = result.dry_run
            endpoint = result.endpoint
            response_data = result.data or {}
            responses.append(response_data)
            stocks = ProductMappingService._extract_warehouse_stocks(response_data)
            all_stocks.extend(stocks)
            if dry_run:
                break
            data = ConfigurationService._unwrap_response_data(response_data)
            total = data.get('total') if isinstance(data, dict) else 0
            response_page_size = data.get('pageSize', page_size) if isinstance(data, dict) else page_size
            try:
                total_value = int(total or 0)
                page_size_value = int(response_page_size or page_size)
                has_reached_total = total_value > 0 and page * page_size_value >= total_value
                has_reached_short_page = total_value <= 0 and len(stocks) < page_size_value
                if not stocks or has_reached_total or has_reached_short_page:
                    break
            except (TypeError, ValueError):
                if not stocks:
                    break

        return {
            'dry_run': dry_run,
            'endpoint': endpoint,
            'stock_count': len(all_stocks),
            'stocks': all_stocks,
            'responses': responses,
        }

    @staticmethod
    def _normalize_inventory_transfer_items(items: Any) -> list[dict[str, Any]]:
        if not isinstance(items, list):
            raise ValueError('Transfer items must be a list.')
        normalized = []
        for index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise ValueError(f'Transfer item {index} must be an object.')
            barcode = str(
                item.get('barcode') or item.get('barCode') or item.get('productCode') or item.get('product_code') or ''
            ).strip()
            if not barcode:
                raise ValueError(f'Transfer item {index} is missing barcode.')
            quantity = ProductMappingService._catalog_decimal(item.get('quantity'), '0.001')
            if quantity <= 0:
                raise ValueError(f'Transfer item {index} quantity must be greater than zero.')
            transfer_item = {'barcode': barcode, 'quantity': float(quantity)}
            if item.get('price') not in (None, ''):
                price = ProductMappingService._catalog_decimal(item.get('price'), '0.01')
                transfer_item['price'] = float(price)
            normalized.append(transfer_item)
        if not normalized:
            raise ValueError('At least one transfer item is required.')
        return normalized

    @staticmethod
    def transfer_inventory(
        *,
        business,
        terminal: Terminal,
        items: Any,
        to_branch=None,
        to_site_id: str = '',
        from_site_id: str = '',
        from_warehouse_to_site: bool = True,
    ) -> dict[str, Any]:
        """Submit a warehouse-to-site or site-to-site EIS stock transfer."""
        ensure_business_eis_enabled(business)
        if not terminal or terminal.business_id != business.id or terminal.status != 'active':
            raise ValueError('An active MRA terminal is required before transferring stock')
        normalized_items = ProductMappingService._normalize_inventory_transfer_items(items)
        target_site_id = str(to_site_id or '').strip()
        if not target_site_id and to_branch is not None:
            target_site_id = str(
                getattr(to_branch, 'mra_site_id', '') or getattr(to_branch, 'mra_branch_code', '') or ''
            ).strip()
        if not target_site_id:
            raise ValueError('Destination MRA site ID is required for inventory transfer.')
        source_site_id = str(from_site_id or '').strip()
        if not from_warehouse_to_site and not source_site_id:
            raise ValueError('Source MRA site ID is required for site-to-site transfer.')

        payload = {
            'fromWarehouseToSite': bool(from_warehouse_to_site),
            'fromSiteId': None if from_warehouse_to_site else source_site_id,
            'toSiteId': target_site_id,
            'items': normalized_items,
        }
        result = MRAEISClient(terminal=terminal).call(
            'transfer_inventory',
            payload=payload,
            method='POST',
            mutating=True,
        )
        response_data = result.data or {}
        response_errors = _extract_mra_response_errors(response_data)
        if response_errors and not result.dry_run:
            raise MRAIntegrationError(
                f'MRA rejected inventory transfer: {"; ".join(response_errors)}',
                status_code=result.status_code,
                endpoint=result.endpoint,
                endpoint_key='transfer_inventory',
                response_data=response_data,
            )
        terminal.last_sync_at = timezone.now()
        terminal.save(update_fields=['last_sync_at', 'updated_at'])
        return {
            'submitted': True,
            'dry_run': result.dry_run,
            'endpoint': result.endpoint,
            'status_code': result.status_code,
            'payload': payload,
            'response': response_data,
            'errors': response_errors,
        }

    @staticmethod
    def reconcile_inventory_with_eis(
        *,
        business,
        terminal: Terminal | None = None,
        branch=None,
        quantity_tolerance: Decimal = Decimal('0.001'),
    ) -> dict[str, Any]:
        """Compare approved local POS mappings with the official EIS stock feed.

        This is intentionally read-only. EIS remains the source of truth for
        the comparison, while local inventory is left untouched until staff
        investigate any differences.
        """
        ensure_business_eis_enabled(business)
        from inventory.models import MRAProductMapping as InventoryMRAProductMapping

        if terminal is None:
            terminal = (
                Terminal.objects.filter(business=business, status='active')
                .select_related('branch')
                .order_by('-updated_at')
                .first()
            )
        if terminal is None:
            raise ValueError('An active MRA terminal is required before reconciling inventory')
        if terminal.business_id != business.id or terminal.status != 'active':
            raise ValueError('An active MRA terminal belonging to this business is required')
        if branch is None:
            branch = terminal.branch

        warehouse = ProductMappingService.fetch_warehouse_inventory(
            business=business,
            terminal=terminal,
        )

        def stock_code(stock: dict[str, Any]) -> str:
            return ProductMappingService._catalog_key(
                ProductMappingService._catalog_first(
                    stock,
                    [
                        'barcode', 'barCode', 'productCode', 'product_code',
                        'mraProductCode', 'mra_product_code',
                    ],
                )
            )

        def stock_quantity(stock: dict[str, Any]) -> Decimal:
            return ProductMappingService._catalog_decimal(
                ProductMappingService._catalog_first(
                    stock,
                    [
                        'currentQuantity', 'current_quantity', 'quantityInStock',
                        'quantity_in_stock', 'stockQuantity', 'quantity', 'stock_units',
                    ],
                ),
                '0.001',
            )

        def stock_name(stock: dict[str, Any], fallback: str = '') -> str:
            return str(
                ProductMappingService._catalog_first(
                    stock,
                    ['productName', 'product_name', 'name', 'description', 'productDescription'],
                )
                or fallback
            ).strip()

        remote_by_code: dict[str, dict[str, Any]] = {}
        for stock in warehouse.get('stocks') or []:
            if not isinstance(stock, dict):
                continue
            code = stock_code(stock)
            if code:
                remote_by_code[code] = stock

        mappings = InventoryMRAProductMapping.objects.select_related('inventory_item').filter(
            inventory_item__business=business,
            is_approved=True,
            mra_synced=True,
        )
        if branch is not None:
            mappings = mappings.filter(inventory_item__branch=branch)

        matched: list[dict[str, Any]] = []
        quantity_mismatches: list[dict[str, Any]] = []
        missing_in_eis: list[dict[str, Any]] = []
        local_codes: set[str] = set()

        for mapping in mappings:
            item = mapping.inventory_item
            code = ProductMappingService._catalog_key(
                mapping.mra_product_code or item.barcode or item.product_code
            )
            if not code:
                continue
            local_codes.add(code)
            local_quantity = ProductMappingService._catalog_decimal(
                item.stock_units,
                '0.001',
            )
            row = {
                'inventory_item_id': str(item.id),
                'name': item.name,
                'mra_product_code': mapping.mra_product_code,
                'local_quantity': str(local_quantity),
                'branch_id': str(item.branch_id or ''),
            }
            remote = remote_by_code.get(code)
            if remote is None:
                missing_in_eis.append(row)
                continue

            remote_quantity = stock_quantity(remote)
            difference = (local_quantity - remote_quantity).quantize(Decimal('0.001'))
            row.update({
                'remote_quantity': str(remote_quantity),
                'difference': str(difference),
                'remote_name': stock_name(remote, item.name),
            })
            if abs(difference) > quantity_tolerance:
                quantity_mismatches.append(row)
            else:
                matched.append(row)

        missing_in_pos: list[dict[str, Any]] = []
        for code, remote in remote_by_code.items():
            if code in local_codes:
                continue
            missing_in_pos.append({
                'mra_product_code': stock_code(remote) or code,
                'name': stock_name(remote),
                'remote_quantity': str(stock_quantity(remote)),
            })

        return {
            'reconciled': True,
            'dry_run': bool(warehouse.get('dry_run')),
            'terminal_id': str(terminal.id),
            'branch_id': str(branch.id) if branch else None,
            'warehouse_stock_count': len(remote_by_code),
            'matched_count': len(matched),
            'quantity_mismatch_count': len(quantity_mismatches),
            'missing_in_eis_count': len(missing_in_eis),
            'missing_in_pos_count': len(missing_in_pos),
            'matched': matched,
            'quantity_mismatches': quantity_mismatches,
            'missing_in_eis': missing_in_eis,
            'missing_in_pos': missing_in_pos,
            'endpoint': warehouse.get('endpoint', ''),
        }

    @staticmethod
    def _levy_identity(node: dict[str, Any] | Any) -> str:
        if not isinstance(node, dict):
            return str(node or '').strip()
        return str(
            ProductMappingService._catalog_first(
                node,
                [
                    'levyTypeId', 'levy_type_id', 'levyId', 'levy_id',
                    'typeId', 'type_id', 'id', 'code', 'levyCode', 'levy_code', 'name',
                ],
            )
            or ''
        ).strip()

    @staticmethod
    def _levy_rate(node: dict[str, Any] | Any) -> Decimal | None:
        if not isinstance(node, dict):
            return None
        raw_rate = ProductMappingService._catalog_first(
            node,
            ['levyRate', 'levy_rate', 'rate', 'levyPercentage', 'levy_percentage', 'percentage'],
        )
        if raw_rate in (None, ''):
            return None
        try:
            rate = Decimal(str(raw_rate).replace('%', '').strip())
            if not rate.is_finite() or rate < 0:
                return None
            return rate.quantize(Decimal('0.01'))
        except (InvalidOperation, TypeError, ValueError):
            return None

    @staticmethod
    def _active_configuration_data(business, config_type: str) -> dict[str, Any]:
        config = ConfigurationService.get_active_configuration(business, config_type)
        return config.config_data if config and isinstance(config.config_data, dict) else {}

    @staticmethod
    def _configured_levy_lookup(business) -> dict[str, dict[str, Any]]:
        """Index rates from MRA's saved taxpayer/global configuration."""
        if not business:
            return {}

        taxpayer_config = ProductMappingService._active_configuration_data(
            business, 'taxpayer_configuration'
        )
        global_config = ProductMappingService._active_configuration_data(
            business, 'global_configuration'
        )
        candidates: list[Any] = []
        if isinstance(taxpayer_config, dict):
            taxpayer_levies = ProductMappingService._catalog_first(
                taxpayer_config,
                ['activatedLevies', 'activated_levies', 'levies'],
            )
            candidates.append(taxpayer_levies)
        if isinstance(global_config, dict):
            global_levies = ProductMappingService._catalog_first(
                global_config,
                ['levies', 'levyTypes', 'levy_types'],
            )
            candidates.append(global_levies)

        lookup: dict[str, dict[str, Any]] = {}
        queue: list[Any] = [candidate for candidate in candidates if candidate not in (None, '')]
        while queue:
            current = queue.pop(0)
            if isinstance(current, list):
                queue.extend(current)
                continue
            if not isinstance(current, dict):
                continue

            nested = ProductMappingService._catalog_first(
                current,
                ['activatedLevies', 'activated_levies', 'levies', 'levyTypes', 'levy_types', 'items', 'data'],
            )
            if isinstance(nested, (list, dict)):
                queue.append(nested)

            levy_id = ProductMappingService._levy_identity(current)
            if not levy_id:
                continue
            levy_rate = ProductMappingService._levy_rate(current)
            lookup[levy_id.upper()] = {
                'levyTypeId': levy_id,
                'levyRate': levy_rate or Decimal('0.00'),
            }
        return lookup

    @staticmethod
    def normalize_levies(raw_levies: Any, business=None) -> list[dict[str, Any]]:
        """Normalize MRA levy rows without inventing a local levy rate."""
        if raw_levies in (None, ''):
            return []

        configured = ProductMappingService._configured_levy_lookup(business)
        queue: list[Any] = [raw_levies]
        normalized: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        while queue:
            current = queue.pop(0)
            if current in (None, ''):
                continue
            if isinstance(current, list):
                queue.extend(current)
                continue
            if isinstance(current, dict):
                nested = ProductMappingService._catalog_first(
                    current,
                    [
                        'levies', 'activatedLevies', 'activated_levies',
                        'productLevies', 'product_levies', 'levyTypes', 'levy_types',
                        'levyBreakDown', 'levyBreakdown', 'items', 'data',
                    ],
                )
                if isinstance(nested, (list, dict)):
                    queue.append(nested)

            levy_id = ProductMappingService._levy_identity(current)
            if not levy_id:
                continue
            configured_node = configured.get(levy_id.upper()) or {}
            levy_rate = ProductMappingService._levy_rate(current)
            if levy_rate is None:
                levy_rate = ProductMappingService._levy_rate(configured_node)
            if levy_rate is None:
                levy_rate = Decimal('0.00')

            key = (levy_id.upper(), str(levy_rate))
            if key in seen:
                continue
            seen.add(key)
            normalized.append({
                'levyTypeId': levy_id,
                'levyRate': float(levy_rate),
            })

        return normalized

    @staticmethod
    def get_activated_levies(business) -> list[dict[str, Any]]:
        taxpayer_config = ProductMappingService._active_configuration_data(
            business, 'taxpayer_configuration'
        )
        raw_levies = ProductMappingService._catalog_first(
            taxpayer_config,
            ['activatedLevies', 'activated_levies', 'levies'],
        )
        return ProductMappingService.normalize_levies(raw_levies, business=business)

    @staticmethod
    def apply_catalog_defaults(business, mapping_data: dict[str, Any]) -> dict[str, Any]:
        """Validate and enrich an inventory mapping from MRA's catalog.

        A local mapping can still be created for non-EIS businesses and for
        test/offline setups without a synced catalog. Once a business has EIS
        enabled and a catalog is available, the selected MRA code is the
        authority for the product name and any tax/unit fields MRA supplied.
        Live/strict mode additionally requires a synced catalog and rejects
        unknown or missing codes.
        """
        data = dict(mapping_data or {})
        code = str(data.get('mra_product_code') or '').strip().upper()
        data['mra_product_code'] = code

        if not is_business_eis_enabled(business):
            return data

        strict = bool(getattr(settings, 'MRA_EIS_STRICT_PRODUCT_CODES', False))
        catalog, _config = ConfigurationService.get_product_catalog(business)
        if not catalog:
            if strict:
                raise MRAIntegrationError(
                    'No active MRA product catalog is available. Sync MRA configuration before mapping products.'
                )
            return data

        if not code:
            if strict:
                raise MRAIntegrationError(
                    'An MRA product code selected from the synced catalog is required.'
                )
            return data

        catalog_product = next((product for product in catalog if product['code'] == code), None)
        if not catalog_product:
            if strict:
                raise MRAIntegrationError(
                    f'MRA product code {code} is not present in the active terminal catalog.'
                )
            return data

        # The portal mapping is authoritative. Do not let a stale local form
        # replace values that MRA returned for the selected code.
        data['mra_product_code'] = catalog_product['code']
        data['mra_product_name'] = catalog_product['name']
        if catalog_product.get('_tax_type_provided'):
            data['mra_tax_type'] = catalog_product['default_tax_type']
        if catalog_product.get('_tax_rate_provided'):
            data['mra_tax_rate'] = Decimal(str(catalog_product['default_tax_rate'])).quantize(
                Decimal('0.01')
            )
        if catalog_product.get('_unit_measure_provided'):
            unit_measure = catalog_product.get('unit_measure')
            allowed_units = {
                'unit', 'kg', 'liter', 'meter', 'box', 'pack', 'bottle', 'can', 'carton'
            }
            if unit_measure in allowed_units:
                data['mra_unit_measure'] = unit_measure
        if catalog_product.get('_calculation_method_provided'):
            data['tax_calculation_method'] = catalog_product['tax_calculation_method']
        data['mra_levies'] = ProductMappingService.normalize_levies(
            catalog_product.get('levies'),
            business=business,
        )

        if data.get('mra_tax_type') in {'zero', 'exempt'}:
            data['mra_tax_rate'] = Decimal('0.00')
            data['tax_calculation_method'] = 'inclusive'
        return data

    @staticmethod
    def create_product_mapping(
        business,
        inventory_item_id,
        product_name,
        mra_product_code,
        mra_product_name,
        tax_category,
        approved_price,
        tax_rate,
    ):
        return MRAProductMapping.objects.create(
            business=business,
            inventory_item_id=inventory_item_id,
            product_name=product_name,
            mra_product_code=mra_product_code,
            mra_product_name=mra_product_name,
            tax_category=tax_category,
            approved_price=approved_price,
            tax_rate=tax_rate,
            is_approved=True,
            approved_at=timezone.now(),
        )

    @staticmethod
    def get_product_mapping(business, inventory_item_id):
        return MRAProductMapping.objects.filter(
            business=business,
            inventory_item_id=inventory_item_id,
            is_active=True,
            is_approved=True,
        ).first()

    @staticmethod
    def validate_product_for_sale(business, inventory_item_id):
        mapping = ProductMappingService.get_product_mapping(business, inventory_item_id)
        if not mapping:
            raise ValueError(f'Product {inventory_item_id} is not MRA-approved for sale')
        return mapping

    @staticmethod
    @transaction.atomic
    def sync_inventory_mapping_to_mra(inventory_mapping, terminal: Terminal | None = None) -> dict[str, Any]:
        """
        Sync inventory app mapping to MRA utilities endpoint.

        In dry-run mode this marks mapping as prepared and synced locally.
        """
        ensure_business_eis_enabled(inventory_mapping.inventory_item.business)
        business = inventory_mapping.inventory_item.business
        if terminal is not None and terminal.business_id != business.id:
            raise MRAIntegrationError('The selected MRA terminal does not belong to this business.')

        client = MRAEISClient(terminal=terminal)
        if not client.dry_run:
            if terminal is None or terminal.status != 'active':
                raise MRAIntegrationError('An active MRA terminal is required to sync a product mapping.')
            if not str(terminal.mra_terminal_id or '').strip():
                raise MRAIntegrationError('The active MRA terminal is missing its MRA terminal ID.')

        normalized_data = ProductMappingService.apply_catalog_defaults(
            business,
            {
                'mra_product_code': inventory_mapping.mra_product_code,
                'mra_product_name': inventory_mapping.mra_product_name,
                'mra_tax_type': inventory_mapping.mra_tax_type,
                'mra_tax_rate': inventory_mapping.mra_tax_rate,
                'mra_unit_measure': inventory_mapping.mra_unit_measure,
                'tax_calculation_method': inventory_mapping.tax_calculation_method,
                'mra_levies': inventory_mapping.mra_levies or [],
            },
        )
        if normalized_data != {
            'mra_product_code': inventory_mapping.mra_product_code,
            'mra_product_name': inventory_mapping.mra_product_name,
            'mra_tax_type': inventory_mapping.mra_tax_type,
            'mra_tax_rate': inventory_mapping.mra_tax_rate,
            'mra_unit_measure': inventory_mapping.mra_unit_measure,
            'tax_calculation_method': inventory_mapping.tax_calculation_method,
            'mra_levies': inventory_mapping.mra_levies or [],
        }:
            inventory_mapping.mra_product_code = normalized_data['mra_product_code']
            inventory_mapping.mra_product_name = normalized_data['mra_product_name']
            inventory_mapping.mra_tax_type = normalized_data['mra_tax_type']
            inventory_mapping.mra_tax_rate = normalized_data['mra_tax_rate']
            inventory_mapping.mra_unit_measure = normalized_data['mra_unit_measure']
            inventory_mapping.tax_calculation_method = normalized_data['tax_calculation_method']
            inventory_mapping.mra_levies = normalized_data.get('mra_levies') or []
            inventory_mapping.mra_synced = False
            inventory_mapping.save(update_fields=[
                'mra_product_code', 'mra_product_name', 'mra_tax_type',
                'mra_tax_rate', 'mra_unit_measure', 'tax_calculation_method',
                'mra_levies',
                'mra_synced', 'updated_at',
            ])

        payload = {
            'terminalId': terminal.mra_terminal_id if terminal else '',
            'items': [
                {
                    'inventoryItemId': str(inventory_mapping.inventory_item_id),
                    'name': inventory_mapping.mra_product_name,
                    'productCode': inventory_mapping.mra_product_code,
                    'taxType': inventory_mapping.mra_tax_type,
                    'taxRate': str(inventory_mapping.mra_tax_rate),
                    'unitMeasure': inventory_mapping.mra_unit_measure,
                    'calculationMethod': inventory_mapping.tax_calculation_method,
                    'levies': inventory_mapping.mra_levies or [],
                }
            ],
        }

        result = client.call('save_inventory_items', payload=payload, method='POST', mutating=True)
        response_errors = _extract_mra_response_errors(result.data)
        if (not result.ok and not result.dry_run) or (response_errors and not result.dry_run):
            detail = '; '.join(response_errors) if response_errors else 'MRA rejected the product mapping.'
            raise MRAIntegrationError(detail)

        inventory_mapping.mra_synced = True
        inventory_mapping.last_synced_at = timezone.now()
        inventory_mapping.save(update_fields=['mra_synced', 'last_synced_at', 'updated_at'])

        return {
            'mapping_id': str(inventory_mapping.id),
            'mra_product_code': inventory_mapping.mra_product_code,
            'synced': True,
            'dry_run': result.dry_run,
            'endpoint': result.endpoint,
            'response': result.data,
        }


class InvoiceService:
    """Invoice creation and MRA submission for standalone MRAInvoice flow."""

    @staticmethod
    def _to_json_safe(value: Any) -> Any:
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, list):
            return [InvoiceService._to_json_safe(item) for item in value]
        if isinstance(value, dict):
            return {key: InvoiceService._to_json_safe(val) for key, val in value.items()}
        return value

    @staticmethod
    def _resolve_signature_secret(terminal: Terminal | None) -> str:
        secret = str(getattr(settings, 'MRA_EIS_SECRET_KEY', '') or '').strip()
        if secret:
            return secret

        # Fallback for non-live/dev mode installations where terminal secrets may
        # be provisioned locally.
        terminal_secret = str(getattr(terminal, 'mra_api_key', '') or '').strip()
        if terminal_secret:
            return terminal_secret

        if getattr(settings, 'MRA_EIS_IS_LIVE', False):
            raise MRAIntegrationError('Offline signature secret is missing for live mode.')
        return ''

    @staticmethod
    def _build_signature_payload(invoice: MRAInvoice) -> dict[str, Any]:
        gross_amount = Decimal(str(invoice.gross_amount or 0)).quantize(Decimal('0.01'))
        return {
            'invoiceNumber': str(invoice.invoice_number),
            'terminalId': invoice.terminal.mra_terminal_id,
            'sellerTin': invoice.seller_tin,
            'invoiceDate': invoice.invoice_date.isoformat(),
            'grossAmount': format(gross_amount, 'f'),
            'items': invoice.items,
        }

    @staticmethod
    def verify_invoice_hash(invoice: MRAInvoice) -> bool:
        """
        Validate stored invoice signature/hash against canonical invoice data.

        - Online invoice: deterministic SHA256 generated by MRAInvoice.generate_signature()
        - Offline invoice: HMAC/SHA256 signature generated from offline payload + secret policy
        """
        current_signature = str(invoice.invoice_signature or '').strip()
        if not current_signature:
            return False

        if invoice.is_online:
            expected_signature = str(invoice.generate_signature() or '').strip()
        else:
            stored_response = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
            stored_payload = stored_response.get('payload') if isinstance(stored_response.get('payload'), dict) else {}
            stored_signature_payload = (
                stored_payload.get('handyPosMetadata', {}).get('offlineSignaturePayload')
                if isinstance(stored_payload.get('handyPosMetadata'), dict)
                else None
            )
            payload = (
                stored_signature_payload
                if isinstance(stored_signature_payload, dict)
                else InvoiceService._build_signature_payload(invoice)
            )
            expected_signature = str(
                InvoiceService._build_offline_signature(payload, invoice.terminal) or ''
            ).strip()

        if not expected_signature:
            return False

        return hmac.compare_digest(current_signature, expected_signature)

    @staticmethod
    def _build_offline_signature(payload: dict[str, Any], terminal: Terminal | None) -> str:
        canonical_payload = json.dumps(payload, separators=(',', ':'), sort_keys=True, default=str)
        secret = InvoiceService._resolve_signature_secret(terminal)
        if secret:
            return hmac.new(secret.encode('utf-8'), canonical_payload.encode('utf-8'), hashlib.sha256).hexdigest()
        # Fallback for dev mode only.
        return hashlib.sha256(canonical_payload.encode('utf-8')).hexdigest()

    @staticmethod
    def _coerce_datetime(value: Any):
        if hasattr(value, 'date') and hasattr(value, 'isoformat'):
            return value if timezone.is_aware(value) else timezone.make_aware(value)
        parsed = parse_datetime(str(value or '')) if value else None
        if parsed is None:
            return timezone.now()
        return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed)

    @staticmethod
    def _base10_to_mra_base64(value: Any) -> str:
        """Encode MRA numeric identifiers using its unpadded base-64 alphabet."""
        chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
        number = int(value or 0)
        if number <= 0:
            return 'A'
        encoded = ''
        while number:
            number, remainder = divmod(number, 64)
            encoded = chars[remainder] + encoded
        return encoded

    @staticmethod
    def _mra_base64_to_base10(value: Any) -> int:
        chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
        result = 0
        for char in str(value or '').strip():
            if char not in chars:
                raise ValueError('Invalid MRA base64 digit')
            result = result * 64 + chars.index(char)
        return result

    @staticmethod
    def _to_julian_date(value: Any) -> int:
        date_value = InvoiceService._coerce_datetime(value).date()
        year = date_value.year
        month = date_value.month
        day = date_value.day
        if month <= 2:
            year -= 1
            month += 12
        century = year // 100
        correction = 2 - century + (century // 4)
        return int(
            (365.25 * (year + 4716)) // 1
            + (30.6001 * (month + 1)) // 1
            + day
            + correction
            - 1524
        )

    @staticmethod
    def _format_fiscal_invoice_number(
        terminal: Terminal,
        *,
        julian_date: int,
        sequence: int,
        is_online: bool,
    ) -> str:
        taxpayer_id = int(getattr(terminal, 'mra_taxpayer_id', 0) or 0)
        terminal_position = int(getattr(terminal, 'terminal_position', 0) or 0)
        if taxpayer_id > 0 and terminal_position > 0:
            return '-'.join(
                [
                    InvoiceService._base10_to_mra_base64(taxpayer_id),
                    InvoiceService._base10_to_mra_base64(terminal_position),
                    InvoiceService._base10_to_mra_base64(julian_date),
                    InvoiceService._base10_to_mra_base64(sequence),
                ]
            )

        if getattr(settings, 'MRA_EIS_REQUIRE_FISCAL_EVIDENCE', False) and getattr(settings, 'MRA_EIS_IS_LIVE', False):
            raise MRAIntegrationError(
                'The activated terminal is missing its MRA taxpayer ID or terminal position.'
            )

        # Test/legacy terminals created before MRA activation do not have the
        # two identity values. Keep their old readable reference in non-live
        # environments while refusing it for live fiscal sales.
        terminal_code = str(terminal.mra_terminal_id or terminal.terminal_id or 'TERM').replace(' ', '').upper()
        mode = '01' if is_online else '02'
        return f'{terminal_code}-{mode}-{int(sequence):08d}'

    @staticmethod
    def extract_julian_from_fiscal_invoice_number(fiscal_invoice_number: str) -> int:
        parts = str(fiscal_invoice_number or '').split('-')
        if len(parts) < 4 or (parts[-1].isdigit() and len(parts[-1]) == 8):
            return 0
        try:
            return InvoiceService._mra_base64_to_base10(parts[-2])
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def extract_sequence_from_fiscal_invoice_number(fiscal_invoice_number: str) -> int:
        last_part = str(fiscal_invoice_number or '').rsplit('-', 1)[-1]
        try:
            if last_part.isdigit() and len(last_part) == 8:
                return int(last_part)
            return InvoiceService._mra_base64_to_base10(last_part)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _extract_invoice_number_from_mra_response(response_data: Any) -> str:
        if not isinstance(response_data, dict):
            return ''
        return str(
            TerminalService._find_nested_value(
                response_data,
                'invoiceNumber', 'receiptNumber', 'fiscalInvoiceNumber', 'fiscal_invoice_number',
            )
            or ''
        ).strip()

    @staticmethod
    def _fiscal_invoice_number_matches_terminal_identity(
        terminal: Terminal,
        fiscal_invoice_number: str,
    ) -> bool:
        taxpayer_id = int(getattr(terminal, 'mra_taxpayer_id', 0) or 0)
        terminal_position = int(getattr(terminal, 'terminal_position', 0) or 0)
        if not taxpayer_id or not terminal_position:
            return True
        parts = str(fiscal_invoice_number or '').split('-')
        if len(parts) < 4:
            return False
        try:
            return (
                InvoiceService._mra_base64_to_base10(parts[0]) == taxpayer_id
                and InvoiceService._mra_base64_to_base10(parts[1]) == terminal_position
            )
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _fetch_last_transaction_sequence_for_day(
        terminal: Terminal,
        *,
        mode: str,
        julian_date: int,
    ) -> dict[str, Any]:
        endpoint_key = 'get_last_online_transaction' if mode == 'online' else 'get_last_offline_transaction'
        try:
            result = MRAEISClient(terminal=terminal).call(
                endpoint_key,
                payload=None,
                method='POST',
                mutating=False,
                send_json=False,
                record_connectivity=False,
            )
        except MRAIntegrationError as exc:
            errors = _extract_mra_response_errors(getattr(exc, 'response_data', {})) or [str(exc)]
            if InvoiceService._mra_no_last_transaction_errors(errors):
                return {'checked': True, 'mode': mode, 'remote_sequence': 0, 'reason': 'no_remote_transaction'}
            return {
                'checked': False,
                'mode': mode,
                'remote_sequence': 0,
                'reason': 'mra_network_unreachable',
                'error': str(exc),
            }

        response_data = result.data if isinstance(result.data, dict) else {}
        if result.dry_run:
            return {'checked': False, 'mode': mode, 'remote_sequence': 0, 'reason': 'dry_run'}
        errors = _extract_mra_response_errors(response_data)
        if errors:
            if InvoiceService._mra_no_last_transaction_errors(errors):
                return {'checked': True, 'mode': mode, 'remote_sequence': 0, 'reason': 'no_remote_transaction'}
            raise MRAIntegrationError(
                f'Unable to recover MRA last {mode} fiscal sequence: {"; ".join(errors)}'
            )
        remote_number = InvoiceService._extract_invoice_number_from_mra_response(response_data)
        if not remote_number:
            return {'checked': True, 'mode': mode, 'remote_sequence': 0, 'reason': 'no_remote_invoice_number'}
        remote_julian = InvoiceService.extract_julian_from_fiscal_invoice_number(remote_number)
        remote_sequence = InvoiceService.extract_sequence_from_fiscal_invoice_number(remote_number)
        if remote_julian and remote_julian != julian_date:
            return {
                'checked': True,
                'mode': mode,
                'remote_invoice_number': remote_number,
                'remote_sequence': 0,
                'reason': 'remote_invoice_from_different_fiscal_day',
            }
        if not remote_sequence or not InvoiceService._fiscal_invoice_number_matches_terminal_identity(terminal, remote_number):
            raise MRAIntegrationError(f'Unable to validate MRA last {mode} invoice number: {remote_number}')
        return {
            'checked': True,
            'mode': mode,
            'remote_invoice_number': remote_number,
            'remote_sequence': remote_sequence,
        }

    @staticmethod
    def _mra_no_last_transaction_errors(errors: list[str]) -> bool:
        text = ' '.join(str(error or '') for error in errors).lower()
        return any(phrase in text for phrase in ('no transaction', 'no invoice', 'no receipt', 'not found', 'no record'))

    @staticmethod
    def recover_fiscal_sequence_from_mra(terminal: Terminal, julian_date: int) -> dict[str, Any]:
        if not getattr(settings, 'MRA_EIS_IS_LIVE', False):
            return {'checked': False, 'reason': 'non_live', 'max_sequence': 0}
        client = MRAEISClient(terminal=terminal)
        if not client.http_enabled or client.dry_run:
            return {'checked': False, 'reason': 'client_not_live', 'max_sequence': 0}
        results = {
            mode: InvoiceService._fetch_last_transaction_sequence_for_day(
                terminal,
                mode=mode,
                julian_date=julian_date,
            )
            for mode in ('online', 'offline')
        }
        return {
            'checked': True,
            'julian_date': julian_date,
            'max_sequence': max(int(value.get('remote_sequence') or 0) for value in results.values()),
            'results': results,
        }

    @staticmethod
    @transaction.atomic
    def allocate_fiscal_sequence(terminal: Terminal, invoice_date_time: Any) -> tuple[int, int]:
        """Allocate one shared daily number for both online and offline sales."""
        julian_date = InvoiceService._to_julian_date(invoice_date_time)
        remote_sequence = 0
        if getattr(settings, 'MRA_EIS_REQUIRE_REMOTE_SEQUENCE_RECOVERY_FOR_SALES', False):
            recovery = InvoiceService.recover_fiscal_sequence_from_mra(terminal, julian_date)
            remote_sequence = int(recovery.get('max_sequence') or 0)
        for _attempt in range(3):
            try:
                had_sequence = FiscalInvoiceSequence.objects.filter(terminal=terminal).exists()
                sequence_row, _created = FiscalInvoiceSequence.objects.select_for_update().get_or_create(
                    terminal=terminal,
                    julian_date=julian_date,
                    defaults={'last_sequence': 0},
                )
                local_max = (
                    MRAInvoice.objects.filter(
                        terminal=terminal,
                        fiscal_julian_date=julian_date,
                    ).aggregate(value=Max('invoice_number')).get('value')
                    or 0
                )
                legacy_max = max(
                    int(getattr(terminal, 'online_invoice_counter', 0) or 0),
                    int(getattr(terminal, 'offline_invoice_counter', 0) or 0),
                )
                sequence_row.last_sequence = max(
                    int(sequence_row.last_sequence or 0),
                    int(local_max or 0),
                    remote_sequence,
                    legacy_max if not had_sequence else 0,
                ) + 1
                sequence_row.save(update_fields=['last_sequence', 'updated_at'])
                # Keep old counters in step for older screens and integrations.
                terminal.online_invoice_counter = max(
                    int(getattr(terminal, 'online_invoice_counter', 0) or 0),
                    int(sequence_row.last_sequence),
                )
                terminal.offline_invoice_counter = max(
                    int(getattr(terminal, 'offline_invoice_counter', 0) or 0),
                    int(sequence_row.last_sequence),
                )
                terminal.save(update_fields=['online_invoice_counter', 'offline_invoice_counter', 'updated_at'])
                terminal.refresh_from_db()
                return int(sequence_row.last_sequence), julian_date
            except IntegrityError:
                continue
        raise MRAIntegrationError('Could not allocate a fiscal invoice sequence number. Retry the sale.')

    @staticmethod
    def build_offline_validation_url(
        *,
        fiscal_invoice_number: str,
        invoice_date_time: Any,
        item_count: int,
        invoice_total: Any,
        vat_amount: Any,
        terminal: Terminal,
    ) -> str:
        """Build the MRA offline receipt validation URL used by the QR code."""
        julian_date = InvoiceService._to_julian_date(invoice_date_time)
        params = (
            f'TI={fiscal_invoice_number}'
            f'&N={max(int(item_count or 0), 0)}'
            f'&I={str(invoice_total or 0)}'
            f'&V={str(vat_amount or 0)}'
            f'&T={InvoiceService._base10_to_mra_base64(julian_date)}'
        )
        secret = InvoiceService._resolve_signature_secret(terminal)
        if secret:
            digest = hmac.new(secret.encode('utf-8'), params.encode('utf-8'), hashlib.sha256).digest()
            signature = base64.urlsafe_b64encode(digest).decode('utf-8').rstrip('=')
        else:
            signature = hashlib.sha256(params.encode('utf-8')).hexdigest()
        base_url = str(
            getattr(settings, 'MRA_EIS_OFFLINE_VALIDATION_BASE_URL', '')
            or 'https://dev-eis-portal.mra.mw/ReceiptValidation/Validate/'
        ).rstrip('/')
        return f'{base_url}?{params}&S={signature}'

    @staticmethod
    def _extract_validation_url(response_data: Any) -> str:
        """Read MRA's receipt-validation URL from either response envelope shape."""
        return str(
            TerminalService._response_value(
                response_data,
                'validationURL',
                'validationUrl',
                'validation_url',
            )
            or TerminalService._find_nested_value(
                response_data,
                'validationURL',
                'validationUrl',
                'validation_url',
            )
            or ''
        ).strip()

    @staticmethod
    def _fetch_last_offline_transaction_snapshot(
        terminal: Terminal,
        *,
        require_success: bool = False,
    ) -> dict[str, Any] | None:
        """
        Best-effort read of MRA's last offline transaction state.
        Failure is non-blocking unless replay validation explicitly requires it.
        """
        client = MRAEISClient(terminal=terminal)
        try:
            result = client.call(
                'get_last_offline_transaction',
                payload={'terminalId': terminal.mra_terminal_id},
                method='POST',
                mutating=False,
            )
            return result.data if isinstance(result.data, dict) else None
        except Exception as exc:
            logger.warning(
                'Could not fetch last offline transaction for terminal %s: %s',
                terminal.terminal_id,
                exc,
            )
            error_data = getattr(exc, 'response_data', {})
            response_errors = _extract_mra_response_errors(error_data) or [str(exc)]
            if InvoiceService._mra_no_last_transaction_errors(response_errors):
                # MRA commonly reports an empty history as an error-shaped
                # response. That is valid for a terminal's first replay.
                return error_data if isinstance(error_data, dict) else {'status': 'no transaction'}
            if require_success:
                raise MRAIntegrationError(
                    f'Unable to verify MRA last offline transaction before replay: {exc}'
                ) from exc
            return None

    @staticmethod
    def _offline_invoice_sequence(invoice: MRAInvoice) -> tuple[int, str]:
        response_data = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
        payload = response_data.get('payload') if isinstance(response_data.get('payload'), dict) else {}
        header = payload.get('invoiceHeader') if isinstance(payload.get('invoiceHeader'), dict) else {}
        fiscal_invoice_number = str(
            header.get('invoiceNumber')
            or response_data.get('fiscal_invoice_number')
            or ''
        ).strip()
        sequence = (
            POSOrderSubmissionService._extract_sequence_from_fiscal_number(fiscal_invoice_number)
            if fiscal_invoice_number
            else 0
        )
        if sequence <= 0:
            try:
                sequence = int(invoice.invoice_number or 0)
            except (TypeError, ValueError):
                sequence = 0
        return sequence, fiscal_invoice_number or str(invoice.invoice_number or '')

    @staticmethod
    def _validate_offline_replay_sequence_guard(
        terminal: Terminal,
        first_entry: OfflineInvoiceQueue | None,
        last_offline_snapshot: dict[str, Any] | None,
        queued_entries=None,
    ) -> dict[str, Any]:
        """Prevent replaying offline invoices out of MRA's required order."""
        if not bool(getattr(settings, 'MRA_EIS_REQUIRE_OFFLINE_REPLAY_SEQUENCE_GUARD', False)):
            return {'checked': False, 'reason': 'disabled'}
        if first_entry is None:
            return {'checked': False, 'reason': 'empty_queue'}
        if not isinstance(last_offline_snapshot, dict):
            raise MRAIntegrationError('Unable to verify MRA last offline transaction before replay.')

        meta = last_offline_snapshot.get('_handyPosMeta')
        if isinstance(meta, dict) and meta.get('dry_run'):
            return {
                'checked': False,
                'reason': 'dry_run',
                'last_offline_transaction': last_offline_snapshot,
            }
        if str(last_offline_snapshot.get('status') or '').lower() == 'prepared':
            return {
                'checked': False,
                'reason': 'dry_run',
                'last_offline_transaction': last_offline_snapshot,
            }

        response_errors = _extract_mra_response_errors(last_offline_snapshot)
        if response_errors:
            if InvoiceService._mra_no_last_transaction_errors(response_errors):
                response_errors = []
            else:
                raise MRAIntegrationError(
                    'Unable to verify MRA last offline transaction before replay: '
                    + '; '.join(response_errors)
                )

        remote_invoice_number = InvoiceService._extract_invoice_number_from_mra_response(
            last_offline_snapshot
        )
        remote_sequence = 0
        if remote_invoice_number:
            remote_sequence = POSOrderSubmissionService._extract_sequence_from_fiscal_number(
                remote_invoice_number
            )
            if remote_sequence <= 0:
                raise MRAIntegrationError(
                    'Unable to decode MRA last offline invoice sequence before replay: '
                    f'{remote_invoice_number}'
                )

        expected_sequence = remote_sequence + 1
        queue_sequence_plan: list[dict[str, Any]] = []
        entries_to_check = list(queued_entries) if queued_entries is not None else [first_entry]
        for queued_entry in entries_to_check:
            local_sequence, local_invoice_number = InvoiceService._offline_invoice_sequence(
                queued_entry.mra_invoice
            )
            if local_sequence <= 0:
                raise MRAIntegrationError(
                    'Unable to determine the next queued offline invoice sequence before replay.'
                )
            if local_sequence != expected_sequence:
                raise MRAIntegrationError(
                    'Offline replay sequence mismatch: MRA last offline sequence is '
                    f'{remote_sequence}; expected {expected_sequence} but queued invoice '
                    f'{local_invoice_number} has sequence {local_sequence}.'
                )
            queue_sequence_plan.append(
                {
                    'queue_position': queued_entry.queue_position,
                    'invoice_id': str(queued_entry.mra_invoice_id),
                    'invoice_number': local_invoice_number,
                    'sequence': local_sequence,
                }
            )
            expected_sequence += 1

        local_counter = int(terminal.offline_invoice_counter or 0)
        highest_queued_sequence = queue_sequence_plan[-1]['sequence'] if queue_sequence_plan else 0
        if remote_sequence > local_counter:
            raise MRAIntegrationError(
                'Offline replay sequence mismatch: MRA is ahead of the local terminal counter. '
                'Reconcile the offline queue before replaying queued sales.'
            )
        if highest_queued_sequence > local_counter:
            raise MRAIntegrationError(
                'Offline replay sequence mismatch: the local terminal counter is behind the queued invoices.'
            )

        return {
            'checked': True,
            'remote_invoice_number': remote_invoice_number,
            'remote_sequence': remote_sequence,
            'expected_next_sequence': remote_sequence + 1,
            'terminal_offline_counter': local_counter,
            'queue_sequence_plan': queue_sequence_plan,
        }

    @staticmethod
    def _mark_linked_pos_order_submitted(invoice: MRAInvoice) -> None:
        """Reflect a successful invoice replay on its source POS order."""
        response_meta = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
        order_id = response_meta.get('order_id') or response_meta.get('orderId')
        if not order_id and isinstance(response_meta.get('payload'), dict):
            order_id = (
                response_meta['payload'].get('orderId')
                or response_meta['payload'].get('order_id')
            )
        if not order_id:
            return

        try:
            from pos_sessions.models import Order

            order = Order.objects.filter(
                pk=order_id,
                business=invoice.business,
                branch=invoice.branch,
            ).first()
            if not order or order.is_fiscal_locked:
                return

            response_data = response_meta.get('response')
            if not isinstance(response_data, dict):
                response_data = {}

            order.eis_status = 'SUBMITTED'
            order.eis_submitted_at = invoice.submitted_at or timezone.now()
            order.eis_uuid = (
                invoice.mra_invoice_id
                or TerminalService._response_value(
                    response_data,
                    'eisUuid', 'eis_uuid', 'invoiceUuid', 'invoice_uuid',
                )
                or order.eis_uuid
            )
            order.qr_code_payload = (
                InvoiceService._extract_validation_url(response_data)
                or TerminalService._response_value(response_data, 'qrCodePayload', 'qr_code_payload')
                or order.qr_code_payload
            )
            order.digital_signature = invoice.invoice_signature or order.digital_signature
            order.is_fiscal_locked = True
            order.save(
                update_fields=[
                    'eis_status',
                    'eis_submitted_at',
                    'eis_uuid',
                    'qr_code_payload',
                    'digital_signature',
                    'is_fiscal_locked',
                    'updated_at',
                ]
            )
        except Exception as exc:
            # Invoice replay has already succeeded. A missing/legacy source
            # order must not turn that fiscal success into a retry.
            logger.warning(
                'Could not update source POS order for MRA invoice %s: %s',
                invoice.id,
                exc,
            )

    @staticmethod
    def _sum_queued_offline_gross_amount(terminal: Terminal) -> Decimal:
        queued_total = (
            OfflineInvoiceQueue.objects.filter(
                terminal=terminal,
                status__in=['queued', 'syncing', 'failed'],
            )
            .aggregate(total=Sum('mra_invoice__gross_amount'))
            .get('total')
        )
        return queued_total if isinstance(queued_total, Decimal) else Decimal('0')

    @staticmethod
    def _calculate_amounts(items: list[dict[str, Any]]) -> tuple[Decimal, Decimal, Decimal, dict[str, Decimal]]:
        net_amount = Decimal('0')
        tax_amount = Decimal('0')
        tax_breakdown = {
            'standard': Decimal('0'),
            'zero': Decimal('0'),
            'exempt': Decimal('0'),
        }

        for item in items:
            quantity = Decimal(str(item.get('quantity', 0)))
            unit_price = Decimal(str(item.get('unit_price', 0)))
            item_net = quantity * unit_price
            net_amount += item_net

            tax_category = item.get('tax_category', 'standard')
            tax_rate = Decimal(str(item.get('tax_rate', 0)))

            item_tax = Decimal('0')
            if tax_category not in {'exempt', 'zero'} and tax_rate > 0:
                item_tax = item_net * (tax_rate / Decimal('100'))

            tax_amount += item_tax
            if tax_category in tax_breakdown:
                tax_breakdown[tax_category] += item_tax

        gross_amount = net_amount + tax_amount
        return net_amount, tax_amount, gross_amount, tax_breakdown

    @staticmethod
    @transaction.atomic
    def create_invoice(
        terminal,
        seller_tin,
        seller_name,
        items,
        buyer_tin=None,
        buyer_name=None,
        is_online=True,
    ):
        ensure_business_eis_enabled(terminal.business)
        if buyer_tin and not is_online:
            raise MRAIntegrationError(
                'B2B EIS sales require MRA online confirmation. Connect to the internet and retry.'
            )
        TerminalService.ensure_terminal_ready_for_sale(terminal, is_online=is_online)
        net_amount, tax_amount, gross_amount, tax_breakdown = InvoiceService._calculate_amounts(items)
        stored_items = InvoiceService._to_json_safe(items)

        invoice_date = timezone.now()
        if getattr(settings, 'MRA_EIS_IS_LIVE', False):
            invoice_date, _time_metadata = TerminalService.resolve_mra_transaction_time(
                terminal,
                require_live_ping=bool(is_online),
                allow_cached=True,
            )
        invoice_number, fiscal_julian_date = InvoiceService.allocate_fiscal_sequence(terminal, invoice_date)
        fiscal_invoice_number = InvoiceService._format_fiscal_invoice_number(
            terminal,
            julian_date=fiscal_julian_date,
            sequence=invoice_number,
            is_online=is_online,
        )

        invoice = MRAInvoice.objects.create(
            business=terminal.business,
            branch=terminal.branch,
            terminal=terminal,
            invoice_number=invoice_number,
            fiscal_julian_date=fiscal_julian_date,
            fiscal_invoice_number=fiscal_invoice_number,
            seller_tin=seller_tin,
            seller_name=seller_name,
            buyer_tin=buyer_tin or '',
            buyer_name=buyer_name or '',
            items=stored_items,
            net_amount=net_amount,
            tax_amount=tax_amount,
            gross_amount=gross_amount,
            tax_breakdown={k: str(v) for k, v in tax_breakdown.items()},
            is_online=is_online,
            invoice_date=invoice_date,
            status='draft',
        )

        if is_online:
            invoice.invoice_signature = invoice.generate_signature()
        else:
            signature_payload = InvoiceService._build_signature_payload(invoice)
            invoice.invoice_signature = InvoiceService._build_offline_signature(
                signature_payload,
                terminal,
            )
        invoice.save(update_fields=['invoice_signature', 'updated_at'])

        InvoiceAuditLog.objects.create(
            mra_invoice=invoice,
            action='created',
            details={
                'seller_tin': seller_tin,
                'gross_amount': str(gross_amount),
                'is_online': is_online,
            },
        )

        return invoice

    @staticmethod
    def _build_mra_invoice_payload(invoice: MRAInvoice) -> dict[str, Any]:
        response_meta = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
        stored_payload = response_meta.get('payload') if isinstance(response_meta.get('payload'), dict) else {}
        stored_header = stored_payload.get('invoiceHeader') if isinstance(stored_payload.get('invoiceHeader'), dict) else {}
        stored_summary = stored_payload.get('invoiceSummary') if isinstance(stored_payload.get('invoiceSummary'), dict) else {}
        fiscal_invoice_number = str(
            invoice.fiscal_invoice_number
            or stored_header.get('invoiceNumber')
            or invoice.invoice_number
        ).strip()

        modern_items = stored_payload.get('invoiceLineItems')
        if not isinstance(modern_items, list):
            modern_items = []
            for index, item in enumerate(invoice.items or [], start=1):
                if not isinstance(item, dict):
                    continue
                quantity = Decimal(str(item.get('quantity') or item.get('qty') or 0))
                unit_price = Decimal(str(item.get('unitPrice') or item.get('unit_price') or 0))
                line_total = Decimal(str(item.get('total') or item.get('subtotal') or 0))
                line_tax = Decimal(str(item.get('totalVAT') or item.get('tax_amount') or 0))
                if line_total == 0:
                    line_total = quantity * unit_price
                tax_type = str(item.get('taxType') or item.get('tax_category') or 'standard').lower()
                tax_rate_id = 'A' if tax_type in {'standard', 'vat_standard'} else ('E' if tax_type in {'exempt', 'vat_exempt'} else 'B')
                modern_items.append({
                    'id': index,
                    'productCode': item.get('productCode') or item.get('mra_product_code') or '',
                    'description': item.get('description') or item.get('name') or '',
                    'unitPrice': float(unit_price),
                    'quantity': float(quantity),
                    'discount': 0.0,
                    'total': float(line_total),
                    'totalVAT': float(line_tax),
                    'taxRateId': tax_rate_id,
                    'isProduct': True,
                })

        invoice_header = {
            **stored_header,
            'invoiceNumber': fiscal_invoice_number,
            'invoiceDateTime': stored_header.get('invoiceDateTime') or invoice.invoice_date.isoformat(),
            'sellerTIN': stored_header.get('sellerTIN') or invoice.seller_tin,
        }
        invoice_summary = {
            **stored_summary,
            'invoiceTotal': stored_summary.get('invoiceTotal') or str(invoice.gross_amount),
            'amountTendered': stored_summary.get('amountTendered') or str(invoice.gross_amount),
            'totalVAT': stored_summary.get('totalVAT') or str(invoice.tax_amount),
        }
        payload = {
            'terminalId': invoice.terminal.mra_terminal_id,
            'invoiceNumber': fiscal_invoice_number,
            'sellerTin': invoice.seller_tin,
            'sellerName': invoice.seller_name,
            'buyerTin': invoice.buyer_tin,
            'buyerName': invoice.buyer_name,
            'items': invoice.items,
            'netAmount': str(invoice.net_amount),
            'taxAmount': str(invoice.tax_amount),
            'grossAmount': str(invoice.gross_amount),
            'invoiceDate': invoice.invoice_date.isoformat(),
            'signature': invoice.invoice_signature,
            'isOffline': not invoice.is_online,
            'invoiceHeader': invoice_header,
            'invoiceLineItems': modern_items,
            'invoiceSummary': invoice_summary,
        }
        if invoice.is_online:
            payload['offlineSignature'] = None
        else:
            offline_signature = invoice.invoice_signature or InvoiceService._build_offline_signature(
                InvoiceService._build_signature_payload(invoice),
                invoice.terminal,
            )
            payload['offlineSignature'] = offline_signature
            payload['signature'] = offline_signature

        return payload

    @staticmethod
    @transaction.atomic
    def submit_invoice(invoice):
        ensure_business_eis_enabled(invoice.business)

        # A retry can reach this method after MRA accepted the invoice but
        # before the local queue row was marked complete. Do not submit the
        # same fiscal invoice a second time.
        if invoice.status in {'submitted', 'accepted', 'offline_synced'}:
            return invoice

        TerminalService.ensure_terminal_ready_for_sale(
            invoice.terminal,
            is_online=bool(invoice.is_online),
        )

        endpoint_key = 'report_sale' if invoice.is_online else 'report_sale_offline'
        payload = InvoiceService._build_mra_invoice_payload(invoice)
        previous_response = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
        source_order_id = previous_response.get('order_id') or previous_response.get('orderId')

        try:
            client = MRAEISClient(terminal=invoice.terminal)
            result = client.call(endpoint_key, payload=payload, method='POST', mutating=True)
            _raise_for_mra_response(
                endpoint_key,
                result.data,
                ok=result.ok or result.dry_run,
            )

            response_validation_url = InvoiceService._extract_validation_url(result.data)
            response_qr_payload = TerminalService._response_value(
                result.data,
                'qrCodePayload',
                'qr_code_payload',
            )
            if (
                not result.dry_run
                and getattr(settings, 'MRA_EIS_IS_LIVE', False)
                and getattr(settings, 'MRA_EIS_REQUIRE_FISCAL_EVIDENCE', False)
                and not response_validation_url
                and not str(response_qr_payload or '').strip().startswith(('http://', 'https://'))
            ):
                raise MRAIntegrationError(
                    'MRA accepted the invoice but returned no receipt validation URL. '
                    'Do not issue a fiscal receipt until MRA evidence is available.'
                )

            if not result.dry_run:
                response_data = result.data if isinstance(result.data, dict) else {}
                invoice.mra_invoice_id = (
                    TerminalService._response_value(
                        response_data,
                        'invoiceId', 'invoice_id', 'eisUuid', 'eis_uuid',
                    )
                    or invoice.mra_invoice_id
                )
                invoice.status = 'submitted'
                invoice.submitted_at = timezone.now()
            invoice.mra_response = {
                'dry_run': result.dry_run,
                'endpoint': result.endpoint,
                'payload': payload,
                'response': result.data,
            }
            if source_order_id:
                invoice.mra_response['order_id'] = source_order_id
            invoice.save(update_fields=['mra_invoice_id', 'status', 'submitted_at', 'mra_response', 'updated_at'])

            if not result.dry_run:
                InvoiceService._mark_linked_pos_order_submitted(invoice)

            InvoiceAuditLog.objects.create(
                mra_invoice=invoice,
                action='submitted',
                details={
                    'dry_run': result.dry_run,
                    'endpoint': result.endpoint,
                    'mra_invoice_id': invoice.mra_invoice_id,
                },
            )

            return invoice
        except Exception as exc:
            MRAAPIError.objects.create(
                terminal=invoice.terminal,
                error_type='invalid_request',
                error_message=str(exc),
                related_invoice=invoice,
            )
            raise

    @staticmethod
    @transaction.atomic
    def queue_offline_invoice(invoice):
        ensure_business_eis_enabled(invoice.business)
        if invoice.is_online:
            raise ValueError('Cannot queue online invoice')

        # Serialise position allocation per terminal. Without this lock two
        # devices can observe the same last position and collide on the unique
        # (terminal, queue_position) constraint.
        terminal = Terminal.objects.select_for_update().get(pk=invoice.terminal_id)
        existing_entry = OfflineInvoiceQueue.objects.select_for_update().filter(mra_invoice=invoice).first()
        if existing_entry:
            if existing_entry.status == 'synced' or invoice.status in {
                'submitted', 'accepted', 'offline_synced',
            }:
                return existing_entry
            if existing_entry.status != 'queued':
                existing_entry.status = 'queued'
                existing_entry.save(update_fields=['status'])
            if invoice.status != 'offline_queued':
                invoice.status = 'offline_queued'
                invoice.save(update_fields=['status', 'updated_at'])
            return existing_entry

        limits = ConfigurationService.get_offline_limits(invoice.business)
        if limits.max_transaction_age_hours is not None:
            age_hours = (timezone.now() - invoice.invoice_date).total_seconds() / 3600
            if age_hours > float(limits.max_transaction_age_hours):
                raise MRAIntegrationError(
                    'Offline transaction age exceeds configured limit '
                    f'({age_hours:.2f}h > {limits.max_transaction_age_hours}h).'
                )

        if limits.max_cumulative_amount is not None:
            queued_total = InvoiceService._sum_queued_offline_gross_amount(terminal)
            projected_total = queued_total + Decimal(str(invoice.gross_amount or 0))
            if projected_total > limits.max_cumulative_amount:
                raise MRAIntegrationError(
                    'Offline cumulative amount exceeds configured limit '
                    f'({projected_total} > {limits.max_cumulative_amount}).'
                )

        last_entry = (
            OfflineInvoiceQueue.objects.filter(terminal=terminal)
            .order_by('-queue_position')
            .first()
        )
        queue_position = (last_entry.queue_position + 1) if last_entry else 1

        queue_entry = OfflineInvoiceQueue.objects.create(
            terminal=terminal,
            mra_invoice=invoice,
            queue_position=queue_position,
            status='queued',
        )

        invoice.status = 'offline_queued'
        invoice.save(update_fields=['status', 'updated_at'])

        OfflineAuditLog.objects.create(
            terminal=invoice.terminal,
            event_type='invoice_queued',
            details={
                'invoice_number': invoice.invoice_number,
                'queue_position': queue_position,
            },
        )

        return queue_entry

    @staticmethod
    @transaction.atomic
    def sync_offline_invoices(terminal):
        ensure_business_eis_enabled(terminal.business)
        queued_entries = OfflineInvoiceQueue.objects.filter(
            terminal=terminal,
            status__in=['queued', 'failed'],
        ).select_for_update().select_related('mra_invoice').order_by('queue_position')

        synced_count = 0
        failed_count = 0
        offline_limits = ConfigurationService.get_offline_limits(terminal.business)
        last_offline_snapshot = None
        sequence_guard = {'checked': False, 'reason': 'empty_queue'}

        if queued_entries:
            first_entry = queued_entries[0]
            try:
                last_offline_snapshot = InvoiceService._fetch_last_offline_transaction_snapshot(
                    terminal,
                    require_success=bool(
                        getattr(settings, 'MRA_EIS_REQUIRE_OFFLINE_REPLAY_SEQUENCE_GUARD', False)
                    ),
                )
                sequence_guard = InvoiceService._validate_offline_replay_sequence_guard(
                    terminal,
                    first_entry,
                    last_offline_snapshot,
                    queued_entries=queued_entries,
                )
            except Exception as exc:
                first_entry.status = 'failed'
                first_entry.last_sync_error = str(exc)
                first_entry.sync_attempts += 1
                first_entry.last_sync_attempt_at = timezone.now()
                first_entry.save(
                    update_fields=[
                        'status',
                        'last_sync_error',
                        'sync_attempts',
                        'last_sync_attempt_at',
                    ]
                )
                terminal.last_sync_at = timezone.now()
                terminal.save(update_fields=['last_sync_at', 'updated_at'])
                sequence_guard = {
                    'checked': True,
                    'blocked': True,
                    'error': str(exc),
                    'queue_entry_id': str(first_entry.id),
                    'invoice_id': str(first_entry.mra_invoice_id),
                }
                OfflineAuditLog.objects.create(
                    terminal=terminal,
                    event_type='sync_failed',
                    details={
                        'reason': 'offline_replay_sequence_guard',
                        'error': str(exc),
                        'sequence_guard': sequence_guard,
                        'offline_limit_source': offline_limits.source,
                    },
                )
                return {
                    'synced': 0,
                    'failed': 1,
                    'blocked': True,
                    'error': str(exc),
                    'sequence_guard': sequence_guard,
                }

        for entry in queued_entries:
            try:
                entry.status = 'syncing'
                entry.last_sync_attempt_at = timezone.now()
                entry.save(update_fields=['status', 'last_sync_attempt_at'])

                if offline_limits.max_transaction_age_hours is not None:
                    age_hours = (
                        timezone.now() - entry.mra_invoice.invoice_date
                    ).total_seconds() / 3600
                    if age_hours > float(offline_limits.max_transaction_age_hours):
                        raise MRAIntegrationError(
                            'Offline transaction age exceeds configured limit '
                            f'({age_hours:.2f}h > {offline_limits.max_transaction_age_hours}h).'
                        )

                submitted_invoice = InvoiceService.submit_invoice(entry.mra_invoice)

                # A dry-run response only proves that the payload was built;
                # it is not an MRA acceptance and must remain replayable.
                if (
                    isinstance(submitted_invoice.mra_response, dict)
                    and submitted_invoice.mra_response.get('dry_run')
                ):
                    entry.status = 'queued'
                    entry.last_sync_error = 'MRA submission is still in dry-run mode; no invoice was accepted.'
                    entry.save(
                        update_fields=['status', 'last_sync_error', 'last_sync_attempt_at']
                    )
                    break

                entry.status = 'synced'
                entry.synced_at = timezone.now()
                entry.mra_invoice.status = 'offline_synced'
                entry.mra_invoice.save(update_fields=['status', 'updated_at'])
                entry.save(update_fields=['status', 'synced_at'])

                synced_count += 1
            except Exception as exc:
                entry.status = 'failed'
                entry.last_sync_error = str(exc)
                entry.sync_attempts += 1
                entry.last_sync_attempt_at = timezone.now()
                entry.save(
                    update_fields=['status', 'last_sync_error', 'sync_attempts', 'last_sync_attempt_at']
                )
                failed_count += 1

                # MRA offline invoices are sequential. Do not send a later
                # invoice while the earlier one is still unresolved.
                break

        terminal.last_sync_at = timezone.now()
        terminal.save(update_fields=['last_sync_at', 'updated_at'])

        OfflineAuditLog.objects.create(
            terminal=terminal,
            event_type='sync_completed',
            details={
                'synced_count': synced_count,
                'failed_count': failed_count,
                'offline_limit_source': offline_limits.source,
                'max_transaction_age_hours': offline_limits.max_transaction_age_hours,
                'max_cumulative_amount': (
                    str(offline_limits.max_cumulative_amount)
                    if offline_limits.max_cumulative_amount is not None
                    else None
                ),
                'last_offline_transaction': last_offline_snapshot,
                'sequence_guard': sequence_guard,
            },
        )

        return {'synced': synced_count, 'failed': failed_count}


class ReceiptService:
    """Receipt rendering and QR payload generation."""

    @staticmethod
    def generate_receipt(invoice, *, force_refresh: bool = False):
        ensure_business_eis_enabled(invoice.business)
        try:
            existing_receipt = invoice.receipt
            if not force_refresh:
                return existing_receipt
        except Receipt.DoesNotExist:
            existing_receipt = None

        response_meta = invoice.mra_response if isinstance(invoice.mra_response, dict) else {}
        response_data = response_meta.get('response') if isinstance(response_meta.get('response'), dict) else {}
        payload = response_meta.get('payload') if isinstance(response_meta.get('payload'), dict) else {}
        invoice_header = payload.get('invoiceHeader') if isinstance(payload.get('invoiceHeader'), dict) else {}
        invoice_summary = payload.get('invoiceSummary') if isinstance(payload.get('invoiceSummary'), dict) else {}
        line_items = (
            payload.get('invoiceLineItems')
            if isinstance(payload.get('invoiceLineItems'), list)
            else invoice.items
        )

        fiscal_invoice_number = str(
            invoice.fiscal_invoice_number
            or invoice_header.get('invoiceNumber')
            or payload.get('fiscalInvoiceNumber')
            or ''
        ).strip()
        if not fiscal_invoice_number:
            fiscal_invoice_number = InvoiceService._format_fiscal_invoice_number(
                invoice.terminal,
                julian_date=(
                    invoice.fiscal_julian_date
                    or InvoiceService._to_julian_date(invoice.invoice_date)
                ),
                sequence=invoice.invoice_number,
                is_online=invoice.is_online,
            )

        validation_url = InvoiceService._extract_validation_url(response_data)
        response_qr_payload = TerminalService._response_value(
            response_data,
            'qrCodePayload',
            'qr_code_payload',
        )
        if not validation_url and str(response_qr_payload or '').strip().startswith(('http://', 'https://')):
            validation_url = str(response_qr_payload).strip()
        local_metadata = response_meta.get('local_metadata') if isinstance(response_meta.get('local_metadata'), dict) else {}
        validation_url = validation_url or str(
            local_metadata.get('offlineValidationURL')
            or local_metadata.get('offline_validation_url')
            or invoice_summary.get('offlineValidationURL')
            or ''
        ).strip()
        if not validation_url and not invoice.is_online:
            validation_url = InvoiceService.build_offline_validation_url(
                fiscal_invoice_number=fiscal_invoice_number,
                invoice_date_time=invoice.invoice_date,
                item_count=len(line_items),
                invoice_total=invoice_summary.get('invoiceTotal') or invoice.gross_amount,
                vat_amount=invoice_summary.get('totalVAT') or invoice.tax_amount,
                terminal=invoice.terminal,
            )
        if (
            getattr(settings, 'MRA_EIS_REQUIRE_FISCAL_EVIDENCE', False)
            and getattr(settings, 'MRA_EIS_IS_LIVE', False)
            and not validation_url
        ):
            raise MRAIntegrationError(
                'Cannot generate a fiscal receipt without the MRA receipt validation URL.'
            )

        signature_preview = (
            invoice.invoice_signature
            if len(invoice.invoice_signature) <= 24
            else f"{invoice.invoice_signature[:12]}...{invoice.invoice_signature[-8:]}"
        )

        tax_breakdown = invoice.tax_breakdown or {}
        standard_tax = str(tax_breakdown.get('standard', '0'))
        zero_tax = str(tax_breakdown.get('zero', '0'))
        exempt_tax = str(tax_breakdown.get('exempt', '0'))

        seller_name = str(invoice.seller_name or invoice.business.name or 'SELLER').strip().upper()
        buyer_name = str(
            invoice.buyer_name
            or invoice_header.get('buyerName')
            or 'WALK-IN CUSTOMER'
        ).strip().upper()
        buyer_tin = str(
            invoice.buyer_tin
            or invoice_header.get('buyerTIN')
            or 'N/A'
        ).strip()
        receipt_lines = [
            '=' * 40,
            '*** START OF LEGAL RECEIPT ***',
            seller_name,
            '=' * 40,
            'ORDER INFO',
            '-' * 40,
            f'Receipt No: {fiscal_invoice_number}',
            f'Fiscal Invoice: {fiscal_invoice_number}',
            f"Date: {invoice.invoice_date.strftime('%Y-%m-%d %H:%M:%S')}",
            f'Payment Mode: {"ONLINE" if invoice.is_online else "OFFLINE"}',
            '',
            'COMPANY INFO',
            '-' * 40,
            f'Seller: {seller_name}',
            f'Seller TIN: {invoice.seller_tin}',
            f"Buyer's Name: {buyer_name}",
            f"Buyer's TIN: {buyer_tin}",
            '',
            'ITEM BREAKDOWN',
            '-' * 40,
        ]

        for item in line_items:
            if not isinstance(item, dict):
                continue
            quantity = Decimal(str(item.get('quantity', 0) or item.get('qty', 0)))
            unit_price = Decimal(str(item.get('unit_price', 0) or item.get('unitPrice', 0)))
            line_total = Decimal(str(
                item.get('lineGrossAmount')
                or item.get('line_gross_amount')
                or item.get('total')
                or 0
            ))
            if line_total == 0:
                line_total = quantity * unit_price
            receipt_lines.append(
                str(item.get('name') or item.get('description') or item.get('productName') or 'Item')
            )
            receipt_lines.append(f"  Qty: {quantity} x {unit_price} = {line_total}")

        receipt_lines.extend([
            '-' * 40,
            'TAX BREAKDOWN (MRA EIS)',
            '-' * 40,
            f'VAT A (STANDARD): {standard_tax}',
            f'VAT B (ZERO): {zero_tax}',
            f'VAT E (EXEMPT): {exempt_tax}',
        ])
        levy_rows = invoice_summary.get('levyBreakDown', [])
        for levy in (levy_rows if isinstance(levy_rows, list) else []):
            if not isinstance(levy, dict):
                continue
            levy_name = str(
                levy.get('levyTypeId')
                or levy.get('levy_type_id')
                or levy.get('name')
                or 'LEVY'
            ).strip().upper()
            levy_amount = levy.get('levyAmount') or levy.get('levy_amount') or 0
            receipt_lines.append(f'{levy_name} LEVY: {levy_amount}')
        receipt_lines.extend([
            '',
            'PAYMENT TOTALS',
            '-' * 40,
            f'Net Amount: {invoice.net_amount}',
            f'VAT Amount: {invoice.tax_amount}',
            f'Gross Amount: {invoice.gross_amount}',
            '',
            'EIS COMPLIANCE',
            '-' * 40,
            f'EIS Status: {invoice.status.upper()}',
            f'EIS UUID: {invoice.mra_invoice_id or "PENDING"}',
            f'Signature: {signature_preview or "N/A"}',
            'Scan Here For Receipt Details',
            f'Validation URL: {validation_url or "PENDING"}',
            '*** END OF LEGAL RECEIPT ***',
            'Thank you for your business!',
            '=' * 40,
        ])

        receipt_text = '\n'.join(receipt_lines)
        qr_data = {
            'invoice_id': str(invoice.id),
            'invoice_number': invoice.invoice_number,
            'fiscal_invoice_number': fiscal_invoice_number,
            'seller_tin': invoice.seller_tin,
            'gross_amount': str(invoice.gross_amount),
            'signature': invoice.invoice_signature,
            'eis_status': invoice.status,
            'eis_uuid': invoice.mra_invoice_id,
            'is_online': invoice.is_online,
            'validation_url': validation_url,
            'date': invoice.invoice_date.isoformat(),
        }

        receipt_payload = {
            'receipt_number': fiscal_invoice_number,
            'receipt_text': receipt_text,
            # Encode the official URL directly. Keep the structured fallback
            # for test/dry-run records that do not have MRA evidence yet.
            'qr_code_data': validation_url or json.dumps(qr_data),
        }
        if existing_receipt:
            Receipt.objects.filter(pk=existing_receipt.pk).update(**receipt_payload)
            existing_receipt.refresh_from_db()
            receipt = existing_receipt
        else:
            receipt = Receipt.objects.create(mra_invoice=invoice, **receipt_payload)

        InvoiceAuditLog.objects.create(
            mra_invoice=invoice,
            action='receipt_generated',
            details={'receipt_number': receipt.receipt_number},
        )

        return receipt


class RetryService:
    """Retry queue processing."""

    @staticmethod
    def queue_retry(terminal, operation_type, payload, max_attempts=5):
        ensure_business_eis_enabled(terminal.business)
        payload = payload or {}

        # A transient network failure can be observed by more than one caller
        # (for example, the sale request and the retry worker). Keep one active
        # retry for each POS order so MRA never receives duplicate submissions.
        if operation_type == 'submit_pos_order' and payload.get('order_id'):
            order_id = str(payload['order_id'])
            existing_retries = SyncRetryQueue.objects.filter(
                terminal=terminal,
                operation_type=operation_type,
                status__in=['pending', 'processing'],
            ).order_by('-created_at')
            for existing in existing_retries:
                existing_order_id = str((existing.payload or {}).get('order_id') or '')
                if existing_order_id == order_id:
                    return existing

        return SyncRetryQueue.objects.create(
            terminal=terminal,
            operation_type=operation_type,
            status='pending',
            payload=payload,
            max_attempts=max_attempts,
            next_attempt_at=timezone.now(),
        )

    @staticmethod
    def process_retry_queue():
        pending_retries = (
            SyncRetryQueue.objects.filter(status='pending')
            .filter(next_attempt_at__lte=timezone.now())
            .order_by('next_attempt_at')
        )

        result = {'processed': 0, 'skipped': 0, 'failed': 0}

        for retry in pending_retries:
            if not is_business_eis_enabled(retry.terminal.business):
                # Preserve the pending job so it can resume if the owner
                # enables EIS later. Disabled businesses are never retried.
                result['skipped'] += 1
                continue

            try:
                retry.status = 'processing'
                retry.save(update_fields=['status'])

                if retry.operation_type == 'submit_invoice':
                    invoice = MRAInvoice.objects.get(id=retry.payload['invoice_id'])
                    submitted_invoice = InvoiceService.submit_invoice(invoice)
                    if (
                        isinstance(submitted_invoice.mra_response, dict)
                        and submitted_invoice.mra_response.get('dry_run')
                    ):
                        raise MRAIntegrationError(
                            'MRA invoice submission is still in dry-run mode.'
                        )
                elif retry.operation_type == 'sync_offline_invoices':
                    terminal = Terminal.objects.get(id=retry.payload['terminal_id'])
                    InvoiceService.sync_offline_invoices(terminal)
                elif retry.operation_type == 'submit_pos_order':
                    from pos_sessions.models import Order

                    order = Order.objects.get(id=retry.payload['order_id'])
                    submission_result = POSOrderSubmissionService.prepare_pos_order_submission(order)
                    response = submission_result.get('response') or {}
                    if submission_result.get('dry_run'):
                        raise MRAIntegrationError(
                            (
                                response.get('error')
                                if isinstance(response, dict)
                                else None
                            )
                            or 'POS order submission was not accepted by MRA.'
                        )

                retry.status = 'completed'
                retry.completed_at = timezone.now()
                retry.save(update_fields=['status', 'completed_at'])
                result['processed'] += 1
            except Exception as exc:
                retry.attempt_count += 1
                retry.last_error = str(exc)

                if not getattr(exc, 'retryable', True):
                    # MRA has already answered and rejected the payload. A
                    # retry with the same payload cannot repair a validation
                    # error and could create a duplicate if the response was
                    # misclassified by an operator.
                    retry.status = 'failed'
                elif retry.attempt_count >= retry.max_attempts:
                    retry.status = 'failed'
                else:
                    retry.status = 'pending'
                    retry.next_attempt_at = retry.calculate_next_retry()

                retry.save(update_fields=['attempt_count', 'last_error', 'status', 'next_attempt_at'])
                result['failed'] += 1

        return result


class EISSaleComplianceService:
    """Validate optional MRA sale headers before a fiscal number is issued."""

    @staticmethod
    def _clean(value: Any, max_length: int) -> str:
        return str(value or '').strip()[:max_length]

    @staticmethod
    def _response_inner(response_data: Any) -> dict[str, Any]:
        if not isinstance(response_data, dict):
            return {}
        inner = TerminalService._response_inner(response_data)
        return inner if isinstance(inner, dict) else response_data

    @staticmethod
    def _is_positive_status(response_data: dict[str, Any]) -> bool:
        value = TerminalService._response_value(response_data, 'statusCode', 'status_code')
        try:
            return int(value or 0) > 0
        except (TypeError, ValueError):
            return False

    @staticmethod
    def check_tin_authorization_requirement(
        *,
        business,
        tin: str,
        terminal: Terminal,
    ) -> dict[str, Any]:
        tin = EISSaleComplianceService._clean(tin, 50)
        if not tin:
            raise MRAIntegrationError('Buyer TIN is required for a B2B sale.')
        result = MRAEISClient(terminal=terminal).call(
            'check_tin_authorization_requirement',
            payload={'tin': tin},
            method='POST',
            mutating=False,
        )
        response_data = result.data if isinstance(result.data, dict) else {}
        inner = EISSaleComplianceService._response_inner(response_data)
        errors = _extract_mra_response_errors(response_data)
        if result.dry_run:
            return {
                'checked': False,
                'dry_run': True,
                'tin': tin,
                'tin_exists': None,
                'requires_authorization_code': False,
            }
        return {
            'checked': True,
            'dry_run': False,
            'tin': TerminalService._dict_get_any(inner, 'tin', 'TIN') or tin,
            'tin_exists': TerminalService._dict_get_any(inner, 'tinExists', 'tin_exists'),
            'requires_authorization_code': bool(
                TerminalService._dict_get_any(
                    inner,
                    'requiresAuthorizationCode',
                    'requires_authorization_code',
                )
            ),
            'errors': errors,
            'response': response_data,
        }

    @staticmethod
    def validate_authorization_code(
        *,
        authorization_code: str,
        terminal: Terminal,
    ) -> dict[str, Any]:
        authorization_code = EISSaleComplianceService._clean(authorization_code, 100)
        if not authorization_code:
            raise MRAIntegrationError('Buyer authorization code is required.')
        result = MRAEISClient(terminal=terminal).call(
            'validate_authorization_code',
            payload={'authorizationCode': authorization_code},
            method='POST',
            mutating=False,
        )
        response_data = result.data if isinstance(result.data, dict) else {}
        inner = EISSaleComplianceService._response_inner(response_data)
        errors = _extract_mra_response_errors(response_data)
        is_valid = TerminalService._dict_get_any(
            inner,
            'isValidAuthorizationCode',
            'is_valid_authorization_code',
            'isValid',
            'is_valid',
        )
        if is_valid is None:
            is_valid = EISSaleComplianceService._is_positive_status(response_data) and not errors
        return {
            'checked': not result.dry_run,
            'dry_run': result.dry_run,
            'is_valid': True if result.dry_run else bool(is_valid),
            'errors': errors,
            'response': response_data,
        }

    @staticmethod
    def validate_vat5_certificate(
        *,
        project_number: str,
        certificate_number: str,
        quantity: Any,
        terminal: Terminal,
    ) -> dict[str, Any]:
        project_number = EISSaleComplianceService._clean(project_number, 100)
        certificate_number = EISSaleComplianceService._clean(certificate_number, 100)
        try:
            quantity_value = Decimal(str(quantity or 0))
        except (InvalidOperation, TypeError, ValueError):
            quantity_value = Decimal('0')
        if not project_number or not certificate_number or quantity_value <= 0:
            raise MRAIntegrationError(
                'VAT5 project number, certificate number, and positive quantity are required for relief supply.'
            )

        result = MRAEISClient(terminal=terminal).call(
            'validate_vat5',
            payload={
                'projectNumber': project_number,
                'certificateNumber': certificate_number,
                'quantity': float(quantity_value.quantize(Decimal('0.001'), rounding=ROUND_HALF_UP)),
            },
            method='POST',
            mutating=False,
        )
        response_data = result.data if isinstance(result.data, dict) else {}
        inner = EISSaleComplianceService._response_inner(response_data)
        errors = _extract_mra_response_errors(response_data)
        is_valid = TerminalService._dict_get_any(inner, 'isValid', 'is_valid')
        if is_valid is None:
            is_valid = EISSaleComplianceService._is_positive_status(response_data) and not errors
        return {
            'checked': not result.dry_run,
            'dry_run': result.dry_run,
            'is_valid': True if result.dry_run else bool(is_valid),
            'errors': errors,
            'response': response_data,
        }

    @staticmethod
    def validate_order_special_fields(order, terminal: Terminal, buyer_tin: str) -> dict[str, Any]:
        metadata = dict(getattr(order, 'eis_validation_metadata', None) or {})
        validation_result: dict[str, Any] = {}
        buyer_tin = EISSaleComplianceService._clean(buyer_tin, 50)
        authorization_code = EISSaleComplianceService._clean(
            getattr(order, 'buyer_authorization_code', None),
            100,
        )

        if buyer_tin and getattr(settings, 'MRA_EIS_VALIDATE_BUYER_TIN_BEFORE_SALE', True):
            try:
                tin_result = EISSaleComplianceService.check_tin_authorization_requirement(
                    business=order.business,
                    tin=buyer_tin,
                    terminal=terminal,
                )
            except Exception as exc:
                if TerminalService._is_network_failure(exc):
                    raise MRAIntegrationError('B2B sales need MRA online.') from exc
                raise
            validation_result['buyer_tin'] = tin_result
            if tin_result.get('tin_exists') is False:
                raise MRAIntegrationError(f'Buyer TIN {buyer_tin} was not found by MRA EIS.')
            if tin_result.get('requires_authorization_code') and not authorization_code:
                raise MRAIntegrationError(
                    'This buyer TIN requires an MRA buyer authorization code before sale submission.'
                )

        if authorization_code:
            try:
                auth_result = EISSaleComplianceService.validate_authorization_code(
                    authorization_code=authorization_code,
                    terminal=terminal,
                )
            except Exception as exc:
                if TerminalService._is_network_failure(exc):
                    raise MRAIntegrationError('B2B sales need MRA online.') from exc
                raise
            validation_result['buyer_authorization'] = auth_result
            if auth_result.get('checked') and not auth_result.get('is_valid'):
                raise MRAIntegrationError('MRA buyer authorization code is invalid or expired.')

        if bool(getattr(order, 'is_relief_supply', False)):
            project_number = EISSaleComplianceService._clean(
                getattr(order, 'vat5_project_number', None),
                100,
            )
            certificate_number = EISSaleComplianceService._clean(
                getattr(order, 'vat5_certificate_number', None),
                100,
            )
            quantity = getattr(order, 'vat5_quantity', None)
            if not project_number or not certificate_number:
                raise MRAIntegrationError(
                    'VAT5 project number, certificate number, and positive quantity are required for relief supply.'
                )
            try:
                quantity_value = Decimal(str(quantity or 0))
            except (InvalidOperation, TypeError, ValueError):
                quantity_value = Decimal('0')
            if quantity_value <= 0:
                raise MRAIntegrationError(
                    'VAT5 project number, certificate number, and positive quantity are required for relief supply.'
                )
            if getattr(settings, 'MRA_EIS_VALIDATE_VAT5_BEFORE_SALE', True):
                try:
                    vat5_result = EISSaleComplianceService.validate_vat5_certificate(
                        project_number=project_number,
                        certificate_number=certificate_number,
                        quantity=quantity_value,
                        terminal=terminal,
                    )
                except Exception as exc:
                    if TerminalService._is_network_failure(exc):
                        raise MRAIntegrationError('Relief sale needs MRA online.') from exc
                    raise
                validation_result['vat5'] = vat5_result
                if vat5_result.get('checked') and not vat5_result.get('is_valid'):
                    raise MRAIntegrationError('MRA VAT5 certificate is invalid or expired.')

        metadata['special_sale_validation'] = validation_result
        order.eis_validation_metadata = metadata
        order.save(update_fields=['eis_validation_metadata', 'updated_at'])
        return validation_result


class POSOrderSubmissionService:
    """
    POS order submission lifecycle.

    In dry-run mode this service prepares and stores everything needed for MRA
    without sending live transactions.
    """

    @staticmethod
    def _resolve_order_terminal(
        order,
        *,
        request_device_serial: str | None = None,
        enforce_device_binding: bool = False,
    ):
        terminal_qs = Terminal.objects.filter(
            business=order.business,
            branch=order.branch,
        )
        device_serial = TerminalService.normalize_device_serial(request_device_serial)
        terminal = None
        if device_serial:
            terminal = terminal_qs.filter(device_serial__iexact=device_serial).order_by('-updated_at').first()
            if terminal is None and enforce_device_binding:
                raise MRAIntegrationError(
                    'This device is not activated as an MRA EIS terminal for this branch. '
                    'Activate this device with a TAC before making fiscal sales.'
                )

        if terminal is None:
            terminal = terminal_qs.order_by('-updated_at').first()

        if terminal:
            return terminal

        # Ensure order can still be prepared in offline/no-terminal scenarios.
        local_terminal_id = f"TRM-{order.branch_id}-{uuid.uuid4().hex[:6].upper()}"
        terminal = Terminal.objects.create(
            business=order.business,
            branch=order.branch,
            terminal_id=local_terminal_id,
            device_serial=f"AUTO-{order.branch_id}",
            mac_address='',
            pos_name='Handy-POS',
            pos_version='1.0.0',
            os_type='Backend',
            mra_terminal_id=local_terminal_id,
            mra_api_key='',
            status='pending_activation',
            is_online=False,
        )
        return terminal

    @staticmethod
    def _generate_fiscal_invoice_number(
        order,
        terminal: Terminal,
        is_online: bool,
        invoice_date_time: Any | None = None,
    ) -> str:
        if order.fiscal_invoice_number:
            return order.fiscal_invoice_number

        invoice_date_time = invoice_date_time or getattr(order, 'created_at', None) or timezone.now()
        sequence, julian_date = InvoiceService.allocate_fiscal_sequence(terminal, invoice_date_time)
        return InvoiceService._format_fiscal_invoice_number(
            terminal,
            julian_date=julian_date,
            sequence=sequence,
            is_online=is_online,
        )

    @staticmethod
    def _is_b2b_order(order, buyer_tin: str = '') -> bool:
        buyer_tin = POSOrderSubmissionService._clean_buyer_value(
            buyer_tin or getattr(order, 'buyer_tin', None) or getattr(order, 'customer_tin', None),
            50,
        )
        authorization_code = POSOrderSubmissionService._clean_buyer_value(
            getattr(order, 'buyer_authorization_code', None),
            100,
        )
        return bool(buyer_tin or authorization_code)

    @staticmethod
    def _enforce_b2b_online_only(order, is_online: bool, buyer_tin: str = '') -> None:
        if POSOrderSubmissionService._is_b2b_order(order, buyer_tin=buyer_tin) and not is_online:
            raise MRAIntegrationError(
                'B2B EIS sales require MRA online confirmation. Connect to the internet and retry.'
            )

    @staticmethod
    def _extract_sequence_from_fiscal_number(fiscal_invoice_number: str) -> int:
        try:
            parts = str(fiscal_invoice_number).split('-')
            last_part = parts[-1]
            # Legacy fallback numbers end with an eight-digit decimal counter.
            # Terminal IDs may themselves contain hyphens, so segment count is
            # not enough to identify the modern MRA base64 format.
            if len(parts) >= 4 and not (last_part.isdigit() and len(last_part) == 8):
                return InvoiceService._mra_base64_to_base10(last_part)
            return int(last_part)
        except Exception:
            return 0

    @staticmethod
    def _extract_julian_from_fiscal_number(fiscal_invoice_number: str) -> int:
        parts = str(fiscal_invoice_number or '').split('-')
        if len(parts) >= 4:
            if parts[-1].isdigit() and len(parts[-1]) == 8:
                return 0
            try:
                return InvoiceService._mra_base64_to_base10(parts[-2])
            except ValueError:
                return 0
        return 0

    @staticmethod
    def _extract_validation_url(response_data: Any) -> str:
        """Read MRA's receipt-validation URL from either response envelope shape."""
        return InvoiceService._extract_validation_url(response_data)

    @staticmethod
    def _sum_queued_offline_gross_amount(terminal: Terminal) -> Decimal:
        return InvoiceService._sum_queued_offline_gross_amount(terminal)

    @staticmethod
    def _enforce_offline_limits(
        order,
        terminal: Terminal,
        is_online: bool,
        *,
        is_new_offline_issue: bool,
    ) -> None:
        if is_online:
            return

        limits = ConfigurationService.get_offline_limits(order.business)

        if limits.max_transaction_age_hours is not None:
            transaction_age_hours = (timezone.now() - order.created_at).total_seconds() / 3600
            if transaction_age_hours > float(limits.max_transaction_age_hours):
                raise MRAIntegrationError(
                    'Offline transaction age exceeds configured limit '
                    f'({transaction_age_hours:.2f}h > {limits.max_transaction_age_hours}h).'
                )

        # Enforce cumulative cap only when issuing a new offline fiscal number.
        # Re-preparing the same order should not double-count its amount.
        if is_new_offline_issue and limits.max_cumulative_amount is not None:
            queued_total = POSOrderSubmissionService._sum_queued_offline_gross_amount(terminal)
            current_amount = Decimal(str(order.gross_amount or order.total or 0))
            projected_total = queued_total + current_amount
            if projected_total > limits.max_cumulative_amount:
                raise MRAIntegrationError(
                    'Offline cumulative amount exceeds configured limit '
                    f'({projected_total} > {limits.max_cumulative_amount}).'
                )

    @staticmethod
    def _apply_offline_signature(payload: dict[str, Any], terminal: Terminal, is_online: bool) -> str | None:
        if is_online:
            payload['offlineSignature'] = None
            if isinstance(payload.get('invoiceSummary'), dict):
                payload['invoiceSummary'].pop('offlineSignature', None)
            return None

        signature_payload = {
            'terminalId': payload.get('terminalId'),
            'orderId': payload.get('orderId'),
            'fiscalInvoiceNumber': payload.get('fiscalInvoiceNumber'),
            'transactionDate': payload.get('transactionDate'),
            'grossAmount': payload.get('grossAmount'),
            'items': payload.get('items', []),
        }
        offline_signature = InvoiceService._build_offline_signature(signature_payload, terminal)
        payload['offlineSignature'] = offline_signature
        invoice_summary = payload.setdefault('invoiceSummary', {})
        invoice_summary['offlineSignature'] = offline_signature
        payload.setdefault('handyPosMetadata', {})['offlineSignaturePayload'] = signature_payload

        # Offline receipts must still contain the MRA validation URL. This is
        # generated from the exact fiscal payload, so the QR can be checked
        # after the terminal reconnects and the invoice is replayed.
        invoice_header = payload.get('invoiceHeader') if isinstance(payload.get('invoiceHeader'), dict) else {}
        invoice_items = payload.get('invoiceLineItems') if isinstance(payload.get('invoiceLineItems'), list) else []
        validation_url = InvoiceService.build_offline_validation_url(
            fiscal_invoice_number=str(invoice_header.get('invoiceNumber') or payload.get('fiscalInvoiceNumber') or ''),
            invoice_date_time=invoice_header.get('invoiceDateTime') or timezone.now(),
            item_count=len(invoice_items),
            invoice_total=invoice_summary.get('invoiceTotal') or payload.get('grossAmount') or 0,
            vat_amount=invoice_summary.get('totalVAT') or payload.get('taxAmount') or 0,
            terminal=terminal,
        )
        payload.setdefault('handyPosMetadata', {})['offlineValidationURL'] = validation_url
        # Keep legacy signature key for compatibility with existing integration code.
        payload['signature'] = offline_signature
        return offline_signature

    @staticmethod
    def _get_item_mapping_map(order_item_ids: list[str]) -> dict[str, Any]:
        order_item_ids = [str(value or '').strip() for value in order_item_ids if str(value or '').strip()]
        if not order_item_ids:
            return {}
        try:
            from inventory.models import MRAProductMapping as InventoryMRAProductMapping

            mappings = InventoryMRAProductMapping.objects.filter(
                inventory_item_id__in=order_item_ids,
                is_approved=True,
                mra_synced=True,
            ).values(
                'inventory_item_id',
                'mra_product_code',
                'mra_product_name',
                'mra_tax_type',
                'mra_tax_rate',
                'tax_calculation_method',
                'mra_levies',
            )
            return {str(m['inventory_item_id']): m for m in mappings}
        except Exception:
            return {}

    @staticmethod
    def _build_levy_breakdown(order_items, mapping_map: dict[str, Any]) -> list[dict[str, Any]]:
        """Calculate product levies from the synchronized MRA mappings.

        MRA levies are applied to each fiscal product line's net amount. The
        result is aggregated by levy type/rate for the invoice summary while
        retaining the source levy rows on each line.
        """
        breakdown: dict[tuple[str, str], dict[str, Any]] = {}
        for item in order_items:
            mapping = mapping_map.get(str(item.inventory_item_id or '').strip()) or {}
            levies = mapping.get('mra_levies') or []
            taxable_amount = Decimal(str(item.subtotal or 0))
            if taxable_amount <= 0 or not isinstance(levies, list):
                continue

            for levy in levies:
                if not isinstance(levy, dict):
                    continue
                levy_type_id = str(
                    levy.get('levyTypeId')
                    or levy.get('levy_type_id')
                    or levy.get('levyId')
                    or levy.get('levy_id')
                    or levy.get('code')
                    or ''
                ).strip()
                if not levy_type_id:
                    continue
                try:
                    levy_rate = Decimal(
                        str(
                            levy.get('levyRate')
                            if levy.get('levyRate') is not None
                            else levy.get('levy_rate', 0)
                        )
                    )
                    if not levy_rate.is_finite() or levy_rate <= 0:
                        continue
                    levy_rate = levy_rate.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                except (InvalidOperation, TypeError, ValueError):
                    continue

                levy_amount = (taxable_amount * levy_rate / Decimal('100')).quantize(
                    Decimal('0.01'), rounding=ROUND_HALF_UP
                )
                key = (levy_type_id.upper(), str(levy_rate))
                existing = breakdown.get(key)
                if existing:
                    existing['taxableAmount'] += taxable_amount
                    existing['levyAmount'] += levy_amount
                else:
                    breakdown[key] = {
                        'levyTypeId': levy_type_id,
                        'levyRate': levy_rate,
                        'taxableAmount': taxable_amount,
                        'levyAmount': levy_amount,
                    }

        return [
            {
                'levyTypeId': row['levyTypeId'],
                'levyRate': str(row['levyRate']),
                'taxableAmount': str(row['taxableAmount'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
                'levyAmount': str(row['levyAmount'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
            }
            for row in breakdown.values()
        ]

    @staticmethod
    def _order_contains_mra_levy_snapshot(order) -> bool:
        """Return whether the order total already includes an MRA levy."""
        snapshots = getattr(order, 'charges_snapshot', None)
        if not isinstance(snapshots, list):
            return False
        return any(
            isinstance(charge, dict)
            and str(charge.get('source') or '').strip().lower() == 'mra'
            for charge in snapshots
        )

    @staticmethod
    def _is_recipe_backed_item(item, inventory_items: dict[str, Any]) -> bool:
        """Identify lines whose internal stock comes from a recipe.

        Recipes are an internal stock-control concern. They must never be
        expanded into MRA invoice lines; the finished sellable product is the
        fiscal item. The inventory lookup covers older orders that did not
        persist a recipe snapshot on the order line.
        """
        if bool(getattr(item, 'is_takeaway_packaging', False)):
            return False
        if bool(getattr(item, 'is_prepared_menu_item', False)):
            return True
        recipe = getattr(item, 'recipe', None)
        if isinstance(recipe, list) and recipe:
            return True
        inventory_item = inventory_items.get(str(getattr(item, 'inventory_item_id', '') or '').strip())
        inventory_recipe = getattr(inventory_item, 'recipe', None)
        return isinstance(inventory_recipe, list) and bool(inventory_recipe)

    @staticmethod
    def _valid_inventory_ids(order_items) -> list[str]:
        """Return UUID inventory references without querying invalid legacy IDs."""
        valid_ids = []
        for item in order_items:
            value = str(getattr(item, 'inventory_item_id', '') or '').strip()
            if not value:
                continue
            try:
                uuid.UUID(value)
            except (ValueError, TypeError, AttributeError):
                continue
            valid_ids.append(value)
        return list(dict.fromkeys(valid_ids))

    @staticmethod
    def _validate_recipe_fiscal_items(order, order_items, mapping_map: dict[str, Any]) -> None:
        """Require a mapped finished product for prepared/recipe-backed lines.

        MRA maps sellable products, not the ingredients used to make them. A
        recipe-only menu line has no valid fiscal identity, so accepting it
        would create an invoice with a blank product code and leave the sale
        in an invalid/retry state.
        """
        if not bool(getattr(settings, 'MRA_EIS_STRICT_PRODUCT_CODES', False)):
            return

        inventory_items: dict[str, Any] = {}
        item_ids = POSOrderSubmissionService._valid_inventory_ids(order_items)
        try:
            from inventory.models import InventoryItem

            inventory_items = {
                str(item.id): item
                for item in InventoryItem.objects.filter(
                    id__in=item_ids,
                    business=order.business,
                    branch=order.branch,
                )
            }
        except Exception as exc:
            logger.warning('Could not load recipe products for EIS order %s: %s', order.id, exc)

        missing_finished_products = []
        for item in order_items:
            if not POSOrderSubmissionService._is_recipe_backed_item(item, inventory_items):
                continue

            item_id = str(getattr(item, 'inventory_item_id', '') or '').strip()
            mapping = mapping_map.get(item_id) or {}
            product_code = str(mapping.get('mra_product_code') or '').strip()
            if not item_id or not product_code:
                missing_finished_products.append(str(getattr(item, 'name', '') or 'Prepared menu item').strip())

        if missing_finished_products:
            names = ', '.join(dict.fromkeys(missing_finished_products))
            raise MRAIntegrationError(
                'Recipe-backed item(s) require a mapped finished sellable product before EIS sale: '
                f'{names}. Map the produced product from the synced MRA catalog; recipe ingredients '
                'remain internal stock items and are not submitted to MRA.'
            )

    @staticmethod
    def _clean_buyer_value(value: Any, max_length: int) -> str:
        if value is None:
            return ''
        return str(value).strip()[:max_length]

    @staticmethod
    def _resolve_related_invoice(order):
        """
        Resolve the business invoice linked to this POS order (if any).
        Supports both direct invoice_id linkage and reverse related_order_id lookup.
        """
        try:
            from business.models import Invoice

            invoice_qs = Invoice.objects.select_related('customer').filter(business=order.business)
            invoice_ref = POSOrderSubmissionService._clean_buyer_value(getattr(order, 'invoice_id', ''), 255)

            if invoice_ref:
                try:
                    if invoice_ref.isdigit():
                        invoice = invoice_qs.filter(id=int(invoice_ref)).first()
                    else:
                        invoice = invoice_qs.filter(id=invoice_ref).first()
                    if invoice:
                        return invoice
                except Exception:
                    # Fall back to reverse lookup below.
                    pass

            return invoice_qs.filter(related_order_id=str(order.id)).order_by('-created_at').first()
        except Exception as exc:
            logger.debug('Could not resolve related invoice for POS order %s: %s', order.id, exc)
            return None

    @staticmethod
    def _resolve_buyer_details(order) -> tuple[str, str]:
        """
        Resolve buyer details for MRA payloads.
        Priority:
        1) Order-level fields (future/optional compatibility)
        2) Linked business invoice + customer
        """
        buyer_tin = POSOrderSubmissionService._clean_buyer_value(
            getattr(order, 'buyer_tin', None) or getattr(order, 'customer_tin', None),
            50,
        )
        buyer_name = POSOrderSubmissionService._clean_buyer_value(
            getattr(order, 'buyer_name', None) or getattr(order, 'customer_name', None),
            255,
        )

        invoice = POSOrderSubmissionService._resolve_related_invoice(order)
        if invoice:
            customer = getattr(invoice, 'customer', None)

            if not buyer_tin:
                buyer_tin = POSOrderSubmissionService._clean_buyer_value(
                    getattr(customer, 'customer_tin', None),
                    50,
                )

            if not buyer_name:
                buyer_name = POSOrderSubmissionService._clean_buyer_value(
                    getattr(customer, 'name', None) or getattr(invoice, 'customer_name', None),
                    255,
                )

        return buyer_tin, buyer_name

    @staticmethod
    def build_pos_order_payload(
        order,
        terminal: Terminal,
        is_online: bool,
        buyer_tin: str = '',
        buyer_name: str = '',
        transaction_date_time: Any | None = None,
    ) -> dict[str, Any]:
        transaction_date_time = transaction_date_time or getattr(order, 'created_at', None) or timezone.now()
        order_items = list(order.items.all())
        mapping_map = POSOrderSubmissionService._get_item_mapping_map(
            [str(item.inventory_item_id or '').strip() for item in order_items]
        )
        inventory_items: dict[str, Any] = {}
        if bool(getattr(settings, 'MRA_EIS_STRICT_PRODUCT_CODES', False)):
            try:
                from inventory.models import InventoryItem

                inventory_items = {
                    str(inventory_item.id): inventory_item
                    for inventory_item in InventoryItem.objects.filter(
                        id__in=POSOrderSubmissionService._valid_inventory_ids(order_items),
                        business=order.business,
                        branch=order.branch,
                    )
                }
            except Exception as exc:
                logger.warning('Could not load inventory recipes for EIS order %s: %s', order.id, exc)

        payload_items: list[dict[str, Any]] = []
        for item in order_items:
            key = str(item.inventory_item_id or '').strip()
            mapping = mapping_map.get(key) or {}
            mapping_product_code = str(mapping.get('mra_product_code') or '').strip()
            local_product_code = str(item.mra_product_code or '').strip()
            tax_type = str(
                mapping.get('mra_tax_type') if mapping.get('mra_tax_type') else item.tax_type or 'standard'
            ).strip().lower()
            line_net_amount = Decimal(str(item.subtotal or 0))
            line_tax_amount = Decimal(str(item.tax_amount or 0))
            line_gross_amount = Decimal(str(item.total or 0))
            if bool(getattr(order, 'is_relief_supply', False)) and tax_type == 'standard':
                # VAT5 relief removes charged standard VAT while retaining the
                # MRA standard tax classification on the fiscal line.
                line_tax_amount = Decimal('0.00')
                line_gross_amount = line_net_amount
            payload_items.append(
                {
                    'inventoryItemId': key,
                    # In strict mode the synced inventory mapping is the only
                    # trusted source for recipe-backed fiscal product codes.
                    'productCode': (
                        mapping_product_code
                        if POSOrderSubmissionService._is_recipe_backed_item(item, inventory_items)
                        and bool(getattr(settings, 'MRA_EIS_STRICT_PRODUCT_CODES', False))
                        else mapping_product_code or local_product_code
                    ),
                    'productName': mapping.get('mra_product_name') or item.name,
                    'quantity': str(item.quantity),
                    'unitPrice': str(item.price),
                    'taxType': tax_type,
                    'taxRate': str(
                        mapping.get('mra_tax_rate')
                        if mapping.get('mra_tax_rate') is not None
                        else item.tax_rate or 0
                    ),
                    'lineNetAmount': str(item.subtotal),
                    'lineTaxAmount': str(line_tax_amount),
                    'lineGrossAmount': str(line_gross_amount),
                    'calculationMethod': mapping.get('tax_calculation_method') if mapping.get('tax_calculation_method') else item.tax_calculation_method or 'inclusive',
                    # The rate and levy type come from the synced MRA
                    # mapping, never from a locally entered business charge.
                    'levies': mapping.get('mra_levies') or [],
                }
            )

        levy_breakdown = POSOrderSubmissionService._build_levy_breakdown(
            order_items,
            mapping_map,
        )
        levy_amount = sum(
            (Decimal(str(row.get('levyAmount') or 0)) for row in levy_breakdown),
            Decimal('0.00'),
        ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        order_gross_amount = Decimal(str(order.gross_amount or order.total or 0))
        if bool(getattr(order, 'is_relief_supply', False)):
            order_tax_amount = Decimal('0.00')
            relief_gross_amount = sum(
                (Decimal(str(line.get('lineGrossAmount') or 0)) for line in payload_items),
                Decimal('0.00'),
            )
            order_gross_amount = relief_gross_amount
        else:
            order_tax_amount = Decimal(str(order.vat_amount or Decimal('0')))
        fiscal_gross_amount = (
            order_gross_amount
            if POSOrderSubmissionService._order_contains_mra_levy_snapshot(order)
            else order_gross_amount + levy_amount
        ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

        try:
            settings_obj = order.business.settings
        except Exception:
            settings_obj = None
        currency = (
            getattr(settings_obj, 'currency', None)
            or getattr(settings, 'MRA_EIS_DEFAULT_CURRENCY', 'MWK')
            or 'MWK'
        )

        payload = {
            'terminalId': terminal.mra_terminal_id,
            'terminalCode': terminal.terminal_id,
            'businessTin': order.business.tin or '',
            'businessName': order.business.name,
            'branchCode': order.branch.mra_branch_code or str(order.branch_id),
            'branchName': order.branch.name,
            'orderId': str(order.id),
            'orderNumber': int(order.order_number),
            'fiscalInvoiceNumber': order.fiscal_invoice_number,
            'transactionDate': transaction_date_time.isoformat(),
            'paymentMethod': order.payment_method,
            'buyerTin': buyer_tin,
            'buyerName': buyer_name,
            'currency': currency,
            'netAmount': str(order.net_amount or order.subtotal),
            'taxAmount': str(order_tax_amount),
            'grossAmount': str(fiscal_gross_amount),
            'levyAmount': str(levy_amount),
            'levyBreakDown': levy_breakdown,
            'isOffline': not is_online,
            'items': payload_items,
        }

        # Also include the nested MRA sale contract. The legacy keys above are
        # retained for older deployments and audit records; the nested shape
        # is the certification-facing representation.
        tax_breakdown: dict[str, dict[str, Decimal]] = {}
        modern_items: list[dict[str, Any]] = []
        for index, line in enumerate(payload_items, start=1):
            normalized_tax_type = str(line.get('taxType') or 'standard').lower()
            tax_rate_id = 'A' if normalized_tax_type == 'standard' else ('B' if normalized_tax_type == 'zero' else 'E')
            line_net = Decimal(str(line.get('lineNetAmount') or 0))
            line_tax = Decimal(str(line.get('lineTaxAmount') or 0))
            bucket = tax_breakdown.setdefault(
                tax_rate_id,
                {'taxableAmount': Decimal('0.00'), 'taxAmount': Decimal('0.00')},
            )
            bucket['taxableAmount'] += line_net
            bucket['taxAmount'] += line_tax
            modern_items.append(
                {
                    'id': index,
                    'productCode': line.get('productCode') or '',
                    'description': line.get('productName') or '',
                    'unitPrice': float(Decimal(str(line.get('unitPrice') or 0))),
                    'quantity': float(Decimal(str(line.get('quantity') or 0))),
                    'discount': 0.0,
                    'total': float(line_net),
                    'totalVAT': float(line_tax),
                    'taxRateId': tax_rate_id,
                    'isProduct': True,
                }
            )
        payload['invoiceHeader'] = {
            'invoiceNumber': order.fiscal_invoice_number,
            'invoiceDateTime': transaction_date_time.isoformat(),
            'sellerTIN': order.business.tin or '',
            'siteId': order.branch.mra_branch_code or str(order.branch_id),
            'isExport': bool(getattr(order, 'is_export', False)),
            'isReliefSupply': bool(getattr(order, 'is_relief_supply', False)),
            'paymentMethod': order.payment_method,
        }
        if buyer_tin:
            payload['invoiceHeader']['buyerTIN'] = buyer_tin
        if buyer_name:
            payload['invoiceHeader']['buyerName'] = buyer_name
        authorization_code = str(getattr(order, 'buyer_authorization_code', '') or '').strip()
        if authorization_code:
            payload['invoiceHeader']['buyerAuthorizationCode'] = authorization_code
        if bool(getattr(order, 'is_relief_supply', False)):
            payload['invoiceHeader']['vat5CertificateDetails'] = {
                'projectNumber': str(getattr(order, 'vat5_project_number', '') or '').strip(),
                'certificateNumber': str(getattr(order, 'vat5_certificate_number', '') or '').strip(),
                'quantity': float(Decimal(str(getattr(order, 'vat5_quantity', 0) or 0))),
            }
        payload['invoiceLineItems'] = modern_items
        payload['invoiceSummary'] = {
            'taxBreakDown': [
                {
                    'rateId': rate_id,
                    'taxableAmount': float(values['taxableAmount'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
                    'taxAmount': float(values['taxAmount'].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
                }
                for rate_id, values in tax_breakdown.items()
            ],
            'levyBreakDown': levy_breakdown,
            'totalVAT': float(order_tax_amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
            'invoiceTotal': float(fiscal_gross_amount),
            'amountTendered': float(fiscal_gross_amount),
        }
        payload['handyPosMetadata'] = {
            'terminalId': terminal.mra_terminal_id,
            'terminalCode': terminal.terminal_id,
            'orderId': str(order.id),
            'orderNumber': int(order.order_number),
            'isOffline': not is_online,
            'isB2B': POSOrderSubmissionService._is_b2b_order(order, buyer_tin=buyer_tin),
            'onlineOnly': POSOrderSubmissionService._is_b2b_order(order, buyer_tin=buyer_tin),
            'lineSnapshots': payload_items,
            'transactionTimeSource': 'mra_server_time' if getattr(settings, 'MRA_EIS_IS_LIVE', False) else 'local_clock',
        }

        return payload

    @staticmethod
    @transaction.atomic
    def prepare_pos_order_submission(
        order,
        force_online: bool | None = None,
        *,
        request_device_serial: str | None = None,
        enforce_device_binding: bool = False,
    ) -> dict[str, Any]:
        ensure_business_eis_enabled(order.business)
        if order.status in {'Voided', 'Cancelled'}:
            return {
                'order_id': str(order.id),
                'skipped': True,
                'reason': f'order_status_{order.status.lower()}',
            }

        # Retries must be idempotent. Once MRA has accepted the sale, never
        # issue a second fiscal transaction for the same local order.
        if order.eis_status in {'SUBMITTED', 'ACCEPTED'} and order.fiscal_invoice_number:
            if not order.is_fiscal_locked:
                order.is_fiscal_locked = True
                order.save(update_fields=['is_fiscal_locked', 'updated_at'])
            return {
                'order_id': str(order.id),
                'fiscal_invoice_number': order.fiscal_invoice_number,
                'eis_status': order.eis_status,
                'dry_run': False,
                'already_submitted': True,
            }

        terminal = POSOrderSubmissionService._resolve_order_terminal(
            order,
            request_device_serial=request_device_serial,
            enforce_device_binding=enforce_device_binding,
        )
        if enforce_device_binding:
            TerminalService.enforce_terminal_device_binding(
                terminal,
                request_device_serial,
                operation='issuing EIS sales',
            )
        is_online = bool(force_online) if force_online is not None else bool(terminal.is_online)
        buyer_tin, buyer_name = POSOrderSubmissionService._resolve_buyer_details(order)
        is_b2b_sale = POSOrderSubmissionService._is_b2b_order(order, buyer_tin=buyer_tin)
        if (
            bool(getattr(settings, 'MRA_EIS_ALWAYS_OFFLINE_B2C', False))
            and not is_b2b_sale
        ):
            is_online = False
        POSOrderSubmissionService._enforce_b2b_online_only(
            order,
            is_online,
            buyer_tin=buyer_tin,
        )
        client = MRAEISClient(terminal=terminal)

        TerminalService.ensure_terminal_ready_for_sale(terminal, is_online=is_online)
        configuration_metadata = ConfigurationService.ensure_fresh_configuration(
            order.business,
            terminal=terminal,
        )
        had_fiscal_number = bool(order.fiscal_invoice_number)

        order_items = list(order.items.all())
        mapping_map = POSOrderSubmissionService._get_item_mapping_map(
            [str(item.inventory_item_id or '').strip() for item in order_items]
        )
        POSOrderSubmissionService._validate_recipe_fiscal_items(order, order_items, mapping_map)

        # Validate special fiscal sale fields before allocating a number. A
        # rejected B2B/VAT5 request must not create a gap in the sequence.
        EISSaleComplianceService.validate_order_special_fields(
            order,
            terminal,
            buyer_tin,
        )

        transaction_date_time = getattr(order, 'created_at', None) or timezone.now()
        transaction_time_metadata: dict[str, Any] = {'source': 'local_clock'}
        if getattr(settings, 'MRA_EIS_IS_LIVE', False):
            # MRA's fiscal day and receipt timestamp must come from the MRA
            # clock, not from a workstation whose time may be incorrect.
            transaction_date_time, transaction_time_metadata = TerminalService.resolve_mra_transaction_time(
                terminal,
                require_live_ping=is_online,
                allow_cached=True,
            )
            order_metadata = dict(getattr(order, 'eis_validation_metadata', None) or {})
            order_metadata['mra_transaction_time'] = transaction_time_metadata
            order.eis_validation_metadata = order_metadata
            order.save(update_fields=['eis_validation_metadata', 'updated_at'])

        if not had_fiscal_number:
            POSOrderSubmissionService._enforce_offline_limits(
                order,
                terminal,
                is_online,
                is_new_offline_issue=True,
            )

        fiscal_number = POSOrderSubmissionService._generate_fiscal_invoice_number(
            order=order,
            terminal=terminal,
            is_online=is_online,
            invoice_date_time=transaction_date_time,
        )
        if order.fiscal_invoice_number:
            if '-02-' in fiscal_number:
                is_online = False
            elif '-01-' in fiscal_number:
                is_online = True
        sequence_number = POSOrderSubmissionService._extract_sequence_from_fiscal_number(fiscal_number)
        if sequence_number <= 0:
            sequence_number = (
                terminal.online_invoice_counter if is_online else terminal.offline_invoice_counter
            )
        order.fiscal_invoice_number = fiscal_number

        POSOrderSubmissionService._enforce_b2b_online_only(
            order,
            is_online,
            buyer_tin=buyer_tin,
        )
        # Re-check the existing fiscal number against the current mode without
        # counting its amount twice in the offline cumulative limit.
        POSOrderSubmissionService._enforce_offline_limits(
            order,
            terminal,
            is_online,
            is_new_offline_issue=False,
        )
        payload = POSOrderSubmissionService.build_pos_order_payload(
            order,
            terminal,
            is_online,
            buyer_tin=buyer_tin,
            buyer_name=buyer_name,
            transaction_date_time=transaction_date_time,
        )
        offline_signature = POSOrderSubmissionService._apply_offline_signature(
            payload,
            terminal,
            is_online,
        )
        endpoint_key = 'report_sale' if is_online else 'report_sale_offline'

        if not is_online:
            # Offline sales are prepared and queued locally. Calling the MRA
            # endpoint here would make a temporary connection state decide
            # whether a fiscal sale is recorded twice or not at all.
            result = client._dry_run_result(
                endpoint_key,
                payload,
                reason='offline_local_queue',
            )
        else:
            try:
                result = client.call(endpoint_key, payload=payload, method='POST', mutating=True)
                _raise_for_mra_response(
                    endpoint_key,
                    result.data,
                    ok=result.ok or result.dry_run,
                )

                # MRA may accept a sale and simultaneously instruct the POS
                # to stop issuing more sales. Persist that instruction before
                # returning so the next sale is blocked locally as well.
                if not result.dry_run:
                    response_data = result.data if isinstance(result.data, dict) else {}
                    response_inner = TerminalService._response_inner(response_data)
                    raw_should_block = TerminalService._response_value(
                        response_data,
                        'shouldBlockTerminal', 'should_block_terminal',
                    )
                    if TerminalService._optional_bool(raw_should_block) is True:
                        blocking_status = TerminalService._extract_blocking_status(response_data)
                        blocking_status['is_blocked'] = True
                        reason = (
                            blocking_status.get('blocking_reason')
                            or TerminalService._dict_get_any(
                                response_inner,
                                'blockingReason', 'blocking_reason', 'remark', 'message'
                            )
                            or 'MRA requested this terminal to stop issuing sales.'
                        )
                        TerminalService.record_terminal_blocked(
                            terminal,
                            reason=reason,
                            source='mra_sale_response_terminal_block',
                            response_data=response_data,
                            blocking_status=blocking_status,
                        )
                        try:
                            TerminalService.get_terminal_blocking_message(terminal)
                        except Exception as block_exc:
                            logger.warning(
                                'Could not fetch MRA terminal blocking message for %s: %s',
                                terminal.terminal_id,
                                block_exc,
                            )
            except MRAResponseError:
                # A valid HTTP response with validation errors is a permanent
                # business rejection. It must be shown to the operator, not
                # converted into an offline retry.
                raise
            except Exception as exc:
                if is_b2b_sale:
                    # B2B transactions are online-only. Never turn an
                    # uncertain B2B response into an unconfirmed local sale.
                    raise MRAIntegrationError(
                        'B2B EIS sales require MRA online confirmation. Connect to internet and retry.'
                    ) from exc
                logger.warning('POS order submission call failed, storing as prepared: %s', exc)
                result = MRACallResult(
                    ok=False,
                    dry_run=True,
                    status_code=0,
                    endpoint=client._resolve_endpoint(endpoint_key),
                    data={'status': 'prepared', 'reason': 'submission_call_failed', 'error': str(exc)},
                )

        prepared_meta = {
            'prepared': True,
            'dry_run': result.dry_run,
            'endpoint': endpoint_key,
            'prepared_at': timezone.now().isoformat(),
            'buyer_tin': buyer_tin,
            'buyer_name': buyer_name,
            'special_sale_validation': (
                (getattr(order, 'eis_validation_metadata', {}) or {}).get('special_sale_validation', {})
            ),
            'configuration': configuration_metadata,
        }
        fallback_signature = (
            offline_signature
            or hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode('utf-8')).hexdigest()
        )
        response_validation_url = POSOrderSubmissionService._extract_validation_url(result.data)
        response_qr_payload = TerminalService._response_value(
            result.data,
            'qrCodePayload',
            'qr_code_payload',
        )
        offline_validation_url = str(
            (payload.get('handyPosMetadata') or {}).get('offlineValidationURL') or ''
        ).strip()

        # A successful live response without MRA's validation URL cannot
        # produce a certifiable fiscal receipt. Fail closed instead of
        # silently printing a locally fabricated QR code.
        if (
            not result.dry_run
            and is_online
            and getattr(settings, 'MRA_EIS_REQUIRE_FISCAL_EVIDENCE', False)
            and not response_validation_url
            and not str(response_qr_payload or '').strip().startswith(('http://', 'https://'))
        ):
            raise MRAIntegrationError(
                'MRA accepted the sale but returned no receipt validation URL. Contact support before retrying.'
            )

        if result.dry_run:
            order.eis_status = 'PENDING'
            order.eis_submitted_at = None
            order.eis_uuid = None
            order.qr_code_payload = offline_validation_url or json.dumps(prepared_meta)
            order.digital_signature = fallback_signature
        else:
            order.eis_status = 'SUBMITTED'
            order.eis_submitted_at = timezone.now()
            order.eis_uuid = (
                TerminalService._response_value(
                    result.data,
                    'eisUuid', 'eis_uuid', 'invoiceUuid', 'invoice_uuid',
                )
                or None
            )
            order.qr_code_payload = (
                response_validation_url
                or response_qr_payload
                or json.dumps(prepared_meta)
            )
            order.digital_signature = (
                TerminalService._response_value(
                    result.data,
                    'digitalSignature', 'digital_signature',
                )
                or fallback_signature
            )
            order.is_fiscal_locked = True

        order.save(
            update_fields=[
                'fiscal_invoice_number',
                'eis_status',
                'eis_submitted_at',
                'eis_uuid',
                'qr_code_payload',
                'digital_signature',
                'is_fiscal_locked',
                'updated_at',
            ]
        )

        if result.dry_run and is_online:
            try:
                RetryService.queue_retry(
                    terminal,
                    'submit_pos_order',
                    {'order_id': str(order.id)},
                )
            except Exception as retry_exc:
                logger.warning('Failed to queue POS order retry for %s: %s', order.id, retry_exc)

        # Track against MRAInvoice for replay/submission readiness.
        invoice_defaults = {
            'business': order.business,
            'branch': order.branch,
            'terminal': terminal,
            'seller_tin': order.business.tin or '',
            'seller_name': order.business.name,
            'buyer_tin': buyer_tin,
            'buyer_name': buyer_name,
            'items': payload['items'],
            'net_amount': order.net_amount or order.subtotal,
            'tax_amount': order.vat_amount or Decimal('0'),
            'gross_amount': Decimal(str(payload.get('grossAmount') or order.gross_amount or order.total)),
            'tax_breakdown': {
                'standard': str(order.vat_amount or Decimal('0')),
                'zero': '0',
                'exempt': '0',
            },
            'invoice_signature': order.digital_signature or '',
            'status': 'draft',
            'is_online': is_online,
            'invoice_date': transaction_date_time,
            'fiscal_julian_date': POSOrderSubmissionService._extract_julian_from_fiscal_number(fiscal_number)
            or InvoiceService._to_julian_date(transaction_date_time),
            'fiscal_invoice_number': fiscal_number,
            'mra_response': {
                'source': 'pos_order_preparation',
                'order_id': str(order.id),
                'payload': payload,
                'dry_run': result.dry_run,
                'endpoint': endpoint_key,
                'response': result.data,
            },
        }

        mra_invoice_status = 'draft' if result.dry_run else 'submitted'
        mra_invoice_submitted_at = None if result.dry_run else timezone.now()
        mra_invoice_id = (
            TerminalService._response_value(
                result.data,
                'invoiceId', 'invoice_id', 'eisUuid', 'eis_uuid',
            )
            or ''
        )

        fiscal_julian_date = invoice_defaults['fiscal_julian_date']
        mra_invoice, _ = MRAInvoice.objects.update_or_create(
            terminal=terminal,
            fiscal_julian_date=fiscal_julian_date,
            invoice_number=sequence_number,
            defaults={
                **invoice_defaults,
                'status': mra_invoice_status,
                'submitted_at': mra_invoice_submitted_at,
                'mra_invoice_id': mra_invoice_id,
            },
        )

        queue_entry = None
        if (not is_online) and result.dry_run:
            # Persist offline transaction for ordered replay when connectivity returns.
            queue_entry = InvoiceService.queue_offline_invoice(mra_invoice)

        InvoiceAuditLog.objects.create(
            mra_invoice=mra_invoice,
            action='created',
            details={
                'from_pos_order': str(order.id),
                'fiscal_invoice_number': fiscal_number,
                'dry_run': result.dry_run,
                'queued_offline': bool(queue_entry),
            },
        )

        return {
            'order_id': str(order.id),
            'fiscal_invoice_number': fiscal_number,
            'eis_status': order.eis_status,
            'dry_run': result.dry_run,
            'endpoint': endpoint_key,
            'response': result.data,
            'offline_signature': offline_signature,
        }

    @staticmethod
    def submit_pos_order_to_mra(pos_order, eis_uuid, qr_code_payload, digital_signature):
        """
        Backward-compatible manual finalization method.
        """
        ensure_business_eis_enabled(pos_order.business)
        if pos_order.eis_status == 'SUBMITTED':
            raise ValueError('Order already submitted to MRA')

        if pos_order.is_fiscal_locked:
            raise ValueError('Cannot submit locked order')

        if not all([eis_uuid, qr_code_payload, digital_signature]):
            raise ValueError('eis_uuid, qr_code_payload, and digital_signature are required')

        pos_order.eis_uuid = eis_uuid
        pos_order.qr_code_payload = qr_code_payload
        pos_order.digital_signature = digital_signature
        pos_order.eis_status = 'SUBMITTED'
        pos_order.eis_submitted_at = timezone.now()
        pos_order.save()

        return pos_order

    @staticmethod
    def get_pending_pos_orders(business=None, branch=None):
        from pos_sessions.models import Order

        queryset = Order.objects.filter(eis_status='PENDING')
        if business:
            queryset = queryset.filter(business=business)
        if branch:
            queryset = queryset.filter(branch=branch)
        return queryset

    @staticmethod
    def get_submitted_pos_orders(business=None, branch=None):
        from pos_sessions.models import Order

        queryset = Order.objects.filter(eis_status='SUBMITTED')
        if business:
            queryset = queryset.filter(business=business)
        if branch:
            queryset = queryset.filter(branch=branch)
        return queryset

    @staticmethod
    def get_locked_pos_orders(business=None, branch=None):
        from pos_sessions.models import Order

        queryset = Order.objects.filter(is_fiscal_locked=True)
        if business:
            queryset = queryset.filter(business=business)
        if branch:
            queryset = queryset.filter(branch=branch)
        return queryset

    @staticmethod
    def batch_submit_pos_orders(orders_data):
        from pos_sessions.models import Order

        results = {'success': 0, 'failed': 0, 'errors': []}

        for order_data in orders_data:
            try:
                order = Order.objects.get(id=order_data['order_id'])
                POSOrderSubmissionService.submit_pos_order_to_mra(
                    order,
                    order_data['eis_uuid'],
                    order_data['qr_code_payload'],
                    order_data['digital_signature'],
                )
                results['success'] += 1
            except Exception as exc:
                results['failed'] += 1
                results['errors'].append(
                    {
                        'order_id': order_data.get('order_id'),
                        'error': str(exc),
                    }
                )

        return results

    @staticmethod
    def prepare_pending_pos_orders(business=None, branch=None, limit=100):
        """Prepare pending orders for MRA submission pipeline without live submission."""
        if business is not None:
            ensure_business_eis_enabled(business)
        queryset = POSOrderSubmissionService.get_pending_pos_orders(business=business, branch=branch)
        if business is None:
            queryset = queryset.filter(business__settings__enable_eis=True)
        queryset = queryset.exclude(status__in=['Voided', 'Cancelled']).order_by('created_at')[:limit]

        prepared = 0
        failed = 0
        errors: list[dict[str, str]] = []

        for order in queryset:
            try:
                POSOrderSubmissionService.prepare_pos_order_submission(order)
                prepared += 1
            except Exception as exc:
                failed += 1
                errors.append({'order_id': str(order.id), 'error': str(exc)})

        return {
            'prepared': prepared,
            'failed': failed,
            'errors': errors,
        }
