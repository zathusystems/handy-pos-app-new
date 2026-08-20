'use client';

/**
 * Scanner Discovery Service
 * Detects available barcode scanners
 */

export interface DiscoveredScanner {
  id: string;
  name: string;
  type: 'usb' | 'bluetooth' | 'network' | 'camera';
  status: 'ready' | 'offline' | 'error' | 'unknown';
  description?: string;
}

class ScannerDiscoveryService {
  /**
   * Scan for available scanners
   */
  async scanScanners(): Promise<DiscoveredScanner[]> {
    try {
      console.log('[ScannerDiscovery] Starting scanner scan...');

      const scanners: DiscoveredScanner[] = [];

      // Method 1: Check for USB HID devices
      if (this.supportsWebHID()) {
        console.log('[ScannerDiscovery] Checking USB HID devices');
        const usbScanners = await this.scanUSBScanners();
        scanners.push(...usbScanners);
      }

      // Method 2: Check for camera/video input (for camera-based scanners)
      if (this.supportsMediaDevices()) {
        console.log('[ScannerDiscovery] Checking camera devices');
        const cameraScanners = await this.scanCameraScanners();
        scanners.push(...cameraScanners);
      }

      // Method 3: Add generic USB scanner option
      scanners.push({
        id: 'generic-usb-scanner',
        name: 'Generic USB Scanner',
        type: 'usb',
        status: 'ready',
        description: 'Standard USB barcode scanner (keyboard emulation)',
      });

      // Method 4: Add Bluetooth scanner option
      if (this.supportsWebBluetooth()) {
        scanners.push({
          id: 'bluetooth-scanner',
          name: 'Bluetooth Scanner',
          type: 'bluetooth',
          status: 'unknown',
          description: 'Bluetooth barcode scanner',
        });
      }

      console.log('[ScannerDiscovery] Found', scanners.length, 'scanners');
      return scanners;
    } catch (error) {
      console.error('[ScannerDiscovery] Error scanning scanners:', error);
      return [];
    }
  }

  /**
   * Scan for USB HID scanners
   */
  private async scanUSBScanners(): Promise<DiscoveredScanner[]> {
    try {
      if (!this.supportsWebHID()) {
        return [];
      }

      const devices = await (navigator as any).hid.getDevices();
      const scanners: DiscoveredScanner[] = [];

      for (const device of devices) {
        // Check if device is a barcode scanner
        if (this.isBarcodeScannerDevice(device)) {
          scanners.push({
            id: device.productId.toString(),
            name: device.productName || 'USB Barcode Scanner',
            type: 'usb',
            status: 'ready',
            description: `USB Scanner - ${device.manufacturerName || 'Unknown'}`,
          });
        }
      }

      return scanners;
    } catch (error) {
      console.error('[ScannerDiscovery] Error scanning USB devices:', error);
      return [];
    }
  }

  /**
   * Scan for camera-based scanners
   */
  private async scanCameraScanners(): Promise<DiscoveredScanner[]> {
    try {
      if (!this.supportsMediaDevices()) {
        return [];
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const scanners: DiscoveredScanner[] = [];

      for (const device of devices) {
        if (device.kind === 'videoinput') {
          scanners.push({
            id: device.deviceId,
            name: device.label || 'Camera Scanner',
            type: 'camera',
            status: 'ready',
            description: 'Camera-based barcode scanner',
          });
        }
      }

      return scanners;
    } catch (error) {
      console.error('[ScannerDiscovery] Error scanning camera devices:', error);
      return [];
    }
  }

  /**
   * Check if device is a barcode scanner
   */
  private isBarcodeScannerDevice(device: any): boolean {
    const name = (device.productName || '').toLowerCase();
    const manufacturer = (device.manufacturerName || '').toLowerCase();

    const scannerKeywords = [
      'scanner',
      'barcode',
      'qr',
      'code',
      'honeywell',
      'zebra',
      'symbol',
      'datalogic',
      'intermec',
      'motorola',
      'newland',
      'sunmi',
    ];

    return (
      scannerKeywords.some(keyword => name.includes(keyword)) ||
      scannerKeywords.some(keyword => manufacturer.includes(keyword))
    );
  }

  /**
   * Request Bluetooth scanner
   */
  async requestBluetoothScanner(): Promise<DiscoveredScanner | null> {
    try {
      if (!this.supportsWebBluetooth()) {
        throw new Error('Web Bluetooth API not supported');
      }

      console.log('[ScannerDiscovery] Requesting Bluetooth device...');

      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [
          { name: /Scanner/ },
          { name: /Barcode/ },
          { name: /QR/ },
          { name: /Honeywell/ },
          { name: /Zebra/ },
          { name: /Symbol/ },
        ],
        optionalServices: ['device_information', 'generic_access'],
      });

      if (!device) {
        return null;
      }

      return {
        id: device.id,
        name: device.name || 'Bluetooth Scanner',
        type: 'bluetooth',
        status: 'ready',
        description: `Bluetooth: ${device.name}`,
      };
    } catch (error) {
      console.error('[ScannerDiscovery] Error requesting Bluetooth scanner:', error);
      if (error instanceof Error && error.name === 'NotFoundError') {
        throw new Error('No Bluetooth scanner found. Make sure your scanner is in pairing mode.');
      }
      throw error;
    }
  }

  /**
   * Check if Web HID is supported
   */
  private supportsWebHID(): boolean {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  /**
   * Check if Web Bluetooth is supported
   */
  private supportsWebBluetooth(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /**
   * Check if Media Devices API is supported
   */
  private supportsMediaDevices(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'mediaDevices' in navigator &&
      'enumerateDevices' in navigator.mediaDevices
    );
  }

  /**
   * Get browser capabilities
   */
  getCapabilities(): {
    supportsWebHID: boolean;
    supportsWebBluetooth: boolean;
    supportsMediaDevices: boolean;
    supportedBrowsers: string[];
  } {
    return {
      supportsWebHID: this.supportsWebHID(),
      supportsWebBluetooth: this.supportsWebBluetooth(),
      supportsMediaDevices: this.supportsMediaDevices(),
      supportedBrowsers: [
        'Chrome/Chromium (full support)',
        'Edge (full support)',
        'Opera (full support)',
        'Firefox (limited support)',
        'Safari (limited support)',
      ],
    };
  }
}

export const scannerDiscoveryService = new ScannerDiscoveryService();
