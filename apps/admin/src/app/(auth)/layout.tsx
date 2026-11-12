import { Icon } from '@storeforge/ui/icons';
import { Collage } from '@storeforge/ui/components';
import { ThemeToggle } from '@storeforge/ui/theme';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <section className="auth__band">
        <div className="sf-spread">
          <p className="sf-eyebrow">StoreForge</p>
          <ThemeToggle compact />
        </div>
        <h1>Sell things. Show real shipping times.</h1>
        <ul>
          <li><Icon name="eta" size={22} /><span><strong>Honest ETAs.</strong> Every product shows how long it really takes to arrive.</span></li>
          <li><Icon name="money" size={22} /><span><strong>Clear fees.</strong> One monthly plan, no commission on your orders.</span></li>
          <li><Icon name="export" size={22} /><span><strong>Your data stays yours.</strong> Export products and orders any time, even after you cancel.</span></li>
        </ul>
        <Collage />
      </section>
      <main className="auth__form" id="main">{children}</main>
    </div>
  );
}
