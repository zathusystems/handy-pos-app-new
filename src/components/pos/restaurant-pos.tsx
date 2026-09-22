'use client';

import { useState } from 'react';
import { Utensils } from 'lucide-react';
import { GenericPos, type PosAddToCartHandler, type PosCartAddOptions, type PosProps } from './generic-pos';
import type { InventoryItem } from '@/lib/db';
import { PortionSaleDialog, canSellInPortions } from './portion-sale-dialog';

export const RestaurantPos = (props: PosProps) => {
  const [selectedPortionSale, setSelectedPortionSale] = useState<{
    item: InventoryItem;
    selectedOptions: Array<Record<string, unknown>>;
  } | null>(null);

  const handleAddToCart: PosAddToCartHandler = (item, quantity, price, notes, takeOrderId, options: PosCartAddOptions = {}) => {
    if (canSellInPortions(item)) {
      setSelectedPortionSale({
        item,
        selectedOptions: Array.isArray(options.selectedOptions) ? options.selectedOptions : [],
      });
      return true;
    }

    return props.onAddToCart(item, quantity, price, notes, takeOrderId, options);
  };

  return (
    <>
      <GenericPos
        {...props}
        businessType="Restaurant"
        onAddToCart={handleAddToCart}
        productIcon={<Utensils className="h-8 w-8 text-muted-foreground" data-ai-hint="restaurant food" />}
      />
      <PortionSaleDialog
        item={selectedPortionSale?.item ?? null}
        open={!!selectedPortionSale}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPortionSale(null);
          }
        }}
        selectedOptions={selectedPortionSale?.selectedOptions}
        onAddToCart={(item, quantity, price, selectedOptions) => (
          props.onAddToCart(item, quantity, price, undefined, undefined, { selectedOptions })
        )}
      />
    </>
  );
};
