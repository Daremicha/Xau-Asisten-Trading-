import { afterEach, describe, expect, test } from 'bun:test';
import { parseVerdict, reviewPrompt, reviewSetup } from '../lib/ai-review';
import { reviewLabel } from '../lib/ai-review-label';
import { sanitiseReviewSetup } from '../lib/ai-review-store';
import { newSetupAlert } from '../lib/trade-alerts';
import { tradeSummaryText } from '../lib/trade-summary';
import type { AiReview, InstitutionalTradingSetup, SelfLearningMemoryRecord } from '../lib/types';

const setup = {
  id: 'sig_abc123',
  orderType: 'SELL LIMIT',
  entryPrice: 4280.2,
  stopLoss: 4298.85,
  takeProfit1: 4253.85,
  takeProfit2: 4240,
  takeProfit3: 4225.5,
  convictionScore: 64,
  tradingStyle: 'Intraday',
  institutionalRationale: 'Bearish order block on H1 after a sweep of the Asian high.',
} as unknown as InstitutionalTradingSetup;

const review = (agree: number, answered: number): AiReview => ({
  at: '2026-09-28T03:00:00.000Z',
  reviews: [],
  agree,
  answered,
});

describe('reading a model verdict', () => {
  test('takes the JSON even inside code fences and chatter', () => {
    expect(parseVerdict('Sure:\n```json\n{"verdict":"agree","confidence":72.4,"reason":"Struktur searah."}\n```')).toEqual({
      verdict: 'agree',
      confidence: 72,
      reason: 'Struktur searah.',
    });
  });

  test('clamps the confidence and caps the reason', () => {
    const parsed = parseVerdict(JSON.stringify({ verdict: 'doubt', confidence: 180, reason: 'x'.repeat(900) }));
    expect(parsed?.confidence).toBe(100);
    expect(parsed?.reason.length).toBe(400);
  });

  test('refuses anything that is not a plain agree or doubt', () => {
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseVerdict('no json here')).toBeNull();
    expect(parseVerdict('{broken')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});

describe('the prompt the models see', () => {
  test('carries the engine levels and never asks for new ones', () => {
    const prompt = reviewPrompt(setup, 4284.1);
    expect(prompt).toContain('SELL LIMIT at 4280.20');
    expect(prompt).toContain('Stop loss: 4298.85');
    expect(prompt).toContain('Current price: 4284.10');
    expect(prompt).toContain('Engine conviction: 64/100');
  });
});

describe('asking the models', () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    process.env = { ...saved };
    globalThis.fetch = realFetch;
  });

  test('is skipped entirely when no key is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    expect(await reviewSetup(setup, null)).toBeNull();
  });

  test('counts the answers of the providers that are configured', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"verdict":"agree","confidence":70,"reason":"Oke."}' } }] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const result = await reviewSetup(setup, 4284.1);
    expect(result?.agree).toBe(1);
    expect(result?.answered).toBe(1);
    expect(result?.reviews[0]).toMatchObject({ provider: 'chatgpt', verdict: 'agree', reason: 'Oke.' });
  });

  test('a provider that fails says why without spoiling the count', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })) as unknown as typeof fetch;
    const result = await reviewSetup(setup, null);
    expect(result?.answered).toBe(0);
    expect(result?.reviews[0].verdict).toBeNull();
    expect(result?.reviews[0].error).toContain('404');
    expect(reviewLabel(result)).toBeNull();
  });
});

describe('showing the verdict', () => {
  test('labels the count of models that agreed', () => {
    expect(reviewLabel(review(2, 3))).toBe('AI: 2 of 3 agree');
    expect(reviewLabel(null)).toBeNull();
  });

  test('the new-setup alert carries the label when there is one', () => {
    expect(newSetupAlert({ ...setup, aiReview: review(2, 3) }, 'scan1').body).toContain('AI: 2 of 3 agree.');
    expect(newSetupAlert(setup, 'scan1').body).not.toContain('AI:');
  });
});

describe('checking what the app sends', () => {
  test('keeps only the fields the models read', () => {
    const clean = sanitiseReviewSetup({ ...setup, recommendedLotSize: 0.01, secret: 'x' }) as unknown as Record<string, unknown>;
    expect(clean.id).toBe('sig_abc123');
    expect(clean.secret).toBeUndefined();
    expect(clean.recommendedLotSize).toBeUndefined();
  });

  test('refuses a setup the engine could not have produced', () => {
    expect(sanitiseReviewSetup({ ...setup, orderType: 'BUY EVERYTHING' })).toBeNull();
    expect(sanitiseReviewSetup({ ...setup, entryPrice: -1 })).toBeNull();
    expect(sanitiseReviewSetup({ ...setup, id: 'a b/../c' })).toBeNull();
    expect(sanitiseReviewSetup(null)).toBeNull();
  });
});

describe('the trade summary', () => {
  const record = (id: string, outcome: 'TP' | 'SL', aiAgree?: number, aiAnswered?: number) =>
    ({
      id,
      analysisId: id,
      timestamp: '2026-09-24T07:30:00.000Z',
      outcome,
      symbol: 'XAUUSD',
      orderType: 'SELL LIMIT',
      entryPrice: 4280.2,
      exitPrice: outcome === 'TP' ? 4253.85 : 4298.85,
      profitOrLossPips: 0,
      profitOrLossDollars: outcome === 'TP' ? 0.26 : -0.19,
      context: { rMultiple: outcome === 'TP' ? 1.4 : -1, aiAgree, aiAnswered },
    }) as unknown as SelfLearningMemoryRecord;

  test('compares trades the models agreed with against the rest', () => {
    const text = tradeSummaryText(
      [record('a', 'TP', 3, 3), record('b', 'SL', 2, 3), record('c', 'SL', 1, 3), record('d', 'TP')],
      {
        equity: 3.78,
        accountType: 'Cent',
        settings: { tradingStyle: 'Intraday', minConviction: 0, protectStopAtR: 1, dailyLossLimit: 3 },
      }
    );
    expect(text).toContain('AI majority agreed: 1/2 won (50%) - otherwise: 0/1 won (0%)');
    expect(text).toContain('|+1.40|3/3');
    expect(text).toContain('|+1.40|-');
  });
});
