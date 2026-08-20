# MRA EIS Certification Package - Item 4

## Scope
Pre-integration preparation evidence for portal registration, business identity, inventory approval flow, branch/stock linkage, and terminal activation reporting.

Primary artifact: `/home/oscar/Desktop/mwakaproject/handy-pos-new/docs/mra-eis/certification/item-4-preintegration-evidence-latest.json`

## 1) Portal Registration Readiness
- Developer Portal: manual confirmation required
- Taxpayer Portal: manual confirmation required
- Reason: registration proof is external to this repository and must be attached manually.

## 2) Business Identification & Requirements
- Business: `MRA Dry Readiness Business`
- Business ID: `1`
- TIN: `9260305044827`
- Email: ``
- Phone: ``
- VAT Registered: `True`
- MRA Enrolled: `True`
- Missing fields: `['email', 'phone']`

## 3) Inventory Upload and Approval Demonstration
- Total mappings: `13`
- Approved mappings: `13`
- Synced mappings: `13`
- Flow implementation:
  - Mapping sync: `ProductMappingService.sync_inventory_mapping_to_mra`
  - Config sync: `ConfigurationService.fetch_and_store_configuration`
- Sample mapped items are included in the JSON artifact.

## 4) Branch, Stock, and Terminal Linkage
- Branches defined: `13`
- Terminals linked: `13`
- Per-branch inventory/mapping summary is included in the JSON artifact.

## 5) Terminal Activation and Reporting to MRA
- Terminal activation request/response evidence is included.
- Post-activation reporting evidence includes online and offline sale-report flows.
- Reporting endpoints: `{'report_sale': '/api/v1/sales/report-sale', 'report_sale_offline': '/api/v1/sales/report-sale-offline'}`

## Manual Actions Before Submission
- Complete MRA Taxpayer/Developer portal registration and keep proof.
- Confirm business contact fields (email/phone) are complete for submission forms.
- Attach portal screenshots and MRA correspondence to submission dossier.

## Reproducibility
```bash
./scripts/mra-eis-dry-readiness.sh
```
