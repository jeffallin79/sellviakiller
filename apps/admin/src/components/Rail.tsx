'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@storeforge/ui/icons';
import { ThemeToggle } from '@storeforge/ui/theme';
import { API_URL } from '@/lib/api';

const NAV: { href: string; label: string; icon: IconName; soon?: boolean }[] = [
  { href: '/launchpad', label: 'Launchpad', icon: 'launchpad' },
  { href: '/shelf', label: 'Shelf', icon: 'shelf' },
  { href: '/dispatch', label: 'Dispatch', icon: 'dispatch' },
  { href: '/emails', label: 'Emails', icon: 'email' },
  { href: '/boost', label: 'Boost', icon: 'boost' },
  { href: '/fuel', label: 'Ad Fuel', icon: 'fuel' },
];
const MORE: { href: string; label: string; icon: IconName }[] = [
  { href: '/stores', label: 'Stores', icon: 'stores' },
  { href: '/domains', label: 'Domains', icon: 'domains' },
  { href: '/billing', label: 'Billing', icon: 'billing' },
];

export function Rail() {
  const path = usePathname();
  const item = (n: { href: string; label: string; icon: IconName; soon?: boolean }) => (
    <Link key={n.href} href={n.href} className="rail__item" aria-current={path.startsWith(n.href) ? 'page' : undefined}>
      <Icon name={n.icon} size={24} />
      <span>{n.label}</span>
      {n.soon && <span className="rail__soon">soon</span>}
    </Link>
  );

  async function signOut() {
    await fetch(`${API_URL}/api/auth/sign-out`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
    window.location.href = '/login';
  }

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail__in">
      <Link href="/launchpad" className="rail__mark" aria-label="StoreForge home">SF</Link>
      <div className="rail__nav">
        {NAV.map(item)}
        <hr className="rail__sep" />
        {MORE.map(item)}
      </div>
      <div className="rail__foot">
        <ThemeToggle compact />
        <button type="button" className="rail__out" onClick={signOut}>
          <Icon name="signOut" size={20} />
          <span>Sign out</span>
        </button>
      </div>
      </div>
    </nav>
  );
}
