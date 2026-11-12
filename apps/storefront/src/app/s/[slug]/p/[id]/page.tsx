'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@storeforge/ui/icons';
import { Money } from '@storeforge/ui/components';
import { ProductImage } from '@storeforge/ui/product-image';
import { ShopFrame, useShop } from '@/components/ShopFrame';
import { useCart, FREE_SHIPPING_CENTS, SHIPPING_CENTS } from '@/lib/cart';
import { useShopHref } from '@/lib/base';
import { useStore, titleOf, type StoreProduct } from '@/lib/store';

export default function ProductPage() {
  const params = useParams();
  const slug = String(params.slug);
  const id = String(params.id);
  const { store, products, error } = useStore(slug);
  const href = useShopHref(slug);
  const p = products?.find((x) => x.id === id);

  return (
    <ShopFrame slug={slug} store={store} products={products}>
      <section className="band">
        <div className="wrap">
          {products === null && !error ? <p className="sf-muted">Loading…</p> : !p ? (
            <><h1>Item not found</h1><Link href={href()}>Back to the shop</Link></>
          ) : <Detail p={p} slug={slug} />}
        </div>
      </section>
    </ShopFrame>
  );
}

function Detail({ p, slug }: { p: StoreProduct; slug: string }) {
  const href = useShopHref(slug);
  const [qty, setQty] = useState(1);
  const { add } = useCart(slug);
  const { openCart } = useShop();
  const arrive = (d: number) => new Date(Date.now() + d * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link href={href()}>Shop</Link><span className="sf-muted">/</span><span className="sf-muted">{titleOf(p)}</span></nav>
      <div className="pdp">
        <div className="pdp__img"><ProductImage src={p.product.imageUrl} alt={titleOf(p)} eager /></div>
        <div>
          {p.product.category && <p className="sf-eyebrow">{p.product.category}</p>}
          <h1>{titleOf(p)}</h1>
          <div className="pdp__price"><Money cents={p.priceCents} /></div>
          <div className="sf-row">
            <div className="qty" aria-label="Quantity">
              <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="One fewer"><Icon name="remove" size={16} /></button>
              <span>{qty}</span>
              <button onClick={() => setQty(Math.min(99, qty + 1))} aria-label="One more"><Icon name="add" size={16} /></button>
            </div>
            <button className="sf-btn sf-btn--brand" style={{ flex: 1 }} onClick={() => { add(p.id, qty); openCart(); }}><Icon name="bag" size={18} />Add to bag</button>
          </div>
          <ul className="facts">
            <li><Icon name="eta" size={20} /><span><strong>Arrives {arrive(p.product.etaDaysMin)} – {arrive(p.product.etaDaysMax)}</strong><br /><span className="sf-muted">{p.product.etaDaysMin}–{p.product.etaDaysMax} days from order, based on the supplier&apos;s recent shipments.</span></span></li>
            <li><Icon name="origin" size={20} /><span><strong>Ships from</strong><br /><span className="sf-muted">{p.product.sourcingLabel}</span></span></li>
            <li><Icon name="package" size={20} /><span><strong>Shipping</strong><br /><span className="sf-muted">Free over <Money cents={FREE_SHIPPING_CENTS} />, otherwise <Money cents={SHIPPING_CENTS} />. No other fees.</span></span></li>
            <li><Icon name="secure" size={20} /><span><strong>Secure checkout</strong><br /><span className="sf-muted">Pay by card on Stripe. Tracking is emailed when it ships.</span></span></li>
          </ul>
          {p.product.description && <><h3>About this item</h3><p className="sf-muted">{p.product.description}</p></>}
        </div>
      </div>
    </>
  );
}
