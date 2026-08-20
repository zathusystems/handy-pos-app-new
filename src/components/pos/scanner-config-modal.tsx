'use client';

import React, { useState, useEffect } from 'react';
import { Barcode, Trash2, Check, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { scannerService, type ScannerConfig, type ScannerSettings } from '@/lib/services/scanner-service';
import { scannerDiscoveryService, type DiscoveredScanner } from '@/lib/services/scanner-discovery-service';
import { safeLocalStorageGetItem } from '@/lib/safe-local-storage';
import { v4 as uuidv4 } from 'uuid';

interface ScannerConfigModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScannerConfigModal({ isOpen, onOpenChange }: ScannerConfigModalProps) {
  const { toast } = useToast();
  const [scanners, setScanners] = useState<ScannerConfig[]>([]);
  const [settings, setSettings] = useState<ScannerSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [discoveredScanners, setDiscoveredScanners] = useState<DiscoveredScanner[]>([]);

  const branchId = safeLocalStorageGetItem('handypos-active-branch') || 'main';

  // Load scanners and settings
  useEffect(() => {
    if (!isOpen) return;

    const loadData = async () => {
      try {
        setIsLoading(true);
        const [scannersList, scannerSettings] = await Promise.all([
          scannerService.getScannerConfigs(branchId),
          scannerService.getScannerSettings(branchId),
        ]);
        setScanners(scannersList);
        setSettings(scannerSettings);
      } catch (error) {
        console.error('Error loading scanner data:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load scanner configuration',
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [isOpen, branchId, toast]);

  const handleDeleteScanner = async (scannerId: string) => {
    try {
      await scannerService.deleteScannerConfig(scannerId, branchId);
      setScanners(scanners.filter(s => s.id !== scannerId));
      toast({
        title: 'Success',
        description: 'Scanner deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting scanner:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete scanner',
      });
    }
  };

  const handleSetDefault = async (scannerId: string) => {
    try {
      const updatedScanners = scanners.map(s => ({
        ...s,
        isDefault: s.id === scannerId,
      }));

      for (const scanner of updatedScanners) {
        await scannerService.saveScannerConfig(scanner);
      }

      setScanners(updatedScanners);
      toast({
        title: 'Success',
        description: 'Default scanner updated',
      });
    } catch (error) {
      console.error('Error setting default scanner:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to set default scanner',
      });
    }
  };

  const handleToggleScanner = async (scannerId: string, isEnabled: boolean) => {
    try {
      const scanner = scanners.find(s => s.id === scannerId);
      if (!scanner) return;

      const updated = { ...scanner, isEnabled };
      await scannerService.saveScannerConfig(updated);

      setScanners(scanners.map(s => (s.id === scannerId ? updated : s)));
      toast({
        title: 'Success',
        description: `Scanner ${isEnabled ? 'enabled' : 'disabled'}`,
      });
    } catch (error) {
      console.error('Error toggling scanner:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update scanner',
      });
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      await scannerService.saveScannerSettings(settings);
      toast({
        title: 'Success',
        description: 'Scanner settings saved successfully',
      });
    } catch (error) {
      console.error('Error saving settings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save scanner settings',
      });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Barcode className="h-5 w-5" />
            Scanner Configuration
          </DialogTitle>
          <DialogDescription>
            Manage barcode scanners for your POS system
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <p className="text-muted-foreground">Loading scanner configuration...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Scan for Scanners */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm">Add Scanner</h3>
              <Button
                onClick={async () => {
                  try {
                    setIsScanning(true);
                    const discovered = await scannerDiscoveryService.scanScanners();
                    setDiscoveredScanners(discovered);

                    if (discovered.length === 0) {
                      toast({
                        title: 'No Scanners Found',
                        description: 'Make sure your scanner is connected and powered on.',
                      });
                    } else {
                      toast({
                        title: 'Success',
                        description: `Found ${discovered.length} scanner(s)`,
                      });
                    }
                  } catch (error) {
                    console.error('Error scanning scanners:', error);
                    toast({
                      variant: 'destructive',
                      title: 'Scan Failed',
                      description: error instanceof Error ? error.message : 'Failed to scan for scanners',
                    });
                  } finally {
                    setIsScanning(false);
                  }
                }}
                disabled={isScanning}
                className="w-full"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Scan for Scanners
                  </>
                )}
              </Button>

              {discoveredScanners.length > 0 && (
                <div className="space-y-2">
                  <Label>Available Scanners</Label>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {discoveredScanners.map((scanner) => (
                      <div
                        key={scanner.id}
                        className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted cursor-pointer transition-colors"
                        onClick={async () => {
                          try {
                            const newScanner: ScannerConfig = {
                              id: uuidv4(),
                              branchId,
                              name: scanner.name,
                              type: scanner.type as 'usb' | 'bluetooth' | 'network' | 'camera',
                              connectionType: scanner.type as 'usb' | 'bluetooth' | 'network' | 'camera',
                              isDefault: scanners.length === 0,
                              isEnabled: true,
                              autoDetect: true,
                              barcodeFormat: 'all' as 'code128' | 'ean13' | 'ean8' | 'upca' | 'qrcode' | 'all',
                              createdAt: new Date().toISOString(),
                              updatedAt: new Date().toISOString(),
                            };

                            await scannerService.saveScannerConfig(newScanner);
                            setScanners([...scanners, newScanner]);

                            toast({
                              title: 'Success',
                              description: `${scanner.name} added successfully`,
                            });

                            setDiscoveredScanners([]);
                          } catch (error) {
                            console.error('Error adding scanner:', error);
                            toast({
                              variant: 'destructive',
                              title: 'Error',
                              description: 'Failed to add scanner',
                            });
                          }
                        }}
                      >
                        <div className="flex-1">
                          <p className="font-medium text-sm">{scanner.name}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                              {scanner.type}
                            </span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                scanner.status === 'ready'
                                  ? 'bg-green-100 text-green-800'
                                  : scanner.status === 'offline'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-yellow-100 text-yellow-800'
                              }`}
                            >
                              {scanner.status}
                            </span>
                          </div>
                        </div>
                        <Check className="h-5 w-5 text-green-600 flex-shrink-0" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Configured Scanners */}
            {scanners.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Configured Scanners</h3>
                <div className="space-y-2">
                  {scanners.map((scanner) => (
                    <div key={scanner.id} className="flex items-center justify-between rounded-lg border p-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{scanner.name}</p>
                          {scanner.isDefault && (
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {scanner.type} • {scanner.barcodeFormat}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={scanner.isEnabled}
                          onCheckedChange={(checked) => handleToggleScanner(scanner.id, checked)}
                        />
                        {!scanner.isDefault && (
                          <Button size="sm" variant="outline" onClick={() => handleSetDefault(scanner.id)}>
                            Default
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeleteScanner(scanner.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Scanner Settings */}
            {settings && (
              <div className="space-y-3 border-t pt-4">
                <h3 className="font-semibold text-sm">Settings</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Sound on Scan</Label>
                    <Switch
                      checked={settings.soundOnScan}
                      onCheckedChange={(checked) => setSettings({ ...settings, soundOnScan: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Vibration on Scan</Label>
                    <Switch
                      checked={settings.vibrationOnScan}
                      onCheckedChange={(checked) => setSettings({ ...settings, vibrationOnScan: checked })}
                    />
                  </div>
                  <Button onClick={handleSaveSettings} className="w-full mt-2">
                    Save Settings
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
