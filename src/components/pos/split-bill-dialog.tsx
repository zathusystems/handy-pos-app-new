'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Printer, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TakeOrder, TakeOrderItem } from '@/lib/db';

type SplitBillShareDraft = {
  id: string;
  label: string;
};

export type SplitBillShare = {
  id: string;
  label: string;
  position: number;
  totalShares: number;
  items: TakeOrderItem[];
  total: number;
};

type SplitBillDialogProps = {
  order: TakeOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrint: (share: SplitBillShare) => Promise<boolean>;
  formatCurrency: (amount: number) => string;
  isPrinting?: boolean;
};

const QUANTITY_EPSILON = 0.001;

const createShareId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `bill-share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const toQuantity = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 1000) / 1000;
};

const toMoney = (value: number): number => Math.round(value * 100) / 100;

const buildInitialShares = (): SplitBillShareDraft[] => [
  { id: createShareId(), label: 'Customer 1' },
  { id: createShareId(), label: 'Customer 2' },
];

export function SplitBillDialog({
  order,
  open,
  onOpenChange,
  onPrint,
  formatCurrency,
  isPrinting = false,
}: SplitBillDialogProps) {
  const [shares, setShares] = useState<SplitBillShareDraft[]>([]);
  const [quantities, setQuantities] = useState<Record<string, Record<string, number>>>({});
  const [printingShareId, setPrintingShareId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !order) return;

    const initialShares = buildInitialShares();
    const initialQuantities: Record<string, Record<string, number>> = {};
    for (const item of order.items) {
      initialQuantities[item.id] = {
        [initialShares[0].id]: toQuantity(item.quantity),
        [initialShares[1].id]: 0,
      };
    }
    setShares(initialShares);
    setQuantities(initialQuantities);
    setPrintingShareId(null);
  }, [open, order?.id]);

  const allocationByItem = useMemo(() => (order?.items || []).map((item) => {
    const orderedQuantity = toQuantity(item.quantity);
    const allocatedQuantity = shares.reduce(
      (total, share) => total + toQuantity(quantities[item.id]?.[share.id]),
      0
    );
    const remainingQuantity = Math.round((orderedQuantity - allocatedQuantity) * 1000) / 1000;
    return {
      item,
      orderedQuantity,
      allocatedQuantity,
      remainingQuantity,
      isValid: Math.abs(remainingQuantity) < QUANTITY_EPSILON,
    };
  }), [order?.items, quantities, shares]);

  const splitShares = useMemo<SplitBillShare[]>(() => shares.map((share, index) => {
    const items = (order?.items || []).flatMap((item) => {
      const quantity = toQuantity(quantities[item.id]?.[share.id]);
      return quantity > 0 ? [{ ...item, quantity }] : [];
    });
    const total = toMoney(items.reduce(
      (sum, item) => sum + (toQuantity(item.quantity) * Number(item.price || 0)),
      0
    ));
    return {
      id: share.id,
      label: share.label.trim() || `Customer ${index + 1}`,
      position: index + 1,
      totalShares: shares.length,
      items,
      total,
    };
  }), [order?.items, quantities, shares]);

  const isFullyAllocated = allocationByItem.every((line) => line.isValid);
  const canPrint = isFullyAllocated && splitShares.every((share) => share.items.length > 0);

  const updateShareLabel = (shareId: string, label: string) => {
    setShares((current) => current.map((share) => (
      share.id === shareId ? { ...share, label } : share
    )));
  };

  const updateQuantity = (itemId: string, shareId: string, value: string) => {
    setQuantities((current) => ({
      ...current,
      [itemId]: {
        ...(current[itemId] || {}),
        [shareId]: toQuantity(value),
      },
    }));
  };

  const addShare = () => {
    const nextShare: SplitBillShareDraft = {
      id: createShareId(),
      label: `Customer ${shares.length + 1}`,
    };
    setShares((current) => [...current, nextShare]);
    setQuantities((current) => {
      const next = { ...current };
      for (const item of order?.items || []) {
        next[item.id] = { ...(next[item.id] || {}), [nextShare.id]: 0 };
      }
      return next;
    });
  };

  const removeShare = (shareId: string) => {
    if (shares.length <= 2) return;
    const remainingShares = shares.filter((share) => share.id !== shareId);
    const recipientId = remainingShares[0]?.id;
    if (!recipientId) return;

    setShares(remainingShares);
    setQuantities((current) => {
      const next: Record<string, Record<string, number>> = {};
      for (const item of order?.items || []) {
        const currentItemQuantities = current[item.id] || {};
        const removedQuantity = toQuantity(currentItemQuantities[shareId]);
        const { [shareId]: _removed, ...withoutRemoved } = currentItemQuantities;
        next[item.id] = {
          ...withoutRemoved,
          [recipientId]: toQuantity(withoutRemoved[recipientId]) + removedQuantity,
        };
      }
      return next;
    });
  };

  const splitEqually = () => {
    if (shares.length === 0) return;
    setQuantities(() => {
      const next: Record<string, Record<string, number>> = {};
      for (const item of order?.items || []) {
        const total = toQuantity(item.quantity);
        const equalQuantity = Math.floor((total / shares.length) * 1000) / 1000;
        const remainder = Math.round((total - (equalQuantity * shares.length)) * 1000) / 1000;
        next[item.id] = shares.reduce<Record<string, number>>((allocations, share, index) => {
          allocations[share.id] = index === 0
            ? toQuantity(equalQuantity + remainder)
            : equalQuantity;
          return allocations;
        }, {});
      }
      return next;
    });
  };

  const printShare = async (share: SplitBillShare) => {
    if (!canPrint || isPrinting || printingShareId) return;
    setPrintingShareId(share.id);
    try {
      await onPrint(share);
    } finally {
      setPrintingShareId(null);
    }
  };

  const printAll = async () => {
    if (!canPrint || isPrinting || printingShareId) return;
    setPrintingShareId('all');
    try {
      for (const share of splitShares) {
        const printed = await onPrint(share);
        if (!printed) break;
      }
    } finally {
      setPrintingShareId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="tauri-android-sidebar-safe-top flex max-h-[92dvh] max-w-4xl flex-col overflow-hidden p-0 sm:max-h-[88vh]">
        <DialogHeader className="shrink-0 border-b px-4 pb-3 pt-5 text-left sm:px-6 sm:pt-6">
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Split Order {order?.orderNumber}
          </DialogTitle>
          <DialogDescription>
            Divide item quantities between customers, then print a separate payment-due bill for each one. The kitchen order and stock remain unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Allocate every ordered quantity exactly once. Use decimals only when the item can genuinely be shared by portion.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" onClick={splitEqually} disabled={shares.length < 2}>
                Split Equally
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={addShare}>
                <Plus className="mr-1 h-4 w-4" />
                Add Customer
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {shares.map((share, index) => {
              const currentShare = splitShares.find((candidate) => candidate.id === share.id);
              return (
                <div key={share.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`split-bill-customer-${share.id}`}>Customer {index + 1}</Label>
                    <Input
                      id={`split-bill-customer-${share.id}`}
                      value={share.label}
                      onChange={(event) => updateShareLabel(share.id, event.target.value)}
                      placeholder={`Customer ${index + 1}`}
                    />
                  </div>
                  <Badge variant="secondary" className="h-9 justify-center px-3 text-sm">
                    {formatCurrency(currentShare?.total || 0)}
                  </Badge>
                  {shares.length > 2 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title="Remove customer"
                      aria-label={`Remove ${share.label || `customer ${index + 1}`}`}
                      onClick={() => removeShare(share.id)}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-3">
            {allocationByItem.map(({ item, orderedQuantity, allocatedQuantity, remainingQuantity, isValid }) => (
              <div key={item.id} className="rounded-md border p-3">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Ordered: {orderedQuantity} at {formatCurrency(Number(item.price || 0))} each
                    </p>
                  </div>
                  <Badge variant={isValid ? 'outline' : 'destructive'} className="w-fit">
                    {isValid
                      ? 'Fully allocated'
                      : remainingQuantity > 0
                        ? `${remainingQuantity} not allocated`
                        : `${Math.abs(remainingQuantity)} over allocated`}
                  </Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {shares.map((share, index) => (
                    <div key={share.id} className="space-y-1">
                      <Label htmlFor={`split-bill-${item.id}-${share.id}`} className="text-xs">
                        {share.label.trim() || `Customer ${index + 1}`} quantity
                      </Label>
                      <Input
                        id={`split-bill-${item.id}-${share.id}`}
                        type="number"
                        min="0"
                        step="0.001"
                        value={quantities[item.id]?.[share.id] ?? 0}
                        onChange={(event) => updateQuantity(item.id, share.id, event.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Allocated: {allocatedQuantity} of {orderedQuantity}
                </p>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t bg-background p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className={`text-sm ${canPrint ? 'text-muted-foreground' : 'text-destructive'}`}>
            {canPrint
              ? 'Each customer has a complete bill ready to print.'
              : 'Allocate every item exactly once and make sure each customer has at least one item.'}
          </p>
          <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            {splitShares.map((share) => (
              <Button
                key={share.id}
                type="button"
                variant="outline"
                disabled={!canPrint || isPrinting || Boolean(printingShareId)}
                onClick={() => void printShare(share)}
              >
                <Printer className="mr-2 h-4 w-4" />
                {printingShareId === share.id ? 'Printing...' : `Print ${share.label}`}
              </Button>
            ))}
            <Button
              type="button"
              disabled={!canPrint || isPrinting || Boolean(printingShareId)}
              onClick={() => void printAll()}
            >
              <Printer className="mr-2 h-4 w-4" />
              {printingShareId === 'all' ? 'Printing...' : 'Print All'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
