'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { shopHref } from './host-routing';

/** '' when the shop is served from its own host (subdomain/custom), '/s/<slug>' in path mode. */
const BaseCtx = createContext<string | null>(null);
export function ShopBaseProvider({ base, children }: { base: string | null; children: ReactNode }) {
  return <BaseCtx.Provider value={base}>{children}</BaseCtx.Provider>;
}
/** Link builder for shop pages. Falls back to path mode when no host info is available. */
export function useShopHref(slug: string) {
  const base = useContext(BaseCtx);
  const b = base ?? `/s/${slug}`;
  return (path = '/') => shopHref(b, path);
}
