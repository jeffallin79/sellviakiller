'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function CompleteInner() {
  const params = useSearchParams();
  const stubPaid = params.get('stub_paid') === '1' || params.get('mode') === 'stub';
  const orderId = params.get('orderId');

  return (
    <div className="wrap">
      <h1>Thank you</h1>
      {stubPaid && (
        <p className="stub-badge" role="status">
          STUB / SANDBOX PAYMENT — no card was charged
        </p>
      )}
      <p className="muted">
        {stubPaid
          ? 'Demo checkout completed without a real payment. Your order will appear in the merchant admin.'
          : 'Thanks — your payment is being confirmed. Your order will appear in the merchant admin. Tracking updates when the supplier confirms shipment.'}
      </p>
      {orderId && (
        <p className="muted" style={{ marginTop: 8 }}>
          Order ID: <code>{orderId}</code>
        </p>
      )}
    </div>
  );
}

export default function CheckoutCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="wrap">
          <h1>Thank you</h1>
          <p className="muted">Loading…</p>
        </div>
      }
    >
      <CompleteInner />
    </Suspense>
  );
}
