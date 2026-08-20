
'use client';

import { useState, useEffect } from 'react';
import { getOfflineBusinessProfile, resolveOfflineBusinessId } from '@/lib/business-profile';

const LOCAL_STORAGE_KEYS = {
    BUSINESS_SETTINGS: 'handypos-business-settings',
};

const normalizeBusinessId = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed;
  }
  return '';
};

const normalizeCurrencyCode = (value: unknown): string => {
  return String(value ?? '').trim().toUpperCase();
};

export const useCurrency = () => {
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [formatter, setFormatter] = useState(() => new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
  }));

  useEffect(() => {
    let cancelled = false;

    const fetchSettings = async () => {
      const activeBusinessId = normalizeBusinessId(resolveOfflineBusinessId());

      // First, try cached business settings only when they belong to current business context.
      const storedSettings = localStorage.getItem(LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS);
      if (storedSettings) {
        try {
          const settings = JSON.parse(storedSettings);
          const settingsCurrency = normalizeCurrencyCode(settings?.currency);
          const settingsBusinessId = normalizeBusinessId(settings?.businessId);
          const isScopedToCurrentBusiness =
            Boolean(settingsBusinessId) &&
            (!activeBusinessId || settingsBusinessId === activeBusinessId);

          if (settingsCurrency && isScopedToCurrentBusiness) {
            if (!cancelled) {
              setCurrencyCode(settingsCurrency);
            }
            return;
          }
        } catch (e) {
          console.error("Failed to parse business settings from localStorage", e);
        }
      }
      
      // Fallback to offline business profile (business-bound Dexie data).
      const business = await getOfflineBusinessProfile();
      const businessCurrency = normalizeCurrencyCode(business?.currency);
      if (businessCurrency) {
        if (!cancelled) {
          setCurrencyCode(businessCurrency);
        }
      }
    };
    
    fetchSettings();

    const handleCurrencyContextChange = () => {
      void fetchSettings();
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (!event.key) return;
      if (
        event.key === LOCAL_STORAGE_KEYS.BUSINESS_SETTINGS ||
        event.key === 'handypos-business-id' ||
        event.key === 'handy-pos-business' ||
        event.key === 'handy-pos-user'
      ) {
        void fetchSettings();
      }
    };

    window.addEventListener('branchChanged', handleCurrencyContextChange as EventListener);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      cancelled = true;
      window.removeEventListener('branchChanged', handleCurrencyContextChange as EventListener);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    try {
        setFormatter(() => new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: currencyCode,
        }));
    } catch (e) {
        console.error(`Invalid currency code: ${currencyCode}. Falling back to USD.`, e);
        setCurrencyCode('USD');
        setFormatter(() => new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'USD',
        }));
    }
  }, [currencyCode]);

  return {
    format: formatter.format,
    currencyCode,
  };
};
