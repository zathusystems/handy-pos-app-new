'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  MoreHorizontal,
  PlusCircle,
  Upload,
  Download,
  Edit,
  History,
  Trash2,
  ClipboardList,
  AlertCircle,
  Package,
  ShoppingBasket,
  Pill,
  Utensils,
  GlassWater,
  Apple,
  Beef,
  Sparkles,
  Eye,
  Hammer,
  Shirt,
  List,
  LayoutGrid,
} from 'lucide-react';

import { toast } from '@/hooks/use-toast';
import { db, type InventoryItem, type MRAMapping, type RecipeIngredient } from '@/lib/db';
import { businessConfig, type BusinessType } from '@/lib/inventory/config';
import {
    formatInventoryQuantity,
    getPortionQuantityDisplay,
    shouldPreferWholeStockCounts,
} from '@/lib/quantity-format';
import { deleteProduct } from '@/lib/services/product-service';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import { ProductDetailsModal } from './product-details-modal';
import { getInventoryTemplateColumnsForBusinessType } from './import-template-config';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { PaginationControls, usePaginatedItems } from './pagination-controls';

const statusBadgeVariant = {
  'In Stock': 'secondary',
  'Low Stock': 'default',
  'Out of Stock': 'destructive',
} as const;

const isProducedInHouseSellable = (item: InventoryItem): boolean =>
    item.itemType === 'sellable' && Boolean(item.isProduced);

type InventoryKindFilter = 'all' | 'produced' | 'ingredients' | 'sellables';

const toCsvBoolean = (value: boolean | undefined): string => (value ? 'true' : 'false');
const toSafeNumber = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const toOptionalCsvNumber = (value: unknown): number | '' => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : '';
};

const getVariablePriceLabel = (unitType?: string): string => {
    const unit = String(unitType || '').trim().toLowerCase();
    if (!unit) return 'Variable Price';
    if (/(^|[^a-z])l(itre|iter|iters|itres)?([^a-z]|$)/.test(unit) || unit === 'l' || unit === 'ml') {
        return 'By Volume';
    }
    if (/(kg|g|gram|grams|lb|lbs|pound|pounds|oz|ounce|ounces|ton|tons)/.test(unit)) {
        return 'By Weight';
    }
    return 'Variable Price';
};

const toTemplateExportCsvRow = (
    item: InventoryItem,
    columns: string[],
    mapping?: MRAMapping
) => {
    const itemWithOptionalTax = item as InventoryItem & {
        taxRate?: number;
        taxCalculationMethod?: 'inclusive' | 'exclusive';
        mraProductCode?: string;
        mraProductName?: string;
        mraTaxType?: string;
        mraTaxRate?: number;
        mraUnitMeasure?: string;
    };

    const sourceRow: Record<string, string | number> = {
        name: item.name || '',
        category: item.category || '',
        productCode: item.productCode || '',
        barcode: item.barcode || '',
        sku: item.sku || '',
        brand: item.brand || '',
        isProduced: toCsvBoolean(item.isProduced),
        currentStock: Number(item.stockUnits || 0),
        price: item.price ?? '',
        cost: item.cost ?? '',
        isVariablePrice: toCsvBoolean(item.isVariablePrice),
        taxRate: toOptionalCsvNumber(itemWithOptionalTax.taxRate ?? mapping?.mraTaxRate),
        taxCalculationMethod: itemWithOptionalTax.taxCalculationMethod ?? mapping?.taxCalculationMethod ?? '',
        mraProductCode: itemWithOptionalTax.mraProductCode ?? mapping?.mraProductCode ?? '',
        mraProductName: itemWithOptionalTax.mraProductName ?? mapping?.mraProductName ?? '',
        mraTaxType: itemWithOptionalTax.mraTaxType ?? mapping?.mraTaxType ?? '',
        mraTaxRate: toOptionalCsvNumber(itemWithOptionalTax.mraTaxRate ?? mapping?.mraTaxRate),
        mraUnitMeasure: itemWithOptionalTax.mraUnitMeasure ?? mapping?.mraUnitMeasure ?? item.unitType ?? '',
        unitType: item.unitType || 'unit',
        reorderLevel: Number(item.reorderLevel || 0),
        supplier: item.supplier || '',
        isSoldInPortions: toCsvBoolean(item.isSoldInPortions),
        portionName: item.portionName || '',
        portionsPerUnit: item.portionsPerUnit ?? '',
        portionPrice: item.portionPrice ?? '',
        recipe: item.recipe && item.recipe.length > 0 ? JSON.stringify(item.recipe) : '',
    };

    return columns.reduce<Record<string, string | number>>((row, column) => {
        row[column] = sourceRow[column] ?? '';
        return row;
    }, {});
};

interface InventoryTabProps {
    inventoryData: InventoryItem[];
    isMobile: boolean;
    currentBusinessType: BusinessType;
    searchTerm: string;
    onAddItem: () => void;
    onEditItem: (item: InventoryItem) => void;
    onImport: () => void;
    onTransfer: () => void;
}

export function InventoryTab({ 
    inventoryData, 
    isMobile,
    currentBusinessType,
    searchTerm,
    onAddItem,
    onEditItem,
    onImport,
    onTransfer
}: InventoryTabProps) {
    const { user } = useAuth();
    const { currencyCode } = useCurrency();
    const currentConfig = businessConfig[currentBusinessType] || businessConfig['General Retail'];
    
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
    const showItemTypeBadge =
      currentBusinessType === 'Restaurant' || currentBusinessType === 'Bar & Liquor';
    const preferWholeStockCounts = React.useMemo(
        () => shouldPreferWholeStockCounts(currentBusinessType),
        [currentBusinessType]
    );
    const exportTemplateColumns = React.useMemo(
        () => getInventoryTemplateColumnsForBusinessType(currentBusinessType),
        [currentBusinessType]
    );
    
    // Product details modal state
    const [selectedProduct, setSelectedProduct] = useState<InventoryItem | null>(null);
    const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
    const [mobileViewMode, setMobileViewMode] = useState<'list' | 'cards'>('list');
    const [kindFilter, setKindFilter] = useState<InventoryKindFilter>('all');
    const normalizedSearchTerm = searchTerm.trim().toLowerCase();
    const inventoryKindFilters = React.useMemo(() => {
        const items = inventoryData || [];
        const counts = {
            all: items.length,
            produced: items.filter((item) => item.itemType === 'sellable' && Boolean(item.isProduced)).length,
            ingredients: items.filter((item) => item.itemType === 'ingredient').length,
            sellables: items.filter((item) => item.itemType === 'sellable' && !item.isProduced).length,
        };

        return [
            { value: 'all' as const, label: 'All', count: counts.all },
            { value: 'produced' as const, label: currentBusinessType === 'Bar & Liquor' ? 'Cocktails/Produced' : 'Meals/Produced', count: counts.produced },
            { value: 'ingredients' as const, label: 'Ingredients', count: counts.ingredients },
            { value: 'sellables' as const, label: 'Sellables', count: counts.sellables },
        ];
    }, [currentBusinessType, inventoryData]);
    const filteredInventoryData = React.useMemo(() => {
        const byKind = (inventoryData || []).filter((item) => {
            if (kindFilter === 'produced') {
                return item.itemType === 'sellable' && Boolean(item.isProduced);
            }
            if (kindFilter === 'ingredients') {
                return item.itemType === 'ingredient';
            }
            if (kindFilter === 'sellables') {
                return item.itemType === 'sellable' && !item.isProduced;
            }
            return true;
        });

        if (!normalizedSearchTerm) return byKind;

        return byKind.filter((item) =>
            [
                item.name,
                item.category,
                item.status,
                item.itemType,
                item.unitType,
                item.supplier,
                item.manufacturer,
                item.brand,
                item.batch,
                item.productCode,
                item.barcode,
                item.sku,
            ].some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm))
        );
    }, [inventoryData, kindFilter, normalizedSearchTerm]);

    const {
        setCurrentPage,
        totalItems,
        totalPages,
        effectiveCurrentPage,
        pageStartIndex,
        pageEndIndex,
        paginatedItems: paginatedInventoryData,
    } = usePaginatedItems(filteredInventoryData);

    React.useEffect(() => {
        setCurrentPage(1);
    }, [kindFilter, normalizedSearchTerm, setCurrentPage]);

    const handleViewDetails = (item: InventoryItem) => {
        setSelectedProduct(item);
        setIsDetailsModalOpen(true);
    };

    const handleEditFromDetails = (item: InventoryItem) => {
        setIsDetailsModalOpen(false);
        onEditItem(item);
    };

    const handleExport = async () => {
        if (!inventoryData || inventoryData.length === 0) {
            toast({ variant: 'destructive', title: 'No data to export' });
            return;
        }

        try {
            const inventoryIds = inventoryData.map((item) => String(item.id)).filter(Boolean);
            const mappings = inventoryIds.length > 0
                ? await db.mraMappings
                    .where('inventoryItemId')
                    .anyOf(inventoryIds)
                    .toArray()
                : [];
            const mappingByItemId = new Map<string, MRAMapping>();

            mappings.forEach((mapping) => {
                if (mapping._operation === 'delete') {
                    return;
                }

                const itemId = String(mapping.inventoryItemId || '').trim();
                if (!itemId || mappingByItemId.has(itemId)) {
                    return;
                }

                mappingByItemId.set(itemId, mapping);
            });

            const rows = inventoryData.map((item) =>
                toTemplateExportCsvRow(item, exportTemplateColumns, mappingByItemId.get(String(item.id)))
            );
            const csv = Papa.unparse(rows);
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            if (link.download !== undefined) {
                const url = URL.createObjectURL(blob);
                link.setAttribute('href', url);
                link.setAttribute('download', 'inventory-export.csv');
                link.style.visibility = 'hidden';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
            toast({ title: 'Export Complete', description: `${inventoryData.length} items have been exported.` });
        } catch (error) {
            console.error('Failed to export inventory:', error);
            toast({
                variant: 'destructive',
                title: 'Export Failed',
                description: 'Could not export the inventory file. Please try again.',
            });
        }
    };

    const handleDeleteItem = async (itemId: string) => {
        if (confirm('Are you sure you want to delete this item? This action cannot be undone.')) {
            try {
                if (!user) {
                    toast({ variant: 'destructive', title: 'Not authenticated' });
                    return;
                }

                // Get the item to get branchId
                const item = inventoryData.find(i => i.id === itemId);
                if (!item) {
                    toast({ variant: 'destructive', title: 'Item not found' });
                    return;
                }

                // Use product-service which handles marking for deletion and sync queueing
                await deleteProduct(
                    itemId,
                    user.uid,
                    user.displayName || user.email || 'Unknown',
                    item.branchId
                );

                toast({
                    title: 'Item Deleted',
                    description: 'The item has been removed from your inventory and queued for sync with the backend.',
                    variant: 'destructive',
                });
            } catch (error) {
                console.error('Failed to delete item:', error);
                toast({
                    variant: 'destructive',
                    title: 'Error',
                    description: 'Failed to delete item. Please try again.',
                });
            }
        }
    };


    const renderIcon = (item: InventoryItem) => {
        // For sellable items, use business-type-specific icons
        if (item.itemType === 'sellable') {
            switch (currentBusinessType) {
            case 'Pharmacy': return <Pill className="h-6 w-6 text-muted-foreground" data-ai-hint="pharmacy medicine" />;
            case 'Restaurant': return <Utensils className="h-6 w-6 text-muted-foreground" data-ai-hint="restaurant food" />;
            case 'Bar & Liquor': return <GlassWater className="h-6 w-6 text-muted-foreground" data-ai-hint="bar liquor bottle" />;
            case 'Supermarket': return <ShoppingBasket className="h-6 w-6 text-muted-foreground" data-ai-hint="supermarket product" />;
            case 'Grocery': return <Apple className="h-6 w-6 text-muted-foreground" data-ai-hint="grocery produce" />;
            case 'Beauty Salon and Spa': return <Sparkles className="h-6 w-6 text-muted-foreground" data-ai-hint="beauty salon product" />;
            case 'Clothing & Fashion': return <Shirt className="h-6 w-6 text-muted-foreground" data-ai-hint="clothing fashion item" />;
            case 'Hardware': return <Hammer className="h-6 w-6 text-muted-foreground" data-ai-hint="hardware tool item" />;
            default: return <Package className="h-6 w-6 text-muted-foreground" />;
            }
        }
        // For ingredients, use business-type-specific icons
        switch (currentBusinessType) {
        case 'Pharmacy': return <Pill className="h-6 w-6 text-muted-foreground" data-ai-hint="pharmacy medicine" />;
        case 'Restaurant': return <Beef className="h-6 w-6 text-muted-foreground" data-ai-hint="restaurant ingredient" />;
        case 'Bar & Liquor': return <GlassWater className="h-6 w-6 text-muted-foreground" data-ai-hint="bar liquor bottle" />;
        case 'Supermarket': return <ShoppingBasket className="h-6 w-6 text-muted-foreground" data-ai-hint="supermarket product" />;
        case 'Grocery': return <Apple className="h-6 w-6 text-muted-foreground" data-ai-hint="grocery produce" />;
        case 'Beauty Salon and Spa': return <Sparkles className="h-6 w-6 text-muted-foreground" data-ai-hint="beauty salon product" />;
        case 'Clothing & Fashion': return <Shirt className="h-6 w-6 text-muted-foreground" data-ai-hint="clothing fashion item" />;
        case 'Hardware': return <Hammer className="h-6 w-6 text-muted-foreground" data-ai-hint="hardware tool item" />;
        default: return <Package className="h-6 w-6 text-muted-foreground" />;
        }
    };

    const calculateCost = (recipe: RecipeIngredient[] | undefined) => {
        if (!recipe || !inventoryData) return 0;
        return recipe.reduce((totalCost, recipeItem) => {
            const inventoryItem = inventoryData.find(i => i.id === recipeItem.ingredientId);
            if (!inventoryItem) return totalCost;
            return totalCost + toSafeNumber(inventoryItem.cost) * toSafeNumber(recipeItem.quantity);
        }, 0);
    };

    const getDisplayValue = (item: InventoryItem) => {
        const storedValue = toSafeNumber(item.value);
        if (storedValue > 0) return storedValue;

        const stockUnits = toSafeNumber(item.stockUnits);
        const costPerUnit = toSafeNumber(item.cost);
        return stockUnits * costPerUnit;
    };

    const renderTableHeader = () => (
        <TableRow>
            <TableHead className="w-[40px]"><Checkbox /></TableHead>
            <TableHead className="min-w-[250px]">Item</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Stock/Price</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead className="text-right">Remaining</TableHead>
            <TableHead className="text-right">Value/Cost</TableHead>
            <TableHead className="w-[50px]"><span className="sr-only">Actions</span></TableHead>
        </TableRow>
    );

    const renderTableRow = (item: InventoryItem) => {
        const isSellable = item.itemType === 'sellable';
        const estimatedRecipeCost = calculateCost(item.recipe);
        const cost = isSellable && estimatedRecipeCost > 0
            ? estimatedRecipeCost
            : toSafeNumber(item.cost);
        const isRecipeManaged = isProducedInHouseSellable(item);
        const displayStatus = isRecipeManaged ? undefined : item.status;
        const displayValue = getDisplayValue(item);
        const formattedStockUnits = formatInventoryQuantity(item.stockUnits, {
            preferWholeNumbers: preferWholeStockCounts,
        });
        const portionQuantityDisplay =
            isSellable && item.isSoldInPortions && item.portionsPerUnit
                ? getPortionQuantityDisplay({
                    quantity: item.stockUnits,
                    unitLabel: item.unitType || 'unit',
                    portionName: item.portionName,
                    portionsPerUnit: item.portionsPerUnit,
                })
                : null;
        
        return (
            <TableRow key={item.id}>
                <TableCell><Checkbox /></TableCell>
                <TableCell>
                    <div className="flex items-center gap-4">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md flex items-center justify-center bg-muted">
                        {renderIcon(item)}
                    </div>
                    <div className='grid gap-0.5'>
                        <div className="flex items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        {item.isVariablePrice && (
                            <Badge variant="outline">{getVariablePriceLabel(item.unitType)}</Badge>
                        )}
                        </div>
                        <span className="text-xs text-muted-foreground">{item.category}</span>
                    </div>
                    </div>
                </TableCell>
                <TableCell>
                    {isRecipeManaged ? (
                        <Badge variant="outline">Recipe managed</Badge>
                    ) : (
                        displayStatus && (
                            <Badge variant={statusBadgeVariant[displayStatus]}>
                                {displayStatus === 'Low Stock' && <AlertCircle className="mr-1 h-3 w-3" />}
                                {displayStatus}
                            </Badge>
                        )
                    )}
                </TableCell>
                <TableCell className="text-right font-medium">
                    {isSellable ? `${currencySymbol}${(Number(item.price) || 0).toFixed(2)}` : formattedStockUnits}
                </TableCell>
                <TableCell className="text-muted-foreground">{item.unitType || 'N/A'}</TableCell>
                <TableCell>{item.isProduced ? 'In-house' : (item.supplier || 'N/A')}</TableCell>
                <TableCell className="text-right">
                    {portionQuantityDisplay ? (
                        <div className="text-sm">
                            <div className="font-semibold">{portionQuantityDisplay.wholeUnitsText}</div>
                            <div className="text-xs text-muted-foreground">
                                {portionQuantityDisplay.remainingPortionsText} remaining
                            </div>
                        </div>
                    ) : (
                        <div className="font-semibold">{formattedStockUnits} {item.unitType}</div>
                    )}
                </TableCell>
                <TableCell className="text-right font-semibold">
                        {isSellable ? `${currencySymbol}${toSafeNumber(cost).toFixed(2)}` : `${currencySymbol}${toSafeNumber(displayValue).toFixed(2)}`}
                </TableCell>
                <TableCell>
                    <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                        <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => handleViewDetails(item)}><Eye className="mr-2"/> View Details</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onEditItem(item)}><Edit className="mr-2"/> Edit Item</DropdownMenuItem>
                        <DropdownMenuItem><History className="mr-2"/> View History</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => handleDeleteItem(item.id)} className="text-destructive"><Trash2 className="mr-2"/> Delete Item</DropdownMenuItem>
                    </DropdownMenuContent>
                    </DropdownMenu>
                </TableCell>
            </TableRow>
        );
    };

    const renderMobileCard = (item: InventoryItem) => {
        const isSellable = item.itemType === 'sellable';
        const estimatedRecipeCost = calculateCost(item.recipe);
        const cost = isSellable && estimatedRecipeCost > 0
            ? estimatedRecipeCost
            : toSafeNumber(item.cost);
        const isRecipeManaged = isProducedInHouseSellable(item);
        const displayStatus = isRecipeManaged ? undefined : item.status;
        const displayValue = getDisplayValue(item);
        const formattedStockUnits = formatInventoryQuantity(item.stockUnits, {
            preferWholeNumbers: preferWholeStockCounts,
        });
        const portionQuantityDisplay =
            isSellable && item.isSoldInPortions && item.portionsPerUnit
                ? getPortionQuantityDisplay({
                    quantity: item.stockUnits,
                    unitLabel: item.unitType || 'unit',
                    portionName: item.portionName,
                    portionsPerUnit: item.portionsPerUnit,
                })
                : null;

        return (
            <Card key={item.id} className="mobile-data-card mb-4">
                <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md flex items-center justify-center bg-muted">
                            {renderIcon(item)}
                        </div>
                        <div className="flex-1 grid gap-0.5">
                            <div className="flex items-center gap-2">
                            <p className="font-semibold">{item.name}</p>
                            {item.isVariablePrice && (
                                <Badge variant="outline">{getVariablePriceLabel(item.unitType)}</Badge>
                            )}
                            </div>
                            <p className="text-sm text-muted-foreground">{item.category}</p>
                            <div className="flex items-center gap-2 mt-1">
                                {showItemTypeBadge && (
                                    <Badge variant={isSellable ? 'default' : 'outline'} className="w-fit">
                                        {item.itemType}
                                    </Badge>
                                )}
                                {isRecipeManaged ? (
                                    <Badge variant="outline" className="w-fit">
                                        Recipe managed
                                    </Badge>
                                ) : displayStatus && (
                                    <Badge variant={statusBadgeVariant[displayStatus]} className="w-fit">
                                        {displayStatus === 'Low Stock' && <AlertCircle className="mr-1 h-3 w-3" />}
                                        {displayStatus}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="-mt-2 -mr-2">
                                    <MoreHorizontal />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => handleViewDetails(item)}><Eye className="mr-2" /> View Details</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => onEditItem(item)}><Edit className="mr-2" /> Edit Item</DropdownMenuItem>
                                <DropdownMenuItem><History className="mr-2" /> View History</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => handleDeleteItem(item.id)} className="text-destructive"><Trash2 className="mr-2" /> Delete Item</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                    <Separator className="my-4" />
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        {isSellable ? (
                            <>
                                <div>
                                    <p className="text-muted-foreground">{item.isVariablePrice ? 'Price/Unit' : 'Price'}</p>
                                    <p className="font-medium">{currencySymbol}{(Number(item.price) || 0).toFixed(2)}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground">Est. Cost</p>
                                    <p className="font-medium">{currencySymbol}{(Number(cost) || 0).toFixed(2)}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground">Remaining</p>
                                    {portionQuantityDisplay ? (
                                        <>
                                            <p className="font-medium">{portionQuantityDisplay.wholeUnitsText}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {portionQuantityDisplay.remainingPortionsText} remaining
                                            </p>
                                        </>
                                    ) : (
                                        <p className="font-medium">
                                            {formattedStockUnits} <span className="text-muted-foreground">{item.unitType || 'unit'}</span>
                                        </p>
                                    )}
                                    {false && item.isSoldInPortions && item.portionsPerUnit && (
                                        <p className="text-xs text-muted-foreground mt-1">
                                            placeholder
                                        </p>
                                    )}
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    <p className="text-muted-foreground">Stock</p>
                                    <p className="font-medium">{formattedStockUnits} <span className="text-muted-foreground">{item.unitType}</span></p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground">Value</p>
                                    <p className="font-medium">{currencySymbol}{toSafeNumber(displayValue).toFixed(2)}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground">Supplier</p>
                                    <p className="font-medium">{item.supplier}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground">Cost/Unit</p>
                                    <p className="font-medium">{currencySymbol}{(Number(item.cost) || 0).toFixed(2)}</p>
                                </div>
                            </>
                        )}
                    </div>
                </CardContent>
            </Card>
        );
    };

    const renderMobileListItem = (item: InventoryItem) => {
        const isSellable = item.itemType === 'sellable';
        const estimatedRecipeCost = calculateCost(item.recipe);
        const cost = isSellable && estimatedRecipeCost > 0
            ? estimatedRecipeCost
            : toSafeNumber(item.cost);
        const isRecipeManaged = isProducedInHouseSellable(item);
        const displayStatus = isRecipeManaged ? undefined : item.status;
        const displayValue = getDisplayValue(item);
        const formattedStockUnits = formatInventoryQuantity(item.stockUnits, {
            preferWholeNumbers: preferWholeStockCounts,
        });
        const portionQuantityDisplay =
            isSellable && item.isSoldInPortions && item.portionsPerUnit
                ? getPortionQuantityDisplay({
                    quantity: item.stockUnits,
                    unitLabel: item.unitType || 'unit',
                    portionName: item.portionName,
                    portionsPerUnit: item.portionsPerUnit,
                })
                : null;
        const primaryAmount = isSellable
            ? `${currencySymbol}${(Number(item.price) || 0).toFixed(2)}`
            : `${formattedStockUnits} ${item.unitType || 'unit'}`;
        const secondaryAmount = isSellable
            ? portionQuantityDisplay
                ? portionQuantityDisplay.wholeUnitsText
                : `${formattedStockUnits} ${item.unitType || 'unit'}`
            : `${currencySymbol}${toSafeNumber(displayValue).toFixed(2)}`;
        const supportLabel = isSellable
            ? `Cost ${currencySymbol}${toSafeNumber(cost).toFixed(2)}`
            : item.supplier || 'No supplier';

        return (
            <div
                key={item.id}
                className="flex min-h-[4.25rem] items-center gap-3 border-b px-1 py-2.5 last:border-b-0"
            >
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => handleViewDetails(item)}
                >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                        {React.cloneElement(renderIcon(item) as React.ReactElement, {
                            className: 'h-5 w-5 text-muted-foreground',
                        })}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <p className="truncate text-sm font-semibold leading-5">{item.name}</p>
                            {item.isVariablePrice && (
                                <Badge variant="outline" className="hidden shrink-0 px-1.5 text-[10px] min-[380px]:inline-flex">
                                    {getVariablePriceLabel(item.unitType)}
                                </Badge>
                            )}
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{item.category || 'Uncategorized'}</span>
                            <span className="shrink-0">•</span>
                            <span className="truncate">{supportLabel}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {showItemTypeBadge && (
                                <Badge variant={isSellable ? 'default' : 'outline'} className="h-5 px-1.5 text-[10px]">
                                    {item.itemType}
                                </Badge>
                            )}
                            {isRecipeManaged ? (
                                <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                                    Recipe managed
                                </Badge>
                            ) : displayStatus && (
                                <Badge variant={statusBadgeVariant[displayStatus]} className="h-5 px-1.5 text-[10px]">
                                    {displayStatus === 'Low Stock' && <AlertCircle className="mr-1 h-3 w-3" />}
                                    {displayStatus}
                                </Badge>
                            )}
                        </div>
                    </div>
                    <div className="w-[4.75rem] shrink-0 text-right">
                        <p className="truncate text-sm font-semibold">{primaryAmount}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{secondaryAmount}</p>
                    </div>
                </button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
                            <MoreHorizontal className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => handleViewDetails(item)}><Eye className="mr-2" /> View Details</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onEditItem(item)}><Edit className="mr-2" /> Edit Item</DropdownMenuItem>
                        <DropdownMenuItem><History className="mr-2" /> View History</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => handleDeleteItem(item.id)} className="text-destructive"><Trash2 className="mr-2" /> Delete Item</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        );
    };

    return (
         <CardContent className="px-3 sm:px-6">
            <div className="mb-4 flex w-full flex-col items-stretch gap-2 sm:mb-6 sm:flex-row">
                <Button onClick={onAddItem}>
                    <PlusCircle className="mr-2 h-4 w-4" /> {currentConfig.addText}
                </Button>
                {/* <Button variant="outline" onClick={onTransfer}>
                    <Repeat className="mr-2 h-4 w-4" /> Transfer Stock
                </Button> */}
                <div className="flex items-center justify-between gap-2 sm:ml-auto sm:justify-end">
                {isMobile && (
                    <div className="grid h-10 grid-cols-2 rounded-md border bg-muted/30 p-1">
                        <Button
                            type="button"
                            variant={mobileViewMode === 'list' ? 'secondary' : 'ghost'}
                            size="sm"
                            className="h-8 px-2"
                            onClick={() => setMobileViewMode('list')}
                            title="Compact list"
                        >
                            <List className="h-4 w-4" />
                            <span className="sr-only">Compact list</span>
                        </Button>
                        <Button
                            type="button"
                            variant={mobileViewMode === 'cards' ? 'secondary' : 'ghost'}
                            size="sm"
                            className="h-8 px-2"
                            onClick={() => setMobileViewMode('cards')}
                            title="Cards"
                        >
                            <LayoutGrid className="h-4 w-4" />
                            <span className="sr-only">Cards</span>
                        </Button>
                    </div>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                    <Button variant="outline" className='h-10 w-10 p-0'>
                        <MoreHorizontal className="h-4 w-4" />
                    </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={onImport}><Upload className="mr-2" /> Import Products</DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleExport}><Download className="mr-2" /> Export Stock File</DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <Link href="/dashboard/inventory/audit"><ClipboardList className="mr-2" /> Full Stock Audit</Link>
                    </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                </div>
            </div>
            <div className="mb-4 overflow-x-auto pb-1">
                <div className="flex w-max min-w-full gap-2">
                    {inventoryKindFilters.map((filter) => (
                        <Button
                            key={filter.value}
                            type="button"
                            variant={kindFilter === filter.value ? 'default' : 'outline'}
                            size="sm"
                            className="shrink-0"
                            onClick={() => setKindFilter(filter.value)}
                        >
                            {filter.label}
                            <Badge
                                variant={kindFilter === filter.value ? 'secondary' : 'outline'}
                                className="ml-2"
                            >
                                {filter.count}
                            </Badge>
                        </Button>
                    ))}
                </div>
            </div>
            {isMobile ? (
                filteredInventoryData.length > 0 ? (
                <div className={mobileViewMode === 'cards' ? 'space-y-3' : 'overflow-hidden rounded-md border'}>
                        {paginatedInventoryData.map(mobileViewMode === 'cards' ? renderMobileCard : renderMobileListItem)}
                </div>
                ) : (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {normalizedSearchTerm ? `No products match "${searchTerm.trim()}".` : 'No products found for this filter.'}
                </div>
                )
            ) : (
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            {renderTableHeader()}
                        </TableHeader>
                        <TableBody>
                            {filteredInventoryData.length > 0 ? (
                                paginatedInventoryData.map(renderTableRow)
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                                        {normalizedSearchTerm ? `No products match "${searchTerm.trim()}".` : 'No products found for this filter.'}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            )}

            <PaginationControls
                currentPage={effectiveCurrentPage}
                totalItems={totalItems}
                totalPages={totalPages}
                pageStartIndex={pageStartIndex}
                pageEndIndex={pageEndIndex}
                onPageChange={setCurrentPage}
                itemLabel="products"
            />

            {/* Product Details Modal */}
            <ProductDetailsModal
                product={selectedProduct}
                isOpen={isDetailsModalOpen}
                onOpenChange={setIsDetailsModalOpen}
                onEdit={handleEditFromDetails}
                currentBusinessType={currentBusinessType}
            />
        </CardContent>
    )
}
