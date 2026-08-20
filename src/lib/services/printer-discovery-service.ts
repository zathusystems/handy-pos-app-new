'use client';

/**
 * Printer Discovery Service
 * Scans for available printers on the system
 */

export interface DiscoveredPrinter {
  id: string;
  name: string;
  type: 'usb' | 'network' | 'bluetooth' | 'unknown';
  status: 'ready' | 'offline' | 'error' | 'unknown';
  isDefault: boolean;
  description?: string;
}

class PrinterDiscoveryService {
  private static readonly TAURI_SCAN_TIMEOUT_MS = 5000;

  /**
   * Scan for available printers using Print API
   * Note: Limited browser support - works best in Chrome/Edge
   */
  async scanPrinters(): Promise<DiscoveredPrinter[]> {
    try {
      console.log('[PrinterDiscovery] Starting printer scan...');
      console.log('[PrinterDiscovery] Tauri check:', typeof (window as any).__TAURI__);
      
      const printers: DiscoveredPrinter[] = [];

      // Try native Tauri printer discovery first. This also supports Tauri v2 setups
      // where window.__TAURI__ global is not exposed.
      const tauriPrinters = await this.scanTauriPrinters();
      if (tauriPrinters.length > 0) {
        console.log('[PrinterDiscovery] Found', tauriPrinters.length, 'printers via Tauri');
        return tauriPrinters;
      }

      // If we are in Tauri but got no printers, do not continue with browser methods.
      if (this.isTauriEnvironment()) {
        console.log('[PrinterDiscovery] Tauri environment detected, but no printers returned');
        return [];
      }

      console.log('[PrinterDiscovery] ❌ NOT in Tauri environment, using browser methods');

      // Method 1: Try using Print API (Chrome/Edge only)
      if (this.supportsPrintAPI()) {
        console.log('[PrinterDiscovery] Using Print API for scanning');
        const printApiPrinters = await this.scanUsingPrintAPI();
        printers.push(...printApiPrinters);
      }

      // Method 2: Try using Bluetooth API
      if (this.supportsWebBluetooth()) {
        console.log('[PrinterDiscovery] Web Bluetooth API available');
        // Don't auto-scan Bluetooth - user must initiate pairing
        // But we can detect already paired devices
        const bluetoothPrinters = await this.scanBluetoothPrinters();
        printers.push(...bluetoothPrinters);
      }

      // Method 3: Get system default printer info
      const defaultPrinter = await this.getDefaultPrinter();
      if (defaultPrinter && !printers.find(p => p.id === defaultPrinter.id)) {
        printers.push(defaultPrinter);
      }

      // Method 4: Try to detect USB printers via WebUSB API (only if not Tauri)
      if (this.supportsWebUSB() && !this.isTauriEnvironment()) {
        console.log('[PrinterDiscovery] WebUSB API available');
        const usbPrinters = await this.scanUSBPrinters();
        printers.push(...usbPrinters);
      }

      console.log('[PrinterDiscovery] Found', printers.length, 'printers');
      return printers;
    } catch (error) {
      console.error('[PrinterDiscovery] Error scanning printers:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Scan for printers using Tauri's system API
   */
  private async scanTauriPrinters(): Promise<DiscoveredPrinter[]> {
    try {
      const invoke = await this.getTauriInvoke();
      if (!invoke) {
        console.log('[PrinterDiscovery] Tauri invoke not available in this context');
        return [];
      }

      console.log('[PrinterDiscovery] 🔍 Invoking Tauri get_printers command');
      
      let printerList: any;
      try {
        printerList = await this.withTimeout(
          invoke('get_printers'),
          PrinterDiscoveryService.TAURI_SCAN_TIMEOUT_MS,
          'Printer scan timed out'
        );
        console.log('[PrinterDiscovery] ✅ Tauri invoke succeeded, got:', printerList);
      } catch (invokeError) {
        console.error('[PrinterDiscovery] ❌ Tauri invoke failed:', invokeError);
        console.error('[PrinterDiscovery] Error details:', invokeError);
        const message = invokeError instanceof Error
          ? invokeError.message
          : String(invokeError);
        const lowerMessage = message.toLowerCase();

        // Android can intentionally reject the first call while prompting runtime permissions.
        if (
          lowerMessage.includes('permission requested') ||
          lowerMessage.includes('allow nearby devices permission')
        ) {
          console.log('[PrinterDiscovery] Bluetooth permission flow in progress');
          throw new Error('Bluetooth permission requested. Allow Nearby devices permission, then tap Scan for Printers again.');
        }

        if (lowerMessage.includes('no such method')) {
          throw new Error('Android printer discovery is unavailable in this build. Rebuild the Tauri Android app and try again.');
        }

        throw new Error(message);
      }
      
      if (!Array.isArray(printerList)) {
        console.log('[PrinterDiscovery] ⚠️ Invalid printer list from Tauri:', printerList);
        return [];
      }

      if (printerList.length === 0) {
        console.log('[PrinterDiscovery] ℹ️ No printers found from Tauri');
        return [];
      }

      const printers: DiscoveredPrinter[] = printerList.map((printer: any) => {
        console.log('[PrinterDiscovery] 🖨️ Processing printer:', printer);
        const normalizedType = String(printer.type || printer['r#type'] || '').toLowerCase();
        const mappedType = normalizedType.includes('bluetooth')
          ? 'bluetooth'
          : normalizedType.includes('network')
          ? 'network'
          : 'usb';

        const rawName = String(printer.name || '').trim();
        const rawId = String(printer.id || '').trim();
        let id = rawId || rawName || `printer-${Date.now()}`;

        // On Windows, ensure we store a spooler queue id to match the native backend.
        if (this.isWindowsEnvironment() && rawName) {
          const lowerId = id.toLowerCase();
          if (!lowerId.startsWith('win:')) {
            id = `win:${rawName}`;
          }
        }

        return {
          id,
          name: rawName || 'Unknown Printer',
          type: mappedType,
          status: (printer.status || 'ready') as 'ready' | 'offline' | 'error' | 'unknown',
          isDefault: printer.is_default || false,
          description: printer.description || `System printer: ${rawName || 'Unknown Printer'}`,
        };
      });

      console.log('[PrinterDiscovery] ✅ Found', printers.length, 'printers from Tauri:', printers);
      return printers;
    } catch (error) {
      console.error('[PrinterDiscovery] ❌ Error scanning Tauri printers:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Scan using Print API (Chrome/Edge)
   */
  private async scanUsingPrintAPI(): Promise<DiscoveredPrinter[]> {
    try {
      const printers: DiscoveredPrinter[] = [];

      // Check if Print API is available
      if (!('getPrinterInfo' in navigator)) {
        console.log('[PrinterDiscovery] Print API not available');
        return printers;
      }

      // Try to get printer info (limited support)
      // Most browsers don't expose full printer list for security
      // But we can try to detect the default printer
      const defaultPrinter = await this.getDefaultPrinter();
      if (defaultPrinter) {
        printers.push(defaultPrinter);
      }

      return printers;
    } catch (error) {
      console.error('[PrinterDiscovery] Error using Print API:', error);
      return [];
    }
  }

  /**
   * Scan for Bluetooth printers
   */
  private async scanBluetoothPrinters(): Promise<DiscoveredPrinter[]> {
    try {
      const printers: DiscoveredPrinter[] = [];

      if (!this.supportsWebBluetooth()) {
        return printers;
      }

      // Note: Web Bluetooth API doesn't allow scanning without user interaction
      // User must initiate the scan through requestDevice()
      console.log('[PrinterDiscovery] Bluetooth scanning requires user interaction');

      return printers;
    } catch (error) {
      console.error('[PrinterDiscovery] Error scanning Bluetooth:', error);
      return [];
    }
  }

  /**
   * Get default printer info
   */
  private async getDefaultPrinter(): Promise<DiscoveredPrinter | null> {
    try {
      // Create a test print to detect default printer
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 200;
      testCanvas.height = 100;
      const ctx = testCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 200, 100);
        ctx.fillStyle = '#000000';
        ctx.font = '12px Arial';
        ctx.fillText('Printer Test', 10, 50);
      }

      // Try to get printer name from system
      // This is a workaround since browsers don't expose printer list
      const printerName = this.detectSystemPrinter();

      if (printerName) {
        return {
          id: 'default-printer',
          name: printerName,
          type: 'usb',
          status: 'ready',
          isDefault: true,
          description: 'System default printer',
        };
      }

      return null;
    } catch (error) {
      console.error('[PrinterDiscovery] Error getting default printer:', error);
      return null;
    }
  }

  /**
   * Detect system printer name (workaround)
   */
  private detectSystemPrinter(): string | null {
    try {
      // Try to detect printer from browser's print settings
      // This is a best-effort approach
      const printerNames = [
        'Microsoft Print to PDF',
        'Print to File',
        'Adobe PDF',
        'Generic / Text Only',
        'Local Printer',
        'Network Printer',
      ];

      // Check localStorage for previously detected printer
      const savedPrinter = localStorage.getItem('detected-system-printer');
      if (savedPrinter) {
        return savedPrinter;
      }

      // Return a generic name
      return 'System Printer';
    } catch (error) {
      console.error('[PrinterDiscovery] Error detecting system printer:', error);
      return null;
    }
  }

  /**
   * Request Bluetooth printer discovery
   * User must initiate this - shows device picker
   */
  async requestBluetoothPrinter(): Promise<DiscoveredPrinter | null> {
    try {
      if (!this.supportsWebBluetooth()) {
        throw new Error('Web Bluetooth API not supported');
      }

      console.log('[PrinterDiscovery] Requesting Bluetooth device...');

      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [
          { name: /Sunmi/ },
          { name: /Star/ },
          { name: /Epson/ },
          { name: /TM-/ },
          { name: /Printer/ },
        ],
        optionalServices: ['180a', '180f', 'fff0'],
      });

      if (!device) {
        return null;
      }

      return {
        id: device.id,
        name: device.name || 'Unknown Bluetooth Printer',
        type: 'bluetooth',
        status: 'ready',
        isDefault: false,
        description: `Bluetooth: ${device.name}`,
      };
    } catch (error) {
      console.error('[PrinterDiscovery] Error requesting Bluetooth printer:', error);
      if (error instanceof Error && error.name === 'NotFoundError') {
        throw new Error('No Bluetooth printer found. Make sure your printer is in pairing mode.');
      }
      throw error;
    }
  }

  /**
   * Check if browser supports Print API
   */
  private supportsPrintAPI(): boolean {
    return typeof window !== 'undefined' && typeof window.print === 'function';
  }

  /**
   * Check if browser supports Web Bluetooth API
   */
  private supportsWebBluetooth(): boolean {
    return typeof window !== 'undefined' && !!(navigator as any).bluetooth;
  }

  /**
   * Check if browser supports WebUSB API
   */
  private supportsWebUSB(): boolean {
    // In Tauri, WebUSB might not be available, so we check for Tauri first
    if (this.isTauriEnvironment()) {
      return false; // Use Tauri's native printer API instead
    }
    return typeof window !== 'undefined' && !!(navigator as any).usb;
  }

  /**
   * Check if running in Tauri environment
   */
  private isTauriEnvironment(): boolean {
    try {
      const hasTauriInvoke = typeof (window as any).__TAURI__?.invoke === 'function';
      const hasInternalInvoke = typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function';
      const userAgent = navigator.userAgent.toLowerCase();
      const isTauriWebview = userAgent.includes('tauri') || userAgent.includes('wry');

      const result = hasTauriInvoke || hasInternalInvoke || isTauriWebview;
      
      console.log('[PrinterDiscovery] Tauri environment check:', {
        hasTauriInvoke,
        hasInternalInvoke,
        isTauriWebview,
        result,
        userAgent: userAgent.substring(0, 150),
        __TAURI__: (window as any).__TAURI__ ? 'exists' : 'undefined',
        __TAURI_INTERNALS__: (window as any).__TAURI_INTERNALS__ ? 'exists' : 'undefined',
      });
      
      return result;
    } catch (error) {
      console.error('[PrinterDiscovery] Error checking Tauri environment:', error);
      return false;
    }
  }

  private isWindowsEnvironment(): boolean {
    try {
      const userAgent = navigator.userAgent.toLowerCase();
      return userAgent.includes('windows');
    } catch {
      return false;
    }
  }

  private async getTauriInvoke(): Promise<((command: string, args?: Record<string, unknown>) => Promise<any>) | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (typeof invoke === 'function') {
        return invoke as (command: string, args?: Record<string, unknown>) => Promise<any>;
      }
    } catch {
      // Ignore and try global fallbacks.
    }

    try {
      const tauriInvoke = (window as any).__TAURI__?.invoke;
      if (typeof tauriInvoke === 'function') {
        return tauriInvoke.bind((window as any).__TAURI__);
      }

      const internalInvoke = (window as any).__TAURI_INTERNALS__?.invoke;
      if (typeof internalInvoke === 'function') {
        return internalInvoke.bind((window as any).__TAURI_INTERNALS__);
      }
    } catch {
      // Ignore global access errors.
    }

    return null;
  }

  /**
   * Scan for USB printers using WebUSB API
   */
  private async scanUSBPrinters(): Promise<DiscoveredPrinter[]> {
    try {
      const printers: DiscoveredPrinter[] = [];

      if (!this.supportsWebUSB()) {
        return printers;
      }

      console.log('[PrinterDiscovery] Scanning for USB printers...');

      // Common printer vendor IDs
      const printerVendorIds = [
        0x04b8, // Epson
        0x0409, // NEC
        0x03f0, // HP
        0x0e8d, // MediaTek
        0x1a86, // QinHeng Electronics (CH340)
        0x10c4, // Silicon Labs
        0x067b, // Prolific
        0x2c7c, // Quectel
      ];

      // Request USB devices
      const devices = await (navigator as any).usb.getDevices();
      
      for (const device of devices) {
        // Check if it's likely a printer
        if (this.isPrinterDevice(device)) {
          const printer: DiscoveredPrinter = {
            id: `usb-${device.vendorId}-${device.productId}`,
            name: device.productName || `USB Printer (${device.vendorId}:${device.productId})`,
            type: 'usb',
            status: 'ready',
            isDefault: false,
            description: `USB: ${device.manufacturerName || 'Unknown'} ${device.productName || 'Printer'}`,
          };
          printers.push(printer);
        }
      }

      console.log('[PrinterDiscovery] Found', printers.length, 'USB printers');
      return printers;
    } catch (error) {
      console.error('[PrinterDiscovery] Error scanning USB printers:', error);
      return [];
    }
  }

  /**
   * Check if a USB device is likely a printer
   */
  private isPrinterDevice(device: any): boolean {
    // Check device class (7 = printer)
    if (device.deviceClass === 7) {
      return true;
    }

    // Check product name
    const productName = (device.productName || '').toLowerCase();
    const manufacturerName = (device.manufacturerName || '').toLowerCase();
    
    const printerKeywords = ['printer', 'thermal', 'receipt', 'pos', 'epson', 'star', 'sunmi', 'xprinter'];
    
    return printerKeywords.some(keyword => 
      productName.includes(keyword) || manufacturerName.includes(keyword)
    );
  }

  /**
   * Request USB printer discovery
   * User must initiate this - shows device picker
   */
  async requestUSBPrinter(): Promise<DiscoveredPrinter | null> {
    try {
      if (!this.supportsWebUSB()) {
        throw new Error('WebUSB API not supported');
      }

      console.log('[PrinterDiscovery] Requesting USB device...');

      const device = await (navigator as any).usb.requestDevice({
        filters: [
          { classCode: 7 }, // Printer class
          { vendorId: 0x04b8 }, // Epson
          { vendorId: 0x03f0 }, // HP
          { vendorId: 0x0e8d }, // MediaTek
        ],
      });

      if (!device) {
        return null;
      }

      return {
        id: `usb-${device.vendorId}-${device.productId}`,
        name: device.productName || `USB Printer (${device.vendorId}:${device.productId})`,
        type: 'usb',
        status: 'ready',
        isDefault: false,
        description: `USB: ${device.manufacturerName || 'Unknown'} ${device.productName || 'Printer'}`,
      };
    } catch (error) {
      console.error('[PrinterDiscovery] Error requesting USB printer:', error);
      if (error instanceof Error && error.name === 'NotFoundError') {
        throw new Error('No USB printer found. Make sure your printer is connected.');
      }
      throw error;
    }
  }

  /**
   * Get browser capabilities
   */
  getCapabilities(): {
    supportsPrintAPI: boolean;
    supportsWebBluetooth: boolean;
    supportsWebUSB: boolean;
    supportedBrowsers: string[];
  } {
    return {
      supportsPrintAPI: this.supportsPrintAPI(),
      supportsWebBluetooth: this.supportsWebBluetooth(),
      supportsWebUSB: this.supportsWebUSB(),
      supportedBrowsers: [
        'Chrome/Chromium (full support)',
        'Edge (full support)',
        'Opera (full support)',
        'Firefox (limited support)',
        'Safari (USB only)',
      ],
    };
  }
}

export const printerDiscoveryService = new PrinterDiscoveryService();
