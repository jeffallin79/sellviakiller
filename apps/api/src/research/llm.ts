/**
 * Copy drafts (blueprint: OPENAI/LLM_API_KEY). Stub mode writes from templates; with LLM_API_KEY
 * it calls an OpenAI-compatible Chat Completions endpoint (LLM_BASE_URL, default OpenAI;
 * LLM_MODEL, default gpt-6-luna). Output is treated as untrusted text: length-capped, stripped of
 * markup, policy-scanned by the caller, and never published without the merchant.
 */
export type LlmRequest = { system: string; user: string; maxTokens?: number };
export interface LlmClient {
  readonly kind: 'stub' | 'openai';
  readonly model: string;
  complete(r: LlmRequest): Promise<string>;
}

export class StubLlm implements LlmClient {
  readonly kind = 'stub' as const;
  readonly model = 'template';
  async complete(): Promise<string> {
    return ''; // callers fall back to their template text
  }
}

export class OpenAiCompatibleLlm implements LlmClient {
  readonly kind = 'openai' as const;
  constructor(
    private key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    readonly model = process.env.LLM_MODEL || 'gpt-6-luna',
    private base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async complete(r: LlmRequest) {
    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }],
        max_completion_tokens: r.maxTokens ?? 600,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`llm ${res.status}: ${String(body?.error?.message ?? 'error').slice(0, 200)}`);
    return String(body?.choices?.[0]?.message?.content ?? '');
  }
}

let override: LlmClient | null = null;
export const getLlm = (): LlmClient => override ?? (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY ? new OpenAiCompatibleLlm() : new StubLlm());
export function setLlmForTests(c: LlmClient | null) {
  override = c;
}

/** Untrusted model text → plain single-paragraph string. */
export const cleanText = (s: unknown, max: number) =>
  String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
