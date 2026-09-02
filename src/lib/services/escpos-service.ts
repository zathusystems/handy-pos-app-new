'use client';

/**
 * ESC/POS Thermal Printer Service
 * Handles direct communication with Bluetooth thermal printers
 * Supports: Sunmi, Star Micronics, Epson TM series, and other ESC/POS compatible printers
 */

export interface BluetoothPrinterDevice {
  id: string;
  name: string;
  type: 'sunmi' | 'star' | 'epson' | 'generic';
  isConnected: boolean;
  lastConnected?: string;
}

export interface ESCPOSConfig {
  paperWidth: 80 | 58; // mm
  charPerLine: number;
  lineHeight: number;
}

type WebBluetoothDevice = any;
type WebBluetoothRemoteGATTCharacteristic = any;

class ESCPOSService {
  private device: WebBluetoothDevice | null = null;
  private characteristic: WebBluetoothRemoteGATTCharacteristic | null = null;
  private config: ESCPOSConfig = {
    paperWidth: 80,
    charPerLine: 42, // 80mm / 2 pixels per char
    lineHeight: 24,
  };

  /**
   * ESC/POS Command Codes
   */
  private readonly ESC = '\x1B';
  private readonly GS = '\x1D';
  private readonly LF = '\x0A';
  private readonly CR = '\x0D';
  private readonly NUL = '\x00';

  setPaperWidth(paperWidth: 80 | 58): void {
    const isCompact = paperWidth === 58;
    this.config = {
      ...this.config,
      paperWidth: isCompact ? 58 : 80,
      charPerLine: isCompact ? 32 : 42,
    };
  }

  /**
   * Check if Web Bluetooth API is supported
   */
  supportsWebBluetooth(): boolean {
    if (typeof window === 'undefined') return false;
    return !!(navigator as any).bluetooth;
  }

  /**
   * Request Bluetooth device
   */
  async requestDevice(): Promise<WebBluetoothDevice | null> {
    try {
      if (!this.supportsWebBluetooth()) {
        throw new Error('Web Bluetooth API not supported in this browser');
      }

      console.log('[ESC/POS] Requesting Bluetooth device...');

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

      console.log('[ESC/POS] Device selected:', device.name);
      this.device = device;

      // Listen for disconnection
      device.addEventListener('gattserverdisconnected', () => {
        console.log('[ESC/POS] Device disconnected');
        this.characteristic = null;
      });

      return device;
    } catch (error) {
      console.error('[ESC/POS] Error requesting device:', error);
      throw error;
    }
  }

  /**
   * Connect to Bluetooth printer
   */
  async connect(device?: WebBluetoothDevice): Promise<boolean> {
    try {
      const targetDevice = device || this.device;
      if (!targetDevice) {
        throw new Error('No device selected');
      }

      console.log('[ESC/POS] Connecting to device:', targetDevice.name);

      // Connect to GATT server
      const server = await targetDevice.gatt?.connect();
      if (!server) {
        throw new Error('Failed to connect to GATT server');
      }

      console.log('[ESC/POS] Connected to GATT server');

      // Try to get service and characteristic
      let service;
      let characteristic;

      // Try common service UUIDs
      const serviceUUIDs = ['fff0', '180a', '180f'];

      for (const uuid of serviceUUIDs) {
        try {
          service = await server.getPrimaryService(uuid);
          console.log('[ESC/POS] Found service:', uuid);
          break;
        } catch (e) {
          // Service not found, try next
        }
      }

      if (!service) {
        // If no specific service found, try to get any service
        const services = await server.getPrimaryServices();
        if (services.length > 0) {
          service = services[0];
          console.log('[ESC/POS] Using first available service');
        } else {
          throw new Error('No services found');
        }
      }

      // Try to get write characteristic
      try {
        const characteristics = await service.getCharacteristics();
        characteristic = characteristics.find(
          (c) =>
            c.properties.write ||
            c.properties.writeWithoutResponse
        );

        if (!characteristic) {
          throw new Error('No write characteristic found');
        }

        console.log('[ESC/POS] Found write characteristic');
      } catch (e) {
        console.error('[ESC/POS] Error getting characteristic:', e);
        throw e;
      }

      this.characteristic = characteristic;
      console.log('[ESC/POS] Connected successfully');
      return true;
    } catch (error) {
      console.error('[ESC/POS] Connection error:', error);
      throw error;
    }
  }

  /**
   * Send data to printer
   */
  private async sendData(data: Uint8Array): Promise<void> {
    if (!this.characteristic) {
      throw new Error('Not connected to printer');
    }

    try {
      // Split data into chunks if needed (max 512 bytes per write)
      const chunkSize = 512;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        await this.characteristic.writeValue(chunk);
        // Small delay between chunks
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.error('[ESC/POS] Error sending data:', error);
      throw error;
    }
  }

  /**
   * Convert string to Uint8Array
   */
  private stringToBytes(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Initialize printer
   */
  async initialize(): Promise<void> {
    const initSequence = this.ESC + '@'; // Reset printer
    await this.sendData(this.stringToBytes(initSequence));
    console.log('[ESC/POS] Printer initialized');
  }

  /**
   * Set text alignment
   */
  private setAlignment(align: 'left' | 'center' | 'right'): string {
    const alignCode = align === 'center' ? 1 : align === 'right' ? 2 : 0;
    return this.ESC + 'a' + String.fromCharCode(alignCode);
  }

  /**
   * Set text size
   */
  private setTextSize(width: number = 1, height: number = 1): string {
    return this.GS + '!' + String.fromCharCode((height - 1) * 16 + (width - 1));
  }

  /**
   * Set bold
   */
  private setBold(enabled: boolean): string {
    return this.ESC + 'E' + (enabled ? '\x01' : '\x00');
  }

  /**
   * Set underline
   */
  private setUnderline(enabled: boolean): string {
    return this.ESC + '-' + (enabled ? '\x01' : '\x00');
  }

  /**
   * Print text
   */
  private printText(text: string): string {
    return text + this.LF;
  }

  /**
   * Print line
   */
  private printLine(char: string = '-'): string {
    return char.repeat(this.config.charPerLine) + this.LF;
  }

  /**
   * Cut paper
   */
  private cutPaper(): string {
    return this.GS + 'V' + '\x00'; // Partial cut
  }

  /**
   * Open cash drawer
   */
  private openCashDrawer(): string {
    return this.ESC + 'p' + '\x00' + '\x19' + '\xFA';
  }

  /**
   * Print receipt from HTML
   */
  async printReceipt(receiptHtml: string, copies: number = 1): Promise<void> {
    try {
      if (!this.characteristic) {
        throw new Error('Not connected to printer');
      }

      console.log('[ESC/POS] Printing receipt...');

      // Parse receipt HTML and convert to ESC/POS
      const escPosCommands = this.htmlToESCPOS(receiptHtml);

      // Print multiple copies
      for (let i = 0; i < copies; i++) {
        await this.sendData(this.stringToBytes(escPosCommands));
        
        if (i < copies - 1) {
          // Delay between copies
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('[ESC/POS] Receipt printed successfully');
    } catch (error) {
      console.error('[ESC/POS] Error printing receipt:', error);
      throw error;
    }
  }

  /**
   * Convert HTML receipt to ESC/POS commands
   */
  private htmlToESCPOS(html: string): string {
    let escPos = this.ESC + '@';
    escPos += this.ESC + 't' + '\x00';
    escPos += this.ESC + '!' + '\x00';
    escPos += this.ESC + '2';

    // Extract text content from HTML
    const tempDiv = typeof document !== 'undefined' ? document.createElement('div') : null;
    let endLegalReceiptMarker = '';

    if (tempDiv) {
      tempDiv.innerHTML = html;
      const text = tempDiv.innerText;
      
      // Split into lines and process
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (this.isEndLegalReceiptMarker(trimmed)) {
          endLegalReceiptMarker = trimmed;
          continue;
        }

        const normalizedLine = trimmed.replace(/\t+/g, '    ');
        const shouldCenter =
          this.isLegalReceiptMarker(normalizedLine) ||
          this.isCopyMarker(normalizedLine) ||
          normalizedLine.startsWith('**VAT REGISTERED') ||
          normalizedLine.startsWith('**NON VAT REGISTERED');

        escPos += this.setAlignment(shouldCenter ? 'center' : 'left');
        escPos += this.printText(normalizedLine.substring(0, this.config.charPerLine));
      }
    }

    const qrPayload = this.extractQrPayload(html);
    if (qrPayload) {
      escPos += this.appendQRCode(qrPayload);
    }

    if (endLegalReceiptMarker) {
      escPos += this.setAlignment('center');
      escPos += this.printText(endLegalReceiptMarker);
    }

    // Cut paper
    escPos += this.ESC + 'd' + '\x03';
    escPos += this.cutPaper();

    return escPos;
  }

  private normalizeLegalMarker(line: string): string {
    return line.trim().replace(/^\*+|\*+$/g, '').trim().toLowerCase();
  }

  private isLegalReceiptMarker(line: string): boolean {
    const normalized = this.normalizeLegalMarker(line);
    return normalized === 'start of legal receipt' || normalized === 'end of legal receipt';
  }

  private isEndLegalReceiptMarker(line: string): boolean {
    return this.normalizeLegalMarker(line) === 'end of legal receipt';
  }

  private isCopyMarker(line: string): boolean {
    const normalized = this.normalizeLegalMarker(line);
    return normalized === 'copy' || normalized.startsWith('copy #');
  }

  private extractQrPayload(html: string): string {
    const srcMatches = html.matchAll(/src=(["'])(.*?)\1/g);
    for (const match of srcMatches) {
      const src = match[2] || '';
      if (!src.toLowerCase().includes('qr')) {
        continue;
      }

      const dataMatch = src.match(/[?&]data=([^&]+)/);
      const encodedValue = dataMatch?.[1]?.trim();
      if (!encodedValue) {
        continue;
      }

      try {
        const decoded = decodeURIComponent(encodedValue).trim();
        if (decoded) {
          return decoded;
        }
      } catch {
        return encodedValue;
      }
    }

    return '';
  }

  private appendQRCode(payload: string): string {
    const value = payload.trim();
    if (!value) {
      return '';
    }

    const maxLength = 7089;
    const safeValue = value.length > maxLength ? value.slice(0, maxLength) : value;
    const payloadLength = safeValue.length + 3;
    const pL = payloadLength & 0xff;
    const pH = (payloadLength >> 8) & 0xff;
    const moduleSize = this.config.paperWidth === 58 ? 4 : 5;

    let commands = this.LF;
    commands += this.setAlignment('center');
    commands += this.GS + '(k' + '\x04\x00\x31\x41\x32\x00';
    commands += this.GS + '(k' + '\x03\x00\x31\x43' + String.fromCharCode(moduleSize);
    commands += this.GS + '(k' + '\x03\x00\x31\x45\x31';
    commands += this.GS + '(k' + String.fromCharCode(pL, pH) + '\x31\x50\x30';
    commands += safeValue;
    commands += this.GS + '(k' + '\x03\x00\x31\x51\x30';
    commands += this.LF;
    commands += this.setAlignment('left');
    return commands;
  }

  /**
   * Disconnect from printer
   */
  async disconnect(): Promise<void> {
    try {
      if (this.device?.gatt?.connected) {
        await this.device.gatt.disconnect();
        console.log('[ESC/POS] Disconnected from printer');
      }
      this.characteristic = null;
    } catch (error) {
      console.error('[ESC/POS] Error disconnecting:', error);
    }
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return !!(this.device?.gatt?.connected && this.characteristic);
  }

  /**
   * Get connected device info
   */
  getDeviceInfo(): BluetoothPrinterDevice | null {
    if (!this.device) return null;

    return {
      id: this.device.id,
      name: this.device.name || 'Unknown',
      type: this.detectPrinterType(this.device.name || ''),
      isConnected: this.isConnected(),
      lastConnected: new Date().toISOString(),
    };
  }

  /**
   * Detect printer type from name
   */
  private detectPrinterType(name: string): 'sunmi' | 'star' | 'epson' | 'generic' {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('sunmi')) return 'sunmi';
    if (lowerName.includes('star')) return 'star';
    if (lowerName.includes('epson') || lowerName.includes('tm-')) return 'epson';
    return 'generic';
  }

  /**
   * Get list of paired devices
   */
  async getPairedDevices(): Promise<BluetoothPrinterDevice[]> {
    try {
      if (!this.supportsWebBluetooth()) {
        return [];
      }

      // Note: Web Bluetooth API doesn't provide a way to list paired devices
      // This is a security feature. Users must use requestDevice() to select.
      console.log('[ESC/POS] Web Bluetooth API does not expose paired devices list');
      return [];
    } catch (error) {
      console.error('[ESC/POS] Error getting paired devices:', error);
      return [];
    }
  }
}

export const escPosService = new ESCPOSService();
