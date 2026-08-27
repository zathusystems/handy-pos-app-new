import { format } from 'date-fns';

import type { Session } from '@/lib/db';

export const SESSION_END_REPORT_TITLE = 'Session End Report';

export type ZReportPaymentBreakdown = {
  cash: number;
  card: number;
  mobileMoney: number;
  bankTransfer: number;
  onAccount: number;
  other: number;
  laybuyDeposits: number;
  laybuyOutstanding: number;
  totalCollected: number;
  totalDue: number;
};

export type ZReportFinancialSummary = {
  orderCount: number;
  netSales: number;
  totalTax: number;
  totalCharges: number;
  totalLevies: number;
  totalOtherCharges: number;
  grossSales: number;
  totalTips: number;
  totalPayable: number;
};

export type ZReportEisStatusCounts = {
  pending: number;
  submitted: number;
  accepted: number;
  rejected: number;
  unknown: number;
};

export type ZReportEisSummary = {
  ordersWithFiscalNumber: number;
  pendingFiscalNumber: number;
  eisStatusCounts: ZReportEisStatusCounts;
  ordersWithQr: number;
  ordersWithSignature: number;
  firstFiscalInvoice?: string;
  lastFiscalInvoice?: string;
  firstSubmissionAt?: string;
  lastSubmissionAt?: string;
};

export type ZReportOrderRecord = {
  status?: string;
  paymentMethod?: string;
  total?: number;
  tip?: number;
  subtotal?: number;
  laybuyDeposit?: number;
  laybuy_deposit?: number;
  depositAmount?: number;
  deposit_amount?: number;
  laybuyPaymentMethod?: string;
  laybuy_payment_method?: string;
  tax?: number;
  vatAmount?: number;
  vat_amount?: number;
  netAmount?: number;
  net_amount?: number;
  grossAmount?: number;
  gross_amount?: number;
  chargesAmount?: number;
  charges_amount?: number;
  chargesSnapshot?: Array<Record<string, unknown>>;
  charges_snapshot?: Array<Record<string, unknown>>;
  fiscalInvoiceNumber?: string;
  fiscal_invoice_number?: string;
  eisStatus?: string;
  eis_status?: string;
  eisSubmittedAt?: string;
  eis_submitted_at?: string;
  qrCodePayload?: string;
  qr_code_payload?: string;
  digitalSignature?: string;
  digital_signature?: string;
  createdAt?: string;
  created_at?: string;
};

export type ZReportCalculatedSummary = {
  paymentBreakdown: ZReportPaymentBreakdown;
  financialSummary: ZReportFinancialSummary;
  eisSummary: ZReportEisSummary;
};

type ZReportSessionSnapshot = Pick<
  Session,
  | 'id'
  | 'status'
  | 'userName'
  | 'startedAt'
  | 'closedAt'
  | 'openingFloat'
  | 'actualCash'
  | 'difference'
  | 'totalSales'
>;

type BuildZReportPrintHtmlInput = {
  session: ZReportSessionSnapshot;
  paymentBreakdown: ZReportPaymentBreakdown;
  financialSummary?: ZReportFinancialSummary;
  eisSummary?: ZReportEisSummary;
  formatCurrency: (amount: number) => string;
  generatedAt?: Date;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toFiniteNumber = (value: unknown, fallback: number = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const toTimestamp = (value: unknown): number | null => {
  const normalized = toTrimmedString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

export type ZReportChargeBreakdown = {
  total: number;
  levies: number;
  otherCharges: number;
  exclusive: number;
  inclusive: number;
};

/** Read the immutable charge snapshot saved with a completed sale. */
export const getOrderChargeBreakdown = (
  order: Pick<ZReportOrderRecord, 'chargesAmount' | 'charges_amount' | 'chargesSnapshot' | 'charges_snapshot'>
): ZReportChargeBreakdown => {
  const snapshot = Array.isArray(order.chargesSnapshot)
    ? order.chargesSnapshot
    : Array.isArray(order.charges_snapshot)
      ? order.charges_snapshot
      : [];
  const declaredTotal = toFiniteNumber(
    order.chargesAmount ?? order.charges_amount,
    Number.NaN
  );

  let snapshotTotal = 0;
  let levies = 0;
  let exclusive = 0;
  let inclusive = 0;

  snapshot.forEach((entry) => {
    const amount = Math.max(0, toFiniteNumber(
      entry?.amount ?? entry?.charge_amount ?? entry?.chargeAmount,
      0
    ));
    if (amount <= 0) return;

    snapshotTotal += amount;
    const chargeType = String(
      entry?.chargeType ?? entry?.charge_type ?? entry?.type ?? ''
    ).trim().toUpperCase();
    if (chargeType === 'LEVY') levies += amount;

    const method = String(
      entry?.calculationMethod ?? entry?.calculation_method ?? ''
    ).trim().toLowerCase();
    if (method === 'exclusive') exclusive += amount;
    if (method === 'inclusive') inclusive += amount;
  });

  const total = Number.isFinite(declaredTotal)
    ? Math.max(0, declaredTotal)
    : Math.max(0, snapshotTotal);

  return {
    total,
    levies: Math.min(total, Math.max(0, levies)),
    otherCharges: Math.max(0, total - Math.min(total, Math.max(0, levies))),
    exclusive: Math.min(total, Math.max(0, exclusive)),
    inclusive: Math.min(total, Math.max(0, inclusive)),
  };
};

const DEFAULT_FINANCIAL_SUMMARY: ZReportFinancialSummary = {
  orderCount: 0,
  netSales: 0,
  totalTax: 0,
  totalCharges: 0,
  totalLevies: 0,
  totalOtherCharges: 0,
  grossSales: 0,
  totalTips: 0,
  totalPayable: 0,
};

const DEFAULT_EIS_STATUS_COUNTS: ZReportEisStatusCounts = {
  pending: 0,
  submitted: 0,
  accepted: 0,
  rejected: 0,
  unknown: 0,
};

const DEFAULT_EIS_SUMMARY: ZReportEisSummary = {
  ordersWithFiscalNumber: 0,
  pendingFiscalNumber: 0,
  eisStatusCounts: DEFAULT_EIS_STATUS_COUNTS,
  ordersWithQr: 0,
  ordersWithSignature: 0,
};

export const calculateZReportSummary = (
  orders: ZReportOrderRecord[]
): ZReportCalculatedSummary => {
  const activeOrders = orders.filter((order) => {
    const status = toTrimmedString(order.status).toLowerCase();
    return status !== 'voided' && status !== 'cancelled';
  });

  const paymentBreakdown: ZReportPaymentBreakdown = {
    cash: 0,
    card: 0,
    mobileMoney: 0,
    bankTransfer: 0,
    onAccount: 0,
    other: 0,
    laybuyDeposits: 0,
    laybuyOutstanding: 0,
    totalCollected: 0,
    totalDue: 0,
  };

  const financialSummary: ZReportFinancialSummary = {
    orderCount: activeOrders.length,
    netSales: 0,
    totalTax: 0,
    totalCharges: 0,
    totalLevies: 0,
    totalOtherCharges: 0,
    grossSales: 0,
    totalTips: 0,
    totalPayable: 0,
  };

  const fiscalValues: Array<{ value: string; createdAt: number }> = [];
  const submissionTimes: number[] = [];
  const eisSummary: ZReportEisSummary = {
    ordersWithFiscalNumber: 0,
    pendingFiscalNumber: 0,
    eisStatusCounts: {
      pending: 0,
      submitted: 0,
      accepted: 0,
      rejected: 0,
      unknown: 0,
    },
    ordersWithQr: 0,
    ordersWithSignature: 0,
  };

  activeOrders.forEach((order, index) => {
    const tipAmount = toFiniteNumber(order.tip);
    const totalValue = toFiniteNumber(order.total);
    const netValue = toFiniteNumber(order.netAmount ?? order.net_amount ?? order.subtotal);
    const taxValue = toFiniteNumber(order.vatAmount ?? order.vat_amount ?? order.tax);
    const chargeBreakdown = getOrderChargeBreakdown(order);
    const grossValueFromTotal = totalValue - tipAmount;
    const grossValue = toFiniteNumber(
      order.grossAmount ?? order.gross_amount,
      grossValueFromTotal > 0
        ? grossValueFromTotal
        : netValue + taxValue + chargeBreakdown.exclusive
    );
    const totalPayableValue = grossValue + tipAmount;

    financialSummary.netSales += netValue;
    financialSummary.totalTax += taxValue;
    financialSummary.totalCharges += chargeBreakdown.total;
    financialSummary.totalLevies += chargeBreakdown.levies;
    financialSummary.totalOtherCharges += chargeBreakdown.otherCharges;
    financialSummary.grossSales += grossValue;
    financialSummary.totalTips += tipAmount;
    financialSummary.totalPayable += totalPayableValue;

    const addPaymentAmount = (method: string, amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return;
      }

      switch (toTrimmedString(method).toLowerCase()) {
        case 'cash':
          paymentBreakdown.cash += amount;
          break;
        case 'card':
          paymentBreakdown.card += amount;
          break;
        case 'mobile money':
          paymentBreakdown.mobileMoney += amount;
          break;
        case 'bank transfer':
          paymentBreakdown.bankTransfer += amount;
          break;
        case 'on account':
          paymentBreakdown.onAccount += amount;
          break;
        default:
          paymentBreakdown.other += amount;
          break;
      }
    };

    const paymentMethod = toTrimmedString(order.paymentMethod);
    if (paymentMethod.toLowerCase() === 'laybuy') {
      const depositAmount = Math.max(
        0,
        Math.min(
          grossValue,
          toFiniteNumber(
            order.laybuyDeposit ?? order.laybuy_deposit ?? order.depositAmount ?? order.deposit_amount
          )
        )
      );
      paymentBreakdown.laybuyDeposits += depositAmount;
      paymentBreakdown.laybuyOutstanding += Math.max(grossValue - depositAmount, 0);

      const depositMethod = toTrimmedString(order.laybuyPaymentMethod ?? order.laybuy_payment_method) || 'Cash';
      addPaymentAmount(depositMethod, depositAmount);
    } else {
      addPaymentAmount(paymentMethod, grossValue);
    }

    const fiscalInvoiceNumber = toTrimmedString(
      order.fiscalInvoiceNumber ?? order.fiscal_invoice_number
    );
    if (fiscalInvoiceNumber) {
      eisSummary.ordersWithFiscalNumber += 1;
      fiscalValues.push({
        value: fiscalInvoiceNumber,
        createdAt:
          toTimestamp(order.createdAt ?? order.created_at) ?? Number.MAX_SAFE_INTEGER - index,
      });
    } else {
      eisSummary.pendingFiscalNumber += 1;
    }

    const eisStatus = toTrimmedString(order.eisStatus ?? order.eis_status).toUpperCase();
    switch (eisStatus) {
      case 'PENDING':
        eisSummary.eisStatusCounts.pending += 1;
        break;
      case 'SUBMITTED':
        eisSummary.eisStatusCounts.submitted += 1;
        break;
      case 'ACCEPTED':
        eisSummary.eisStatusCounts.accepted += 1;
        break;
      case 'REJECTED':
        eisSummary.eisStatusCounts.rejected += 1;
        break;
      default:
        eisSummary.eisStatusCounts.unknown += 1;
        break;
    }

    if (toTrimmedString(order.qrCodePayload ?? order.qr_code_payload)) {
      eisSummary.ordersWithQr += 1;
    }
    if (toTrimmedString(order.digitalSignature ?? order.digital_signature)) {
      eisSummary.ordersWithSignature += 1;
    }

    const submittedAt = toTimestamp(order.eisSubmittedAt ?? order.eis_submitted_at);
    if (submittedAt !== null) {
      submissionTimes.push(submittedAt);
    }
  });

  if (fiscalValues.length > 0) {
    fiscalValues.sort((a, b) => a.createdAt - b.createdAt);
    eisSummary.firstFiscalInvoice = fiscalValues[0]?.value;
    eisSummary.lastFiscalInvoice = fiscalValues[fiscalValues.length - 1]?.value;
  }

  if (submissionTimes.length > 0) {
    submissionTimes.sort((a, b) => a - b);
    eisSummary.firstSubmissionAt = new Date(submissionTimes[0]).toISOString();
    eisSummary.lastSubmissionAt = new Date(submissionTimes[submissionTimes.length - 1]).toISOString();
  }

  paymentBreakdown.totalCollected =
    paymentBreakdown.cash +
    paymentBreakdown.card +
    paymentBreakdown.mobileMoney +
    paymentBreakdown.bankTransfer +
    paymentBreakdown.other;
  paymentBreakdown.totalDue = paymentBreakdown.onAccount + paymentBreakdown.laybuyOutstanding;

  return {
    paymentBreakdown,
    financialSummary,
    eisSummary,
  };
};

const formatSessionDate = (value?: string): string => {
  if (!value) return 'N/A';

  try {
    return format(new Date(value), 'PPpp');
  } catch {
    return 'N/A';
  }
};

export const isSessionClosedForZReport = (
  session: Pick<Session, 'status' | 'closedAt'>
): boolean => {
  const normalizedStatus = String(session.status || '').trim().toLowerCase();
  return normalizedStatus === 'closed' || Boolean(session.closedAt);
};

export const buildZReportPrintHtml = ({
  session,
  paymentBreakdown,
  financialSummary = DEFAULT_FINANCIAL_SUMMARY,
  eisSummary = DEFAULT_EIS_SUMMARY,
  formatCurrency,
  generatedAt = new Date(),
}: BuildZReportPrintHtmlInput): string => {
  const openingFloat = toFiniteNumber(session.openingFloat);
  const sessionTotalSales = toFiniteNumber(session.totalSales);
  const netSales = toFiniteNumber(financialSummary.netSales);
  const totalTax = toFiniteNumber(financialSummary.totalTax);
  const totalLevies = toFiniteNumber(financialSummary.totalLevies);
  const totalOtherCharges = toFiniteNumber(financialSummary.totalOtherCharges);
  const grossSales = toFiniteNumber(financialSummary.grossSales);
  const totalTips = toFiniteNumber(financialSummary.totalTips);
  const totalPayable = toFiniteNumber(financialSummary.totalPayable);
  const totalCollected = toFiniteNumber(paymentBreakdown.totalCollected);
  const totalDue = toFiniteNumber(paymentBreakdown.totalDue);
  const actualCash = toFiniteNumber(session.actualCash);
  const difference = toFiniteNumber(session.difference);
  const cashCollected = toFiniteNumber(paymentBreakdown.cash);
  const expectedDrawer = openingFloat + cashCollected;
  const fiscalAssigned = toFiniteNumber(eisSummary.ordersWithFiscalNumber);
  const fiscalPending = toFiniteNumber(eisSummary.pendingFiscalNumber);
  const ordersWithQr = toFiniteNumber(eisSummary.ordersWithQr);
  const ordersWithSignature = toFiniteNumber(eisSummary.ordersWithSignature);

  const lines: string[] = [
    SESSION_END_REPORT_TITLE.toUpperCase(),
    `Session ID: ${session.id}`,
    `Session By: ${toTrimmedString(session.userName) || 'Unknown'}`,
    `Generated: ${format(generatedAt, 'PPpp')}`,
    `Started: ${formatSessionDate(session.startedAt)}`,
    `Closed: ${formatSessionDate(session.closedAt)}`,
    '--------------------------------',
    'FINANCIAL SUMMARY',
    `Orders: ${Math.max(0, Math.floor(toFiniteNumber(financialSummary.orderCount)))}`,
    `Net Sales: ${formatCurrency(netSales)}`,
    `Tax: ${formatCurrency(totalTax)}`,
    `Levies: ${formatCurrency(totalLevies)}`,
    `Other Charges: ${formatCurrency(totalOtherCharges)}`,
    `Gross Sales: ${formatCurrency(grossSales)}`,
    // `Tips: ${formatCurrency(totalTips)}`,
    `Sales Value: ${formatCurrency(totalPayable)}`,
    `Session Total Sales: ${formatCurrency(sessionTotalSales)}`,
    '--------------------------------',
    'COLLECTIONS',
    `Cash Collected: ${formatCurrency(cashCollected)}`,
    `Card Collected: ${formatCurrency(toFiniteNumber(paymentBreakdown.card))}`,
    `Mobile Money Collected: ${formatCurrency(toFiniteNumber(paymentBreakdown.mobileMoney))}`,
    `Bank Transfer Collected: ${formatCurrency(toFiniteNumber(paymentBreakdown.bankTransfer))}`,
    `Other Collected: ${formatCurrency(toFiniteNumber(paymentBreakdown.other))}`,
    `Laybuy Deposits: ${formatCurrency(toFiniteNumber(paymentBreakdown.laybuyDeposits))}`,
    `Total Collected: ${formatCurrency(totalCollected)}`,
    '--------------------------------',
    'AMOUNTS STILL DUE',
    `Account / Invoice Due: ${formatCurrency(toFiniteNumber(paymentBreakdown.onAccount))}`,
    `Laybuy Outstanding: ${formatCurrency(toFiniteNumber(paymentBreakdown.laybuyOutstanding))}`,
    `Total Due: ${formatCurrency(totalDue)}`,
    '--------------------------------',
    'CASH RECONCILIATION',
    `Opening Float: ${formatCurrency(openingFloat)}`,
    `Expected in Drawer: ${formatCurrency(expectedDrawer)}`,
    `Actual Cash: ${formatCurrency(actualCash)}`,
    `Difference: ${formatCurrency(difference)}`,
    // '--------------------------------',
    // 'EIS COMPLIANCE',
    // `Fiscal Assigned: ${Math.max(0, Math.floor(fiscalAssigned))}`,
    // `Fiscal Pending: ${Math.max(0, Math.floor(fiscalPending))}`,
    // `EIS Pending: ${Math.max(0, Math.floor(toFiniteNumber(eisSummary.eisStatusCounts?.pending)))}`,
    // `EIS Submitted: ${Math.max(0, Math.floor(toFiniteNumber(eisSummary.eisStatusCounts?.submitted)))}`,
    // `EIS Accepted: ${Math.max(0, Math.floor(toFiniteNumber(eisSummary.eisStatusCounts?.accepted)))}`,
    // `EIS Rejected: ${Math.max(0, Math.floor(toFiniteNumber(eisSummary.eisStatusCounts?.rejected)))}`,
    // `EIS Unknown: ${Math.max(0, Math.floor(toFiniteNumber(eisSummary.eisStatusCounts?.unknown)))}`,
    // `With QR Payload: ${Math.max(0, Math.floor(ordersWithQr))}`,
    // `With Signature: ${Math.max(0, Math.floor(ordersWithSignature))}`,
    // `First Fiscal #: ${eisSummary.firstFiscalInvoice || 'N/A'}`,
    // `Last Fiscal #: ${eisSummary.lastFiscalInvoice || 'N/A'}`,
    // `First Submission: ${formatSessionDate(eisSummary.firstSubmissionAt)}`,
    // `Last Submission: ${formatSessionDate(eisSummary.lastSubmissionAt)}`,
    '--------------------------------',
    `END OF ${SESSION_END_REPORT_TITLE.toUpperCase()}`,
  ];

  return `
<div id="receipt-printable-area" style="font-family:'Courier New',monospace;font-size:12px;line-height:1.35;">
  ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
</div>
`.trim();
};
