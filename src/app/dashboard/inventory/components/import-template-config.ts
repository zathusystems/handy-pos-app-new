'use client';

import { type BusinessType } from '@/lib/inventory/config';

export const getInventoryTemplateColumnsForBusinessType = (businessType: BusinessType): string[] => {
  const isRestaurantOrBar = businessType === 'Restaurant' || businessType === 'Bar & Liquor';
  const isClothingOrHardware = businessType === 'Clothing & Fashion' || businessType === 'Hardware';

  if (!isRestaurantOrBar) {
    const retailColumns = [
      'name',
      'category',
      'productCode',
      'barcode',
      'sku',
      'brand',
      'currentStock',
      'price',
      'cost',
      'taxRate',
      'taxCalculationMethod',
      'mraProductCode',
      'mraProductName',
      'mraTaxType',
      'mraTaxRate',
      'mraUnitMeasure',
      'unitType',
      'reorderLevel',
      'supplier',
    ];

    if (isClothingOrHardware) {
      retailColumns.splice(7, 0, 'isVariablePrice');
    }

    return retailColumns;
  }

  const columns = [
    'name',
    'category',
    'barcode',
    'isProduced',
    'currentStock',
    'price',
    'cost',
    'taxRate',
    'taxCalculationMethod',
    'mraProductCode',
    'mraProductName',
    'mraTaxType',
    'mraTaxRate',
    'mraUnitMeasure',
    'unitType',
    'reorderLevel',
    'supplier',
  ];

  if (businessType === 'Bar & Liquor') {
    columns.push('isSoldInPortions', 'portionName', 'portionsPerUnit', 'portionPrice');
  }

  columns.push('recipe');
  return columns;
};
