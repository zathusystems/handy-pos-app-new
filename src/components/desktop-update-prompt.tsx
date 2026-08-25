'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Download, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isTauriApp } from '@/lib/tauri-init';
import {
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  fetchDesktopReleaseManifest,
  getCurrentDesktopVersion,
  isNewerDesktopVersion,
  type DesktopReleaseManifest,
} from '@/lib/desktop-update';

const DISMISSED_VERSION_KEY = 'handypos-desktop-update-dismissed-version';

export function DesktopUpdatePrompt() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [release, setRelease] = useState<DesktopReleaseManifest | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      if (!isTauriApp()) {
        return;
      }

      setIsLoading(true);

      const [installedVersion, manifest] = await Promise.all([
        getCurrentDesktopVersion(),
        fetchDesktopReleaseManifest(),
      ]);

      if (!alive) {
        return;
      }

      const normalizedInstalled = String(installedVersion || '').trim();
      setCurrentVersion(normalizedInstalled);

      if (!manifest) {
        setIsLoading(false);
        return;
      }

      const dismissedVersion = String(
        typeof window !== 'undefined'
          ? window.localStorage.getItem(DISMISSED_VERSION_KEY) || ''
          : ''
      ).trim();

      const shouldPrompt =
        !!manifest.latestVersion &&
        isNewerDesktopVersion(normalizedInstalled, manifest.latestVersion) &&
        dismissedVersion !== manifest.latestVersion;

      setRelease(manifest);
      setIsOpen(shouldPrompt);
      setIsLoading(false);
    };

    void run();

    return () => {
      alive = false;
    };
  }, []);

  const downloadUrl = useMemo(
    () => release?.downloadUrl || DEFAULT_DESKTOP_DOWNLOAD_URL,
    [release]
  );

  const handleLater = () => {
    if (release?.latestVersion && typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISSED_VERSION_KEY, release.latestVersion);
    }
    setIsOpen(false);
  };

  const handleDownload = async () => {
    const targetUrl = downloadUrl || DEFAULT_DESKTOP_DOWNLOAD_URL;

    if (typeof window !== 'undefined') {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
      window.localStorage.setItem(DISMISSED_VERSION_KEY, release?.latestVersion || '');
    }

    setIsOpen(false);

    if (isTauriApp() && typeof window !== 'undefined') {
      window.setTimeout(() => {
        void import('@tauri-apps/api/window')
          .then(({ getCurrentWindow }) => getCurrentWindow().close())
          .catch(() => {
            try {
              window.close();
            } catch {
              // ignore close failures in restricted environments
            }
          });
      }, 150);
    }
  };

  if (!isTauriApp() || !release || !isOpen) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>New Handy POS version available</DialogTitle>
              <DialogDescription>
                Version {release.latestVersion} is ready. Your current desktop build is {currentVersion || 'unknown'}.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Download the latest desktop build to keep payments, reporting, and sync behavior in step with the current release.
          </p>
          {release.notes ? (
            <div className="rounded-lg border bg-muted/40 p-3 text-foreground">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">What changed</p>
              <p className="text-sm leading-6">{release.notes}</p>
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleLater} className="w-full sm:w-auto">
            <X className="mr-2 h-4 w-4" />
            Later
          </Button>
          <Button onClick={handleDownload} className="w-full sm:w-auto">
            <Download className="mr-2 h-4 w-4" />
            Open download page
          </Button>
        </DialogFooter>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking release info...
          </div>
        ) : null}
        <div className="text-xs text-muted-foreground">
          If the button does not open your browser, use the download page directly.
          {' '}
          <a href={downloadUrl || DEFAULT_DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
            Open download page
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
