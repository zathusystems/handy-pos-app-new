'use client';

import React from 'react';
import { format } from 'date-fns';
import type { Business } from '@/lib/db';
import { getOfflineBusinessProfile } from '@/lib/business-profile';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X,
  DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT,
  DEFAULT_RECEIPT_FONT_WEIGHT,
  DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X,
  DEFAULT_RECEIPT_LINE_HEIGHT,
  getDefaultReceiptBusinessNameFontSize,
  normalizeReceiptBusinessNameFontSize,
  normalizeReceiptFontSize,
  normalizeReceiptFontWeight,
  normalizeReceiptLineHeight,
  normalizeReceiptPaddingX,
  normalizeReceiptTextScaleX,
  type ReceiptFontWeight,
} from '@/lib/services/printer-service';
import {
  formatQuantityWithUnit,
  getPortionQuantityDisplay,
} from '@/lib/quantity-format';

type BillCartItem = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  notes?: string;
  selectedOptions?: Array<Record<string, unknown>>;
  selected_options?: Array<Record<string, unknown>>;
  unitType?: string;
  isVariablePrice?: boolean;
  isSoldInPortions?: boolean;
  portionName?: string;
  portionsPerUnit?: number;
};

type BillReceiptProps = {
  cart: BillCartItem[];
  business?: Business;
  currencyFormatter: (amount: number) => string;
  subtotal: number;
  tax: number;
  total: number;
  taxLabel?: string;
  cartTitle?: string;
  billNumber?: string;
  paperWidth?: '80mm' | '58mm';
  rootId?: string;
  receiptFontSize?: number;
  receiptFontWeight?: ReceiptFontWeight;
  receiptLineHeight?: number;
  receiptPaddingX?: number;
  receiptBusinessNameFontSize?: number;
  receiptBusinessNameFontWeight?: ReceiptFontWeight;
  receiptBusinessNameScaleX?: number;
  receiptHeaderDetailScaleX?: number;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTrimmedString = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const getSelectedOptions = (item: BillCartItem): Array<Record<string, unknown>> => {
  const selected = item.selectedOptions ?? item.selected_options;
  return Array.isArray(selected)
    ? selected.filter((option) => option && typeof option === 'object')
    : [];
};

const formatSelectedOptionLine = (option: Record<string, unknown>): string => {
  const groupName = toTrimmedString(
    option.groupName ??
    option.group_name ??
    option.optionGroupName ??
    option.option_group_name
  );
  const optionName = toTrimmedString(option.name ?? option.label ?? option.optionName ?? option.option_name);
  const quantity = toFiniteNumber(
    option.quantity ?? option.selectedQuantity ?? option.selected_quantity,
    1
  );
  const quantityPrefix = quantity > 1 ? `${quantity} x ` : '';

  if (!optionName) {
    return '';
  }

  return groupName ? `${groupName}: ${quantityPrefix}${optionName}` : `${quantityPrefix}${optionName}`;
};

const formatItemQuantitySummary = (item: BillCartItem): string => {
  const portionsPerUnit = toFiniteNumber(item.portionsPerUnit, 0);
  if (item.isSoldInPortions && portionsPerUnit > 0) {
    const portionDisplay = getPortionQuantityDisplay({
      quantity: item.quantity,
      unitLabel: item.unitType || 'unit',
      portionName: item.portionName,
      portionsPerUnit,
    });
    return portionDisplay.summaryText;
  }

  return formatQuantityWithUnit(item.quantity, item.unitType || 'unit', {
    maximumFractionDigits: 3,
  });
};

const resolveLineTotal = (item: BillCartItem): number => {
  if (item.isVariablePrice) {
    return toFiniteNumber(item.price, 0);
  }
  return toFiniteNumber(item.price, 0) * toFiniteNumber(item.quantity, 0);
};

export function BillReceipt({
  cart,
  business,
  currencyFormatter,
  subtotal,
  tax,
  total,
  taxLabel = 'VAT Amount',
  cartTitle,
  billNumber,
  paperWidth = '80mm',
  rootId = 'bill-printable-area',
  receiptFontSize,
  receiptFontWeight,
  receiptLineHeight,
  receiptPaddingX,
  receiptBusinessNameFontSize,
  receiptBusinessNameFontWeight,
  receiptBusinessNameScaleX,
  receiptHeaderDetailScaleX,
}: BillReceiptProps) {
  const offlineBusiness = useLiveQuery(async () => getOfflineBusinessProfile(), []);
  const resolvedBusiness = business || offlineBusiness || undefined;
  const businessName = toTrimmedString(resolvedBusiness?.name) || 'Handy POS';
  const businessPhone = toTrimmedString(resolvedBusiness?.phone);
  const businessEmail = toTrimmedString(resolvedBusiness?.email);
  const businessAddress = toTrimmedString(resolvedBusiness?.address);
  const printedAt = new Date();
  const resolvedBillNumber =
    toTrimmedString(billNumber) ||
    `BILL-${format(printedAt, 'yyyyMMdd-HHmmss')}`;
  const resolvedPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm';
  const isCompactPaper = resolvedPaperWidth === '58mm';
  const sheetWidth = resolvedPaperWidth;
  const fontSize = normalizeReceiptFontSize(receiptFontSize, resolvedPaperWidth);
  const fontWeight = normalizeReceiptFontWeight(receiptFontWeight ?? DEFAULT_RECEIPT_FONT_WEIGHT);
  const lineHeight = normalizeReceiptLineHeight(receiptLineHeight ?? DEFAULT_RECEIPT_LINE_HEIGHT);
  const horizontalPadding = normalizeReceiptPaddingX(receiptPaddingX, resolvedPaperWidth);
  const printPaddingXmm = isCompactPaper
    ? Math.max(1.5, Math.round((horizontalPadding / 12) * 10) / 10)
    : Math.max(2, Math.round((horizontalPadding / 10) * 10) / 10);
  const businessNameFontSize = normalizeReceiptBusinessNameFontSize(
    receiptBusinessNameFontSize ?? getDefaultReceiptBusinessNameFontSize(resolvedPaperWidth),
    resolvedPaperWidth
  );
  const businessNameWeight = normalizeReceiptFontWeight(
    receiptBusinessNameFontWeight ?? DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT
  );
  const businessNameScale = normalizeReceiptTextScaleX(
    receiptBusinessNameScaleX,
    DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
  );
  const headerDetailScale = normalizeReceiptTextScaleX(
    receiptHeaderDetailScaleX,
    DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
  );
  const businessNameMaxWidth = `${Math.floor(100 / businessNameScale)}%`;
  const headerDetailMaxWidth = `${Math.floor(100 / headerDetailScale)}%`;
  const ruleLength = isCompactPaper ? 32 : 42;
  const rule = '-'.repeat(ruleLength);

  const formatBillAmount = (value: unknown): string => currencyFormatter(toFiniteNumber(value, 0));

  return (
    <div id={rootId}>
      <style>{`
        .bill-sheet {
          width: ${sheetWidth};
          box-sizing: border-box;
          margin: 0 auto;
          padding: ${isCompactPaper ? 10 : 12}px ${horizontalPadding}px ${isCompactPaper ? 12 : 14}px;
          background: #fff;
          color: #000;
          font-family: "Courier New", "Liberation Mono", "Lucida Console", monospace;
          font-size: ${fontSize}px;
          font-weight: ${fontWeight};
          line-height: ${lineHeight};
          letter-spacing: 0;
        }
        .bill-center {
          text-align: center;
        }
        .bill-business {
          margin: 2px 0 3px;
          text-align: center;
          line-height: 1;
          white-space: nowrap;
        }
        .bill-business-text {
          display: inline-block;
          max-width: ${businessNameMaxWidth};
          overflow: hidden;
          text-overflow: clip;
          font-size: ${businessNameFontSize}px;
          font-weight: ${businessNameWeight};
          line-height: 1;
          transform: scaleX(${businessNameScale});
          transform-origin: center center;
          white-space: nowrap;
        }
        .bill-header-detail {
          display: inline-block;
          max-width: ${headerDetailMaxWidth};
          overflow: hidden;
          text-overflow: clip;
          white-space: nowrap;
          transform: scaleX(${headerDetailScale});
          transform-origin: center center;
        }
        .bill-label {
          margin: 7px 0 5px;
          border: 1px solid #000;
          padding: 4px 6px;
          text-align: center;
          font-weight: 800;
          letter-spacing: 0;
        }
        .bill-note {
          text-align: center;
          font-size: ${Math.max(9, fontSize - 2)}px;
        }
        .bill-rule {
          overflow: hidden;
          white-space: nowrap;
          line-height: 1;
          margin: 6px 0 5px;
        }
        .bill-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) max-content;
          column-gap: 8px;
          align-items: start;
          min-height: ${Math.ceil(fontSize * lineHeight)}px;
          white-space: nowrap;
        }
        .bill-row span:first-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: clip;
        }
        .bill-row span:last-child {
          text-align: right;
        }
        .bill-item {
          margin-bottom: 5px;
        }
        .bill-item-name {
          font-weight: 700;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .bill-item-meta {
          display: grid;
          grid-template-columns: minmax(0, 1fr) max-content;
          column-gap: 8px;
          font-size: ${Math.max(9, fontSize - 1)}px;
        }
        .bill-item-meta span:first-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: clip;
          white-space: nowrap;
        }
        .bill-item-option {
          margin-top: 1px;
          padding-left: 8px;
          font-size: ${Math.max(8, fontSize - 2)}px;
          color: #111;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .bill-total {
          font-size: ${fontSize + 1}px;
          font-weight: 800;
        }
        .bill-footer {
          margin-top: 8px;
          text-align: center;
          font-size: ${Math.max(9, fontSize - 2)}px;
        }
        @media print {
          @page {
            size: ${resolvedPaperWidth} auto;
            margin: 0;
          }
          html,
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
          .bill-sheet {
            width: ${resolvedPaperWidth};
            margin: 0 auto !important;
            padding: 2mm ${printPaddingXmm}mm ${isCompactPaper ? 3 : 4}mm !important;
          }
        }
      `}</style>

      <div className="bill-sheet">
        <div className="bill-business">
          <span className="bill-business-text">{businessName}</span>
        </div>
        {businessAddress && (
          <div className="bill-center">
            <span className="bill-header-detail">{businessAddress}</span>
          </div>
        )}
        {businessPhone && (
          <div className="bill-center">
            <span className="bill-header-detail">MOB: {businessPhone}</span>
          </div>
        )}
        {businessEmail && (
          <div className="bill-center">
            <span className="bill-header-detail">EMAIL: {businessEmail}</span>
          </div>
        )}

        <div className="bill-label">CUSTOMER BILL</div>
        <div className="bill-note">PAYMENT PENDING - NOT A FISCAL RECEIPT</div>

        <div className="bill-rule">{rule}</div>
        <div className="bill-row">
          <span>BILL NO</span>
          <span>{resolvedBillNumber}</span>
        </div>
        {toTrimmedString(cartTitle) && (
          <div className="bill-row">
            <span>CART</span>
            <span>{toTrimmedString(cartTitle)}</span>
          </div>
        )}
        <div className="bill-row">
          <span>DATE</span>
          <span>{format(printedAt, 'dd-MM-yyyy')}</span>
        </div>
        <div className="bill-row">
          <span>TIME</span>
          <span>{format(printedAt, 'HH:mm:ss')}</span>
        </div>

        <div className="bill-rule">{rule}</div>
        {cart.map((item) => {
          const optionLines = getSelectedOptions(item).map(formatSelectedOptionLine).filter(Boolean);

          return (
            <div className="bill-item" key={item.id}>
              <div className="bill-item-name">{item.name}</div>
              {optionLines.map((line, index) => (
                <div className="bill-item-option" key={`${item.id}-option-${index}`}>
                  + {line}
                </div>
              ))}
              <div className="bill-item-meta">
                <span>{formatItemQuantitySummary(item)} x {formatBillAmount(item.price)}</span>
                <span>{formatBillAmount(resolveLineTotal(item))}</span>
              </div>
              {item.notes && <div className="bill-note">NOTE: {item.notes}</div>}
            </div>
          );
        })}

        <div className="bill-rule">{rule}</div>
        <div className="bill-row">
          <span>SUBTOTAL</span>
          <span>{formatBillAmount(subtotal)}</span>
        </div>
        <div className="bill-row">
          <span>{taxLabel}</span>
          <span>{formatBillAmount(tax)}</span>
        </div>
        <div className="bill-row bill-total">
          <span>AMOUNT DUE</span>
          <span>{formatBillAmount(total)}</span>
        </div>
        <div className="bill-rule">{rule}</div>
        <div className="bill-footer">
          Please present this bill to the cashier for payment.
        </div>
      </div>
    </div>
  );
}
