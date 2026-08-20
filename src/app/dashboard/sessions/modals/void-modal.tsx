'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import { logAuditAction } from '@/lib/audit';
import { useAuth } from '@/hooks/use-auth';
import type { Order } from '@/lib/db';


interface VoidModalProps {
  order: Order | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  canVoid?: boolean;
  onVoidCreated?: (updatedOrder: Order) => void;
}

export function VoidModal({
  order,
  isOpen,
  onOpenChange,
  canVoid = true,
  onVoidCreated,
}: VoidModalProps) {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const { register, handleSubmit, formState: { errors }, reset, watch } = useForm({
    defaultValues: {
      void_reason: 'customer_request',
      reason_description: '',
      refund_method: 'none',
      refund_amount: '0',
    },
  });

  const refundMethod = watch('refund_method');
  const refundAmount = parseFloat(watch('refund_amount') || '0');

  React.useEffect(() => {
    if (!isOpen) {
      setIsLoading(false);
    }
  }, [isOpen]);

  const onSubmit = async (data: any) => {
    if (!order) return;
    if (!canVoid) {
      toast({
        variant: 'destructive',
        title: 'Permission Denied',
        description: 'Only admin users can void sales.',
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await authFetch.fetch<any>('/sessions/void-transactions/create_void/', {
        method: 'POST',
        body: JSON.stringify({
          original_order_id: order.id,
          void_reason: data.void_reason,
          reason_description: data.reason_description,
          voided_amount: order.total - (order.vat_amount || 0),
          voided_vat: order.vat_amount || 0,
          refund_method: data.refund_method,
          refund_amount: parseFloat(data.refund_amount),
        }),
      });

      if (response) {
        toast({
          title: 'Sale Voided',
          description: `Order #${order.orderNumber} has been voided successfully.`,
        });

        reset();
        setIsLoading(false);
        onOpenChange(false);

        if (response.order) {
          onVoidCreated?.(response.order);
        } else {
          onVoidCreated?.(order);
        }

        try {
          await logAuditAction({
            userId: user?.uid || 'unknown',
            userName: user?.displayName || user?.email || 'System',
            branchId: order.branchId,
            actionType: 'ORDER_VOID',
            entityType: 'Order',
            entityId: order.id,
            details: {
              orderNumber: order.orderNumber,
              void_reason: data.void_reason,
              refund_method: data.refund_method,
              refund_amount: parseFloat(data.refund_amount),
            },
          });
        } catch (auditError) {
          console.warn('Failed to log void audit action:', auditError);
        }

        void (async () => {
          try {
            const branchId =
              order.branchId ||
              localStorage.getItem('handypos-active-branch') ||
              'main';
            const { syncService } = await import('@/lib/services/sync-service');
            await syncService.fetchAllInventoryFromBackend(String(branchId));
            console.log('[Void] Refreshed inventory after void');
          } catch (syncError) {
            console.warn('[Void] Failed to refresh inventory after void:', syncError);
          }
        })();

        return;
      }
    } catch (error) {
      console.error('Error voiding sale:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to void sale. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!order) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            Void Sale
          </DialogTitle>
          <DialogDescription>
            Cancel Order #{order.orderNumber} and create a void transaction record for MRA compliance.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Warning */}
          <div className="bg-red-50 border border-red-200 p-3 rounded-lg">
            <p className="text-sm text-red-800">
              <strong>Warning:</strong> This action will void the entire sale. The original invoice will be marked as voided in your records for MRA compliance.
            </p>
          </div>

          {/* Original Order Info */}
          <div className="bg-muted p-3 rounded-lg space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order #:</span>
              <span className="font-semibold">#{order.orderNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount:</span>
              <span className="font-semibold">{order.total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Payment Method:</span>
              <span className="font-semibold">{order.paymentMethod}</span>
            </div>
          </div>

          {/* Void Reason */}
          <div className="space-y-2">
            <Label htmlFor="void_reason">Reason for Void</Label>
            <Select defaultValue="customer_request" {...register('void_reason')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="customer_request">Customer Request</SelectItem>
                <SelectItem value="item_returned">Item Returned</SelectItem>
                <SelectItem value="wrong_order">Wrong Order</SelectItem>
                <SelectItem value="system_error">System Error</SelectItem>
                <SelectItem value="duplicate">Duplicate Entry</SelectItem>
                <SelectItem value="payment_failed">Payment Failed</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Detailed Description */}
          <div className="space-y-2">
            <Label htmlFor="reason_description">Detailed Description</Label>
            <Textarea
              id="reason_description"
              placeholder="Provide detailed explanation for audit trail..."
              {...register('reason_description', { required: 'Description is required' })}
              className="min-h-20"
            />
            {errors.reason_description && (
              <p className="text-sm text-red-500">{errors.reason_description.message}</p>
            )}
          </div>

          {/* Refund Method */}
          <div className="space-y-2">
            <Label htmlFor="refund_method">Refund Method</Label>
            <Select defaultValue="none" {...register('refund_method')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Refund</SelectItem>
                <SelectItem value="cash">Cash Refund</SelectItem>
                <SelectItem value="card">Card Refund</SelectItem>
                <SelectItem value="credit">Store Credit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Refund Amount (if applicable) */}
          {refundMethod !== 'none' && (
            <div className="space-y-2">
              <Label htmlFor="refund_amount">Refund Amount</Label>
              <Input
                id="refund_amount"
                type="number"
                step="0.01"
                placeholder="0.00"
                {...register('refund_amount', {
                  required: 'Refund amount is required',
                  min: { value: 0, message: 'Cannot be negative' },
                })}
              />
              {errors.refund_amount && (
                <p className="text-sm text-red-500">{errors.refund_amount.message}</p>
              )}
            </div>
          )}

          {/* Summary */}
          <div className="bg-orange-50 p-3 rounded-lg space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount Voided:</span>
              <span className="font-semibold">{order.total}</span>
            </div>
            {refundMethod !== 'none' && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Refund Amount:</span>
                <span className="font-semibold text-orange-600">{refundAmount.toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !canVoid}
              variant="destructive"
              className="flex-1"
            >
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void Sale
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
