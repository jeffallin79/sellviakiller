import type { NextConfig } from 'next';

// The shop's browser code calls the API same-origin (/api/...), proxied here. That works on every
// host a shop is served from (platform subdomains, merchant custom domains) with no CORS, and only
// the public storefront endpoints are exposed through merchant domains.
const API = (process.env.STOREFRONT_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/storefront/:path*', destination: `${API}/api/storefront/:path*` },
      { source: '/api/stores/by-slug/:slug', destination: `${API}/api/stores/by-slug/:slug` },
      { source: '/api/checkout', destination: `${API}/api/checkout` },
    ];
  },
  // Lint runs via `pnpm lint` (repo eslint.config.mjs + token check), not during build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@storeforge/shared', '@storeforge/ui'],
  // No next/image in the apps (product photos are plain <img> with a branded fallback), so the
  // Image Optimization API is switched off and no remote hosts are allowed through it.
  images: { unoptimized: true, remotePatterns: [], domains: [] },
};

export default nextConfig;
