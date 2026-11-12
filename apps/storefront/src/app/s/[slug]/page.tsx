'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Collage, Money } from '@storeforge/ui/components';
import { ProductImage } from '@storeforge/ui/product-image';
import { ShopFrame } from '@/components/ShopFrame';
import { useCart } from '@/lib/cart';
import { useShopHref } from '@/lib/base';
import { useStore, titleOf, type StoreProduct } from '@/lib/store';

export default function StoreHome() {
  const slug = String(useParams().slug);
  const { store, products, error } = useStore(slug);
  const { add } = useCart(slug);

  if (error && !store) {
    return (
      <div className="wrap band"><p className="sf-eyebrow">404</p><h1>This shop isn&apos;t open</h1><p className="sf-muted">Check the address, or the shop may have closed.</p></div>
    );
  }
  const list = products ?? [];
  const hero = list[0];
  const fastest = list.length ? Math.min(...list.map((p) => p.product.etaDaysMin)) : null;

  return (
    <ShopFrame slug={slug} store={store} products={products}>
      <section className="band band--ink">
        <div className="wrap hero">
          <div>
            <p className="sf-eyebrow"><Icon name="spark" size={16} />New on the shelf</p>
            <h1>{store?.name ?? slug}</h1>
            <p className="hero__lede">Small-batch finds, picked by hand. Every item tells you how long it really takes to reach you, before you pay.</p>
            <div className="sf-row">
              <a className="sf-btn sf-btn--money" href="#shelf">Shop the shelf<Icon name="next" size={18} /></a>
              <a className="sf-btn sf-btn--quiet" href="#shipping">How shipping works</a>
            </div>
            <div className="hero__facts">
              <span><Icon name="eta" size={18} />{fastest ? `Arrives in as little as ${fastest} days` : 'Real delivery times'}</span>
              <span><Icon name="secure" size={18} />Secure card checkout</span>
            </div>
          </div>
          <div className="hero__art">
            <Collage />
            {hero && <div className="hero__photo"><ProductImage src={hero.product.imageUrl} alt={titleOf(hero)} eager /></div>}
          </div>
        </div>
      </section>

      <section className="band" id="shelf">
        <div className="wrap">
          <div className="shelfhead">
            <div><p className="sf-eyebrow">The shelf</p><h2>Everything in the shop</h2></div>
            <span className="sf-muted"><span className="sf-num">{list.length}</span> items · prices include everything but shipping</span>
          </div>
          {products === null ? <p className="sf-muted">Loading…</p> : list.length === 0 ? (
            <p className="sf-muted">Nothing on the shelf yet — check back soon.</p>
          ) : (
            <div className="editorial">
              {list.map((p, i) => <Tile key={p.id} p={p} slug={slug} feature={i === 0} onAdd={() => add(p.id)} />)}
            </div>
          )}
        </div>
      </section>

      <section className="band band--ink" id="shipping">
        <div className="wrap">
          <p className="sf-eyebrow">Shipping, plainly</p>
          <h2 style={{ fontSize: 'clamp(1.8rem, 1.3rem + 1.6vw, 2.6rem)', marginBottom: 28 }}>No surprises after you pay</h2>
          <div className="how">
            <div><div className="how__n">01</div><h3>Made to order</h3><p>Most items ship from our supplier&apos;s warehouse, so each product shows its own delivery window.</p></div>
            <div><div className="how__n">02</div><h3>One shipping fee</h3><p>Free over <Money cents={5000} />. Otherwise a flat <Money cents={499} />, shown before you pay.</p></div>
            <div><div className="how__n">03</div><h3>Tracking by email</h3><p>You get a tracking number as soon as your order leaves the warehouse.</p></div>
          </div>
        </div>
      </section>
    </ShopFrame>
  );
}

function Tile({ p, slug, feature, onAdd }: { p: StoreProduct; slug: string; feature: boolean; onAdd: () => void }) {
  const href = useShopHref(slug);
  return (
    <article className={`tile ${feature ? 'tile--feature' : ''}`}>
      <Link href={href(`/p/${p.id}`)} className="tile__img">
        <ProductImage src={p.product.imageUrl} alt={titleOf(p)} eager={feature} />
        {p.product.etaDaysMax <= 10 && <span className="tile__tag"><Badge tone="money">Arrives fast</Badge></span>}
      </Link>
      <Link href={href(`/p/${p.id}`)} style={{ color: 'inherit', textDecoration: 'none' }}><h3>{titleOf(p)}</h3></Link>
      <div className="tile__meta">
        <span className="tile__price"><Money cents={p.priceCents} /></span>
        <button className="sf-btn sf-btn--sm" onClick={onAdd} aria-label={`Add ${titleOf(p)} to bag`}><Icon name="add" size={16} />Add</button>
      </div>
      <span className="tile__eta"><Icon name="eta" size={14} />Arrives in {p.product.etaDaysMin}–{p.product.etaDaysMax} days</span>
    </article>
  );
}
