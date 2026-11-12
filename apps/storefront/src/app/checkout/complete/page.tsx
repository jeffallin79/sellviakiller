'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@storeforge/ui/icons';
import { Callout, Collage } from '@storeforge/ui/components';

function CompleteInner() {
  const params = useSearchParams();
  const stubPaid = params.get('stub_paid') === '1' || params.get('mode') === 'stub';
  const orderId = params.get('orderId');
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
          {orderId && <p className="sf-muted">Order <span className="sf-mono">#{orderId.slice(-6).toUpperCase()}</span></p>}
        </div>
        <Collage />
      </div>
    </section>
  );
}

export default function CheckoutCompletePage() {
  return <Suspense fallback={<div className="wrap band"><h1>Thank you</h1></div>}><CompleteInner /></Suspense>;
}
