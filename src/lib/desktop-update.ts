import packageJson from '../../package.json';

import { isTauriApp } from '@/lib/tauri-init';

export type DesktopReleaseManifest = {
  latestVersion: string;
  downloadUrl: string;
  notes?: string;
  publishedAt?: string;
};

export const DEFAULT_DESKTOP_RELEASE_MANIFEST_URL =
  process.env.NEXT_PUBLIC_DESKTOP_RELEASES_URL?.trim() ||
  'https://handypos.online/desktop-release.json';

export const DEFAULT_DESKTOP_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL?.trim() ||
  'https://handypos.online/download';

const FALLBACK_DESKTOP_VERSION = String(packageJson.version || '1.0.0').trim() || '1.0.0';

const stripVersionDecorators = (value: string): string =>
  String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('+', 1)[0]
    .split('-', 1)[0];

const parseVersionParts = (value: string): number[] =>
  stripVersionDecorators(value)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

export const compareDesktopVersions = (left: string, right: string): number => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
};

export const isNewerDesktopVersion = (localVersion: string, remoteVersion: string): boolean =>
  compareDesktopVersions(remoteVersion, localVersion) > 0;

export const getCurrentDesktopVersion = async (): Promise<string> => {
  if (!isTauriApp()) {
    return FALLBACK_DESKTOP_VERSION;
  }

  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const runtimeVersion = String(await getVersion() || '').trim();
    return runtimeVersion || FALLBACK_DESKTOP_VERSION;
  } catch (error) {
    console.warn('[DesktopUpdate] Failed to read runtime version:', error);
    return FALLBACK_DESKTOP_VERSION;
  }
};

export const fetchDesktopReleaseManifest = async (): Promise<DesktopReleaseManifest | null> => {
  try {
    const response = await fetch(DEFAULT_DESKTOP_RELEASE_MANIFEST_URL, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const manifest = (await response.json()) as Partial<DesktopReleaseManifest>;
    const latestVersion = String(manifest.latestVersion || '').trim();
    const downloadUrl = String(manifest.downloadUrl || '').trim();

    if (!latestVersion || !downloadUrl) {
      return null;
    }

    return {
      latestVersion,
      downloadUrl,
      notes: String(manifest.notes || '').trim() || undefined,
      publishedAt: String(manifest.publishedAt || '').trim() || undefined,
    };
  } catch (error) {
    console.warn('[DesktopUpdate] Failed to fetch release manifest:', error);
    return null;
  }
};
