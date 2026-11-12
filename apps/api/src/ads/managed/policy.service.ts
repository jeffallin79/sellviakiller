import { prisma } from '@storeforge/db';

export type Finding = { rule: string; level: 'warn' | 'block'; field: string; message: string; match?: string };
export type PolicyResult = { result: 'pass' | 'warn' | 'block'; rules: string[]; findings: Finding[] };

/**
 * Pre-launch policy scan shared by Meta, Google and TikTok (blueprint: ads.policy-scan). Catches the
 * usual rejections before a platform does: prohibited categories, health / income / weight-loss
 * claims, before-after, personal attributes, ALL CAPS and gimmicky punctuation, and landing-page
 * basics (price + delivery time shown). "block" stops launch; "warn" is shown but allowed.
 * Platform review verdicts are stored as PolicyCheck rows too (source = meta | google | tiktok).
 */
const PROHIBITED_CATEGORY = /\b(weapon|firearm|ammo|ammunition|vape|e-?cig|cbd|thc|cannabis|tobacco|kratom|steroid|prescription|replica|counterfeit|adult toy|spy ?cam)\b/i;
const RULES: { id: string; level: 'warn' | 'block'; re: RegExp; message: string }[] = [
  { id: 'claims.health_cure', level: 'block', re: /\b(cure[sd]?|heals?|treats?|prevents?) (cancer|diabetes|anxiety|depression|arthritis|covid|disease|acne|pain)\b|\bcure[sd]?\b/i, message: 'Medical claims (cures, treats, prevents) are not allowed in ads.' },
  { id: 'claims.weight_loss', level: 'block', re: /\b(lose|drop|burn) \d+ ?(lb|lbs|kg|pounds|kilos)\b|\bfat burn(ing|er)\b/i, message: 'Specific weight-loss claims are not allowed.' },
  { id: 'claims.miracle', level: 'block', re: /\b(miracle|magic(al)? (pill|cure)|instant results?)\b/i, message: 'Miracle / instant-result claims get ads rejected.' },
  { id: 'claims.guarantee', level: 'block', re: /\bguaranteed? (results?|income|earnings|profit)\b|\b100% (guaranteed|effective)\b/i, message: 'Guaranteed results or income claims are not allowed.' },
  { id: 'claims.before_after', level: 'warn', re: /\bbefore (and|&) after\b/i, message: 'Before/after framing is restricted on Meta and TikTok.' },
  { id: 'personal.attributes', level: 'warn', re: /\b(are you|do you (have|suffer))\b.{0,30}\b(overweight|fat|depressed|bald|single|broke|in debt|diabetic)\b/i, message: 'Don’t assert things about the viewer (personal attributes).' },
  { id: 'claims.superlative', level: 'warn', re: /(?<![\w#])#1\b|\b(number one|best in the world|world'?s best)\b/i, message: 'Unprovable superlatives may be rejected; Google needs third-party proof.' },
  { id: 'style.all_caps', level: 'warn', re: /\b[A-Z]{5,}\b(?:\s+\b[A-Z]{3,}\b)+/, message: 'Avoid ALL-CAPS words (Google rejects excessive capitalisation).' },
  { id: 'style.punctuation', level: 'warn', re: /[!?]{2,}|!.*!/, message: 'Use at most one exclamation mark (Google: excessive punctuation).' },
  { id: 'style.symbols', level: 'warn', re: /[★☆✓✔→➡💯🔥]{1}|\${2,}/u, message: 'Gimmicky symbols are not allowed in Google text ads.' },
];

export class PolicyService {
  scan(o: { title: string; category?: string | null; texts: { field: string; text: string }[]; landing: { priceCents: number | null; etaDaysMin: number | null; etaDaysMax: number | null; https: boolean } }): PolicyResult {
    const findings: Finding[] = [];
    if (PROHIBITED_CATEGORY.test(`${o.title} ${o.category ?? ''}`)) findings.push({ rule: 'category.prohibited', level: 'block', field: 'product', message: 'This product category can’t be advertised on Meta, Google or TikTok.', match: PROHIBITED_CATEGORY.exec(`${o.title} ${o.category ?? ''}`)?.[0] });
    for (const t of o.texts) {
      for (const r of RULES) {
        const m = r.re.exec(t.text);
        if (m) findings.push({ rule: r.id, level: r.level, field: t.field, message: r.message, match: m[0] });
      }
    }
    if (!o.landing.priceCents || o.landing.priceCents <= 0) findings.push({ rule: 'landing.no_price', level: 'block', field: 'landing', message: 'The product page must show a price.' });
    if (o.landing.etaDaysMin == null || o.landing.etaDaysMax == null) findings.push({ rule: 'landing.no_eta', level: 'warn', field: 'landing', message: 'Show the delivery time on the product page.' });
    else if (o.landing.etaDaysMax > 30) findings.push({ rule: 'landing.long_eta', level: 'warn', field: 'landing', message: 'Delivery over 30 days gets more complaints and lower ad quality.' });
    if (!o.landing.https) findings.push({ rule: 'landing.not_https', level: 'warn', field: 'landing', message: 'Live ads need an https product page (Google Merchant Center rejects http).' });
    const result = findings.some((f) => f.level === 'block') ? 'block' : findings.length ? 'warn' : 'pass';
    return { result, rules: [...new Set(findings.map((f) => f.rule))], findings };
  }
  async record(groupId: string, r: PolicyResult, source = 'storeforge', creativeId: string | null = null) {
    return prisma.policyCheck.create({ data: { groupId, creativeId, rules: r.rules, result: r.result, findings: r.findings as any, source } });
  }
}
