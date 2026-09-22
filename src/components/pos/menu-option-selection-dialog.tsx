'use client';

import { useEffect, useMemo, useState } from 'react';

import type { InventoryItem } from '@/lib/db';
import { useCurrency } from '@/hooks/use-currency';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type MenuOption = {
  id: string | number;
  name: string;
  description?: string;
  price_mode?: 'delta' | 'override' | string;
  price_delta?: number | string;
  price_override?: number | string | null;
  recipe?: Array<Record<string, unknown>>;
  linked_inventory_item?: string | number | null;
  linked_inventory_item_name?: string;
  linked_inventory_quantity?: number | string;
  is_default?: boolean;
  is_visible?: boolean;
};

export type MenuOptionGroup = {
  id: string | number;
  name: string;
  group_type?: 'option' | 'side' | 'addon' | string;
  is_required?: boolean;
  min_select?: number | string;
  max_select?: number | string;
  options: MenuOption[];
};

type InventoryItemWithOptions = InventoryItem & {
  optionGroups?: MenuOptionGroup[];
  option_groups?: MenuOptionGroup[];
};

type MenuOptionSelectionDialogProps = {
  item: InventoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    item: InventoryItem,
    selectedOptions: Array<Record<string, unknown>>,
    configuredPrice: number
  ) => boolean | void | Promise<boolean | void>;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getSelectionLimit = (group: MenuOptionGroup): number => {
  return Math.max(1, Math.floor(toFiniteNumber(group.max_select, 1)) || 1);
};

const getMinimumSelection = (group: MenuOptionGroup): number => {
  const configuredMinimum = Math.max(0, Math.floor(toFiniteNumber(group.min_select, 0)) || 0);
  return group.is_required ? Math.max(1, configuredMinimum) : configuredMinimum;
};

export const getMenuOptionGroups = (item: InventoryItem | null | undefined): MenuOptionGroup[] => {
  const candidate = (item as InventoryItemWithOptions | null | undefined)?.optionGroups
    ?? (item as InventoryItemWithOptions | null | undefined)?.option_groups;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((group) => (
    group
    && Array.isArray(group.options)
    && group.options.some((option) => option?.is_visible !== false)
  ));
};

const getDefaultOptionIds = (item: InventoryItem): Record<string, string[]> => {
  return getMenuOptionGroups(item).reduce<Record<string, string[]>>((selected, group) => {
    const defaultIds = group.options
      .filter((option) => option.is_visible !== false && option.is_default)
      .slice(0, getSelectionLimit(group))
      .map((option) => String(option.id));

    if (defaultIds.length > 0) {
      selected[String(group.id)] = defaultIds;
    }
    return selected;
  }, {});
};

export const buildSelectedOptionSnapshots = (
  item: InventoryItem,
  selectedOptionIds: Record<string, string[]>
): Array<Record<string, unknown>> => {
  return getMenuOptionGroups(item).flatMap((group) => {
    const selectedIds = new Set(selectedOptionIds[String(group.id)] || []);
    return group.options
      .filter((option) => option.is_visible !== false && selectedIds.has(String(option.id)))
      .map((option) => ({
        id: String(option.id),
        group_id: String(group.id),
        group_name: group.name,
        group_type: group.group_type || 'option',
        name: option.name,
        description: option.description || '',
        quantity: 1,
        price_mode: option.price_mode || 'delta',
        price_delta: toFiniteNumber(option.price_delta),
        price_override: option.price_override === null || option.price_override === undefined || option.price_override === ''
          ? null
          : toFiniteNumber(option.price_override),
        recipe: Array.isArray(option.recipe) ? option.recipe : [],
        linked_inventory_item: option.linked_inventory_item ?? null,
        linked_inventory_item_name: option.linked_inventory_item_name || '',
        linked_inventory_quantity: toFiniteNumber(option.linked_inventory_quantity, 1),
      }));
  });
};

export const getConfiguredMenuPrice = (
  item: InventoryItem,
  selectedOptions: Array<Record<string, unknown>>
): number => {
  return selectedOptions.reduce((configuredPrice, option) => {
    const priceMode = String(option.price_mode ?? option.priceMode ?? 'delta').toLowerCase();
    const override = toFiniteNumber(option.price_override ?? option.priceOverride, Number.NaN);
    if (priceMode === 'override' && Number.isFinite(override)) {
      return Math.max(0, override);
    }
    return configuredPrice + toFiniteNumber(option.price_delta ?? option.priceDelta);
  }, Math.max(0, toFiniteNumber(item.price)));
};

export function MenuOptionSelectionDialog({
  item,
  open,
  onOpenChange,
  onConfirm,
}: MenuOptionSelectionDialogProps) {
  const [selectedOptionIds, setSelectedOptionIds] = useState<Record<string, string[]>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const { format: formatCurrency } = useCurrency();

  useEffect(() => {
    if (open && item) {
      setSelectedOptionIds(getDefaultOptionIds(item));
      setValidationMessage('');
      setIsSubmitting(false);
      return;
    }

    if (!open) {
      setSelectedOptionIds({});
      setValidationMessage('');
      setIsSubmitting(false);
    }
  }, [item?.id, open]);

  const selectedOptions = useMemo(
    () => item ? buildSelectedOptionSnapshots(item, selectedOptionIds) : [],
    [item, selectedOptionIds]
  );
  const configuredPrice = useMemo(
    () => item ? getConfiguredMenuPrice(item, selectedOptions) : 0,
    [item, selectedOptions]
  );

  const handleOptionToggle = (group: MenuOptionGroup, optionId: string, checked: boolean) => {
    const groupId = String(group.id);
    const maxSelect = getSelectionLimit(group);
    setSelectedOptionIds((current) => {
      const selected = current[groupId] || [];
      if (maxSelect === 1) {
        return { ...current, [groupId]: checked ? [optionId] : [] };
      }
      if (!checked) {
        return { ...current, [groupId]: selected.filter((id) => id !== optionId) };
      }
      if (selected.includes(optionId) || selected.length >= maxSelect) {
        return current;
      }
      return { ...current, [groupId]: [...selected, optionId] };
    });
  };

  const handleConfirm = async () => {
    if (!item || isSubmitting) {
      return;
    }

    const invalidGroup = getMenuOptionGroups(item).find((group) => {
      const selectedCount = (selectedOptionIds[String(group.id)] || []).length;
      return selectedCount < getMinimumSelection(group) || selectedCount > getSelectionLimit(group);
    });
    if (invalidGroup) {
      const minimum = getMinimumSelection(invalidGroup);
      setValidationMessage(
        minimum > 0
          ? `${invalidGroup.name}: choose at least ${minimum} option${minimum === 1 ? '' : 's'}.`
          : `${invalidGroup.name}: choose up to ${getSelectionLimit(invalidGroup)} option${getSelectionLimit(invalidGroup) === 1 ? '' : 's'}.`
      );
      return;
    }

    setValidationMessage('');
    setIsSubmitting(true);
    try {
      const added = await onConfirm(item, selectedOptions, configuredPrice);
      if (added !== false) {
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose options{item ? ` for ${item.name}` : ''}</DialogTitle>
          <DialogDescription>
            Select the choices to include with this item. Any linked option stock is deducted when the sale is completed.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="space-y-4 py-2">
            {getMenuOptionGroups(item).map((group) => {
              const groupId = String(group.id);
              const selectedIds = selectedOptionIds[groupId] || [];
              const maxSelect = getSelectionLimit(group);
              const minimum = getMinimumSelection(group);
              const rule = minimum > 0
                ? `Required${maxSelect > minimum ? ` · choose ${minimum}-${maxSelect}` : ` · choose ${minimum}`}`
                : maxSelect > 1
                  ? `Optional · choose up to ${maxSelect}`
                  : 'Optional';

              return (
                <section key={groupId} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{group.name}</p>
                      <p className="text-xs text-muted-foreground">{rule}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{selectedIds.length}/{maxSelect}</span>
                  </div>
                  <div className="space-y-2">
                    {group.options
                      .filter((option) => option.is_visible !== false)
                      .map((option) => {
                        const optionId = String(option.id);
                        const checked = selectedIds.includes(optionId);
                        const optionDelta = toFiniteNumber(option.price_delta);
                        const optionOverride = toFiniteNumber(option.price_override, Number.NaN);
                        const optionPrice = String(option.price_mode || '').toLowerCase() === 'override' && Number.isFinite(optionOverride)
                          ? `Set to ${formatCurrency(optionOverride)}`
                          : optionDelta === 0
                            ? 'Included'
                            : `${optionDelta > 0 ? '+' : ''}${formatCurrency(optionDelta)}`;

                        return (
                          <label
                            key={optionId}
                            htmlFor={`pos-option-${groupId}-${optionId}`}
                            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
                          >
                            <input
                              id={`pos-option-${groupId}-${optionId}`}
                              type={maxSelect === 1 ? 'radio' : 'checkbox'}
                              name={`pos-option-group-${groupId}`}
                              checked={checked}
                              onChange={(event) => handleOptionToggle(group, optionId, event.target.checked)}
                              className="mt-1 h-4 w-4 accent-primary"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start justify-between gap-3 text-sm font-medium">
                                <span>{option.name}</span>
                                <span className="shrink-0 text-muted-foreground">{optionPrice}</span>
                              </span>
                              {option.description && (
                                <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                </section>
              );
            })}

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
              <span className="text-sm text-muted-foreground">Price after choices</span>
              <span className="font-semibold">{formatCurrency(configuredPrice)}</span>
            </div>
            {validationMessage && <p className="text-sm text-destructive">{validationMessage}</p>}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={isSubmitting} onClick={handleConfirm}>
            {isSubmitting ? 'Adding...' : 'Add to cart'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
