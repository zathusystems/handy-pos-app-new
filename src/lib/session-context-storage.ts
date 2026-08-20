'use client';

const SESSION_CONTEXT_KEYS = [
  'handy-pos-business',
  'handypos-business',
  'handypos-business-id',
  'handypos-business-name',
  'handypos-business-settings',
  'handypos-active-branch',
  'handypos-current-branch-id',
  'handypos-branches',
] as const;

const SESSION_CONTEXT_PREFIXES = [
  'handypos-branch-',
] as const;

export function clearSessionContextStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }

  for (const key of SESSION_CONTEXT_KEYS) {
    localStorage.removeItem(key);
  }

  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (!key) {
      continue;
    }

    if (SESSION_CONTEXT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      localStorage.removeItem(key);
    }
  }
}
