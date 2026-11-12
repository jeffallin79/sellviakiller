import type { Metadata } from 'next';
import { Icon } from '@storeforge/ui/icons';

export const metadata: Metadata = { title: 'No shop at this address', robots: { index: false } };

const ROOT = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';

export default async function UnknownDomain({ searchParams }: { searchParams: Promise<{ host?: string }> }) {
  const host = String((await searchParams).host ?? '').slice(0, 253);
  return (
    <main id="main">
      <section className="band band--ink">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <p className="sf-eyebrow"><Icon name="stores" size={16} />StoreForge</p>
          <h1>No shop lives here yet</h1>
          <p className="hero__lede">
            {host ? <><span className="sf-mono">{host}</span> points at StoreForge, but it isn&apos;t connected to an open shop.</> : 'This address isn’t connected to an open shop.'}
          </p>
        </div>
      </section>
      <section className="band">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <h2>Is this your domain?</h2>
          <p className="sf-muted">Open <strong>Domains</strong> in your StoreForge admin and check its status. New domains usually go live a few minutes after the DNS records are in place.</p>
          <p className="sf-muted">Shopping? Check the address, or find the shop at <span className="sf-mono">its-name.{ROOT}</span>.</p>
        </div>
      </section>
    </main>
  );
}
