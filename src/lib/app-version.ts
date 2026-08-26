import packageJson from '../../package.json';

export const FALLBACK_APP_VERSION = String(
  process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version || '1.0.0'
).trim() || '1.0.0';
