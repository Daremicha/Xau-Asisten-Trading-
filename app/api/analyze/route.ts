import { NextResponse } from 'next/server';
import { validateAnalyzeBody } from '@/lib/request-validation';
import { runAnalysis } from '@/lib/run-analysis';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Request body is not valid JSON.' },
      { status: 400 }
    );
  }

  const { value: input, errors } = validateAnalyzeBody(body);
  if (!input) {
    return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
  }

  const result = await runAnalysis(input);
  return NextResponse.json(result.body, { status: result.status });
}
