'use client';

const ZERO_WIDTH_CHARS_REGEX = /[\u200B-\u200D\uFEFF]/g;

export function normalizeBarcodeValue(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_CHARS_REGEX, '')
    .replace(/\s+/g, '')
    .trim();
}

export function getBarcodeVariants(value: unknown): string[] {
  const normalized = normalizeBarcodeValue(value);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);

  // Many scanners return UPC-A as EAN-13 with a leading zero.
  if (/^\d{12}$/.test(normalized)) {
    variants.add(`0${normalized}`);
  }

  if (/^0\d{12}$/.test(normalized)) {
    variants.add(normalized.slice(1));
  }

  return Array.from(variants);
}

export function barcodeValuesMatch(left: unknown, right: unknown): boolean {
  const leftVariants = getBarcodeVariants(left);
  const rightVariants = new Set(getBarcodeVariants(right));

  if (leftVariants.length === 0 || rightVariants.size === 0) {
    return false;
  }

  return leftVariants.some((variant) => rightVariants.has(variant));
}
