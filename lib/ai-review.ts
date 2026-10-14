/**
 * Three language models reading a setup the engine has already built, each on
 * its own, and saying whether they would take it.
 *
 * They never set a price. The entry, stop and targets come from the tested
 * engine; a model's opinion cannot be backtested, so it is shown and recorded
 * rather than acted on. Once enough live trades carry these verdicts, the
 * record says whether trades the models agreed with actually did better, and
 * only then is it worth letting their opinion filter anything.
 *
 * Each provider runs only when its key is set. A provider that fails says why,
 * in words that never carry a key, and the others are unaffected.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { redactSecrets } from './safe-error';
import type { AiReview, InstitutionalTradingSetup, ProviderReview, ReviewProvider } from './types';

export type { AiReview, ProviderReview, ReviewProvider };
export { reviewLabel } from './ai-review-label';

const TIMEOUT_MS = 20_000;

const SYSTEM = [
  'You review XAUUSD (gold) trade setups produced by a tested structural engine.',
  'You cannot change the levels. Judge only whether you would take this trade now, given the facts provided.',
  'Answer with JSON only: {"verdict":"agree"|"doubt","confidence":0-100,"reason":"..."}.',
  'The reason is one or two short sentences in Indonesian, naming the main factor behind your verdict.',
].join(' ');

/** The facts every model sees, and nothing else. */
export function reviewPrompt(setup: InstitutionalTradingSetup, marketPrice: number | null): string {
  const lines = [
    `Order: ${setup.orderType} at ${setup.entryPrice.toFixed(2)}`,
    `Stop loss: ${setup.stopLoss.toFixed(2)}; targets: ${setup.takeProfit1.toFixed(2)}, ${setup.takeProfit2.toFixed(
      2
    )}, ${setup.takeProfit3.toFixed(2)}`,
    marketPrice !== null ? `Current price: ${marketPrice.toFixed(2)}` : null,
    typeof setup.convictionScore === 'number' ? `Engine conviction: ${setup.convictionScore}/100` : null,
    setup.tradingStyle ? `Style: ${setup.tradingStyle}` : null,
    `Engine reasoning: ${setup.institutionalRationale ?? ''}`.slice(0, 2500),
  ];
  return lines.filter(Boolean).join('\n');
}

/** Reads the JSON a model returned, tolerating code fences and stray text around it. */
export function parseVerdict(text: string | null | undefined): Pick<ProviderReview, 'verdict' | 'confidence' | 'reason'> | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { verdict?: unknown; confidence?: unknown; reason?: unknown };
    const verdict = raw.verdict === 'agree' || raw.verdict === 'doubt' ? raw.verdict : null;
    if (!verdict) return null;
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(100, Math.round(raw.confidence)))
        : null;
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 400) : '';
    return { verdict, confidence, reason };
  } catch {
    return null;
  }
}

const BILLING: Record<ReviewProvider, string> = {
  gemini: 'aistudio.google.com',
  chatgpt: 'platform.openai.com → Billing',
  claude: 'console.anthropic.com → Plans & Billing',
};

/**
 * What went wrong, in words a trader can act on. Providers answer with raw
 * JSON; the common cases are named, anything else is passed on, shortened.
 */
export function explainFailure(provider: ReviewProvider, message: string): string {
  const m = message.toLowerCase();
  if (/credit balance|no credits|insufficient_quota|exceeded your current quota|billing/.test(m)) {
    return `Kredit API habis. Isi ulang di ${BILLING[provider]}. Langganan ChatGPT Plus atau Claude Pro tidak termasuk kredit API.`;
  }
  if (/\b503\b|high demand|overloaded|unavailable|\b529\b/.test(m)) {
    return 'Model sedang sibuk. Biasanya sementara; tanya lagi beberapa menit lagi.';
  }
  if (/\b401\b|\b403\b|api key|unauthori[sz]ed|permission/.test(m)) {
    return 'API key ditolak. Cek key yang dipasang di Vercel.';
  }
  if (/\b404\b|not found|does not exist|not available/.test(m)) {
    return 'Model ini tidak tersedia untuk key tersebut. Pasang model lain di variabel *_REVIEW_MODEL.';
  }
  if (/\b429\b|rate limit/.test(m)) return 'Terlalu banyak permintaan sekaligus. Tanya lagi semenit lagi.';
  if (/within 20 seconds|timeout|timed out/.test(m)) return 'Tidak ada jawaban dalam 20 detik.';
  if (/readable verdict/.test(m)) return 'Jawaban AI tidak bisa dibaca sebagai pendapat.';
  if (/declined to review/.test(m)) return 'Model menolak meninjau setup ini.';
  return message.slice(0, 160);
}

function failure(provider: ReviewProvider, model: string, err: unknown): ProviderReview {
  const message = err instanceof Error ? err.message : String(err);
  return {
    provider,
    model,
    verdict: null,
    confidence: null,
    reason: '',
    error: explainFailure(provider, redactSecrets(message)),
  };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No answer within 20 seconds.')), TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function answered(provider: ReviewProvider, model: string, text: string | null | undefined): ProviderReview {
  const parsed = parseVerdict(text);
  if (!parsed) return failure(provider, model, new Error('The reply was not a readable verdict.'));
  return { provider, model, ...parsed };
}

/** Tried in turn when the one before is overloaded or unavailable. */
const GEMINI_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function askGemini(prompt: string): Promise<ProviderReview | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const first = process.env.GEMINI_REVIEW_MODEL?.trim() || 'gemini-flash-latest';
  const models = [first, ...GEMINI_FALLBACKS.filter((m) => m !== first)];
  const client = new GoogleGenAI({ apiKey: key });
  let last: ProviderReview | null = null;
  const started = Date.now();
  for (const model of models) {
    // The three providers are asked side by side inside one request's time;
    // a fallback is not started once most of it has gone.
    if (last && Date.now() - started > 15_000) break;
    try {
      const result = await withTimeout(
        client.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json', systemInstruction: SYSTEM },
        })
      );
      return answered('gemini', model, result.text);
    } catch (err) {
      last = failure('gemini', model, err);
      // Only a busy or missing model is worth another try; a bad key or an
      // empty balance fails the same way on every model.
      const text = err instanceof Error ? err.message : String(err);
      if (!/\b503\b|\b404\b|\b429\b|high demand|overloaded|unavailable|not found/i.test(text)) break;
    }
  }
  return last;
}

async function askChatGpt(prompt: string): Promise<ProviderReview | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const model = process.env.OPENAI_REVIEW_MODEL?.trim() || 'gpt-4o';
  try {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await withTimeout(
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
        }),
      })
    );
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    } | null;
    if (!res.ok) throw new Error(`HTTP ${res.status}${data?.error?.message ? `: ${data.error.message}` : ''}`);
    return answered('chatgpt', model, data?.choices?.[0]?.message?.content);
  } catch (err) {
    return failure('chatgpt', model, err);
  }
}

const CLAUDE_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['agree', 'doubt'] },
    confidence: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'reason'],
  additionalProperties: false,
};

async function askClaude(prompt: string): Promise<ProviderReview | null> {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)?.trim();
  if (!key) return null;
  const model = process.env.CLAUDE_REVIEW_MODEL?.trim() || 'claude-opus-5';
  try {
    const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 1 });
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM,
      // A short judgement, so a light effort; the schema guarantees the shape.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAUDE_VERDICT_SCHEMA } },
      // Should the model decline, the request is re-run on a fallback model
      // chosen by the API rather than coming back empty.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The model declined to review this setup.');
    const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return answered('claude', response.model ?? model, text);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return failure('claude', model, new Error('The API key was rejected.'));
    if (err instanceof Anthropic.NotFoundError) return failure('claude', model, new Error(`Model ${model} is not available to this key.`));
    if (err instanceof Anthropic.RateLimitError) return failure('claude', model, new Error('Rate limited; try again later.'));
    return failure('claude', model, err);
  }
}

/** Asks every configured model at once. Null when no key is configured at all. */
export async function reviewSetup(
  setup: InstitutionalTradingSetup,
  marketPrice: number | null
): Promise<AiReview | null> {
  const prompt = reviewPrompt(setup, marketPrice);
  const results = await Promise.all([askGemini(prompt), askChatGpt(prompt), askClaude(prompt)]);
  const reviews = results.filter((r): r is ProviderReview => r !== null);
  if (reviews.length === 0) return null;
  return {
    at: new Date().toISOString(),
    reviews,
    agree: reviews.filter((r) => r.verdict === 'agree').length,
    answered: reviews.filter((r) => r.verdict !== null).length,
  };
}
