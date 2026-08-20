const toFiniteQuantity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const normalizePurchaseBatchQuantities = (
  quantityReceived: unknown,
  quantityRemaining: unknown
) => {
  const safeQuantityReceived = toFiniteQuantity(quantityReceived);
  const safeQuantityRemaining = toFiniteQuantity(quantityRemaining);

  // Remaining stock can never exceed what was received.
  // If we encounter older inconsistent data, lift received up to the remaining
  // count so the batch still reflects the whole purchased quantity.
  const normalizedQuantityReceived = Math.max(safeQuantityReceived, safeQuantityRemaining);
  const normalizedQuantityRemaining = Math.min(safeQuantityRemaining, normalizedQuantityReceived);

  return {
    quantityReceived: normalizedQuantityReceived,
    quantityRemaining: normalizedQuantityRemaining,
  };
};
