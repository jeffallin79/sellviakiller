import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { prisma, Prisma, type AdAccount } from '@storeforge/db';
import { getManagedChannel } from './adapters';
import { PlatformError, type AccountRef, type ServerConversion } from './types';

export const MAX_DELIVERY_ATTEMPTS = 8;
const backoffMs = (attempts: number) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Google enhanced conversions: lower-case, trim, and drop dots in the local part of gmail/googlemail addresses. */
export const googleEmailHash = (email: string) => {
  const e = email.trim().toLowerCase();
  const [local, domain] = e.split('@');
  return sha(domain === 'gmail.com' || domain === 'googlemail.com' ? `${local.replace(/\./g, '')}@${domain}` : e);
};
export const refOf = (a: Pick<AdAccount, 'externalId' | 'currency' | 'timezone' | 'merchantCenterId' | 'dataSourceId' | 'catalogId' | 'pixelId' | 'pageId' | 'conversionActionId' | 'conversionTag' | 'billingRef'>): AccountRef => ({
  externalId: a.externalId, currency: a.currency, timezone: a.timezone, merchantCenterId: a.merchantCenterId, dataSourceId: a.dataSourceId, catalogId: a.catalogId,
  pixelId: a.pixelId, pageId: a.pageId, conversionActionId: a.conversionActionId, conversionTag: a.conversionTag, billingRef: a.billingRef,
});

/**
 * Server-side purchase for every managed account of the store that runs ads: Meta CAPI (our
 * Business pixel), Google enhanced conversions (ENHANCEMENT by order id = gtag transaction_id) and
 * TikTok Events API (CompletePayment, event_id shared with the browser pixel). One
 * ConversionDelivery per (event, account): a replay can't create a second one; sending is claimed
 * by compare-and-set on attempts and retried with backoff (max 8, then failed).
 */
export class ManagedConversions {
  private readonly logger = new Logger(ManagedConversions.name);
  readonly inflight = new Set<Promise<unknown>>();
  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }

  /** Managed accounts of a store that have launched at least one campaign */
  accountsFor(storeId: string) {
    return prisma.adAccount.findMany({ where: { storeId, mode: 'MANAGED', status: 'active', provisionStatus: 'ready', campaigns: { some: { launchedAt: { not: null } } } } });
  }

  async createFor(conversionEventId: string, accounts: AdAccount[]) {
    if (!accounts.length) return 0;
    const r = await prisma.conversionDelivery.createMany({ data: accounts.map((a) => ({ conversionEventId, adAccountId: a.id, channel: a.channel, testCode: a.testEventCode })), skipDuplicates: true });
    const rows = await prisma.conversionDelivery.findMany({ where: { conversionEventId, status: 'pending' }, select: { id: true } });
    for (const d of rows) {
      const p = this.dispatch(d.id).catch(() => null).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
    return r.count;
  }

  private build(ev: { eventId: string; orderId: string; payload: any }, order: { customerEmail: string; attribution: any; totalCents: number; currency: string }): ServerConversion {
    const p = ev.payload ?? {};
    const ud = p.user_data ?? {};
    const first = (k: string) => (Array.isArray(ud[k]) ? ud[k][0] : undefined);
    const attr = order.attribution ?? {};
    return {
      eventId: ev.eventId, orderId: ev.orderId, eventTime: Number(p.event_time ?? Math.floor(Date.now() / 1000)), valueMinor: order.totalCents, currency: order.currency.toUpperCase(), sourceUrl: p.event_source_url ?? null,
      hashed: { em: first('em'), fn: first('fn'), ln: first('ln'), ct: first('ct'), st: first('st'), zp: first('zp'), country: first('country'), external_id: first('external_id'), emGoogle: order.customerEmail ? googleEmailHash(order.customerEmail) : undefined },
      ip: ud.client_ip_address ?? null, ua: ud.client_user_agent ?? null, fbp: ud.fbp ?? null, fbc: ud.fbc ?? null, gclid: attr.gclid ?? null, ttclid: attr.ttclid ?? null, ttp: attr.ttp ?? null,
      contentIds: p.custom_data?.content_ids ?? [], numItems: Number(p.custom_data?.num_items ?? 1),
    };
  }

  async dispatch(id: string): Promise<'sent' | 'retry' | 'failed' | 'skipped'> {
    const d = await prisma.conversionDelivery.findUnique({ where: { id }, include: { event: true, account: true } });
    if (!d || d.status !== 'pending') return 'skipped';
    const claim = await prisma.conversionDelivery.updateMany({ where: { id, status: 'pending', attempts: d.attempts }, data: { attempts: { increment: 1 } } });
    if (!claim.count) return 'skipped';
    const fail = async (reason: string) => { await prisma.conversionDelivery.update({ where: { id }, data: { status: 'failed', lastError: reason.slice(0, 500) } }); return 'failed' as const; };
    if (!d.event.payload) return fail('no consent payload');
    const order = await prisma.order.findUnique({ where: { id: d.event.orderId } });
    if (!order) return fail('order not found');
    const sc = this.build(d.event as any, order as any);
    if (sc.eventTime * 1000 < Date.now() - 7 * 86_400_000) return fail('event older than 7 days');
    try {
      const r = await getManagedChannel(d.channel).sendConversion(refOf(d.account), sc, d.testCode);
      await prisma.conversionDelivery.update({ where: { id }, data: { status: r.trace.startsWith('skipped') ? 'skipped' : 'sent', trace: r.trace, sentAt: new Date(), lastError: null } });
      if (d.channel === 'GOOGLE') await prisma.conversionEvent.update({ where: { id: d.conversionEventId }, data: { sentGoogle: true } });
      if (d.channel === 'TIKTOK') await prisma.conversionEvent.update({ where: { id: d.conversionEventId }, data: { sentTikTok: true } });
      return 'sent';
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient = !(e instanceof PlatformError) || e.isTransient;
      if (!transient || d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) return fail(msg);
      await prisma.conversionDelivery.update({ where: { id }, data: { lastError: msg.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMs(d.attempts + 1)) } });
      return 'retry';
    }
  }

  /** Sweeper: due retries, plus consented events (last 48 h) whose deliveries were never written. */
  async retryDue(now = new Date()) {
    const out: { id: string; result: string }[] = [];
    const since = new Date(now.getTime() - 48 * 3600_000);
    const missing = await prisma.conversionEvent.findMany({ where: { createdAt: { gt: since }, payload: { not: Prisma.DbNull } }, select: { id: true, storeId: true, payload: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    for (const ev of missing) {
      if (!ev.payload) continue;
      const accts = await this.accountsFor(ev.storeId);
      const have = await prisma.conversionDelivery.count({ where: { conversionEventId: ev.id } });
      if (accts.length > have) await this.createFor(ev.id, accts);
    }
    const due = await prisma.conversionDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, take: 100, select: { id: true } });
    for (const d of due) out.push({ id: d.id, result: await this.dispatch(d.id).catch((e) => `retry: ${e?.message ?? e}`) });
    await this.idle();
    return out;
  }
}
