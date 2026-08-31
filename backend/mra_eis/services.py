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
import uuid
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import requests
from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from .models import (
    ConfigurationSyncLog,
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


@dataclass
class MRACallResult:
    ok: bool
    dry_run: bool
    status_code: int
    endpoint: str
    data: dict[str, Any]


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

    def _build_signature(self, payload: dict[str, Any] | None) -> str:
        secret = (getattr(settings, 'MRA_EIS_SECRET_KEY', '') or '').encode('utf-8')
        if not secret:
            return ''
        message = self._canonical_json(payload).encode('utf-8')
        return hmac.new(secret, message, hashlib.sha256).hexdigest()

    def _build_headers(self, endpoint_key: str, payload: dict[str, Any] | None) -> dict[str, str]:
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }

        # MRA's initial activation request is TAC-based and unauthenticated.
        # Keep the existing gateway headers for post-activation calls.
        if endpoint_key != 'activate_terminal':
            access_key = getattr(settings, 'MRA_EIS_ACCESS_KEY', '') or ''
            if access_key:
                headers['x-access-key'] = access_key

            signature = self._build_signature(payload)
            if signature:
                headers['x-signature'] = signature

        if endpoint_key != 'activate_terminal' and self.terminal and self.terminal.mra_token:
            headers['Authorization'] = f"Bearer {self.terminal.mra_token}"

        return headers

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
        )

    def call(
        self,
        endpoint_key: str,
        payload: dict[str, Any] | None = None,
        *,
        method: str = 'POST',
        mutating: bool = True,
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
        headers = self._build_headers(endpoint_key, payload)

        try:
            response = requests.request(
                method=method.upper(),
                url=endpoint,
                json=payload or {},
                headers=headers,
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
            response.raise_for_status()
            response_data: dict[str, Any] = {}
            if response.content:
                try:
                    response_data = response.json()
                except ValueError:
                    # Some MRA endpoints return a plain-text body even when
                    # the request succeeded. Preserve it for audit/diagnostics.
                    response_data = {'raw': response.text}

            return MRACallResult(
                ok=True,
                dry_run=False,
                status_code=response.status_code,
                endpoint=endpoint,
                data=response_data,
            )
        except requests.RequestException as exc:
            raise MRAIntegrationError(f"MRA request failed ({endpoint_key}): {exc}") from exc


class TerminalService:
    """Terminal management and onboarding."""

    @staticmethod
    def normalize_device_serial(value: Any) -> str:
        return str(value or '').strip()

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
        terminals = Terminal.objects.select_for_update().filter(business=business, branch=branch)
        terminal = (
            terminals.filter(device_serial__iexact=incoming_serial).order_by('-updated_at').first()
            if incoming_serial
            else terminals.order_by('-updated_at').first()
        )

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
            device_serial=device_serial,
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
            logger.warning('Terminal activation call failed, falling back to pending mode: %s', exc)
            result = MRACallResult(
                ok=False,
                dry_run=True,
                status_code=0,
                endpoint=client._resolve_endpoint('activate_terminal'),
                data={'status': 'pending_activation', 'error': str(exc)},
            )
        response_data = result.data or {}
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
        """
        Refresh terminal token (onboarding confirm endpoint compatible fallback).
        """
        client = MRAEISClient(terminal=terminal)
        payload = {
            'terminalId': terminal.mra_terminal_id,
            'action': 'refresh_token',
        }
        result = client.call('confirm_terminal', payload=payload, method='POST', mutating=True)

        token = (
            result.data.get('token')
            or result.data.get('accessToken')
            or result.data.get('access_token')
            or ''
        )

        if token:
            terminal.mra_token = token
            terminal.token_expires_at = timezone.now() + timedelta(hours=24)
            terminal.save(update_fields=['mra_token', 'token_expires_at', 'updated_at'])

        TerminalAuditLog.objects.create(
            terminal=terminal,
            action='token_refreshed',
            details={
                'dry_run': result.dry_run,
                'response': result.data,
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
            if is_online:
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

    @staticmethod
    def _extract_config_data(data: dict[str, Any], config_type: str) -> dict[str, Any]:
        if not data:
            return {'source': 'dry_run', 'config_type': config_type}

        aliases = {
            'global_configuration': 'globalConfiguration',
            'terminal_configuration': 'terminalConfiguration',
            'taxpayer_configuration': 'taxpayerConfiguration',
            'terminal_site_products': 'terminalSiteProducts',
        }
        containers = [data]
        nested_data = data.get('data') if isinstance(data, dict) else None
        if isinstance(nested_data, dict):
            containers.append(nested_data)

        for container in containers:
            for key in (config_type, aliases.get(config_type, '')):
                if key and isinstance(container.get(key), dict):
                    return container[key]

        if 'configurations' in data and isinstance(data['configurations'], dict):
            found = data['configurations'].get(config_type)
            if isinstance(found, dict):
                return found

        return {'raw': data, 'config_type': config_type}

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
        if config_types is None:
            config_types = [
                'global_configuration',
                'terminal_configuration',
                'taxpayer_configuration',
                'tax_rules',
                'receipt_format',
                'product_codes',
                'system_settings',
            ]

        sync_log = ConfigurationSyncLog.objects.create(
            business=business,
            status='pending',
            config_types=config_types,
            started_at=timezone.now(),
        )

        try:
            client = MRAEISClient(terminal=terminal)
            result = client.call('get_latest_config', payload=None, method='POST', mutating=False)
            response_data = result.data or {}

            for config_type in config_types:
                config_data = ConfigurationService._extract_config_data(response_data, config_type)
                config_version = (
                    config_data.get('version')
                    or response_data.get('version')
                    or timezone.now().strftime('%Y%m%d%H%M%S')
                )

                MRAConfiguration.objects.filter(
                    business=business,
                    config_type=config_type,
                    is_active=True,
                ).update(is_active=False, effective_to=timezone.now())

                MRAConfiguration.objects.create(
                    business=business,
                    config_type=config_type,
                    config_version=str(config_version),
                    config_data=config_data,
                    effective_from=timezone.now(),
                    fetched_from_mra_at=timezone.now(),
                    is_active=True,
                )

            sync_log.status = 'success'
            sync_log.completed_at = timezone.now()
            sync_log.save(update_fields=['status', 'completed_at'])
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


class ProductMappingService:
    """MRA product mapping helpers."""

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
                }
            ],
        }

        client = MRAEISClient(terminal=terminal)
        result = client.call('save_inventory_items', payload=payload, method='POST', mutating=True)

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
            payload = InvoiceService._build_signature_payload(invoice)
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
    def _fetch_last_offline_transaction_snapshot(terminal: Terminal) -> dict[str, Any] | None:
        """
        Best-effort read of MRA's last offline transaction state.
        Failure is non-blocking; used for audit/observability.
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
            return None

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
        net_amount, tax_amount, gross_amount, tax_breakdown = InvoiceService._calculate_amounts(items)
        stored_items = InvoiceService._to_json_safe(items)

        invoice_number = terminal.increment_online_counter() if is_online else terminal.increment_offline_counter()

        invoice = MRAInvoice.objects.create(
            business=terminal.business,
            branch=terminal.branch,
            terminal=terminal,
            invoice_number=invoice_number,
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
            invoice_date=timezone.now(),
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
        payload = {
            'terminalId': invoice.terminal.mra_terminal_id,
            'invoiceNumber': str(invoice.invoice_number),
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
        endpoint_key = 'report_sale' if invoice.is_online else 'report_sale_offline'
        payload = InvoiceService._build_mra_invoice_payload(invoice)

        try:
            client = MRAEISClient(terminal=invoice.terminal)
            result = client.call(endpoint_key, payload=payload, method='POST', mutating=True)

            invoice.mra_invoice_id = (
                result.data.get('invoiceId')
                or result.data.get('invoice_id')
                or result.data.get('eisUuid')
                or result.data.get('eis_uuid')
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
            invoice.save(update_fields=['mra_invoice_id', 'status', 'submitted_at', 'mra_response', 'updated_at'])

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
        if invoice.is_online:
            raise ValueError('Cannot queue online invoice')

        existing_entry = OfflineInvoiceQueue.objects.filter(mra_invoice=invoice).first()
        if existing_entry:
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
            queued_total = InvoiceService._sum_queued_offline_gross_amount(invoice.terminal)
            projected_total = queued_total + Decimal(str(invoice.gross_amount or 0))
            if projected_total > limits.max_cumulative_amount:
                raise MRAIntegrationError(
                    'Offline cumulative amount exceeds configured limit '
                    f'({projected_total} > {limits.max_cumulative_amount}).'
                )

        last_entry = (
            OfflineInvoiceQueue.objects.filter(terminal=invoice.terminal)
            .order_by('-queue_position')
            .first()
        )
        queue_position = (last_entry.queue_position + 1) if last_entry else 1

        queue_entry = OfflineInvoiceQueue.objects.create(
            terminal=invoice.terminal,
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
        queued_entries = OfflineInvoiceQueue.objects.filter(
            terminal=terminal,
            status__in=['queued', 'failed'],
        ).order_by('queue_position')

        synced_count = 0
        failed_count = 0
        offline_limits = ConfigurationService.get_offline_limits(terminal.business)
        last_offline_snapshot = InvoiceService._fetch_last_offline_transaction_snapshot(terminal)

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

                InvoiceService.submit_invoice(entry.mra_invoice)

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
            },
        )

        return {'synced': synced_count, 'failed': failed_count}


class ReceiptService:
    """Receipt rendering and QR payload generation."""

    @staticmethod
    def generate_receipt(invoice):
        terminal_code = invoice.terminal.mra_terminal_id or invoice.terminal.terminal_id
        mode_code = '01' if invoice.is_online else '02'
        fiscal_invoice_number = f"{terminal_code}-{mode_code}-{int(invoice.invoice_number):08d}"
        signature_preview = (
            invoice.invoice_signature
            if len(invoice.invoice_signature) <= 24
            else f"{invoice.invoice_signature[:12]}...{invoice.invoice_signature[-8:]}"
        )

        tax_breakdown = invoice.tax_breakdown or {}
        standard_tax = str(tax_breakdown.get('standard', '0'))
        zero_tax = str(tax_breakdown.get('zero', '0'))
        exempt_tax = str(tax_breakdown.get('exempt', '0'))

        receipt_lines = [
            '=' * 40,
            'MRA EIS FISCAL RECEIPT',
            '=' * 40,
            'ORDER INFO',
            '-' * 40,
            f'Receipt No: RCP-{invoice.invoice_number}',
            f'Fiscal Invoice: {fiscal_invoice_number}',
            f"Date: {invoice.invoice_date.strftime('%Y-%m-%d %H:%M:%S')}",
            f'Payment Mode: {"ONLINE" if invoice.is_online else "OFFLINE"}',
            '',
            'COMPANY INFO',
            '-' * 40,
            f'Seller: {invoice.seller_name}',
            f'Seller TIN: {invoice.seller_tin}',
            '',
            'ITEM BREAKDOWN',
            '-' * 40,
        ]

        for item in invoice.items:
            quantity = Decimal(str(item.get('quantity', 0) or item.get('qty', 0)))
            unit_price = Decimal(str(item.get('unit_price', 0) or item.get('unitPrice', 0)))
            line_total = quantity * unit_price
            receipt_lines.append(f"{item.get('name', 'Item')}")
            receipt_lines.append(f"  Qty: {quantity} x {unit_price} = {line_total}")

        receipt_lines.extend(
            [
                '-' * 40,
                'TAX BREAKDOWN (MRA EIS)',
                '-' * 40,
                f'Standard VAT: {standard_tax}',
                f'Zero VAT: {zero_tax}',
                f'Exempt VAT: {exempt_tax}',
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
                '=' * 40,
                'Thank you for your business!',
                '=' * 40,
            ]
        )

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
            'date': invoice.invoice_date.isoformat(),
        }

        receipt = Receipt.objects.create(
            mra_invoice=invoice,
            receipt_number=f'RCP-{invoice.invoice_number}',
            receipt_text=receipt_text,
            qr_code_data=json.dumps(qr_data),
        )

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

        for retry in pending_retries:
            try:
                retry.status = 'processing'
                retry.save(update_fields=['status'])

                if retry.operation_type == 'submit_invoice':
                    invoice = MRAInvoice.objects.get(id=retry.payload['invoice_id'])
                    InvoiceService.submit_invoice(invoice)
                elif retry.operation_type == 'sync_offline_invoices':
                    terminal = Terminal.objects.get(id=retry.payload['terminal_id'])
                    InvoiceService.sync_offline_invoices(terminal)
                elif retry.operation_type == 'submit_pos_order':
                    from pos_sessions.models import Order

                    order = Order.objects.get(id=retry.payload['order_id'])
                    POSOrderSubmissionService.prepare_pos_order_submission(order)

                retry.status = 'completed'
                retry.completed_at = timezone.now()
                retry.save(update_fields=['status', 'completed_at'])
            except Exception as exc:
                retry.attempt_count += 1
                retry.last_error = str(exc)

                if retry.attempt_count >= retry.max_attempts:
                    retry.status = 'failed'
                else:
                    retry.status = 'pending'
                    retry.next_attempt_at = retry.calculate_next_retry()

                retry.save(update_fields=['attempt_count', 'last_error', 'status', 'next_attempt_at'])


class POSOrderSubmissionService:
    """
    POS order submission lifecycle.

    In dry-run mode this service prepares and stores everything needed for MRA
    without sending live transactions.
    """

    @staticmethod
    def _resolve_order_terminal(order):
        terminal = (
            Terminal.objects.filter(
                business=order.business,
                branch=order.branch,
            )
            .order_by('-updated_at')
            .first()
        )

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
    def _generate_fiscal_invoice_number(order, terminal: Terminal, is_online: bool) -> str:
        if order.fiscal_invoice_number:
            return order.fiscal_invoice_number

        sequence = terminal.increment_online_counter() if is_online else terminal.increment_offline_counter()
        mode = '01' if is_online else '02'

        terminal_code = terminal.mra_terminal_id or terminal.terminal_id or f'TRM-{order.branch_id}'
        terminal_code = str(terminal_code).replace(' ', '').upper()

        return f"{terminal_code}-{mode}-{int(sequence):08d}"

    @staticmethod
    def _extract_sequence_from_fiscal_number(fiscal_invoice_number: str) -> int:
        try:
            return int(str(fiscal_invoice_number).rsplit('-', 1)[-1])
        except Exception:
            return 0

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
        # Keep legacy signature key for compatibility with existing integration code.
        payload['signature'] = offline_signature
        return offline_signature

    @staticmethod
    def _get_item_mapping_map(order_item_ids: list[str]) -> dict[str, Any]:
        try:
            from inventory.models import MRAProductMapping as InventoryMRAProductMapping

            mappings = InventoryMRAProductMapping.objects.filter(
                inventory_item_id__in=order_item_ids,
            ).values(
                'inventory_item_id',
                'mra_product_code',
                'mra_product_name',
                'mra_tax_type',
                'mra_tax_rate',
                'tax_calculation_method',
                'is_approved',
                'mra_synced',
            )
            return {str(m['inventory_item_id']): m for m in mappings}
        except Exception:
            return {}

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
    ) -> dict[str, Any]:
        order_items = list(order.items.all())
        mapping_map = POSOrderSubmissionService._get_item_mapping_map(
            [str(item.inventory_item_id) for item in order_items]
        )

        payload_items: list[dict[str, Any]] = []
        for item in order_items:
            key = str(item.inventory_item_id)
            mapping = mapping_map.get(key) or {}
            payload_items.append(
                {
                    'inventoryItemId': key,
                    'productCode': mapping.get('mra_product_code') or item.mra_product_code or '',
                    'productName': mapping.get('mra_product_name') or item.name,
                    'quantity': str(item.quantity),
                    'unitPrice': str(item.price),
                    'taxType': mapping.get('mra_tax_type') or item.tax_type or 'standard',
                    'taxRate': str(mapping.get('mra_tax_rate') or item.tax_rate or 0),
                    'lineNetAmount': str(item.subtotal),
                    'lineTaxAmount': str(item.tax_amount),
                    'lineGrossAmount': str(item.total),
                    'calculationMethod': mapping.get('tax_calculation_method') or item.tax_calculation_method or 'inclusive',
                }
            )

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
            'transactionDate': order.created_at.isoformat(),
            'paymentMethod': order.payment_method,
            'buyerTin': buyer_tin,
            'buyerName': buyer_name,
            'currency': currency,
            'netAmount': str(order.net_amount or order.subtotal),
            'taxAmount': str(order.vat_amount or Decimal('0')),
            'grossAmount': str(order.gross_amount or order.total),
            'isOffline': not is_online,
            'items': payload_items,
        }

        return payload

    @staticmethod
    @transaction.atomic
    def prepare_pos_order_submission(order, force_online: bool | None = None) -> dict[str, Any]:
        if order.status in {'Voided', 'Cancelled'}:
            return {
                'order_id': str(order.id),
                'skipped': True,
                'reason': f'order_status_{order.status.lower()}',
            }

        terminal = POSOrderSubmissionService._resolve_order_terminal(order)
        is_online = bool(force_online) if force_online is not None else bool(terminal.is_online)
        had_fiscal_number = bool(order.fiscal_invoice_number)

        fiscal_number = POSOrderSubmissionService._generate_fiscal_invoice_number(
            order=order,
            terminal=terminal,
            is_online=is_online,
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

        # Enforce MRA offline policy limits (age/cumulative amount) before attempting submission.
        POSOrderSubmissionService._enforce_offline_limits(
            order,
            terminal,
            is_online,
            is_new_offline_issue=not had_fiscal_number,
        )

        buyer_tin, buyer_name = POSOrderSubmissionService._resolve_buyer_details(order)
        payload = POSOrderSubmissionService.build_pos_order_payload(
            order,
            terminal,
            is_online,
            buyer_tin=buyer_tin,
            buyer_name=buyer_name,
        )
        offline_signature = POSOrderSubmissionService._apply_offline_signature(
            payload,
            terminal,
            is_online,
        )
        endpoint_key = 'report_sale' if is_online else 'report_sale_offline'

        client = MRAEISClient(terminal=terminal)
        try:
            result = client.call(endpoint_key, payload=payload, method='POST', mutating=True)
        except Exception as exc:
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
        }
        fallback_signature = (
            offline_signature
            or hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode('utf-8')).hexdigest()
        )

        if result.dry_run:
            order.eis_status = 'PENDING'
            order.eis_submitted_at = None
            order.eis_uuid = None
            order.qr_code_payload = json.dumps(prepared_meta)
            order.digital_signature = fallback_signature
        else:
            order.eis_status = 'SUBMITTED'
            order.eis_submitted_at = timezone.now()
            order.eis_uuid = (
                result.data.get('eisUuid')
                or result.data.get('eis_uuid')
                or result.data.get('invoiceUuid')
                or result.data.get('invoice_uuid')
                or None
            )
            order.qr_code_payload = (
                result.data.get('qrCodePayload')
                or result.data.get('qr_code_payload')
                or json.dumps(prepared_meta)
            )
            order.digital_signature = (
                result.data.get('digitalSignature')
                or result.data.get('digital_signature')
                or fallback_signature
            )

        order.save(
            update_fields=[
                'fiscal_invoice_number',
                'eis_status',
                'eis_submitted_at',
                'eis_uuid',
                'qr_code_payload',
                'digital_signature',
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
            'gross_amount': order.gross_amount or order.total,
            'tax_breakdown': {
                'standard': str(order.vat_amount or Decimal('0')),
                'zero': '0',
                'exempt': '0',
            },
            'invoice_signature': order.digital_signature or '',
            'status': 'draft',
            'is_online': is_online,
            'invoice_date': order.created_at,
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
            result.data.get('invoiceId')
            or result.data.get('invoice_id')
            or result.data.get('eisUuid')
            or result.data.get('eis_uuid')
            or ''
        )

        mra_invoice, _ = MRAInvoice.objects.update_or_create(
            terminal=terminal,
            invoice_number=sequence_number,
            is_online=is_online,
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
        queryset = POSOrderSubmissionService.get_pending_pos_orders(business=business, branch=branch)
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
