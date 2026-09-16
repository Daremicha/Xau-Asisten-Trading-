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
      model: 'gemini-3.8-flash',
      role: 'Primary Provider',
    },
    openai: {
      configured: hasOpenAI,
      label: 'ChatGPT (GPT-4o)',
      model: 'gpt-4o',
      role: 'Secondary Fallback (activates on Gemini quota limit)',
    },
    claude: {
      configured: hasClaude,
      label: 'Claude Sonnet',
      model: 'claude-3-7-sonnet',
      role: 'Tertiary Fallback (activates if Gemini & ChatGPT exhausted)',
    },
    algorithmic: {
      configured: true,
      label: 'SMC/ICT Quantitative Matrix',
      model: 'Algorithmic Engine',
      role: 'Autonomous Baseline',
    },
  });
}
