'use client';

import React, { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, Lock, Unlock, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

interface ComplianceItem {
  id: string;
  name: string;
  mraProductCode: string;
  taxType: string;
  taxRate: number;
  priceLocked: boolean;
  taxLocked: boolean;
  isApproved: boolean;
  mraSynced: boolean;
  lastSyncedAt?: string;
}

interface MRAComplianceTabProps {
  inventoryData?: any[];
  businessId?: string;
}

export function MRAComplianceTab({ inventoryData = [], businessId }: MRAComplianceTabProps) {
  const [complianceItems, setComplianceItems] = useState<ComplianceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<ComplianceItem | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Load compliance data
  useEffect(() => {
    const loadComplianceData = async () => {
      if (!businessId) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        const response = await authFetch.fetch<any>(
          `/inventory/mra-mappings/?business_id=${businessId}`
        );

        if (response && Array.isArray(response)) {
          const items = response.map((item: any) => ({
            id: item.id,
            name: item.inventory_item_name || item.product_name,
            mraProductCode: item.mra_product_code,
            taxType: item.mra_tax_type,
            taxRate: parseFloat(item.mra_tax_rate),
            priceLocked: item.price_locked || false,
            taxLocked: item.tax_locked || true,
            isApproved: item.is_approved,
            mraSynced: item.mra_synced,
            lastSyncedAt: item.last_synced_at,
          }));
          setComplianceItems(items);
        } else if (response?.results && Array.isArray(response.results)) {
          const items = response.results.map((item: any) => ({
            id: item.id,
            name: item.inventory_item_name || item.product_name,
            mraProductCode: item.mra_product_code,
            taxType: item.mra_tax_type,
            taxRate: parseFloat(item.mra_tax_rate),
            priceLocked: item.price_locked || false,
            taxLocked: item.tax_locked || true,
            isApproved: item.is_approved,
            mraSynced: item.mra_synced,
            lastSyncedAt: item.last_synced_at,
          }));
          setComplianceItems(items);
        }
      } catch (error) {
        console.error('Failed to load compliance data:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load MRA compliance data',
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadComplianceData();
  }, [businessId]);

  const handleSyncItem = async (itemId: string) => {
    try {
      setIsSyncing(true);
      await authFetch.fetch<any>(
        `/inventory/mra-mappings/${itemId}/sync/`,
        { method: 'POST' }
      );

      // Update local state
      setComplianceItems(items =>
        items.map(item =>
          item.id === itemId
            ? { ...item, mraSynced: true, lastSyncedAt: new Date().toISOString() }
            : item
        )
      );

      toast({
        title: 'Success',
        description: 'Product synced to MRA',
      });
    } catch (error) {
      console.error('Failed to sync item:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to sync product to MRA',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const getTaxTypeColor = (taxType: string) => {
    switch (taxType) {
      case 'standard':
        return 'bg-blue-100 text-blue-800';
      case 'zero':
        return 'bg-green-100 text-green-800';
      case 'exempt':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTaxTypeLabel = (taxType: string) => {
    switch (taxType) {
      case 'standard':
        return 'Standard (16.5%)';
      case 'zero':
        return 'Zero Rated (0%)';
      case 'exempt':
        return 'Exempt';
      default:
        return taxType;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Compliance Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Products</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{complianceItems.length}</div>
            <p className="text-xs text-muted-foreground mt-1">MRA mapped products</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {complianceItems.filter(i => i.isApproved).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">MRA approved</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Synced</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {complianceItems.filter(i => i.mraSynced).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Synced to MRA</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Price Locked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">
              {complianceItems.filter(i => i.priceLocked).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Locked by MRA</p>
          </CardContent>
        </Card>
      </div>

      {/* Compliance Details */}
      <Card>
        <CardHeader>
          <CardTitle>Product Compliance Status</CardTitle>
          <CardDescription>
            View MRA compliance status for all products
          </CardDescription>
        </CardHeader>
        <CardContent>
          {complianceItems.length === 0 ? (
            <div className="text-center py-8">
              <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No MRA-mapped products found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product Name</TableHead>
                    <TableHead>MRA Code</TableHead>
                    <TableHead>Tax Type</TableHead>
                    <TableHead>Tax Rate</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Locks</TableHead>
                    <TableHead>Sync</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {complianceItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="font-mono text-sm">{item.mraProductCode}</TableCell>
                      <TableCell>
                        <Badge className={getTaxTypeColor(item.taxType)}>
                          {getTaxTypeLabel(item.taxType)}
                        </Badge>
                      </TableCell>
                      <TableCell>{item.taxRate.toFixed(2)}%</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {item.isApproved ? (
                            <Badge variant="outline" className="bg-green-50 text-green-700">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Approved
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-yellow-50 text-yellow-700">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Pending
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {item.priceLocked && (
                            <div className="flex items-center gap-1 text-xs bg-amber-50 px-2 py-1 rounded">
                              <Lock className="h-3 w-3 text-amber-600" />
                              <span className="text-amber-700">Price</span>
                            </div>
                          )}
                          {item.taxLocked && (
                            <div className="flex items-center gap-1 text-xs bg-blue-50 px-2 py-1 rounded">
                              <Lock className="h-3 w-3 text-blue-600" />
                              <span className="text-blue-700">Tax</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {item.mraSynced ? (
                          <div className="flex items-center gap-1 text-xs text-green-600">
                            <CheckCircle2 className="h-3 w-3" />
                            Synced
                          </div>
                        ) : (
                          <Badge variant="outline" className="bg-red-50 text-red-700">
                            Not Synced
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedItem(item);
                              setIsDetailDialogOpen(true);
                            }}
                          >
                            View
                          </Button>
                          {!item.mraSynced && (
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => handleSyncItem(item.id)}
                              disabled={isSyncing}
                            >
                              {isSyncing ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Product Compliance Details</DialogTitle>
            <DialogDescription>
              View detailed MRA compliance information
            </DialogDescription>
          </DialogHeader>

          {selectedItem && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Product Name</label>
                <p className="text-sm text-muted-foreground mt-1">{selectedItem.name}</p>
              </div>

              <div>
                <label className="text-sm font-medium">MRA Product Code</label>
                <p className="font-mono text-sm text-muted-foreground mt-1">
                  {selectedItem.mraProductCode}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Tax Type</label>
                  <Badge className={`${getTaxTypeColor(selectedItem.taxType)} mt-1`}>
                    {getTaxTypeLabel(selectedItem.taxType)}
                  </Badge>
                </div>

                <div>
                  <label className="text-sm font-medium">Tax Rate</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedItem.taxRate.toFixed(2)}%
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">MRA Approval</label>
                  <div className="mt-1">
                    {selectedItem.isApproved ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Approved
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-yellow-50 text-yellow-700">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Pending
                      </Badge>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium">MRA Sync</label>
                  <div className="mt-1">
                    {selectedItem.mraSynced ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Synced
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-red-50 text-red-700">
                        Not Synced
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Price Locked</label>
                  {selectedItem.priceLocked ? (
                    <div className="flex items-center gap-1 text-amber-600">
                      <Lock className="h-4 w-4" />
                      <span className="text-sm">Locked</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-gray-600">
                      <Unlock className="h-4 w-4" />
                      <span className="text-sm">Unlocked</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Tax Locked</label>
                  {selectedItem.taxLocked ? (
                    <div className="flex items-center gap-1 text-blue-600">
                      <Lock className="h-4 w-4" />
                      <span className="text-sm">Locked</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-gray-600">
                      <Unlock className="h-4 w-4" />
                      <span className="text-sm">Unlocked</span>
                    </div>
                  )}
                </div>
              </div>

              {selectedItem.lastSyncedAt && (
                <div className="text-xs text-muted-foreground border-t pt-4">
                  Last synced: {new Date(selectedItem.lastSyncedAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
