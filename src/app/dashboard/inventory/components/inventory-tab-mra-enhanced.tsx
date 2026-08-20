'use client';

import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Lock,
  AlertTriangle,
  Eye,
  EyeOff,
} from 'lucide-react';
import { type InventoryItem } from '@/lib/db';
import { useIsMobile } from '@/hooks/use-mobile';

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
} from '@/components/ui/dialog';

interface InventoryTabMRAEnhancedProps {
  inventoryData: InventoryItem[];
  onAddItem: () => void;
  onEditItem: (item: InventoryItem) => void;
  onTransfer: () => void;
}

export function InventoryTabMRAEnhanced({
  inventoryData,
  onAddItem,
  onEditItem,
  onTransfer,
}: InventoryTabMRAEnhancedProps) {
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [showMRADetails, setShowMRADetails] = useState(false);
  const isMobile = useIsMobile();

  // Filter sellable items only
  const sellableItems = inventoryData.filter(item => item.itemType === 'sellable');

  // Calculate MRA compliance stats
  const stats = {
    total: sellableItems.length,
    mraReady: sellableItems.filter(item => item.is_mra_ready).length,
    priceLocked: sellableItems.filter(item => item.price_locked).length,
    taxLocked: sellableItems.filter(item => item.tax_locked).length,
  };

  const getMRAStatus = (item: InventoryItem) => {
    if (!item.is_mra_ready) {
      return {
        label: 'Not Ready',
        color: 'bg-red-100 text-red-800',
        icon: AlertTriangle,
      };
    }
    return {
      label: 'MRA Ready',
      color: 'bg-green-100 text-green-800',
      icon: CheckCircle2,
    };
  };

  return (
    <div className="space-y-6 p-6">
      {/* MRA Compliance Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Products</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">MRA Ready</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.mraReady}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Price Locked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.priceLocked}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Tax Locked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">{stats.taxLocked}</div>
          </CardContent>
        </Card>
      </div>

      {/* MRA Compliance Info */}
      <Card className="bg-blue-50 border-blue-200">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-blue-600" />
            MRA Compliance Status
          </CardTitle>
          <CardDescription>
            Products must be mapped to MRA codes and approved before they can be sold
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Inventory Table with MRA Fields */}
      <Card>
        <CardHeader>
          <CardTitle>Inventory Items</CardTitle>
          <CardDescription>
            {sellableItems.length} sellable products
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sellableItems.length === 0 ? (
            <div className="text-center py-12">
              <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-4">No sellable products found</p>
              <Button onClick={onAddItem}>Add Product</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product Name</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>MRA Status</TableHead>
                    <TableHead>Locks</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sellableItems.map((item) => {
                    const mraStatus = getMRAStatus(item);
                    const StatusIcon = mraStatus.icon;

                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">
                          {item.name}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span>{item.stock_units}</span>
                            <span className="text-xs text-muted-foreground">
                              {item.unit_type}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {item.price ? `${item.price.toFixed(2)}` : 'N/A'}
                        </TableCell>
                        <TableCell>
                          <Badge className={mraStatus.color}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {mraStatus.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            {item.price_locked && (
                              <div
                                className="flex items-center gap-1 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded"
                                title="Price is locked by MRA"
                              >
                                <Lock className="h-3 w-3" />
                                Price
                              </div>
                            )}
                            {item.tax_locked && (
                              <div
                                className="flex items-center gap-1 text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded"
                                title="Tax is locked by MRA"
                              >
                                <Lock className="h-3 w-3" />
                                Tax
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedItem(item);
                              setShowMRADetails(true);
                            }}
                          >
                            View MRA
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* MRA Details Dialog */}
      <Dialog open={showMRADetails} onOpenChange={setShowMRADetails}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>MRA Compliance Details</DialogTitle>
            <DialogDescription>
              {selectedItem?.name}
            </DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <div className="space-y-4">
              {/* MRA Status */}
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold mb-3">MRA Status</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">MRA Ready</span>
                    {selectedItem.is_mra_ready ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Price Locked</span>
                    {selectedItem.price_locked ? (
                      <Lock className="h-5 w-5 text-blue-600" />
                    ) : (
                      <EyeOff className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Tax Locked</span>
                    {selectedItem.tax_locked ? (
                      <Lock className="h-5 w-5 text-purple-600" />
                    ) : (
                      <EyeOff className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                </div>
              </div>

              {/* Product Info */}
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold mb-3">Product Information</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Name</span>
                    <span className="font-medium">{selectedItem.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Category</span>
                    <span className="font-medium">{selectedItem.category}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stock</span>
                    <span className="font-medium">
                      {selectedItem.stock_units} {selectedItem.unit_type}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price</span>
                    <span className="font-medium">
                      {selectedItem.price?.toFixed(2) || 'N/A'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Warning if not MRA ready */}
              {!selectedItem.is_mra_ready && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-sm text-amber-900">
                    ⚠️ This product is not MRA-ready. It must be mapped to an MRA product code and approved before it can be sold.
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
