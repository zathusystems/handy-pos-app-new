'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Loader2, Upload, X, FileText, Download, GitBranch, CheckSquare, Square } from 'lucide-react';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';

import { db, type InventoryItem, type MRAMapping, type PurchaseRecord, type PurchaseOrder, type Supplier } from '@/lib/db';
import { type BusinessType, unitTypesByBusinessType } from '@/lib/inventory/config';
import { syncService } from '@/lib/services/sync-service';
import { createSupplier } from '@/lib/services/supplier-service';
import { isTauriApp } from '@/lib/tauri-init';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { getInventoryTemplateColumnsForBusinessType } from './import-template-config';

type Branch = { id: string; name: string; address: string; };
type ImportMode = 'csv' | 'branch';

const normalizeProductName = (value?: string) => String(value || '').trim().toLowerCase();
const toBackendBranchId = (id: string): string => {
  const normalized = String(id || '').trim();
  if (!normalized) return normalized;

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) return brnMatch[1];

  const legacyBranchMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyBranchMatch) return legacyBranchMatch[1];

  if (/^\d+$/.test(normalized)) return normalized;
  return normalized;
};

const getBranchIdCandidates = (branchId: string): string[] => {
  const normalized = String(branchId || '').trim();
  if (!normalized) return [];

  const backendId = toBackendBranchId(normalized);
  const candidates = new Set<string>([normalized, backendId]);

  if (/^\d+$/.test(backendId)) {
    candidates.add(`BRN-${backendId}`);
    candidates.add(`branch-${backendId}`);
  }

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
};

const getInventoryItemsForBranch = async (targetBranchId: string): Promise<InventoryItem[]> => {
  const branchCandidates = getBranchIdCandidates(targetBranchId);
  if (branchCandidates.length === 0) {
    return [];
  }

  if (branchCandidates.length === 1) {
    return db.inventory.where('branchId').equals(branchCandidates[0]).toArray();
  }

  return db.inventory.where('branchId').anyOf(branchCandidates).toArray();
};

const DEFAULT_REORDER_LEVEL = 10;
const REORDER_LEVEL_OPTIONS = ['5', '10', '20', '50'];
const BOOLEAN_OPTIONS = ['true', 'false'];
const BAR_PORTION_NAME_OPTIONS = ['shot', 'tot', 'glass', 'pint', 'bottle', 'can', 'cup', 'measure', 'custom'];
const MRA_UNIT_MEASURE_OPTIONS = ['unit', 'kg', 'liter', 'meter', 'box', 'pack', 'bottle', 'can', 'carton'];

type ImportTemplateRow = Record<string, string | number | boolean>;
type TemplateFieldOption = { field: string; options: string[] };

type CsvRow = Record<string, unknown>;

type ImportInventoryRow = InventoryItem & {
  importTaxRate?: number;
  importTaxCalculationMethod?: 'inclusive' | 'exclusive';
  importMraProductCode?: string;
  importMraProductName?: string;
  importMraTaxType?: 'standard' | 'zero' | 'exempt';
  importMraTaxRate?: number;
  importMraUnitMeasure?: string;
};

type InitialStockEntry = {
  itemId: string;
  productName: string;
  quantity: number;
  costPerUnit: number;
  taxRate: number;
  taxMethod: 'inclusive' | 'exclusive';
  supplier?: Supplier;
};

const CSV_FIELD_ALIASES = {
  id: ['id', 'productid', 'itemid'],
  name: ['name', 'itemname', 'productname'],
  itemType: ['itemtype', 'type', 'producttype'],
  category: ['category', 'itemcategory'],
  stockUnits: ['stockunits', 'stock', 'quantity', 'qty', 'onhand', 'currentstock', 'current_stock', 'openingstock', 'opening_stock', 'initialstock', 'initial_stock'],
  unitType: ['unittype', 'unit', 'uom', 'measureunit'],
  reorderLevel: ['reorderlevel', 'reorder', 'minimumstock', 'minstock'],
  cost: ['cost', 'purchasecost', 'buyingprice', 'costperunit'],
  price: ['price', 'sellingprice', 'saleprice'],
  taxRate: ['taxrate', 'vat', 'vatrate', 'tax', 'taxpercent', 'vatpercent'],
  taxCalculationMethod: ['taxmethod', 'taxcalculationmethod', 'vatmethod', 'vatcalculationmethod', 'taxcalc'],
  value: ['value', 'stockvalue'],
  status: ['status', 'stockstatus'],
  supplier: ['supplier', 'suppliername'],
  manufacturer: ['manufacturer', 'maker'],
  brand: ['brand'],
  batch: ['batch', 'batchnumber'],
  packSize: ['packsize'],
  productCode: ['productcode', 'code', 'itemcode'],
  barcode: ['barcode', 'barcodevalue'],
  sku: ['sku'],
  expiry: ['expiry', 'expirydate', 'expdate'],
  mraProductCode: ['mraproductcode', 'mracode', 'mra_code', 'mraitemcode'],
  mraProductName: ['mraproductname', 'mraname', 'mra_product_name', 'mraitemname'],
  mraTaxType: ['mrataxtype', 'mra_tax_type', 'mravattype', 'mra_tax_category'],
  mraTaxRate: ['mrataxrate', 'mra_tax_rate', 'mravatrate'],
  mraUnitMeasure: ['mraunitmeasure', 'mra_unit_measure', 'mraunit', 'mrauom'],
  isVariablePrice: ['isvariableprice', 'variableprice'],
  isFuel: ['isfuel', 'fuel', 'fuelitem', 'isfuelitem'],
  isProduced: ['isproduced', 'produced'],
  onMenu: ['onmenu', 'menu'],
  isSoldInPortions: ['issoldinportions', 'soldinportions'],
  portionName: ['portionname'],
  portionsPerUnit: ['portionsperunit'],
  portionPrice: ['portionprice', 'priceperportion', 'portionunitprice'],
  recipe: ['recipe', 'bom', 'billofmaterials'],
} as const;

const normalizeCsvHeader = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const parseCsvBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseCsvNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value ?? '').trim().replace(/,/g, '');
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCsvOptionalNumber = (value: unknown): number | undefined => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return undefined;
  const parsed = parseCsvNumber(normalized, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const formatPreviewNumber = (value?: number): string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '—';
  }
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const normalizeItemType = (value: unknown): 'ingredient' | 'sellable' => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'sellable';
  if (
    normalized === 'ingredient' ||
    normalized === 'ingredients' ||
    normalized === 'raw' ||
    normalized === 'rawmaterial' ||
    normalized === 'rawmaterials'
  ) {
    return 'ingredient';
  }
  return 'sellable';
};

const normalizeExpiryDate = (value: unknown): string | undefined => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const parsedDate = new Date(normalized);
  if (Number.isNaN(parsedDate.getTime())) {
    return undefined;
  }

  return parsedDate.toISOString().slice(0, 10);
};

const parseRecipe = (value: unknown): InventoryItem['recipe'] => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value as InventoryItem['recipe'];
  }

  if (typeof value !== 'string') {
    return [];
  }

  const normalized = value.trim();
  if (!normalized) return [];

  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? (parsed as InventoryItem['recipe']) : [];
  } catch {
    return [];
  }
};

const normalizeLookupValue = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const computeStatus = (
  stockUnits: number,
  reorderLevel: number,
  isRecipeManaged = false
): InventoryItem['status'] => {
  if (isRecipeManaged) return 'In Stock';
  if (stockUnits <= 0) return 'Out of Stock';
  if (stockUnits <= reorderLevel) return 'Low Stock';
  return 'In Stock';
};

const normalizeTaxRate = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizeMraTaxType = (
  value: unknown,
  fallbackRate?: number
): 'standard' | 'zero' | 'exempt' => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'zero' || normalized === 'vat_zero' || normalized === 'zero-rated' || normalized === 'zero_rated') {
    return 'zero';
  }
  if (normalized === 'exempt' || normalized === 'vat_exempt') {
    return 'exempt';
  }
  if (normalized === 'standard' || normalized === 'vat_standard') {
    return 'standard';
  }

  return normalizeTaxRate(fallbackRate) === 0 ? 'zero' : 'standard';
};

const resolveMraTaxRate = (
  taxType: 'standard' | 'zero' | 'exempt',
  explicitRate?: number,
  fallbackRate?: number
): number => {
  if (explicitRate !== undefined) {
    return normalizeTaxRate(explicitRate);
  }

  if (taxType === 'zero' || taxType === 'exempt') {
    return 0;
  }

  return normalizeTaxRate(fallbackRate);
};

const resolveTaxMethod = (value: unknown): 'inclusive' | 'exclusive' => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.startsWith('inc')) return 'inclusive';
  if (normalized.startsWith('excl')) return 'exclusive';
  return 'exclusive';
};

const calculateItemVat = (
  costPerUnit: number,
  quantity: number,
  taxRate: number,
  method: 'inclusive' | 'exclusive'
): number => {
  const rate = normalizeTaxRate(taxRate);
  const base = Number(costPerUnit || 0) * Number(quantity || 0);
  if (!Number.isFinite(base) || base <= 0 || rate <= 0) return 0;
  if (method === 'inclusive') {
    return base - base / (1 + rate / 100);
  }
  return base * (rate / 100);
};

const calculateItemGross = (
  costPerUnit: number,
  quantity: number,
  vatAmount: number,
  method: 'inclusive' | 'exclusive'
): number => {
  const base = Number(costPerUnit || 0) * Number(quantity || 0);
  if (!Number.isFinite(base)) return 0;
  return method === 'exclusive' ? base + (vatAmount || 0) : base;
};

const getCsvValue = (
  row: CsvRow,
  aliases: readonly string[]
): unknown => {
  const normalizedEntries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    normalizedEntries.set(normalizeCsvHeader(key), value);
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeCsvHeader(alias);
    if (!normalizedEntries.has(normalizedAlias)) continue;
    const value = normalizedEntries.get(normalizedAlias);
    if (value === undefined || value === null) continue;
    return value;
  }

  return undefined;
};

const parseInventoryCsvRow = (
  row: CsvRow,
  targetBranchId: string,
  businessType: BusinessType
): ImportInventoryRow | null => {
  const name = String(getCsvValue(row, CSV_FIELD_ALIASES.name) ?? '').trim();
  if (!name) {
    return null;
  }

  const rawItemType = getCsvValue(row, CSV_FIELD_ALIASES.itemType);
  const hasExplicitItemType = String(rawItemType ?? '').trim().length > 0;
  const isRestaurantOrBar = businessType === 'Restaurant' || businessType === 'Bar & Liquor';
  const parsedPrice = parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.price));
  const parsedCost = parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.cost));
  const parsedTaxRate = parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.taxRate));
  const parsedTaxMethodRaw = getCsvValue(row, CSV_FIELD_ALIASES.taxCalculationMethod);
  const parsedMraTaxRate = parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.mraTaxRate));
  const parsedMraProductCode = String(getCsvValue(row, CSV_FIELD_ALIASES.mraProductCode) ?? '').trim();
  const parsedMraProductName = String(getCsvValue(row, CSV_FIELD_ALIASES.mraProductName) ?? '').trim();
  const parsedMraUnitMeasure = String(getCsvValue(row, CSV_FIELD_ALIASES.mraUnitMeasure) ?? '').trim();
  const parsedRecipe = parseRecipe(getCsvValue(row, CSV_FIELD_ALIASES.recipe));
  const isProduced = parseCsvBoolean(getCsvValue(row, CSV_FIELD_ALIASES.isProduced), false);
  const itemType = hasExplicitItemType
    ? normalizeItemType(rawItemType)
    : isRestaurantOrBar
      ? isProduced || parsedPrice !== undefined || parsedRecipe.length > 0
        ? 'sellable'
        : parsedCost !== undefined
          ? 'ingredient'
          : 'sellable'
      : 'sellable';
  const stockUnits = parseCsvNumber(getCsvValue(row, CSV_FIELD_ALIASES.stockUnits), 0);
  const reorderLevel = parseCsvNumber(getCsvValue(row, CSV_FIELD_ALIASES.reorderLevel), DEFAULT_REORDER_LEVEL);
  const cost = parsedCost;
  const parsedValue = parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.value));
  const computedValue = Number((stockUnits * (cost || 0)).toFixed(2));
  const value = parsedValue ?? computedValue;
  const statusValue = String(getCsvValue(row, CSV_FIELD_ALIASES.status) ?? '').trim() as InventoryItem['status'];
  const isRecipeManaged = itemType === 'sellable' && isProduced;
  const status =
    isRecipeManaged
      ? 'In Stock'
      : statusValue === 'In Stock' || statusValue === 'Low Stock' || statusValue === 'Out of Stock'
      ? statusValue
      : computeStatus(stockUnits, reorderLevel, isRecipeManaged);
  const rawId = String(getCsvValue(row, CSV_FIELD_ALIASES.id) ?? '').trim();

  return {
    id: rawId || uuidv4(),
    name,
    category: String(getCsvValue(row, CSV_FIELD_ALIASES.category) ?? '').trim() || 'Uncategorized',
    itemType,
    branchId: targetBranchId,
    stockUnits,
    unitType: String(getCsvValue(row, CSV_FIELD_ALIASES.unitType) ?? '').trim() || 'unit',
    reorderLevel,
    cost,
    price: parsedPrice,
    value,
    status,
    supplier: String(getCsvValue(row, CSV_FIELD_ALIASES.supplier) ?? '').trim() || undefined,
    manufacturer: String(getCsvValue(row, CSV_FIELD_ALIASES.manufacturer) ?? '').trim() || undefined,
    brand: String(getCsvValue(row, CSV_FIELD_ALIASES.brand) ?? '').trim() || undefined,
    batch: String(getCsvValue(row, CSV_FIELD_ALIASES.batch) ?? '').trim() || undefined,
    packSize: parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.packSize)),
    productCode: String(getCsvValue(row, CSV_FIELD_ALIASES.productCode) ?? '').trim() || undefined,
    barcode: String(getCsvValue(row, CSV_FIELD_ALIASES.barcode) ?? '').trim() || undefined,
    sku: String(getCsvValue(row, CSV_FIELD_ALIASES.sku) ?? '').trim() || undefined,
    expiry: normalizeExpiryDate(getCsvValue(row, CSV_FIELD_ALIASES.expiry)),
    recipe: parsedRecipe,
    isVariablePrice: parseCsvBoolean(getCsvValue(row, CSV_FIELD_ALIASES.isVariablePrice), false),
    isFuel: parseCsvBoolean(getCsvValue(row, CSV_FIELD_ALIASES.isFuel), false),
    isProduced,
    onMenu: parseCsvBoolean(getCsvValue(row, CSV_FIELD_ALIASES.onMenu), false),
    isSoldInPortions: parseCsvBoolean(getCsvValue(row, CSV_FIELD_ALIASES.isSoldInPortions), false),
    portionName: String(getCsvValue(row, CSV_FIELD_ALIASES.portionName) ?? '').trim() || undefined,
    portionsPerUnit: parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.portionsPerUnit)),
    portionPrice: parseCsvOptionalNumber(getCsvValue(row, CSV_FIELD_ALIASES.portionPrice)),
    importTaxRate: parsedTaxRate !== undefined ? Number(parsedTaxRate) : undefined,
    importTaxCalculationMethod:
      parsedTaxMethodRaw !== undefined && String(parsedTaxMethodRaw ?? '').trim() !== ''
        ? resolveTaxMethod(parsedTaxMethodRaw)
        : undefined,
    importMraProductCode: parsedMraProductCode || undefined,
    importMraProductName: parsedMraProductName || undefined,
    importMraTaxType: normalizeMraTaxType(
      getCsvValue(row, CSV_FIELD_ALIASES.mraTaxType),
      parsedMraTaxRate ?? parsedTaxRate ?? 0
    ),
    importMraTaxRate: parsedMraTaxRate !== undefined ? Number(parsedMraTaxRate) : undefined,
    importMraUnitMeasure: parsedMraUnitMeasure || undefined,
  };
};

const getTemplateFieldOptionsForBusinessType = (
  businessType: BusinessType,
  columns: string[]
): TemplateFieldOption[] => {
  const optionEntries: TemplateFieldOption[] = [];

  const registerOptions = (field: string, options: string[]) => {
    if (!columns.includes(field) || options.length === 0) return;
    optionEntries.push({ field, options });
  };

  registerOptions('unitType', unitTypesByBusinessType[businessType] || []);
  registerOptions('reorderLevel', REORDER_LEVEL_OPTIONS);
  registerOptions('isProduced', BOOLEAN_OPTIONS);
  registerOptions('taxCalculationMethod', ['inclusive', 'exclusive']);
  registerOptions('mraTaxType', ['standard', 'zero', 'exempt']);
  registerOptions('mraUnitMeasure', MRA_UNIT_MEASURE_OPTIONS);
  registerOptions('isSoldInPortions', BOOLEAN_OPTIONS);
  registerOptions('portionName', BAR_PORTION_NAME_OPTIONS);

  return optionEntries;
};

const getTemplateRowsForBusinessType = (businessType: BusinessType): ImportTemplateRow[] => {
  const isRestaurantOrBar = businessType === 'Restaurant' || businessType === 'Bar & Liquor';

  if (!isRestaurantOrBar) {
    if (businessType === 'Clothing & Fashion') {
      return [
        {
          name: 'Black Polo Shirt - Medium',
          category: 'Men Clothing',
          productCode: 'POLO-BLK-M',
          barcode: '6001000000012',
          sku: 'STYLE-100-BLK-M',
          brand: 'Urban Wear',
          currentStock: 24,
          price: 15000,
          cost: 8500,
          isVariablePrice: false,
          taxRate: 16.5,
          taxCalculationMethod: 'inclusive',
          mraProductCode: 'POLO-BLK-M',
          mraProductName: 'Black Polo Shirt - Medium',
          mraTaxType: 'standard',
          mraTaxRate: 16.5,
          mraUnitMeasure: 'unit',
          unitType: 'unit',
          reorderLevel: DEFAULT_REORDER_LEVEL,
          supplier: 'Fashion Wholesale',
        },
        {
          name: 'Chitenje Fabric',
          category: 'Fabrics',
          productCode: 'FAB-CHITENJE',
          barcode: '',
          sku: 'FAB-CHITENJE-ROLL',
          brand: 'Local Textile',
          currentStock: 60,
          price: 2500,
          cost: 1500,
          isVariablePrice: true,
          taxRate: 16.5,
          taxCalculationMethod: 'inclusive',
          mraProductCode: 'FAB-CHITENJE',
          mraProductName: 'Chitenje Fabric',
          mraTaxType: 'standard',
          mraTaxRate: 16.5,
          mraUnitMeasure: 'meter',
          unitType: 'meter',
          reorderLevel: 20,
          supplier: 'Textile Supplier',
        },
      ];
    }

    if (businessType === 'Hardware') {
      return [
        {
          name: '20mm PVC Pipe',
          category: 'Plumbing',
          productCode: 'PVC-20MM',
          barcode: '6002000000019',
          sku: 'PLUMB-PVC-20MM',
          brand: 'BuildPro',
          currentStock: 40,
          price: 4500,
          cost: 2800,
          isVariablePrice: false,
          taxRate: 16.5,
          taxCalculationMethod: 'inclusive',
          mraProductCode: 'PVC-20MM',
          mraProductName: '20mm PVC Pipe',
          mraTaxType: 'standard',
          mraTaxRate: 16.5,
          mraUnitMeasure: 'unit',
          unitType: 'unit',
          reorderLevel: DEFAULT_REORDER_LEVEL,
          supplier: 'Hardware Wholesale',
        },
        {
          name: 'Electrical Cable 2.5mm',
          category: 'Electrical',
          productCode: 'CABLE-2.5MM',
          barcode: '',
          sku: 'ELEC-CABLE-2.5MM',
          brand: 'PowerLine',
          currentStock: 120,
          price: 1200,
          cost: 700,
          isVariablePrice: true,
          taxRate: 16.5,
          taxCalculationMethod: 'inclusive',
          mraProductCode: 'CABLE-2.5MM',
          mraProductName: 'Electrical Cable 2.5mm',
          mraTaxType: 'standard',
          mraTaxRate: 16.5,
          mraUnitMeasure: 'meter',
          unitType: 'meter',
          reorderLevel: 20,
          supplier: 'Electrical Supplies Ltd',
        },
      ];
    }

    return [
      {
        name: 'Milk 300ml',
        category: 'Dairy & Eggs',
        productCode: 'MILK-300ML',
        barcode: '1234567890123',
        sku: 'MILK-300ML',
        brand: 'Local Dairy',
        currentStock: 50,
        price: 700,
        cost: 450,
        taxRate: 16.5,
        taxCalculationMethod: 'inclusive',
        mraProductCode: 'MILK-300ML',
        mraProductName: 'Milk 300ml',
        mraTaxType: 'standard',
        mraTaxRate: 16.5,
        mraUnitMeasure: 'bottle',
        unitType: 'bottle',
        reorderLevel: DEFAULT_REORDER_LEVEL,
        supplier: 'Local Dairy Ltd',
      },
    ];
  }

  const ingredientRow: ImportTemplateRow = {
    name: 'Flour',
    barcode: '',
    category: 'Grains & Flour',
    isProduced: false,
    currentStock: 25,
    price: '',
    cost: 2500,
    taxRate: 0,
    taxCalculationMethod: 'inclusive',
    mraProductCode: 'FLOUR-1KG',
    mraProductName: 'Flour',
    mraTaxType: 'zero',
    mraTaxRate: 0,
    mraUnitMeasure: 'kg',
    unitType: 'kg',
    reorderLevel: 20,
    supplier: 'Wholesale Foods',
    recipe: '',
    isSoldInPortions: false,
    portionName: '',
    portionsPerUnit: '',
    portionPrice: '',
  };

  const producedRow: ImportTemplateRow = {
    name: businessType === 'Bar & Liquor' ? 'Signature Mojito' : 'House Pizza',
    barcode: '',
    category: businessType === 'Bar & Liquor' ? 'Cocktails' : 'Main Courses',
    isProduced: true,
    currentStock: 10,
    price: businessType === 'Bar & Liquor' ? 4500 : 8000,
    cost: '',
    taxRate: 16.5,
    taxCalculationMethod: 'inclusive',
    mraProductCode: businessType === 'Bar & Liquor' ? 'MOJITO-001' : 'PIZZA-HOUSE',
    mraProductName: businessType === 'Bar & Liquor' ? 'Signature Mojito' : 'House Pizza',
    mraTaxType: 'standard',
    mraTaxRate: 16.5,
    mraUnitMeasure: businessType === 'Bar & Liquor' ? 'glass' : 'unit',
    unitType: '',
    reorderLevel: '',
    supplier: '',
    recipe:
      businessType === 'Bar & Liquor'
        ? '[{"ingredientId":"ING-RUM","name":"Rum","quantity":0.05,"unit":"L"}]'
        : '[{"ingredientId":"ING-FLOUR","name":"Flour","quantity":0.5,"unit":"kg"}]',
    isSoldInPortions: false,
    portionName: '',
    portionsPerUnit: '',
    portionPrice: '',
  };

  const purchasedSellableRow: ImportTemplateRow = {
    name: businessType === 'Bar & Liquor' ? 'Whisky (Bottle)' : 'Bottled Water',
    barcode: '',
    isProduced: false,
    category: businessType === 'Bar & Liquor' ? 'Spirits' : 'Beverages',
    currentStock: 40,
    price: businessType === 'Bar & Liquor' ? 2500 : 1000,
    cost: businessType === 'Bar & Liquor' ? 18000 : 600,
    taxRate: 16.5,
    taxCalculationMethod: 'inclusive',
    mraProductCode: businessType === 'Bar & Liquor' ? 'WHISKY-BTL' : 'WATER-BTL',
    mraProductName: businessType === 'Bar & Liquor' ? 'Whisky (Bottle)' : 'Bottled Water',
    mraTaxType: 'standard',
    mraTaxRate: 16.5,
    mraUnitMeasure: businessType === 'Bar & Liquor' ? 'bottle' : 'bottle',
    unitType: '',
    reorderLevel: '',
    supplier: businessType === 'Bar & Liquor' ? 'Premium Drinks Ltd' : 'Local Beverages',
    recipe: '',
    isSoldInPortions: businessType === 'Bar & Liquor',
    portionName: businessType === 'Bar & Liquor' ? 'shot' : '',
    portionsPerUnit: businessType === 'Bar & Liquor' ? 25 : '',
    portionPrice: businessType === 'Bar & Liquor' ? '' : '',
  };

  return [ingredientRow, purchasedSellableRow, producedRow];
};

const projectTemplateRows = (
  rows: ImportTemplateRow[],
  columns: string[]
): ImportTemplateRow[] =>
  rows.map((row) => {
    const projected: ImportTemplateRow = {};
    columns.forEach((column) => {
      projected[column] = row[column] ?? '';
    });
    return projected;
  });

const buildTemplateOptionHintRow = (
  columns: string[],
  fieldOptions: TemplateFieldOption[]
): ImportTemplateRow => {
  const hintRow: ImportTemplateRow = {};

  columns.forEach((column) => {
    hintRow[column] = '';
  });

  fieldOptions.forEach(({ field, options }) => {
    if (!columns.includes(field)) return;
    hintRow[field] = options.join(' | ');
  });

  return hintRow;
};

export const ImportModal = ({
  isOpen,
  onOpenChange,
  branchId,
  branches,
  businessType,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  branchId: string;
  branches: Branch[];
  businessType: BusinessType;
}) => {
  const [importMode, setImportMode] = useState<ImportMode>('csv');
  const [file, setFile] = useState<globalThis.File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStage, setImportStage] = useState('');
  const [parsedData, setParsedData] = useState<ImportInventoryRow[]>([]);
  const [parsedHeaders, setParsedHeaders] = useState<string[]>([]);
  const [sourceBranchId, setSourceBranchId] = useState('');
  const [sourceProducts, setSourceProducts] = useState<InventoryItem[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [isLoadingSourceProducts, setIsLoadingSourceProducts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();

  const sourceBranchOptions = useMemo(
    () => branches.filter((branch) => String(branch.id) !== String(branchId)),
    [branches, branchId]
  );

  const templateColumns = useMemo(
    () => getInventoryTemplateColumnsForBusinessType(businessType),
    [businessType]
  );
  const templateRows = useMemo(
    () => projectTemplateRows(getTemplateRowsForBusinessType(businessType), templateColumns),
    [businessType, templateColumns]
  );
  const templateOptionalColumns = useMemo(
    () => templateColumns.filter((column) => column !== 'name'),
    [templateColumns]
  );
  const templateFieldOptions = useMemo(
    () => getTemplateFieldOptionsForBusinessType(businessType, templateColumns),
    [businessType, templateColumns]
  );
  const templateRowsForDownload = useMemo(
    () =>
      templateFieldOptions.length > 0
        ? [buildTemplateOptionHintRow(templateColumns, templateFieldOptions), ...templateRows]
        : templateRows,
    [templateColumns, templateFieldOptions, templateRows]
  );

  useEffect(() => {
    if (isOpen) {
      setImportMode('csv');
      setFile(null);
      setParsedData([]);
      setParsedHeaders([]);
      setSourceBranchId('');
      setSourceProducts([]);
      setSelectedProductIds([]);
      setImportProgress(0);
      setImportStage('');
    }
  }, [isOpen]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const uploadedFile = event.target.files[0];
      setFile(uploadedFile);
      setParsedData([]);
      setParsedHeaders([]);
      setImportProgress(0);
      setImportStage('');
      parseFile(uploadedFile);
    }
  };

  const parseFile = (fileToParse: globalThis.File) => {
    setIsParsing(true);
    Papa.parse(fileToParse, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
      complete: (results) => {
        const headers = (results.meta.fields || []).map((header) => normalizeCsvHeader(header));
        setParsedHeaders(headers);
        const hasNameHeader = headers.some((header) =>
          CSV_FIELD_ALIASES.name.map((alias) => normalizeCsvHeader(alias)).includes(header)
        );

        if (!hasNameHeader) {
          toast({
            variant: 'destructive',
            title: 'Invalid CSV Format',
            description: 'File must contain at least a product name column (name/itemName/productName).',
          });
          setFile(null);
          setParsedData([]);
          setParsedHeaders([]);
        } else {
          const rows = Array.isArray(results.data) ? (results.data as CsvRow[]) : [];
          const inventoryItems = rows
            .map((row) => parseInventoryCsvRow(row, branchId, businessType))
            .filter((item): item is InventoryItem => item !== null);

          if (inventoryItems.length === 0) {
            toast({
              variant: 'destructive',
              title: 'No Valid Rows Found',
              description: 'No valid products were detected in the CSV file.',
            });
            setFile(null);
            setParsedData([]);
            setParsedHeaders([]);
          } else {
            setParsedData(inventoryItems);
          }
        }
        setIsParsing(false);
      },
      error: (error) => {
        toast({ variant: 'destructive', title: 'Error parsing file', description: error.message });
        setParsedData([]);
        setParsedHeaders([]);
        setIsParsing(false);
      },
    });
  };

  const loadSourceBranchProducts = async (selectedBranchId: string) => {
    setIsLoadingSourceProducts(true);
    try {
      if (typeof window !== 'undefined' && navigator.onLine) {
        try {
          await syncService.fetchAllInventoryFromBackend(selectedBranchId);
        } catch (error) {
          console.warn('Failed to refresh source branch products from backend:', error);
        }
      }

      const items = (await getInventoryItemsForBranch(selectedBranchId)).filter(
        (item) => item._operation !== 'delete'
      );

      const dedupedById: InventoryItem[] = [];
      const seenIds = new Set<string>();
      for (const item of items) {
        const normalizedId = String(item.id || '').trim();
        if (!normalizedId || seenIds.has(normalizedId)) {
          continue;
        }
        seenIds.add(normalizedId);
        dedupedById.push(item);
      }

      dedupedById.sort((a, b) => a.name.localeCompare(b.name));

      setSourceProducts(dedupedById);
      setSelectedProductIds(dedupedById.map((item) => item.id));
    } catch (error: any) {
      console.error('Failed to load source branch products:', error);
      toast({
        variant: 'destructive',
        title: 'Failed to Load Branch Products',
        description: error?.message || 'Could not load products from selected branch.',
      });
      setSourceProducts([]);
      setSelectedProductIds([]);
    } finally {
      setIsLoadingSourceProducts(false);
    }
  };

  useEffect(() => {
    if (!isOpen || importMode !== 'branch') {
      return;
    }

    if (!sourceBranchId) {
      setSourceProducts([]);
      setSelectedProductIds([]);
      return;
    }

    loadSourceBranchProducts(sourceBranchId);
  }, [isOpen, importMode, sourceBranchId]);

  const toggleProductSelection = (productId: string, checked: boolean) => {
    setSelectedProductIds((prev) => {
      if (checked) {
        if (prev.includes(productId)) return prev;
        return [...prev, productId];
      }
      return prev.filter((id) => id !== productId);
    });
  };

  const handleToggleAllSourceProducts = () => {
    if (selectedProductIds.length === sourceProducts.length) {
      setSelectedProductIds([]);
      return;
    }
    setSelectedProductIds(sourceProducts.map((product) => product.id));
  };

  const handleDownloadTemplate = async () => {
    const csv = Papa.unparse(templateRowsForDownload);
    const normalizedBusinessType = businessType
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const filename = `inventory-template-${normalizedBusinessType || 'default'}.csv`;

    const isAndroidUserAgent = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
    const hasAndroidTauriAttr =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-tauri-android') === 'true';
    const hasGlobalTauriInvoke =
      typeof window !== 'undefined' && typeof (window as any).__TAURI__?.invoke === 'function';
    const hasInternalTauriInvoke =
      typeof window !== 'undefined' && typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function';
    const isAndroidTauri =
      (isAndroidUserAgent || hasAndroidTauriAttr) &&
      (isTauriApp() || hasGlobalTauriInvoke || hasInternalTauriInvoke || hasAndroidTauriAttr);

    if (isAndroidTauri) {
      try {
        let invokeFn: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          if (typeof invoke === 'function') {
            invokeFn = invoke as (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          }
        } catch {
          // Ignore and try global fallbacks below.
        }

        if (!invokeFn && hasGlobalTauriInvoke) {
          invokeFn = (window as any).__TAURI__.invoke.bind((window as any).__TAURI__);
        }
        if (!invokeFn && hasInternalTauriInvoke) {
          invokeFn = (window as any).__TAURI_INTERNALS__.invoke.bind((window as any).__TAURI_INTERNALS__);
        }

        if (!invokeFn) {
          throw new Error('Tauri invoke bridge is not available');
        }

        const savedPath = await invokeFn('save_inventory_template_csv', {
          filename,
          content: csv,
        });

        toast({
          title: 'Template Saved',
          description: `Template saved to ${String(savedPath)}.`,
        });
        return;
      } catch (error) {
        console.error('Failed to save template via Tauri command:', error);
        toast({
          variant: 'destructive',
          title: 'Template Save Failed',
          description:
            'Could not save the CSV template on this Android app build. No file was downloaded.',
        });
        return;
      }
    }

    let downloadStarted = false;
    try {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloadStarted = true;
    } catch (error) {
      console.error('Failed to trigger browser template download:', error);
      downloadStarted = false;
    }

    if (!downloadStarted) {
      toast({
        variant: 'destructive',
        title: 'Template Download Failed',
        description: 'Could not save the template file on this device. Please try again.',
      });
      return;
    }

    toast({
      title: isAndroidUserAgent ? 'Download Started' : 'Template Downloaded',
      description: isAndroidUserAgent
        ? 'Download started. Check your Downloads folder. If no file appears, use the desktop app.'
        : 'Fill in your product details and upload the file. The first row includes option hints.',
    });
  };

  const handleCsvImport = async (): Promise<{
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
  }> => {
    if (!branchId) throw new Error('Branch ID is missing.');

    setImportStage('Processing products');
    setImportProgress(5);

    const normalizedHeaderSet = new Set(parsedHeaders.map((header) => normalizeCsvHeader(header)));
    const hasColumn = (field: keyof typeof CSV_FIELD_ALIASES): boolean =>
      CSV_FIELD_ALIASES[field].some((alias) => normalizedHeaderSet.has(normalizeCsvHeader(alias)));

    const currentBranchItems = (await getInventoryItemsForBranch(branchId)).filter(
      (item) => item._operation !== 'delete'
    );
    const allSuppliers = await db.suppliers.toArray();
    const supplierLookup = new Map<string, Supplier>();
    for (const supplier of allSuppliers) {
      const key = normalizeLookupValue(supplier.name);
      if (key && !supplierLookup.has(key)) {
        supplierLookup.set(key, supplier);
      }
    }
    const missingSupplierKeys = new Set<string>();
    const resolveSupplier = async (value?: string): Promise<Supplier | undefined> => {
      const rawName = String(value ?? '').trim();
      const key = normalizeLookupValue(rawName);
      if (!key) return undefined;
      if (supplierLookup.has(key)) return supplierLookup.get(key);
      if (missingSupplierKeys.has(key)) return undefined;

      try {
        const created = await createSupplier(
          { name: rawName },
          user?.uid || 'system-import',
          user?.displayName || user?.email || 'CSV Import',
          branchId,
          user?.businessId
        );
        supplierLookup.set(key, created);
        return created;
      } catch (error) {
        console.warn('[ImportModal] Failed to create supplier during import:', error);
        missingSupplierKeys.add(key);
        return undefined;
      }
    };

    const importedIds = parsedData
      .map((item) => String(item.id || '').trim())
      .filter(Boolean);

    const existingByImportedIdLookup = new Map<string, InventoryItem>();
    if (importedIds.length > 0) {
      const existingByImportedId = await db.inventory.bulkGet(importedIds);
      for (const existingItem of existingByImportedId) {
        if (existingItem?.id) {
          existingByImportedIdLookup.set(String(existingItem.id), existingItem);
        }
      }
    }

    const byId = new Map<string, InventoryItem>();
    const byName = new Map<string, InventoryItem>();
    const byProductCode = new Map<string, InventoryItem>();
    const byBarcode = new Map<string, InventoryItem>();

    for (const existingItem of currentBranchItems) {
      const itemId = String(existingItem.id || '').trim();
      if (itemId) byId.set(itemId, existingItem);

      const nameKey = normalizeLookupValue(existingItem.name);
      if (nameKey) byName.set(nameKey, existingItem);

      const productCodeKey = normalizeLookupValue(existingItem.productCode);
      if (productCodeKey) byProductCode.set(productCodeKey, existingItem);

      const barcodeKey = normalizeLookupValue(existingItem.barcode);
      if (barcodeKey) byBarcode.set(barcodeKey, existingItem);
    }

    const itemsToUpsert: InventoryItem[] = [];
    const mraMappingsToUpsert: MRAMapping[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const initialStockEntries: InitialStockEntry[] = [];
    const hasStockColumn = hasColumn('stockUnits');
    const totalRows = parsedData.length;
    const nowIso = new Date().toISOString();
    const allExistingMappings = await db.mraMappings.toArray();
    const existingMappingsByItemId = new Map<string, MRAMapping>();

    for (const mapping of allExistingMappings) {
      const mappingItemId = String(mapping.inventoryItemId || '').trim();
      if (!mappingItemId) {
        continue;
      }

      const mappingBranchId = String(mapping.branchId || '').trim();
      if (mappingBranchId && mappingBranchId !== String(branchId)) {
        continue;
      }

      existingMappingsByItemId.set(mappingItemId, mapping);
    }

    for (const [index, parsedItem] of parsedData.entries()) {
      const parsedId = String(parsedItem.id || '').trim();
      const nameKey = normalizeLookupValue(parsedItem.name);
      if (!nameKey) {
        skippedCount += 1;
        continue;
      }

      const productCodeKey = normalizeLookupValue(parsedItem.productCode);
      const barcodeKey = normalizeLookupValue(parsedItem.barcode);

      let matchedExistingItem: InventoryItem | undefined;
      if (parsedId && byId.has(parsedId)) {
        matchedExistingItem = byId.get(parsedId);
      }
      if (!matchedExistingItem && barcodeKey && byBarcode.has(barcodeKey)) {
        matchedExistingItem = byBarcode.get(barcodeKey);
      }
      if (!matchedExistingItem && productCodeKey && byProductCode.has(productCodeKey)) {
        matchedExistingItem = byProductCode.get(productCodeKey);
      }
      if (!matchedExistingItem && byName.has(nameKey)) {
        matchedExistingItem = byName.get(nameKey);
      }

      const globalExistingById = parsedId ? existingByImportedIdLookup.get(parsedId) : undefined;
      const idBelongsToAnotherBranch =
        Boolean(globalExistingById) && String(globalExistingById?.branchId) !== String(branchId);

      const finalId = matchedExistingItem
        ? matchedExistingItem.id
        : parsedId && !idBelongsToAnotherBranch
          ? parsedId
          : uuidv4();

      const stockUnits = Number(parsedItem.stockUnits || 0);
      const reorderLevel = Number(parsedItem.reorderLevel || DEFAULT_REORDER_LEVEL);
      const cost = parsedItem.cost !== undefined ? Number(parsedItem.cost) : undefined;
      const value =
        parsedItem.value !== undefined
          ? Number(parsedItem.value)
          : Number((stockUnits * (cost || 0)).toFixed(2));
      const resolvedSupplier = hasColumn('supplier')
        ? await resolveSupplier(parsedItem.supplier)
        : undefined;
      const resolvedSupplierName = resolvedSupplier?.name;
      const {
        importTaxRate,
        importTaxCalculationMethod,
        importMraProductCode,
        importMraProductName,
        importMraTaxType,
        importMraTaxRate,
        importMraUnitMeasure,
        ...parsedItemBase
      } = parsedItem;
      const resolvedMraTaxType = importMraTaxType ?? normalizeMraTaxType(undefined, importMraTaxRate ?? importTaxRate ?? 0);
      const resolvedMraTaxRate = resolveMraTaxRate(
        resolvedMraTaxType,
        importMraTaxRate,
        importTaxRate
      );

      if (matchedExistingItem) {
        const currentStockUnits = Number(matchedExistingItem.stockUnits || 0);
        const desiredStockUnits = hasColumn('stockUnits') ? stockUnits : currentStockUnits;
        const receiptQuantity = hasColumn('stockUnits')
          ? Math.max(0, desiredStockUnits - currentStockUnits)
          : 0;
        const shouldCreateStockReceipt = receiptQuantity > 0;
        const nextStockUnits = hasColumn('stockUnits')
          ? shouldCreateStockReceipt
            ? currentStockUnits
            : desiredStockUnits
          : currentStockUnits;
        const nextReorderLevel = hasColumn('reorderLevel')
          ? reorderLevel
          : Number(matchedExistingItem.reorderLevel || DEFAULT_REORDER_LEVEL);
        const nextItemType = hasColumn('itemType')
          ? parsedItem.itemType
          : matchedExistingItem.itemType;
        const nextIsProduced = hasColumn('isProduced')
          ? parsedItem.isProduced
          : matchedExistingItem.isProduced;
        const nextIsRecipeManaged = nextItemType === 'sellable' && Boolean(nextIsProduced);
        const nextCost = hasColumn('cost') ? cost : matchedExistingItem.cost;
        const nextValue = hasColumn('value')
          ? value
          : shouldCreateStockReceipt
            ? matchedExistingItem.value
            : hasColumn('stockUnits') || hasColumn('cost')
            ? Number((nextStockUnits * Number(nextCost || 0)).toFixed(2))
            : matchedExistingItem.value;
        const nextStatus = nextIsRecipeManaged
          ? 'In Stock'
          : hasColumn('status')
            ? parsedItem.status
            : shouldCreateStockReceipt
              ? computeStatus(currentStockUnits, nextReorderLevel, nextIsRecipeManaged)
              : hasColumn('stockUnits') || hasColumn('reorderLevel')
              ? computeStatus(nextStockUnits, nextReorderLevel, nextIsRecipeManaged)
              : matchedExistingItem.status;

        const updatedItem: InventoryItem = {
          ...matchedExistingItem,
          id: finalId,
          branchId,
          stockUnits: nextStockUnits,
          reorderLevel: nextReorderLevel,
          cost: nextCost,
          value: nextValue,
          status: nextStatus,
          _dirty: true,
          _operation: 'update',
        };

        if (hasColumn('name')) updatedItem.name = parsedItem.name;
        if (hasColumn('category')) updatedItem.category = parsedItem.category;
        if (hasColumn('itemType')) updatedItem.itemType = parsedItem.itemType;
        if (hasColumn('unitType')) updatedItem.unitType = parsedItem.unitType;
        if (hasColumn('price')) updatedItem.price = parsedItem.price;
        if (hasColumn('supplier')) updatedItem.supplier = resolvedSupplierName;
        if (hasColumn('manufacturer')) updatedItem.manufacturer = parsedItem.manufacturer;
        if (hasColumn('brand')) updatedItem.brand = parsedItem.brand;
        if (hasColumn('batch')) updatedItem.batch = parsedItem.batch;
        if (hasColumn('packSize')) updatedItem.packSize = parsedItem.packSize;
        if (hasColumn('productCode')) updatedItem.productCode = parsedItem.productCode;
        if (hasColumn('barcode')) updatedItem.barcode = parsedItem.barcode;
        if (hasColumn('sku')) updatedItem.sku = parsedItem.sku;
        if (hasColumn('expiry')) updatedItem.expiry = parsedItem.expiry;
        if (hasColumn('isVariablePrice')) updatedItem.isVariablePrice = parsedItem.isVariablePrice;
        if (hasColumn('isProduced')) updatedItem.isProduced = parsedItem.isProduced;
        if (hasColumn('onMenu')) updatedItem.onMenu = parsedItem.onMenu;
        if (hasColumn('isSoldInPortions')) updatedItem.isSoldInPortions = parsedItem.isSoldInPortions;
        if (hasColumn('portionName')) updatedItem.portionName = parsedItem.portionName;
        if (hasColumn('portionsPerUnit')) updatedItem.portionsPerUnit = parsedItem.portionsPerUnit;
        if (hasColumn('portionPrice')) updatedItem.portionPrice = parsedItem.portionPrice;
        if (hasColumn('recipe')) updatedItem.recipe = parsedItem.recipe;

        itemsToUpsert.push({
          ...updatedItem,
        });
        updatedCount += 1;

        if (shouldCreateStockReceipt) {
          const receiptCostPerUnit = hasColumn('cost')
            ? (Number.isFinite(Number(cost)) ? Number(cost) : 0)
            : Number(matchedExistingItem.cost || 0);

          initialStockEntries.push({
            itemId: finalId,
            productName: parsedItem.name,
            quantity: receiptQuantity,
            costPerUnit: receiptCostPerUnit,
            taxRate: normalizeTaxRate(importTaxRate),
            taxMethod: importTaxCalculationMethod ?? 'inclusive',
            supplier: resolvedSupplier,
          });
        }
      } else {
        const initialStockQuantity = hasStockColumn ? Math.max(0, stockUnits) : 0;
        const shouldCreateInitialStock = hasStockColumn && initialStockQuantity > 0;
        const createdStockUnits = shouldCreateInitialStock ? 0 : stockUnits;
        const createdValue = shouldCreateInitialStock
          ? Number((createdStockUnits * (cost || 0)).toFixed(2))
          : value;
        const createdIsRecipeManaged = parsedItem.itemType === 'sellable' && Boolean(parsedItem.isProduced);
        const createdStatus = createdIsRecipeManaged
          ? 'In Stock'
          : shouldCreateInitialStock
            ? computeStatus(createdStockUnits, reorderLevel, createdIsRecipeManaged)
            : parsedItem.status || computeStatus(stockUnits, reorderLevel, createdIsRecipeManaged);

        const createdItem: InventoryItem = {
          ...parsedItemBase,
          id: finalId,
          branchId,
          stockUnits: createdStockUnits,
          reorderLevel,
          cost,
          value: createdValue,
          supplier: hasColumn('supplier') ? resolvedSupplierName : parsedItem.supplier,
          status: createdStatus,
          ...(shouldCreateInitialStock ? { initialStockViaPurchase: true } : {}),
        };

        itemsToUpsert.push({
          ...createdItem,
          _dirty: true,
          _operation: 'create',
        });
        createdCount += 1;

        if (shouldCreateInitialStock) {
          initialStockEntries.push({
            itemId: finalId,
            productName: parsedItem.name,
            quantity: initialStockQuantity,
            costPerUnit: Number.isFinite(Number(cost)) ? Number(cost) : 0,
            taxRate: normalizeTaxRate(importTaxRate),
            taxMethod: importTaxCalculationMethod ?? 'inclusive',
            supplier: resolvedSupplier,
          });
        }
      }

      const indexedItem = itemsToUpsert[itemsToUpsert.length - 1];
      byId.set(String(indexedItem.id), indexedItem);
      if (nameKey) byName.set(nameKey, indexedItem);
      if (productCodeKey) byProductCode.set(productCodeKey, indexedItem);
      if (barcodeKey) byBarcode.set(barcodeKey, indexedItem);

      const resolvedMraProductCode = String(importMraProductCode || '').trim();
      if (resolvedMraProductCode) {
        const existingMapping = existingMappingsByItemId.get(String(indexedItem.id));
        const mappingRecord: MRAMapping = {
          id: existingMapping?.id || `${indexedItem.id}-mra`,
          inventoryItemId: String(indexedItem.id),
          branchId,
          mraProductCode: resolvedMraProductCode,
          mraProductName: String(importMraProductName || indexedItem.name || '').trim() || indexedItem.name,
          mraTaxType: resolvedMraTaxType,
          mraTaxRate: resolvedMraTaxRate,
          mraUnitMeasure: String(importMraUnitMeasure || indexedItem.unitType || 'unit').trim() || 'unit',
          taxCalculationMethod: importTaxCalculationMethod ?? 'inclusive',
          isApproved: true,
          approvedAt: nowIso,
          mraSynced: false,
          lastSyncedAt: existingMapping?.lastSyncedAt,
          createdAt: existingMapping?.createdAt || nowIso,
          updatedAt: nowIso,
          _dirty: true,
          _operation: existingMapping ? 'update' : 'create',
          _synced_at: existingMapping?._synced_at,
        };

        mraMappingsToUpsert.push(mappingRecord);
        existingMappingsByItemId.set(String(indexedItem.id), mappingRecord);
      }

      if (totalRows > 0 && (index % 10 === 0 || index === totalRows - 1)) {
        const percent = Math.min(70, Math.round(((index + 1) / totalRows) * 70));
        setImportProgress(percent);
      }
    }

    if (itemsToUpsert.length === 0) {
      throw new Error('No valid items to import from CSV.');
    }

    setImportStage(
      initialStockEntries.length > 0
        ? mraMappingsToUpsert.length > 0
          ? 'Saving products, initial stock & MRA mappings'
          : 'Saving products & initial stock'
        : mraMappingsToUpsert.length > 0
          ? 'Saving products & MRA mappings'
          : 'Saving products'
    );
    setImportProgress((prev) => (prev < 75 ? 75 : prev));

    const purchaseRecordIds: string[] = [];
    const purchaseOrderIds: string[] = [];

    await db.transaction('rw', db.inventory, db.purchaseHistory, db.purchaseOrders, db.mraMappings, async () => {
      await db.inventory.bulkPut(itemsToUpsert);

      if (mraMappingsToUpsert.length > 0) {
        await db.mraMappings.bulkPut(mraMappingsToUpsert);
      }

      if (initialStockEntries.length === 0) {
        return;
      }

      const groupedBySupplier = new Map<
        string,
        { supplier?: Supplier; entries: InitialStockEntry[] }
      >();

      for (const entry of initialStockEntries) {
        const supplierKey =
          entry.supplier?.id || normalizeLookupValue(entry.supplier?.name) || 'no-supplier';
        const existingGroup = groupedBySupplier.get(supplierKey);
        if (existingGroup) {
          existingGroup.entries.push(entry);
        } else {
          groupedBySupplier.set(supplierKey, {
            supplier: entry.supplier,
            entries: [entry],
          });
        }
      }

      let receivedIndexOffset = 0;
      const baseReceivedAt = Date.now();
      const referenceNumber = `IMPORT-${new Date(baseReceivedAt).toISOString().slice(0, 10).replace(/-/g, '')}`;

      for (const group of groupedBySupplier.values()) {
        const purchaseOrderId = uuidv4();
        purchaseOrderIds.push(purchaseOrderId);

        let totalCost = 0;
        let totalVat = 0;
        let totalWithVat = 0;

        for (const entry of group.entries) {
          const quantity = Number(entry.quantity || 0);
          const costPerUnit = Number(entry.costPerUnit || 0);
          const taxRate = normalizeTaxRate(entry.taxRate);
          const taxMethod = entry.taxMethod;
          const itemVat = calculateItemVat(costPerUnit, quantity, taxRate, taxMethod);
          const itemGross = calculateItemGross(costPerUnit, quantity, itemVat, taxMethod);
          totalCost += quantity * costPerUnit;
          totalVat += itemVat;
          totalWithVat += itemGross;
        }

        const paymentStatus: PurchaseOrder['paymentStatus'] = 'Paid';
        const amountPaid = totalWithVat;
        const amountDue = 0;

        for (const entry of group.entries) {
          const quantityReceived = Number(entry.quantity || 0);
          const costPerUnit = Number(entry.costPerUnit || 0);
          const itemTotalCost = quantityReceived * costPerUnit;
          const taxRate = normalizeTaxRate(entry.taxRate);
          const taxMethod = entry.taxMethod;
          const itemVatAmount = calculateItemVat(costPerUnit, quantityReceived, taxRate, taxMethod);
          const itemGross = calculateItemGross(costPerUnit, quantityReceived, itemVatAmount, taxMethod);
          const normalizedCostPerUnit = Number.isFinite(costPerUnit)
            ? Number(costPerUnit.toFixed(4))
            : Number(costPerUnit || 0);
          const receivedDate = new Date(baseReceivedAt + receivedIndexOffset).toISOString();
          receivedIndexOffset += 1;

          const product = await db.inventory.get(entry.itemId);
          if (product) {
            const newStock = (product.stockUnits || 0) + quantityReceived;
            const nextValue = Number.isFinite(newStock * normalizedCostPerUnit)
              ? Number((newStock * normalizedCostPerUnit).toFixed(2))
              : product.value;
            await db.inventory.update(entry.itemId, {
              stockUnits: newStock,
              // Product import keeps the entered cost intact, even when VAT metadata is inclusive.
              cost: normalizedCostPerUnit,
              value: nextValue,
              status:
                newStock > (product.reorderLevel || 0)
                  ? 'In Stock'
                  : newStock > 0
                    ? 'Low Stock'
                    : 'Out of Stock',
            });
          }

          const purchaseRecordId = uuidv4();
          await db.purchaseHistory.put({
            id: purchaseRecordId,
            purchaseOrderId: purchaseOrderId,
            referenceNumber: referenceNumber,
            vatAmount: totalVat,
            taxRate: taxRate,
            taxCalculationMethod: taxMethod,
            taxAmount: itemVatAmount,
            productId: entry.itemId,
            productName: entry.productName,
            supplierId: group.supplier?.id,
            supplierName: group.supplier?.name || 'No Supplier',
            branchId: branchId,
            quantityReceived: quantityReceived,
            quantityRemaining: quantityReceived,
            costPerUnit: costPerUnit,
            totalCost: itemTotalCost,
            paymentStatus: paymentStatus,
            amountDue: paymentStatus === 'Paid' ? 0 : itemGross,
            receivedDate: receivedDate,
            _dirty: true,
            _operation: 'create',
          } as PurchaseRecord);
          purchaseRecordIds.push(purchaseRecordId);
        }

        await db.purchaseOrders.add({
          id: purchaseOrderId,
          orderNumber: purchaseOrderId,
          supplierId: group.supplier?.id,
          supplierName: group.supplier?.name || 'No Supplier',
          status: 'Received',
          totalItems: group.entries.length,
          totalCost: totalCost,
          referenceNumber: referenceNumber,
          vatAmount: totalVat,
          paymentStatus: paymentStatus,
          amountPaid: amountPaid,
          amountDue: amountDue,
          notes: 'Initial stock import',
          createdBy: user?.displayName || user?.email || 'System',
          branchId: branchId,
          items: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          supplierTin: group.supplier?.supplierTin || undefined,
          supplierVatRegistered: group.supplier?.vatRegistered || false,
          eisSynced: false,
          eisSyncedAt: undefined,
          approvedBy: undefined,
          approvedAt: undefined,
          _dirty: true,
          _operation: 'create',
        });
      }
    });

    setImportStage('Finalizing import');
    setImportProgress((prev) => (prev < 92 ? 92 : prev));

    for (const recordId of purchaseRecordIds) {
      await syncService.markAsDirty('PurchaseRecord', recordId, 'create');
    }
    for (const orderId of purchaseOrderIds) {
      await syncService.markAsDirty('PurchaseOrder', orderId, 'create');
    }

    setImportProgress((prev) => (prev < 80 ? 80 : prev));
    setImportStage('Import complete');

    return {
      createdCount,
      updatedCount,
      skippedCount,
    };
  };

  const handleBranchImport = async (): Promise<{
    importedCount: number;
    skippedCount: number;
    productCodeResetCount: number;
  }> => {
    if (!branchId) throw new Error('Branch ID is missing.');
    if (!sourceBranchId) throw new Error('Please select a source branch.');

    const selectedProducts = sourceProducts.filter((item) => selectedProductIds.includes(item.id));
    if (selectedProducts.length === 0) {
      throw new Error('Please select at least one product to import.');
    }

    if (typeof window !== 'undefined' && navigator.onLine) {
      try {
        await syncService.fetchAllInventoryFromBackend(branchId);
      } catch (error) {
        console.warn('Failed to refresh target branch products from backend before import:', error);
      }
    }

    const existingTargetItems = await getInventoryItemsForBranch(branchId);
    const existingNames = new Set(
      existingTargetItems
        .filter((item) => item._operation !== 'delete')
        .map((item) => normalizeProductName(item.name))
        .filter(Boolean)
    );

    const itemsToCreate: InventoryItem[] = [];
    let skippedCount = 0;
    let productCodeResetCount = 0;

    for (const sourceItem of selectedProducts) {
      const normalizedName = normalizeProductName(sourceItem.name);
      if (!normalizedName || existingNames.has(normalizedName)) {
        skippedCount += 1;
        continue;
      }

      existingNames.add(normalizedName);

      const {
        id: _id,
        _dirty: _dirty,
        _operation: _operation,
        _synced_at: _syncedAt,
        productCode: _sourceProductCode,
        ...productFields
      } = sourceItem;
      if (_sourceProductCode) {
        productCodeResetCount += 1;
      }

      const stockUnits = 0;

      itemsToCreate.push({
        ...productFields,
        id: uuidv4(),
        branchId,
        stockUnits,
        value: 0,
        status: 'Out of Stock',
        _dirty: true,
        _operation: 'create',
      });
    }

    if (itemsToCreate.length > 0) {
      await db.inventory.bulkAdd(itemsToCreate);
    }

    return {
      importedCount: itemsToCreate.length,
      skippedCount,
      productCodeResetCount,
    };
  };

  const handleImport = async () => {
    setIsImporting(true);
    try {
      if (importMode === 'csv') {
        const result = await handleCsvImport();
        const summary = [
          `${result.createdCount} created`,
          `${result.updatedCount} updated`,
          result.skippedCount > 0 ? `${result.skippedCount} skipped` : null,
        ].filter(Boolean);
        toast({
          title: 'Import Successful',
          description: `CSV import complete: ${summary.join(', ')}.`,
        });
      } else {
        setImportStage('Importing from branch');
        setImportProgress(10);
        const result = await handleBranchImport();
        setImportProgress((prev) => (prev < 80 ? 80 : prev));
        setImportStage('Import complete');
        const summaryParts = [
          `Imported ${result.importedCount} products`,
          result.skippedCount > 0 ? `skipped ${result.skippedCount} existing` : null,
          result.productCodeResetCount > 0
            ? `${result.productCodeResetCount} product code${result.productCodeResetCount === 1 ? '' : 's'} reset for backend uniqueness`
            : null,
          'stock initialized to 0',
        ].filter(Boolean) as string[];

        toast({
          title: 'Import Successful',
          description: `${summaryParts.join(', ')}.`,
        });
      }

      if (typeof window !== 'undefined' && navigator.onLine) {
        setImportStage('Syncing to server');
        setImportProgress((prev) => (prev < 80 ? 80 : prev));

        await syncService.performFullSync(branchId, {
          onProgress: (progress) => {
            const base = 80;
            const span = 20;
            const percent = typeof progress.percent === 'number' ? progress.percent : undefined;
            let nextValue = base;

            if (progress.stage === 'inventory' && percent !== undefined) {
              nextValue = base + Math.round((percent / 100) * span);
            } else if (progress.stage === 'pull') {
              nextValue = base + Math.round(span * 0.9);
            } else if (progress.stage === 'done') {
              nextValue = 100;
            } else if (progress.stage === 'error') {
              nextValue = base + Math.round(span * 0.9);
            }

            setImportProgress((prev) => Math.max(prev, Math.min(100, nextValue)));
            if (progress.message) {
              setImportStage(progress.message);
            }
          },
        });
      }

      setImportProgress(100);
      setImportStage('All done');

      onOpenChange(false);
    } catch (error: any) {
      console.error('Failed to import data:', error);
      toast({ variant: 'destructive', title: 'Import Failed', description: error.message });
    } finally {
      setIsImporting(false);
    }
  };

  const isBranchImportReady = !!sourceBranchId && selectedProductIds.length > 0;
  const isCsvImportReady = parsedData.length > 0;
  const canImport = importMode === 'csv' ? isCsvImportReady : isBranchImportReady;
  const areAllSelected = sourceProducts.length > 0 && selectedProductIds.length === sourceProducts.length;
  const isImportProgressVisible =
    isImporting || isParsing || isLoadingSourceProducts || importProgress > 0;
  const importProgressValue = isImporting
    ? importProgress
    : isParsing
      ? 35
      : isLoadingSourceProducts
        ? 45
        : importProgress;
  const importProgressLabel = isImporting
    ? importStage || 'Importing...'
    : isParsing
      ? 'Parsing file'
      : isLoadingSourceProducts
        ? 'Loading branch products'
        : importStage || 'Loading...';

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import Products</DialogTitle>
          <DialogDescription>
            Import products from a CSV file or copy them from another branch in this business.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="py-4">
            <Tabs value={importMode} onValueChange={(value) => setImportMode(value as ImportMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="csv">From CSV</TabsTrigger>
                <TabsTrigger value="branch">From Branch</TabsTrigger>
              </TabsList>

              <TabsContent value="csv" className="space-y-6 pt-4">
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={handleDownloadTemplate}>
                    <Download className="w-4 h-4 mr-2" />
                    Download Template
                  </Button>
                </div>

              {!file ? (
                <div
                  className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-lg cursor-pointer hover:bg-muted/50"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="w-8 h-8 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">Click or drag file to this area to upload</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
              ) : (
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <FileText className="w-6 h-6" />
                        <div>
                          <p className="font-semibold">{file.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {isParsing ? 'Parsing...' : `${parsedData.length} items found.`}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setFile(null);
                          setParsedData([]);
                          setParsedHeaders([]);
                          if (fileInputRef.current) {
                            fileInputRef.current.value = '';
                          }
                        }}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {isImportProgressVisible && (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{importProgressLabel}</span>
                      <span>{Math.round(importProgressValue)}%</span>
                    </div>
                    <Progress value={importProgressValue} />
                  </CardContent>
                </Card>
              )}

              {!isParsing && parsedData.length > 0 && (
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Review Products Before Import</p>
                      <p className="text-xs text-muted-foreground">
                        {parsedData.length} item{parsedData.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <div className="max-h-72 overflow-y-auto rounded-md border p-2">
                      <div className="space-y-2">
                        {parsedData.map((item, index) => (
                          <div key={`${item.id}-${index}`} className="rounded-md border p-3">
                            <p className="text-xs text-muted-foreground">#{index + 1}</p>
                            <p
                              className="font-medium text-sm overflow-hidden"
                              title={item.name}
                              style={{
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                              }}
                            >
                              {item.name}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                              <p>
                                <span className="text-muted-foreground">Unit:</span> {item.unitType || 'unit'}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Reorder:</span> {formatPreviewNumber(item.reorderLevel)}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Stock:</span> {formatPreviewNumber(item.stockUnits)}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Category:</span> {item.category || '—'}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Cost:</span> {formatPreviewNumber(item.cost)}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Price:</span> {formatPreviewNumber(item.price)}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Tax Rate:</span> {formatPreviewNumber(item.importTaxRate)}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Tax Method:</span> {item.importTaxCalculationMethod || '—'}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Supplier:</span> {item.supplier || '—'}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Barcode:</span> {item.barcode || '—'}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Confirm these products, then click Import.
                    </p>
                  </CardContent>
                </Card>
              )}

              </TabsContent>

              <TabsContent value="branch" className="space-y-4 pt-4">
                {sourceBranchOptions.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No other branches are available to import from.
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label>Source Branch</Label>
                      <Select value={sourceBranchId} onValueChange={setSourceBranchId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select branch to import from" />
                        </SelectTrigger>
                        <SelectContent>
                          {sourceBranchOptions.map((branch) => (
                            <SelectItem key={branch.id} value={branch.id}>
                              {branch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                  {sourceBranchId && (
                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">
                            {isLoadingSourceProducts ? 'Loading products...' : `${sourceProducts.length} products found`}
                          </p>
                          {sourceProducts.length > 0 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={handleToggleAllSourceProducts}
                              className="h-8 px-2"
                            >
                              {areAllSelected ? (
                                <Square className="mr-2 h-4 w-4" />
                              ) : (
                                <CheckSquare className="mr-2 h-4 w-4" />
                              )}
                              {areAllSelected ? 'Clear All' : 'Select All'}
                            </Button>
                          )}
                        </div>

                        {isLoadingSourceProducts ? (
                          <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading branch products...
                          </div>
                        ) : sourceProducts.length === 0 ? (
                          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                            No products found in this branch.
                          </div>
                        ) : (
                          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                            {sourceProducts.map((item) => {
                              const isSelected = selectedProductIds.includes(item.id);
                              return (
                                <label
                                  key={item.id}
                                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/40"
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={(checked) => toggleProductSelection(item.id, checked === true)}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{item.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {item.category} • Stock {item.stockUnits || 0} {item.unitType || 'units'}
                                    </p>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                          Selected {selectedProductIds.length} of {sourceProducts.length} products.
                        </p>
                      </CardContent>
                    </Card>
                  )}
                </>
              )}

                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5" />
                  Existing products are skipped by name. Imported stock is initialized to 0.
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
        <DialogFooter className="mt-2 border-t bg-background/95 pt-4 sticky bottom-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isImporting}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!canImport || isImporting}>
            {isImporting && <Loader2 className="animate-spin mr-2" />}
            {importMode === 'csv' ? `Import ${parsedData.length} items` : `Import ${selectedProductIds.length} products`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
