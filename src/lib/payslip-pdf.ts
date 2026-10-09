export type PayslipLine = {
  kind: 'earning' | 'deduction';
  label: string;
  amount: number | string;
};

export interface PayslipData {
  businessName: string;
  businessAddress?: string;
  businessPhone?: string;
  periodStart: string;
  periodEnd: string;
  payDate?: string | null;
  employeeName: string;
  employeeCode: string;
  jobTitle?: string;
  payFrequency?: string;
  currency: string;
  basePay: number | string;
  overtimeMinutes: number;
  overtimePay: number | string;
  grossPay: number | string;
  deductionsTotal: number | string;
  netPay: number | string;
  lines: PayslipLine[];
}

const escapeHtml = (value: unknown): string => String(value ?? '')
  .trim()
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const money = (amount: number | string, currency: string): string => {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `${currency} ${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
  }
};

const dateLabel = (value?: string | null): string => {
  if (!value) return 'Not set';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).format(date);
};

const filenamePart = (value: string): string => {
  const normalized = value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  return normalized || 'employee';
};

const rows = (lines: Array<{ label: string; amount: number | string }>, currency: string, emptyCopy: string): string => {
  if (!lines.length) {
    return `<tr><td colspan="2" class="empty">${escapeHtml(emptyCopy)}</td></tr>`;
  }

  return lines.map((line) => `
    <tr>
      <td>${escapeHtml(line.label)}</td>
      <td class="amount">${money(line.amount, currency)}</td>
    </tr>
  `).join('');
};

const buildPayslipHtml = (data: PayslipData): string => {
  const earningLines = [
    { label: 'Base pay', amount: data.basePay },
    ...(Number(data.overtimePay || 0) > 0
      ? [{ label: `Overtime (${data.overtimeMinutes || 0} minutes)`, amount: data.overtimePay }]
      : []),
    ...data.lines.filter((line) => line.kind === 'earning'),
  ];
  const deductionLines = data.lines.filter((line) => line.kind === 'deduction');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Payslip</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 32px; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.45; }
          .payslip { max-width: 860px; margin: 0 auto; }
          header { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 18px; border-bottom: 2px solid #111827; }
          .business-name { font-size: 25px; font-weight: 800; text-transform: uppercase; }
          .business-detail { margin-top: 3px; color: #4b5563; }
          .document { text-align: right; }
          .document h1 { margin: 0; font-size: 24px; letter-spacing: .04em; }
          .document p { margin: 5px 0 0; color: #4b5563; }
          .info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 22px 0; }
          .info { border: 1px solid #d1d5db; padding: 14px; }
          .label { color: #6b7280; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
          .value { margin-top: 4px; font-size: 15px; font-weight: 700; }
          .detail { margin-top: 2px; color: #4b5563; }
          .pay-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
          section { border: 1px solid #d1d5db; }
          h2 { margin: 0; padding: 11px 13px; background: #f3f4f6; border-bottom: 1px solid #d1d5db; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 10px 13px; border-bottom: 1px solid #e5e7eb; }
          tr:last-child td { border-bottom: 0; }
          td.amount { text-align: right; white-space: nowrap; font-weight: 600; }
          .empty { color: #6b7280; font-style: italic; }
          .totals { display: grid; grid-template-columns: 1fr auto; gap: 9px 28px; margin: 22px 0 0 auto; max-width: 360px; }
          .totals div:nth-child(even) { text-align: right; font-weight: 700; }
          .net { margin-top: 5px; padding-top: 11px; border-top: 2px solid #111827; font-size: 16px; }
          footer { margin-top: 26px; border-top: 1px solid #d1d5db; padding-top: 12px; color: #4b5563; font-size: 10px; }
          @media print { body { padding: 0; } .payslip { max-width: none; } }
        </style>
      </head>
      <body>
        <main class="payslip">
          <header>
            <div>
              <div class="business-name">${escapeHtml(data.businessName || 'Business')}</div>
              ${data.businessAddress ? `<div class="business-detail">${escapeHtml(data.businessAddress)}</div>` : ''}
              ${data.businessPhone ? `<div class="business-detail">${escapeHtml(data.businessPhone)}</div>` : ''}
            </div>
            <div class="document">
              <h1>PAYSLIP</h1>
              <p>Pay period: ${escapeHtml(dateLabel(data.periodStart))} to ${escapeHtml(dateLabel(data.periodEnd))}</p>
            </div>
          </header>

          <div class="info-grid">
            <div class="info">
              <div class="label">Employee</div>
              <div class="value">${escapeHtml(data.employeeName)}</div>
              <div class="detail">${escapeHtml(data.employeeCode)}${data.jobTitle ? ` · ${escapeHtml(data.jobTitle)}` : ''}</div>
            </div>
            <div class="info">
              <div class="label">Payment Details</div>
              <div class="value">Pay date: ${escapeHtml(dateLabel(data.payDate))}</div>
              <div class="detail">${escapeHtml(data.payFrequency ? `${data.payFrequency} pay` : 'Payroll payment')} · ${escapeHtml(data.currency)}</div>
            </div>
          </div>

          <div class="pay-grid">
            <section>
              <h2>Earnings</h2>
              <table><tbody>${rows(earningLines, data.currency, 'No earnings recorded.')}</tbody></table>
            </section>
            <section>
              <h2>Deductions</h2>
              <table><tbody>${rows(deductionLines, data.currency, 'No deductions recorded.')}</tbody></table>
            </section>
          </div>

          <div class="totals">
            <div>Gross pay</div><div>${money(data.grossPay, data.currency)}</div>
            <div>Total deductions</div><div>${money(data.deductionsTotal, data.currency)}</div>
            <div class="net">Net pay</div><div class="net">${money(data.netPay, data.currency)}</div>
          </div>

          <footer>This payslip records the payroll calculation for the period shown above. Keep it with your employment records.</footer>
        </main>
      </body>
    </html>
  `;
};

export async function downloadPayslipPdf(data: PayslipData): Promise<void> {
  const html2pdfModule = await import('html2pdf.js');
  const html2pdf = ((html2pdfModule as any).default ?? html2pdfModule) as any;
  const container = document.createElement('div');
  container.innerHTML = buildPayslipHtml(data);

  await html2pdf()
    .set({
      margin: 0.25,
      filename: `HandyPOS_Payslip_${filenamePart(data.employeeCode || data.employeeName)}_${data.periodEnd.slice(0, 10)}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .from(container)
    .save();
}
