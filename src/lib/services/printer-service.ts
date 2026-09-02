'use client';

import { db } from '@/lib/db';

export const PRINTER_CONFIG_UPDATED_EVENT = 'handypos:printer-config-updated';

export const DEFAULT_RECEIPT_FONT_WEIGHT = 500;
export const DEFAULT_RECEIPT_LINE_HEIGHT = 1.22;
export const DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT = 400;
export const DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X = 1.28;
export const DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X = 1;
export const DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT = 500;
export const DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X = 1;
export const RECEIPT_FONT_WEIGHT_OPTIONS = [400, 500, 600, 700] as const;
export type ReceiptFontWeight = typeof RECEIPT_FONT_WEIGHT_OPTIONS[number];

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

export const getDefaultReceiptFontSize = (paperWidth: '80mm' | '58mm' = '80mm'): number => (
  paperWidth === '58mm' ? 11 : 13
);

export const getDefaultReceiptPaddingX = (paperWidth: '80mm' | '58mm' = '80mm'): number => (
  paperWidth === '58mm' ? 14 : 16
);

export const getDefaultReceiptBusinessNameFontSize = (
  paperWidth: '80mm' | '58mm' = '80mm'
): number => (
  paperWidth === '58mm' ? 15 : 18
);

export const getDefaultReceiptLegalMarkerFontSize = (
  paperWidth: '80mm' | '58mm' = '80mm'
): number => getDefaultReceiptFontSize(paperWidth);

export const getDefaultReceiptQRCodeSize = (
  paperWidth: '80mm' | '58mm' = '80mm'
): number => (
  paperWidth === '58mm' ? 76 : 90
);

export const normalizeReceiptFontSize = (
  value: unknown,
  paperWidth: '80mm' | '58mm' = '80mm'
): number => {
  const parsed = Number(value);
  const fallback = getDefaultReceiptFontSize(paperWidth);
  return Number.isFinite(parsed) ? clampNumber(parsed, 8, 18) : fallback;
};

export const normalizeReceiptFontWeight = (value: unknown): ReceiptFontWeight => {
  const parsed = Number(value);
  if (RECEIPT_FONT_WEIGHT_OPTIONS.includes(parsed as ReceiptFontWeight)) {
    return parsed as ReceiptFontWeight;
  }
  return DEFAULT_RECEIPT_FONT_WEIGHT;
};

export const normalizeReceiptLineHeight = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Number(clampNumber(parsed, 1.05, 1.6).toFixed(2))
    : DEFAULT_RECEIPT_LINE_HEIGHT;
};

export const normalizeReceiptPaddingX = (
  value: unknown,
  paperWidth: '80mm' | '58mm' = '80mm'
): number => {
  const parsed = Number(value);
  const fallback = getDefaultReceiptPaddingX(paperWidth);
  return Number.isFinite(parsed) ? Math.round(clampNumber(parsed, 6, 32)) : fallback;
};

export const normalizeReceiptBusinessNameFontSize = (
  value: unknown,
  paperWidth: '80mm' | '58mm' = '80mm'
): number => {
  const parsed = Number(value);
  const fallback = getDefaultReceiptBusinessNameFontSize(paperWidth);
  return Number.isFinite(parsed) ? Math.round(clampNumber(parsed, 10, 28)) : fallback;
};

export const normalizeReceiptLegalMarkerFontSize = (
  value: unknown,
  paperWidth: '80mm' | '58mm' = '80mm'
): number => {
  const parsed = Number(value);
  const fallback = getDefaultReceiptLegalMarkerFontSize(paperWidth);
  return Number.isFinite(parsed)
    ? Math.round(clampNumber(parsed, 8, getDefaultReceiptFontSize(paperWidth)))
    : fallback;
};

export const normalizeReceiptTextScaleX = (value: unknown, fallback: number = 1): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Number(clampNumber(parsed, 0.75, 1.8).toFixed(2))
    : fallback;
};

export const normalizeReceiptQRCodeSize = (
  value: unknown,
  paperWidth: '80mm' | '58mm' = '80mm'
): number => {
  const parsed = Number(value);
  const fallback = getDefaultReceiptQRCodeSize(paperWidth);
  return Number.isFinite(parsed) ? Math.round(clampNumber(parsed, 48, 140)) : fallback;
};

export interface PrinterConfig {
  id: string;
  branchId: string;
  name: string;
  type: 'thermal' | 'inkjet' | 'laser' | 'thermal_bluetooth';
  paperWidth: '80mm' | '58mm'; // Roll paper sizes (80mm standard, 58mm compact)
  connectionType: 'usb' | 'network' | 'bluetooth'; // How printer connects
  bluetoothDeviceId?: string; // For Bluetooth printers
  bluetoothDeviceName?: string; // For Bluetooth printers
  isDefault: boolean;
  isEnabled: boolean;
  autoprint: boolean; // Auto-print receipts on sale completion
  printCopies: number; // Number of copies to print
  createdAt: string;
  updatedAt: string;
}

export interface PrinterSettings {
  branchId: string;
  autoprint: boolean;
  printCopies: number;
  defaultPrinter?: string;
  receiptPaperWidth: '80mm' | '58mm'; // Receipt layout width (can be compact on 80mm printers)
  receiptFontSize: number; // Normal receipt body font size in px
  receiptFontWeight: ReceiptFontWeight; // Normal receipt body font weight
  receiptLineHeight: number; // Normal receipt body line/word height
  receiptPaddingX: number; // Receipt horizontal padding in px
  receiptBusinessNameFontSize: number; // Business name font size in px
  receiptBusinessNameFontWeight: ReceiptFontWeight; // Business name font weight
  receiptBusinessNameScaleX: number; // Business name horizontal stretch
  receiptHeaderDetailScaleX: number; // Header/contact detail horizontal stretch
  receiptLegalMarkerFontSize: number; // Start/end legal receipt marker font size in px
  receiptLegalMarkerFontWeight: ReceiptFontWeight; // Start/end legal receipt marker font weight
  receiptLegalMarkerScaleX: number; // Start/end legal receipt marker horizontal stretch
  receiptQrCodeSize: number; // Receipt QR code preview/print size in px
  printHeader: boolean;
  printFooter: boolean;
  printQRCode: boolean;
  printItemDetails: boolean;
  printTaxBreakdown: boolean;
  createdAt: string;
  updatedAt: string;
}

class PrinterService {
  private printerConfigs: Map<string, PrinterConfig> = new Map();
  private printerSettings: Map<string, PrinterSettings> = new Map();

  private normalizeBranchId(value: unknown): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) return 'main';

    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];

    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];

    return normalized;
  }

  private getConfigsStorageKey(branchId: string): string {
    return `printer-configs-${this.normalizeBranchId(branchId)}`;
  }

  private getSettingsStorageKey(branchId: string): string {
    return `printer-settings-${this.normalizeBranchId(branchId)}`;
  }

  private readStorageWithBranchMigration(
    keyType: 'configs' | 'settings',
    branchId: string
  ): string | null {
    const normalizedBranchId = this.normalizeBranchId(branchId);
    const canonicalKey =
      keyType === 'configs'
        ? this.getConfigsStorageKey(normalizedBranchId)
        : this.getSettingsStorageKey(normalizedBranchId);

    const rawBranch = String(branchId ?? '').trim();
    const legacyKey =
      keyType === 'configs'
        ? `printer-configs-${rawBranch}`
        : `printer-settings-${rawBranch}`;

    let stored = localStorage.getItem(canonicalKey);
    if (!stored && rawBranch && legacyKey !== canonicalKey) {
      stored = localStorage.getItem(legacyKey);
      if (stored) {
        localStorage.setItem(canonicalKey, stored);
        localStorage.removeItem(legacyKey);
      }
    }

    return stored;
  }

  private normalizePaperWidth(value: unknown): '80mm' | '58mm' {
    return value === '58mm' ? '58mm' : '80mm';
  }

  private getDefaultPrinterFromCache(branchId: string): PrinterConfig | null {
    const normalizedBranchId = this.normalizeBranchId(branchId);
    return Array.from(this.printerConfigs.values()).find(
      (printer) =>
        this.normalizeBranchId(printer.branchId) === normalizedBranchId &&
        printer.isDefault &&
        printer.isEnabled
    ) || null;
  }

  private getEffectiveReceiptPaperWidth(
    branchId: string,
    requestedWidth: unknown
  ): '80mm' | '58mm' {
    const defaultPrinter = this.getDefaultPrinterFromCache(branchId);

    // A receipt cannot be wider than the configured physical roll.
    // An 80mm printer can still use the compact 58mm receipt layout.
    if (defaultPrinter?.paperWidth === '58mm') {
      return '58mm';
    }

    return this.normalizePaperWidth(requestedWidth);
  }

  private notifyPrinterUpdate(branchId: string, type: 'config' | 'settings'): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(new CustomEvent(PRINTER_CONFIG_UPDATED_EVENT, {
      detail: {
        branchId,
        type,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  private normalizePrinterSettings(branchId: string, raw?: Partial<PrinterSettings> | null): PrinterSettings {
    const receiptPaperWidth = this.getEffectiveReceiptPaperWidth(branchId, raw?.receiptPaperWidth);

    return {
      branchId,
      autoprint: raw?.autoprint ?? true,
      printCopies: Math.max(1, Number(raw?.printCopies || 1) || 1),
      defaultPrinter: raw?.defaultPrinter,
      receiptPaperWidth,
      receiptFontSize: normalizeReceiptFontSize(raw?.receiptFontSize, receiptPaperWidth),
      receiptFontWeight: normalizeReceiptFontWeight(raw?.receiptFontWeight),
      receiptLineHeight: normalizeReceiptLineHeight(raw?.receiptLineHeight),
      receiptPaddingX: normalizeReceiptPaddingX(raw?.receiptPaddingX, receiptPaperWidth),
      receiptBusinessNameFontSize: normalizeReceiptBusinessNameFontSize(
        raw?.receiptBusinessNameFontSize,
        receiptPaperWidth
      ),
      receiptBusinessNameFontWeight: normalizeReceiptFontWeight(
        raw?.receiptBusinessNameFontWeight ?? DEFAULT_RECEIPT_BUSINESS_NAME_WEIGHT
      ),
      receiptBusinessNameScaleX: normalizeReceiptTextScaleX(
        raw?.receiptBusinessNameScaleX,
        DEFAULT_RECEIPT_BUSINESS_NAME_SCALE_X
      ),
      receiptHeaderDetailScaleX: normalizeReceiptTextScaleX(
        raw?.receiptHeaderDetailScaleX,
        DEFAULT_RECEIPT_HEADER_DETAIL_SCALE_X
      ),
      receiptLegalMarkerFontSize: normalizeReceiptLegalMarkerFontSize(
        raw?.receiptLegalMarkerFontSize,
        receiptPaperWidth
      ),
      receiptLegalMarkerFontWeight: normalizeReceiptFontWeight(
        raw?.receiptLegalMarkerFontWeight ?? DEFAULT_RECEIPT_LEGAL_MARKER_WEIGHT
      ),
      receiptLegalMarkerScaleX: normalizeReceiptTextScaleX(
        raw?.receiptLegalMarkerScaleX,
        DEFAULT_RECEIPT_LEGAL_MARKER_SCALE_X
      ),
      receiptQrCodeSize: normalizeReceiptQRCodeSize(
        raw?.receiptQrCodeSize,
        receiptPaperWidth
      ),
      printHeader: raw?.printHeader ?? true,
      printFooter: raw?.printFooter ?? true,
      printQRCode: raw?.printQRCode ?? true,
      printItemDetails: raw?.printItemDetails ?? true,
      printTaxBreakdown: raw?.printTaxBreakdown ?? true,
      createdAt: raw?.createdAt || new Date().toISOString(),
      updatedAt: raw?.updatedAt || new Date().toISOString(),
    };
  }

  /**
   * Initialize printer service - load configs from IndexedDB
   */
  async initialize(branchId: string): Promise<void> {
    try {
      const normalizedBranchId = this.normalizeBranchId(branchId);
      console.log('[Printer] Initializing printer service for branch:', normalizedBranchId);
      
      // Load printer configs from localStorage (for quick access)
      const storedConfigs = this.readStorageWithBranchMigration('configs', branchId);
      if (storedConfigs) {
        try {
          const configs = JSON.parse(storedConfigs);
          configs.forEach((config: PrinterConfig) => {
            const normalizedConfig: PrinterConfig = {
              ...config,
              branchId: normalizedBranchId,
              paperWidth: this.normalizePaperWidth(config?.paperWidth),
            };
            this.printerConfigs.set(normalizedConfig.id, normalizedConfig);
          });
          console.log('[Printer] Loaded', configs.length, 'printer configs from localStorage');
        } catch (e) {
          console.error('[Printer] Failed to parse printer configs:', e);
        }
      }

      // Load printer settings
      const storedSettings = this.readStorageWithBranchMigration('settings', branchId);
      if (storedSettings) {
        try {
          const settings = this.normalizePrinterSettings(normalizedBranchId, JSON.parse(storedSettings));
          this.printerSettings.set(normalizedBranchId, settings);
          console.log('[Printer] Loaded printer settings from localStorage');
        } catch (e) {
          console.error('[Printer] Failed to parse printer settings:', e);
        }
      }
    } catch (error) {
      console.error('[Printer] Error initializing printer service:', error);
    }
  }

  /**
   * Get all printer configs for a branch
   */
  async getPrinterConfigs(branchId: string): Promise<PrinterConfig[]> {
    const normalizedBranchId = this.normalizeBranchId(branchId);
    await this.initialize(branchId);
    return Array.from(this.printerConfigs.values()).filter(
      p => this.normalizeBranchId(p.branchId) === normalizedBranchId
    );
  }

  /**
   * Get default printer for a branch
   */
  async getDefaultPrinter(branchId: string): Promise<PrinterConfig | null> {
    const configs = await this.getPrinterConfigs(branchId);
    return configs.find(p => p.isDefault && p.isEnabled) || null;
  }

  /**
   * Save printer config
   */
  async savePrinterConfig(config: PrinterConfig): Promise<void> {
    try {
      const normalizedBranchId = this.normalizeBranchId(config.branchId);
      const normalizedConfig: PrinterConfig = {
        ...config,
        branchId: normalizedBranchId,
        paperWidth: this.normalizePaperWidth(config.paperWidth),
      };

      console.log('[Printer] Saving printer config:', normalizedConfig.id);
      
      // If this is the new default, unset other defaults
      if (normalizedConfig.isDefault) {
        const configs = await this.getPrinterConfigs(normalizedBranchId);
        for (const existing of configs) {
          if (existing.id !== normalizedConfig.id && existing.isDefault) {
            existing.isDefault = false;
            this.printerConfigs.set(existing.id, existing);
          }
        }
      }

      this.printerConfigs.set(normalizedConfig.id, normalizedConfig);
      
      // Save to localStorage
      const configs = Array.from(this.printerConfigs.values()).filter(
        p => this.normalizeBranchId(p.branchId) === normalizedBranchId
      );
      localStorage.setItem(this.getConfigsStorageKey(normalizedBranchId), JSON.stringify(configs));

      // Keep an existing receipt layout within the physical width of its new default printer.
      if (normalizedConfig.isDefault && normalizedConfig.paperWidth === '58mm') {
        const currentSettings = this.printerSettings.get(normalizedBranchId);
        if (currentSettings?.receiptPaperWidth !== '58mm') {
          const compactSettings = this.normalizePrinterSettings(normalizedBranchId, {
            ...currentSettings,
            receiptPaperWidth: '58mm',
          });
          compactSettings.updatedAt = new Date().toISOString();
          this.printerSettings.set(normalizedBranchId, compactSettings);
          localStorage.setItem(
            this.getSettingsStorageKey(normalizedBranchId),
            JSON.stringify(compactSettings)
          );
          this.notifyPrinterUpdate(String(config.branchId || normalizedBranchId), 'settings');
        }
      }

      this.notifyPrinterUpdate(String(config.branchId || normalizedBranchId), 'config');
      
      console.log('[Printer] Printer config saved successfully');
    } catch (error) {
      console.error('[Printer] Error saving printer config:', error);
      throw error;
    }
  }

  /**
   * Delete printer config
   */
  async deletePrinterConfig(printerId: string, branchId: string): Promise<void> {
    try {
      const normalizedBranchId = this.normalizeBranchId(branchId);
      console.log('[Printer] Deleting printer config:', printerId);
      
      this.printerConfigs.delete(printerId);
      
      // Save to localStorage
      const configs = Array.from(this.printerConfigs.values()).filter(
        p => this.normalizeBranchId(p.branchId) === normalizedBranchId
      );
      localStorage.setItem(this.getConfigsStorageKey(normalizedBranchId), JSON.stringify(configs));
      this.notifyPrinterUpdate(String(branchId || normalizedBranchId), 'config');
      
      console.log('[Printer] Printer config deleted successfully');
    } catch (error) {
      console.error('[Printer] Error deleting printer config:', error);
      throw error;
    }
  }

  /**
   * Get printer settings for a branch
   */
  async getPrinterSettings(branchId: string): Promise<PrinterSettings> {
    const normalizedBranchId = this.normalizeBranchId(branchId);
    await this.initialize(branchId);
    
    if (this.printerSettings.has(normalizedBranchId)) {
      const normalized = this.normalizePrinterSettings(normalizedBranchId, this.printerSettings.get(normalizedBranchId)!);
      this.printerSettings.set(normalizedBranchId, normalized);
      return normalized;
    }

    const defaultPrinter = this.getDefaultPrinterFromCache(normalizedBranchId);

    // Return default settings matched to the default printer roll size.
    return this.normalizePrinterSettings(normalizedBranchId, {
      receiptPaperWidth: defaultPrinter?.paperWidth,
    });
  }

  /**
   * Save printer settings
   */
  async savePrinterSettings(settings: PrinterSettings): Promise<void> {
    try {
      const normalizedBranchId = this.normalizeBranchId(settings.branchId);
      console.log('[Printer] Saving printer settings for branch:', normalizedBranchId);

      await this.initialize(normalizedBranchId);
      const normalizedSettings = this.normalizePrinterSettings(normalizedBranchId, settings);
      normalizedSettings.updatedAt = new Date().toISOString();
      this.printerSettings.set(normalizedBranchId, normalizedSettings);
      
      // Save to localStorage
      localStorage.setItem(this.getSettingsStorageKey(normalizedBranchId), JSON.stringify(normalizedSettings));
      this.notifyPrinterUpdate(String(settings.branchId || normalizedBranchId), 'settings');
      
      console.log('[Printer] Printer settings saved successfully');
    } catch (error) {
      console.error('[Printer] Error saving printer settings:', error);
      throw error;
    }
  }

  /**
   * Print receipt silently without dialog (for connected devices)
   * Uses Web Print API with automatic printer selection
   */
  async printReceiptSilent(
    receiptHtml: string,
    copies: number = 1,
    paperWidth: '80mm' | '58mm' = '80mm'
  ): Promise<boolean> {
    try {
      const resolvedPaperWidth = this.normalizePaperWidth(paperWidth);
      console.log('[Printer] Silent printing receipt', { copies, paperWidth: resolvedPaperWidth });

      // Validate receipt content
      if (!receiptHtml || receiptHtml.trim().length === 0) {
        console.error('[Printer] Receipt content is empty');
        return false;
      }

      // Print multiple copies
      for (let copyNum = 1; copyNum <= copies; copyNum++) {
        // For copies 2+, add copy indicator to receipt
        let printHtml = receiptHtml;
        if (copyNum > 1) {
          // Insert copy indicator after the opening body tag
          printHtml = receiptHtml.replace(
            /<div id="receipt-printable-area"/,
            `<div id="receipt-printable-area" data-copy-number="${copyNum}"`
          );
        }

        // Create a hidden iframe for printing
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.style.visibility = 'hidden';
        iframe.style.position = 'absolute';
        iframe.style.left = '-9999px';
        iframe.style.width = resolvedPaperWidth;
        iframe.style.height = 'auto';
        document.body.appendChild(iframe);

        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) {
          throw new Error('Could not access iframe document');
        }

        // Write receipt HTML to iframe with print styles
        iframeDoc.write(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                * {
                  margin: 0;
                  padding: 0;
                  box-sizing: border-box;
                }
                html, body {
                  width: ${resolvedPaperWidth};
                  margin: 0;
                  padding: 0;
                }
                body {
                  font-family: 'Courier New', monospace;
                  font-size: 12px;
                  line-height: 1.4;
                  width: ${resolvedPaperWidth};
                  margin: 0;
                  padding: 0;
                }
                @media print {
                  * {
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                  }
                  html, body {
                    width: ${resolvedPaperWidth} !important;
                    height: auto !important;
                    margin: 0 !important;
                    padding: 0 !important;
                  }
                  @page {
                    size: ${resolvedPaperWidth} auto;
                    margin: 0;
                    padding: 0;
                  }
                }
              </style>
            </head>
            <body>
              ${copyNum > 1 ? `<div style="text-align: center; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed; font-weight: bold; font-size: 11px;">*** COPY #${copyNum} ***</div>` : ''}
              ${printHtml}
            </body>
          </html>
        `);
        iframeDoc.close();

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 300));

        // Print this copy silently
        if (iframe.contentWindow) {
          // Use silent print with automatic printer selection
          await this.silentPrintIframe(iframe, copyNum, copies, resolvedPaperWidth);
          
          // Wait between copies
          if (copyNum < copies) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        // Clean up after a delay
        setTimeout(() => {
          try {
            document.body.removeChild(iframe);
          } catch (e) {
            console.warn('[Printer] Error removing iframe:', e);
          }
        }, 500);
      }

      console.log('[Printer] Silent receipt printed successfully');
      return true;
    } catch (error) {
      console.error('[Printer] Error in silent print:', error);
      return false;
    }
  }

  /**
   * Silent print using iframe with automatic printer selection
   */
  private async silentPrintIframe(
    iframe: HTMLIFrameElement,
    copyNum: number,
    totalCopies: number,
    paperWidth: '80mm' | '58mm'
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!iframe.contentWindow) {
        resolve();
        return;
      }

      const printWindow = iframe.contentWindow;
      
      try {
        // Method 1: Try using the Print API with automatic printer selection
        // This requires the browser to have a default printer configured
        if (this.tryAutoPrint(printWindow)) {
          console.log(`[Printer] Auto-printing copy ${copyNum}/${totalCopies}`);
          setTimeout(() => resolve(), 1000);
          return;
        }

        // Method 2: Use CSS media queries to trigger print without dialog
        // This works by using @media print and letting the browser handle it
        const style = printWindow.document.createElement('style');
        style.textContent = `
          @media print {
            body { margin: 0; padding: 0; }
          }
          @page {
            margin: 0;
            size: ${paperWidth} auto;
          }
        `;
        printWindow.document.head.appendChild(style);

        // Set up event listeners
        printWindow.addEventListener('beforeprint', () => {
          console.log(`[Printer] Printing copy ${copyNum}/${totalCopies}`);
        });

        printWindow.addEventListener('afterprint', () => {
          console.log(`[Printer] Print completed for copy ${copyNum}/${totalCopies}`);
          resolve();
        });

        // Trigger print with keyboard shortcut simulation
        // This works better than window.print() in some cases
        const printEvent = new KeyboardEvent('keydown', {
          key: 'p',
          code: 'KeyP',
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          bubbles: true,
          cancelable: true,
        });

        // Try to trigger print
        if (!printWindow.document.dispatchEvent(printEvent)) {
          // If keyboard event is prevented, use window.print()
          printWindow.print();
        }

        // Fallback: resolve after timeout if afterprint doesn't fire
        setTimeout(() => {
          resolve();
        }, 2500);
      } catch (error) {
        console.error('[Printer] Error triggering print:', error);
        resolve();
      }
    });
  }

  /**
   * Try to auto-print using browser's print API
   */
  private tryAutoPrint(printWindow: Window): boolean {
    try {
      // Check if browser supports automatic printing
      // This is a best-effort approach
      if ((printWindow as any).print && typeof (printWindow as any).print === 'function') {
        // Some browsers allow automatic printing if:
        // 1. User has set a default printer
        // 2. The page is from a trusted source
        // 3. The browser is in kiosk mode
        
        // Try to detect if we can auto-print
        const canAutoPrint = this.detectAutoPrintCapability();
        return canAutoPrint;
      }
      return false;
    } catch (error) {
      console.error('[Printer] Error checking auto-print capability:', error);
      return false;
    }
  }

  /**
   * Detect if browser can auto-print
   */
  private detectAutoPrintCapability(): boolean {
    try {
      // Check for Chrome/Edge auto-print capability
      if (typeof (navigator as any).printer !== 'undefined') {
        return true;
      }

      // Check for Firefox auto-print
      if (typeof (navigator as any).mozPrint !== 'undefined') {
        return true;
      }

      // Check localStorage for auto-print preference
      const autoPrintEnabled = localStorage.getItem('handy-pos-auto-print-enabled');
      if (autoPrintEnabled === 'true') {
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Printer] Error detecting auto-print capability:', error);
      return false;
    }
  }

  /**
   * Validate printer connection status
   */
  async validatePrinterConnection(printer: PrinterConfig): Promise<boolean> {
    try {
      if (printer.connectionType === 'bluetooth') {
        // Check if Bluetooth printer is connected
        const { escPosService } = await import('./escpos-service');
        const isConnected = escPosService.isConnected();
        console.log('[Printer] Bluetooth connection status:', isConnected);
        return isConnected;
      } else {
        // USB/Network printers are available if browser supports printing
        const supported = this.supportsPrinting();
        console.log('[Printer] Web Print API supported:', supported);
        return supported;
      }
    } catch (error) {
      console.error('[Printer] Error validating connection:', error);
      return false;
    }
  }

  /**
   * Print receipt using Web Print API
   */
  async printReceipt(
    receiptHtml: string,
    printerName?: string,
    copies: number = 1
  ): Promise<boolean> {
    try {
      console.log('[Printer] Printing receipt', { printerName, copies });

      // Create a hidden iframe for printing
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error('Could not access iframe document');
      }

      // Write receipt HTML to iframe
      iframeDoc.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body {
                margin: 0;
                padding: 0;
                font-family: monospace;
                font-size: 12px;
              }
              @media print {
                body {
                  margin: 0;
                  padding: 0;
                }
              }
            </style>
          </head>
          <body>
            ${receiptHtml}
          </body>
        </html>
      `);
      iframeDoc.close();

      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Print multiple copies
      for (let i = 0; i < copies; i++) {
        iframe.contentWindow?.print();
        
        // Wait between copies
        if (i < copies - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Clean up
      setTimeout(() => {
        document.body.removeChild(iframe);
      }, 1000);

      console.log('[Printer] Receipt printed successfully');
      return true;
    } catch (error) {
      console.error('[Printer] Error printing receipt:', error);
      return false;
    }
  }

  /**
   * Print receipt directly (without dialog)
   */
  async printReceiptDirect(
    receiptHtml: string,
    copies: number = 1,
    paperWidth: '80mm' | '58mm' = '80mm'
  ): Promise<boolean> {
    try {
      console.log('[Printer] Direct printing receipt', { copies, paperWidth });
      return await this.printReceiptSilent(receiptHtml, copies, paperWidth);
    } catch (error) {
      console.error('[Printer] Error in direct print:', error);
      return false;
    }
  }

  /**
   * Check if browser supports Web Print API
   */
  supportsPrinting(): boolean {
    return typeof window !== 'undefined' && typeof window.print === 'function';
  }

  /**
   * Get available printers (browser-based - limited support)
   */
  async getAvailablePrinters(): Promise<string[]> {
    // Note: Modern browsers don't expose printer list for security reasons
    // This is a placeholder for future implementation
    return ['Default Printer', 'System Printer'];
  }
}

export const printerService = new PrinterService();
