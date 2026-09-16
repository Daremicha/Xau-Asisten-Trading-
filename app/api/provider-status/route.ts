import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const hasGemini = Boolean(
    process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0
  );
  const hasOpenAI = Boolean(
    process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0
  );
  const hasClaude = Boolean(
    (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0) ||
    (process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY.trim().length > 0)
  );

  return NextResponse.json({
    gemini: {
      configured: hasGemini,
      label: 'Google Gemini',
      model: 'gemini-flash-latest',
      role: 'Primary narrative writer',
    },
    openai: {
      configured: hasOpenAI,
      label: 'ChatGPT (GPT-4o)',
      model: 'gpt-4o',
      role: 'Secondary narrative writer, used if Gemini is rate limited',
    },
    claude: {
      configured: hasClaude,
      label: 'Claude Sonnet',
      model: 'claude-3-7-sonnet',
      role: 'Tertiary narrative writer, used if the first two are exhausted',
    },
    algorithmic: {
      configured: true,
      label: 'Structural SMC/ICT engine',
      model: 'Deterministic, derived from live candles',
      role: 'Owns every price level; the app is fully functional without any language model key',
    },
  });
}
