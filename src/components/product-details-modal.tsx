'use client';

import React from 'react';
import { format } from 'date-fns';
import { X, Package, DollarSign, Barcode, Tag, Layers, AlertCircle, CheckCircle } from 'lucide-react';
import type { InventoryItem } from '@/lib/db';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatQuantityWithUnit, getPortionQuantityDisplay } from '@/lib/quantity-format';

interface ProductDetailsModalProps {
  product: InventoryItem | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (product: InventoryItem) => void;
}

export const ProductDetailsModal: React.FC<ProductDetailsModalProps> = ({
  product,
  isOpen,
  onOpenChange,
  onEdit,
}) => {
  if (!product) return null;

  const isSellable = product.itemType === 'sellable';
  const computedPortionPrice =
    product.isSoldInPortions && product.portionsPerUnit && product.portionsPerUnit > 0 && product.price
      ? product.price / product.portionsPerUnit
      : undefined;
  const portionQuantityDisplay =
    product.isSoldInPortions && product.portionsPerUnit && product.portionsPerUnit > 0
      ? getPortionQuantityDisplay({
          quantity: product.stockUnits,
          unitLabel: product.unitType || 'unit',
          portionName: product.portionName,
          portionsPerUnit: product.portionsPerUnit,
        })
      : null;
  const remainingQuantityText = portionQuantityDisplay
    ? portionQuantityDisplay.summaryText
    : formatQuantityWithUnit(product.stockUnits || 0, product.unitType || 'unit', {
        maximumFractionDigits: 3,
      });
  const totalPortionsText = portionQuantityDisplay
    ? formatQuantityWithUnit(portionQuantityDisplay.totalPortions, product.portionName || 'portion', {
        preferWholeNumbers: true,
        maximumFractionDigits: 0,
      })
    : '';
  const portionsPerUnitText =
    product.isSoldInPortions && product.portionsPerUnit && product.portionsPerUnit > 0
      ? `${formatQuantityWithUnit(product.portionsPerUnit, product.portionName || 'portion', {
          preferWholeNumbers: true,
          maximumFractionDigits: 0,
        })} per ${product.unitType || 'unit'}`
      : '';
  const statusColor = {
    'In Stock': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    'Low Stock': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    'Out of Stock': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="sticky top-0 bg-background z-10 pb-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <DialogTitle className="text-2xl font-bold">{product.name}</DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">{product.category}</p>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            {isSellable && product.recipe && product.recipe.length > 0 && (
              <TabsTrigger value="recipe">Recipe</TabsTrigger>
            )}
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4">
            {/* Status */}
            <div className="grid grid-cols-1 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Status</p>
                    <Badge className={`${statusColor[product.status as keyof typeof statusColor] || 'bg-gray-100'} text-base py-1 px-3`}>
                      {product.status || 'Unknown'}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Pricing & Stock */}
            <div className="grid grid-cols-2 gap-4">
              {isSellable && product.price !== undefined && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Selling Price</p>
                      </div>
                      <p className="text-2xl font-bold">{product.price.toFixed(2)}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {product.stockUnits !== undefined && product.stockUnits !== null && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Remaining Quantity</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xl font-bold leading-tight">{remainingQuantityText}</p>
                        {totalPortionsText ? (
                          <p className="text-xs text-muted-foreground">{totalPortionsText} total</p>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {product.cost !== undefined && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Cost</p>
                      <p className="text-2xl font-bold">{product.cost.toFixed(2)}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {product.value !== undefined && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Total Value</p>
                      <p className="text-2xl font-bold">{product.value.toFixed(2)}</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Identifiers */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Identifiers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {product.productCode && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Product Code</span>
                    <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.productCode}</code>
                  </div>
                )}
                {product.barcode && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-2">
                      <Barcode className="h-4 w-4" /> Barcode
                    </span>
                    <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.barcode}</code>
                  </div>
                )}
                {product.sku && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">SKU</span>
                    <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.sku}</code>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Details Tab */}
          <TabsContent value="details" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Category</p>
                    <p className="font-medium">{product.category}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Unit Type</p>
                    <p className="font-medium">{product.unitType || 'N/A'}</p>
                  </div>
                </div>
                {product.manufacturer && (
                  <div>
                    <p className="text-sm text-muted-foreground">Manufacturer</p>
                    <p className="font-medium">{product.manufacturer}</p>
                  </div>
                )}
                {product.brand && (
                  <div>
                    <p className="text-sm text-muted-foreground">Brand</p>
                    <p className="font-medium">{product.brand}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Supplier & Batch</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Supplier</p>
                    <p className="font-medium">{product.supplier || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Batch Number</p>
                    <p className="font-medium">{product.batch || 'N/A'}</p>
                  </div>
                </div>
                {product.expiry && (
                  <div>
                    <p className="text-sm text-muted-foreground">Expiry Date</p>
                    <p className="font-medium">{format(new Date(product.expiry), 'PPP')}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {!isSellable && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Stock Management</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Reorder Level</p>
                      <p className="font-medium">{product.reorderLevel || 0}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Current Stock</p>
                      <p className="font-medium">{remainingQuantityText}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {isSellable && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Sellable Product Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-muted-foreground">Produced In-House</p>
                      {product.isProduced ? (
                        <CheckCircle className="h-4 w-4 text-green-600" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-muted-foreground">Variable Price</p>
                      {product.isVariablePrice ? (
                        <CheckCircle className="h-4 w-4 text-green-600" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {product.isSoldInPortions && (
                    <div className="space-y-2 pt-2 border-t">
                      <p className="font-medium text-sm">Portion Information</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Portion Name</p>
                          <p className="font-medium">{product.portionName}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Portions per Unit</p>
                          <p className="font-medium">{portionsPerUnitText}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Portion Price</p>
                          <p className="font-medium">
                            {(product.portionPrice ?? computedPortionPrice ?? 0).toFixed(2)}
                          </p>
                        </div>
                      </div>
                      {portionQuantityDisplay ? (
                        <div className="rounded-md bg-muted/40 p-3">
                          <p className="text-xs text-muted-foreground">Current Stock</p>
                          <p className="font-medium">{portionQuantityDisplay.summaryText}</p>
                          <p className="text-xs text-muted-foreground mt-1">{totalPortionsText} total</p>
                        </div>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Recipe Tab */}
          {isSellable && product.recipe && product.recipe.length > 0 && (
            <TabsContent value="recipe" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recipe / Bill of Materials</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {product.recipe.map((ingredient, index) => (
                      <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex-1">
                          <p className="font-medium">{ingredient.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {ingredient.quantity} {ingredient.unit}
                          </p>
                        </div>
                        <Badge variant="outline">{ingredient.quantity} {ingredient.unit}</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>

        {/* Footer Actions */}
        <div className="flex gap-2 pt-4 border-t sticky bottom-0 bg-background">
          {onEdit && (
            <Button onClick={() => onEdit(product)} className="flex-1">
              Edit Product
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
