'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@storeforge/ui/icons';
import { Callout, Collage } from '@storeforge/ui/components';
import { getConsent, loadTags, track, type Tag } from '@/lib/pixel';

function CompleteInner() {
  const params = useSearchParams();
  const stubPaid = params.get('stub_paid') === '1' || params.get('mode') === 'stub';
  const orderId = params.get('orderId');
  useEffect(() => {
    // Browser half of the Purchase event on every tag; the server sends the same ids (CAPI / enhanced conversions / Events API).
    if (!orderId || getConsent() !== 'granted') return;
    const key = `sf-purchase-${orderId}`;
    try { if (sessionStorage.getItem(key)) return; } catch { /* ignore */ }
    let tries = 0;
    const go = async () => {
      const r = await fetch(`/api/storefront/orders/${encodeURIComponent(orderId)}/pixel`, { cache: 'no-store' }).catch(() => null);
      if (r?.status === 404 && tries++ < 5) { setTimeout(go, 2000); return; } // payment still confirming
      if (!r?.ok) return;
      const p = await r.json();
      const tags: Tag[] = [...(p.pixelId ? [{ kind: 'meta' as const, id: p.pixelId, stub: !!p.stub }] : []), ...(p.tags ?? [])];
      if (!tags.length) return;
      loadTags(tags);
      track('Purchase', { value: p.value, currency: p.currency }, p.eventId, p.transactionId);
      try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
    };
    void go();
  }, [orderId]);
  return (
    <section className="band">
      <div className="wrap hero">
        <div>
          <p className="sf-eyebrow"><Icon name="done" size={16} />Order placed</p>
          <h1>Thank you</h1>
          {stubPaid && <Callout tone="warn">Demo checkout — no card was charged.</Callout>}
          <p className="hero__lede">
            {stubPaid ? 'This was a test order. It now appears in the shop owner’s Dispatch.' : 'Your payment is being confirmed. A receipt is on its way to your inbox, and tracking follows as soon as your order ships.'}
          </p>
          {orderId && <p className="sf-muted">Order <span className="sf-mono">#{orderId.slice(-8).toUpperCase()}</span></p>}
        </div>
        <Collage />
      </div>
    </section>
  );
}

export default function CheckoutCompletePage() {
  return <Suspense fallback={<div className="wrap band"><h1>Thank you</h1></div>}><CompleteInner /></Suspense>;
}
