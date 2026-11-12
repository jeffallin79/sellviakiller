import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lint runs via `pnpm lint` (repo eslint.config.mjs + token check), not during build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@storeforge/shared', '@storeforge/ui'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'picsum.photos' }],
  },
};

export default nextConfig;
