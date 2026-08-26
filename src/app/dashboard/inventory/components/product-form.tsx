
'use client';

import React, { useEffect } from 'react';
import { useForm, FormProvider, useFieldArray, useWatch } from 'react-hook-form';
import { format } from 'date-fns';
import { Utensils, Beef, BookOpen, Plus, X, Barcode as BarcodeIcon } from 'lucide-react';

import { db, type InventoryItem, type Supplier, type RecipeIngredient } from '@/lib/db';
import {
    type BusinessType,
    ingredientCategories,
    purchasedCategories,
    sellableCategories,
    unitTypesByBusinessType,
} from '@/lib/inventory/config';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { createProduct, updateProduct } from '@/lib/services/product-service';
import { SHOW_FUEL_FEATURES } from '@/lib/fuel-features';
import { useIsMobile } from '@/hooks/use-mobile';
import { normalizeBarcodeValue } from '@/lib/barcode';
import {
    readStoredCustomSalesSectionSettings,
    resolveCustomSalesSectionSettings,
} from '@/lib/custom-sales-section';

import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { CameraBarcodeScannerModal, type BarcodeDetectionOutcome } from '@/components/pos/camera-barcode-scanner-modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useLiveQuery } from 'dexie-react-hooks';

const REORDER_LEVEL_PRESETS = [5, 10, 20, 50] as const;
const DEFAULT_REORDER_LEVEL = REORDER_LEVEL_PRESETS[0];

const normalizeReorderLevelForForm = (value?: number | null): number => {
    const parsed = Number(value);
    if (REORDER_LEVEL_PRESETS.includes(parsed as (typeof REORDER_LEVEL_PRESETS)[number])) {
        return parsed;
    }
    return DEFAULT_REORDER_LEVEL;
};

const toPositiveNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const roundMoney = (value: number): number => Number(value.toFixed(2));

const isPortionedSellable = (item?: InventoryItem | null): boolean => (
    Boolean(item?.isSoldInPortions) && toPositiveNumber(item?.portionsPerUnit, 0) > 0
);

const formatPortionStockQuantity = (item: InventoryItem): string => {
    const portionsPerUnit = toPositiveNumber(item.portionsPerUnit, 0);
    if (portionsPerUnit <= 0) {
        return '';
    }

    return Number((1 / portionsPerUnit).toFixed(6)).toString();
};

const VARIABLE_PRICE_BUSINESS_TYPES = new Set<BusinessType>([
    'Restaurant',
    'Bar & Liquor',
    'Grocery',
    'Supermarket',
    'Clothing & Fashion',
    'Hardware',
    'General Retail',
]);

const getProductNamePlaceholder = (businessType: BusinessType, itemType: InventoryItem['itemType']): string => {
    if (itemType === 'ingredient') {
        return businessType === 'Bar & Liquor' ? 'e.g., Lemon Juice' : 'e.g., Roma Tomatoes';
    }

    switch (businessType) {
    case 'Clothing & Fashion':
        return 'e.g., Black Polo Shirt - Medium';
    case 'Hardware':
        return 'e.g., 20mm PVC Pipe';
    case 'Beauty Salon and Spa':
        return 'e.g., Hair Treatment Cream';
    case 'Pharmacy':
        return 'e.g., Paracetamol 500mg';
    case 'Supermarket':
        return 'e.g., Milk 300ml';
    case 'Grocery':
        return 'e.g., Fresh Tomatoes';
    case 'Bar & Liquor':
        return 'e.g., Whisky Bottle';
    case 'Restaurant':
        return 'e.g., Margherita Pizza';
    default:
        return 'e.g., Product Name';
    }
};

const getProductCodePlaceholder = (businessType: BusinessType): string => {
    switch (businessType) {
    case 'Clothing & Fashion':
        return 'e.g., POLO-BLK-M';
    case 'Hardware':
        return 'e.g., PVC-20MM';
    default:
        return 'e.g., PROD-001';
    }
};

const getSkuPlaceholder = (businessType: BusinessType): string => {
    switch (businessType) {
    case 'Clothing & Fashion':
        return 'e.g., STYLE-100-BLK-M';
    case 'Hardware':
        return 'e.g., BIN-A3-SHELF-02';
    default:
        return 'e.g., SKU-001';
    }
};

const getVariablePriceDescription = (businessType: BusinessType): string => {
    switch (businessType) {
    case 'Restaurant':
        return 'Enable for sellable items priced by weight, portion size, or custom service amount.';
    case 'Bar & Liquor':
        return 'Enable for sellable drinks priced by volume, custom pour, or negotiated amount.';
    case 'Clothing & Fashion':
        return 'Enable for fabric or trims sold by meter, yard, or weight.';
    case 'Hardware':
        return 'Enable for cable, pipe, timber, paint, or materials sold by length, weight, or volume.';
    case 'General Retail':
        return 'Enable for products sold by length, weight, or volume.';
    default:
        return 'Enable if product is sold by weight/volume (e.g. kg, L).';
    }
};

export const AddProductForm = ({
    businessType,
    suppliers,
    ingredients,
    onFormSubmit,
    defaultValues,
    branchId,
}: {
    businessType: BusinessType;
    suppliers: Supplier[];
    ingredients: InventoryItem[];
    onFormSubmit: () => void;
    defaultValues?: Partial<InventoryItem>;
    branchId: string;
}) => {
    const { user } = useAuth();
    const businessRecord = useLiveQuery(
        () => user?.businessId ? db.business.get(user.businessId) : undefined,
        [user?.businessId]
    );
    const isRestaurantOrBar = businessType === 'Restaurant' || businessType === 'Bar & Liquor';
    const supportsVariablePrice = VARIABLE_PRICE_BUSINESS_TYPES.has(businessType);
    const isMobile = useIsMobile();
    const [isBarcodeScannerOpen, setIsBarcodeScannerOpen] = React.useState(false);
    const isAndroidUserAgent = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
    const isAndroidTauri =
        typeof document !== 'undefined' && document.documentElement.getAttribute('data-tauri-android') === 'true';
    
    const unitTypes = unitTypesByBusinessType[businessType] || [];
    const unitOptionsListId = `unit-options-${businessType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const categoryOptionsListId = `category-options-${businessType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const form = useForm<InventoryItem>({
      defaultValues: {
          branchId,
          name: '',
          category: '',
          itemType: 'sellable',
          stockUnits: 0,
          price: 0,
          cost: 0,
          recipe: [],
          reorderLevel: DEFAULT_REORDER_LEVEL,
          isVariablePrice: false,
          isFuel: false,
          showInCustomSalesSection: false,
          portionPrice: undefined,
      }
    });

    const { handleSubmit, control, watch, reset, setValue } = form;
    const canUseCameraScanner =
        (isMobile || isAndroidUserAgent || isAndroidTauri)
        && typeof window !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia;

    const { fields, append, remove } = useFieldArray({
        control,
        name: "recipe",
    });

    const itemType = useWatch({ control, name: 'itemType' });
    const isVariablePrice = useWatch({ control, name: 'isVariablePrice' });
    const isProduced = useWatch({ control, name: 'isProduced' });
    const isSoldInPortions = useWatch({ control, name: 'isSoldInPortions' });
    const showInCustomSalesSection = useWatch({ control, name: 'showInCustomSalesSection' });
    const portionName = useWatch({ control, name: 'portionName' });
    const portionsPerUnit = useWatch({ control, name: 'portionsPerUnit' });
    const portionPrice = useWatch({ control, name: 'portionPrice' });
    const price = useWatch({ control, name: 'price' });
    const unitType = useWatch({ control, name: 'unitType' });
    const [portionPricingMode, setPortionPricingMode] = React.useState<'auto' | 'custom'>('auto');
    const [customSalesSectionSettings, setCustomSalesSectionSettings] = React.useState({
        enabled: false,
        name: '',
    });
    const hasSelectedUnit = Boolean((unitType || '').trim());
    const canConfigurePortions = isRestaurantOrBar && itemType === 'sellable' && !isProduced;
    const categoryOptions = React.useMemo(() => {
        if (itemType === 'ingredient') {
            return ingredientCategories[businessType] || [];
        }
        if (isRestaurantOrBar && !isProduced) {
            return purchasedCategories[businessType] || sellableCategories[businessType] || [];
        }
        return sellableCategories[businessType] || [];
    }, [businessType, isProduced, isRestaurantOrBar, itemType]);
    const portionDescription =
        businessType === 'Restaurant'
            ? 'Enable when this purchased product is bought as a full unit and sold in smaller servings, cups, slices, or glasses.'
            : 'Enable when this purchased product is bought as a full unit and sold in smaller portions like shots, tots, glasses, or cups.';
    const computedPortionPrice =
        isSoldInPortions && Number(portionsPerUnit) > 0 && Number(price) > 0
            ? roundMoney(Number(price) / Number(portionsPerUnit))
            : undefined;
    const customPortionPrice = Number(portionPrice || 0);
    const displayedPortionPrice =
        portionPricingMode === 'custom' && customPortionPrice > 0
            ? customPortionPrice
            : computedPortionPrice;
    const customSalesSectionName = customSalesSectionSettings.name || 'Custom section';

    const resetPortionFields = React.useCallback(() => {
        setValue('isSoldInPortions', false);
        setValue('portionName', undefined);
        setValue('portionsPerUnit', undefined);
        setValue('portionPrice', undefined);
    }, [setValue]);

    useEffect(() => {
        if (canConfigurePortions) {
            return;
        }

        if (isSoldInPortions || portionName || portionsPerUnit || portionPrice) {
            resetPortionFields();
        }
    }, [canConfigurePortions, isSoldInPortions, portionName, portionsPerUnit, portionPrice, resetPortionFields]);

    React.useEffect(() => {
        const storedSettings = readStoredCustomSalesSectionSettings();
        setCustomSalesSectionSettings(
            resolveCustomSalesSectionSettings(
                businessRecord as Record<string, any> | null,
                storedSettings
            )
        );

        if (typeof window === 'undefined') return;

        const refreshFromStorage = () => {
            const currentStored = readStoredCustomSalesSectionSettings();
            setCustomSalesSectionSettings(
                resolveCustomSalesSectionSettings(
                    businessRecord as Record<string, any> | null,
                    currentStored
                )
            );
        };

        window.addEventListener('storage', refreshFromStorage);
        window.addEventListener('focus', refreshFromStorage);
        window.addEventListener('handypos-business-settings-changed', refreshFromStorage);
        return () => {
            window.removeEventListener('storage', refreshFromStorage);
            window.removeEventListener('focus', refreshFromStorage);
            window.removeEventListener('handypos-business-settings-changed', refreshFromStorage);
        };
    }, [businessRecord]);

    React.useEffect(() => {
        if (!customSalesSectionSettings.enabled && showInCustomSalesSection) {
            setValue('showInCustomSalesSection', false);
        }
    }, [customSalesSectionSettings.enabled, setValue, showInCustomSalesSection]);

    React.useEffect(() => {
        if (isProduced && isVariablePrice) {
            setValue('isVariablePrice', false);
        }
    }, [isProduced, isVariablePrice, setValue]);

    // Log suppliers for debugging
    React.useEffect(() => {
        console.log('[ProductForm] Suppliers received:', suppliers.length);
        console.log('[ProductForm] Suppliers data:', suppliers.map(s => ({ id: s.id, name: s.name })));
    }, [suppliers]);

    // Global barcode scanner listener - prevent form submission on Enter when scanning
    React.useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            // Check if this is an Enter key press
            if (e.key !== 'Enter') {
                return;
            }

            // Get the currently focused element
            const activeElement = document.activeElement as HTMLInputElement;
            
            // If no element is focused, do nothing
            if (!activeElement) {
                return;
            }

            // Check if the focused element is a form input (but not the barcode field)
            const isFormInput = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'SELECT';
            const isBarcodeField = activeElement.name === 'barcode';
            
            // If it's a form input but NOT the barcode field, and Enter is pressed,
            // this might be a barcode scan (barcode scanners typically end with Enter)
            // So we should prevent the default form submission
            if (isFormInput && !isBarcodeField) {
                // Check if the input value looks like it could be a barcode
                // (typically barcodes are numeric or alphanumeric strings)
                const inputValue = activeElement.value;
                
                // If the field just received input (barcode scan), prevent form submission
                // by checking if this is likely a barcode scan (rapid input followed by Enter)
                if (inputValue && inputValue.length > 0) {
                    // Prevent the Enter key from submitting the form
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, []);

    // When defaultValues change (i.e., when opening the dialog to edit),
    // reset the form with the new default values.
    // This must happen AFTER the form is initialized
    useEffect(() => {
        console.log('[ProductForm] useEffect triggered with defaultValues:', defaultValues?.id, 'isRestaurantOrBar:', isRestaurantOrBar);
        
        if (defaultValues && defaultValues.id) {
            console.log('[ProductForm] Resetting form with defaultValues:', defaultValues);
            const defaultPortionsPerUnit = Number(defaultValues.portionsPerUnit || 0);
            const defaultFullUnitPrice = Number(defaultValues.price || 0);
            const defaultPortionPrice = Number(defaultValues.portionPrice || 0);
            const defaultCalculatedPortionPrice = defaultPortionsPerUnit > 0 && defaultFullUnitPrice > 0
                ? roundMoney(defaultFullUnitPrice / defaultPortionsPerUnit)
                : 0;
            setPortionPricingMode(
                defaultPortionPrice > 0 && Math.abs(defaultPortionPrice - defaultCalculatedPortionPrice) > 0.009
                    ? 'custom'
                    : 'auto'
            );
            const resetData = {
                ...defaultValues,
                itemType: defaultValues.itemType ?? (isRestaurantOrBar ? 'ingredient' : 'sellable'),
                // Ensure all fields are present
                stockUnits: defaultValues.stockUnits ?? 0,
                price: defaultValues.price ?? 0,
                cost: defaultValues.cost ?? 0,
                reorderLevel: normalizeReorderLevelForForm(defaultValues.reorderLevel),
                isVariablePrice: defaultValues.isVariablePrice ?? false,
                isFuel: defaultValues.isFuel ?? false,
                showInCustomSalesSection: defaultValues.showInCustomSalesSection ?? false,
                isProduced: defaultValues.isProduced ?? false,
                isSoldInPortions: defaultValues.isSoldInPortions ?? false,
                portionPrice: defaultValues.portionPrice ?? undefined,
                recipe: defaultValues.recipe ?? [],
            };
            console.log('[ProductForm] Reset data:', resetData);
            reset(resetData);
        } else {
            console.log('[ProductForm] Resetting form to empty state');
            setPortionPricingMode('auto');
            reset({
                branchId,
                name: '',
                category: '',
                itemType: 'sellable',
                stockUnits: 0,
                price: 0,
                cost: 0,
                recipe: [],
                reorderLevel: DEFAULT_REORDER_LEVEL,
                isVariablePrice: false,
                isFuel: false,
                showInCustomSalesSection: false,
                isProduced: false,
                isSoldInPortions: false,
                portionPrice: undefined,
            });
        }
    }, [defaultValues?.id, isRestaurantOrBar, branchId, reset]);

    const handleProductBarcodeDetected = React.useCallback(async (barcode: string): Promise<BarcodeDetectionOutcome> => {
        const trimmedBarcode = normalizeBarcodeValue(barcode);
        if (!trimmedBarcode) {
            return {
                accepted: false,
                message: 'Invalid barcode value.',
            };
        }

        setValue('barcode', trimmedBarcode, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
        });
        setIsBarcodeScannerOpen(false);
        toast({
            title: 'Barcode Captured',
            description: `Barcode ${trimmedBarcode} added to the product form.`,
        });

        return {
            accepted: true,
            productName: 'Product barcode',
        };
    }, [setValue]);
    
    const onSubmit = async (data: Partial<InventoryItem>) => {
        if (!user) {
            toast({ variant: 'destructive', title: 'Not authenticated.'});
            return;
        }
        
        try {
            console.log('[ProductForm] Form data received:', data);
            console.log('[ProductForm] stockUnits value:', data.stockUnits, 'type:', typeof data.stockUnits);
            console.log('[ProductForm] cost value:', data.cost, 'type:', typeof data.cost);
            console.log('[ProductForm] price value:', data.price, 'type:', typeof data.price);
            console.log('[ProductForm] itemType from form:', data.itemType, 'isRestaurantOrBar:', isRestaurantOrBar);
            
            // Determine final item type - ensure it's always set correctly
            let finalItemType: InventoryItem['itemType'] = data.itemType === 'ingredient' ? 'ingredient' : 'sellable';
            if (!isRestaurantOrBar) {
                // For non-restaurant businesses, always force sellable
                finalItemType = 'sellable';
            }
            
            console.log('[ProductForm] Final itemType:', finalItemType);
            
            const isEditing = !!defaultValues?.id;
            const supportsProducedItems = isRestaurantOrBar && finalItemType === 'sellable';
            const normalizedIsProduced = supportsProducedItems ? Boolean(data.isProduced) : false;
            const supportsPortions =
                isRestaurantOrBar &&
                finalItemType === 'sellable' &&
                !normalizedIsProduced;
            // Parse numeric values early because portion pricing depends on the full-unit price.
            const stockUnitsValue = isEditing && defaultValues?.stockUnits !== undefined 
                ? Number(defaultValues.stockUnits) 
                : 0;
            const costValue = data.cost !== undefined && data.cost !== null ? Number(data.cost) : 0;
            const priceValue = data.price !== undefined && data.price !== null ? Number(data.price) : 0;
            const reorderLevelValue = normalizeReorderLevelForForm(data.reorderLevel);
            const normalizedIsSoldInPortions = supportsPortions ? Boolean(data.isSoldInPortions) : false;
            const normalizedPortionName = normalizedIsSoldInPortions
                ? String(data.portionName || '').trim()
                : '';
            const normalizedPortionsPerUnit = normalizedIsSoldInPortions
                ? (Number(data.portionsPerUnit) > 0 ? Number(data.portionsPerUnit) : undefined)
                : undefined;
            const calculatedPortionPrice = normalizedIsSoldInPortions && normalizedPortionsPerUnit && priceValue > 0
                ? roundMoney(priceValue / normalizedPortionsPerUnit)
                : undefined;
            if (
                normalizedIsSoldInPortions &&
                portionPricingMode === 'custom' &&
                !(Number(data.portionPrice) > 0)
            ) {
                toast({
                    variant: 'destructive',
                    title: 'Portion price required',
                    description: 'Enter your selling price per portion, or choose calculated pricing.',
                });
                return;
            }
            const normalizedPortionPrice = normalizedIsSoldInPortions
                ? (
                    portionPricingMode === 'custom'
                        ? roundMoney(Number(data.portionPrice))
                        : calculatedPortionPrice
                )
                : undefined;
            const normalizedRecipe = supportsProducedItems && normalizedIsProduced
                ? data.recipe
                    ?.map((recipeItem) => ({
                        ...recipeItem,
                        quantity: Number(recipeItem.quantity),
                    }))
                    .filter((recipeItem) => recipeItem.ingredientId && Number(recipeItem.quantity) > 0)
                : [];
            const normalizedIsFuel = SHOW_FUEL_FEATURES ? Boolean(data.isFuel) : false;
            const normalizedShowInCustomSalesSection =
                customSalesSectionSettings.enabled &&
                finalItemType === 'sellable' &&
                Boolean(data.showInCustomSalesSection);
            const normalizedIsVariablePrice =
                supportsVariablePrice &&
                finalItemType === 'sellable' &&
                !normalizedIsProduced &&
                Boolean(data.isVariablePrice);

            const normalizedCategory = String(data.category || '').trim();
            const normalizedStatus: InventoryItem['status'] = normalizedIsProduced
                ? 'In Stock'
                : stockUnitsValue > reorderLevelValue
                    ? 'In Stock'
                    : (stockUnitsValue > 0 ? 'Low Stock' : 'Out of Stock');

            console.log('[ProductForm] Parsed values - stockUnits:', stockUnitsValue, 'cost:', costValue, 'price:', priceValue);

            // Build complete item data with all fields
            // For updates, we need to include ALL fields, not just changed ones
            // This ensures the backend receives complete data for proper sync
            const itemData: Omit<InventoryItem, 'id'> = {
                branchId: branchId,
                name: data.name!,
                itemType: finalItemType!,
                category: normalizedCategory,
                status: normalizedStatus,
                supplier: data.supplier || 'N/A',
                manufacturer: data.manufacturer || '',
                batch: data.batch || '',
                unitType: data.unitType || 'unit',
                reorderLevel: reorderLevelValue,
                expiry: data.expiry ? format(new Date(data.expiry), 'yyyy-MM-dd') : undefined,
                stockUnits: stockUnitsValue,
                cost: costValue > 0 ? costValue : undefined,
                value: stockUnitsValue * costValue,
                price: finalItemType === 'sellable' ? (priceValue > 0 ? priceValue : undefined) : undefined,
                recipe: normalizedRecipe,
                isVariablePrice: normalizedIsVariablePrice,
                isFuel: normalizedIsFuel,
                showInCustomSalesSection: normalizedShowInCustomSalesSection,
                isProduced: normalizedIsProduced,
                isSoldInPortions: normalizedIsSoldInPortions,
                portionName: normalizedPortionName || undefined,
                portionsPerUnit: normalizedPortionsPerUnit,
                portionPrice: normalizedPortionPrice,
                // Include product identifiers
                productCode: data.productCode || undefined,
                barcode: data.barcode || undefined,
                sku: data.sku || undefined,
                brand: data.brand || undefined,
                // Include all other fields from defaultValues for updates to preserve data
                ...(isEditing && defaultValues ? {
                    packSize: defaultValues.packSize,
                    isRecipeIngredient: defaultValues.isRecipeIngredient,
                    onMenu: defaultValues.onMenu,
                    image: defaultValues.image,
                } : {})
            };
            
            console.log('[ProductForm] itemData being sent:', itemData);

            if (isEditing && defaultValues?.id) {
                // Update existing product (offline-first)
                // Pass the complete merged data to ensure all fields are synced
                await updateProduct(
                    defaultValues.id,
                    itemData,
                    user.uid,
                    user.displayName || user.email || 'Unknown',
                    branchId
                );
                toast({
                    title: 'Item Updated',
                    description: `"${itemData.name}" has been saved locally. It will sync when online.`,
                });
            } else {
                // Create new product (offline-first)
                await createProduct(
                    itemData,
                    user.uid,
                    user.displayName || user.email || 'Unknown'
                );
                toast({
                    title: 'Item Added',
                    description: `"${itemData.name}" has been saved locally. It will sync when online.`,
                });
            }

            reset();
            onFormSubmit();
        } catch (error) {
            console.error('Failed to save product:', error);
            toast({
                variant: 'destructive',
                title: 'Error',
                description: 'Failed to save product. Please try again.',
            });
        }
    };

    return (
        <FormProvider {...form}>
            <>
            <form onSubmit={handleSubmit(onSubmit)} className="grid gap-6">
                {isRestaurantOrBar && (
                    <>
                        <FormField
                            control={control}
                            name="itemType"
                            render={({ field }) => (
                                <FormItem className="space-y-3">
                                    <FormLabel>What are you adding?</FormLabel>
                                    <FormControl>
                                        <RadioGroup
                                            onValueChange={field.onChange}
                                            value={field.value}
                                            className="grid grid-cols-2 gap-4"
                                        >
                                            <FormItem>
                                                <RadioGroupItem value="ingredient" id="ingredient" className="sr-only" />
                                                <Label 
                                                    htmlFor="ingredient" 
                                                    className={`flex flex-col items-center justify-center rounded-md border-2 bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer transition-all ${
                                                        itemType === 'ingredient' 
                                                            ? 'border-primary outline outline-2 outline-primary outline-offset-2' 
                                                            : 'border-muted'
                                                    }`}
                                                >
                                                    <Beef className="mb-3 h-6 w-6" />
                                                    Ingredient
                                                </Label>
                                            </FormItem>
                                            <FormItem>
                                                <RadioGroupItem value="sellable" id="sellable" className="sr-only" />
                                                <Label 
                                                    htmlFor="sellable" 
                                                    className={`flex flex-col items-center justify-center rounded-md border-2 bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer transition-all ${
                                                        itemType === 'sellable' 
                                                            ? 'border-primary outline outline-2 outline-primary outline-offset-2' 
                                                            : 'border-muted'
                                                    }`}
                                                >
                                                    <Utensils className="mb-3 h-6 w-6" />
                                                    Sellable Product
                                                </Label>
                                            </FormItem>
                                        </RadioGroup>
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <Separator />
                    </>
                )}

                {isRestaurantOrBar && itemType === 'sellable' && (
                    <>
                    <FormField
                        control={form.control}
                        name="isProduced"
                        render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                            <div className="space-y-0.5">
                            <FormLabel>This is a Produced Item</FormLabel>
                            <FormDescription>
                                Enable if this product is made in-house using a recipe. Disable if it's a purchased product.
                            </FormDescription>
                            </div>
                            <FormControl>
                            <Switch
                                checked={field.value}
                                onCheckedChange={(checked) => {
                                    field.onChange(checked);
                                    // Reset category when toggling isProduced to show appropriate categories
                                    setValue('category', '');
                                    if (checked) {
                                        setValue('isVariablePrice', false);
                                    }
                                    if (checked) {
                                        resetPortionFields();
                                    }
                                }}
                            />
                            </FormControl>
                        </FormItem>
                        )}
                    />
                    </>
                )}
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                     <FormField
                        control={control}
                        name="name"
                        rules={{ required: "Item name is required" }}
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Item Name</FormLabel>
                                <FormControl>
                                    <Input placeholder={getProductNamePlaceholder(businessType, itemType || 'sellable')} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={control}
                        name="productCode"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Product Code</FormLabel>
                                <FormControl>
                                    <Input placeholder={getProductCodePlaceholder(businessType)} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>

                <div className="grid grid-cols-1 gap-4">
                    <FormField
                        control={control}
                        name="category"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Category</FormLabel>
                                <FormControl>
                                    <Input
                                        list={categoryOptionsListId}
                                        placeholder="Type a category (optional)"
                                        value={field.value || ''}
                                        onChange={(event) => field.onChange(event.target.value)}
                                    />
                                </FormControl>
                                <datalist id={categoryOptionsListId}>
                                    {categoryOptions.map((category) => (
                                        <option key={category} value={category} />
                                    ))}
                                </datalist>
                                <FormDescription>
                                    Optional. Use any label you want for grouping and filtering.
                                </FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>

                {customSalesSectionSettings.enabled && itemType === 'sellable' && (
                    <FormField
                        control={form.control}
                        name="showInCustomSalesSection"
                        render={({ field }) => (
                            <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                                <div className="space-y-0.5">
                                    <FormLabel>Show in {customSalesSectionName}</FormLabel>
                                    <FormDescription>
                                        Include this product in the internal {customSalesSectionName} section and reporting.
                                    </FormDescription>
                                </div>
                                <FormControl>
                                    <Switch
                                        checked={field.value}
                                        onCheckedChange={field.onChange}
                                    />
                                </FormControl>
                            </FormItem>
                        )}
                    />
                )}

                {!isRestaurantOrBar && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField
                            control={control}
                            name="sku"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{businessType === 'Clothing & Fashion' ? 'SKU / Variant Code' : 'SKU'}</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder={getSkuPlaceholder(businessType)}
                                            {...field}
                                            value={field.value || ''}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={control}
                            name="brand"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{businessType === 'Hardware' ? 'Brand / Manufacturer' : 'Brand'}</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder={businessType === 'Hardware' ? 'e.g., Bosch, Dulux, Ingco' : 'e.g., Brand name'}
                                            {...field}
                                            value={field.value || ''}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    </div>
                )}

                <div className="grid grid-cols-1 gap-4">
                    <FormField
                        control={control}
                        name="barcode"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Barcode</FormLabel>
                                <FormControl>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            placeholder="e.g., 5901234123457 (scan or type)"
                                            {...field}
                                            value={field.value || ''}
                                            onKeyDown={(e) => {
                                                // Prevent form submission when Enter is pressed on barcode field
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }
                                            }}
                                        />
                                        {canUseCameraScanner ? (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                className="shrink-0"
                                                onClick={() => setIsBarcodeScannerOpen(true)}
                                            >
                                                <BarcodeIcon className="mr-2 h-4 w-4" />
                                                Scan
                                            </Button>
                                        ) : null}
                                    </div>
                                </FormControl>
                                <FormDescription>
                                    {canUseCameraScanner
                                        ? 'Scan with the camera or type the product barcode for quick lookup at POS. Leave blank if unavailable.'
                                        : 'Scan or type the product barcode for quick lookup at POS. Leave blank if unavailable.'}
                                </FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>

                {supportsVariablePrice && itemType === 'sellable' && !isProduced && (
                     <FormField
                        control={form.control}
                        name="isVariablePrice"
                        render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                            <div className="space-y-0.5">
                            <FormLabel>Variable Price</FormLabel>
                            <FormDescription>
                                {getVariablePriceDescription(businessType)}
                            </FormDescription>
                            </div>
                            <FormControl>
                            <Switch
                                checked={field.value}
                                onCheckedChange={(checked) => field.onChange(checked)}
                            />
                            </FormControl>
                        </FormItem>
                        )}
                    />
                )}

                {SHOW_FUEL_FEATURES && !isRestaurantOrBar && itemType === 'sellable' && (
                     <FormField
                        control={form.control}
                        name="isFuel"
                        render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                            <div className="space-y-0.5">
                            <FormLabel>Fuel Item</FormLabel>
                            <FormDescription>
                                Enable for fuel products so only fuel attendants can sell them.
                            </FormDescription>
                            </div>
                            <FormControl>
                            <Switch
                                checked={field.value}
                                onCheckedChange={field.onChange}
                            />
                            </FormControl>
                        </FormItem>
                        )}
                    />
                )}

                {(itemType === 'ingredient' || !isRestaurantOrBar) && (
                     <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                             <FormField
                                control={control}
                                name="unitType"
                                rules={{ required: 'Unit is required before pricing.' }}
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Unit</FormLabel>
                                        <FormControl>
                                            <Input
                                                list={unitOptionsListId}
                                                placeholder="Type or select a unit"
                                                value={field.value || ''}
                                                onChange={(event) => field.onChange(event.target.value)}
                                            />
                                        </FormControl>
                                        <datalist id={unitOptionsListId}>
                                            {unitTypes.map((unit) => (
                                                <option key={unit} value={unit} />
                                            ))}
                                        </datalist>
                                        <FormDescription>
                                            Type to search units, then enter prices.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                             <FormField
                                control={control}
                                name="reorderLevel"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Reorder Level</FormLabel>
                                        <Select
                                            onValueChange={(selectedValue) => field.onChange(Number(selectedValue))}
                                            value={String(normalizeReorderLevelForForm(field.value))}
                                        >
                                            <FormControl>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select reorder level" />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                {REORDER_LEVEL_PRESETS.map((level) => (
                                                    <SelectItem key={level} value={String(level)}>
                                                        {level}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FormDescription>
                                            Stock warning appears when quantity reaches this level.
                                        </FormDescription>
                                    </FormItem>
                                )}
                            />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                             <FormField
                                control={control}
                                name="cost"
                                render={({ field: { value, onChange, ...field } }) => (
                                    <FormItem>
                                        <FormLabel>
                                            {isVariablePrice ? `Cost Price per ${unitType || 'Unit'}` : `Cost Price${unitType ? ` (per ${unitType})` : ''}`}
                                        </FormLabel>
                                        <FormControl>
                                            <Input 
                                                type="number" 
                                                step="0.01" 
                                                placeholder="0.00" 
                                                disabled={!hasSelectedUnit}
                                                value={value || ''} 
                                                onChange={(e) => onChange(e.target.value ? parseFloat(e.target.value) : 0)}
                                                {...field} 
                                            />
                                        </FormControl>
                                        {!hasSelectedUnit && (
                                            <FormDescription>Select a unit first to add cost price.</FormDescription>
                                        )}
                                    </FormItem>
                                )}
                            />
                            {!isRestaurantOrBar && itemType === 'sellable' && (
                                <FormField
                                    control={control}
                                    name="price"
                                    rules={{ required: "Price is required", min: { value: 0, message: "Price must be positive" } }}
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>
                                                {isVariablePrice ? `Selling Price per ${unitType || 'Unit'}` : `Selling Price${unitType ? ` (per ${unitType})` : ''}`}
                                            </FormLabel>
                                            <FormControl>
                                                <Input type="number" step="0.01" placeholder="0.00" disabled={!hasSelectedUnit} {...field} />
                                            </FormControl>
                                            {!hasSelectedUnit && (
                                                <FormDescription>Select a unit first to add selling price.</FormDescription>
                                            )}
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            )}
                        </div>
                        <FormField
                            control={control}
                            name="supplier"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Supplier</FormLabel>
                                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select a supplier" />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            {suppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                </FormItem>
                            )}
                        />
                    </div>
                )}
                
                {itemType === 'sellable' && isRestaurantOrBar && (
                    <div className="space-y-4">
                        <FormField
                            control={control}
                            name="unitType"
                            rules={{ required: 'Unit is required before pricing.' }}
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Unit</FormLabel>
                                    <FormControl>
                                        <Input
                                            list={unitOptionsListId}
                                            placeholder="Type or select a unit"
                                            value={field.value || ''}
                                            onChange={(event) => field.onChange(event.target.value)}
                                        />
                                    </FormControl>
                                    <datalist id={unitOptionsListId}>
                                        {unitTypes.map((unit) => (
                                            <option key={unit} value={unit} />
                                        ))}
                                    </datalist>
                                    <FormDescription>
                                        Type to search units, then enter prices.
                                    </FormDescription>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {!isProduced ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <FormField
                                    control={control}
                                    name="cost"
                                    render={({ field: { value, onChange, ...field } }) => (
                                        <FormItem>
                                            <FormLabel>Cost Price</FormLabel>
                                            <FormControl>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder="0.00"
                                                    disabled={!hasSelectedUnit}
                                                    value={value || ''}
                                                    onChange={(e) => onChange(e.target.value ? parseFloat(e.target.value) : 0)}
                                                    {...field}
                                                />
                                            </FormControl>
                                            {!hasSelectedUnit && (
                                                <FormDescription>Select a unit first to add cost price.</FormDescription>
                                            )}
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={control}
                                    name="price"
                                    rules={{ required: "Price is required", min: { value: 0, message: "Price must be positive" } }}
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>
                                                {isVariablePrice ? `Selling Price per ${unitType || 'Unit'}` : `Selling Price${unitType ? ` (per ${unitType})` : ''}`}
                                            </FormLabel>
                                            <FormControl>
                                                <Input type="number" step="0.01" placeholder="0.00" disabled={!hasSelectedUnit} {...field} />
                                            </FormControl>
                                            {!hasSelectedUnit && (
                                                <FormDescription>Select a unit first to add selling price.</FormDescription>
                                            )}
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            </div>
                        ) : (
                            <FormField
                                control={control}
                                name="price"
                                rules={{ required: "Price is required", min: { value: 0, message: "Price must be positive" } }}
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            {isVariablePrice ? `Selling Price per ${unitType || 'Unit'}` : `Selling Price${unitType ? ` (per ${unitType})` : ''}`}
                                        </FormLabel>
                                        <FormControl>
                                            <Input type="number" step="0.01" placeholder="0.00" disabled={!hasSelectedUnit} {...field} />
                                        </FormControl>
                                        {!hasSelectedUnit && (
                                            <FormDescription>Select a unit first to add selling price.</FormDescription>
                                        )}
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        )}

                        <Separator />

                        {isRestaurantOrBar && isProduced && (
                            <>
                            <div>
                                <h3 className="text-lg font-medium flex items-center gap-2"><BookOpen className="h-5 w-5"/> Recipe / Bill of Materials</h3>
                                <p className="text-sm text-muted-foreground mb-4">
                                    Select ingredients or purchased sellable drinks used to make one unit of this product.
                                </p>
                                <div className="space-y-4">
                                    {fields.map((field, index) => (
                                        <div key={field.id} className="grid grid-cols-[1fr_auto_auto] items-end gap-2 p-3 border rounded-lg sm:grid-cols-[1fr_auto_auto_auto]">
                                            <FormField
                                                control={control}
                                                name={`recipe.${index}.ingredientId`}
                                                rules={{ required: true }}
                                                render={({ field: selectField }) => (
                                                    <FormItem>
                                                        <FormLabel className="text-xs">Component</FormLabel>
                                                        <Select 
                                                            onValueChange={(value) => {
                                                                const selectedIngredient = ingredients.find(i => i.id === value);
                                                                if (selectedIngredient) {
                                                                    const currentQuantity = Number(watch(`recipe.${index}.quantity`));
                                                                    selectField.onChange(value);
                                                                    setValue(`recipe.${index}.name`, selectedIngredient.name);
                                                                    setValue(`recipe.${index}.unit`, selectedIngredient.unitType || '');
                                                                    if (isPortionedSellable(selectedIngredient)) {
                                                                        setValue(
                                                                            `recipe.${index}.quantity`,
                                                                            Number(formatPortionStockQuantity(selectedIngredient))
                                                                        );
                                                                    } else if (!Number.isFinite(currentQuantity) || currentQuantity <= 0) {
                                                                        setValue(`recipe.${index}.quantity`, 1);
                                                                    }
                                                                }
                                                            }} 
                                                            defaultValue={selectField.value}
                                                        >
                                                            <FormControl>
                                                                <SelectTrigger>
                                                                    <SelectValue placeholder="Select component" />
                                                                </SelectTrigger>
                                                            </FormControl>
                                                            <SelectContent>
                                                                {ingredients.map((ing) => {
                                                                    const portioned = isPortionedSellable(ing);
                                                                    return (
                                                                        <SelectItem key={ing.id} value={ing.id}>
                                                                            <div className="flex flex-col">
                                                                                <span>{ing.name}</span>
                                                                                <span className="text-xs text-muted-foreground">
                                                                                    {ing.itemType === 'sellable' ? 'Purchased sellable' : 'Ingredient'}
                                                                                    {portioned
                                                                                        ? ` - 1 ${ing.portionName || 'portion'} = ${formatPortionStockQuantity(ing)} ${ing.unitType || 'unit'}`
                                                                                        : ''}
                                                                                </span>
                                                                            </div>
                                                                        </SelectItem>
                                                                    );
                                                                })}
                                                            </SelectContent>
                                                        </Select>
                                                        {(() => {
                                                            const selectedComponent = ingredients.find(
                                                                (component) => component.id === watch(`recipe.${index}.ingredientId`)
                                                            );
                                                            if (!selectedComponent || !isPortionedSellable(selectedComponent)) {
                                                                return null;
                                                            }
                                                            return (
                                                                <FormDescription className="max-w-xs text-xs">
                                                                    Quantity is saved in stock units. 1 {selectedComponent.portionName || 'portion'} deducts {formatPortionStockQuantity(selectedComponent)} {selectedComponent.unitType || 'unit'}.
                                                                </FormDescription>
                                                            );
                                                        })()}
                                                    </FormItem>
                                                )}
                                            />
                                            <FormField
                                                control={control}
                                                name={`recipe.${index}.quantity`}
                                                rules={{ required: true, min: 0.001 }}
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <FormLabel className="text-xs">Qty</FormLabel>
                                                        <FormControl>
                                                            <Input type="number" step="0.001" className="w-20 sm:w-24" {...field} />
                                                        </FormControl>
                                                    </FormItem>
                                                )}
                                            />
                                            <FormField
                                                control={control}
                                                name={`recipe.${index}.unit`}
                                                render={({ field }) => (
                                                    <FormItem className="hidden sm:block">
                                                        <FormLabel className="text-xs">Unit</FormLabel>
                                                        <FormControl>
                                                            <Input className="w-20 bg-muted" readOnly {...field} />
                                                        </FormControl>
                                                    </FormItem>
                                                )}
                                            />
                                            <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} className="text-destructive">
                                                <X className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => append({ ingredientId: '', name: '', quantity: 1, unit: '' })}
                                    >
                                    <Plus className="mr-2 h-4 w-4" /> Add Component
                                    </Button>
                                </div>
                            </div>
                            </>
                        )}

                        {isRestaurantOrBar && !isProduced && (
                            <>
                            <div className="space-y-4">
                                <FormField
                                    control={control}
                                    name="supplier"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Supplier</FormLabel>
                                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                <FormControl>
                                                    <SelectTrigger>
                                                        <SelectValue placeholder="Select a supplier" />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent>
                                                    {suppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                                                </SelectContent>
                                            </Select>
                                        </FormItem>
                                    )}
                                />
                                
                                {canConfigurePortions && (
                                    <>
                                    <Separator />
                                    <FormField
                                        control={form.control}
                                        name="isSoldInPortions"
                                        render={({ field }) => (
                                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                                            <div className="space-y-0.5">
                                            <FormLabel>Sold in Portions</FormLabel>
                                            <FormDescription>
                                                {portionDescription}
                                            </FormDescription>
                                            </div>
                                            <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={field.onChange}
                                            />
                                            </FormControl>
                                        </FormItem>
                                        )}
                                    />
                                    
                                    {isSoldInPortions && (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                                            <FormField
                                                control={control}
                                                name="portionName"
                                                rules={{ required: "Portion name is required" }}
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <FormLabel>Portion Name</FormLabel>
                                                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                            <FormControl>
                                                                <SelectTrigger>
                                                                    <SelectValue placeholder="Select portion type" />
                                                                </SelectTrigger>
                                                            </FormControl>
                                                            <SelectContent>
                                                                <SelectItem value="shot">Shot</SelectItem>
                                                                <SelectItem value="tot">Tot</SelectItem>
                                                                <SelectItem value="glass">Glass</SelectItem>
                                                                <SelectItem value="pint">Pint</SelectItem>
                                                                <SelectItem value="bottle">Bottle</SelectItem>
                                                                <SelectItem value="can">Can</SelectItem>
                                                                <SelectItem value="cup">Cup</SelectItem>
                                                                <SelectItem value="slice">Slice</SelectItem>
                                                                <SelectItem value="serving">Serving</SelectItem>
                                                                <SelectItem value="scoop">Scoop</SelectItem>
                                                                <SelectItem value="measure">Measure</SelectItem>
                                                                <SelectItem value="custom">Custom</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
                                            
                                            {portionName === 'custom' && (
                                                <FormField
                                                    control={control}
                                                    name="portionName"
                                                    render={({ field }) => (
                                                        <FormItem>
                                                            <FormLabel>Custom Portion Name</FormLabel>
                                                            <FormControl>
                                                                <Input placeholder="e.g., Jigger, Half plate, Small cup" {...field} />
                                                            </FormControl>
                                                            <FormMessage />
                                                        </FormItem>
                                                    )}
                                                />
                                            )}
                                            
                                            <FormField
                                                control={control}
                                                name="portionsPerUnit"
                                                rules={{ required: "Number of portions is required", min: { value: 1, message: "Must be at least 1" } }}
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <FormLabel>Portions per Full Unit</FormLabel>
                                                        <FormControl>
                                                            <Input type="number" min="1" placeholder="e.g., 25 shots per bottle or 8 slices per cake" {...field} />
                                                        </FormControl>
                                                        <FormDescription>
                                                            How many sellable portions make up one purchased unit of this product.
                                                        </FormDescription>
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
                                            <FormField
                                                control={control}
                                                name="portionPrice"
                                                render={({ field }) => (
                                                    <FormItem className="sm:col-span-2">
                                                        <FormLabel>Portion Selling Price</FormLabel>
                                                        <RadioGroup
                                                            value={portionPricingMode}
                                                            onValueChange={(value) => setPortionPricingMode(value as 'auto' | 'custom')}
                                                            className="grid gap-3 sm:grid-cols-2"
                                                        >
                                                            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
                                                                <RadioGroupItem value="auto" className="mt-1" />
                                                                <span>
                                                                    <span className="block text-sm font-medium">Use calculated price</span>
                                                                    <span className="block text-xs text-muted-foreground">
                                                                        {computedPortionPrice
                                                                            ? `${computedPortionPrice.toFixed(2)} per ${portionName || 'portion'} from full price / portions.`
                                                                            : 'Enter full unit price and portions first.'}
                                                                    </span>
                                                                </span>
                                                            </label>
                                                            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
                                                                <RadioGroupItem value="custom" className="mt-1" />
                                                                <span>
                                                                    <span className="block text-sm font-medium">Enter my own price</span>
                                                                    <span className="block text-xs text-muted-foreground">
                                                                        Use this when each portion sells at a different margin.
                                                                    </span>
                                                                </span>
                                                            </label>
                                                        </RadioGroup>
                                                        {portionPricingMode === 'custom' && (
                                                            <FormControl>
                                                                <Input
                                                                    type="number"
                                                                    min="0"
                                                                    step="0.01"
                                                                    placeholder="Selling price per portion"
                                                                    {...field}
                                                                />
                                                            </FormControl>
                                                        )}
                                                        <FormDescription>
                                                            {displayedPortionPrice
                                                                ? `The POS will sell each ${portionName || 'portion'} at ${displayedPortionPrice.toFixed(2)}.`
                                                                : 'Set the full unit price and portions per unit to calculate the portion price.'}
                                                        </FormDescription>
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
                                        </div>
                                    )}
                                    </>
                                )}
                            </div>
                            </>
                        )}
                    </div>
                )}
                
                <DialogFooter className="sticky bottom-0 bg-background pt-4 border-t">
                    <Button type="submit">{defaultValues?.id ? 'Save Changes' : 'Add Item'}</Button>
                </DialogFooter>
            </form>
            <CameraBarcodeScannerModal
                isOpen={isBarcodeScannerOpen}
                onOpenChange={setIsBarcodeScannerOpen}
                onBarcodeDetected={handleProductBarcodeDetected}
                closeOnSuccessfulDetection
            />
            </>
        </FormProvider>
    );
};
