import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ROOT = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  const hostname = host.split(':')[0];

  // demo.storeforge.local → rewrite to /s/demo/...
  if (hostname.endsWith(`.${ROOT}`) || hostname.endsWith('.localhost')) {
    const parts = hostname.split('.');
    const slug = parts[0];
    if (slug && slug !== 'www' && slug !== 'admin') {
      const url = req.nextUrl.clone();
      if (!url.pathname.startsWith('/s/')) {
        url.pathname = `/s/${slug}${url.pathname === '/' ? '' : url.pathname}`;
        return NextResponse.rewrite(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|api).*)'],
};
