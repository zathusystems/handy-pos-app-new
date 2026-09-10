'use client';

import React from 'react';

type KitchenTicketItem = {
  id: string;
  name: string;
  quantity: number;
  notes?: string;
  selectedOptions?: Array<Record<string, unknown>>;
  selected_options?: Array<Record<string, unknown>>;
};

type KitchenTicketProps = {
  items: KitchenTicketItem[];
  orderNumber: number;
  paperWidth?: '80mm' | '58mm';
  rootId?: string;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const getSelectedOptions = (item: KitchenTicketItem): Array<Record<string, unknown>> => {
  const options = item.selectedOptions ?? item.selected_options;
  return Array.isArray(options)
    ? options.filter((option) => option && typeof option === 'object')
    : [];
};

const formatOption = (option: Record<string, unknown>): string => {
  const groupName = toTrimmedString(
    option.groupName ?? option.group_name ?? option.optionGroupName ?? option.option_group_name
  );
  const optionName = toTrimmedString(option.name ?? option.label ?? option.optionName ?? option.option_name);
  const quantity = toFiniteNumber(option.quantity ?? option.selectedQuantity ?? option.selected_quantity, 1);
  if (!optionName) return '';

  const quantityPrefix = quantity > 1 ? `${quantity} x ` : '';
  return groupName ? `${groupName}: ${quantityPrefix}${optionName}` : `${quantityPrefix}${optionName}`;
};

const formatQuantity = (value: unknown): string => new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
}).format(toFiniteNumber(value, 0));

export function KitchenTicket({
  items,
  orderNumber,
  paperWidth = '80mm',
  rootId = 'kitchen-ticket-printable-area',
}: KitchenTicketProps) {
  const resolvedPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm';
  const isCompactPaper = resolvedPaperWidth === '58mm';
  const rule = '-'.repeat(isCompactPaper ? 32 : 42);

  return (
    <div id={rootId}>
      <style>{`
        .kitchen-ticket-sheet {
          width: ${resolvedPaperWidth};
          box-sizing: border-box;
          margin: 0 auto;
          padding: ${isCompactPaper ? 12 : 14}px ${isCompactPaper ? 14 : 18}px ${isCompactPaper ? 36 : 46}px;
          background: #fff;
          color: #000;
          font-family: "Courier New", "Liberation Mono", "Lucida Console", monospace;
          font-size: ${isCompactPaper ? 13 : 15}px;
          font-weight: 600;
          line-height: 1.2;
        }
        .kitchen-ticket-title {
          margin-bottom: 3px;
          text-align: center;
          font-size: ${isCompactPaper ? 16 : 18}px;
          font-weight: 800;
        }
        .kitchen-ticket-order {
          margin-bottom: 8px;
          text-align: center;
          font-size: ${isCompactPaper ? 13 : 14}px;
          font-weight: 700;
        }
        .kitchen-ticket-rule {
          overflow: hidden;
          margin: 7px 0;
          line-height: 1;
          white-space: nowrap;
        }
        .kitchen-ticket-item {
          display: grid;
          grid-template-columns: minmax(0, 1fr) max-content;
          column-gap: 10px;
          align-items: start;
          margin-bottom: 8px;
        }
        .kitchen-ticket-item-name {
          min-width: 0;
          font-weight: 800;
          overflow-wrap: anywhere;
        }
        .kitchen-ticket-quantity {
          font-weight: 800;
          text-align: right;
          white-space: nowrap;
        }
        .kitchen-ticket-option,
        .kitchen-ticket-note {
          grid-column: 1 / -1;
          margin-top: 2px;
          padding-left: 8px;
          font-size: ${isCompactPaper ? 11 : 12}px;
          font-weight: 500;
          overflow-wrap: anywhere;
        }
        .kitchen-ticket-note {
          font-weight: 700;
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
          .kitchen-ticket-sheet {
            width: ${resolvedPaperWidth};
            margin: 0 auto !important;
            padding: 3mm ${isCompactPaper ? 3 : 4}mm ${isCompactPaper ? 12 : 16}mm !important;
          }
        }
      `}</style>

      <div className="kitchen-ticket-sheet">
        <div className="kitchen-ticket-title">KITCHEN TICKET</div>
        <div className="kitchen-ticket-order">ORDER #{orderNumber}</div>
        <div className="kitchen-ticket-rule">{rule}</div>
        {items.map((item) => {
          const selectedOptions = getSelectedOptions(item).map(formatOption).filter(Boolean);
          return (
            <div className="kitchen-ticket-item" key={item.id}>
              <div className="kitchen-ticket-item-name">{item.name}</div>
              <div className="kitchen-ticket-quantity">x {formatQuantity(item.quantity)}</div>
              {selectedOptions.map((option, index) => (
                <div className="kitchen-ticket-option" key={`${item.id}-option-${index}`}>
                  + {option}
                </div>
              ))}
              {toTrimmedString(item.notes) && (
                <div className="kitchen-ticket-note">NOTE: {toTrimmedString(item.notes)}</div>
              )}
            </div>
          );
        })}
        <div className="kitchen-ticket-rule">{rule}</div>
      </div>
    </div>
  );
}
