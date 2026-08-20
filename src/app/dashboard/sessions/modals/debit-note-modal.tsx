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
import { toast } from '@/hooks/use-toast';
import { authFetch } from '@/lib/auth-fetch';
import type { Order } from '@/lib/db';


interface DebitNoteModalProps {
  order: Order | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onDebitNoteCreated?: () => void;
}

export function DebitNoteModal({
  order,
  isOpen,
  onOpenChange,
  onDebitNoteCreated,
}: DebitNoteModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { register, handleSubmit, formState: { errors }, reset, watch } = useForm({
    defaultValues: {
      description: '',
      additional_amount: '',
      vat_amount: '',
    },
  });

  const additionalAmount = parseFloat(watch('additional_amount') || '0');
  const vatAmount = parseFloat(watch('vat_amount') || '0');
  const totalDebit = additionalAmount + vatAmount;

  const onSubmit = async (data: any) => {
    if (!order) return;

    setIsLoading(true);
    try {
      const response = await authFetch.fetch('/sessions/debit-notes/create_debit_note/', {
        method: 'POST',
        body: JSON.stringify({
          original_order_id: order.id,
          description: data.description,
          additional_amount: parseFloat(data.additional_amount),
          vat_amount: parseFloat(data.vat_amount),
        }),
      });

      if (response) {
        toast({
          title: 'Debit Note Created',
          description: `Debit Note ${response.debit_note_number} has been created successfully.`,
        });
        reset();
        onOpenChange(false);
        onDebitNoteCreated?.();
      }
    } catch (error) {
      console.error('Error creating debit note:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create debit note. Please try again.',
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
          <DialogTitle>Create Debit Note</DialogTitle>
          <DialogDescription>
            Issue a debit note for additional charges on Order #{order.orderNumber}
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

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Explain what additional charges are being added..."
              {...register('description', { required: 'Description is required' })}
              className="min-h-24"
            />
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description.message}</p>
            )}
          </div>

          {/* Additional Amount */}
          <div className="space-y-2">
            <Label htmlFor="additional_amount">Additional Amount (before VAT)</Label>
            <Input
              id="additional_amount"
              type="number"
              step="0.01"
              placeholder="0.00"
              {...register('additional_amount', {
                required: 'Additional amount is required',
                min: { value: 0.01, message: 'Must be greater than 0' },
              })}
            />
            {errors.additional_amount && (
              <p className="text-sm text-red-500">{errors.additional_amount.message}</p>
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

          {/* Total Debit */}
          <div className="bg-orange-50 p-3 rounded-lg">
            <div className="flex justify-between font-semibold">
              <span>Total Additional Charge:</span>
              <span>{totalDebit.toFixed(2)}</span>
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
              Create Debit Note
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
