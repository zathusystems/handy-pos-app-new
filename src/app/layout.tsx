import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider } from '@/hooks/use-auth';
import { ThemeProvider } from '@/contexts/theme-context';
import { TauriReadySignal } from '@/components/tauri-ready-signal';
import { AndroidModalBackGuard } from '@/components/android-modal-back-guard';
import { TauriDeepLinkListener } from '@/components/tauri-deep-link-listener';

export const metadata: Metadata = {
  title: 'Handy POS - POS and Inventory System',
  description: 'Modern POS and Inventory Management System for Handy POS with offline-first capabilities.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon' },
      { url: '/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { url: '/app-icon.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/app-icon.png', sizes: '512x512', type: 'image/png' }],
    shortcut: ['/favicon.ico'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#0066FF" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html[data-tauri-android='true']:not([data-tauri-app-ready='true']) body {
                opacity: 0 !important;
                background: #1f4fd7 !important;
              }
            `,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                var ua = navigator.userAgent || '';
                var isAndroid = /android/i.test(ua);
                var isTauri = /tauri|wry/i.test(ua) || !!window.__TAURI__ || !!window.__TAURI_INTERNALS__;
                if (!isAndroid || !isTauri) return;
                var root = document.documentElement;
                root.setAttribute('data-tauri-android', 'true');
                setTimeout(function () {
                  if (!root.hasAttribute('data-tauri-app-ready')) {
                    root.setAttribute('data-tauri-app-ready', 'true');
                  }
                }, 5000);
              })();
            `,
          }}
        />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider>
          <AuthProvider>
            {children}
            <Toaster />
            <TauriReadySignal />
            <TauriDeepLinkListener />
            <AndroidModalBackGuard />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
