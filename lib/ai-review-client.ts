/**
 * The browser asking for the models' opinion of the setup on the card.
 */

import type { AiReview, InstitutionalTradingSetup } from './types';

const RETRY_MS = 15_000;
const ATTEMPTS = 4;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The review, or null when no model is configured. Undefined when it could
 * not be had this time, so the card simply shows nothing and the setup is
 * recorded without one.
 */
export async function fetchAiReview(
  setup: InstitutionalTradingSetup,
  marketPrice: number | null,
  retry = false
): Promise<AiReview | null | undefined> {
  const body = JSON.stringify({
    setup: {
      id: setup.id,
      orderType: setup.orderType,
      entryPrice: setup.entryPrice,
      stopLoss: setup.stopLoss,
      takeProfit1: setup.takeProfit1,
      takeProfit2: setup.takeProfit2,
      takeProfit3: setup.takeProfit3,
      convictionScore: setup.convictionScore,
      tradingStyle: setup.tradingStyle,
      institutionalRationale: setup.institutionalRationale,
    },
    marketPrice,
    retry,
  });
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch('/api/ai-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        review?: AiReview | null;
        status?: 'pending' | 'busy';
      } | null;
      if (!res.ok || !data?.success) return undefined;
      if (data.status === 'busy') return undefined;
      // Someone else is already asking; their answer is stored for us shortly.
      if (data.status === 'pending') {
        await wait(RETRY_MS);
        continue;
      }
      return data.review ?? null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
