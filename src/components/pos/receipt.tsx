
'use client';

import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { db, type Order, type Business } from '@/lib/db';
import { getOfflineBusinessProfile } from '@/lib/business-profile';

interface ReceiptProps {
    order: Order;
    business?: Business;
    currencyFormatter: (amount: number) => string;
    paperWidth?: '80mm' | '58mm';
    showQRCode?: boolean;
    showHeader?: boolean;
    showFooter?: boolean;
    showItemDetails?: boolean;
    showTaxBreakdown?: boolean;
    copyNumber?: number; // 1 = Original, 2+ = Copy
}

export const Receipt = ({ 
  order, 
  business, 
  currencyFormatter,
  paperWidth = '80mm',
  showQRCode = true,
  showHeader = true,
  showFooter = true,
  showItemDetails = true,
  showTaxBreakdown = true,
  copyNumber = 1,
}: ReceiptProps) => {
  const toFiniteNumber = (value: unknown, fallback: number = 0): number => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return fallback;
      }
      const normalized = trimmed.replace(/[^0-9.-]/g, '');
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    const parsed = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const toOptionalFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return null;
    }
    const parsed = toFiniteNumber(value, Number.NaN);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const toTrimmedString = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  };

  const resolveCashierReceiptLabel = (...candidates: Array<unknown>): string => {
    for (const candidate of candidates) {
      const raw = toTrimmedString(candidate);
      if (!raw) {
        continue;
      }

      const exactNumericMatch = raw.match(/^\d+$/);
      if (exactNumericMatch) {
        const parsed = Number.parseInt(exactNumericMatch[0], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          return `Cashier ${parsed}`;
        }
      }
    }

    return 'Cashier';
  };

  const resolveBuyerField = (...candidates: Array<unknown>): string => {
    for (const candidate of candidates) {
      const trimmed = toTrimmedString(candidate);
      if (trimmed) {
        return trimmed;
      }
    }
    return '';
  };

  const formatSignaturePreview = (value: string): string => {
    if (!value) {
      return '';
    }
    if (value.length <= 24) {
      return value;
    }
    return `${value.slice(0, 12)}...${value.slice(-8)}`;
  };

  const resolveQrPayload = (rawValue: unknown): string => {
    const raw = toTrimmedString(rawValue);
    if (!raw) {
      return '';
    }

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') {
        return parsed.trim();
      }
      if (parsed && typeof parsed === 'object') {
        const nestedPayload =
          parsed.qrCodePayload ||
          parsed.qr_code_payload ||
          parsed.qrPayload ||
          parsed.qr_payload;
        if (nestedPayload) {
          return toTrimmedString(nestedPayload);
        }
      }
    } catch {
      // Keep raw value when payload is not JSON.
    }

    return raw;
  };

  const formatSafeCurrency = (value: unknown): string => currencyFormatter(toFiniteNumber(value, 0));
  const offlineBusiness = useLiveQuery(async () => getOfflineBusinessProfile(), []);
  const receiptSession = useLiveQuery(async () => {
    const sessionId = toTrimmedString(
      (order as any).sessionId ??
      (order as any).session_id ??
      (order as any).session
    );
    if (!sessionId) {
      return null;
    }
    return db.sessions.get(sessionId);
  }, [(order as any).sessionId, (order as any).session_id, (order as any).session]);

  const resolvedBusiness = business || offlineBusiness || undefined;
  const businessName = resolvedBusiness?.name?.trim() || 'Handy POS Inc.';
  const businessNameDisplay = businessName.toUpperCase();
  const compactBusinessName = businessNameDisplay.replace(/\s+/g, ' ').trim();
  const businessNameLength = compactBusinessName.length;
  const businessAddress = resolvedBusiness?.address?.trim();
  const businessPhone = resolvedBusiness?.phone?.trim();
  const businessEmail = resolvedBusiness?.email?.trim();
  const businessTin = toTrimmedString(
    (resolvedBusiness as any)?.tin ??
    (resolvedBusiness as any)?.taxPin ??
    (resolvedBusiness as any)?.tax_pin
  );

  const orderNumberDisplay = toTrimmedString((order as any).orderNumber ?? (order as any).order_number) || '-';
  const orderDateRaw = toTrimmedString((order as any).createdAt ?? (order as any).created_at);
  const parsedOrderDate = orderDateRaw ? new Date(orderDateRaw) : new Date();
  const orderDate = Number.isNaN(parsedOrderDate.getTime()) ? new Date() : parsedOrderDate;
  const paymentMethodDisplay = toTrimmedString((order as any).paymentMethod ?? (order as any).payment_method);
  const normalizedPaymentMethod = paymentMethodDisplay.toLowerCase();
  const isCashPayment = normalizedPaymentMethod === 'cash' || normalizedPaymentMethod.includes('cash');
  const buyerName = resolveBuyerField(
    (order as any).customerName,
    (order as any).customer_name,
    (order as any).buyerName,
    (order as any).buyer_name
  );
  const buyerTin = resolveBuyerField(
    (order as any).customerTin,
    (order as any).customer_tin,
    (order as any).buyerTin,
    (order as any).buyer_tin
  );

  const fiscalInvoiceNumber = toTrimmedString(
    (order as any).fiscalInvoiceNumber ?? (order as any).fiscal_invoice_number
  );
  const eisUuid = toTrimmedString((order as any).eisUuid ?? (order as any).eis_uuid);
  const eisStatus = toTrimmedString((order as any).eisStatus ?? (order as any).eis_status).toUpperCase() || 'PENDING';
  const digitalSignature = toTrimmedString(
    (order as any).digitalSignature ?? (order as any).digital_signature
  );
  const signaturePreview = formatSignaturePreview(digitalSignature);
  const branchIdDisplay = toTrimmedString(
    (order as any).branchId ??
    (order as any).branch_id ??
    (receiptSession as any)?.branchId ??
    (receiptSession as any)?.branch_id ??
    (receiptSession as any)?.branch
  );
  const cashierReceiptLabel = resolveCashierReceiptLabel(
    receiptSession?.userId,
    (receiptSession as any)?.user_id,
    (order as any)?.createdById,
    (order as any)?.created_by_id,
    (order as any)?.userId,
    (order as any)?.user_id
  );
  const orderTypeRaw = toTrimmedString((order as any).orderType ?? (order as any).order_type).toLowerCase();
  const receiptType = ((): string => {
    if (order.status === 'Voided' || order.status === 'Cancelled') {
      return 'VOID';
    }
    if (orderTypeRaw.includes('return') || orderTypeRaw.includes('refund')) {
      return 'RETURN';
    }
    if (orderTypeRaw.includes('adjust')) {
      return 'ADJUSTMENT';
    }
    return 'SALE';
  })();
  const fiscalDayNumber = format(orderDate, 'yyyyMMdd');

  const normalizedOrderSubtotal = toFiniteNumber(order.subtotal ?? (order as any).subtotal, 0);
  const normalizedOrderTotal = toFiniteNumber(order.total ?? (order as any).total, normalizedOrderSubtotal);
  const normalizedOrderNet = toFiniteNumber(
    (order as any).netAmount ?? (order as any).net_amount,
    normalizedOrderSubtotal
  );
  const normalizedOrderTax = toFiniteNumber(
    (order as any).tax ??
    (order as any).vatAmount ??
    (order as any).vat_amount,
    0
  );
  const normalizedFinalPayable = normalizedOrderTotal;
  const explicitChangeAmount = toOptionalFiniteNumber(
    (order as any).change ??
    (order as any).changeAmount ??
    (order as any).change_amount
  );
  const tenderedCashAmount = toOptionalFiniteNumber(
    (order as any).amountTendered ??
    (order as any).amount_tendered ??
    (order as any).amountReceived ??
    (order as any).amount_received ??
    (order as any).cashPaid ??
    (order as any).cash_paid
  );
  const computedChangeAmount =
    explicitChangeAmount !== null
      ? explicitChangeAmount
      : tenderedCashAmount !== null
      ? tenderedCashAmount - normalizedFinalPayable
      : 0;
  const receiptPaidAmount =
    isCashPayment && tenderedCashAmount !== null && tenderedCashAmount > 0
      ? tenderedCashAmount
      : 0;
  const receiptChangeAmount =
    isCashPayment && computedChangeAmount > 0.0001 ? computedChangeAmount : 0;
  const isOnAccountPayment = normalizedPaymentMethod.includes('account');
  const receiptAmountPaid =
    receiptPaidAmount > 0
      ? receiptPaidAmount
      : isOnAccountPayment
      ? 0
      : normalizedFinalPayable;
  const receiptChangeDisplay = receiptChangeAmount > 0 ? receiptChangeAmount : 0;

  const orderItems = Array.isArray((order as any).items) ? (order as any).items : [];
  const totalItemVat = orderItems.reduce(
    (acc, item) => acc + toFiniteNumber((item as any).itemTax ?? item.tax_amount ?? item.taxAmount, 0),
    0
  );
  const hasPerItemTax = totalItemVat > 0;

  const resolvedQrPayload = resolveQrPayload(
    (order as any).qrCodePayload ?? (order as any).qr_code_payload
  );
  const fallbackCompliancePayload = [
    `MRA-EIS`,
    `FISCAL:${fiscalInvoiceNumber || `ORD-${orderNumberDisplay}`}`,
    `ORDER:${orderNumberDisplay}`,
    `STATUS:${eisStatus}`,
    `UUID:${eisUuid || 'N/A'}`,
    `TOTAL:${normalizedFinalPayable.toFixed(2)}`,
    `DATE:${orderDate.toISOString()}`,
    `SIG:${signaturePreview || 'N/A'}`,
  ].join('|');
  const qrPayload = (resolvedQrPayload && resolvedQrPayload.length <= 512)
    ? resolvedQrPayload
    : fallbackCompliancePayload;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&ecc=M&margin=0&data=${encodeURIComponent(qrPayload)}`;

  // Calculate tax breakdown by rate for MRA compliance
  const calculateTaxBreakdown = () => {
    const breakdown: Record<string, { 
      taxableValue: number; 
      taxRate: number; 
      vatAmount: number; 
      method: string;
      count: number;
    }> = {};
    
    orderItems.forEach((item) => {
      const taxMethod = (item.tax_calculation_method || item.taxCalculationMethod) === 'exclusive' ? 'exclusive' : 'inclusive';
      const normalizedTaxType = String(item.tax_type ?? item.taxType ?? '').trim().toLowerCase();
      const isZeroOrExempt =
        normalizedTaxType === 'zero' ||
        normalizedTaxType === 'zero_rated' ||
        normalizedTaxType === 'zero-rated' ||
        normalizedTaxType === 'vat_zero' ||
        normalizedTaxType === 'exempt' ||
        normalizedTaxType === 'vat_exempt';

      const itemQuantity = Math.max(1, toFiniteNumber(item.quantity, 1));
      const itemPrice = toFiniteNumber(item.price, 0);
      const computedSubtotal = itemPrice * itemQuantity;
      const itemSubtotal = toFiniteNumber(item.subtotal, computedSubtotal);
      const itemTaxAmount = toFiniteNumber(item.tax_amount ?? item.taxAmount, 0);
      const explicitTaxRate = toOptionalFiniteNumber(item.tax_rate ?? item.taxRate);

      let resolvedTaxRate = 0;
      if (isZeroOrExempt) {
        resolvedTaxRate = 0;
      } else if (explicitTaxRate !== null && explicitTaxRate > 0) {
        resolvedTaxRate = explicitTaxRate;
      } else if (itemTaxAmount > 0 && itemSubtotal > 0) {
        // Backfill rate from amounts when rate snapshot is missing on the item.
        resolvedTaxRate = (itemTaxAmount / itemSubtotal) * 100;
      } else if (explicitTaxRate !== null && explicitTaxRate >= 0) {
        resolvedTaxRate = explicitTaxRate;
      }

      const normalizedTaxRate = Number.isFinite(resolvedTaxRate)
        ? Number(resolvedTaxRate.toFixed(2))
        : 0;
      const rateKey = `${normalizedTaxRate}-${taxMethod}`;
      
      if (!breakdown[rateKey]) {
        breakdown[rateKey] = { 
          taxableValue: 0, 
          taxRate: normalizedTaxRate,
          vatAmount: 0, 
          method: taxMethod,
          count: 0
        };
      }
      breakdown[rateKey].taxableValue += itemSubtotal;
      breakdown[rateKey].vatAmount += itemTaxAmount;
      breakdown[rateKey].count += 1;
    });
    
    return Object.entries(breakdown)
      .sort(([keyA], [keyB]) => {
        const rateA = parseFloat(keyA.split('-')[0]);
        const rateB = parseFloat(keyB.split('-')[0]);
        return rateB - rateA;
      })
      .map(([, data]) => ({
        rate: data.taxRate,
        method: data.method,
        taxableValue: data.taxableValue,
        vatAmount: data.vatAmount,
        count: data.count
      }));
  };

  const taxBreakdown = calculateTaxBreakdown();
  const resolvedPaperWidth: '80mm' | '58mm' = paperWidth === '58mm' ? '58mm' : '80mm';
  const isCompactPaper = resolvedPaperWidth === '58mm';
  const containerWidthClass = isCompactPaper ? 'w-[218px]' : 'w-[300px]';
  const contentPaddingClass = isCompactPaper ? 'px-2 py-2' : 'px-3 py-2';
  const bodyTextClass = isCompactPaper ? 'text-[9px]' : 'text-[10px]';
  const metaTextClass = isCompactPaper ? 'text-[8px]' : 'text-[9px]';
  const businessNameTextClass = isCompactPaper ? 'text-[10px]' : 'text-[12px]';
  const businessNameWidthClass =
    businessNameLength > 30
      ? (isCompactPaper ? 'text-[9px] tracking-normal' : 'text-[10px] tracking-normal')
      : businessNameLength > 20
      ? 'tracking-[0.04em]'
      : 'tracking-[0.08em]';
  const payableTextClass = isCompactPaper ? 'text-[11px]' : 'text-sm';
  const inlineValueMaxWidthClass = isCompactPaper ? 'min-w-0 max-w-[108px]' : 'min-w-0 max-w-[170px]';
  const qrSizeClass = isCompactPaper ? 'h-10 w-10' : 'h-12 w-12';
  const printContentWidth = resolvedPaperWidth;
  const receiptVatTotal = hasPerItemTax ? totalItemVat : normalizedOrderTax;
  // Keep divider width aligned with native ESC/POS formatter widths
  // (58mm=28 chars, 80mm=42 chars) to prevent hard-wrap in printed output.
  const receiptLineWidth = isCompactPaper ? 28 : 42;
  const sectionDotRule = '-'.repeat(receiptLineWidth);
  const sectionSpacingClass = 'mt-3 mb-3';
  const makeSectionBanner = (title: string): string => {
    return title.trim().toUpperCase();
  };
  const renderDotRuleLine = () => (
    <p
      className={`block w-full overflow-hidden whitespace-nowrap text-center ${metaTextClass} leading-none`}
      style={{ overflowWrap: 'normal', wordBreak: 'normal' }}
    >
      {sectionDotRule}
    </p>
  );
  const renderSectionDivider = () => (
    <div className="mb-1">
      {renderDotRuleLine()}
    </div>
  );
  const renderSectionTitleBlock = (title: string) => (
    <div className="mb-1 space-y-0.5">
      {renderDotRuleLine()}
      <p className={`text-center ${metaTextClass} font-semibold tracking-wide`}>{makeSectionBanner(title)}</p>
      {renderDotRuleLine()}
    </div>
  );

  const isCopyReceipt = copyNumber > 1;
  const receiptTypeLabel = `COPY${copyNumber > 2 ? ` #${copyNumber}` : ''}`;

  return (
    <div id="receipt-printable-area" className={`${containerWidthClass} ${contentPaddingClass} bg-white text-black font-mono ${bodyTextClass} leading-tight`}>
      <style jsx global>{`
        #receipt-printable-area,
        #receipt-printable-area * {
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        @media print {
          body * {
            visibility: hidden;
          }
          #receipt-printable-area, #receipt-printable-area * {
            visibility: visible;
          }
          #receipt-printable-area {
            position: absolute;
            left: 50%;
            top: 0;
            transform: translateX(-50%);
            width: ${printContentWidth};
            margin: 0;
            padding: 0 0 ${isCompactPaper ? '16mm' : '18mm'};
          }
          @page {
            margin: 0;
            size: ${resolvedPaperWidth} auto;
          }
        }
      `}</style>

      <div className={`${bodyTextClass} text-center mb-1 font-semibold`}>*** START OF RECEIPT ***</div>
      {renderDotRuleLine()}

      {/* Receipt copy indicator (hidden for first/original print) */}
      {isCopyReceipt && (
        <div className="text-center mb-1">
          <p className="inline-block rounded-sm border border-red-700 px-1.5 py-[1px] text-[8px] leading-none font-semibold tracking-wide text-red-700">
            {receiptTypeLabel}
          </p>
        </div>
      )}

      {/* Business Header */}
      {showHeader && (
        <div className={`text-center space-y-0.5 mt-1 mb-3 ${bodyTextClass}`}>
          <p className={`${businessNameTextClass} font-extrabold leading-tight`}>
            <span className={`${businessNameWidthClass} break-words`}>{businessNameDisplay}</span>
          </p>
          {renderDotRuleLine()}
          <p className={`text-center ${metaTextClass} leading-snug whitespace-pre-line`}>
             {businessAddress || 'N/A'}
          </p>
          <p className={`${metaTextClass} leading-snug`}>Tel: {businessPhone || 'N/A'}</p>
          <p className={`${metaTextClass} leading-snug`}>Email: {businessEmail || 'N/A'}</p>
          <p className={`${metaTextClass} leading-snug`}>TPIN: {businessTin || 'N/A'}</p>
          {/* <p className={`${metaTextClass} leading-snug`}>Branch: {branchIdDisplay || 'N/A'}</p> */}
          <p className={`${metaTextClass} leading-snug`}>{cashierReceiptLabel}</p>
        </div>
      )}

      {/* Invoice Section */}
      <div className={`space-y-0.5 ${sectionSpacingClass} ${bodyTextClass}`}>
        {renderSectionDivider()}
        <div className="flex justify-between items-start gap-2">
          <span>Invoice No:</span>
          <span className="font-semibold text-right min-w-0 flex-1 break-all">
            {orderNumberDisplay}
          </span>
        </div>
        {/* <div className="flex justify-between items-start gap-2">
          <span>Fiscal Invoice No:</span>
          <span className="font-semibold text-right min-w-0 flex-1 break-all">
            {fiscalInvoiceNumber || 'PENDING ASSIGNMENT'}
          </span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Receipt Type:</span>
          <span>{receiptType}</span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Fiscal Day:</span>
          <span>{fiscalDayNumber}</span>
        </div> */}
        <div className="flex justify-between items-start gap-2">
          <span>Date:</span>
          <span>{format(orderDate, 'dd/MM/yyyy')}</span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Time:</span>
          <span>{format(orderDate, 'HH:mm:ss')}</span>
        </div>
      </div>

      {/* Buyer Details */}
      <div className={`space-y-0.5 ${sectionSpacingClass} ${bodyTextClass}`}>
        {renderSectionDivider()}
        <div className="flex justify-between items-start gap-2">
          <span>Buyer&apos;s Name:</span>
          <span className={`text-right ${inlineValueMaxWidthClass} break-words`}>{buyerName || 'Walk-in Customer'}</span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Buyer TPIN:</span>
          <span className={`text-right ${inlineValueMaxWidthClass} break-all`}>{buyerTin || 'N/A'}</span>
        </div>
      </div>

      {/* Items */}
      {showItemDetails && (
        <div className={`${sectionSpacingClass} ${bodyTextClass}`}>
          {renderSectionDivider()}
          <div className="flex justify-between items-start gap-2 font-bold py-0.5 mb-1">
            <span>ITEM</span>
            <span className="text-right">TOTAL</span>
          </div>
          {orderItems.map((item, index) => {
            const itemPrice = toFiniteNumber(item.price, 0);
            const itemQuantity = Math.max(1, toFiniteNumber(item.quantity, 1));
            const itemTotal = toFiniteNumber(item.total, itemPrice * itemQuantity);
            
            return (
              <div key={`${item.id}-${index}`} className="mb-1.5">
                <div className="flex justify-between items-start gap-2">
                  <span className="pr-2 min-w-0 break-words">{item.name}</span>
                  <span className="font-semibold">{formatSafeCurrency(itemTotal)}</span>
                </div>
                <div className={`${metaTextClass} text-gray-600 pl-2`}>
                  {itemQuantity} x {formatSafeCurrency(itemPrice)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Total Amount */}
      <div className={`space-y-0.5 ${sectionSpacingClass} ${bodyTextClass}`}>
        {renderSectionDivider()}
        <div className="flex justify-between items-start gap-2">
          <span>Subtotal:</span>
          <span>{formatSafeCurrency(normalizedOrderNet)}</span>
        </div>
        <div className="pt-1 mt-1">
          {renderDotRuleLine()}
          <div className={`flex justify-between items-start gap-2 font-bold ${payableTextClass} py-1`}>
            <span className="tracking-wide">TOTAL PAYABLE</span>
            <span>{formatSafeCurrency(normalizedFinalPayable)}</span>
          </div>
          {renderDotRuleLine()}
        </div>
      </div>

      {/* Payment Information */}
      <div className={`space-y-0.5 ${sectionSpacingClass} ${bodyTextClass}`}>
        {renderSectionDivider()}
        <div className="flex justify-between items-start gap-2">
          <span>Payment Method:</span>
          <span>{paymentMethodDisplay || 'N/A'}</span>
        </div>
        <div className="flex justify-between items-start gap-2 font-semibold">
          <span>Amount Paid:</span>
          <span>{formatSafeCurrency(receiptAmountPaid)}</span>
        </div>
        <div className="flex justify-between items-start gap-2 font-semibold">
          <span>Change:</span>
          <span>{formatSafeCurrency(receiptChangeDisplay)}</span>
        </div>
      </div>

      {/* Tax Breakdown */}
      {false && showTaxBreakdown && taxBreakdown.length > 0 && (
        <div className={`${sectionSpacingClass} ${bodyTextClass}`}>
          <div className="mb-1 space-y-0.5">
            <p className={`text-center ${metaTextClass} font-semibold tracking-wide`}>
              {makeSectionBanner('Tax Summary')}
            </p>
            {renderDotRuleLine()}
          </div>
          {taxBreakdown.map((tax, idx) => {
            const methodShortLabel = tax.method === 'exclusive' ? 'EXC' : 'INC';
            const displayTaxRate = toFiniteNumber(tax.rate, 0).toFixed(2);
            return (
              <div key={idx} className="space-y-0.5 mb-1">
                <div className="flex justify-between items-start gap-2">
                  <span>VAT {displayTaxRate}% ({methodShortLabel})</span>
                  <span className="font-semibold">{formatSafeCurrency(tax.vatAmount)}</span>
                </div>
                <div className={`flex justify-between items-start gap-2 ${metaTextClass} text-gray-700 pl-2`}>
                  <span>Taxable:</span>
                  <span>{formatSafeCurrency(tax.taxableValue)}</span>
                </div>
              </div>
            );
          })}
          {renderDotRuleLine()}
        </div>
      )}

      <div className={`${sectionSpacingClass} ${bodyTextClass}`}>
        {renderDotRuleLine()}
        <div className={`${bodyTextClass} text-center font-semibold`}>*** END OF RECEIPT ***</div>
      </div>
      <div className={isCompactPaper ? 'h-12' : 'h-16'} />

      {/* EIS Verification */}
      {/* <div className={`space-y-0.5 ${sectionSpacingClass} ${bodyTextClass}`}>
        {renderSectionDivider()}
        <div className="flex justify-between items-start gap-2">
          <span>EIS Receipt No:</span>
          <span className={`text-right ${inlineValueMaxWidthClass} break-all`}>
            {fiscalInvoiceNumber || 'PENDING'}
          </span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Verification Code:</span>
          <span className={`text-right ${inlineValueMaxWidthClass} break-all`}>
            {eisUuid || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>Fiscal Signature:</span>
          <span className={`text-right ${inlineValueMaxWidthClass} break-all`}>
            {digitalSignature || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between items-start gap-2">
          <span>EIS Status:</span>
          <span>{eisStatus || 'PENDING'}</span>
        </div>
      </div> */}

      {/* Footer */}
      {showFooter && (
        <div className="text-center mt-6">
          <div className="h-3" />
          <p className={`${metaTextClass} font-semibold`}>Thank you for your purchase</p>
          {/* <p className={`${metaTextClass} text-gray-700 mt-0.5 mb-1`}>MRA EIS Fiscal Receipt</p> */}
          {showQRCode && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrCodeUrl} alt="EIS QR Code" className={qrSizeClass} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
