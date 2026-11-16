import { NextResponse } from 'next/server';
import { reviewOnce, sanitiseReviewSetup } from '@/lib/ai-review-store';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
/** Three models asked side by side, each allowed twenty seconds. */
export const maxDuration = 45;

/**
 * The language models' opinion of a setup the engine produced. They are
 * asked once per setup; every later request gets the stored answer.
 */
export async function POST(request: Request) {
  const quota = await rateLimit(request, 'ai-review', 6, 60);
  if (!quota.allowed) {
    return NextResponse.json({ success: false, error: 'Batas AI review tercapai. Coba lagi nanti.' }, { status: 429, headers: { 'Retry-After': String(quota.retryAfterSeconds) } });
  }
  const body = (await request.json().catch(() => null)) as {
    setup?: unknown;
    marketPrice?: unknown;
    retry?: unknown;
  } | null;
  const setup = sanitiseReviewSetup(body?.setup);
  if (!setup) {
    return NextResponse.json({ success: false, error: 'setup harus berupa setup dari analisis.' }, { status: 400 });
  }
  const marketPrice =
    typeof body?.marketPrice === 'number' && Number.isFinite(body.marketPrice) && body.marketPrice > 0
      ? body.marketPrice
      : null;
  try {
    const result = await reviewOnce(setup, marketPrice, { retryFailed: body?.retry === true });
    if (result.status === 'done') return NextResponse.json({ success: true, review: result.review });
    return NextResponse.json({ success: true, review: null, status: result.status });
  } catch (err) {
    console.warn('AI review failed:', err);
    return NextResponse.json({ success: false, error: 'Pendapat AI tidak bisa diambil.' }, { status: 502 });
  }
}
