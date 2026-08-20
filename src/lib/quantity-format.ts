import { type BusinessType } from '@/lib/inventory/config';

const WHOLE_STOCK_BUSINESS_TYPES = new Set<BusinessType>([
    'Grocery',
    'Supermarket',
    'General Retail',
    'Clothing & Fashion',
    'Hardware',
    'Pharmacy',
    'Beauty Salon and Spa',
]);

type QuantityFormatOptions = {
    preferWholeNumbers?: boolean;
    maximumFractionDigits?: number;
};

type PortionQuantityDisplayInput = {
    quantity: unknown;
    unitLabel?: string | null;
    portionName?: string | null;
    portionsPerUnit?: unknown;
};

export type PortionQuantityDisplay = {
    wholeUnits: number;
    remainingPortions: number;
    totalPortions: number;
    wholeUnitsText: string;
    remainingPortionsText: string;
    summaryText: string;
};

export const shouldPreferWholeStockCounts = (businessType?: BusinessType): boolean => {
    return businessType ? WHOLE_STOCK_BUSINESS_TYPES.has(businessType) : false;
};

export const formatInventoryQuantity = (
    value: unknown,
    options: QuantityFormatOptions = {}
): string => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return '0';
    }

    const normalized = Math.abs(parsed) < 0.0005 ? 0 : parsed;
    const roundedWhole = Math.round(normalized);
    const wholeNumberTolerance = options.preferWholeNumbers ? 0.01 : 0.001;

    if (Math.abs(normalized - roundedWhole) <= wholeNumberTolerance) {
        return roundedWhole.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    return normalized.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: options.maximumFractionDigits ?? (options.preferWholeNumbers ? 2 : 3),
    });
};

const pluralizeUnitLabel = (label: string, quantity: number): string => {
    const trimmedLabel = String(label || '').trim();
    if (!trimmedLabel) {
        return Math.abs(quantity - 1) < 0.001 ? 'unit' : 'units';
    }

    if (Math.abs(quantity - 1) < 0.001) {
        return trimmedLabel;
    }

    const lowerLabel = trimmedLabel.toLowerCase();

    if (lowerLabel === 'unit') return 'units';
    if (lowerLabel === 'glass') return 'glasses';
    if (trimmedLabel.length <= 3) return trimmedLabel;
    if (/(s|x|z|ch|sh)$/i.test(trimmedLabel)) return `${trimmedLabel}es`;
    if (/[^aeiou]y$/i.test(trimmedLabel)) return `${trimmedLabel.slice(0, -1)}ies`;

    return `${trimmedLabel}s`;
};

export const formatQuantityWithUnit = (
    value: unknown,
    unitLabel?: string | null,
    options: QuantityFormatOptions = {}
): string => {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) ? (Math.abs(parsed) < 0.0005 ? 0 : parsed) : 0;
    return `${formatInventoryQuantity(normalized, options)} ${pluralizeUnitLabel(unitLabel || 'unit', normalized)}`.trim();
};

export const getPortionQuantityDisplay = ({
    quantity,
    unitLabel,
    portionName,
    portionsPerUnit,
}: PortionQuantityDisplayInput): PortionQuantityDisplay | null => {
    const parsedQuantity = Number(quantity);
    const parsedPortionsPerUnit = Number(portionsPerUnit);

    if (!Number.isFinite(parsedQuantity) || !Number.isFinite(parsedPortionsPerUnit) || parsedPortionsPerUnit <= 0) {
        return null;
    }

    const rawTotalPortions = parsedQuantity * parsedPortionsPerUnit;
    const roundedTotalPortions = Math.round(rawTotalPortions);
    const totalPortions = Math.max(
        0,
        Math.abs(rawTotalPortions - roundedTotalPortions) <= 0.01
            ? roundedTotalPortions
            : Math.round(rawTotalPortions)
    );
    const wholeUnits = Math.floor(totalPortions / parsedPortionsPerUnit);
    const remainingPortions = totalPortions % parsedPortionsPerUnit;
    const wholeUnitsText = formatQuantityWithUnit(wholeUnits, unitLabel || 'unit', {
        preferWholeNumbers: true,
        maximumFractionDigits: 0,
    });
    const remainingPortionsText = formatQuantityWithUnit(remainingPortions, portionName || 'portion', {
        preferWholeNumbers: true,
        maximumFractionDigits: 0,
    });

    const summaryParts: string[] = [];
    if (wholeUnits > 0 || totalPortions === 0) {
        summaryParts.push(wholeUnitsText);
    }
    if (remainingPortions > 0) {
        summaryParts.push(remainingPortionsText);
    }

    return {
        wholeUnits,
        remainingPortions,
        totalPortions,
        wholeUnitsText,
        remainingPortionsText,
        summaryText: summaryParts.length > 0 ? summaryParts.join(' + ') : remainingPortionsText,
    };
};

export const formatNotificationBadgeCount = (count: number): string => {
    return count > 9 ? '9+' : String(Math.max(0, count));
};
