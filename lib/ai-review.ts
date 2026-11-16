/**
 * Gemini-only second opinion for a setup already produced by the deterministic engine.
 * Gemini never sets entry, stop, or target; it only returns an optional opinion.
 */
import { GoogleGenAI } from '@google/genai';
import { redactSecrets } from './safe-error';
import type { AiReview, InstitutionalTradingSetup, ProviderReview, ReviewProvider } from './types';

export type { AiReview, ProviderReview, ReviewProvider };
export { reviewLabel } from './ai-review-label';

const TIMEOUT_MS = 20_000;
const SYSTEM = [
  'You review XAUUSD trade setups produced by a deterministic structural engine.',
  'You cannot change the levels. Judge only whether you would take this trade now, given the facts provided.',
  'Answer with JSON only: {"verdict":"agree"|"doubt","confidence":0-100,"reason":"..."}.',
  'The reason must be one or two short sentences in Indonesian.',
].join(' ');

export function reviewPrompt(setup: InstitutionalTradingSetup, marketPrice: number | null): string {
  return [
    `Order: ${setup.orderType} at ${setup.entryPrice.toFixed(2)}`,
    `Stop loss: ${setup.stopLoss.toFixed(2)}; targets: ${setup.takeProfit1.toFixed(2)}, ${setup.takeProfit2.toFixed(2)}, ${setup.takeProfit3.toFixed(2)}`,
    marketPrice !== null ? `Current price: ${marketPrice.toFixed(2)}` : null,
    typeof setup.convictionScore === 'number' ? `Engine conviction: ${setup.convictionScore}/100` : null,
    setup.tradingStyle ? `Style: ${setup.tradingStyle}` : null,
    `Engine reasoning: ${setup.institutionalRationale ?? ''}`.slice(0, 2500),
  ].filter(Boolean).join('\n');
}

export function parseVerdict(text: string | null | undefined): Pick<ProviderReview, 'verdict' | 'confidence' | 'reason'> | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { verdict?: unknown; confidence?: unknown; reason?: unknown };
    const verdict = raw.verdict === 'agree' || raw.verdict === 'doubt' ? raw.verdict : null;
    if (!verdict) return null;
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(100, Math.round(raw.confidence))) : null;
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 400) : '';
    return { verdict, confidence, reason };
  } catch {
    return null;
  }
}

export function explainFailure(provider: ReviewProvider, message: string): string {
  void provider;
  const m = message.toLowerCase();
  if (/credit balance|no credits|insufficient_quota|exceeded your current quota|billing|resource_exhausted/.test(m)) return 'Kuota Gemini habis atau dibatasi. Periksa Google AI Studio dan billing/API key Gemini.';
  if (/\b503\b|high demand|overloaded|unavailable|\b529\b/.test(m)) return 'Gemini sedang sibuk. Biasanya sementara; tekan Tanya lagi beberapa menit lagi.';
  if (/\b401\b|\b403\b|api key|unauthori[sz]ed|permission/.test(m)) return 'API key Gemini ditolak. Periksa GEMINI_API_KEY yang dipasang di Vercel.';
  if (/\b404\b|not found|does not exist|not available/.test(m)) return 'Model Gemini tidak tersedia untuk key tersebut. Isi GEMINI_REVIEW_MODEL dengan model Gemini yang tersedia.';
  if (/\b429\b|rate limit/.test(m)) return 'Gemini terlalu banyak menerima permintaan. Tunggu sebentar lalu tekan Tanya lagi.';
  if (/within 20 seconds|timeout|timed out/.test(m)) return 'Gemini tidak menjawab dalam 20 detik. Coba lagi; engine harga tetap berjalan tanpa pendapat AI.';
  if (/readable verdict/.test(m)) return 'Jawaban Gemini tidak bisa dibaca sebagai pendapat.';
  return redactSecrets(message).slice(0, 160);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No answer within 20 seconds.')), TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function failure(model: string, err: unknown): ProviderReview {
  const message = err instanceof Error ? err.message : String(err);
  return { provider: 'gemini', model, verdict: null, confidence: null, reason: '', error: explainFailure('gemini', redactSecrets(message)) };
}

function answered(model: string, text: string | null | undefined): ProviderReview {
  const parsed = parseVerdict(text);
  return parsed ? { provider: 'gemini', model, ...parsed } : failure(model, new Error('The reply was not a readable verdict.'));
}

const GEMINI_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function askGemini(prompt: string): Promise<ProviderReview | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const first = process.env.GEMINI_REVIEW_MODEL?.trim() || 'gemini-2.5-flash';
  const models = [first, ...GEMINI_FALLBACKS.filter((model) => model !== first)];
  const client = new GoogleGenAI({ apiKey: key });
  let last: ProviderReview | null = null;
  const started = Date.now();
  for (const model of models) {
    if (last && Date.now() - started > 38_000) break;
    try {
      const result = await withTimeout(client.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: 'application/json', systemInstruction: SYSTEM },
      }));
      return answered(model, result.text);
    } catch (error) {
      last = failure(model, error);
      const text = error instanceof Error ? error.message : String(error);
      if (!/\b503\b|\b404\b|\b429\b|high demand|overloaded|unavailable|not found|timeout/i.test(text)) break;
    }
  }
  return last;
}

export async function reviewSetup(setup: InstitutionalTradingSetup, marketPrice: number | null): Promise<AiReview | null> {
  const review = await askGemini(reviewPrompt(setup, marketPrice));
  if (!review) return null;
  return {
    at: new Date().toISOString(),
    reviews: [review],
    agree: review.verdict === 'agree' ? 1 : 0,
    answered: review.verdict === null ? 0 : 1,
  };
}
