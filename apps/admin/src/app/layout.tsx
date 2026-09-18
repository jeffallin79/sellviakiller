import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'StoreForge Admin',
  description: 'Merchant dashboard — Phase 0 MVP',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/dashboard" className="brand">
            StoreForge
          </a>
          <nav>
            <a href="/dashboard">Home</a>
            <a href="/dashboard/stores">Stores</a>
            <a href="/dashboard/catalog">Catalog</a>
            <a href="/dashboard/orders">Orders</a>
            <a href="/dashboard/billing">Billing</a>
            <a href="/login">Sign in</a>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
