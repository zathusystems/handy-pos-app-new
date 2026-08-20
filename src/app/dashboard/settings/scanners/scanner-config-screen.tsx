'use client';

import React, { useState, useEffect } from 'react';
import { Barcode, Plus, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { scannerService, type ScannerConfig, type ScannerSettings } from '@/lib/services/scanner-service';
import { scannerDiscoveryService, type DiscoveredScanner } from '@/lib/services/scanner-discovery-service';
import { v4 as uuidv4 } from 'uuid';
import { Loader2, Search } from 'lucide-react';

export function ScannerConfigScreen() {
  const { toast } = useToast();
  const [scanners, setScanners] = useState<ScannerConfig[]>([]);
  const [settings, setSettings] = useState<ScannerSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddingScanner, setIsAddingScanner] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [discoveredScanners, setDiscoveredScanners] = useState<DiscoveredScanner[]>([]);

  const branchId = localStorage.getItem('handypos-active-branch') || 'main';

  // Load scanners and settings
  useEffect(() => {
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
  }, [branchId, toast]);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">Loading scanner configuration...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Scanners List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Barcode className="h-5 w-5" />
                Configured Scanners
              </CardTitle>
              <CardDescription>
                Manage barcode scanners for your POS system
              </CardDescription>
            </div>
            <Dialog open={isAddingScanner} onOpenChange={setIsAddingScanner}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Scanner
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Scan and Add Scanner</DialogTitle>
                  <DialogDescription>
                    Scan for available barcode scanners and add them to your system
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
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
                      <div className="space-y-2 max-h-64 overflow-y-auto">
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
                                  type: scanner.type,
                                  connectionType: scanner.type,
                                  isDefault: scanners.length === 0,
                                  isEnabled: true,
                                  autoDetect: true,
                                  barcodeFormat: 'all',
                                  createdAt: new Date().toISOString(),
                                  updatedAt: new Date().toISOString(),
                                };

                                await scannerService.saveScannerConfig(newScanner);
                                setScanners([...scanners, newScanner]);

                                toast({
                                  title: 'Success',
                                  description: `${scanner.name} added successfully`,
                                });

                                setIsAddingScanner(false);
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

                  {discoveredScanners.length === 0 && !isScanning && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Barcode className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">Click "Scan for Scanners" to find available devices</p>
                    </div>
                  )}
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsAddingScanner(false);
                      setDiscoveredScanners([]);
                    }}
                  >
                    Close
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {scanners.length === 0 ? (
            <div className="text-center py-8">
              <Barcode className="h-12 w-12 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-muted-foreground">No scanners configured yet</p>
              <p className="text-sm text-muted-foreground">Add a scanner to enable barcode scanning</p>
            </div>
          ) : (
            <div className="space-y-3">
              {scanners.map((scanner) => (
                <div key={scanner.id} className="flex items-center justify-between rounded-lg border p-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{scanner.name}</h3>
                      {scanner.isDefault && (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          Default
                        </span>
                      )}
                      {!scanner.isEnabled && (
                        <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {scanner.type.charAt(0).toUpperCase() + scanner.type.slice(1)} • {scanner.barcodeFormat}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={scanner.isEnabled}
                      onCheckedChange={(checked) => handleToggleScanner(scanner.id, checked)}
                    />
                    {!scanner.isDefault && (
                      <Button size="sm" variant="outline" onClick={() => handleSetDefault(scanner.id)}>
                        Set Default
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
          )}
        </CardContent>
      </Card>

      {/* Scanner Settings */}
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>Scanner Settings</CardTitle>
            <CardDescription>Configure default scanning behavior</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Auto-Detect Scanner</Label>
                  <p className="text-sm text-muted-foreground">Automatically detect connected scanners</p>
                </div>
                <Switch
                  checked={settings.autoDetect}
                  onCheckedChange={(checked) => setSettings({ ...settings, autoDetect: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Continuous Scanning</Label>
                  <p className="text-sm text-muted-foreground">Keep scanner active between scans</p>
                </div>
                <Switch
                  checked={settings.continuousScanning}
                  onCheckedChange={(checked) => setSettings({ ...settings, continuousScanning: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Sound on Scan</Label>
                  <p className="text-sm text-muted-foreground">Play beep sound when barcode is scanned</p>
                </div>
                <Switch
                  checked={settings.soundOnScan}
                  onCheckedChange={(checked) => setSettings({ ...settings, soundOnScan: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Vibration on Scan</Label>
                  <p className="text-sm text-muted-foreground">Vibrate device when barcode is scanned</p>
                </div>
                <Switch
                  checked={settings.vibrationOnScan}
                  onCheckedChange={(checked) => setSettings({ ...settings, vibrationOnScan: checked })}
                />
              </div>
            </div>

            <Button onClick={handleSaveSettings} className="w-full">
              Save Settings
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Test Scan */}
      <Card>
        <CardHeader>
          <CardTitle>Test Scan</CardTitle>
          <CardDescription>Test your scanner configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={async () => {
              try {
                await scannerService.testScan('1234567890');
                toast({
                  title: 'Success',
                  description: 'Test scan completed - check console for barcode',
                });
              } catch (error) {
                console.error('Error testing scanner:', error);
                toast({
                  variant: 'destructive',
                  title: 'Error',
                  description: 'Failed to test scanner',
                });
              }
            }}
          >
            Test Scanner
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
