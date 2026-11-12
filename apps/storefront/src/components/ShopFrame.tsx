'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@storeforge/ui/icons';
import { ThemeToggle } from '@storeforge/ui/theme';
import { Callout, Money } from '@storeforge/ui/components';
import { ProductImage } from '@storeforge/ui/product-image';
import { api } from '@/lib/api';
import { useCart, shippingFor, FREE_SHIPPING_CENTS, SHIPPING_CENTS, cartToken, setCartToken, rotateCartToken } from '@/lib/cart';
import { CART_CONSENT_TEXT } from '@storeforge/shared';
import { titleOf, type StoreProduct } from '@/lib/store';
import { useShopHref } from '@/lib/base';
import { attribution, track } from '@/lib/pixel';
import { ShopPixel } from '@/components/Consent';

const ShopCtx = createContext<{ openCart: () => void }>({ openCart: () => {} });
export const useShop = () => useContext(ShopCtx);

export function ShopFrame({ slug, store, products, children }: { slug: string; store: any; products: StoreProduct[] | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { count, replace } = useCart(slug);
  // Recovery link from a reminder email (?recover=<cart>&t=<sig>): put the bag back, open it.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('recover');
    const t = q.get('t');
    if (!id || !t) return;
    q.delete('recover'); q.delete('t');
    window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}${window.location.hash}`);
    api<{ status: string; token: string | null; lines: { storeProductId: string; quantity: number }[] }>(`/storefront/carts/recover?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`)
      .then((r) => {
        if (r.status === 'CONVERTED') { setNote('You already checked out this bag. Thanks!'); setOpen(true); return; }
        if (r.token) setCartToken(slug, r.token);
        if (r.lines.length) replace(Object.fromEntries(r.lines.map((l) => [l.storeProductId, l.quantity])));
        setNote(r.lines.length ? 'Your bag is back, just as you left it. Prices shown are today\'s.' : 'Those items are no longer available, sorry.');
        setOpen(true);
      })
      .catch(() => { setNote('That link has expired. Your bag may still be here.'); setOpen(true); });
  }, [slug]);
  const href = useShopHref(slug);
  const name = store?.name ?? slug;
  return (
    <ShopCtx.Provider value={{ openCart: () => setOpen(true) }}>
      {/* Consent first: on desktop it's an in-flow strip above the header, so it never covers content */}
      <ShopPixel storeId={store?.id} />
      <header className="shophead">
        <div className="wrap shophead__in">
          <Link href={href()} className="wordmark"><span className="wordmark__dot" aria-hidden="true" />{name}</Link>
          <nav aria-label="Shop">
            <Link href={href('#shelf')}>Shop all</Link>
            <Link href={href('#shipping')}>Shipping</Link>
          </nav>
          <div className="shophead__end">
            <ThemeToggle compact />
            <button className="sf-btn sf-btn--brand cartbtn" onClick={() => setOpen(true)} aria-label={`Bag, ${count} item${count === 1 ? '' : 's'}`}>
              <Icon name="bag" size={20} />Bag <span className="cartbtn__n">{count}</span>
            </button>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="shopfoot">
        <div className="wrap shopfoot__in">
          <span><strong>{name}</strong> · <span className="sf-muted">Free shipping over <Money cents={FREE_SHIPPING_CENTS} />, otherwise <Money cents={SHIPPING_CENTS} />.</span></span>
          <span className="sf-muted"><Icon name="secure" size={16} /> Card payments by Stripe · Shop built on StoreForge</span>
        </div>
      </footer>
      {open && <CartDrawer slug={slug} products={products ?? []} note={note} onClose={() => { setOpen(false); setNote(''); }} />}
    </ShopCtx.Provider>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function CartDrawer({ slug, products, note, onClose }: { slug: string; products: StoreProduct[]; note?: string; onClose: () => void }) {
  const { cart, set, clear } = useCart(slug);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [remind, setRemind] = useState(false);
  const synced = useRef(false);
  // Reminder opt-in (unticked by default). Only with the box ticked AND an email typed is the bag
  // saved on the server; unticking tells the server to forget the address.
  useEffect(() => {
    const wants = remind && EMAIL_RE.test(email.trim());
    if (!wants && !synced.current) return;
    const h = setTimeout(() => {
      const body = { storeSlug: slug, token: cartToken(slug), consent: wants, ...(wants ? { email: email.trim(), name: name.trim() || undefined } : {}), lines: Object.entries(cart).map(([storeProductId, quantity]) => ({ storeProductId, quantity })).slice(0, 50) };
      api<{ stored: boolean; rotate?: boolean }>('/storefront/carts', { method: 'POST', body: JSON.stringify(body) })
        .then((r) => {
          if (r.rotate) { rotateCartToken(slug); return; }
          synced.current = r.stored;
        })
        .catch(() => null);
    }, 800);
    return () => clearTimeout(h);
  }, [remind, email, name, cart, slug]);
  const [step, setStep] = useState<'bag' | 'details'>('bag');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = Object.entries(cart).map(([id, q]) => ({ p: products.find((x) => x.id === id), id, q })).filter((l) => l.p) as { p: StoreProduct; id: string; q: number }[];
  const subtotal = lines.reduce((a, l) => a + l.p.priceCents * l.q, 0);
  const shipping = shippingFor(subtotal);
  const slowest = lines.reduce((m, l) => Math.max(m, l.p.product.etaDaysMax), 0);

  async function pay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setBusy(true);
    const fd = new FormData(e.currentTarget);
    track('InitiateCheckout', { value: (subtotal + shipping) / 100, currency: 'USD', num_items: lines.reduce((a, l) => a + l.q, 0) });
    try {
      const res = await api<any>('/checkout', {
        method: 'POST',
        body: JSON.stringify({
          storeSlug: slug, email: fd.get('email'), name: fd.get('name'), cartToken: cartToken(slug), cartConsent: remind,
          lines: lines.map((l) => ({ storeProductId: l.id, quantity: l.q })),
          shippingAddress: { line1: fd.get('line1'), city: fd.get('city'), state: fd.get('state'), postalCode: fd.get('postalCode'), country: fd.get('country') },
          attribution: attribution(),
        }),
      });
      if (res.checkoutUrl) { clear(); rotateCartToken(slug); window.location.href = res.checkoutUrl; return; }
      setError('Checkout did not return a payment page. Please try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Your bag">
        <div className="sf-spread">
          <h2 style={{ margin: 0 }}>{step === 'bag' ? 'Your bag' : 'Delivery details'}</h2>
          <button className="sf-btn sf-btn--sm sf-btn--quiet" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {note && <Callout tone="info">{note}</Callout>}
        {lines.length === 0 ? (
          <p className="sf-muted">Your bag is empty.</p>
        ) : step === 'bag' ? (
          <>
            {lines.map((l) => (
              <div key={l.id} className="drawer__line">
                <span className="drawer__thumb"><ProductImage src={l.p.product.imageUrl} alt={titleOf(l.p)} /></span>
                <div>
                  <strong style={{ display: 'block' }}>{titleOf(l.p)}</strong>
                  <span className="sf-muted" style={{ fontSize: '0.82rem' }}>Arrives in {l.p.product.etaDaysMin}–{l.p.product.etaDaysMax} days</span>
                  <div className="qty" style={{ marginTop: 6 }}>
                    <button onClick={() => set(l.id, l.q - 1)} aria-label="One fewer"><Icon name="remove" size={16} /></button>
                    <span>{l.q}</span>
                    <button onClick={() => set(l.id, l.q + 1)} aria-label="One more"><Icon name="add" size={16} /></button>
                  </div>
                </div>
                <Money cents={l.p.priceCents * l.q} />
              </div>
            ))}
            <Summary subtotal={subtotal} shipping={shipping} slowest={slowest} />
            <button className="sf-btn sf-btn--brand sf-btn--block" onClick={() => setStep('details')}>Continue<Icon name="next" size={18} /></button>
          </>
        ) : (
          <form onSubmit={pay}>
            <div className="sf-field"><label className="sf-label" htmlFor="c-name">Full name</label><input id="c-name" name="name" className="sf-input" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="sf-field"><label className="sf-label" htmlFor="c-email">Email (for tracking)</label><input id="c-email" name="email" type="email" className="sf-input" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <label className="sf-optin" htmlFor="c-remind">
              <input id="c-remind" type="checkbox" className="sf-check" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
              <span>{CART_CONSENT_TEXT}</span>
            </label>
            <div className="sf-field"><label className="sf-label" htmlFor="c-l1">Street address</label><input id="c-l1" name="line1" className="sf-input" required autoComplete="address-line1" /></div>
            <div className="two">
              <div className="sf-field"><label className="sf-label" htmlFor="c-city">City</label><input id="c-city" name="city" className="sf-input" required autoComplete="address-level2" /></div>
              <div className="sf-field"><label className="sf-label" htmlFor="c-st">State / province</label><input id="c-st" name="state" className="sf-input" required autoComplete="address-level1" /></div>
            </div>
            <div className="two">
              <div className="sf-field"><label className="sf-label" htmlFor="c-zip">Postal code</label><input id="c-zip" name="postalCode" className="sf-input" required autoComplete="postal-code" /></div>
              <div className="sf-field"><label className="sf-label" htmlFor="c-ctry">Country</label><select id="c-ctry" name="country" className="sf-select" defaultValue="US"><option value="US">United States</option><option value="CA">Canada</option></select></div>
            </div>
            <Summary subtotal={subtotal} shipping={shipping} slowest={slowest} />
            {error && <Callout tone="bad">{error}</Callout>}
            <div className="sf-row" style={{ marginTop: 12 }}>
              <button type="button" className="sf-btn sf-btn--quiet" onClick={() => setStep('bag')}><Icon name="back" size={18} />Bag</button>
              <button className="sf-btn sf-btn--brand" style={{ flex: 1 }} disabled={busy} type="submit"><Icon name="secure" size={18} />{busy ? 'Opening payment…' : 'Pay securely'}</button>
            </div>
            <p className="sf-muted" style={{ fontSize: '0.8rem', marginTop: 10 }}>You&apos;ll enter your card on Stripe&apos;s secure page. No extra fees are added there.</p>
          </form>
        )}
      </aside>
    </>
  );
}

function Summary({ subtotal, shipping, slowest }: { subtotal: number; shipping: number; slowest: number }) {
  return (
    <div className="drawer__sum">
      <div><span>Items</span><Money cents={subtotal} /></div>
      <div><span>Shipping {shipping === 0 && subtotal > 0 ? '(free over $50)' : ''}</span><Money cents={shipping} /></div>
      <div className="total"><span>Total</span><Money cents={subtotal + shipping} /></div>
      {slowest > 0 && <span className="sf-muted" style={{ fontSize: '0.82rem' }}><Icon name="eta" size={14} /> Everything arrives within {slowest} days.</span>}
    </div>
  );
}
