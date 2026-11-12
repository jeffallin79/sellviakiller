import type { Metadata } from 'next';
import '@storeforge/ui/fonts';
import '@storeforge/ui/tokens.css';
import '@storeforge/ui/base.css';
import './globals.css';
import { ThemeScript } from '@storeforge/ui/theme-script';

export const metadata: Metadata = {
  title: { default: 'StoreForge', template: '%s' },
  description: 'Independent shops with real shipping times.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>{children}</body>
    </html>
  );
}
