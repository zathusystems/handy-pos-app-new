'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Pencil,
} from 'lucide-react';
import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';
import { db, type InventoryItem } from '@/lib/db';
import { ProductMappingForm } from './product-mapping-form';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PaginationControls, usePaginatedItems } from './pagination-controls';

interface MRAMapping {
  id: string;
  inventory_item: string;
  inventory_item_name: string;
  branch?: number | string;
  branch_name?: string;
  mra_product_code: string;
  mra_product_name: string;
  mra_tax_type?: string;
  mra_tax_rate: number;
  mra_unit_measure?: string;
  tax_calculation_method?: string;
  taxCalculationMethod?: string;
  is_approved: boolean;
  mra_synced: boolean;
  created_at: string;
  approved_at?: string;
  last_synced_at?: string;
}

type MRATaxType = 'standard' | 'zero' | 'exempt';
type TaxCalculationMethod = 'inclusive' | 'exclusive';

const buildMappingsUrl = (branchId?: string): string => {
  if (!branchId) {
    return '/inventory/mra-mappings/';
  }

  const branchIdMatch = branchId.match(/\d+/);
  const branchIdInt = branchIdMatch ? parseInt(branchIdMatch[0], 10) : parseInt(branchId, 10);
  return `/inventory/mra-mappings/?branch_id=${branchIdInt}`;
};

const fetchAllMappings = async (initialUrl: string): Promise<MRAMapping[]> => {
  const allMappings: MRAMapping[] = [];
  let nextUrl: string | null = initialUrl;
  const visitedUrls = new Set<string>();

  while (nextUrl) {
    if (visitedUrls.has(nextUrl)) {
      console.warn('[MRAMappingsTab] Detected duplicate pagination URL, stopping:', nextUrl);
      break;
    }
    visitedUrls.add(nextUrl);

    const response = await authFetch.fetch<any>(nextUrl);

    if (Array.isArray(response)) {
      allMappings.push(...response);
      break;
    }

    if (Array.isArray(response?.results)) {
      allMappings.push(...response.results);
      nextUrl = typeof response.next === 'string' && response.next.length > 0
        ? response.next
        : null;
      continue;
    }

    break;
  }

  return allMappings;
};

interface MRAMappingsTabProps {
  inventoryData: InventoryItem[];
  businessId?: string | number;
  branchId?: string;
  searchTerm: string;
  refreshKey?: number;
}

export function MRAMappingsTab({ inventoryData, businessId, branchId, searchTerm, refreshKey = 0 }: MRAMappingsTabProps) {
  const [mappings, setMappings] = useState<MRAMapping[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState<string | null>(null);
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [editingMapping, setEditingMapping] = useState<MRAMapping | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editMraCode, setEditMraCode] = useState('');
  const [editMraName, setEditMraName] = useState('');
  const [editTaxType, setEditTaxType] = useState<MRATaxType>('standard');
  const [editTaxRate, setEditTaxRate] = useState('16.5');
  const [editUnitMeasure, setEditUnitMeasure] = useState('unit');
  const [editCalcMethod, setEditCalcMethod] = useState<TaxCalculationMethod>('inclusive');
  const [filterStatus, setFilterStatus] = useState<'all' | 'approved' | 'unapproved' | 'synced'>('all');
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();

  const normalizeTaxType = (value?: string): MRATaxType => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'vat_zero' || normalized === 'zero' || normalized === 'zero_rated' || normalized === 'zero-rated') {
      return 'zero';
    }
    if (normalized === 'vat_exempt' || normalized === 'exempt') {
      return 'exempt';
    }
    return 'standard';
  };

  const normalizeCalcMethod = (value: unknown): 'inclusive' | 'exclusive' => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized.startsWith('excl') ? 'exclusive' : 'inclusive';
  };

  const normalizeBranchId = (value: unknown): string | undefined => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return undefined;
    const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
    if (brnMatch) return brnMatch[1];
    const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
    if (legacyMatch) return legacyMatch[1];
    return normalized;
  };

  const syncMappingsToLocalCache = useCallback(async (mappingsList: MRAMapping[]) => {
    try {
      const nowIso = new Date().toISOString();
      await db.mraMappings.bulkPut(
        mappingsList
          .map((mapping) => {
            const inventoryItemId = String(mapping.inventory_item || '').trim();
            if (!inventoryItemId) return null;
            const rawTaxType = mapping.mra_tax_type;
            const taxType =
              rawTaxType === 'zero' || rawTaxType === 'exempt'
                ? rawTaxType
                : 'standard';
            const calcMethod = normalizeCalcMethod(
              (mapping as any).tax_calculation_method ??
              (mapping as any).taxCalculationMethod
            );
            return {
              id: String(mapping.id),
              inventoryItemId,
              branchId: normalizeBranchId(mapping.branch),
              mraProductCode: mapping.mra_product_code || '',
              mraProductName: mapping.mra_product_name || mapping.inventory_item_name || '',
              mraTaxType: taxType,
              mraTaxRate: Number(mapping.mra_tax_rate ?? 0),
              mraUnitMeasure: mapping.mra_unit_measure || '',
              taxCalculationMethod: calcMethod,
              isApproved: Boolean(mapping.is_approved),
              approvedAt: mapping.approved_at || undefined,
              mraSynced: Boolean(mapping.mra_synced),
              lastSyncedAt: mapping.last_synced_at || undefined,
              createdAt: mapping.created_at || nowIso,
              updatedAt: nowIso,
              _dirty: false,
              _synced_at: nowIso,
            };
          })
          .filter(Boolean) as any[]
      );
    } catch (syncError) {
      console.warn('[MRAMappingsTab] Failed to refresh local MRA mapping cache:', syncError);
    }
  }, []);

  const refreshMappings = useCallback(async (showLoadingState = false) => {
    if (showLoadingState) {
      setIsLoading(true);
    }

    try {
      const url = buildMappingsUrl(branchId);
      console.log('[MRAMappingsTab] Fetching mappings from:', url);
      const mappingsList = await fetchAllMappings(url);

      console.log('[MRAMappingsTab] Received', mappingsList.length, 'mappings for branch:', branchId);
      setMappings(mappingsList);
      await syncMappingsToLocalCache(mappingsList);
      return mappingsList;
    } catch (error) {
      console.error('Failed to fetch MRA mappings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load MRA mappings',
      });
      return [];
    } finally {
      if (showLoadingState) {
        setIsLoading(false);
      }
    }
  }, [branchId, syncMappingsToLocalCache]);

  // Fetch MRA mappings from backend - filtered by branch
  useEffect(() => {
    void refreshMappings(true);
  }, [refreshMappings, refreshKey]);

  // Approve mapping
  const handleApproveMapping = async (mappingId: string) => {
    try {
      setIsApproving(mappingId);
      await authFetch.fetch<any>(`/inventory/mra-mappings/${mappingId}/approve/`, {
        method: 'POST',
        body: JSON.stringify({
          is_approved: true,
        }),
      });

      // Update local state
      setMappings(mappings.map(m => 
        m.id === mappingId 
          ? { ...m, is_approved: true, mra_synced: true, approved_at: new Date().toISOString() }
          : m
      ));
      await refreshMappings();

      toast({
        title: 'Success',
        description: 'Mapping approved. Sync it from the MRA compliance view when ready.',
      });
    } catch (error) {
      console.error('Failed to approve mapping:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to approve mapping',
      });
    } finally {
      setIsApproving(null);
    }
  };

  const openEditDialog = (mapping: MRAMapping) => {
    const normalizedTaxType = normalizeTaxType(mapping.mra_tax_type);
    const normalizedCalcMethod = normalizeCalcMethod(
      (mapping as any).tax_calculation_method ??
      (mapping as any).taxCalculationMethod
    );

    setEditingMapping(mapping);
    setEditMraCode(String(mapping.mra_product_code || '').trim());
    setEditMraName(String(mapping.mra_product_name || mapping.inventory_item_name || '').trim());
    setEditTaxType(normalizedTaxType);
    setEditTaxRate(String(Number(mapping.mra_tax_rate ?? 0)));
    setEditUnitMeasure(String(mapping.mra_unit_measure || 'unit').trim() || 'unit');
    setEditCalcMethod(normalizedCalcMethod);
  };

  const closeEditDialog = (force = false) => {
    if (isSavingEdit && !force) return;
    setEditingMapping(null);
    setEditMraCode('');
    setEditMraName('');
    setEditTaxType('standard');
    setEditTaxRate('16.5');
    setEditUnitMeasure('unit');
    setEditCalcMethod('inclusive');
  };

  const handleSaveEdit = async () => {
    if (!editingMapping) {
      return;
    }

    const trimmedName = editMraName.trim() || editingMapping.inventory_item_name;
    const trimmedCode = editMraCode.trim();
    const normalizedRate = editTaxType === 'standard' ? Number(editTaxRate) : 0;
    const normalizedUnit = editUnitMeasure.trim() || 'unit';
    const normalizedCalcMethod: TaxCalculationMethod =
      editTaxType === 'standard' ? editCalcMethod : 'inclusive';

    if (
      trimmedCode &&
      mappings.some(
        (mapping) =>
          mapping.id !== editingMapping.id &&
          String(mapping.mra_product_code || '').trim() === trimmedCode
      )
    ) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'This MRA code is already assigned to another product',
      });
      return;
    }

    if (!Number.isFinite(normalizedRate) || normalizedRate < 0) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Enter a valid non-negative tax rate',
      });
      return;
    }

    try {
      setIsSavingEdit(true);

      await authFetch.fetch<any>(`/inventory/mra-mappings/${editingMapping.id}/`, {
        method: 'PUT',
        body: JSON.stringify({
          inventory_item: editingMapping.inventory_item,
          mra_product_code: trimmedCode,
          mra_product_name: trimmedName,
          mra_tax_type: editTaxType,
          mra_tax_rate: normalizedRate,
          mra_unit_measure: normalizedUnit,
          tax_calculation_method: normalizedCalcMethod,
        }),
      });

      if (editingMapping.is_approved) {
        await authFetch.fetch<any>(`/inventory/mra-mappings/${editingMapping.id}/approve/`, {
          method: 'POST',
          body: JSON.stringify({
            is_approved: true,
            mra_synced: true,
          }),
        });
      }

      await refreshMappings();
      closeEditDialog(true);

      toast({
        title: 'Success',
        description: 'Mapping updated',
      });
    } catch (error) {
      console.error('Failed to update mapping:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update mapping',
      });
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Filter mappings
  const filteredMappings = mappings.filter(mapping => {
    const matchesSearch =
      !normalizedSearchTerm ||
      [
        mapping.inventory_item_name,
        mapping.mra_product_code,
        mapping.mra_product_name,
        mapping.branch_name,
        mapping.mra_tax_type,
      ].some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm));

    if (filterStatus === 'approved') return matchesSearch && mapping.is_approved;
    if (filterStatus === 'unapproved') return matchesSearch && !mapping.is_approved;
    if (filterStatus === 'synced') return matchesSearch && mapping.mra_synced;
    return matchesSearch;
  });

  const {
    setCurrentPage,
    totalItems,
    totalPages,
    effectiveCurrentPage,
    pageStartIndex,
    pageEndIndex,
    paginatedItems: paginatedMappings,
  } = usePaginatedItems(filteredMappings);

  useEffect(() => {
    setCurrentPage(1);
  }, [filterStatus, normalizedSearchTerm, setCurrentPage]);

  const stats = {
    total: mappings.length,
    approved: mappings.filter(m => m.is_approved).length,
    synced: mappings.filter(m => m.mra_synced).length,
    pending: mappings.filter(m => !m.is_approved).length,
  };

  const mappedInventoryIds = new Set(
    mappings
      .map((mapping) => String(mapping.inventory_item || '').trim())
      .filter((id) => id.length > 0)
  );
  const pendingFilteredMappings = filteredMappings.filter((mapping) => !mapping.is_approved);
  const unmappedInventory = inventoryData.filter(
    (item) => !mappedInventoryIds.has(String(item.id))
  );

  const handleApproveAll = async () => {
    if (pendingFilteredMappings.length === 0) {
      return;
    }

    try {
      setIsApprovingAll(true);
      let approvedCount = 0;
      let failedCount = 0;

      for (const mapping of pendingFilteredMappings) {
        try {
          await authFetch.fetch<any>(`/inventory/mra-mappings/${mapping.id}/approve/`, {
            method: 'POST',
            body: JSON.stringify({
              is_approved: true,
            }),
          });
          approvedCount += 1;
        } catch (error) {
          console.error('Failed to approve mapping:', mapping.id, error);
          failedCount += 1;
        }
      }

      if (approvedCount > 0) {
        await refreshMappings();
      }

      if (approvedCount > 0 && failedCount === 0) {
        toast({
          title: 'Success',
          description: `Approved ${approvedCount} mapping${approvedCount === 1 ? '' : 's'}`,
        });
        return;
      }

      if (approvedCount > 0) {
        toast({
          title: 'Partial Success',
          description: `Approved ${approvedCount} mapping${approvedCount === 1 ? '' : 's'}, ${failedCount} failed`,
        });
        return;
      }

      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to approve mappings',
      });
    } finally {
      setIsApprovingAll(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Mappings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.approved}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Synced</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.synced}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{stats.pending}</div>
          </CardContent>
        </Card>
      </div>

      {/* Action */}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleApproveAll}
          disabled={isApprovingAll || pendingFilteredMappings.length === 0}
        >
          {isApprovingAll ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Approving...
            </>
          ) : (
            `Approve All Pending (${pendingFilteredMappings.length})`
          )}
        </Button>
        <ProductMappingForm
          inventoryData={unmappedInventory}
          businessId={businessId?.toString()}
          onMappingCreated={() => {
            void refreshMappings();
          }}
        />
      </div>

      {/* Filters */}
      <div className="flex gap-4 flex-col sm:flex-row">
        <Select value={filterStatus} onValueChange={(value: any) => setFilterStatus(value)}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Mappings</SelectItem>
            <SelectItem value="approved">Approved Only</SelectItem>
            <SelectItem value="unapproved">Pending Approval</SelectItem>
            <SelectItem value="synced">Synced Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Mappings Table */}
      <Card>
        <CardHeader>
          <CardTitle>Product Mappings</CardTitle>
          <CardDescription>
            {filteredMappings.length} of {mappings.length} mappings
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredMappings.length === 0 ? (
            <div className="text-center py-12">
              <AlertTriangle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">
                {normalizedSearchTerm ? `No mappings match "${searchTerm.trim()}".` : 'No mappings found'}
              </p>
            </div>
          ) : (
            <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product Name</TableHead>
                    <TableHead>MRA Code</TableHead>
                    <TableHead>MRA Product</TableHead>
                    <TableHead>Tax Rate</TableHead>
                    <TableHead>Calc Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedMappings.map((mapping) => (
                    <TableRow key={mapping.id}>
                      <TableCell className="font-medium">
                        {mapping.inventory_item_name}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-2 py-1 rounded">
                          {mapping.mra_product_code}
                        </code>
                      </TableCell>
                      <TableCell>{mapping.mra_product_name}</TableCell>
                      <TableCell>{mapping.mra_tax_rate}%</TableCell>
                      <TableCell>
                        {normalizeCalcMethod(
                          (mapping as any).tax_calculation_method ??
                          (mapping as any).taxCalculationMethod ??
                          'inclusive'
                        ) === 'exclusive' ? 'Exclusive' : 'Inclusive'}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          {mapping.is_approved && (
                            <Badge variant="default" className="bg-green-600">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Approved
                            </Badge>
                          )}
                          {!mapping.is_approved && (
                            <Badge variant="outline" className="border-amber-600 text-amber-600">
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              Pending
                            </Badge>
                          )}
                          {mapping.mra_synced && (
                            <Badge variant="secondary">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Synced
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openEditDialog(mapping)}
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            Edit
                          </Button>
                          {!mapping.is_approved && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => handleApproveMapping(mapping.id)}
                              disabled={isApproving === mapping.id || isApprovingAll}
                            >
                              {isApproving === mapping.id ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  Approving...
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  Approve
                                </>
                              )}
                            </Button>
                          )}
                          {mapping.is_approved && (
                            <span className="text-xs text-muted-foreground">Approved</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              currentPage={effectiveCurrentPage}
              totalItems={totalItems}
              totalPages={totalPages}
              pageStartIndex={pageStartIndex}
              pageEndIndex={pageEndIndex}
              onPageChange={setCurrentPage}
              itemLabel="mappings"
            />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={editingMapping !== null} onOpenChange={(open) => {
        if (!open) {
          closeEditDialog();
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Mapping</DialogTitle>
            <DialogDescription>
              Update the selected mapping details and save them back to the current branch.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Product</label>
              <Input value={editingMapping?.inventory_item_name || ''} disabled />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">MRA Code</label>
              <Input
                value={editMraCode}
                onChange={(event) => setEditMraCode(event.target.value)}
                placeholder="Enter MRA code"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">MRA Product Name</label>
              <Input
                value={editMraName}
                onChange={(event) => setEditMraName(event.target.value)}
                placeholder="Enter MRA product name"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium">Tax Type</label>
                <Select
                  value={editTaxType}
                  onValueChange={(value) => {
                    const nextTaxType = value as MRATaxType;
                    setEditTaxType(nextTaxType);
                    if (nextTaxType !== 'standard') {
                      setEditTaxRate('0');
                      setEditCalcMethod('inclusive');
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="zero">Zero Rated</SelectItem>
                    <SelectItem value="exempt">Exempt</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium">Tax Rate (%)</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editTaxType === 'standard' ? editTaxRate : '0'}
                  onChange={(event) => setEditTaxRate(event.target.value)}
                  disabled={editTaxType !== 'standard'}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium">Unit of Measure</label>
                <Select value={editUnitMeasure} onValueChange={setEditUnitMeasure}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
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
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium">Calculation Method</label>
                <Select
                  value={editTaxType === 'standard' ? editCalcMethod : 'inclusive'}
                  onValueChange={(value) => setEditCalcMethod(value as TaxCalculationMethod)}
                  disabled={editTaxType !== 'standard'}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inclusive">Inclusive</SelectItem>
                    <SelectItem value="exclusive">Exclusive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => closeEditDialog()}
                disabled={isSavingEdit}
              >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveEdit}
              disabled={isSavingEdit || !editingMapping}
            >
              {isSavingEdit ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
