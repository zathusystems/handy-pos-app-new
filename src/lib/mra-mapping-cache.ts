import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';
import { safeLocalStorageGetItem, safeLocalStorageSetItem } from '@/lib/safe-local-storage';

const CACHE_META_PREFIX = 'handypos-mra-cache-meta';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PER_ITEM_BATCH_SIZE = 8;

type WarmMraMappingsOptions = {
  branchId?: string | null;
  inventoryItemIds?: string[];
  force?: boolean;
  logPrefix?: string;
};

type WarmMraMappingsResult = {
  attempted: boolean;
  refreshed: boolean;
  missingInventoryItemIds: string[];
  branchMappingsFetched: number;
  perItemMappingsFetched: number;
};

type CacheMeta = {
  refreshedAt: string;
  branchId: string;
  inventoryItemCount: number;
  missingItemCount: number;
};

const normalizeBranchId = (value?: string | number | null): string => {
  if (value && typeof value === 'object') {
    const maybeId =
      (value as any).id ??
      (value as any).branch_id ??
      (value as any).branchId ??
      (value as any).branch;

    if (maybeId !== undefined && maybeId !== value) {
      return normalizeBranchId(maybeId as any);
    }

    return '';
  }

  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === '[object Object]') {
    return '';
  }

  const brnMatch = /^BRN-(\d+)$/i.exec(normalized);
  if (brnMatch) {
    return brnMatch[1];
  }

  const legacyMatch = /^branch-(\d+)$/i.exec(normalized);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  return normalized;
};

const normalizeInventoryReference = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nestedValue =
      obj.id ??
      obj.pk ??
      obj.uuid ??
      obj.inventory_item_id ??
      obj.inventoryItemId;

    return String(nestedValue ?? '').trim();
  }

  return String(value).trim();
};

const resolveMappingInventoryItemId = (mapping: any): string => {
  if (!mapping || typeof mapping !== 'object') {
    return '';
  }

  const candidates = [
    mapping.inventoryItemId,
    mapping.inventory_item_id,
    mapping.inventoryItem,
    mapping.inventory_item,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeInventoryReference(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const resolveMappingBranchId = (mapping: any): string => {
  return normalizeBranchId(
    mapping?.branchId ??
      mapping?.branch_id ??
      mapping?.branch
  );
};

const normalizeTaxCalculationMethod = (value: unknown): 'inclusive' | 'exclusive' => {
  return String(value ?? '').trim().toLowerCase().startsWith('excl') ? 'exclusive' : 'inclusive';
};

const extractMappingsFromResponse = (response: any): any[] => {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.results)) {
    return response.results;
  }

  return [];
};

const extractPaginatedItems = <T,>(result: any): { items: T[]; next: string | null } => {
  if (Array.isArray(result)) {
    return { items: result, next: null };
  }

  if (result && Array.isArray(result.results)) {
    return {
      items: result.results,
      next: typeof result.next === 'string' && result.next.trim().length > 0 ? result.next : null,
    };
  }

  return { items: [], next: null };
};

const fetchPaginatedResults = async <T,>(initialUrl: string): Promise<T[]> => {
  const collected: T[] = [];
  const visitedUrls = new Set<string>();
  let nextUrl: string | null = initialUrl;

  while (nextUrl) {
    if (visitedUrls.has(nextUrl)) {
      throw new Error('Pagination loop detected while fetching MRA mappings');
    }

    visitedUrls.add(nextUrl);
    const result = await authFetch.fetch<any>(nextUrl, { method: 'GET' });
    const { items, next } = extractPaginatedItems<T>(result);

    collected.push(...items);
    nextUrl = next;
  }

  return collected;
};

const mappingReadinessRank = (mapping: any): number => {
  if (!mapping) {
    return -1;
  }

  const approved = Boolean(mapping.isApproved ?? mapping.is_approved);
  const synced = Boolean(mapping.mraSynced ?? mapping.mra_synced);

  if (approved && synced) {
    return 3;
  }
  if (approved) {
    return 2;
  }
  if (synced) {
    return 1;
  }
  return 0;
};

const choosePreferredMapping = (current: any, candidate: any): any => {
  if (!current) {
    return candidate;
  }

  const currentRank = mappingReadinessRank(current);
  const candidateRank = mappingReadinessRank(candidate);
  if (candidateRank > currentRank) {
    return candidate;
  }
  if (candidateRank < currentRank) {
    return current;
  }

  const currentUpdatedAt = new Date(
    current.updatedAt ??
      current.updated_at ??
      current.lastSyncedAt ??
      current.last_synced_at ??
      current.createdAt ??
      current.created_at ??
      0
  ).getTime();
  const candidateUpdatedAt = new Date(
    candidate.updatedAt ??
      candidate.updated_at ??
      candidate.lastSyncedAt ??
      candidate.last_synced_at ??
      candidate.createdAt ??
      candidate.created_at ??
      0
  ).getTime();

  return candidateUpdatedAt >= currentUpdatedAt ? candidate : current;
};

const pickPreferredMapping = (mappings: any[]): any => {
  let preferred: any = undefined;
  for (const mapping of mappings) {
    preferred = choosePreferredMapping(preferred, mapping);
  }
  return preferred;
};

const filterMappingsForBranch = (mappings: any[], branchId: string): any[] => {
  const normalizedBranchId = normalizeBranchId(branchId);
  const shouldScopeByBranch =
    Boolean(normalizedBranchId) &&
    !['main', 'main-branch', 'main_branch'].includes(normalizedBranchId.toLowerCase());

  return mappings.filter((mapping) => {
    const mappingBranchId = resolveMappingBranchId(mapping);
    if (!mappingBranchId) {
      return true;
    }
    if (!shouldScopeByBranch) {
      return true;
    }
    return mappingBranchId === normalizedBranchId;
  });
};

const buildMappingLookup = (mappings: any[]): Map<string, any> => {
  const lookup = new Map<string, any>();

  for (const mapping of mappings) {
    const inventoryItemId = resolveMappingInventoryItemId(mapping);
    if (!inventoryItemId) {
      continue;
    }

    lookup.set(inventoryItemId, choosePreferredMapping(lookup.get(inventoryItemId), mapping));
  }

  return lookup;
};

const toCacheMetaKey = (branchId: string): string => `${CACHE_META_PREFIX}:${normalizeBranchId(branchId) || String(branchId)}`;

const readCacheMeta = (branchId: string): CacheMeta | null => {
  const raw = safeLocalStorageGetItem(toCacheMetaKey(branchId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as CacheMeta;
  } catch (error) {
    console.warn('[MRA Cache] Failed to parse cache metadata:', error);
    return null;
  }
};

export const recordMraMappingCacheRefresh = (
  branchId: string,
  details?: { inventoryItemCount?: number; missingItemCount?: number }
): void => {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) {
    return;
  }

  safeLocalStorageSetItem(
    toCacheMetaKey(normalizedBranchId),
    JSON.stringify({
      refreshedAt: new Date().toISOString(),
      branchId: normalizedBranchId,
      inventoryItemCount: Number(details?.inventoryItemCount ?? 0),
      missingItemCount: Number(details?.missingItemCount ?? 0),
    } satisfies CacheMeta)
  );
};

const persistMappings = async (rawMappings: any[], fallbackBranchId: string): Promise<number> => {
  const nowIso = new Date().toISOString();
  const records = rawMappings
    .map((rawMapping) => {
      const inventoryItemId = resolveMappingInventoryItemId(rawMapping);
      if (!inventoryItemId) {
        return null;
      }

      const rawTaxType = rawMapping.mra_tax_type ?? rawMapping.mraTaxType;
      const taxType = rawTaxType === 'zero' || rawTaxType === 'exempt' ? rawTaxType : 'standard';

      return {
        id: String(rawMapping.id || `${inventoryItemId}-mapping`),
        inventoryItemId,
        branchId: resolveMappingBranchId(rawMapping) || fallbackBranchId || undefined,
        mraProductCode: rawMapping.mra_product_code || rawMapping.mraProductCode || '',
        mraProductName: rawMapping.mra_product_name || rawMapping.mraProductName || '',
        mraTaxType: taxType,
        mraTaxRate: Number(rawMapping.mra_tax_rate ?? rawMapping.mraTaxRate ?? 0),
        mraUnitMeasure: rawMapping.mra_unit_measure || rawMapping.mraUnitMeasure || '',
        taxCalculationMethod: normalizeTaxCalculationMethod(
          rawMapping.tax_calculation_method ??
            rawMapping.taxCalculationMethod ??
            rawMapping.calculation_method ??
            rawMapping.calculationMethod
        ),
        isApproved: Boolean(rawMapping.is_approved ?? rawMapping.isApproved),
        approvedAt: rawMapping.approved_at || rawMapping.approvedAt || undefined,
        mraSynced: Boolean(rawMapping.mra_synced ?? rawMapping.mraSynced),
        lastSyncedAt: rawMapping.last_synced_at || rawMapping.lastSyncedAt || undefined,
        createdAt: rawMapping.created_at || rawMapping.createdAt || nowIso,
        updatedAt: nowIso,
        _dirty: false,
        _synced_at: nowIso,
      };
    })
    .filter(Boolean);

  if (records.length === 0) {
    return 0;
  }

  await db.mraMappings.bulkPut(records as any[]);
  return records.length;
};

const getMissingInventoryItemIds = async (branchId: string, inventoryItemIds: string[]): Promise<string[]> => {
  const localMappings = await db.mraMappings.toArray();
  const mappingByItemId = buildMappingLookup(filterMappingsForBranch(localMappings, branchId));

  return inventoryItemIds.filter((inventoryItemId) => !mappingByItemId.has(inventoryItemId));
};

const fetchPreferredMappingForItem = async (
  inventoryItemId: string,
  backendBranchId: string
): Promise<any | null> => {
  let mappings: any[] = [];

  if (backendBranchId) {
    const scopedResponse = await authFetch.fetch<any>(
      `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(inventoryItemId)}&branch_id=${encodeURIComponent(backendBranchId)}`
    );
    mappings = extractMappingsFromResponse(scopedResponse);
  }

  let preferred = pickPreferredMapping(mappings);
  if (preferred) {
    return preferred;
  }

  const fallbackResponse = await authFetch.fetch<any>(
    `/inventory/mra-mappings/?inventory_item=${encodeURIComponent(inventoryItemId)}`
  );
  const fallbackMappings = extractMappingsFromResponse(fallbackResponse);

  preferred = pickPreferredMapping([...mappings, ...fallbackMappings]);
  return preferred || null;
};

export const warmBranchMraMappingCache = async ({
  branchId,
  inventoryItemIds = [],
  force = false,
  logPrefix = '[MRA Cache]',
}: WarmMraMappingsOptions): Promise<WarmMraMappingsResult> => {
  const normalizedBranchId = normalizeBranchId(branchId);
  const uniqueInventoryItemIds = Array.from(
    new Set(
      inventoryItemIds
        .map((inventoryItemId) => String(inventoryItemId || '').trim())
        .filter((inventoryItemId) => inventoryItemId.length > 0)
    )
  );

  if (!normalizedBranchId || uniqueInventoryItemIds.length === 0) {
    return {
      attempted: false,
      refreshed: false,
      missingInventoryItemIds: [],
      branchMappingsFetched: 0,
      perItemMappingsFetched: 0,
    };
  }

  if (typeof navigator === 'undefined' || !navigator.onLine) {
    return {
      attempted: false,
      refreshed: false,
      missingInventoryItemIds: await getMissingInventoryItemIds(normalizedBranchId, uniqueInventoryItemIds),
      branchMappingsFetched: 0,
      perItemMappingsFetched: 0,
    };
  }

  const cacheMeta = readCacheMeta(normalizedBranchId);
  if (!force && cacheMeta?.refreshedAt) {
    const ageMs = Date.now() - Date.parse(cacheMeta.refreshedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CACHE_TTL_MS) {
      const missingInventoryItemIds = await getMissingInventoryItemIds(normalizedBranchId, uniqueInventoryItemIds);
      if (missingInventoryItemIds.length === 0) {
        console.log(`${logPrefix} MRA cache already warm for branch ${normalizedBranchId}`);
        return {
          attempted: false,
          refreshed: false,
          missingInventoryItemIds,
          branchMappingsFetched: 0,
          perItemMappingsFetched: 0,
        };
      }
    }
  }

  let branchMappingsFetched = 0;
  let perItemMappingsFetched = 0;

  try {
    const branchMappings = await fetchPaginatedResults<any>(
      `/inventory/mra-mappings/?branch_id=${encodeURIComponent(normalizedBranchId)}`
    );

    branchMappingsFetched = await persistMappings(branchMappings, normalizedBranchId);

    let missingInventoryItemIds = await getMissingInventoryItemIds(normalizedBranchId, uniqueInventoryItemIds);

    if (missingInventoryItemIds.length > 0) {
      for (let index = 0; index < missingInventoryItemIds.length; index += PER_ITEM_BATCH_SIZE) {
        const batch = missingInventoryItemIds.slice(index, index + PER_ITEM_BATCH_SIZE);
        const preferredMappings = await Promise.all(
          batch.map(async (inventoryItemId) => {
            try {
              return await fetchPreferredMappingForItem(inventoryItemId, normalizedBranchId);
            } catch (error) {
              console.warn(`${logPrefix} Failed to warm mapping for item ${inventoryItemId}:`, error);
              return null;
            }
          })
        );

        const batchMappings = preferredMappings.filter(Boolean);
        perItemMappingsFetched += await persistMappings(batchMappings, normalizedBranchId);
      }

      missingInventoryItemIds = await getMissingInventoryItemIds(normalizedBranchId, uniqueInventoryItemIds);
      recordMraMappingCacheRefresh(normalizedBranchId, {
        inventoryItemCount: uniqueInventoryItemIds.length,
        missingItemCount: missingInventoryItemIds.length,
      });

      console.log(
        `${logPrefix} Warmed MRA cache for branch ${normalizedBranchId}: ` +
          `${branchMappingsFetched} bulk mappings, ${perItemMappingsFetched} per-item mappings, ` +
          `${missingInventoryItemIds.length} products still missing`
      );

      return {
        attempted: true,
        refreshed: true,
        missingInventoryItemIds,
        branchMappingsFetched,
        perItemMappingsFetched,
      };
    }

    recordMraMappingCacheRefresh(normalizedBranchId, {
      inventoryItemCount: uniqueInventoryItemIds.length,
      missingItemCount: 0,
    });

    console.log(
      `${logPrefix} Warmed MRA cache for branch ${normalizedBranchId}: ` +
        `${branchMappingsFetched} bulk mappings, 0 products missing`
    );

    return {
      attempted: true,
      refreshed: true,
      missingInventoryItemIds: [],
      branchMappingsFetched,
      perItemMappingsFetched,
    };
  } catch (error) {
    console.warn(`${logPrefix} Failed warming MRA cache for branch ${normalizedBranchId}:`, error);
    return {
      attempted: true,
      refreshed: false,
      missingInventoryItemIds: await getMissingInventoryItemIds(normalizedBranchId, uniqueInventoryItemIds),
      branchMappingsFetched,
      perItemMappingsFetched,
    };
  }
};
