'use client';

import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, Plus } from 'lucide-react';
import { db, type TakeOrder, type InventoryItem } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { syncService } from '@/lib/services/sync-service';
import { addTakeOrderToSaleCart } from '@/lib/take-order-sale';

interface TakeOrdersPanelProps {
  branchId: string;
  onAddToCart: (item: InventoryItem, quantity: number, price: number, notes?: string, takeOrderId?: string) => void;
}

const normalizeBranchId = (value?: string | number | null): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) return legacyMatch[1];

  return normalized;
};

const TakeOrderCard = ({
  order,
  onAddToCart,
}: {
  order: TakeOrder;
  onAddToCart: (order: TakeOrder) => void;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Handle both camelCase and snake_case field names from backend
  const customerName = (order as any).customer_name || order.customerName;
  const customerPhone = (order as any).customer_phone || order.customerPhone;
  const specialInstructions = (order as any).special_instructions || order.specialInstructions;
  const customerNotes = (order as any).customer_notes || order.customerNotes;
  const createdAt = (order as any).created_at || order.createdAt;

  const createdTime = new Date(createdAt);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - createdTime.getTime()) / 60000);

  return (
    <Card className="overflow-hidden border-l-4 border-l-green-600">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">Order #{order.orderNumber}</CardTitle>
            <p className="text-sm text-muted-foreground">{minutesAgo} min ago</p>
          </div>
          <Badge className="bg-green-100 text-green-800">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Ready
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Customer Info */}
        {(customerName || customerPhone) && (
          <div className="space-y-1 text-sm">
            {customerName && (
              <p>
                <span className="font-semibold">Customer:</span> {customerName}
              </p>
            )}
            {customerPhone && (
              <p>
                <span className="font-semibold">Phone:</span> {customerPhone}
              </p>
            )}
          </div>
        )}

        {/* Items Summary */}
        <div className="space-y-2">
          <p className="font-semibold text-sm">Items ({order.items.length}):</p>
          <div className="space-y-1">
            {order.items.slice(0, isExpanded ? undefined : 2).map((item) => (
              <div key={item.id} className="flex justify-between text-sm">
                <span>{item.name}</span>
                <span className="font-medium">x{item.quantity}</span>
              </div>
            ))}
            {!isExpanded && order.items.length > 2 && (
              <button
                onClick={() => setIsExpanded(true)}
                className="text-xs text-blue-600 hover:underline"
              >
                +{order.items.length - 2} more
              </button>
            )}
            {isExpanded && order.items.length > 2 && (
              <button
                onClick={() => setIsExpanded(false)}
                className="text-xs text-blue-600 hover:underline"
              >
                Show less
              </button>
            )}
          </div>
        </div>

        {/* Special Instructions */}
        {specialInstructions && (
          <>
            <Separator />
            <div className="rounded-lg bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
              <p className="font-semibold text-amber-900 dark:text-amber-200">
                Special Instructions:
              </p>
              <p className="text-amber-800 dark:text-amber-300">
                {specialInstructions}
              </p>
            </div>
          </>
        )}

        {/* Customer Notes */}
        {customerNotes && (
          <div className="rounded-lg bg-blue-50 p-2 text-sm dark:bg-blue-950/30">
            <p className="font-semibold text-blue-900 dark:text-blue-200">Notes:</p>
            <p className="text-blue-800 dark:text-blue-300">{customerNotes}</p>
          </div>
        )}

        <Button
          className="w-full bg-green-600 hover:bg-green-700"
          onClick={() => onAddToCart(order)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Process Sale
        </Button>
      </CardContent>
    </Card>
  );
};

export const TakeOrdersPanel = ({
  branchId,
  onAddToCart,
}: TakeOrdersPanelProps) => {
  const [isOpen, setIsOpen] = useState(false);

  // First, get all take orders to debug
  const allTakeOrders = useLiveQuery(
    () => db.takeOrders.toArray(),
    []
  );

  const readyTakeOrders = useLiveQuery(
    async () => {
      if (!branchId) return [];
      // Get all take orders and filter by branchId and status
      // Using toArray() instead of where() to avoid branchId type mismatch issues
      const allOrders = await db.takeOrders.toArray();
      const normalizedQueryBranchId = normalizeBranchId(branchId);
      console.log('[TakeOrdersPanel Query] All take orders in DB:', allOrders);
      const ordersForBranch = allOrders.filter((order) => {
        const orderBranchId = normalizeBranchId(order.branchId);
        const queryBranchId = normalizedQueryBranchId;
        console.log('[TakeOrdersPanel Query] Comparing branchIds:', { orderBranchId, queryBranchId, match: orderBranchId === queryBranchId });
        return orderBranchId === queryBranchId;
      });
      console.log('[TakeOrdersPanel Query] Orders for branch:', ordersForBranch);
      
      // Ensure all take orders are marked as synced (not dirty) so they display
      // This handles take orders that were created locally but not yet synced
      for (const order of ordersForBranch) {
        if (order._dirty !== false) {
          console.log('[TakeOrdersPanel] Marking take order as synced:', order.id);
          await db.takeOrders.update(order.id, { _dirty: false, _synced_at: new Date().toISOString() });
        }
      }
      
      const ready = ordersForBranch.filter((order) => order.status === 'Ready');
      console.log('[TakeOrdersPanel Query] Filtered ready orders:', ready);
      return ready;
    },
    [branchId]
  );

  // Fetch take orders from backend when component mounts or branchId changes
  useEffect(() => {
    if (branchId) {
      console.log('[TakeOrdersPanel] Fetching take orders from backend for branch:', branchId);
      syncService.fetchAllTakeOrdersFromBackend(branchId);
    }
  }, [branchId]);

  // Debug logging
  useEffect(() => {
    console.log('[TakeOrdersPanel] branchId:', branchId);
    console.log('[TakeOrdersPanel] allTakeOrders count:', allTakeOrders?.length);
    if (allTakeOrders && allTakeOrders.length > 0) {
      console.log('[TakeOrdersPanel] Sample order:', allTakeOrders[0]);
    }
    console.log('[TakeOrdersPanel] readyTakeOrders count:', readyTakeOrders?.length);
    if (readyTakeOrders && readyTakeOrders.length > 0) {
      console.log('[TakeOrdersPanel] Sample ready order:', readyTakeOrders[0]);
    }
  }, [branchId, readyTakeOrders, allTakeOrders]);

  const handleAddToCart = async (order: TakeOrder) => {
    console.log('[TakeOrdersPanel] Adding order to cart:', order);

    const result = await addTakeOrderToSaleCart({
      order,
      branchId,
      onAddToCart,
    });

    if (result.added === 0) {
      console.warn('[TakeOrdersPanel] No order items were added to sale cart:', result);
      return;
    }

    setIsOpen(false);
  };

  console.log('[TakeOrdersPanel] Rendering - ready orders:', readyTakeOrders?.length || 0);

  // Always render the button, even if no ready orders (for testing)
  const orderCount = readyTakeOrders?.length || 0;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="whitespace-nowrap"
        >
          <CheckCircle2 className="mr-2 h-4 w-4 text-green-600" />
          Ready for Sale
          <Badge className="ml-2 bg-green-600 text-white">{orderCount}</Badge>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] flex flex-col max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ready for Sale ({orderCount})</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pr-4">
          {orderCount === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              <p>No ready orders at this time</p>
            </div>
          ) : (
            <div className="space-y-4">
              {readyTakeOrders?.map((order) => (
                <TakeOrderCard
                  key={order.id}
                  order={order}
                  onAddToCart={handleAddToCart}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
