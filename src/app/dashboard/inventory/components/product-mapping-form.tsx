'use client';

import React, { useState, useEffect } from 'react';
import { Plus, Loader2, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';
import { type InventoryItem } from '@/lib/db';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const productMappingSchema = z.object({
  mra_unit_measure: z.string().min(1, 'Unit of measure is required'),
  mra_tax_id: z.string().min(1, 'Tax rate is required'),
  tax_calculation_method: z.enum(['inclusive', 'exclusive'], {
    errorMap: () => ({ message: 'Tax calculation method is required' }),
  }),
});

type ProductMappingFormValues = z.infer<typeof productMappingSchema>;

interface TaxRate {
  id: string;
  name: string;
  rate: number;
  taxType: string;
  isDefault?: boolean;
}

const normalizeTaxType = (value?: string): 'standard' | 'zero' | 'exempt' => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'vat_zero' || normalized === 'zero' || normalized === 'zero_rated' || normalized === 'zero-rated') {
    return 'zero';
  }
  if (normalized === 'vat_exempt' || normalized === 'exempt') {
    return 'exempt';
  }
  return 'standard';
};

const isZeroOrExemptTax = (tax: TaxRate | undefined): boolean => {
  if (!tax) return false;
  const taxType = normalizeTaxType(tax.taxType);
  if (taxType === 'zero' || taxType === 'exempt') {
    return true;
  }
  return Number(tax.rate || 0) === 0;
};

interface MRAProductCode {
  code: string;
  name: string;
  category: string;
  default_tax_type: string;
  default_tax_rate: number;
  unit_measure?: string;
  tax_calculation_method?: string;
}

interface ProductMapping {
  productId: string;
  productName: string;
  mraCode: string;
  mraName: string;
  mraTaxType: 'standard' | 'zero' | 'exempt';
  mraTaxRate: number;
  mraUnitMeasure: string;
  taxCalculationMethod: 'inclusive' | 'exclusive';
  taxRateLabel: string;
}

interface ProductMappingFormProps {
  inventoryData: InventoryItem[];
  businessId?: string;
  onMappingCreated?: () => void;
}

const normalizeBusinessIdParam = (value?: string): string | null => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return /^\d+$/.test(normalized) ? normalized : null;
};

const extractList = <T,>(response: any): T[] => {
  if (Array.isArray(response)) return response as T[];
  if (response?.results && Array.isArray(response.results)) return response.results as T[];
  if (response?.data && Array.isArray(response.data)) return response.data as T[];
  return [];
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { message?: string }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
  }
  return 'Unknown error';
};

export function ProductMappingForm({
  inventoryData,
  businessId,
  onMappingCreated,
}: ProductMappingFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [mraProducts, setMraProducts] = useState<MRAProductCode[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [catalogSource, setCatalogSource] = useState<'mra_configuration' | 'fallback_catalog' | 'unknown'>('unknown');
  const [catalogVersion, setCatalogVersion] = useState<string | null>(null);
  const [searchMraProducts, setSearchMraProducts] = useState('');
  const [searchProducts, setSearchProducts] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedMraProduct, setSelectedMraProduct] = useState<MRAProductCode | null>(null);
  const [mappings, setMappings] = useState<ProductMapping[]>([]);

  const form = useForm<ProductMappingFormValues>({
    resolver: zodResolver(productMappingSchema),
    defaultValues: {
      mra_unit_measure: 'unit',
      tax_calculation_method: 'inclusive',
    },
  });

  const selectedTaxId = form.watch('mra_tax_id');
  const selectedTax = taxRates.find((tax) => tax.id === selectedTaxId);
  const zeroOrExemptSelected = isZeroOrExemptTax(selectedTax);

  useEffect(() => {
    if (zeroOrExemptSelected) {
      form.setValue('tax_calculation_method', 'inclusive', { shouldValidate: true });
    }
  }, [zeroOrExemptSelected, form]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedProductIds([]);
      setSelectedMraProduct(null);
      setSearchProducts('');
      setSearchMraProducts('');
    }
  }, [isOpen]);

  // Fetch available MRA products and tax rates
  useEffect(() => {
    const fetchData = async () => {
      console.log('[ProductMappingForm] Fetching MRA products and tax rates');

      const fetchCatalog = async () => {
        const baseParams = new URLSearchParams({ include_meta: 'true' });
        const normalizedBusinessId = normalizeBusinessIdParam(businessId);
        const candidateParams: URLSearchParams[] = [];

        if (normalizedBusinessId) {
          const withBusiness = new URLSearchParams(baseParams.toString());
          withBusiness.set('business_id', normalizedBusinessId);
          candidateParams.push(withBusiness);
        }

        // Fallback if business_id is missing/invalid or backend rejects scoped query
        candidateParams.push(baseParams);

        let lastError: unknown = null;
        for (const params of candidateParams) {
          try {
            const response = await authFetch.fetch<any>(`/mra/product-codes/?${params.toString()}`);
            const products = extractList<MRAProductCode>(response);
            const source =
              response?.source === 'mra_configuration' || response?.source === 'fallback_catalog'
                ? response.source
                : 'unknown';
            const version = typeof response?.config_version === 'string' ? response.config_version : null;
            return {
              products,
              source: source as 'mra_configuration' | 'fallback_catalog' | 'unknown',
              version,
            };
          } catch (error) {
            lastError = error;
          }
        }

        throw lastError || new Error('Failed to load MRA catalog');
      };

      const fetchTaxes = async () => {
        // NOTE: authFetch already includes /api base, so do not prefix with /api here.
        const response = await authFetch.fetch<any>('/business/tax-rates/');
        const backendTaxes = extractList<any>(response);

        const formattedTaxes: TaxRate[] = backendTaxes
          .map((tax) => {
            const taxId = String(tax?.id ?? '').trim();
            if (!taxId) return null;
            const parsedRate = Number(tax?.rate ?? 0);
            return {
              id: taxId,
              name: String(tax?.name ?? '').trim() || `Tax ${taxId}`,
              rate: Number.isFinite(parsedRate) ? parsedRate : 0,
              taxType: String(tax?.tax_type ?? tax?.taxType ?? 'VAT_STANDARD'),
              isDefault: Boolean(tax?.is_default ?? tax?.isDefault),
            };
          })
          .filter(Boolean) as TaxRate[];

        return formattedTaxes;
      };

      const [catalogResult, taxesResult] = await Promise.allSettled([
        fetchCatalog(),
        fetchTaxes(),
      ]);

      const failedTargets: string[] = [];

      if (catalogResult.status === 'fulfilled') {
        setMraProducts(catalogResult.value.products);
        setCatalogSource(catalogResult.value.source);
        setCatalogVersion(catalogResult.value.version);
      } else {
        console.error('[ProductMappingForm] Failed to fetch MRA catalog:', catalogResult.reason);
        setMraProducts([]);
        setCatalogSource('unknown');
        setCatalogVersion(null);
        failedTargets.push('catalog');
      }

      if (taxesResult.status === 'fulfilled') {
        const loadedTaxes = taxesResult.value;
        setTaxRates(loadedTaxes);

        if (loadedTaxes.length > 0) {
          const currentTaxId = String(form.getValues('mra_tax_id') || '').trim();
          const stillValid = loadedTaxes.some((tax) => tax.id === currentTaxId);
          if (!stillValid) {
            const defaultTax = loadedTaxes.find((tax) => tax.isDefault) || loadedTaxes[0];
            form.setValue('mra_tax_id', defaultTax.id, { shouldValidate: true });
          }
        }
      } else {
        console.error('[ProductMappingForm] Failed to fetch tax rates:', taxesResult.reason);
        setTaxRates([]);
        failedTargets.push('tax rates');
      }

      if (failedTargets.length > 0) {
        const reason =
          catalogResult.status === 'rejected'
            ? extractErrorMessage(catalogResult.reason)
            : extractErrorMessage(taxesResult.status === 'rejected' ? taxesResult.reason : null);

        toast({
          variant: 'destructive',
          title: 'Error',
          description: `Failed to load ${failedTargets.join(' and ')} from backend: ${reason}`,
        });
      }
    };

    if (isOpen) {
      fetchData();
    }
  }, [isOpen, businessId, form]);

  const onSubmit = async (_data: ProductMappingFormValues) => {
    if (!businessId) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Business ID not found',
      });
      return;
    }

    if (mappings.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please add at least one product mapping',
      });
      return;
    }

    try {
      setIsLoading(true);

      const payload = {
        mappings: mappings.map((mapping) => ({
          inventory_item_id: mapping.productId,
          mra_product_code: mapping.mraCode,
          mra_product_name: mapping.mraName,
          mra_tax_type: mapping.mraTaxType,
          mra_tax_rate: mapping.mraTaxRate,
          mra_unit_measure: mapping.mraUnitMeasure,
          tax_calculation_method: mapping.taxCalculationMethod,
        })),
      };

      console.log('[ProductMappingForm] Submitting bulk mapping payload:', payload);

      const response = await authFetch.fetch<any>(
        '/inventory/mra-mappings/',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );

      const createdCount = Number(response?.count || mappings.length);
      toast({
        title: 'Success',
        description: `Created ${createdCount} product mapping${createdCount !== 1 ? 's' : ''}`,
      });

      form.reset();
      setSelectedProductIds([]);
      setSelectedMraProduct(null);
      setMappings([]);
      setIsOpen(false);
      onMappingCreated?.();
    } catch (error: any) {
      console.error('Failed to create mappings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to create product mappings',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const filteredMraProducts = mraProducts.filter(
    (product) =>
      product.code.toLowerCase().includes(searchMraProducts.toLowerCase()) ||
      product.name.toLowerCase().includes(searchMraProducts.toLowerCase())
  );

  const filteredInventoryProducts = inventoryData.filter(
    (product) =>
      product.name.toLowerCase().includes(searchProducts.toLowerCase()) &&
      !mappings.some(m => m.productId === product.id)
  );

  const selectedProducts = inventoryData.filter((product) =>
    selectedProductIds.includes(product.id) && !mappings.some((mapping) => mapping.productId === product.id)
  );

  const allFilteredProductsSelected =
    filteredInventoryProducts.length > 0 &&
    filteredInventoryProducts.every((product) => selectedProductIds.includes(product.id));

  const toggleProductSelection = (productId: string) => {
    setSelectedProductIds((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId]
    );
  };

  const handleSelectAllProducts = () => {
    setSelectedProductIds((current) => {
      const selectedSet = new Set(current);
      if (allFilteredProductsSelected) {
        return current.filter((id) => !filteredInventoryProducts.some((product) => product.id === id));
      }

      for (const product of filteredInventoryProducts) {
        selectedSet.add(product.id);
      }

      return Array.from(selectedSet);
    });
  };

  const handleClearSelectedProducts = () => {
    setSelectedProductIds([]);
  };

  const handleAddMapping = () => {
    if (selectedProducts.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select at least one product',
      });
      return;
    }

    if (!selectedTax) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select a tax rate for this mapping',
      });
      return;
    }

    const selectedMraCode = selectedMraProduct?.code?.trim() || '';

    if (catalogSource === 'mra_configuration' && !selectedMraCode) {
      toast({
        variant: 'destructive',
        title: 'Select an MRA product',
        description: 'Choose the matching product from the synced MRA catalog before adding this mapping.',
      });
      return;
    }

    if (selectedMraCode && selectedProducts.length > 1) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Bulk add works only without a single MRA code. Clear the MRA code or map products one by one.',
      });
      return;
    }

    // Check if MRA code is already used (only when provided)
    if (selectedMraCode && mappings.some(m => m.mraCode === selectedMraCode)) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'This MRA code is already assigned to another product',
      });
      return;
    }

    const normalizedTaxType = normalizeTaxType(selectedTax.taxType);
    const selectedUnitMeasure = String(form.getValues('mra_unit_measure') || 'unit').trim() || 'unit';
    const selectedTaxCalculationMethod = (form.getValues('tax_calculation_method') || 'inclusive') as 'inclusive' | 'exclusive';
    const zeroOrExemptForRow = isZeroOrExemptTax(selectedTax);
    const effectiveTaxCalculationMethod: 'inclusive' | 'exclusive' = zeroOrExemptForRow
      ? 'inclusive'
      : selectedTaxCalculationMethod;
    const effectiveTaxRate = zeroOrExemptForRow ? 0 : parseFloat(String(selectedTax.rate || 0));

    const newMappings: ProductMapping[] = selectedProducts.map((product) => ({
      productId: product.id,
      productName: product.name,
      mraCode: selectedMraCode,
      mraName: selectedMraProduct?.name?.trim() || product.name,
      mraTaxType: normalizedTaxType,
      mraTaxRate: effectiveTaxRate,
      mraUnitMeasure: selectedUnitMeasure,
      taxCalculationMethod: effectiveTaxCalculationMethod,
      taxRateLabel: `${selectedTax.name} (${effectiveTaxRate}%)`,
    }));

    setMappings((current) => [...current, ...newMappings]);
    setSelectedProductIds([]);
    setSelectedMraProduct(null);
    setSearchProducts('');
    setSearchMraProducts('');
  };

  const handleRemoveMapping = (productId: string) => {
    setMappings(mappings.filter(m => m.productId !== productId));
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Map Products to MRA
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map Multiple Products to MRA Codes</DialogTitle>
          <DialogDescription>
            Link multiple products to unique MRA codes. You can choose tax rate, unit, and tax calculation method per mapping.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Tax Rate, Unit, and Calculation Method Selection */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="mra_tax_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tax Rate</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a tax rate" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {taxRates.map((tax) => (
                          <SelectItem key={tax.id} value={tax.id}>
                            {tax.name} ({tax.rate}%)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>From Settings → Taxes</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="mra_unit_measure"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unit of Measure</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="unit">Unit</SelectItem>
                        <SelectItem value="kg">Kilogram</SelectItem>
                        <SelectItem value="liter">Liter</SelectItem>
                        <SelectItem value="meter">Meter</SelectItem>
                        <SelectItem value="box">Box</SelectItem>
                        <SelectItem value="pack">Pack</SelectItem>
                        <SelectItem value="bottle">Bottle</SelectItem>
                        <SelectItem value="can">Can</SelectItem>
                        <SelectItem value="carton">Carton</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tax_calculation_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tax Calculation</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={zeroOrExemptSelected}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={zeroOrExemptSelected ? 'Not applicable for 0% tax' : 'Select method'}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="inclusive">
                          Inclusive (Price includes tax)
                        </SelectItem>
                        <SelectItem value="exclusive">
                          Exclusive (Tax added to price)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {zeroOrExemptSelected
                        ? 'Not applicable for Zero Rated/Exempt taxes. Saved as Inclusive for consistency.'
                        : 'How is tax calculated?'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Product and MRA Code Selection */}
            <div className="grid grid-cols-2 gap-4">
              {/* Select Product */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <FormLabel>Select Product</FormLabel>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleSelectAllProducts}
                      disabled={filteredInventoryProducts.length === 0}
                    >
                      {allFilteredProductsSelected ? 'Unselect All' : 'Select All'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleClearSelectedProducts}
                      disabled={selectedProductIds.length === 0}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <Input
                  placeholder="Search products..."
                  value={searchProducts}
                  onChange={(e) => setSearchProducts(e.target.value)}
                  className="mb-2"
                />
                <div className="border rounded-lg max-h-48 overflow-y-auto">
                  {filteredInventoryProducts.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      No products available
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredInventoryProducts.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => toggleProductSelection(product.id)}
                          className={`w-full text-left px-4 py-2 hover:bg-gray-100 border-b last:border-b-0 transition-colors ${
                            selectedProductIds.includes(product.id) ? 'bg-blue-50' : ''
                          }`}
                        >
                          <p className="font-medium text-sm">{product.name}</p>
                          <p className="text-xs text-muted-foreground">{product.category}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedProducts.length > 0 && (
                  <Badge className="mt-2">
                    {selectedProducts.length} product{selectedProducts.length === 1 ? '' : 's'} selected
                  </Badge>
                )}
              </div>

              {/* Select MRA Code */}
              <div className="space-y-2">
                <FormLabel>
                  Select MRA Product{catalogSource === 'mra_configuration' ? '' : ' (Optional)'}
                </FormLabel>
                {catalogSource === 'mra_configuration' && (
                  <p className="text-xs text-green-700">
                    Select the product assigned in the MRA portal{catalogVersion ? ` (v${catalogVersion})` : ''}.
                  </p>
                )}
                {catalogSource === 'fallback_catalog' && (
                  <p className="text-xs text-amber-700">
                    Using fallback catalog. Sync product codes in Settings → MRA EIS for production.
                  </p>
                )}
                <Input
                  placeholder="Search MRA codes..."
                  value={searchMraProducts}
                  onChange={(e) => setSearchMraProducts(e.target.value)}
                  className="mb-2"
                />
                <div className="border rounded-lg max-h-48 overflow-y-auto">
                  {filteredMraProducts.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      No MRA products found
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredMraProducts.map((product) => (
                        <button
                          key={product.code}
                          type="button"
                          onClick={() => setSelectedMraProduct(product)}
                          className={`w-full text-left px-4 py-2 hover:bg-gray-100 border-b last:border-b-0 transition-colors ${
                            selectedMraProduct?.code === product.code ? 'bg-blue-50' : ''
                          }`}
                        >
                          <p className="font-mono text-sm font-semibold">{product.code}</p>
                          <p className="text-xs text-muted-foreground">{product.name}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedMraProduct && (
                  <Badge className="mt-2">{selectedMraProduct.code}</Badge>
                )}
              </div>
            </div>

            {/* Add Button */}
            <Button
              type="button"
              onClick={handleAddMapping}
              variant="outline"
              className="w-full"
              disabled={selectedProducts.length === 0 || !selectedTax}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add {selectedProducts.length || 0} Mapping{selectedProducts.length === 1 ? '' : 's'}
            </Button>

            {/* Mappings Table */}
            {mappings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Product Mappings ({mappings.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead>MRA Code</TableHead>
                          <TableHead>MRA Name</TableHead>
                          <TableHead>Tax</TableHead>
                          <TableHead>Calculation</TableHead>
                          <TableHead>Unit</TableHead>
                          <TableHead className="w-12">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {mappings.map((mapping) => (
                          <TableRow key={mapping.productId}>
                            <TableCell className="font-medium">
                              {mapping.productName}
                            </TableCell>
                            <TableCell>
                              <code className="text-xs bg-muted px-2 py-1 rounded">
                                {mapping.mraCode || '—'}
                              </code>
                            </TableCell>
                            <TableCell className="text-sm">
                              {mapping.mraName}
                            </TableCell>
                            <TableCell className="text-sm">
                              {mapping.taxRateLabel}
                            </TableCell>
                            <TableCell className="text-sm capitalize">
                              {mapping.taxCalculationMethod}
                            </TableCell>
                            <TableCell className="text-sm uppercase">
                              {mapping.mraUnitMeasure}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveMapping(mapping.productId)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading || mappings.length === 0}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating Mappings...
                  </>
                ) : (
                  `Create ${mappings.length} Mapping${mappings.length !== 1 ? 's' : ''}`
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
