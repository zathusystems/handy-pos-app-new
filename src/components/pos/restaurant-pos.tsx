'use client';

import { useState } from 'react';
import { Utensils } from 'lucide-react';
import { GenericPos, type PosProps } from './generic-pos';
import type { InventoryItem } from '@/lib/db';
import { PortionSaleDialog, canSellInPortions } from './portion-sale-dialog';

export const RestaurantPos = (props: PosProps) => {
  const [selectedPortionItem, setSelectedPortionItem] = useState<InventoryItem | null>(null);

  const handleAddToCart = (item: InventoryItem) => {
    if (canSellInPortions(item)) {
      setSelectedPortionItem(item);
      return;
    }

    props.onAddToCart(item);
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
        item={selectedPortionItem}
        open={!!selectedPortionItem}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPortionItem(null);
          }
        }}
        onAddToCart={props.onAddToCart}
      />
    </>
  );
};
