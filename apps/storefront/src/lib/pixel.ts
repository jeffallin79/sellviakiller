'use client';

/**
 * Meta Pixel, consent-gated (slice 3). Nothing loads and no _fbp/_fbc cookie is set until the
 * shopper accepts marketing cookies in the banner. The Purchase event uses the same event id the
 * server sends through the Conversions API (order_<orderId>) so Meta counts the sale once.
 *
 * Stub Meta mode (dev): a stand-in fbq posts events to /api/storefront/stub-pixel, which the
 * stub Test Events view shows next to the server events (with dedupe).
 */
type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[][]; loaded?: boolean; callMethod?: (...a: unknown[]) => void; push?: unknown; version?: string };
declare global { interface Window { fbq?: Fbq; _fbq?: Fbq; __sfPixel?: { id: string; stub: boolean } } }

const KEY = 'sf-consent-v1';
export type Consent = 'granted' | 'denied' | null;
const FB_COOKIE = /^fb\.\d\.\d+\.[\w.-]+$/;

export function getConsent(): Consent {
  try { const v = localStorage.getItem(KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; }
}
export function setConsent(v: 'granted' | 'denied') {
  try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  if (v === 'denied') { clearCookie('_fbp'); clearCookie('_fbc'); }
  window.dispatchEvent(new CustomEvent('sf-consent', { detail: v }));
}

function cookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; Max-Age=${90 * 86400}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
function clearCookie(name: string) { document.cookie = `${name}=; Max-Age=0; Path=/`; }

/** First-party click id / browser id, the same format Meta's own pixel writes. */
function ensureFbCookies() {
  if (!cookie('_fbp')) setCookie('_fbp', `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e10)}`);
  const fbclid = new URLSearchParams(location.search).get('fbclid');
  if (fbclid && /^[\w.-]{1,400}$/.test(fbclid)) setCookie('_fbc', `fb.1.${Date.now()}.${fbclid}`);
}

export function loadPixel(pixelId: string, stub: boolean) {
  if (getConsent() !== 'granted' || window.__sfPixel?.id === pixelId) return;
  window.__sfPixel = { id: pixelId, stub };
  ensureFbCookies();
  if (stub) {
    const f = ((cmd: string, eventName?: string, _params?: unknown, opts?: { eventID?: string }) => {
      if (cmd !== 'track' || !eventName) return;
      void fetch('/api/storefront/stub-pixel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixelId, eventName, eventId: opts?.eventID }), keepalive: true }).catch(() => null);
    }) as Fbq;
    window.fbq = f;
  } else if (!window.fbq) {
    // Meta's standard base code, minus the inline <script>.
    const n = function (...args: unknown[]) { n.callMethod ? n.callMethod(...args) : n.queue!.push(args); } as Fbq;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    window.fbq = n; window._fbq = n;
    const s = document.createElement('script');
    s.async = true; s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);
    window.fbq('init', pixelId);
  }
}

export function track(eventName: 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase', params?: Record<string, unknown>, eventId?: string) {
  if (getConsent() !== 'granted' || !window.fbq) return;
  window.fbq('track', eventName, params ?? {}, eventId ? { eventID: eventId } : undefined);
}

/** Sent with checkout: the server only keeps (and only sends to Meta) these with consent. */
export function attribution() {
  const consent = getConsent() === 'granted';
  if (!consent) return { consent: false };
  const fbp = cookie('_fbp');
  const fbc = cookie('_fbc');
  return {
    consent: true,
    ...(fbp && FB_COOKIE.test(fbp) ? { fbp } : {}),
    ...(fbc && FB_COOKIE.test(fbc) ? { fbc } : {}),
    sourceUrl: location.href.slice(0, 2000),
  };
}
