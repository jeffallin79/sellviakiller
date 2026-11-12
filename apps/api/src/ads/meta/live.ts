import { createHmac } from 'node:crypto';
import {
  MetaApiError, META_SCOPES, type CapiEvent, type CapiResult, type MetaAdAccount, type MetaInsightRow,
  type MetaMarketingClient, type MetaPage, type MetaPixel, type MetaStatus,
} from './types';

/** Real Graph API client. Every call carries appsecret_proof (required by "Require App Secret" apps). */
export class LiveMetaClient implements MetaMarketingClient {
  readonly mode = 'live' as const;
  private readonly base: string;
  constructor(
    private readonly appId = process.env.META_APP_ID ?? '',
    private readonly appSecret = process.env.META_APP_SECRET ?? '',
    private readonly version = process.env.META_GRAPH_VERSION ?? 'v26.0',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://graph.facebook.com/${version}`;
  }

  private proof(token: string) {
    return createHmac('sha256', this.appSecret).update(token).digest('hex');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, token: string | null, params: Record<string, unknown> = {}): Promise<T> {
    const q = new URLSearchParams();
    const body: Record<string, unknown> = {};
    const all = { ...params, ...(token ? { access_token: token, appsecret_proof: this.proof(token) } : {}) };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || v === null) continue;
      if (method === 'GET') q.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      else body[k] = v;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${path}${method === 'GET' ? `?${q}` : ''}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new MetaApiError(`Meta API unreachable: ${e instanceof Error ? e.message : e}`, { status: 0, isTransient: true });
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const er = json?.error ?? {};
      throw new MetaApiError(er.error_user_msg || er.message || `Meta API ${res.status}`, {
        status: res.status, code: er.code, subcode: er.error_subcode, type: er.type, isTransient: er.is_transient, fbtraceId: er.fbtrace_id,
      });
    }
    return json as T;
  }

  private async paged<T>(path: string, token: string, params: Record<string, unknown>): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r: any = await this.call('GET', path, token, { ...params, limit: 100, ...(after ? { after } : {}) });
      out.push(...(r.data ?? []));
      after = r.paging?.cursors?.after;
      if (!r.paging?.next || !after) break;
    }
    return out;
  }

  authorizeUrl(o: { state: string; redirectUri: string }) {
    const q = new URLSearchParams({ client_id: this.appId, redirect_uri: o.redirectUri, state: o.state, response_type: 'code', scope: META_SCOPES.join(',') });
    if (process.env.META_LOGIN_CONFIG_ID) q.set('config_id', process.env.META_LOGIN_CONFIG_ID); // Facebook Login for Business
    return `https://www.facebook.com/${this.version}/dialog/oauth?${q}`;
  }

  async exchangeCode(o: { code: string; redirectUri: string }) {
    const short: any = await this.call('GET', 'oauth/access_token', null, { client_id: this.appId, client_secret: this.appSecret, redirect_uri: o.redirectUri, code: o.code });
    const long: any = await this.call('GET', 'oauth/access_token', null, {
      grant_type: 'fb_exchange_token', client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: short.access_token,
    });
    const perms: any = await this.call('GET', 'me/permissions', long.access_token);
    const scopes = (perms.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
    return { accessToken: long.access_token as string, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null, scopes };
  }

  me(token: string) {
    return this.call<{ id: string; name: string }>('GET', 'me', token, { fields: 'id,name' });
  }

  async listAdAccounts(token: string): Promise<MetaAdAccount[]> {
    const rows = await this.paged<any>('me/adaccounts', token, { fields: 'id,account_id,name,currency,account_status,timezone_name,business{name}' });
    return rows.map((a) => ({
      id: a.id, accountId: a.account_id, name: a.name, currency: a.currency, accountStatus: a.account_status, timezone: a.timezone_name ?? null, businessName: a.business?.name ?? null,
    }));
  }

  async listPages(token: string): Promise<MetaPage[]> {
    return (await this.paged<any>('me/accounts', token, { fields: 'id,name' })).map((p) => ({ id: p.id, name: p.name }));
  }

  async listPixels(token: string, adAccountId: string): Promise<MetaPixel[]> {
    return (await this.paged<any>(`${adAccountId}/adspixels`, token, { fields: 'id,name' })).map((p) => ({ id: p.id, name: p.name }));
  }

  async findCampaignByTag(token: string, adAccountId: string, tag: string) {
    const rows = await this.paged<any>(`${adAccountId}/campaigns`, token, {
      fields: 'id,name',
      filtering: [{ field: 'name', operator: 'CONTAIN', value: tag }],
    });
    return rows[0] ? { id: rows[0].id as string } : null;
  }

  createCampaign(token: string, adAccountId: string, o: { name: string; status: MetaStatus }) {
    return this.call<{ id: string }>('POST', `${adAccountId}/campaigns`, token, {
      name: o.name, objective: 'OUTCOME_SALES', status: o.status, special_ad_categories: [], is_adset_budget_sharing_enabled: false,
    });
  }

  createAdSet(token: string, adAccountId: string, o: { campaignId: string; name: string; dailyBudgetMinor: number; pixelId: string; countries: string[]; status: MetaStatus }) {
    return this.call<{ id: string }>('POST', `${adAccountId}/adsets`, token, {
      name: o.name,
      campaign_id: o.campaignId,
      daily_budget: o.dailyBudgetMinor,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      promoted_object: { pixel_id: o.pixelId, custom_event_type: 'PURCHASE' },
      targeting: { geo_locations: { countries: o.countries }, targeting_automation: { advantage_audience: 1 } },
      status: o.status,
    });
  }

  createCreative(token: string, adAccountId: string, o: { name: string; pageId: string; link: string; message: string; headline: string; imageUrl?: string | null }) {
    return this.call<{ id: string }>('POST', `${adAccountId}/adcreatives`, token, {
      name: o.name,
      object_story_spec: {
        page_id: o.pageId,
        link_data: { link: o.link, message: o.message, name: o.headline, ...(o.imageUrl ? { picture: o.imageUrl } : {}), call_to_action: { type: 'SHOP_NOW', value: { link: o.link } } },
      },
    });
  }

  createAd(token: string, adAccountId: string, o: { name: string; adSetId: string; creativeId: string; status: MetaStatus }) {
    return this.call<{ id: string }>('POST', `${adAccountId}/ads`, token, { name: o.name, adset_id: o.adSetId, creative: { creative_id: o.creativeId }, status: o.status });
  }

  async setStatus(token: string, objectId: string, status: MetaStatus) {
    await this.call('POST', objectId, token, { status });
  }

  async getCampaign(token: string, campaignId: string) {
    const r: any = await this.call('GET', campaignId, token, { fields: 'id,status,effective_status' });
    return { id: r.id, status: r.status, effectiveStatus: r.effective_status };
  }

  async insights(token: string, campaignId: string, range: { since: string; until: string }): Promise<MetaInsightRow[]> {
    return this.paged<MetaInsightRow>(`${campaignId}/insights`, token, {
      time_range: range,
      time_increment: 1,
      level: 'campaign',
      fields: 'date_start,date_stop,impressions,clicks,spend,actions,action_values',
    });
  }

  sendEvents(token: string, pixelId: string, events: CapiEvent[], testEventCode?: string | null) {
    return this.call<CapiResult>('POST', `${pixelId}/events`, token, { data: events, ...(testEventCode ? { test_event_code: testEventCode } : {}) });
  }
}
