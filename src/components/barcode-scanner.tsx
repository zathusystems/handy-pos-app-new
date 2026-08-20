'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Barcode, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';

interface BarcodeScannerProps {
  onBarcodeScanned: (barcode: string) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export const BarcodeScanner: React.FC<BarcodeScannerProps> = ({
  onBarcodeScanned,
  isOpen,
  onOpenChange,
}) => {
  const [manualInput, setManualInput] = useState('');
  const [scannedBarcode, setScannedBarcode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setManualInput('');
      setScannedBarcode('');
      return;
    }

    // Focus input when dialog opens
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, [isOpen]);

  // Separate effect for keyboard listener - ONLY active when dialog is open
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // Handle barcode scanner input ONLY when dialog is open
    // Most barcode scanners work by simulating keyboard input
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if the scanner input is focused
      if (document.activeElement !== inputRef.current) {
        return;
      }

      // Enter key completes the scan
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (manualInput.trim()) {
          handleScan(manualInput.trim());
        }
      }
    };

    // Use capture phase to intercept events early
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, manualInput]);

  const handleScan = (barcode: string) => {
    if (!barcode.trim()) {
      toast({
        variant: 'destructive',
        title: 'Invalid Barcode',
        description: 'Please scan or enter a valid barcode.',
      });
      return;
    }

    setScannedBarcode(barcode);
    setManualInput('');
    
    // Call the callback
    onBarcodeScanned(barcode);
    
    // Show success message
    toast({
      title: 'Barcode Scanned',
      description: `Barcode: ${barcode}`,
    });

    // Don't auto-close - let user close manually to prevent form submission
    // setTimeout(() => {
    //   onOpenChange(false);
    // }, 500);
  };

  const handleManualSubmit = () => {
    if (manualInput.trim()) {
      handleScan(manualInput.trim());
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Barcode className="h-5 w-5" />
            Scan Barcode
          </DialogTitle>
          <DialogDescription>
            Use your barcode scanner or enter the barcode manually below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Scanner Input - Hidden but receives scanner input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Barcode Input</label>
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="text"
                placeholder="Scan barcode or type manually..."
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleManualSubmit();
                  }
                }}
                autoFocus
                className="font-mono"
              />
              <Button
                onClick={handleManualSubmit}
                disabled={!manualInput.trim()}
                className="px-4"
              >
                Submit
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter or click Submit after scanning/typing
            </p>
          </div>

          {/* Last Scanned Barcode Display */}
          {scannedBarcode && (
            <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-3 border border-green-200 dark:border-green-800">
              <p className="text-sm font-medium text-green-900 dark:text-green-100">
                Last Scanned:
              </p>
              <p className="text-lg font-mono font-bold text-green-700 dark:text-green-300 mt-1">
                {scannedBarcode}
              </p>
              <Button
                onClick={() => onOpenChange(false)}
                className="mt-3 w-full"
              >
                Close & Continue
              </Button>
            </div>
          )}

          {/* Instructions */}
          <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3 border border-blue-200 dark:border-blue-800">
            <p className="text-sm text-blue-900 dark:text-blue-100">
              <strong>How to use:</strong>
            </p>
            <ul className="text-xs text-blue-800 dark:text-blue-200 mt-2 space-y-1 list-disc list-inside">
              <li>Point your barcode scanner at the barcode</li>
              <li>Or manually type the barcode number</li>
              <li>Press Enter or click Submit</li>
              <li>The barcode will be automatically filled in the form</li>
              <li>Click "Close & Continue" to return to the form</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
