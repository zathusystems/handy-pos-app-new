/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';

const nextConfig = {
  // ✅ Output to 'out' directory for production Tauri build, use .next-dev for dev
  distDir: isDev ? '.next-dev' : 'out',

  // ✅ Enable static export for Tauri desktop app
  output: 'export',
  
  // ✅ Disable image optimization for desktop
  images: {
    unoptimized: true,
  },
  
  // ✅ Add trailing slashes for better routing
  trailingSlash: true,
  
  // ✅ Disable Strict Mode to prevent double state updates in development
  reactStrictMode: false,
  
  // ✅ TypeScript - ignore errors for now (focus on Tauri build)
  typescript: {
    ignoreBuildErrors: true,
  },
  
  // ✅ ESLint - ignore during build
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Disable webpack filesystem cache in dev to avoid stale cache crashes.
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = false;
    }
    return config;
  },
};

module.exports = nextConfig;
