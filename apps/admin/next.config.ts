import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@storeforge/shared'],
  async redirects() {
    return [
      { source: '/signin', destination: '/login', permanent: false },
    ];
  },
};

export default nextConfig;
