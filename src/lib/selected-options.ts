type SnapshotRecord = Record<string, unknown>;

const asRecord = (value: unknown): SnapshotRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as SnapshotRecord
    : null
);

export const getSelectedOptionNames = (item: unknown): string[] => {
  const itemRecord = asRecord(item);
  if (!itemRecord) return [];

  const rawOptions = itemRecord.selectedOptions ?? itemRecord.selected_options;
  if (!Array.isArray(rawOptions)) return [];

  const optionNames: string[] = [];
  rawOptions.forEach((option) => {
    const optionRecord = asRecord(option);
    const optionName = String(optionRecord?.name ?? optionRecord?.label ?? '').trim();
    if (optionName && !optionNames.includes(optionName)) {
      optionNames.push(optionName);
    }
  });

  return optionNames;
};
