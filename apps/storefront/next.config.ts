import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lint runs via `pnpm lint` (repo eslint.config.mjs + token check), not during build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@storeforge/shared', '@storeforge/ui'],
  // No next/image in the apps (product photos are plain <img> with a branded fallback), so the
  // Image Optimization API is switched off and no remote hosts are allowed through it.
  images: { unoptimized: true, remotePatterns: [], domains: [] },
};

export default nextConfig;
