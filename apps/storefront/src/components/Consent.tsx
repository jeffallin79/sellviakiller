'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getConsent, loadTags, setConsent, track, type Consent, type Tag } from '@/lib/pixel';

/** Marketing-cookie banner + the store's ad tags (owned Meta Pixel, managed Boost tags), only after "Accept". */
export function ShopPixel({ storeId }: { storeId: string | null | undefined }) {
  const [consent, setC] = useState<Consent | 'loading'>('loading');
  const [pixel, setPixel] = useState<{ pixelId: string | null; stub?: boolean; tags?: Tag[] } | null>(null);
  const path = usePathname();

  useEffect(() => {
    setC(getConsent());
    const on = (e: Event) => setC((e as CustomEvent).detail);
    window.addEventListener('sf-consent', on);
    return () => window.removeEventListener('sf-consent', on);
  }, []);
  useEffect(() => {
    if (!storeId) return;
    fetch(`/api/storefront/stores/${encodeURIComponent(storeId)}/pixel`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(setPixel).catch(() => setPixel(null));
  }, [storeId]);
  useEffect(() => {
    if (consent !== 'granted' || !pixel) return;
    const tags: Tag[] = [...(pixel.pixelId ? [{ kind: 'meta' as const, id: pixel.pixelId, stub: !!pixel.stub }] : []), ...(pixel.tags ?? [])];
    if (!tags.length) return;
    loadTags(tags);
    track('PageView');
  }, [consent, pixel, path]);

  if (consent !== null) return null; // loading, or already chosen
  return (
    <div className="consent" role="region" aria-live="polite" aria-label="Cookies">
      <div className="wrap consent__in">
        <p>We use cookies to measure our ads and show you relevant ones. Essential cookies (your bag) are always on.</p>
        <div className="consent__btns">
          <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => setConsent('denied')}>Essential only</button>
          <button type="button" className="sf-btn sf-btn--sm sf-btn--brand" onClick={() => setConsent('granted')}>Accept</button>
        </div>
      </div>
    </div>
  );
}
