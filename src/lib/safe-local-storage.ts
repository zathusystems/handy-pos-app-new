export const safeLocalStorageGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn(`[Storage] Failed to read localStorage key "${key}":`, error);
    return null;
  }
};

export const safeLocalStorageSetItem = (key: string, value: string): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[Storage] Failed to write localStorage key "${key}":`, error);
    return false;
  }
};
