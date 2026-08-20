'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import type { Order } from '@/lib/db';


interface CreditNoteModalProps {
  order: Order | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreditNoteCreated?: () => void;
}

export function CreditNoteModal({
  order,
  isOpen,
  onOpenChange,
  onCreditNoteCreated,
}: CreditNoteModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { register, handleSubmit, formState: { errors }, reset, watch } = useForm({
    defaultValues: {
      reason: 'refund',
      description: '',
      credit_amount: '',
      vat_amount: '',
    },
  });

  const creditAmount = parseFloat(watch('credit_amount') || '0');
  const vatAmount = parseFloat(watch('vat_amount') || '0');
  const totalCredit = creditAmount + vatAmount;

  const onSubmit = async (data: any) => {
    if (!order) return;

    setIsLoading(true);
    try {
      const response = await authFetch.fetch('/sessions/credit-notes/create_credit_note/', {
        method: 'POST',
        body: JSON.stringify({
          original_order_id: order.id,
          reason: data.reason,
          description: data.description,
          credit_amount: parseFloat(data.credit_amount),
          vat_amount: parseFloat(data.vat_amount),
        }),
      });

      if (response) {
        toast({
          title: 'Credit Note Created',
          description: `Credit Note ${response.credit_note_number} has been created successfully.`,
        });
        reset();
        onOpenChange(false);
        onCreditNoteCreated?.();
      }
    } catch (error) {
      console.error('Error creating credit note:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create credit note. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!order) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Credit Note</DialogTitle>
          <DialogDescription>
            Issue a credit note for Order #{order.orderNumber}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Original Order Info */}
          <div className="bg-muted p-3 rounded-lg space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order #:</span>
              <span className="font-semibold">#{order.orderNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Original Amount:</span>
              <span className="font-semibold">{order.total}</span>
            </div>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason for Credit Note</Label>
            <Select defaultValue="refund" {...register('reason')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="return">Sales Return</SelectItem>
                <SelectItem value="refund">Customer Refund</SelectItem>
                <SelectItem value="discount">Discount Adjustment</SelectItem>
                <SelectItem value="error">Invoice Error Correction</SelectItem>
              </SelectContent>
            </Select>
            {errors.reason && (
              <p className="text-sm text-red-500">{errors.reason.message}</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Explain the reason for this credit note..."
              {...register('description', { required: 'Description is required' })}
              className="min-h-24"
            />
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description.message}</p>
            )}
          </div>

          {/* Credit Amount */}
          <div className="space-y-2">
            <Label htmlFor="credit_amount">Credit Amount (before VAT)</Label>
            <Input
              id="credit_amount"
              type="number"
              step="0.01"
              placeholder="0.00"
              {...register('credit_amount', {
                required: 'Credit amount is required',
                min: { value: 0.01, message: 'Must be greater than 0' },
              })}
            />
            {errors.credit_amount && (
              <p className="text-sm text-red-500">{errors.credit_amount.message}</p>
            )}
          </div>

          {/* VAT Amount */}
          <div className="space-y-2">
            <Label htmlFor="vat_amount">VAT Amount</Label>
            <Input
              id="vat_amount"
              type="number"
              step="0.01"
              placeholder="0.00"
              {...register('vat_amount', {
                required: 'VAT amount is required',
                min: { value: 0, message: 'Cannot be negative' },
              })}
            />
            {errors.vat_amount && (
              <p className="text-sm text-red-500">{errors.vat_amount.message}</p>
            )}
          </div>

          {/* Total Credit */}
          <div className="bg-blue-50 p-3 rounded-lg">
            <div className="flex justify-between font-semibold">
              <span>Total Credit:</span>
              <span>{totalCredit.toFixed(2)}</span>
            </div>
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
            <Button type="submit" disabled={isLoading} className="flex-1">
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Credit Note
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
