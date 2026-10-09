export type SubscriptionQuotationFeature = {
  name: string;
  description?: string;
  monthlyPrice: number;
  included?: boolean;
  selected?: boolean;
};

export interface SubscriptionQuotationData {
  currencyCode: string;
  minimumMonthlyAmount: number;
  includedFeatures: SubscriptionQuotationFeature[];
  additionalFeatures: SubscriptionQuotationFeature[];
  issuedAt?: Date;
}

const escapeHtml = (value: unknown): string => String(value ?? '')
  .trim()
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatMoney = (amount: number, currencyCode: string): string => {
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currencyCode} ${value.toFixed(2)}`;
  }
};

const buildFeatureRows = (
  features: SubscriptionQuotationFeature[],
  currencyCode: string,
  emptyCopy: string,
): string => {
  if (features.length === 0) {
    return `<tr><td colspan="2" class="empty">${escapeHtml(emptyCopy)}</td></tr>`;
  }

  return features.map((feature) => `
    <tr>
      <td>
        <div class="feature-name">${escapeHtml(feature.name)}</div>
        ${feature.description ? `<div class="feature-description">${escapeHtml(feature.description)}</div>` : ''}
      </td>
      <td class="amount">${feature.included ? 'Included' : `${formatMoney(feature.monthlyPrice, currencyCode)} / month`}</td>
    </tr>
  `).join('');
};

const buildSubscriptionQuotationHtml = (data: SubscriptionQuotationData): string => {
  const issuedAt = data.issuedAt || new Date();
  const issuedDate = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(issuedAt);
  const includedRows = buildFeatureRows(
    data.includedFeatures,
    data.currencyCode,
    'Included system features are configured by your plan.',
  );
  const additionalRows = buildFeatureRows(
    data.additionalFeatures,
    data.currencyCode,
    'There are no additional paid features published at the moment.',
  );

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>HandyPOS Subscription Quotation</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 32px;
            background: #ffffff;
            color: #111827;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 12px;
            line-height: 1.45;
          }
          .quotation { max-width: 920px; margin: 0 auto; }
          .header {
            display: flex;
            justify-content: space-between;
            gap: 28px;
            padding-bottom: 20px;
            border-bottom: 2px solid #111827;
          }
          .brand { font-size: 28px; font-weight: 800; letter-spacing: 0.02em; }
          .brand-subtitle { margin-top: 4px; color: #4b5563; font-size: 12px; }
          .document-title { text-align: right; }
          .document-title h1 { margin: 0; font-size: 25px; letter-spacing: 0.04em; }
          .document-title p { margin: 5px 0 0; color: #4b5563; }
          .info-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 18px;
            margin: 22px 0;
          }
          .info-block { border: 1px solid #d1d5db; padding: 14px; }
          .label { margin-bottom: 5px; color: #6b7280; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
          .business-name { font-size: 16px; font-weight: 700; }
          .contact { margin-top: 3px; color: #4b5563; }
          .summary-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
            margin-bottom: 22px;
          }
          .summary-card { border: 1px solid #111827; padding: 16px; }
          .summary-card.current { background: #f3f4f6; }
          .summary-title { color: #4b5563; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
          .summary-amount { margin: 7px 0 3px; font-size: 24px; font-weight: 800; }
          .summary-copy { color: #4b5563; font-size: 11px; }
          .section { margin-top: 22px; }
          .section h2 { margin: 0 0 8px; font-size: 15px; }
          .section-copy { margin: 0 0 10px; color: #4b5563; }
          table { width: 100%; border-collapse: collapse; }
          th { padding: 9px 10px; background: #f3f4f6; border-top: 1px solid #9ca3af; border-bottom: 1px solid #9ca3af; text-align: left; font-size: 11px; }
          th.amount, td.amount { text-align: right; white-space: nowrap; }
          td { padding: 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
          .feature-name { font-weight: 700; }
          .feature-description { margin-top: 2px; color: #6b7280; font-size: 11px; }
          .empty { color: #6b7280; font-style: italic; }
          .total-row { display: flex; justify-content: flex-end; margin-top: 10px; }
          .total-box { min-width: 300px; border-top: 2px solid #111827; padding-top: 8px; text-align: right; }
          .total-box strong { display: block; font-size: 16px; }
          .upcoming { margin-top: 22px; border: 1px solid #c7d2fe; background: #eef2ff; padding: 14px; }
          .upcoming h2 { margin: 0 0 4px; font-size: 15px; }
          .upcoming p { margin: 0; color: #3730a3; }
          .terms { margin-top: 24px; border-top: 1px solid #d1d5db; padding-top: 14px; color: #4b5563; font-size: 10px; }
          .terms p { margin: 4px 0; }
          @media print {
            body { padding: 0; }
            .quotation { max-width: none; }
          }
        </style>
      </head>
      <body>
        <main class="quotation">
          <header class="header">
            <div>
              <div class="brand">HANDY POS</div>
              <div class="brand-subtitle">Business software by Zathu Systems</div>
            </div>
            <div class="document-title">
              <h1>SUBSCRIPTION QUOTATION</h1>
              <p>Issued ${escapeHtml(issuedDate)}</p>
            </div>
          </header>

          <section class="info-grid">
            <div class="info-block">
              <div class="label">Issued By</div>
              <div class="business-name">Zathu Systems</div>
              <div class="contact">HandyPOS business management software</div>
            </div>
            <div class="info-block">
              <div class="label">Quotation Basis</div>
              <div class="business-name">30-day subscription period</div>
              <div class="contact">Currency: ${escapeHtml(data.currencyCode)}</div>
              <div class="contact">Prices are shown monthly.</div>
            </div>
          </section>

          <section class="summary-grid">
            <div class="summary-card">
              <div class="summary-title">Minimum Monthly Subscription</div>
              <div class="summary-amount">${formatMoney(data.minimumMonthlyAmount, data.currencyCode)}</div>
              <div class="summary-copy">Base HandyPOS subscription with no paid additional features.</div>
            </div>
            <div class="summary-card current">
              <div class="summary-title">Build Your Monthly Plan</div>
              <div class="summary-amount">Base + selected add-ons</div>
              <div class="summary-copy">Choose the optional modules your business needs. Each listed price is added to the minimum monthly subscription.</div>
            </div>
          </section>

          <section class="section">
            <h2>Included Features</h2>
            <p class="section-copy">Included features do not increase the monthly quotation total.</p>
            <table>
              <thead><tr><th>Feature</th><th class="amount">Monthly Price</th></tr></thead>
              <tbody>${includedRows}</tbody>
            </table>
          </section>

          <section class="section">
            <h2>Available Additional Features</h2>
            <p class="section-copy">Add any of these optional modules to the minimum monthly subscription price above.</p>
            <table>
              <thead><tr><th>Feature</th><th class="amount">Monthly Price</th></tr></thead>
              <tbody>${additionalRows}</tbody>
            </table>
          </section>

          <section class="upcoming">
            <h2>HR &amp; Payroll Management</h2>
            <p>Employee records, attendance, leave, overtime, payroll preparation, approvals, and downloadable payslips are available through Multi-User Access. It is included whenever that module is selected.</p>
          </section>

          <footer class="terms">
            <p>This is a subscription quotation, not a tax invoice or payment request.</p>
            <p>Prices are calculated from the current HandyPOS price list and are shown for a 30-day period. Your final monthly amount is the minimum subscription price plus the optional features selected for your business.</p>
          </footer>
        </main>
      </body>
    </html>
  `;
};

export async function downloadSubscriptionQuotationPdf(data: SubscriptionQuotationData): Promise<void> {
  const html2pdfModule = await import('html2pdf.js');
  const html2pdf = ((html2pdfModule as any).default ?? html2pdfModule) as any;
  const container = document.createElement('div');
  container.innerHTML = buildSubscriptionQuotationHtml(data);

  await html2pdf()
    .set({
      margin: 0.25,
      filename: 'HandyPOS_Subscription_Quotation.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .from(container)
    .save();
}
