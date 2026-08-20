'use client';

import React, { useState } from 'react';
import { useTheme, type Theme, type FontSize, type FontFamily } from '@/contexts/theme-context';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Palette, Type, RotateCcw } from 'lucide-react';

const PRESET_COLORS = [
  { name: 'Purple', value: '263 88% 57%' },
  { name: 'Blue', value: '217 91% 60%' },
  { name: 'Green', value: '142 71% 45%' },
  { name: 'Red', value: '0 84% 60%' },
  { name: 'Orange', value: '25 95% 53%' },
  { name: 'Pink', value: '330 81% 60%' },
  { name: 'Indigo', value: '262 80% 50%' },
  { name: 'Teal', value: '180 60% 45%' },
];

export function ThemeCustomizer() {
  const { settings, updateTheme, updateFontSize, updateFontFamily, updatePrimaryColor, updateAccentColor, resetSettings } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="tauri-android-floating-bottom gap-2 fixed bottom-6 right-6 z-40 shadow-lg hover:shadow-xl transition-shadow"
        >
          <Palette className="w-4 h-4" />
          Customize
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="tauri-android-sidebar-safe-top w-full sm:w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Customize Theme & Font</SheetTitle>
          <SheetDescription>
            Personalize your app experience with custom themes and fonts
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          <Tabs defaultValue="theme" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="theme">Theme</TabsTrigger>
              <TabsTrigger value="font">Font</TabsTrigger>
              <TabsTrigger value="colors">Colors</TabsTrigger>
            </TabsList>

            {/* Theme Tab */}
            <TabsContent value="theme" className="space-y-4 mt-4">
              <div className="space-y-3">
                <Label>Appearance</Label>
                <Select value={settings.theme} onValueChange={(value) => updateTheme(value as Theme)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {settings.theme === 'system'
                    ? 'Follows your system preferences'
                    : `Currently set to ${settings.theme} mode`}
                </p>
              </div>
            </TabsContent>

            {/* Font Tab */}
            <TabsContent value="font" className="space-y-6 mt-4">
              <div className="space-y-3">
                <Label className="flex items-center gap-2">
                  <Type className="w-4 h-4" />
                  Font Size
                </Label>
                <Select value={settings.fontSize} onValueChange={(value) => updateFontSize(value as FontSize)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small (14px)</SelectItem>
                    <SelectItem value="medium">Medium (15px)</SelectItem>
                    <SelectItem value="large">Large (16px)</SelectItem>
                  </SelectContent>
                </Select>
                <div className="p-3 bg-muted rounded-md">
                  <p className="text-sm">Preview: The quick brown fox jumps over the lazy dog</p>
                </div>
              </div>

              <div className="space-y-3">
                <Label>Font Family</Label>
                <Select value={settings.fontFamily} onValueChange={(value) => updateFontFamily(value as FontFamily)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inter">Inter (Modern)</SelectItem>
                    <SelectItem value="system">System (Native)</SelectItem>
                    <SelectItem value="georgia">Georgia (Classic)</SelectItem>
                  </SelectContent>
                </Select>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Preview:</p>
                  <div className="space-y-1">
                    <p style={{ fontFamily: '"Inter", sans-serif' }} className="text-sm">
                      Inter: The quick brown fox
                    </p>
                    <p style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }} className="text-sm">
                      System: The quick brown fox
                    </p>
                    <p style={{ fontFamily: '"Georgia", serif' }} className="text-sm">
                      Georgia: The quick brown fox
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Colors Tab */}
            <TabsContent value="colors" className="space-y-6 mt-4">
              <div className="space-y-3">
                <Label>Primary Color</Label>
                <div className="grid grid-cols-4 gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      onClick={() => updatePrimaryColor(color.value)}
                      className="relative p-3 rounded-lg border-2 transition-all hover:scale-105"
                      style={{
                        backgroundColor: `hsl(${color.value})`,
                        borderColor: settings.primaryColor === color.value ? '#000' : 'transparent',
                      }}
                      title={color.name}
                    >
                      {settings.primaryColor === color.value && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-2 h-2 bg-white rounded-full" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <Label>Accent Color</Label>
                <div className="grid grid-cols-4 gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      onClick={() => updateAccentColor(color.value)}
                      className="relative p-3 rounded-lg border-2 transition-all hover:scale-105"
                      style={{
                        backgroundColor: `hsl(${color.value})`,
                        borderColor: settings.accentColor === color.value ? '#000' : 'transparent',
                      }}
                      title={color.name}
                    >
                      {settings.accentColor === color.value && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-2 h-2 bg-white rounded-full" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex justify-between gap-2 pt-6 border-t mt-6">
          <Button
            variant="outline"
            onClick={() => {
              resetSettings();
              setOpen(false);
            }}
            className="gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
