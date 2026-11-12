import { Resolver } from 'node:dns/promises';

/** What the verifier needs to know about a host's DNS. Every field is best-effort (missing → []). */
export interface DnsSnapshot {
  txt: string[]; // values at _storeforge.<host>, chunks joined
  cname: string[]; // CNAME targets of <host>, lower-case, no trailing dot
  a: string[]; // A records of <host> (after CNAME flattening by the resolver)
}

export interface DnsLookup {
  readonly mode: 'live' | 'stub';
  lookup(host: string, ctx: { devDnsSimulatedAt: Date | null; expectedTxt: string; expectedTarget: string; apexIps: string[] }): Promise<DnsSnapshot>;
  resolveA(host: string): Promise<string[]>;
}

const clean = (s: string) => s.toLowerCase().replace(/\.+$/, '');

/** Real public DNS. Uses DOMAIN_DNS_SERVERS (default 1.1.1.1, 8.8.8.8) so local /etc/hosts never fakes a pass. */
export class LiveDns implements DnsLookup {
  readonly mode = 'live' as const;
  private resolver: Resolver;
  constructor(servers = (process.env.DOMAIN_DNS_SERVERS ?? '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean)) {
    this.resolver = new Resolver({ timeout: 4000, tries: 2 });
    if (servers.length) this.resolver.setServers(servers);
  }
  private async safe<T>(p: Promise<T>, fallback: T): Promise<T> {
    try {
      return await p;
    } catch {
      return fallback; // ENODATA / ENOTFOUND / timeout → "not there yet"
    }
  }
  async lookup(host: string) {
    const [txt, cname, a] = await Promise.all([
      this.safe(this.resolver.resolveTxt(`_storeforge.${host}`), [] as string[][]),
      this.safe(this.resolver.resolveCname(host), [] as string[]),
      this.safe(this.resolver.resolve4(host), [] as string[]),
    ]);
    return { txt: txt.map((chunks) => chunks.join('')), cname: cname.map(clean), a };
  }
  resolveA(host: string) {
    return this.safe(this.resolver.resolve4(host), [] as string[]);
  }
}

/**
 * Dev/stub DNS. Nothing is looked up. Records "exist" only after the merchant presses
 * "Simulate DNS" in admin (devDnsSimulatedAt), so every state can be walked locally.
 */
export class StubDns implements DnsLookup {
  readonly mode = 'stub' as const;
  async lookup(_host: string, ctx: { devDnsSimulatedAt: Date | null; expectedTxt: string; expectedTarget: string }) {
    if (!ctx.devDnsSimulatedAt) return { txt: [], cname: [], a: [] };
    return { txt: [ctx.expectedTxt], cname: [ctx.expectedTarget], a: [] };
  }
  async resolveA() {
    return [] as string[];
  }
}

let override: DnsLookup | null = null;
export function getDns(): DnsLookup {
  if (override) return override;
  return process.env.DOMAIN_DNS_MODE === 'live' ? new LiveDns() : new StubDns();
}
export function setDnsForTests(d: DnsLookup | null) {
  override = d;
}
