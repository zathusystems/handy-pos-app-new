# MRA EIS Certification Package - Item 2

## Scope
Technical documentation and evidence for API usage, security controls, and offline-sync behavior.

Generated: `2026-03-05T06:12:21.986524+00:00`

## 1) Technical Documentation of EIS API Integration
The backend integration is implemented in:
- `backend/mra_eis/services.py` (onboarding, config sync, inventory sync, invoice submission, offline sync)
- `backend/mra_eis/views.py` and `backend/mra_eis/urls.py` (API exposure)
- `backend/mra_eis/models.py` (compliance records, queue, audit and retry entities)

Configured endpoint map:
- `activate_terminal` -> `/api/v1/onboarding/activate-terminal`
- `check_terminal_unblock_status` -> `/api/v1/utilities/check-terminal-unblock-status`
- `confirm_terminal` -> `/api/v1/onboarding/confirm-terminal`
- `get_last_offline_transaction` -> `/api/v1/sales/get-last-offline-transaction`
- `get_latest_config` -> `/api/v1/utilities/get-latest-config`
- `get_terminal_blocking_message` -> `/api/v1/utilities/get-terminal-blocking-message`
- `get_terminal_site_products` -> `/api/v1/utilities/get-terminal-site-products`
- `report_sale` -> `/api/v1/sales/report-sale`
- `report_sale_offline` -> `/api/v1/sales/report-sale-offline`
- `save_inventory_items` -> `/api/v1/utilities/save-inventory-items`
- `sync_product_status` -> `/api/v1/utilities/sync-product-status`
- `validate_vat5` -> `/api/v1/utilities/validate-vat5`

Execution environment used for this evidence:
- `DJANGO_SETTINGS_MODULE`: `core.settings_test`
- `database_engine`: `django.db.backends.sqlite3`
- `MRA_EIS_MODE`: `TEST`
- `MRA_EIS_DRY_RUN`: `True`
- `MRA_EIS_ALLOW_LIVE_SUBMISSION`: `False`

## 2) Evidence of Correct API Usage (Input/Output + Error Handling)
Primary artifact: `/home/oscar/Desktop/mwakaproject/handy-pos-new/docs/mra-eis/certification/item-2-api-evidence-latest.json`

Included evidence:
- Terminal activation input/output example
- Configuration sync request scope
- Inventory mapping sync output
- Online sale report payload and response
- Offline sale report payload and response
- Error queue metrics (unresolved API errors, retry jobs)

Automated flow result:
- functional flow status: `pass`
- test suite status: `pass`
- test labels: `mra_eis.tests`
- summary: pass `8`, warn `2`, fail `0`

## 3) Security Measures Before Submission
Implemented controls:
- Request signing (HMAC) via `x-signature` in `MRAEISClient._build_signature`.
- Access key support via `x-access-key` in `MRAEISClient._build_headers`.
- Token-based terminal auth (`Authorization: Bearer`).
- Live-mode safeguards in `backend/core/settings.py` (disallow LIVE with dry-run, missing keys, or disabled submission).
- Write-once style audit trail entities (`InvoiceAuditLog`, `TerminalAuditLog`, `OfflineAuditLog`).
- Sensitive values are redacted in generated evidence artifacts.

## 4) Offline Mode and Deferred Sync Handling
Offline handling evidence includes:
- Offline invoice creation and queueing (`OfflineInvoiceQueue`).
- Ordered sync replay (`InvoiceService.sync_offline_invoices`).
- Retry and failure metadata on queue entries.
- Audit events for queue and sync lifecycle.

Observed dry-run evidence in this run:
- offline queue status: `synced`
- offline invoice status: `offline_synced`
- sync summary: `{'synced': 1, 'failed': 0}`

## Reproducibility
Regenerate this package with:
```bash
./scripts/mra-eis-dry-readiness.sh
```
