import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { redactSecrets } from '@/lib/safe-error';
import { EngineProvider } from '@/lib/types';

export interface GenerationOptions {
  responseMimeType?: string;
  systemInstruction?: string;
  primaryModel?: string;
  fallbackModel?: string;
  openAIModel?: string;
  claudeModel?: string;
}

export interface SynthesisResult {
  text: string;
  provider: EngineProvider;
  model: string;
  isFallback: boolean;
  switchReason?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function cleanMarkdownFences(text?: string): string | null {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  }
  return cleaned;
}

/**
 * Executes a call to OpenAI ChatGPT models (e.g. gpt-4o).
 * Activates when Gemini quota or rate limits are reached.
 */
async function callOpenAI(
  prompt: string,
  options: GenerationOptions
): Promise<string | null> {
  const secretKey = process.env.OPENAI_API_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    return null;
  }

  const systemMessage =
    options.systemInstruction ||
    'You are a Senior Institutional Quantitative Trading strategist for XAUUSD (Gold). Write in clear, plain Indonesian (Bahasa Indonesia) for a retail trader, keeping trading terms traders use as-is (entry, stop loss, take profit, order block, FVG) in English. Avoid using the word "A" followed by "I".';

  const bodyPayload: Record<string, unknown> = {
    model: options.openAIModel || 'gpt-4o',
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };

  if (options.responseMimeType === 'application/json') {
    bodyPayload.response_format = { type: 'json_object' };
  }

  try {
    const res = await withTimeout(
      // Overridable so a self hosted proxy, or a mock in tests, can stand in
      // for the public endpoint.
      fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey.trim()}`,
        },
        body: JSON.stringify(bodyPayload),
      }),
      9000
    );

    if (!res.ok) {
      console.warn(`OpenAI switch response returned status: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return cleanMarkdownFences(content);
  } catch (err) {
    console.warn('OpenAI fallback invocation exception:', err);
    return null;
  }
}

/**
 * Executes a call to Anthropic Claude through the official SDK.
 * Activates when Gemini and ChatGPT quotas or limits are reached.
 */
async function callClaude(
  prompt: string,
  options: GenerationOptions
): Promise<{ text: string; model: string } | null> {
  const secretKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    return null;
  }

  const systemMessage =
    options.systemInstruction ||
    'You are a Senior Institutional Quantitative Trading strategist for XAUUSD (Gold). Write in clear, plain Indonesian (Bahasa Indonesia) for a retail trader, keeping trading terms traders use as-is (entry, stop loss, take profit, order block, FVG) in English. Avoid using the word "A" followed by "I". If JSON is requested, output only pure JSON.';
  const model = options.claudeModel || 'claude-opus-5';

  try {
    const client = new Anthropic({ apiKey: secretKey.trim(), timeout: 20_000, maxRetries: 1 });
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system: systemMessage,
      output_config: { effort: 'low' },
      // A declined request is re-run on a fallback model chosen by the API.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') return null;
    const content = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    const cleaned = cleanMarkdownFences(content);
    return cleaned ? { text: cleaned, model: response.model ?? model } : null;
  } catch (err) {
    console.warn(`Claude invocation error for ${model}:`, err instanceof Error ? redactSecrets(err.message) : err);
    return null;
  }
}

/**
 * Multi-Provider Failover Synthesis:
 * 1. Primary: Google Gemini (gemini-flash-latest, overridable per call)
 * 2. Secondary: OpenAI ChatGPT (gpt-4o) - triggered automatically if Gemini quota is reached (429/quota/503)
 * 3. Tertiary: Anthropic Claude (claude-opus-5) - triggered if Gemini & ChatGPT are unavailable
 * 4. Algorithmic Fallback: Mathematical SMC/ICT calculation engine
 */
export async function executeGenerativeSynthesisWithProvider(
  prompt: string,
  options: GenerationOptions = {}
): Promise<SynthesisResult | null> {
  let switchReason: string | undefined = undefined;

  // STEP 1: Attempt Primary Provider (Google Gemini)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey.trim().length > 0) {
    // 'gemini-3.8-flash' was previously the default here and does not exist,
    // so every primary call failed and silently fell through to the fallback.
    const primaryModel = options.primaryModel || 'gemini-flash-latest';
    const fallbackModel = options.fallbackModel || 'gemini-2.5-flash';
    const candidateModels = [primaryModel, fallbackModel];

    const genClient = new GoogleGenAI({ apiKey: geminiKey.trim() });

    for (let m = 0; m < candidateModels.length; m++) {
      const activeModel = candidateModels[m];

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await withTimeout(
            genClient.models.generateContent({
              model: activeModel,
              contents: prompt,
              config: {
                ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
                ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
              },
            }),
            8000
          );

          const outputText = cleanMarkdownFences(result.text?.trim());
          if (outputText) {
            return {
              text: outputText,
              provider: 'gemini',
              model: activeModel,
              isFallback: false,
            };
          }
        } catch (thrownErr: unknown) {
          const errorRecord = thrownErr as {
            status?: string | number;
            message?: string;
            error?: { code?: number; message?: string };
          };

          const isQuotaOrDemand =
            errorRecord?.status === 429 ||
            errorRecord?.status === 503 ||
            errorRecord?.status === 'UNAVAILABLE' ||
            errorRecord?.status === 'RESOURCE_EXHAUSTED' ||
            errorRecord?.error?.code === 429 ||
            errorRecord?.error?.code === 503 ||
            (typeof errorRecord?.message === 'string' &&
              (errorRecord.message.includes('429') ||
                errorRecord.message.includes('quota') ||
                errorRecord.message.includes('Quota') ||
                errorRecord.message.includes('RESOURCE_EXHAUSTED') ||
                errorRecord.message.includes('rate') ||
                errorRecord.message.includes('503') ||
                errorRecord.message.includes('demand') ||
                errorRecord.message.includes('UNAVAILABLE')));

          if (isQuotaOrDemand) {
            switchReason = 'Kuota gratis atau kapasitas Google Gemini habis. Model cadangan diaktifkan.';
          }

          if (isQuotaOrDemand && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }

          break;
        }
      }
    }
  } else {
    switchReason = 'Key Google Gemini belum dipasang. Model cadangan diaktifkan.';
  }

  // STEP 2: Automatic Switch to Secondary Provider (OpenAI ChatGPT / gpt-4o)
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) {
    const openAIText = await callOpenAI(prompt, options);
    if (openAIText) {
      return {
        text: openAIText,
        provider: 'openai',
        model: options.openAIModel || 'gpt-4o',
        isFallback: true,
        switchReason: switchReason || 'Beralih ke ChatGPT (GPT-4o) sebagai cadangan kuota utama.',
      };
    }
    switchReason = 'Kuota Gemini & ChatGPT habis. Claude diaktifkan.';
  }

  // STEP 3: Automatic Switch to Tertiary Provider (Anthropic Claude)
  const claudeKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (claudeKey && claudeKey.trim().length > 0) {
    const claudeResult = await callClaude(prompt, options);
    if (claudeResult) {
      return {
        text: claudeResult.text,
        provider: 'claude',
        model: claudeResult.model,
        isFallback: true,
        switchReason: switchReason || 'Beralih ke Claude sebagai cadangan kuota.',
      };
    }
  }

  return null;
}

/**
 * Standard content generator maintaining complete backwards compatibility.
 * Automatically fails over to OpenAI and Claude if Gemini quota is reached.
 */
export async function executeGenerativeSynthesis(
  prompt: string,
  options: GenerationOptions = {}
): Promise<string | null> {
  const result = await executeGenerativeSynthesisWithProvider(prompt, options);
  return result?.text || null;
}
