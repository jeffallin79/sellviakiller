'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

type StoreProduct = {
  id: string;
  title?: string;
  priceCents: number;
  product: {
    title: string;
    imageUrl?: string;
    etaDaysMin: number;
    etaDaysMax: number;
    sourcingLabel: string;
    description: string;
  };
};

export default function StorePage() {
  const params = useParams();
  const slug = String(params.slug);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [store, setStore] = useState<any>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [stubMode, setStubMode] = useState(false);

  useEffect(() => {
    api(`/stores/by-slug/${slug}`).then(setStore).catch((e) => setError(e.message));
    api<StoreProduct[]>(`/storefront/${slug}/products`).then(setProducts).catch(() => setProducts([]));
  }, [slug]);

  const cartCount = useMemo(
    () => Object.values(cart).reduce((a, b) => a + b, 0),
    [cart],
  );

  function add(id: string) {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  }

  async function checkout(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const lines = Object.entries(cart).map(([storeProductId, quantity]) => ({
      storeProductId,
      quantity,
    }));
    try {
      const res = await api<any>('/checkout', {
        method: 'POST',
        body: JSON.stringify({
          storeSlug: slug,
          email: fd.get('email'),
          name: fd.get('name'),
          lines,
          shippingAddress: {
            line1: fd.get('line1'),
            city: fd.get('city'),
            state: fd.get('state'),
            postalCode: fd.get('postalCode'),
            country: 'US',
          },
        }),
      });
      setMsg(res.message ?? 'Order placed');
      setStubMode(res.mode === 'stub');
      if (res.mode === 'stub' && res.checkoutUrl) {
        // Prefer thank-you URL from stub payment link (includes stub_paid=1)
        window.location.href = res.checkoutUrl;
        return;
      }
      if (res.checkoutUrl && process.env.NEXT_PUBLIC_SQUARE_LIVE === '1') {
        window.location.href = res.checkoutUrl;
      } else {
        setCheckoutOpen(false);
        setCart({});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    }
  }

  if (error && !store) {
    return (
      <div className="wrap">
        <h1>Store not found</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>{store?.name ?? slug}</h1>
        <p className="muted">Powered by StoreForge · Honest supplier ETAs · Square checkout</p>
      </div>

      {products.length === 0 && (
        <p className="muted">No products yet — import from admin catalog.</p>
      )}

      <div className="grid">
        {products.map((p) => (
          <div className="product" key={p.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.product.imageUrl ?? ''} alt="" />
            <div className="body">
              <h3>{p.title ?? p.product.title}</h3>
              <div className="eta">
                Ships in {p.product.etaDaysMin}–{p.product.etaDaysMax} days · {p.product.sourcingLabel}
              </div>
              <div className="price">${(p.priceCents / 100).toFixed(2)}</div>
              <button className="btn" onClick={() => add(p.id)}>Add to cart</button>
            </div>
          </div>
        ))}
      </div>

      {cartCount > 0 && (
        <button className="cart" onClick={() => setCheckoutOpen(true)}>
          Cart ({cartCount}) — Checkout
        </button>
      )}

      {checkoutOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <form
            onSubmit={checkout}
            style={{ background: '#fff', padding: 24, borderRadius: 12, width: 'min(420px, 100%)' }}
          >
            <h2 style={{ fontFamily: 'system-ui' }}>Checkout (Square)</h2>
            <label className="muted">Name</label>
            <input name="name" required defaultValue="Test Customer" />
            <label className="muted">Email</label>
            <input name="email" type="email" required defaultValue="customer@example.com" />
            <label className="muted">Address</label>
            <input name="line1" required defaultValue="123 Main St" />
            <label className="muted">City</label>
            <input name="city" required defaultValue="Austin" />
            <label className="muted">State</label>
            <input name="state" required defaultValue="TX" />
            <label className="muted">Postal</label>
            <input name="postalCode" required defaultValue="78701" />
            <button className="btn" type="submit">Pay with Square</button>
            <button type="button" className="btn" style={{ marginLeft: 8, background: '#666' }} onClick={() => setCheckoutOpen(false)}>
              Cancel
            </button>
          </form>
        </div>
      )}

      {stubMode && (
        <p className="stub-badge" role="status" style={{ marginTop: 16 }}>
          STUB / SANDBOX PAYMENT — no Square charge was made
        </p>
      )}
      {msg && <p className="muted" style={{ marginTop: 16 }}>{msg}</p>}
    </div>
  );
}
