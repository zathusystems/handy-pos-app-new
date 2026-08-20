'use client';

import React, { useState, useEffect } from 'react';
import { format, isPast, isWithinInterval, addDays } from 'date-fns';
import { X, Package, DollarSign, Barcode, Tag, Layers, AlertCircle, CheckCircle, AlertTriangle, Clock, Truck, Loader2 } from 'lucide-react';
import type { InventoryItem } from '@/lib/db';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCurrency } from '@/hooks/use-currency';
import { authFetch } from '@/lib/auth-fetch';
import { type BusinessType } from '@/lib/inventory/config';
import { formatInventoryQuantity, shouldPreferWholeStockCounts } from '@/lib/quantity-format';

interface ProductDetailsModalProps {
  product: InventoryItem | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (product: InventoryItem) => void;
  currentBusinessType: BusinessType;
}

export const ProductDetailsModal: React.FC<ProductDetailsModalProps> = ({
  product,
  isOpen,
  onOpenChange,
  onEdit,
  currentBusinessType,
}) => {
  const { currencyCode } = useCurrency();
  
  if (!product) return null;

  // Get currency symbol based on currency code
  const getCurrencySymbol = () => {
    const symbols: Record<string, string> = {
      'USD': '$',
      'EUR': '€',
      'GBP': '£',
      'JPY': '¥',
      'MWK': 'MWK',
      'ZAR': 'R',
      'KES': 'KSh',
      'UGX': 'USh',
      'TZS': 'TSh',
    };
    return symbols[currencyCode] || currencyCode;
  };

  const currencySymbol = getCurrencySymbol();

  const isSellable = product.itemType === 'sellable';
  const isProducedInHouse = isSellable && Boolean(product.isProduced);
  const preferWholeStockCounts = shouldPreferWholeStockCounts(currentBusinessType);
  const formattedStockUnits = formatInventoryQuantity(product.stockUnits, {
    preferWholeNumbers: preferWholeStockCounts,
  });
  const formattedReorderLevel = formatInventoryQuantity(product.reorderLevel, {
    preferWholeNumbers: preferWholeStockCounts,
  });
  const statusColor = {
    'In Stock': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    'Low Stock': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    'Out of Stock': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };
  const displayStatus = isProducedInHouse ? 'Recipe managed' : product.status || 'Unknown';
  const displayStatusClass = isProducedInHouse
    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
    : statusColor[product.status as keyof typeof statusColor] || 'bg-gray-100';

  // Check expiry status
  const isExpired = product.expiry ? isPast(new Date(product.expiry)) : false;
  const isExpiringoon = product.expiry && !isExpired ? isWithinInterval(new Date(product.expiry), { start: new Date(), end: addDays(new Date(), 30) }) : false;
  
  // Check if low stock
  const isLowStock = !isProducedInHouse && product.status === 'Low Stock';
  const isOutOfStock = !isProducedInHouse && product.status === 'Out of Stock';

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

        {/* Alert Warnings */}
        <div className="space-y-2">
          {isExpired && (
            <Alert className="border-red-200 bg-red-50 dark:bg-red-950/30">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800 dark:text-red-200">
                ⚠️ <strong>EXPIRED</strong> - This product expired on {format(new Date(product.expiry!), 'PPP')}
              </AlertDescription>
            </Alert>
          )}
          
          {isExpiringoon && !isExpired && (
            <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950/30">
              <Clock className="h-4 w-4 text-yellow-600" />
              <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                ⏰ <strong>EXPIRING SOON</strong> - Expires on {format(new Date(product.expiry!), 'PPP')}
              </AlertDescription>
            </Alert>
          )}

          {isOutOfStock && (
            <Alert className="border-red-200 bg-red-50 dark:bg-red-950/30">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800 dark:text-red-200">
                📦 <strong>OUT OF STOCK</strong> - No units available
              </AlertDescription>
            </Alert>
          )}

          {isLowStock && !isOutOfStock && (
            <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950/30">
              <AlertCircle className="h-4 w-4 text-yellow-600" />
              <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                ⚠️ <strong>LOW STOCK</strong> - Current stock: {formattedStockUnits} {product.unitType} (Reorder level: {formattedReorderLevel})
              </AlertDescription>
            </Alert>
          )}

          {product.batch && (
            <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950/30">
              <Truck className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 dark:text-blue-200">
                📋 <strong>Batch:</strong> {product.batch}
              </AlertDescription>
            </Alert>
          )}
        </div>

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
                    <Badge className={`${displayStatusClass} text-base py-1 px-3`}>
                      {displayStatus}
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
                      <p className="text-2xl font-bold">{currencySymbol}{(Number(product.price) || 0).toFixed(2)}</p>
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
                      <p className="text-2xl font-bold">{formattedStockUnits} <span className="text-sm text-muted-foreground">{product.unitType}</span></p>
                      {product.value !== undefined && product.value !== null && (
                        <p className="text-sm text-muted-foreground">Value: {currencySymbol}{(Number(product.value) || 0).toFixed(2)}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {product.cost !== undefined && product.cost !== null && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Cost</p>
                      <p className="text-2xl font-bold">{currencySymbol}{(Number(product.cost) || 0).toFixed(2)}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {product.value !== undefined && product.value !== null && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Total Value</p>
                      <p className="text-2xl font-bold">{currencySymbol}{(Number(product.value) || 0).toFixed(2)}</p>
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
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Product Code</span>
                  <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.productCode || 'N/A'}</code>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Barcode className="h-4 w-4" /> Barcode
                  </span>
                  <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.barcode || 'N/A'}</code>
                </div>
                {product.sku && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">SKU</span>
                    <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{product.sku}</code>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* MRA Tax Rate Mapping */}
            <MRATaxMappingCard productId={product.id} />
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
                <CardTitle className="text-base flex items-center gap-2">
                  <Truck className="h-4 w-4" />
                  Supplier & Batch Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Supplier</p>
                    <p className="font-medium text-base">{product.supplier || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Batch Number</p>
                    <p className="font-medium text-base">{product.batch || 'N/A'}</p>
                  </div>
                </div>
                {product.expiry && (
                  <div className="pt-2 border-t">
                    <p className="text-sm text-muted-foreground">Expiry Date</p>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="font-medium text-base">{format(new Date(product.expiry), 'PPP')}</p>
                      {isExpired && <Badge variant="destructive">EXPIRED</Badge>}
                      {isExpiringoon && !isExpired && <Badge variant="outline" className="bg-yellow-50">EXPIRING SOON</Badge>}
                    </div>
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
                      <p className="font-medium text-base">{formattedReorderLevel} {product.unitType}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Current Stock</p>
                      <p className="font-medium text-base">{formattedStockUnits} {product.unitType}</p>
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
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Portion Name</p>
                          <p className="font-medium">{product.portionName}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Portions per Unit</p>
                          <p className="font-medium">{product.portionsPerUnit}</p>
                        </div>
                      </div>
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

// MRA Tax Rate Mapping Card Component
function MRATaxMappingCard({ productId }: { productId: string }) {
  const [mapping, setMapping] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchMapping = async () => {
      try {
        console.log('[MRATaxMappingCard] Fetching mapping for product:', productId);
        setIsLoading(true);
        const response = await authFetch.fetch<any>(`/inventory/mra-mappings/?inventory_item=${productId}`);
        
        console.log('[MRATaxMappingCard] Full Response:', response);
        console.log('[MRATaxMappingCard] Response type:', typeof response);
        console.log('[MRATaxMappingCard] Is Array:', Array.isArray(response));
        
        let mappings: any[] = [];
        if (Array.isArray(response)) {
          mappings = response;
          console.log('[MRATaxMappingCard] Response is array, length:', mappings.length);
        } else if (response?.results && Array.isArray(response.results)) {
          mappings = response.results;
          console.log('[MRATaxMappingCard] Response has results array, length:', mappings.length);
        } else if (response && typeof response === 'object') {
          console.log('[MRATaxMappingCard] Response is object but no results array. Keys:', Object.keys(response));
          mappings = [];
        }

        console.log('[MRATaxMappingCard] Final mappings array length:', mappings.length);

        // Filter mappings to only include those for this specific product
        const productMappings = mappings.filter(m => m.inventory_item === productId);
        console.log('[MRATaxMappingCard] Filtered mappings for this product:', productMappings.length);

        // Get the first mapping for this product
        if (productMappings && productMappings.length > 0) {
          console.log('[MRATaxMappingCard] Setting mapping:', productMappings[0]);
          setMapping(productMappings[0]);
        } else {
          console.log('[MRATaxMappingCard] No mappings found for this product, setting to null');
          setMapping(null);
        }
      } catch (error) {
        console.error('[MRATaxMappingCard] Failed to fetch mapping:', error);
        setMapping(null);
      } finally {
        setIsLoading(false);
      }
    };

    if (productId) {
      fetchMapping();
    }
  }, [productId]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading MRA mapping...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!mapping) {
    return (
      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-amber-900">No MRA Mapping</p>
              <p className="text-sm text-amber-800 mt-1">This product has not been mapped to an MRA code yet. Go to MRA Mappings tab to create a mapping.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-green-200 bg-green-50">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-green-900">
          <CheckCircle className="h-5 w-5 text-green-600" />
          MRA Tax Rate Mapping
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-green-700 font-medium">MRA Code</p>
            <p className="text-green-900 font-mono font-semibold">{mapping.mra_product_code}</p>
          </div>
          <div>
            <p className="text-green-700 font-medium">MRA Product</p>
            <p className="text-green-900">{mapping.mra_product_name}</p>
          </div>
          <div>
            <p className="text-green-700 font-medium">Tax Rate</p>
            <p className="text-green-900 font-semibold">{mapping.mra_tax_rate}%</p>
          </div>
          <div>
            <p className="text-green-700 font-medium">Tax Type</p>
            <p className="text-green-900 capitalize">{mapping.mra_tax_type}</p>
          </div>
          <div>
            <p className="text-green-700 font-medium">Unit Measure</p>
            <p className="text-green-900">{mapping.mra_unit_measure}</p>
          </div>
          <div>
            <p className="text-green-700 font-medium">Status</p>
            <p className="text-green-900">
              {mapping.is_approved ? (
                <span className="inline-flex items-center gap-1">
                  <CheckCircle className="h-4 w-4" />
                  Approved
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  Pending
                </span>
              )}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
