import { NextResponse } from 'next/server';
import { validateAnalyzeBody } from '@/lib/request-validation';
import { runAnalysis } from '@/lib/run-analysis';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const quota = await rateLimit(request, 'analyze', 30, 60);
  if (!quota.allowed) {
    return NextResponse.json(
      { success: false, error: 'Batas analisis tercapai. Tunggu sebentar sebelum mencoba lagi.', retryAfterSeconds: quota.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(quota.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 1_000_000) return NextResponse.json({ success: false, error: 'Isi permintaan terlalu besar.' }, { status: 413 });
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Isi permintaan bukan JSON yang valid.' },
      { status: 400 }
    );
  }

  const { value: input, errors } = validateAnalyzeBody(body);
  if (!input) {
    return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
  }

  const result = await runAnalysis(input);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'X-RateLimit-Limit': String(quota.limit), 'X-RateLimit-Remaining': String(quota.remaining) },
  });
}
