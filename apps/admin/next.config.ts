import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lint runs via `pnpm lint` (repo eslint.config.mjs + token check), not during build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@storeforge/shared', '@storeforge/ui'],
  // No next/image in the apps (product photos are plain <img> with a branded fallback), so the
  // Image Optimization API is switched off and no remote hosts are allowed through it.
  images: { unoptimized: true, remotePatterns: [], domains: [] },
  async redirects() {
    return [
      { source: '/signin', destination: '/login', permanent: false },
      // Phase 0 URLs → renamed sections (slice 1)
      { source: '/dashboard', destination: '/launchpad', permanent: false },
      { source: '/dashboard/catalog', destination: '/shelf', permanent: false },
      { source: '/dashboard/orders', destination: '/dispatch', permanent: false },
      { source: '/dashboard/stores', destination: '/stores', permanent: false },
      { source: '/dashboard/billing', destination: '/billing', permanent: false },
    ];
  },
};

export default nextConfig;
