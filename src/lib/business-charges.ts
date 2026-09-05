import type { BusinessCharge } from '@/lib/db';

export interface AppliedBusinessCharge {
  [key: string]: unknown;
  id: string;
  name: string;
  chargeType: BusinessCharge['chargeType'];
  rate: number;
  calculationMethod: BusinessCharge['calculationMethod'];
  calculationBase: BusinessCharge['calculationBase'];
  baseAmount: number;
  amount: number;
}

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const isChargeEffective = (charge: BusinessCharge, now = new Date()): boolean => {
  if (!charge.isActive || !charge.autoApply) return false;

  const from = charge.effectiveFrom ? new Date(`${charge.effectiveFrom}T00:00:00`) : null;
  const to = charge.effectiveTo ? new Date(`${charge.effectiveTo}T23:59:59`) : null;

  if (from && now < from) return false;
  if (to && now > to) return false;
  return true;
};

export const calculateAppliedCharges = ({
  charges,
  netSubtotal,
  grossTotal,
}: {
  charges: BusinessCharge[];
  netSubtotal: number;
  grossTotal: number;
}): AppliedBusinessCharge[] => {
  return charges
    .filter((charge) => isChargeEffective(charge))
    .filter((charge) => {
      if (charge.applicationRule !== 'over_amount') return true;
      const threshold = Number(charge.minimumSaleAmount);
      return !Number.isFinite(threshold) || grossTotal > Math.max(0, threshold);
    })
    .map((charge) => {
      const rate = Number.isFinite(Number(charge.rate)) ? Number(charge.rate) : 0;
      const baseAmount = charge.calculationBase === 'gross_total' ? grossTotal : netSubtotal;
      const rawAmount = rate > 0 ? baseAmount * (rate / 100) : 0;
      const amount = charge.calculationMethod === 'inclusive'
        ? (rate > 0 ? baseAmount * (rate / 100) / (1 + rate / 100) : 0)
        : rawAmount;

      return {
        id: charge.id,
        name: charge.name,
        chargeType: charge.chargeType,
        rate,
        calculationMethod: charge.calculationMethod,
        calculationBase: charge.calculationBase,
        applicationRule: charge.applicationRule,
        minimumSaleAmount: roundMoney(Math.max(0, Number(charge.minimumSaleAmount) || 0)),
        baseAmount: roundMoney(baseAmount),
        amount: roundMoney(amount),
      };
    })
    .filter((charge) => charge.amount > 0);
};

export const sumAppliedCharges = (charges: AppliedBusinessCharge[]): number => (
  roundMoney(charges.reduce((total, charge) => total + charge.amount, 0))
);
