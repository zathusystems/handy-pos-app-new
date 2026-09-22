'use client';

import { GlassWater } from 'lucide-react';
import { GenericPos, type PosAddToCartHandler, type PosCartAddOptions, type PosProps } from './generic-pos';
import { useState } from 'react';
import type { InventoryItem } from '@/lib/db';
import { PortionSaleDialog, canSellInPortions } from './portion-sale-dialog';

export const BarLiquorPos = (props: PosProps) => {
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
        } else {
            return props.onAddToCart(item, quantity, price, notes, takeOrderId, options);
        }
    };

    return (
        <>
            <GenericPos
                {...props}
                businessType="Bar & Liquor"
                productIcon={<GlassWater className="h-8 w-8 text-muted-foreground" data-ai-hint="bar liquor bottle" />}
                onAddToCart={handleAddToCart}
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
}
