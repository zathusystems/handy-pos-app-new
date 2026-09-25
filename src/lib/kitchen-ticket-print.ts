export type KitchenTicketPrintItem = {
  id?: string | number;
  name?: string;
  quantity?: number;
  notes?: string;
  selectedOptions?: Array<Record<string, unknown>>;
  selected_options?: Array<Record<string, unknown>>;
};

export type KitchenTicketPrintData = {
  items: KitchenTicketPrintItem[];
  orderNumber: number | string;
  businessName?: string;
  takenByName?: string;
  customerName?: string;
  tableNumber?: string;
  createdAt?: string;
  isTakeaway?: boolean;
  isSelfService?: boolean;
  paperWidth?: '80mm' | '58mm';
  ticketTitle?: string;
  locationLabel?: string;
};

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const escapeHtml = (value: unknown): string => toTrimmedString(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatQuantity = (value: unknown): string => new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
}).format(toFiniteNumber(value, 0));

const formatTicketDateTime = (value?: string): string => {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
};

const formatSelectedOption = (option: Record<string, unknown>): string => {
  const groupName = toTrimmedString(
    option.groupName ?? option.group_name ?? option.optionGroupName ?? option.option_group_name
  );
  const optionName = toTrimmedString(option.name ?? option.label ?? option.optionName ?? option.option_name);
  const quantity = toFiniteNumber(option.quantity ?? option.selectedQuantity ?? option.selected_quantity, 1);
  if (!optionName) return '';

  const quantityPrefix = quantity > 1 ? `${quantity} x ` : '';
  return groupName ? `${groupName}: ${quantityPrefix}${optionName}` : `${quantityPrefix}${optionName}`;
};

const getSelectedOptions = (item: KitchenTicketPrintItem): Array<Record<string, unknown>> => {
  const options = item.selectedOptions ?? item.selected_options;
  return Array.isArray(options)
    ? options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
    : [];
};

/**
 * Builds print-ready markup without relying on a mounted modal. Android ticket
 * printing can therefore continue after the order form has closed.
 */
export const buildKitchenTicketPrintHtml = ({
  items,
  orderNumber,
  businessName,
  takenByName,
  customerName,
  tableNumber,
  createdAt,
  isTakeaway = false,
  isSelfService = false,
  paperWidth = '80mm',
  ticketTitle = 'KITCHEN TICKET',
  locationLabel = 'TABLE / ADDRESS',
}: KitchenTicketPrintData): string => {
  const resolvedPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm';
  const isCompactPaper = resolvedPaperWidth === '58mm';
  const rule = '-'.repeat(isCompactPaper ? 32 : 42);
  const preparedBy = toTrimmedString(takenByName) || (isSelfService ? 'Customer QR order' : 'Staff');
  const orderLocation = toTrimmedString(tableNumber);
  const customer = toTrimmedString(customerName);
  const orderedAt = formatTicketDateTime(createdAt);
  const itemLines = items.map((item) => {
    const options = getSelectedOptions(item)
      .map(formatSelectedOption)
      .filter(Boolean)
      .map((option) => `<div style="padding-left: 8px">+ ${escapeHtml(option)}</div>`)
      .join('');
    const note = toTrimmedString(item.notes);

    return [
      `<div>${escapeHtml(item.name || 'Item')} x ${escapeHtml(formatQuantity(item.quantity))}</div>`,
      options,
      note ? `<div style="padding-left: 8px">NOTE: ${escapeHtml(note)}</div>` : '',
    ].join('');
  }).join('');

  return [
    `<div data-receipt-font-size="${isCompactPaper ? 13 : 15}" data-receipt-font-weight="600" data-receipt-line-height="1.2">`,
    businessName ? `<div>${escapeHtml(toTrimmedString(businessName).toUpperCase())}</div>` : '',
    `<div>${escapeHtml(ticketTitle)}</div>`,
    `<div>ORDER #: ${escapeHtml(orderNumber)}</div>`,
    `<div>TAKEN BY: ${escapeHtml(preparedBy)}</div>`,
    orderLocation ? `<div>${escapeHtml(locationLabel)}: ${escapeHtml(orderLocation)}</div>` : '',
    customer ? `<div>CUSTOMER: ${escapeHtml(customer)}</div>` : '',
    isTakeaway ? '<div>TAKEAWAY</div>' : '',
    orderedAt ? `<div>ORDERED: ${escapeHtml(orderedAt)}</div>` : '',
    `<div>${rule}</div>`,
    itemLines,
    `<div>${rule}</div>`,
    '</div>',
  ].join('');
};
