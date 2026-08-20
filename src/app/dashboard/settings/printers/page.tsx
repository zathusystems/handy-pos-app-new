'use client';

import { Printer } from 'lucide-react';
import { PrinterConfigScreen } from './printer-config-screen';

export default function PrintersPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Printer className="h-5 w-5" />
          Printer Configuration
        </h2>
        <p className="text-sm text-muted-foreground">
          Configure printers directly from POS without leaving this screen.
        </p>
      </div>

      <PrinterConfigScreen />
    </div>
  );
}
