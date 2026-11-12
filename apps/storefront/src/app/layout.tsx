import type { Metadata } from 'next';
import '@storeforge/ui/fonts';
import '@storeforge/ui/tokens.css';
import '@storeforge/ui/base.css';
import './globals.css';
import { headers } from 'next/headers';
import { ThemeScript } from '@storeforge/ui/theme-script';
import { ShopBaseProvider } from '@/lib/base';

export const metadata: Metadata = {
  title: { default: 'StoreForge', template: '%s' },
  description: 'Independent shops with real shipping times.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body><ShopBaseProvider base={(await headers()).get('x-sf-base')}>{children}</ShopBaseProvider></body>
    </html>
  );
}
