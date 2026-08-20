'use client';

/**
 * Scanner Service
 * Manages barcode scanner configuration and detection
 */

export interface ScannerConfig {
  id: string;
  branchId: string;
  name: string;
  type: 'usb' | 'bluetooth' | 'network' | 'camera';
  connectionType: 'usb' | 'bluetooth' | 'network' | 'camera';
  isDefault: boolean;
  isEnabled: boolean;
  autoDetect: boolean;
  scannerDeviceId?: string;
  scannerDeviceName?: string;
  barcodeFormat?: 'code128' | 'ean13' | 'ean8' | 'upca' | 'qrcode' | 'all';
  createdAt: string;
  updatedAt: string;
}

export interface ScannerSettings {
  branchId: string;
  autoDetect: boolean;
  continuousScanning: boolean;
  soundOnScan: boolean;
  vibrationOnScan: boolean;
  scanDelay: number; // milliseconds between scans
  createdAt: string;
  updatedAt: string;
}

class ScannerService {
  private scannerConfigs: Map<string, ScannerConfig> = new Map();
  private scannerSettings: Map<string, ScannerSettings> = new Map();
  private scanListeners: Map<string, (barcode: string) => void> = new Map();

  /**
   * Initialize scanner service
   */
  async initialize(branchId: string): Promise<void> {
    try {
      console.log('[Scanner] Initializing scanner service for branch:', branchId);

      // Load scanner configs from localStorage
      const storedConfigs = localStorage.getItem(`scanner-configs-${branchId}`);
      if (storedConfigs) {
        try {
          const configs = JSON.parse(storedConfigs);
          configs.forEach((config: ScannerConfig) => {
            this.scannerConfigs.set(config.id, config);
          });
          console.log('[Scanner] Loaded', configs.length, 'scanner configs from localStorage');
        } catch (e) {
          console.error('[Scanner] Failed to parse scanner configs:', e);
        }
      }

      // Load scanner settings
      const storedSettings = localStorage.getItem(`scanner-settings-${branchId}`);
      if (storedSettings) {
        try {
          const settings = JSON.parse(storedSettings);
          this.scannerSettings.set(branchId, settings);
          console.log('[Scanner] Loaded scanner settings from localStorage');
        } catch (e) {
          console.error('[Scanner] Failed to parse scanner settings:', e);
        }
      }

      // Start listening for keyboard input (USB scanners typically emit keyboard events)
      this.setupKeyboardListener();
    } catch (error) {
      console.error('[Scanner] Error initializing scanner service:', error);
    }
  }

  /**
   * Setup keyboard listener for USB scanners
   */
  private setupKeyboardListener(): void {
    if (typeof window === 'undefined') return;

    let scanBuffer = '';
    let scanTimeout: NodeJS.Timeout;

    window.addEventListener('keydown', (event) => {
      // Only capture if not typing in an input field
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Accumulate characters
      if (event.key.length === 1) {
        scanBuffer += event.key;
      }

      // Clear timeout and set new one
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        if (scanBuffer.length > 0) {
          this.processScan(scanBuffer);
          scanBuffer = '';
        }
      }, 100); // 100ms timeout for scan completion
    });
  }

  /**
   * Process barcode scan
   */
  private processScan(barcode: string): void {
    console.log('[Scanner] Barcode scanned:', barcode);

    // Play sound if enabled
    this.playScanSound();

    // Trigger vibration if enabled
    this.triggerVibration();

    // Notify all listeners
    this.scanListeners.forEach((listener) => {
      listener(barcode);
    });
  }

  /**
   * Play scan sound
   */
  private playScanSound(): void {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800; // 800 Hz beep
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch (error) {
      console.warn('[Scanner] Could not play scan sound:', error);
    }
  }

  /**
   * Trigger vibration feedback
   */
  private triggerVibration(): void {
    if (navigator.vibrate) {
      navigator.vibrate(50); // 50ms vibration
    }
  }

  /**
   * Register scan listener
   */
  onScan(listenerId: string, callback: (barcode: string) => void): void {
    this.scanListeners.set(listenerId, callback);
    console.log('[Scanner] Registered scan listener:', listenerId);
  }

  /**
   * Unregister scan listener
   */
  offScan(listenerId: string): void {
    this.scanListeners.delete(listenerId);
    console.log('[Scanner] Unregistered scan listener:', listenerId);
  }

  /**
   * Get all scanner configs for a branch
   */
  async getScannerConfigs(branchId: string): Promise<ScannerConfig[]> {
    await this.initialize(branchId);
    return Array.from(this.scannerConfigs.values()).filter(s => s.branchId === branchId);
  }

  /**
   * Get default scanner for a branch
   */
  async getDefaultScanner(branchId: string): Promise<ScannerConfig | null> {
    const configs = await this.getScannerConfigs(branchId);
    return configs.find(s => s.isDefault && s.isEnabled) || null;
  }

  /**
   * Save scanner config
   */
  async saveScannerConfig(config: ScannerConfig): Promise<void> {
    try {
      console.log('[Scanner] Saving scanner config:', config.id);

      // If this is the new default, unset other defaults
      if (config.isDefault) {
        const configs = await this.getScannerConfigs(config.branchId);
        for (const existing of configs) {
          if (existing.id !== config.id && existing.isDefault) {
            existing.isDefault = false;
            this.scannerConfigs.set(existing.id, existing);
          }
        }
      }

      this.scannerConfigs.set(config.id, config);

      // Save to localStorage
      const configs = Array.from(this.scannerConfigs.values()).filter(
        s => s.branchId === config.branchId
      );
      localStorage.setItem(`scanner-configs-${config.branchId}`, JSON.stringify(configs));

      console.log('[Scanner] Scanner config saved successfully');
    } catch (error) {
      console.error('[Scanner] Error saving scanner config:', error);
      throw error;
    }
  }

  /**
   * Delete scanner config
   */
  async deleteScannerConfig(scannerId: string, branchId: string): Promise<void> {
    try {
      console.log('[Scanner] Deleting scanner config:', scannerId);

      this.scannerConfigs.delete(scannerId);

      // Save to localStorage
      const configs = Array.from(this.scannerConfigs.values()).filter(s => s.branchId === branchId);
      localStorage.setItem(`scanner-configs-${branchId}`, JSON.stringify(configs));

      console.log('[Scanner] Scanner config deleted successfully');
    } catch (error) {
      console.error('[Scanner] Error deleting scanner config:', error);
      throw error;
    }
  }

  /**
   * Get scanner settings for a branch
   */
  async getScannerSettings(branchId: string): Promise<ScannerSettings> {
    await this.initialize(branchId);

    if (this.scannerSettings.has(branchId)) {
      return this.scannerSettings.get(branchId)!;
    }

    // Return default settings
    return {
      branchId,
      autoDetect: true,
      continuousScanning: true,
      soundOnScan: true,
      vibrationOnScan: true,
      scanDelay: 100,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Save scanner settings
   */
  async saveScannerSettings(settings: ScannerSettings): Promise<void> {
    try {
      console.log('[Scanner] Saving scanner settings for branch:', settings.branchId);

      settings.updatedAt = new Date().toISOString();
      this.scannerSettings.set(settings.branchId, settings);

      // Save to localStorage
      localStorage.setItem(`scanner-settings-${settings.branchId}`, JSON.stringify(settings));

      console.log('[Scanner] Scanner settings saved successfully');
    } catch (error) {
      console.error('[Scanner] Error saving scanner settings:', error);
      throw error;
    }
  }

  /**
   * Test scanner by simulating a scan
   */
  async testScan(testBarcode: string = '1234567890'): Promise<void> {
    console.log('[Scanner] Testing scanner with barcode:', testBarcode);
    this.processScan(testBarcode);
  }

  /**
   * Check if scanner is available
   */
  isScannerAvailable(): boolean {
    return typeof window !== 'undefined';
  }

  /**
   * Get supported barcode formats
   */
  getSupportedFormats(): string[] {
    return ['code128', 'ean13', 'ean8', 'upca', 'qrcode', 'all'];
  }
}

export const scannerService = new ScannerService();
