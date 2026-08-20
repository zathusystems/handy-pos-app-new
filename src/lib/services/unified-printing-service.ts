'use client';

/**
 * Unified Printing Service
 * Handles both Web Print API (USB/Network) and ESC/POS (Bluetooth) printers
 */

import { type PrinterConfig } from './printer-service';
import { escPosService } from './escpos-service';
import { silentPrintService } from './silent-print-service';

export class UnifiedPrintingService {
  /**
   * Print receipt to appropriate printer based on type
   */
  async printReceipt(
    receiptHtml: string,
    printer: PrinterConfig,
    copies: number = 1
  ): Promise<{ success: boolean; message: string }> {
    try {
      console.log('[UnifiedPrinting] Printing to:', printer.name, 'Type:', printer.connectionType);

      if (printer.connectionType === 'bluetooth') {
        if (this.shouldUseNativeBluetoothPath(printer)) {
          return await this.printViaNativeSystem(receiptHtml, printer, copies);
        }
        return await this.printViaBluetoothESCPOS(receiptHtml, printer, copies);
      } else {
        return await this.printViaNativeSystem(receiptHtml, printer, copies);
      }
    } catch (error) {
      console.error('[UnifiedPrinting] Print error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Use native/system silent printing path (USB/Network/CUPS Bluetooth queues)
   */
  private async printViaNativeSystem(
    receiptHtml: string,
    printer: PrinterConfig,
    copies: number
  ): Promise<{ success: boolean; message: string }> {
    try {
      console.log('[UnifiedPrinting] Using native/system print path for:', printer.name);
      const success = await silentPrintService.printSilentlyViaSystem(receiptHtml, {
        printerName: printer.name,
        printerId: printer.id,
        copies,
        paperSize: printer.paperWidth,
        printerPaperSize: printer.paperWidth,
      });

      if (success) {
        return {
          success: true,
          message: `Receipt sent to ${printer.name}`,
        };
      } else {
        return {
          success: false,
          message: 'Print operation failed',
        };
      }
    } catch (error) {
      console.error('[UnifiedPrinting] Native/system print error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Print failed',
      };
    }
  }

  private shouldUseNativeBluetoothPath(printer: PrinterConfig): boolean {
    const printerId = String(printer.id || '').trim().toLowerCase();
    return printerId.startsWith('cups:') || printerId.startsWith('bt:');
  }

  /**
   * Print via Bluetooth ESC/POS (Thermal printers)
   */
  private async printViaBluetoothESCPOS(
    receiptHtml: string,
    printer: PrinterConfig,
    copies: number
  ): Promise<{ success: boolean; message: string }> {
    try {
      console.log('[UnifiedPrinting] Using ESC/POS for Bluetooth printer:', printer.name);

      // Check if Web Bluetooth is supported
      if (!escPosService.supportsWebBluetooth()) {
        return {
          success: false,
          message: 'Web Bluetooth API not supported in this browser. Use Chrome, Edge, or Opera.',
        };
      }

      // Check if already connected
      if (!escPosService.isConnected()) {
        console.log('[UnifiedPrinting] Not connected, requesting device...');

        // Request device
        const device = await escPosService.requestDevice();
        if (!device) {
          return {
            success: false,
            message: 'No device selected',
          };
        }

        // Connect
        await escPosService.connect(device);
        await escPosService.initialize();
      }

      // Print receipt
      await escPosService.printReceipt(receiptHtml, copies);

      return {
        success: true,
        message: `Receipt printed to ${printer.name}`,
      };
    } catch (error) {
      console.error('[UnifiedPrinting] Bluetooth ESC/POS error:', error);

      // Provide helpful error messages
      let message = 'Bluetooth print failed';
      if (error instanceof Error) {
        if (error.message.includes('NotFoundError')) {
          message = 'Printer not found. Make sure it is paired and in range.';
        } else if (error.message.includes('NotAllowedError')) {
          message = 'Bluetooth permission denied. Please allow access.';
        } else if (error.message.includes('NetworkError')) {
          message = 'Bluetooth connection lost. Try reconnecting.';
        } else {
          message = error.message;
        }
      }

      return {
        success: false,
        message,
      };
    }
  }

  /**
   * Connect to Bluetooth printer manually
   */
  async connectBluetoothPrinter(): Promise<{ success: boolean; message: string }> {
    try {
      if (!escPosService.supportsWebBluetooth()) {
        return {
          success: false,
          message: 'Web Bluetooth API not supported',
        };
      }

      const device = await escPosService.requestDevice();
      if (!device) {
        return {
          success: false,
          message: 'No device selected',
        };
      }

      await escPosService.connect(device);
      await escPosService.initialize();

      const deviceInfo = escPosService.getDeviceInfo();
      return {
        success: true,
        message: `Connected to ${deviceInfo?.name}`,
      };
    } catch (error) {
      console.error('[UnifiedPrinting] Connection error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * Disconnect from Bluetooth printer
   */
  async disconnectBluetoothPrinter(): Promise<void> {
    await escPosService.disconnect();
  }

  /**
   * Check Bluetooth printer connection status
   */
  isBluetoothConnected(): boolean {
    return escPosService.isConnected();
  }

  /**
   * Get Bluetooth printer info
   */
  getBluetoothPrinterInfo() {
    return escPosService.getDeviceInfo();
  }

  /**
   * Check if Web Bluetooth is supported
   */
  supportsWebBluetooth(): boolean {
    return escPosService.supportsWebBluetooth();
  }

  /**
   * Test print to verify printer works
   */
  async testPrint(printer: PrinterConfig): Promise<{ success: boolean; message: string }> {
    const testReceipt = `
      <div style="font-family: monospace; width: 80mm; padding: 10mm;">
        <div style="text-align: center; margin-bottom: 10mm;">
          <h2 style="margin: 0;">TEST RECEIPT</h2>
          <p style="margin: 0; font-size: 0.8em;">Handy POS System</p>
        </div>
        <div style="border-top: 1px dashed; border-bottom: 1px dashed; padding: 5mm 0; margin: 5mm 0;">
          <div style="display: flex; justify-content: space-between; font-size: 0.9em;">
            <span>Item 1</span>
            <span>$10.00</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.9em;">
            <span>Item 2</span>
            <span>$15.00</span>
          </div>
        </div>
        <div style="font-size: 0.9em; margin: 5mm 0;">
          <div style="display: flex; justify-content: space-between;">
            <span>Subtotal:</span>
            <span>$25.00</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Tax (16%):</span>
            <span>$4.00</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 1.1em; margin-top: 5mm;">
            <span>TOTAL:</span>
            <span>$29.00</span>
          </div>
        </div>
        <div style="text-align: center; margin-top: 10mm; font-size: 0.8em;">
          <p>Thank you for your business!</p>
          <p>Powered by Handy POS</p>
        </div>
      </div>
    `;

    return await this.printReceipt(testReceipt, printer, 1);
  }
}

export const unifiedPrintingService = new UnifiedPrintingService();
