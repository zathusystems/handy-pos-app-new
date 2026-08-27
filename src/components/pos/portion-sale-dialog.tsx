'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Minus, Plus } from 'lucide-react';

import type { InventoryItem } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatQuantityWithUnit, getPortionQuantityDisplay } from '@/lib/quantity-format';

type PortionSaleMode = 'portion' | 'full_unit';

type PortionSaleDialogProps = {
  item: InventoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedOptions?: Array<Record<string, unknown>>;
  onAddToCart: (
    item: InventoryItem,
    quantity?: number,
    price?: number,
    selectedOptions?: Array<Record<string, unknown>>
  ) => boolean | void | Promise<boolean | void>;
};

const toPositiveNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toPositiveInteger = (value: unknown, fallback = 1): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
};

const roundCartQuantity = (value: number): number => Number(value.toFixed(6));

export const canSellInPortions = (item: InventoryItem | null | undefined): item is InventoryItem => {
  return Boolean(item?.isSoldInPortions && toPositiveNumber(item?.portionsPerUnit, 0) > 0);
};

export function PortionSaleDialog({
  item,
  open,
  onOpenChange,
  selectedOptions = [],
  onAddToCart,
}: PortionSaleDialogProps) {
  const [saleMode, setSaleMode] = useState<PortionSaleMode>('portion');
  const [saleQuantity, setSaleQuantity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { format: formatCurrency } = useCurrency();

  const portionsPerUnit = toPositiveNumber(item?.portionsPerUnit, 0);
  const portionLabel = String(item?.portionName || 'portion').trim() || 'portion';
  const fullUnitLabel = String(item?.unitType || 'unit').trim() || 'unit';
  const fullUnitPrice = toPositiveNumber(item?.price, 0);
  const explicitPortionPrice = toPositiveNumber(item?.portionPrice ?? item?.portion_price, 0);
  const basePortionUnitPrice = portionsPerUnit > 0
    ? (explicitPortionPrice > 0 ? explicitPortionPrice : fullUnitPrice / portionsPerUnit)
    : 0;
  const configuredFullUnitPrice = selectedOptions.reduce((price, option) => {
    const override = Number(option?.price_override ?? option?.priceOverride);
    if (
      String(option?.price_mode ?? option?.priceMode ?? '').toLowerCase() === 'override'
      && Number.isFinite(override)
    ) {
      return Math.max(0, override);
    }
    const delta = Number(option?.price_delta ?? option?.priceDelta ?? 0);
    return price + (Number.isFinite(delta) ? delta : 0);
  }, explicitPortionPrice > 0 ? explicitPortionPrice * portionsPerUnit : fullUnitPrice);
  const portionUnitPrice = portionsPerUnit > 0
    ? configuredFullUnitPrice / portionsPerUnit
    : basePortionUnitPrice;

  useEffect(() => {
    if (open) {
      setSaleMode('portion');
      setSaleQuantity(1);
      setIsSubmitting(false);
    }
  }, [open, item?.id]);

  const quantityInStockUnits = useMemo(() => {
    if (saleMode === 'portion') {
      return portionsPerUnit > 0 ? saleQuantity / portionsPerUnit : 0;
    }
    return saleQuantity;
  }, [portionsPerUnit, saleMode, saleQuantity]);

  const selectedQuantityDisplay = useMemo(() => {
    return saleMode === 'portion'
      ? formatQuantityWithUnit(saleQuantity, portionLabel, {
          preferWholeNumbers: true,
          maximumFractionDigits: 0,
        })
      : formatQuantityWithUnit(saleQuantity, fullUnitLabel, {
          preferWholeNumbers: true,
          maximumFractionDigits: 0,
        });
  }, [fullUnitLabel, portionLabel, saleMode, saleQuantity]);

  const stockEquivalentDisplay = useMemo(() => {
    if (saleMode === 'full_unit') {
      return formatQuantityWithUnit(saleQuantity, fullUnitLabel, {
        preferWholeNumbers: true,
        maximumFractionDigits: 0,
      });
    }

    const portionDisplay = getPortionQuantityDisplay({
      quantity: quantityInStockUnits,
      unitLabel: fullUnitLabel,
      portionName: portionLabel,
      portionsPerUnit,
    });

    return portionDisplay?.summaryText || formatQuantityWithUnit(quantityInStockUnits, fullUnitLabel, {
      maximumFractionDigits: 3,
    });
  }, [fullUnitLabel, portionLabel, portionsPerUnit, quantityInStockUnits, saleMode, saleQuantity]);

  const previewPrice = saleMode === 'portion'
    ? saleQuantity * portionUnitPrice
    : saleQuantity * fullUnitPrice;

  const handleQuantityChange = (nextQuantity: unknown) => {
    setSaleQuantity(toPositiveInteger(nextQuantity, 1));
  };

  const handleConfirm = async () => {
    if (!item || !canSellInPortions(item) || saleQuantity <= 0 || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (saleMode === 'portion') {
        const perFullUnitPrice = portionUnitPrice * portionsPerUnit;
        const added = await onAddToCart(
          item,
          roundCartQuantity(quantityInStockUnits),
          Number(perFullUnitPrice.toFixed(2)),
          selectedOptions
        );
        if (added === false) {
          return;
        }
      } else {
        const fullUnitItem: InventoryItem = {
          ...item,
          isSoldInPortions: false,
          portionName: undefined,
          portionsPerUnit: undefined,
          portionPrice: undefined,
          portion_price: undefined,
        };
        const added = await onAddToCart(fullUnitItem, saleQuantity, configuredFullUnitPrice, selectedOptions);
        if (added === false) {
          return;
        }
      }

      onOpenChange(false);
    } catch (error) {
      console.error('[POS] Failed to add portion sale to cart:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (isSubmitting) {
      return;
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sell Product</DialogTitle>
          <DialogDescription>
            Add this item as individual portions or as complete full units.
          </DialogDescription>
        </DialogHeader>

        {item ? (
          <div className="space-y-4 py-2">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-lg font-semibold leading-tight">{item.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatQuantityWithUnit(portionsPerUnit, portionLabel, {
                  preferWholeNumbers: true,
                  maximumFractionDigits: 0,
                })} per {fullUnitLabel}
              </p>
              {selectedOptions.length > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Choices: {selectedOptions.map((option) => String(option.name || '')).filter(Boolean).join(', ')}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={saleMode === 'portion' ? 'default' : 'outline'}
                onClick={() => {
                  setSaleMode('portion');
                  setSaleQuantity(1);
                }}
              >
                Sell by {portionLabel}
              </Button>
              <Button
                type="button"
                variant={saleMode === 'full_unit' ? 'default' : 'outline'}
                onClick={() => {
                  setSaleMode('full_unit');
                  setSaleQuantity(1);
                }}
              >
                Sell full {fullUnitLabel}
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="portion-sale-quantity">
                {saleMode === 'portion'
                  ? `Number of ${portionLabel}`
                  : `Number of ${fullUnitLabel}`}
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setSaleQuantity((current) => Math.max(1, current - 1))}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  id="portion-sale-quantity"
                  type="number"
                  min="1"
                  step="1"
                  value={saleQuantity}
                  onChange={(event) => handleQuantityChange(event.target.value)}
                  className="text-center text-lg font-semibold"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setSaleQuantity((current) => current + 1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="flex justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Selected</span>
                <span className="text-right font-semibold">{selectedQuantityDisplay}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Stock used</span>
                <span className="text-right font-semibold">{stockEquivalentDisplay}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm font-semibold">
                <span>Line total</span>
                <span className="text-right">{formatCurrency(previewPrice)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {saleMode === 'portion'
                  ? `Using ${formatCurrency(portionUnitPrice)} per ${portionLabel}.`
                  : `Using ${formatCurrency(configuredFullUnitPrice)} per ${fullUnitLabel}.`}
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!item || isSubmitting || previewPrice <= 0}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Add to Cart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
