import { PageHead } from '@/components/PageHead';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Collage } from '@storeforge/ui/components';

export const metadata = { title: 'Boost' };
const FEE = Number(process.env.ADS_FEE_PCT ?? 15);
const MIN = Number(process.env.ADS_MIN_DAILY_CENTS ?? 1000) / 100;

export default function BoostPage() {
  return (
    <>
      <PageHead eyebrow="Boost · ads" icon="boost" title="Boost" lede="Run ads for a product on Meta, Google and TikTok from one screen, paid from your Ad Fuel." actions={<Badge tone="warn">Not live yet</Badge>} />
      <div className="grid-2">
        <section className="sf-card sf-card--ticket">
          <h2>How Boost will work</h2>
          <ol style={{ paddingLeft: 20, display: 'grid', gap: 10 }}>
            <li>Pick a product. We draft a few ad versions; you edit or approve them.</li>
            <li>Pick channels and a daily budget (from <span className="sf-num">${MIN}</span>/day). You can raise or lower it any time.</li>
            <li>Ads start in <strong>Warming up</strong> while the platforms learn, then move to <strong>Steady</strong>.</li>
            <li>Your dashboard shows spend, fee and true profit after product cost, shipping and ads.</li>
          </ol>
          <hr className="sf-divider" />
          <p style={{ margin: 0 }}><strong>Fee:</strong> <span className="sf-num">{FEE}%</span> of ad spend, shown on every campaign. Connect your own ad account instead and the fee is <span className="sf-num">0%</span>.</p>
        </section>
        <section className="sf-card empty">
          <Collage />
          <div>
            <h3>Waiting on ad platform approvals</h3>
            <p className="sf-muted">Meta, Google Ads and TikTok each review new ad tools before they can go live. We&apos;ll switch Boost on as each one approves.</p>
            <p className="sf-muted" style={{ margin: 0 }}><Icon name="info" size={16} /> Nothing is charged until you launch a campaign.</p>
          </div>
        </section>
      </div>
    </>
  );
}
