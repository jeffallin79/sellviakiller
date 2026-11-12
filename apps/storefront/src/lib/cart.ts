'use client';

import { useCallback, useEffect, useState } from 'react';

export type Cart = Record<string, number>;
const key = (slug: string) => `sf-cart:${slug}`;
export const FREE_SHIPPING_CENTS = 5000;
export const SHIPPING_CENTS = 499;
export const shippingFor = (subtotal: number) => (subtotal >= FREE_SHIPPING_CENTS || subtotal === 0 ? 0 : SHIPPING_CENTS);

/** Per-store cart kept in localStorage, synced across tabs/pages. */
export function useCart(slug: string) {
  const [cart, setCart] = useState<Cart>({});
  useEffect(() => {
    const read = () => { try { setCart(JSON.parse(localStorage.getItem(key(slug)) ?? '{}')); } catch { setCart({}); } };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === key(slug)) read(); };
    const onLocal = () => read();
    window.addEventListener('storage', onStorage);
    window.addEventListener('sf-cart', onLocal);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('sf-cart', onLocal); };
  }, [slug]);
  const write = useCallback((next: Cart) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, q]) => q > 0));
    localStorage.setItem(key(slug), JSON.stringify(clean));
    setCart(clean);
    window.dispatchEvent(new Event('sf-cart'));
  }, [slug]);
  return {
    cart,
    count: Object.values(cart).reduce((a, b) => a + b, 0),
    add: (id: string, n = 1) => write({ ...cart, [id]: Math.min(99, (cart[id] ?? 0) + n) }),
    set: (id: string, n: number) => write({ ...cart, [id]: Math.max(0, Math.min(99, n)) }),
    clear: () => write({}),
  };
}
