import { NextResponse } from 'next/server';
import { reviewOnce, sanitiseReviewSetup } from '@/lib/ai-review-store';

export const dynamic = 'force-dynamic';
/** Three models asked side by side, each allowed twenty seconds. */
export const maxDuration = 45;

/**
 * The language models' opinion of a setup the engine produced. They are
 * asked once per setup; every later request gets the stored answer.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    setup?: unknown;
    marketPrice?: unknown;
    retry?: unknown;
  } | null;
  const setup = sanitiseReviewSetup(body?.setup);
  if (!setup) {
    return NextResponse.json({ success: false, error: 'setup must be a setup produced by the analysis.' }, { status: 400 });
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
    return NextResponse.json({ success: false, error: 'Could not get the AI review.' }, { status: 502 });
  }
}
