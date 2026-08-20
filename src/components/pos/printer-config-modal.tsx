'use client';

import React from 'react';
import { Printer } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PrinterConfigScreen } from '@/app/dashboard/settings/printers/printer-config-screen';

interface PrinterConfigModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PrinterConfigModal({ isOpen, onOpenChange }: PrinterConfigModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="tauri-android-safe-bottom flex h-[calc(100dvh-1rem)] w-[calc(100vw-0.75rem)] max-w-5xl flex-col overflow-hidden p-0 sm:h-auto sm:max-h-[90dvh] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-10 sm:px-6 sm:py-4">
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            Printer Configuration
          </DialogTitle>
          <DialogDescription>
            Configure printers directly from POS without leaving this screen.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
          <PrinterConfigScreen />
        </div>
      </DialogContent>
    </Dialog>
  );
}
