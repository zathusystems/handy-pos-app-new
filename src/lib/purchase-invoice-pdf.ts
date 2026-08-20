import { type Business, type PurchaseRecord } from '@/lib/db';

export interface PurchaseInvoiceGroup {
  groupId: string;
  displayDate: string;
  supplierName: string;
  paymentStatus: string;
  amountDue: number;
  totalCost: number;
  totalVat: number;
  totalWithVat: number;
  vatAmount?: number;
  items: PurchaseRecord[];
}

interface GeneratePurchaseInvoicePdfOptions {
  purchase: PurchaseInvoiceGroup;
  business?: Pick<Business, 'name' | 'address' | 'phone' | 'email' | 'tin'> | null;
  currencyCode?: string;
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const parseDateCandidate = (...values: unknown[]): Date | null => {
  for (const value of values) {
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) return value;
      continue;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1_000_000_000_000 ? value * 1000 : value;
      const parsed = new Date(ms);
      if (!Number.isNaN(parsed.getTime())) return parsed;
      continue;
    }

    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') continue;

    if (/^\d+$/.test(trimmed)) {
      const numericValue = Number(trimmed);
      if (Number.isFinite(numericValue)) {
        const ms = numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
        const parsed = new Date(ms);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
};

const formatDisplayDate = (...values: unknown[]): string => {
  const parsed = parseDateCandidate(...values);
  return parsed ? parsed.toLocaleDateString() : 'N/A';
};

const formatCurrency = (amount: number, currencyCode: string): string => {
  const normalizedAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(normalizedAmount);
  } catch {
    const fallbackPrefix = currencyCode === 'MWK' ? 'MWK' : '$';
    return `${fallbackPrefix} ${normalizedAmount.toFixed(2)}`;
  }
};

const resolveTaxMethod = (value: unknown): 'inclusive' | 'exclusive' => {
  return value === 'inclusive' ? 'inclusive' : 'exclusive';
};

const normalizeTaxRate = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const toFiniteNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveRecordVat = (record: PurchaseRecord): number => {
  const taxRate = normalizeTaxRate(record.taxRate);
  const method = resolveTaxMethod(record.taxCalculationMethod);
  const base = Number(record.totalCost || 0);
  if (!Number.isFinite(base) || base <= 0 || taxRate <= 0) {
    return typeof record.taxAmount === 'number' && Number.isFinite(record.taxAmount) ? record.taxAmount : 0;
  }

  if (method === 'inclusive') {
    return base - base / (1 + taxRate / 100);
  }

  return base * (taxRate / 100);
};

const resolvePurchaseVat = (purchase: Pick<PurchaseInvoiceGroup, 'totalVat' | 'vatAmount'>): number => {
  const computedVat = toFiniteNumber(purchase.totalVat) ?? 0;
  if (computedVat > 0) {
    return computedVat;
  }

  return toFiniteNumber(purchase.vatAmount) ?? 0;
};

const resolvePurchaseTotalWithVat = (
  purchase: Pick<PurchaseInvoiceGroup, 'totalCost' | 'totalVat' | 'totalWithVat' | 'vatAmount'>
): number => {
  const computedVat = toFiniteNumber(purchase.totalVat) ?? 0;
  const computedTotal = toFiniteNumber(purchase.totalWithVat) ?? 0;
  const fallbackVat = toFiniteNumber(purchase.vatAmount) ?? 0;

  if (computedVat > 0 || fallbackVat <= 0) {
    return computedTotal;
  }

  return purchase.totalCost + fallbackVat;
};

const buildPurchaseInvoiceHtml = (
  purchase: PurchaseInvoiceGroup,
  business: Pick<Business, 'name' | 'address' | 'phone' | 'email' | 'tin'> | null | undefined,
  currencyCode: string
): string => {
  const businessName = business?.name?.trim() || 'Business';
  const businessAddress = business?.address?.trim() || 'Address not provided';
  const businessPhone = business?.phone?.trim();
  const businessEmail = business?.email?.trim();
  const businessTin = business?.tin?.trim();

  const referenceNumbers = Array.from(
    new Set(
      purchase.items
        .map((item) => String(item.referenceNumber || '').trim())
        .filter(Boolean)
    )
  );
  const resolvedVat = resolvePurchaseVat(purchase);
  const resolvedTotalWithVat = resolvePurchaseTotalWithVat(purchase);
  const subtotal = Math.max(0, resolvedTotalWithVat - resolvedVat);
  const totalQuantity = purchase.items.reduce((sum, item) => sum + Number(item.quantityReceived || 0), 0);

  const itemsRows = purchase.items
    .map((item, index) => {
      const itemVat = resolveRecordVat(item);
      const vatMethod = resolveTaxMethod(item.taxCalculationMethod);
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(item.productName || '')}</td>
          <td class="right">${Number(item.quantityReceived || 0)}</td>
          <td class="right">${formatCurrency(Number(item.costPerUnit || 0), currencyCode)}</td>
          <td class="right">${formatCurrency(Number(item.totalCost || 0), currencyCode)}</td>
          <td class="right">${formatCurrency(itemVat, currencyCode)} (${vatMethod === 'inclusive' ? 'Incl' : 'Excl'})</td>
          <td>${escapeHtml(item.batchNumber || 'N/A')}</td>
          <td>${escapeHtml(formatDisplayDate(item.expiryDate))}</td>
        </tr>
      `;
    })
    .join('');

  const businessMeta = [businessPhone, businessEmail, businessTin ? `TIN: ${businessTin}` : '']
    .filter(Boolean)
    .map((value) => `<div>${escapeHtml(value)}</div>`)
    .join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Purchase Invoice</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 24px;
          font-family: Arial, sans-serif;
          color: #111827;
          background: #ffffff;
        }
        .invoice {
          max-width: 980px;
          margin: 0 auto;
        }
        .header {
          display: flex;
          justify-content: space-between;
          gap: 24px;
          border-bottom: 2px solid #111827;
          padding-bottom: 18px;
          margin-bottom: 18px;
        }
        .business-name {
          font-size: 26px;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .business-meta,
        .muted {
          color: #4b5563;
          font-size: 12px;
          line-height: 1.5;
        }
        .title-wrap {
          text-align: right;
          min-width: 240px;
        }
        .title {
          font-size: 28px;
          font-weight: 700;
          letter-spacing: 0.04em;
          margin: 0 0 8px 0;
        }
        .meta-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          margin-bottom: 20px;
        }
        .meta-card {
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 14px;
          background: #fafafa;
        }
        .section-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #6b7280;
          margin-bottom: 8px;
          font-weight: 700;
        }
        .meta-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          font-size: 13px;
          padding: 4px 0;
          border-bottom: 1px solid #eceff3;
        }
        .meta-row:last-child {
          border-bottom: none;
        }
        .meta-label {
          color: #6b7280;
        }
        .meta-value {
          font-weight: 600;
          text-align: right;
          word-break: break-word;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          margin-bottom: 18px;
        }
        thead {
          background: #f3f4f6;
        }
        th, td {
          padding: 9px 10px;
          border: 1px solid #e5e7eb;
          vertical-align: top;
        }
        th {
          text-align: left;
          font-weight: 700;
        }
        .right {
          text-align: right;
        }
        .summary {
          margin-left: auto;
          width: 320px;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          overflow: hidden;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 14px;
          font-size: 13px;
          border-bottom: 1px solid #e5e7eb;
        }
        .summary-row:last-child {
          border-bottom: none;
        }
        .summary-row.total {
          background: #111827;
          color: #ffffff;
          font-size: 14px;
          font-weight: 700;
        }
        .footer {
          margin-top: 18px;
          padding-top: 12px;
          border-top: 1px solid #e5e7eb;
          font-size: 11px;
          color: #6b7280;
        }
      </style>
    </head>
    <body>
      <div class="invoice">
        <div class="header">
          <div>
            <div class="business-name">${escapeHtml(businessName)}</div>
            <div class="business-meta">
              <div>${escapeHtml(businessAddress)}</div>
              ${businessMeta}
            </div>
          </div>
          <div class="title-wrap">
            <div class="title">Purchase Invoice</div>
            <div class="muted">Generated from purchase history</div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-card">
            <div class="section-title">Purchase Details</div>
            <div class="meta-row">
              <span class="meta-label">Purchase Ref</span>
              <span class="meta-value">${escapeHtml(purchase.groupId)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Received Date</span>
              <span class="meta-value">${escapeHtml(purchase.displayDate)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Payment Status</span>
              <span class="meta-value">${escapeHtml(purchase.paymentStatus)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Reference No.</span>
              <span class="meta-value">${escapeHtml(referenceNumbers.join(', ') || 'N/A')}</span>
            </div>
          </div>

          <div class="meta-card">
            <div class="section-title">Supplier</div>
            <div class="meta-row">
              <span class="meta-label">Supplier Name</span>
              <span class="meta-value">${escapeHtml(purchase.supplierName)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Items</span>
              <span class="meta-value">${purchase.items.length}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Quantity Received</span>
              <span class="meta-value">${totalQuantity}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Amount Due</span>
              <span class="meta-value">${formatCurrency(purchase.amountDue, currencyCode)}</span>
            </div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Product</th>
              <th class="right">Qty</th>
              <th class="right">Unit Cost</th>
              <th class="right">Line Total</th>
              <th class="right">VAT</th>
              <th>Batch</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows || '<tr><td colspan="8">No purchase items available.</td></tr>'}
          </tbody>
        </table>

        <div class="summary">
          <div class="summary-row">
            <span>Subtotal (Excl VAT)</span>
            <span>${formatCurrency(subtotal, currencyCode)}</span>
          </div>
          <div class="summary-row">
            <span>VAT</span>
            <span>${formatCurrency(resolvedVat, currencyCode)}</span>
          </div>
          <div class="summary-row">
            <span>Amount Due</span>
            <span>${formatCurrency(purchase.amountDue, currencyCode)}</span>
          </div>
          <div class="summary-row total">
            <span>Total (Incl VAT)</span>
            <span>${formatCurrency(resolvedTotalWithVat, currencyCode)}</span>
          </div>
        </div>

        <div class="footer">
          Purchase invoice generated on ${escapeHtml(new Date().toLocaleString())}
        </div>
      </div>
    </body>
    </html>
  `;
};

const sanitizeFilenamePart = (value: string): string => {
  const normalized = value.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'purchase';
};

export async function generatePurchaseInvoicePDF({
  purchase,
  business,
  currencyCode = 'USD',
}: GeneratePurchaseInvoicePdfOptions): Promise<void> {
  const html2pdfModule = await import('html2pdf.js');
  const html2pdf = ((html2pdfModule as any).default ?? html2pdfModule) as any;

  const container = document.createElement('div');
  const invoiceContent = document.createElement('div');
  invoiceContent.innerHTML = buildPurchaseInvoiceHtml(purchase, business, currencyCode);
  container.appendChild(invoiceContent);

  const safeSupplier = sanitizeFilenamePart(purchase.supplierName);
  const safeReference = sanitizeFilenamePart(purchase.groupId);
  const filename = `Purchase_Invoice_${safeSupplier}_${safeReference}.pdf`;

  await html2pdf()
    .set({
      margin: 0.3,
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    })
    .from(container)
    .save();
}
