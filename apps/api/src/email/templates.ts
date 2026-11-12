import { emailPalette } from './palette';

export type EmailKindName = 'ORDER_CONFIRMED' | 'ORDER_SHIPPED' | 'ORDER_DELIVERED' | 'ORDER_REFUNDED';

export type EmailContext = {
  store: { name: string; shopUrl: string };
  order: {
    id: string;
    number: string; // short, human
    createdAt: Date;
    customerName: string;
    currency: string;
    lines: { title: string; quantity: number; unitPriceCents: number }[];
    subtotalCents: number;
    shippingCents: number;
    totalCents: number;
    refundedCents: number;
    shipTo: string[];
    eta: { minDays: number; maxDays: number } | null;
  };
  tracking?: { carrier: string | null; number: string; url: string } | null;
  refund?: { amountCents: number } | null;
};

export type Rendered = { subject: string; html: string; text: string; preheader: string };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export function etaWindow(createdAt: Date, eta: { minDays: number; maxDays: number } | null) {
  if (!eta) return null;
  return { from: day(addDays(createdAt, eta.minDays)), to: day(addDays(createdAt, eta.maxDays)), ...eta };
}

/** Public carrier tracking pages; unknown carriers fall back to 17TRACK (multi-carrier). */
export function trackingUrl(carrier: string | null | undefined, number: string): string {
  const n = encodeURIComponent(number);
  const c = (carrier ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (c === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c === 'ups') return `https://www.ups.com/track?tracknum=${n}`;
  if (c === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.startsWith('dhl')) return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${n}`;
  if (c === 'yunexpress') return `https://www.yuntrack.com/parcelTracking?id=${n}`;
  return `https://t.17track.net/en#nums=${n}`;
}

const FONT_DISPLAY = "'Bricolage Grotesque', 'Instrument Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_UI = "'Instrument Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const STEPS = ['Paid', 'With supplier', 'Shipped', 'Delivered'] as const;
const stepFor: Record<EmailKindName, number> = { ORDER_CONFIRMED: 0, ORDER_SHIPPED: 2, ORDER_DELIVERED: 3, ORDER_REFUNDED: -1 };

function copy(kind: EmailKindName, c: EmailContext) {
  const first = c.order.customerName.trim().split(/\s+/)[0] || 'there';
  const cur = c.order.currency;
  const w = etaWindow(c.order.createdAt, c.order.eta);
  const s = c.store.name;
  const n = c.order.number;
  switch (kind) {
    case 'ORDER_CONFIRMED':
      return {
        subject: `Order confirmed: ${s} #${n}`,
        kicker: 'Order confirmed',
        title: `Thanks, ${first}. Your order is in.`,
        preheader: `${money(c.order.totalCents, cur)} paid.${w ? ` Expected ${w.from} – ${w.to}.` : ''} Tracking comes by email when it ships.`,
        body: [
          `We've charged ${money(c.order.totalCents, cur)} to your card. ${s} now sends your order to its supplier.`,
          `You'll get one more email with a tracking number as soon as it ships. No account needed.`,
        ],
        cta: { label: 'Visit the shop', href: c.store.shopUrl },
      };
    case 'ORDER_SHIPPED':
      return {
        subject: `Shipped: ${s} #${n} is on its way`,
        kicker: 'Shipped',
        title: 'Your order is on its way.',
        preheader: `${c.tracking?.carrier ?? 'Carrier'} ${c.tracking?.number ?? ''}${w ? ` · expected by ${w.to}` : ''}`,
        body: [
          `It left the warehouse${c.tracking?.carrier ? ` with ${c.tracking.carrier}` : ''}. Tracking can take a day to show the first scan.`,
        ],
        cta: c.tracking ? { label: `Track${c.tracking.carrier ? ` with ${c.tracking.carrier}` : ' your package'}`, href: c.tracking.url } : { label: 'Visit the shop', href: c.store.shopUrl },
      };
    case 'ORDER_DELIVERED':
      return {
        subject: `Delivered: ${s} #${n}`,
        kicker: 'Delivered',
        title: 'Delivered. Enjoy it.',
        preheader: `The carrier marked order #${n} as delivered.`,
        body: [`The carrier marked your package as delivered. If something's missing or damaged, just reply to this email and ${s} will sort it out.`],
        cta: { label: 'Visit the shop', href: c.store.shopUrl },
      };
    case 'ORDER_REFUNDED': {
      const amt = c.refund?.amountCents ?? 0;
      const full = c.order.refundedCents >= c.order.totalCents;
      return {
        subject: `Refund issued: ${s} #${n}`,
        kicker: full ? 'Refunded' : 'Partial refund',
        title: `We've refunded ${money(amt, cur)}.`,
        preheader: `${money(amt, cur)} is on its way back to your card. Banks usually show it in 5–10 business days.`,
        body: [
          `It goes back to the card you paid with. Banks usually show it within 5–10 business days.`,
          full ? 'This order is now fully refunded.' : `Refunded so far: ${money(c.order.refundedCents, cur)} of ${money(c.order.totalCents, cur)}.`,
        ],
        cta: { label: 'Visit the shop', href: c.store.shopUrl },
      };
    }
  }
}

export function renderOrderEmail(kind: EmailKindName, c: EmailContext): Rendered {
  const p = emailPalette();
  const k = copy(kind, c);
  const cur = c.order.currency;
  const w = etaWindow(c.order.createdAt, c.order.eta);
  const step = stepFor[kind];

  const stepper =
    step < 0
      ? ''
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr>${STEPS.map((label, i) => {
          const done = i <= step;
          const now = i === step;
          const bg = now ? p.money : done ? p.surface2 : p.surface;
          const fg = now ? p.onMoney : done ? p.ink : p.muted;
          const border = now ? p.money : p.line;
          return `<td width="25%" style="padding:0 3px"><div style="background:${bg};color:${fg};border:2px solid ${border};border-radius:999px;padding:7px 4px;text-align:center;font:${now ? 700 : 500} 12px/1.2 ${FONT_UI};white-space:nowrap">${done ? '&#10003;&nbsp;' : ''}${esc(label)}</div></td>`;
        }).join('')}</tr></table>`;

  const fact = (label: string, value: string, sub?: string) =>
    `<td valign="top" style="padding:14px 16px;background:${p.surface2};border-radius:14px"><div style="font:600 11px/1.4 ${FONT_MONO};letter-spacing:.08em;text-transform:uppercase;color:${p.moneyInk}">${esc(label)}</div><div style="font:700 17px/1.35 ${FONT_DISPLAY};color:${p.ink};margin-top:4px">${value}</div>${sub ? `<div style="font:400 13px/1.45 ${FONT_UI};color:${p.muted};margin-top:2px">${esc(sub)}</div>` : ''}</td>`;

  let facts = '';
  if (kind === 'ORDER_SHIPPED' && c.tracking) {
    facts = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>${fact('Tracking number', `<span style="font-family:${FONT_MONO}">${esc(c.tracking.number)}</span>`, c.tracking.carrier ?? undefined)}<td width="10"></td>${w ? fact('Expected by', esc(w.to), `${w.minDays}–${w.maxDays} days from your order`) : ''}</tr></table>`;
  } else if (kind === 'ORDER_REFUNDED' && c.refund) {
    facts = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>${fact('Refunded', esc(money(c.refund.amountCents, cur)), 'to your original card')}<td width="10"></td>${fact('Order total', esc(money(c.order.totalCents, cur)), `Refunded so far ${money(c.order.refundedCents, cur)}`)}</tr></table>`;
  } else if (kind === 'ORDER_CONFIRMED' && w) {
    facts = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>${fact('Expected delivery', `${esc(w.from)} – ${esc(w.to)}`, `${w.minDays}–${w.maxDays} days. Ships from the supplier's warehouse.`)}<td width="10"></td>${fact('Paid', esc(money(c.order.totalCents, cur)), 'Card, via Stripe')}</tr></table>`;
  }

  const row = (l: string, r: string, strong = false, color = p.ink) =>
    `<tr><td style="padding:6px 0;font:${strong ? 700 : 400} 14px/1.4 ${FONT_UI};color:${color}">${l}</td><td align="right" style="padding:6px 0;font:${strong ? 700 : 500} 14px/1.4 ${FONT_MONO};color:${color};white-space:nowrap">${r}</td></tr>`;

  const items = c.order.lines
    .map(
      (l) =>
        `<tr><td style="padding:10px 0;border-bottom:2px solid ${p.line};font:500 14px/1.4 ${FONT_UI};color:${p.ink}">${esc(l.title)} <span style="color:${p.muted}">× ${l.quantity}</span></td><td align="right" style="padding:10px 0;border-bottom:2px solid ${p.line};font:500 14px/1.4 ${FONT_MONO};color:${p.ink};white-space:nowrap">${esc(money(l.unitPriceCents * l.quantity, cur))}</td></tr>`,
    )
    .join('');

  const totals =
    row('Items', esc(money(c.order.subtotalCents, cur))) +
    row('Shipping', c.order.shippingCents ? esc(money(c.order.shippingCents, cur)) : 'Free') +
    row('Total', esc(money(c.order.totalCents, cur)), true) +
    (c.order.refundedCents ? row('Refunded', `−${esc(money(c.order.refundedCents, cur))}`, false, p.ok) : '');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(k.subject)}</title></head>
<body style="margin:0;padding:0;background:${p.canvas};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${p.canvas}">${esc(k.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${p.canvas}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
  <tr><td style="background:${p.band};border-radius:18px 18px 0 0;padding:22px 28px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:800 22px/1.1 ${FONT_DISPLAY};letter-spacing:-.02em;color:${p.onBand}"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;background:${p.money};margin-right:8px;vertical-align:1px"></span>${esc(c.store.name)}</td>
      <td align="right" style="font:500 12px/1.2 ${FONT_MONO};color:${p.bandMuted};letter-spacing:.04em">ORDER #${esc(c.order.number)}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${p.surface};border:2px solid ${p.line};border-top:0;border-radius:0 0 18px 18px;padding:30px 28px 28px">
    <div style="font:600 12px/1.4 ${FONT_MONO};letter-spacing:.1em;text-transform:uppercase;color:${p.moneyInk}">${esc(k.kicker)}</div>
    <h1 style="margin:8px 0 12px;font:800 30px/1.12 ${FONT_DISPLAY};letter-spacing:-.025em;color:${p.ink}">${esc(k.title)}</h1>
    ${k.body.map((t) => `<p style="margin:0 0 10px;font:400 16px/1.55 ${FONT_UI};color:${p.ink}">${esc(t)}</p>`).join('')}
    ${stepper}
    ${facts}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 6px"><tr><td style="background:${p.brand};border-radius:14px;box-shadow:0 3px 0 ${p.band}">
      <a href="${esc(k.cta.href)}" style="display:inline-block;padding:13px 22px;font:700 15px/1 ${FONT_UI};color:${p.onBrand};text-decoration:none">${esc(k.cta.label)} &rarr;</a>
    </td></tr></table>
    <h2 style="margin:28px 0 6px;font:700 16px/1.3 ${FONT_DISPLAY};color:${p.ink}">What you ordered</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">${totals}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
      <td valign="top" style="padding:14px 16px;border:2px solid ${p.line};border-radius:14px">
        <div style="font:600 11px/1.4 ${FONT_MONO};letter-spacing:.08em;text-transform:uppercase;color:${p.muted}">Shipping to</div>
        <div style="font:400 14px/1.55 ${FONT_UI};color:${p.ink};margin-top:4px">${c.order.shipTo.map(esc).join('<br>')}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 28px 0;font:400 13px/1.6 ${FONT_UI};color:${p.muted}">
    Questions? Reply to this email and it goes straight to ${esc(c.store.name)}.<br>
    Sold by ${esc(c.store.name)} · card payments by Stripe · shop built on StoreForge.<br>
    <span style="font-family:${FONT_MONO};font-size:11px">Ref ${esc(c.order.id)}</span>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${c.store.name} · Order #${c.order.number}`,
    '',
    k.kicker.toUpperCase(),
    k.title,
    '',
    ...k.body,
    ...(kind === 'ORDER_SHIPPED' && c.tracking ? ['', `Tracking: ${c.tracking.carrier ?? ''} ${c.tracking.number}`.trim(), c.tracking.url] : []),
    ...(w && kind !== 'ORDER_REFUNDED' && kind !== 'ORDER_DELIVERED' ? ['', `Expected delivery: ${w.from} – ${w.to} (${w.minDays}–${w.maxDays} days from your order)`] : []),
    '',
    'What you ordered:',
    ...c.order.lines.map((l) => `  ${l.title} × ${l.quantity}  ${money(l.unitPriceCents * l.quantity, cur)}`),
    `  Items     ${money(c.order.subtotalCents, cur)}`,
    `  Shipping  ${c.order.shippingCents ? money(c.order.shippingCents, cur) : 'Free'}`,
    `  Total     ${money(c.order.totalCents, cur)}`,
    ...(c.order.refundedCents ? [`  Refunded  -${money(c.order.refundedCents, cur)}`] : []),
    '',
    'Shipping to:',
    ...c.order.shipTo.map((l) => `  ${l}`),
    '',
    `${k.cta.label}: ${k.cta.href}`,
    '',
    `Questions? Reply to this email and it goes straight to ${c.store.name}.`,
    `Ref ${c.order.id}`,
  ].join('\n');

  return { subject: k.subject, html, text, preheader: k.preheader };
}
