'use client';

export const withBusinessQuery = (
  path: string,
  businessId?: string | number | null
): string => {
  const normalizedPath = String(path || '');
  const normalizedBusinessId = String(businessId ?? '').trim();

  if (!normalizedBusinessId) {
    return normalizedPath;
  }

  const separator = normalizedPath.includes('?') ? '&' : '?';
  return `${normalizedPath}${separator}business=${encodeURIComponent(normalizedBusinessId)}`;
};

export const withBusinessPayload = <T extends Record<string, unknown>>(
  payload: T,
  businessId?: string | number | null
): T & { business?: string } => {
  const normalizedBusinessId = String(businessId ?? '').trim();

  if (!normalizedBusinessId) {
    return payload;
  }

  return {
    ...payload,
    business: normalizedBusinessId,
  };
};
