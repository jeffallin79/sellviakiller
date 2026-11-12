'use client';

/**
 * Ad tags, consent-gated (slices 3–4). Nothing loads and no ad cookie is set until the shopper
 * accepts marketing cookies in the banner.
 *   - Meta Pixel: the merchant's own Pixel (connect-your-own) and/or the managed Boost Pixel.
 *   - Google tag (gtag.js, AW-…): managed Boost on Google; Purchase = `conversion` with
 *     transaction_id = order id, which Google joins to the server-side enhanced conversion.
 *   - TikTok Pixel: managed Boost on TikTok; CompletePayment with event_id = order_<id>, the same
 *     id the server sends through the Events API, so TikTok counts it once.
 * Click ids (gclid / ttclid) and the TikTok _ttp cookie go to checkout only with consent.
 *
 * Stub ad platforms (dev): stand-ins post each hit to /api/storefront/stub-pixel, which the stub
 * Test Events views show next to the server events (with dedupe).
 */
type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[][]; loaded?: boolean; callMethod?: (...a: unknown[]) => void; push?: unknown; version?: string };
type Ttq = { _i?: Record<string, unknown>; methods?: string[]; load?: (id: string) => void; page: () => void; track: (e: string, p?: Record<string, unknown>, o?: { event_id?: string }) => void; [k: string]: unknown };
export type Tag = { kind: 'meta' | 'gtag' | 'tiktok'; id: string; sendTo?: string; stub?: boolean };
declare global {
  interface Window { fbq?: Fbq; _fbq?: Fbq; dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void; ttq?: Ttq; TiktokAnalyticsObject?: string; __sfTags?: Record<string, Tag> }
}

const KEY = 'sf-consent-v1';
export type Consent = 'granted' | 'denied' | null;
const FB_COOKIE = /^fb\.\d\.\d+\.[\w.-]+$/;
const GCLID = /^[\w-]{1,300}$/;
const TTCLID = /^[\w.-]{1,500}$/;
const TTP = /^[\w.-]{1,200}$/;
const AD_COOKIES = ['_fbp', '_fbc', '_sf_gclid', '_sf_ttclid', '_ttp'];

export function getConsent(): Consent {
  try { const v = localStorage.getItem(KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; }
}
export function setConsent(v: 'granted' | 'denied') {
  try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  if (v === 'denied') AD_COOKIES.forEach(clearCookie);
  window.dispatchEvent(new CustomEvent('sf-consent', { detail: v }));
}

function cookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; Max-Age=${90 * 86400}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
function clearCookie(name: string) { document.cookie = `${name}=; Max-Age=0; Path=/`; }

/** First-party click ids: Meta's own formats for _fbp/_fbc; gclid/ttclid kept as landed. */
function captureClickIds() {
  if (!cookie('_fbp')) setCookie('_fbp', `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e10)}`);
  const q = new URLSearchParams(location.search);
  const fbclid = q.get('fbclid');
  if (fbclid && /^[\w.-]{1,400}$/.test(fbclid)) setCookie('_fbc', `fb.1.${Date.now()}.${fbclid}`);
  const gclid = q.get('gclid');
  if (gclid && GCLID.test(gclid)) setCookie('_sf_gclid', gclid);
  const ttclid = q.get('ttclid');
  if (ttclid && TTCLID.test(ttclid)) setCookie('_sf_ttclid', ttclid);
}

const stubHit = (kind: Tag['kind'], id: string, eventName: string, eventId?: string) =>
  void fetch('/api/storefront/stub-pixel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, pixelId: id, eventName, eventId }), keepalive: true }).catch(() => null);
const script = (src: string) => { const s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); };

function loadMeta(t: Tag) {
  if (t.stub) {
    const ids = new Set<string>(Object.values(window.__sfTags ?? {}).filter((x) => x.kind === 'meta' && x.stub).map((x) => x.id));
    ids.add(t.id);
    window.fbq = ((cmd: string, eventName?: string, _p?: unknown, opts?: { eventID?: string }) => {
      if (cmd === 'track' && eventName) ids.forEach((id) => stubHit('meta', id, eventName, opts?.eventID));
    }) as Fbq;
    return;
  }
  if (!window.fbq) {
    // Meta's standard base code, minus the inline <script>.
    const n = function (...args: unknown[]) { n.callMethod ? n.callMethod(...args) : n.queue!.push(args); } as Fbq;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    window.fbq = n; window._fbq = n;
    script('https://connect.facebook.net/en_US/fbevents.js');
  }
  window.fbq('init', t.id); // several Pixels on one page: every track goes to each
}
function loadGtag(t: Tag) {
  if (t.stub) return; // stub: hits are posted directly in track()
  if (!window.gtag) {
    window.dataLayer = window.dataLayer ?? [];
    window.gtag = function (...a: unknown[]) { window.dataLayer!.push(a); };
    window.gtag('js', new Date());
    script(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(t.id)}`);
  }
  window.gtag('config', t.id);
}
function loadTikTok(t: Tag) {
  if (!t.stub) {
    if (!window.ttq) {
      // TikTok's base code, minus the inline <script>: queue calls until events.js loads.
      window.TiktokAnalyticsObject = 'ttq';
      const q: unknown[] = [];
      const ttq = q as unknown as Ttq;
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
      for (const m of ttq.methods) (ttq as Record<string, unknown>)[m] = (...a: unknown[]) => { q.push([m, ...a]); };
      window.ttq = ttq;
    }
    script(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(t.id)}&lib=ttq`);
  } else if (!cookie('_ttp')) {
    setCookie('_ttp', `sf.${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`); // what TikTok's pixel sets
  }
}

/** Load every tag the store uses (owned + managed). Safe to call again; each tag loads once. */
export function loadTags(tags: Tag[]) {
  if (getConsent() !== 'granted' || !tags.length) return;
  captureClickIds();
  window.__sfTags = window.__sfTags ?? {};
  for (const t of tags) {
    const k = `${t.kind}:${t.id}`;
    if (window.__sfTags[k]) continue;
    if (t.kind === 'meta') loadMeta(t);
    else if (t.kind === 'gtag') loadGtag(t);
    else loadTikTok(t);
    window.__sfTags[k] = t;
  }
}
/** Slice-3 entry point (owned Pixel only). */
export function loadPixel(pixelId: string, stub: boolean) { loadTags([{ kind: 'meta', id: pixelId, stub }]); }

type Ev = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase';
const TIKTOK_EVENT: Record<Ev, string> = { PageView: 'PageView', ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment' };

/**
 * One call fans out to every loaded tag. `eventId` is the server's event id (order_<id>);
 * `transactionId` is what Google's conversion tag dedupes on (the order id).
 */
export function track(eventName: Ev, params?: Record<string, unknown>, eventId?: string, transactionId?: string) {
  if (getConsent() !== 'granted') return;
  const tags = Object.values(window.__sfTags ?? {});
  if (window.fbq && tags.some((t) => t.kind === 'meta')) window.fbq('track', eventName, params ?? {}, eventId ? { eventID: eventId } : undefined);
  for (const t of tags) {
    if (t.kind === 'tiktok') {
      const e = TIKTOK_EVENT[eventName];
      if (t.stub) { if (eventName !== 'PageView') stubHit('tiktok', t.id, e, eventId); }
      else if (eventName === 'PageView') window.ttq?.page();
      else window.ttq?.track(e, { ...(params ?? {}), content_type: 'product' }, eventId ? { event_id: eventId } : undefined);
    }
    if (t.kind === 'gtag' && eventName === 'Purchase') {
      if (t.stub) stubHit('gtag', t.id, 'purchase', transactionId);
      else window.gtag?.('event', 'conversion', { send_to: t.sendTo ?? t.id, value: params?.value, currency: params?.currency, transaction_id: transactionId });
    }
  }
}

/** Sent with checkout: the server only keeps (and only sends to the ad platforms) these with consent. */
export function attribution() {
  const consent = getConsent() === 'granted';
  if (!consent) return { consent: false };
  const fbp = cookie('_fbp');
  const fbc = cookie('_fbc');
  const gclid = cookie('_sf_gclid');
  const ttclid = cookie('_sf_ttclid');
  const ttp = cookie('_ttp');
  return {
    consent: true,
    ...(fbp && FB_COOKIE.test(fbp) ? { fbp } : {}),
    ...(fbc && FB_COOKIE.test(fbc) ? { fbc } : {}),
    ...(gclid && GCLID.test(gclid) ? { gclid } : {}),
    ...(ttclid && TTCLID.test(ttclid) ? { ttclid } : {}),
    ...(ttp && TTP.test(ttp) ? { ttp } : {}),
    sourceUrl: location.href.slice(0, 2000),
  };
}
