# HandyPOS System Features Template

Use this as a partner-facing briefing document. Replace fields in `[brackets]` with your current business details.

## 1. Document Info
- Product: `HandyPOS`
- Version/Build: `[e.g. v1.0.0 / Mar 2026 build]`
- Audience: `Partners / Investors / Strategic Resellers`
- Prepared by: `[Name]`
- Date: `[Date]`

## 2. Executive Summary
HandyPOS is an offline-first, multi-branch point-of-sale and business operations system for retail and service businesses.  
It combines POS, inventory, sessions, invoicing with compliance (MRA EIS) ready

### Target Business Types
- Restaurant
- Supermarket
- Grocery
- Bar & Liquor
- Beauty Salon and Spa
- Pharmacy
- Generic retail/business

## 3. System At a Glance
- Platform: Web (Next.js/PWA), Desktop (Tauri), backend API (Django REST)
- Data strategy: Local-first (Dexie/IndexedDB) + background sync to backend
- User types: Owner/Admin, Manager, Cashier
- Branch model: Multi-branch with per-branch operations and switching



### 4.1 Setup, Authentication, and Access
- Guided setup wizard for business profile and initial subscription setup
- Login via email or phone
- Business/branch-aware login flow
- Role-based access control (Admin, Manager, Cashier, Waiter)

### 4.2 Multi-Branch Management
- Create, edit, delete branches
- Set/switch active branch from header and settings
- Branch-specific data separation (inventory, sessions, reports, orders)

### 4.3 POS Operations
- Branch-based POS checkout with business-type-specific POS layouts
- Requires active session before sales
- Payment methods: Cash, Card, Mobile Money, On Account, Other
- Receipt printing with configurable printer settings
- Barcode support (scanner + camera scanner on supported devices)
- Tax snapshot captured at order/line level for audit/compliance
- MRA mapping checks before selling mapped items (compliance guardrail)

### 4.4 Session Management
- Start session with opening float and opening stock snapshot
- Close session with reconciliation (expected cash vs actual cash)
- Session reports: Sales report, Z report, Stock report
- Session history and sale drill-down
- Correction workflows: void transactions, credit notes, debit notes

### 4.5 Inventory and Stock Control
- Inventory items by branch (ingredient/sellable)
- Product create/edit with barcode/SKU/product code support
- Stock receiving from purchases
- Stock transfer between branches
- Waste recording
- Stock audits and approval flow
- Import products via CSV or from another branch
- Inventory search + barcode lookup

### 4.6 Suppliers and Purchasing
- Supplier management with contact info
- Supplier TIN and VAT fields for compliance
- Purchase orders (draft/pending/approved/received/completed/cancelled)
- Supplier balances, payment tracking, and purchase history

### 4.7 Customers and Invoicing
- Customer management (B2C/B2B details)
- Invoice creation with line items, tax, due dates, notes
- Invoice lifecycle: Draft, Sent, Paid, Void
- Link invoice payment to POS order and stock movements
- PDF invoice export

### 4.8 Expenses and Approvals
- Expense capture with categories and approval status
- Manager/admin approval workflows
- Central approvals screen for stock audits, expenses, and invoices

### 4.9 Reports and Analytics
- Dashboard KPIs and trend visualizations
- Payment mix and top-selling products
- Inventory insights and low-stock visibility
- Financial report views by sales, orders, products, categories, and staff
- CSV exports for dashboard/reports


### 4.12 Settings and Device Configuration
- Business profile settings
- Branch settings
- Tax rate management (default, active/inactive, effective dates)
- MRA EIS setup and terminal activation
- Printer configuration (default printer, copies, paper width, receipt options)
- Scanner configuration (default scanner, enabled scanners, discovery)
- Billing and subscription settings



## 5. Compliance and Control (MRA EIS Focus)
- Terminal onboarding and activation (TAC-based)
- MRA configuration sync and product code mapping
- Product-to-MRA mapping approval and sync status
- EIS invoice/receipt lifecycle states (PENDING/SUBMITTED/ACCEPTED/REJECTED)
- Fiscal identifiers and QR/signature fields on transactions
- Offline queue and retry handling for compliance submissions
- Immutable/locked records after key compliance events (where applicable)
- Tax rate locking behavior after usage (where applicable)

## 6. Offline-First and Sync Capabilities
- Local operational continuity when internet is unavailable
- Dirty-record tracking for create/update/delete operations
- Sync queues with retries and de-duplication
- Auto-sync on reconnect + periodic sync intervals
- Branch-aware full sync and data pull
- Local fallback when backend requests fail


### Cashier
- POS, sessions, dashboard, kitchen visibility

## 8. Typical Daily Workflow
1. User logs in and selects business/branch (if multiple branches exist).
2. Open session (opening float + opening stock context).
3. Run POS sales, receive/transfer stock, handle take orders/kitchen.
4. Print receipts and submit compliance data where enabled.
5. Review reports and approvals.
6. Close session with reconciliation and generate Z/stock reports.

## 9. Business Value Talking Points
- Reduced downtime through offline-first architecture
- Better stock control and shrinkage tracking
- Multi-branch operational visibility
- Cleaner audit/compliance trail (especially for tax/fiscal workflows)
- Modular feature controls aligned with subscription model
- Device-ready operations (printer/scanner integration)

## 10. Current Deployment/Implementation Notes
- Frontend: Next.js (App Router)
- Desktop: Tauri runtime
- Backend: Django + DRF
- Local data: IndexedDB via Dexie
- API domains include: accounts, business, staff, inventory, sessions, orders, digital-menu, mra-eis, subscription, affiliate, system config

## 11. Partner Q&A Section (Fillable)
- Primary target segment: `[e.g. mid-size retail chains in Malawi]`
- Competitive advantages: `[offline reliability, MRA readiness, branch controls]`
- Revenue model summary: `[credits + daily charges + feature pricing]`
- Integration roadmap: `[payments, ERP, accounting, etc.]`
- Go-to-market motion: `[direct sales / channel partners / referrals]`

## 12. Optional Appendix: Route/Module Map
- Dashboard: `/dashboard`
- POS: `/dashboard/pos`
- Sessions: `/dashboard/sessions`
- Reports: `/dashboard/sales`
- Inventory: `/dashboard/inventory`
- Suppliers: `/dashboard/suppliers`
- Staff: `/dashboard/staff`
- Invoicing: `/dashboard/invoicing`
- Expenses: `/dashboard/expenses`
- Customers: `/dashboard/customers`
- Approvals: `/dashboard/approvals`
- Kitchen: `/dashboard/kitchen`
- Menu Builder: `/dashboard/menu`
- Settings: `/dashboard/settings/*`
- Affiliate: `/dashboard/affiliate`
