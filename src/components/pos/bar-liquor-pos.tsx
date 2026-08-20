'use client';

import { GlassWater } from 'lucide-react';
import { GenericPos, type PosProps } from './generic-pos';
import { useState } from 'react';
import type { InventoryItem } from '@/lib/db';
import { PortionSaleDialog, canSellInPortions } from './portion-sale-dialog';

export const BarLiquorPos = (props: PosProps) => {
    const [selectedPortionItem, setSelectedPortionItem] = useState<InventoryItem | null>(null);

    const handleAddToCart = (item: InventoryItem) => {
        if (canSellInPortions(item)) {
            setSelectedPortionItem(item);
        } else {
            props.onAddToCart(item);
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
}
