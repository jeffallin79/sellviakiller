import { Icon } from '@storeforge/ui/icons';
import { Collage } from '@storeforge/ui/components';
import { ThemeToggle } from '@storeforge/ui/theme';

const ROOT = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';

export default function Home() {
  return (
    <main id="main">
      <section className="band band--ink">
        <div className="wrap hero">
          <div>
            <div className="sf-spread"><p className="sf-eyebrow">StoreForge</p><ThemeToggle compact /></div>
            <h1>Shops that tell you when things arrive.</h1>
            <p className="hero__lede">Every StoreForge shop lives at its own address, like <span className="sf-mono">yourshop.{ROOT}</span>.</p>
          </div>
          <Collage />
        </div>
      </section>
      <section className="band">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <h2>Running locally?</h2>
          <p className="sf-muted">Add the shop to <code>/etc/hosts</code>, or open it by path:</p>
          <pre className="sf-card sf-card--sunken sf-mono" style={{ overflowX: 'auto' }}>127.0.0.1 demo.{ROOT}{'\n'}127.0.0.1 admin.{ROOT}</pre>
          <p><a className="sf-btn sf-btn--brand" href="/s/demo"><Icon name="stores" size={18} />Open /s/demo</a></p>
        </div>
      </section>
    </main>
  );
}
