export interface CustomSalesSectionSettings {
  enabled: boolean;
  name: string;
}

export const EMPTY_CUSTOM_SALES_SECTION_SETTINGS: CustomSalesSectionSettings = {
  enabled: false,
  name: '',
};

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  return fallback;
};

export const resolveCustomSalesSectionSettings = (
  source?: Record<string, any> | null,
  fallback: CustomSalesSectionSettings = EMPTY_CUSTOM_SALES_SECTION_SETTINGS
): CustomSalesSectionSettings => {
  const settings = source ?? {};
  const enabled = toBoolean(
    settings.enableCustomSalesSection ??
      settings.enable_custom_sales_section ??
      settings?.settings?.enableCustomSalesSection ??
      settings?.settings?.enable_custom_sales_section,
    fallback.enabled
  );

  const name = String(
    settings.customSalesSectionName ??
      settings.custom_sales_section_name ??
      settings?.settings?.customSalesSectionName ??
      settings?.settings?.custom_sales_section_name ??
      fallback.name ??
      ''
  ).trim();

  return {
    enabled: enabled && Boolean(name),
    name,
  };
};

export const readStoredCustomSalesSectionSettings = (): CustomSalesSectionSettings => {
  if (typeof window === 'undefined') {
    return EMPTY_CUSTOM_SALES_SECTION_SETTINGS;
  }

  try {
    return resolveCustomSalesSectionSettings(
      readStoredBusinessSettingsObject(),
      EMPTY_CUSTOM_SALES_SECTION_SETTINGS
    );
  } catch (error) {
    console.warn('[CustomSalesSection] Failed to read stored settings:', error);
    return EMPTY_CUSTOM_SALES_SECTION_SETTINGS;
  }
};

export const readStoredBusinessSettingsObject = (): Record<string, any> => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem('handypos-business-settings');
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};
