'use client';

import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Utensils } from 'lucide-react';
import { db, type InventoryItem } from '@/lib/db';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useCurrency } from '@/hooks/use-currency';

const MenuItemCard = ({
  item,
  formatCurrency,
}: {
  item: InventoryItem;
  formatCurrency: (value: number) => string;
}) => {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start gap-4 p-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-muted">
                <Utensils className="h-8 w-8 text-muted-foreground" data-ai-hint="restaurant food" />
            </div>
            <div className="flex-1">
                <h3 className="text-lg font-semibold">{item.name}</h3>
                <p className="text-sm text-muted-foreground">{item.category}</p>
            </div>
            <Badge variant="secondary" className="text-base">
                {formatCurrency(Number(item.price || 0))}
            </Badge>
        </div>
      </CardContent>
    </Card>
  );
};


export default function PublicMenuPage() {
    const { format: formatCurrency } = useCurrency();
    const menuItems = useLiveQuery(
        () => db.inventory.where({ itemType: 'sellable', onMenu: true }).toArray(),
        []
    ) || [];

    const categories = [...new Set(menuItems.map(item => item.category))];

    if (menuItems.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/30 py-24 text-center">
                <Utensils className="h-16 w-16 text-muted-foreground/30" />
                <h2 className="mt-6 text-xl font-semibold">The menu is currently empty.</h2>
                <p className="mt-2 text-muted-foreground">The restaurant owner is updating the menu. Please check back soon!</p>
            </div>
        )
    }

  return (
    <div className="flex flex-col gap-8">
        {categories.map(category => (
            <div key={category}>
                <h2 className="text-2xl font-bold tracking-tight">{category}</h2>
                <Separator className="my-4" />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {menuItems.filter(item => item.category === category).map(item => (
                        <MenuItemCard key={item.id} item={item} formatCurrency={formatCurrency} />
                    ))}
                </div>
            </div>
        ))}
    </div>
  );
}
