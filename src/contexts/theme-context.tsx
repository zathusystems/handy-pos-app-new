'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type FontFamily = 'inter' | 'system' | 'georgia';

export interface ThemeSettings {
  theme: Theme;
  fontSize: FontSize;
  fontFamily: FontFamily;
  primaryColor: string;
  accentColor: string;
}

const MOBILE_BREAKPOINT = 768;

const BASE_SETTINGS: Omit<ThemeSettings, 'fontSize'> = {
  theme: 'system',
  fontFamily: 'inter',
  primaryColor: '263 88% 57%',
  accentColor: '236 100% 64%',
};

function getDefaultSettings(): ThemeSettings {
  const isMobileViewport =
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT;

  return {
    ...BASE_SETTINGS,
    fontSize: isMobileViewport ? 'large' : 'small',
  };
}

interface ThemeContextType {
  settings: ThemeSettings;
  updateTheme: (theme: Theme) => void;
  updateFontSize: (size: FontSize) => void;
  updateFontFamily: (family: FontFamily) => void;
  updatePrimaryColor: (color: string) => void;
  updateAccentColor: (color: string) => void;
  resetSettings: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<ThemeSettings>(getDefaultSettings);
  const [mounted, setMounted] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    const defaultSettings = getDefaultSettings();
    const stored = localStorage.getItem('theme-settings');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setSettings({
          ...defaultSettings,
          ...parsed,
        });
      } catch (e) {
        console.error('Failed to parse theme settings:', e);
        setSettings(defaultSettings);
      }
    } else {
      setSettings(defaultSettings);
    }
    setMounted(true);
  }, []);

  // Apply theme to document
  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    
    // Apply theme class
    if (settings.theme === 'dark') {
      root.classList.add('dark');
    } else if (settings.theme === 'light') {
      root.classList.remove('dark');
    } else {
      // System preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }

    // Apply font size
    const fontSizeMap = {
      small: '14px',
      medium: '15px',
      large: '16px',
    };
    root.style.fontSize = fontSizeMap[settings.fontSize];

    // Apply font family
    const fontFamilyMap = {
      inter: '"Inter", sans-serif',
      system: 'system-ui, -apple-system, sans-serif',
      georgia: '"Georgia", serif',
    };
    root.style.fontFamily = fontFamilyMap[settings.fontFamily];

    // Apply colors
    root.style.setProperty('--primary', settings.primaryColor);
    root.style.setProperty('--accent', settings.accentColor);

    // Save to localStorage
    localStorage.setItem('theme-settings', JSON.stringify(settings));
  }, [settings, mounted]);

  const updateTheme = (theme: Theme) => {
    setSettings(prev => ({ ...prev, theme }));
  };

  const updateFontSize = (size: FontSize) => {
    setSettings(prev => ({ ...prev, fontSize: size }));
  };

  const updateFontFamily = (family: FontFamily) => {
    setSettings(prev => ({ ...prev, fontFamily: family }));
  };

  const updatePrimaryColor = (color: string) => {
    setSettings(prev => ({ ...prev, primaryColor: color }));
  };

  const updateAccentColor = (color: string) => {
    setSettings(prev => ({ ...prev, accentColor: color }));
  };

  const resetSettings = () => {
    setSettings(getDefaultSettings());
  };

  return (
    <ThemeContext.Provider
      value={{
        settings,
        updateTheme,
        updateFontSize,
        updateFontFamily,
        updatePrimaryColor,
        updateAccentColor,
        resetSettings,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
