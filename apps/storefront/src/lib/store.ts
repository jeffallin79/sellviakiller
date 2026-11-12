'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export type StoreProduct = {
  id: string;
  title?: string | null;
  priceCents: number;
  compareAtCents?: number | null;
  product: { title: string; imageUrl?: string | null; etaDaysMin: number; etaDaysMax: number; sourcingLabel: string; description: string; category?: string | null };
};
export const titleOf = (p: StoreProduct) => p.title ?? p.product.title;

export function useStore(slug: string) {
  const [store, setStore] = useState<any>(null);
  const [products, setProducts] = useState<StoreProduct[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/stores/by-slug/${slug}`).then(setStore).catch((e) => setError(e.message || 'Store not found'));
    api<StoreProduct[]>(`/storefront/${slug}/products`).then(setProducts).catch(() => setProducts([]));
  }, [slug]);
  return { store, products, error };
}
