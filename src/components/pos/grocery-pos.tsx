
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Apple } from 'lucide-react';
import { useForm } from 'react-hook-form';

import { GenericPos, type PosProps } from './generic-pos';
import type { InventoryItem } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const VariablePriceDialog = ({
  item,
  isOpen,
  onClose,
  onConfirm,
}: {
  item: InventoryItem;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (item: InventoryItem, totalPrice: number, quantity: number) => void;
}) => {
  const [inputMode, setInputMode] = useState<'price' | 'quantity'>('price');
  const unitPrice = Number(item.price || 0);
  const { register, handleSubmit, reset, watch } = useForm<{ price?: number; quantity?: number }>();
  const { format: formatCurrency } = useCurrency();
  const enteredPrice = Number(watch('price') || 0);
  const enteredQuantity = Number(watch('quantity') || 0);

  useEffect(() => {
    if (isOpen) {
      setInputMode('price');
      reset({ price: undefined, quantity: undefined });
    }
  }, [isOpen, reset]);

  const calculatedQuantity = useMemo(() => {
    if (unitPrice <= 0 || enteredPrice <= 0) return 0;
    return enteredPrice / unitPrice;
  }, [enteredPrice, unitPrice]);

  const calculatedTotalPrice = useMemo(() => {
    if (unitPrice <= 0 || enteredQuantity <= 0) return 0;
    return enteredQuantity * unitPrice;
  }, [enteredQuantity, unitPrice]);

  const onSubmit = (data: { price?: number; quantity?: number }) => {
    if (unitPrice <= 0) return;

    const rawPrice = Number(data.price || 0);
    const rawQuantity = Number(data.quantity || 0);

    const finalTotalPrice = inputMode === 'price' ? rawPrice : rawQuantity * unitPrice;
    const finalQuantity = inputMode === 'price' ? (rawPrice / unitPrice) : rawQuantity;

    if (!Number.isFinite(finalTotalPrice) || finalTotalPrice <= 0) return;
    if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) return;

    onConfirm(item, Number(finalTotalPrice.toFixed(2)), Number(finalQuantity.toFixed(3)));
    reset();
    onClose();
  };

  const canSubmit =
    unitPrice > 0 &&
    (inputMode === 'price' ? enteredPrice > 0 : enteredQuantity > 0);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enter Price for {item.name}</DialogTitle>
          <DialogDescription>
            This item is sold by weight/volume. By default enter total cash, or switch to quantity entry.
            (Price per {item.unitType}: {formatCurrency(item.price || 0)})
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={inputMode === 'price' ? 'default' : 'outline'}
                onClick={() => setInputMode('price')}
              >
                Enter Total Cash
              </Button>
              <Button
                type="button"
                variant={inputMode === 'quantity' ? 'default' : 'outline'}
                onClick={() => setInputMode('quantity')}
              >
                Enter Quantity
              </Button>
            </div>

            {inputMode === 'price' ? (
              <div className="grid gap-2">
                <Label htmlFor="price">Total Price</Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  placeholder="Enter total cash amount"
                  {...register('price', { valueAsNumber: true, min: 0.01 })}
                  autoFocus
                />
                <p className="text-lg font-semibold text-foreground">
                  Calculated quantity: {calculatedQuantity > 0 ? `${calculatedQuantity.toFixed(3)} ${item.unitType}` : '—'}
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="quantity">Quantity ({item.unitType})</Label>
                <Input
                  id="quantity"
                  type="number"
                  step="0.001"
                  placeholder={`Enter quantity in ${item.unitType}`}
                  {...register('quantity', { valueAsNumber: true, min: 0.001 })}
                  autoFocus
                />
                <p className="text-lg font-semibold text-foreground">
                  Calculated total cash: {calculatedTotalPrice > 0 ? formatCurrency(calculatedTotalPrice) : '—'}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              Add to Cart
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const GroceryPos = (props: PosProps) => {
  const [variablePriceItem, setVariablePriceItem] = useState<InventoryItem | null>(null);

  const customOnAddToCart = (item: InventoryItem) => {
    if (item.isVariablePrice) {
      setVariablePriceItem(item);
    } else {
      props.onAddToCart(item);
    }
  };

  const handleConfirmVariablePrice = (item: InventoryItem, totalPrice: number, quantity: number) => {
    if (!item.price || item.price <= 0 || totalPrice <= 0 || quantity <= 0) {
      console.error('Invalid variable-price sale inputs.');
      return;
    }
    props.onAddToCart(item, quantity, totalPrice);
    setVariablePriceItem(null);
  };

  return (
    <>
      <GenericPos
        {...props}
        onAddToCart={customOnAddToCart}
        productIcon={<Apple className="h-8 w-8 text-muted-foreground" data-ai-hint="grocery produce" />}
      />
      {variablePriceItem && (
        <VariablePriceDialog
          isOpen={!!variablePriceItem}
          item={variablePriceItem}
          onClose={() => setVariablePriceItem(null)}
          onConfirm={handleConfirmVariablePrice}
        />
      )}
    </>
  );
};

    
