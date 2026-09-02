export type MraLevy = {
  levyTypeId: string;
  levyRate: number;
};

export type AppliedMraLevy = {
  [key: string]: unknown;
  id: string;
  name: string;
  chargeType: 'LEVY';
  rate: number;
  calculationMethod: 'exclusive';
  calculationBase: 'net_subtotal';
  baseAmount: number;
  amount: number;
  source: 'mra';
  levyTypeId: string;
};

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const resolveLevies = (raw: unknown): MraLevy[] => {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    const levyTypeId = String(
      value.levyTypeId ?? value.levy_type_id ?? value.levyId ?? value.levy_id ?? value.code ?? ''
    ).trim();
    const levyRate = Number(value.levyRate ?? value.levy_rate ?? 0);
    if (!levyTypeId || !Number.isFinite(levyRate) || levyRate <= 0) return [];

    const key = `${levyTypeId.toUpperCase()}:${levyRate}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ levyTypeId, levyRate }];
  });
};

const resolveMapping = (mapping: any): any => mapping || {};

export const calculateAppliedMraLevies = ({
  cart,
  mappingByItemId,
  lineNetAmounts,
}: {
  cart: Array<{ id: string; inventoryItemId?: string }>;
  mappingByItemId: Map<string, any>;
  lineNetAmounts: Record<string, number>;
}): AppliedMraLevy[] => {
  const applied: AppliedMraLevy[] = [];

  for (const cartItem of cart) {
    const inventoryItemId = String(cartItem.inventoryItemId || cartItem.id || '').trim();
    const mapping = resolveMapping(mappingByItemId.get(inventoryItemId));
    const isReady = Boolean(mapping.isApproved ?? mapping.is_approved) &&
      Boolean(mapping.mraSynced ?? mapping.mra_synced);
    if (!isReady) continue;

    const baseAmount = Number(lineNetAmounts[String(cartItem.id)] ?? 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) continue;

    for (const levy of resolveLevies(mapping.mraLevies ?? mapping.mra_levies)) {
      const amount = roundMoney(baseAmount * levy.levyRate / 100);
      if (amount <= 0) continue;
      applied.push({
        id: `mra:${levy.levyTypeId}:${cartItem.id}`,
        name: `MRA Levy ${levy.levyTypeId}`,
        chargeType: 'LEVY',
        rate: levy.levyRate,
        calculationMethod: 'exclusive',
        calculationBase: 'net_subtotal',
        baseAmount: roundMoney(baseAmount),
        amount,
        source: 'mra',
        levyTypeId: levy.levyTypeId,
      });
    }
  }

  return applied;
};

export const sumAppliedMraLevies = (levies: AppliedMraLevy[]): number => (
  roundMoney(levies.reduce((total, levy) => total + levy.amount, 0))
);
