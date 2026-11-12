import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export function money(cents: number | null | undefined, currency = 'USD') {
  const v = (cents ?? 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(v);
}

export function Money({ cents, currency, className = '' }: { cents: number | null | undefined; currency?: string; className?: string }) {
  return <span className={`sf-num ${className}`.trim()}>{money(cents, currency)}</span>;
}

const STATUS: Record<string, { tone: string; label: string }> = {
  PENDING_PAYMENT: { tone: 'neutral', label: 'Awaiting payment' },
  PAID: { tone: 'money', label: 'Paid' },
  AWAITING_MERCHANT_APPROVAL: { tone: 'warn', label: 'Needs your OK' },
  FULFILLMENT_SUBMITTED: { tone: 'info', label: 'With supplier' },
  SHIPPED: { tone: 'ok', label: 'Shipped' },
  DELIVERED: { tone: 'ok', label: 'Delivered' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
  REFUNDED: { tone: 'neutral', label: 'Refunded' },
  PENDING_DNS: { tone: 'warn', label: 'Waiting for DNS' },
  ISSUING_TLS: { tone: 'info', label: 'Securing (HTTPS)' },
  QUEUED: { tone: 'info', label: 'Queued' },
  SENT: { tone: 'ok', label: 'Sent' },
  FAILED: { tone: 'bad', label: 'Failed' },
  ACTIVE: { tone: 'ok', label: 'Active' },
  TRIALING: { tone: 'info', label: 'Trial' },
  PAST_DUE: { tone: 'bad', label: 'Past due' },
  INCOMPLETE: { tone: 'warn', label: 'Incomplete' },
  SUSPENDED: { tone: 'bad', label: 'Suspended' },
  SOFT_DELETED: { tone: 'neutral', label: 'Archived' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral', label: status.toLowerCase().replace(/_/g, ' ') };
  return <span className={`sf-badge sf-badge--${s.tone}`}>{s.label}</span>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'money' | 'ok' | 'warn' | 'bad' | 'info' | 'brand'; children: ReactNode }) {
  return <span className={`sf-badge sf-badge--${tone}`}>{children}</span>;
}

export function Callout({ tone = 'info', title, action, children }: { tone?: 'ok' | 'bad' | 'warn' | 'info'; title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const icon: IconName = tone === 'ok' ? 'done' : tone === 'bad' ? 'warning' : tone === 'warn' ? 'warning' : 'info';
  return (
    <div className={`sf-callout sf-callout--${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={icon} size={20} />
      <span style={{ flex: 1 }}>{title && <strong style={{ display: 'block', marginBottom: 2 }}>{title}</strong>}{children}</span>
      {action}
    </div>
  );
}

/** Decorative hand-cut paper collage (brand illustration style). */
export function Collage({ className = '' }: { className?: string }) {
  return (
    <div className={`sf-collage ${className}`.trim()} aria-hidden="true">
      <i className="c1" />
      <i className="c2" />
      <i className="c3" />
      <i className="c4" />
    </div>
  );
}

export function Bars({ values, labels, hotIndex }: { values: number[]; labels?: string[]; hotIndex?: number }) {
  const max = Math.max(1, ...values);
  const hot = hotIndex ?? values.length - 1;
  return (
    <div>
      <div className="sf-bars" role="img" aria-label={`Bar chart: ${values.map((v, i) => `${labels?.[i] ?? i + 1} ${v}`).join(', ')}`}>
        {values.map((v, i) => (
          <div key={i} className={`sf-bars__bar ${i === hot ? 'sf-bars__bar--hot' : ''}`} style={{ height: `${Math.max(5, (v / max) * 100)}%` }} />
        ))}
      </div>
      {labels && (
        <div className="sf-bars__lbl" aria-hidden="true">
          {labels.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

export { Icon } from './icons';
export type { IconName } from './icons';
