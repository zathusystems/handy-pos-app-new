# MRA EIS Certification Package - Item 5

## Scope
Terminal activation flow evidence for onboarding activation, post-approval configuration pull, and transaction reporting (real-time and queued).

Primary artifact: `/home/oscar/Desktop/mwakaproject/handy-pos-new/docs/mra-eis/certification/item-5-terminal-activation-evidence-latest.json`

Overall assertion status: `pass`

## 1) Activate Terminals via Onboarding API
- Endpoint: `/api/v1/onboarding/activate-terminal`
- Terminal ID: `710c81dc-8663-4ae3-9e9f-0071ec21dd57`
- Terminal status: `pending_activation`
- Dry run: `True`
- Full request/response payload evidence is in JSON artifact.

## 2) Pull Configuration from MRA After Approval
- Endpoint: `/api/v1/utilities/get-latest-config`
- Sync status: `success`
- Sync log id: `4e844ba5-824e-42e2-923d-c32329497a68`
- Config types: `['tax_rules', 'receipt_format', 'product_codes', 'system_settings']`

## 3) Report Transaction Data (Real-time and Queued)
- Real-time endpoint: `/api/v1/sales/report-sale`
- Queued endpoint: `/api/v1/sales/report-sale-offline`
- Real-time invoice status: `submitted`
- Queued invoice status: `offline_synced`
- Queue status: `synced`

## Certification Assertions
- `activate_terminal_via_onboarding_api`: `pass` (Terminal activation request/response captured from onboarding flow.)
- `pull_configuration_after_terminal_approval`: `pass` (Configuration sync executed with MRA config types.)
- `report_transactions_realtime_or_queued`: `pass` (Online report_sale and offline queued/sync paths executed.)

## Reproducibility
```bash
./scripts/mra-eis-dry-readiness.sh
```
