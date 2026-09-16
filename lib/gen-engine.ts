import { GoogleGenAI } from '@google/genai';
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
    'You are a Senior Institutional Quantitative Trading strategist for XAUUSD (Gold). Write in rigorous institutional English. Avoid using the word "A" followed by "I".';

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
      fetch('https://api.openai.com/v1/chat/completions', {
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
 * Executes a call to Anthropic Claude Sonnet models.
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
    'You are a Senior Institutional Quantitative Trading strategist for XAUUSD (Gold). Write in rigorous institutional English. Avoid using the word "A" followed by "I". If JSON is requested, output only pure JSON.';

  const modelsToTry = [
    options.claudeModel || 'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
  ];

  for (const modelCandidate of modelsToTry) {
    try {
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': secretKey.trim(),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelCandidate,
            max_tokens: 2048,
            temperature: 0.2,
            system: systemMessage,
            messages: [{ role: 'user', content: prompt }],
          }),
        }),
        9000
      );

      if (!res.ok) {
        console.warn(`Claude switch response for ${modelCandidate} returned status: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const content = data?.content?.[0]?.text;
      const cleaned = cleanMarkdownFences(content);
      if (cleaned) {
        return { text: cleaned, model: modelCandidate };
      }
    } catch (err) {
      console.warn(`Claude fallback invocation error for ${modelCandidate}:`, err);
    }
  }

  return null;
}

/**
 * Multi-Provider Failover Synthesis:
 * 1. Primary: Google Gemini (gemini-3.8-flash -> gemini-flash-latest)
 * 2. Secondary: OpenAI ChatGPT (gpt-4o) - triggered automatically if Gemini quota is reached (429/quota/503)
 * 3. Tertiary: Anthropic Claude Sonnet (claude-3-7-sonnet / claude-3-5-sonnet) - triggered if Gemini & ChatGPT are unavailable
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
    const primaryModel = options.primaryModel || 'gemini-3.8-flash';
    const fallbackModel = options.fallbackModel || 'gemini-flash-latest';
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
            switchReason = 'Google Gemini free quota or capacity reached. Activated secondary model.';
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
    switchReason = 'Google Gemini key not configured. Activated secondary model.';
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
        switchReason: switchReason || 'Switched to ChatGPT (GPT-4o) as primary quota fallback.',
      };
    }
    switchReason = 'Gemini & ChatGPT quotas reached. Activated Claude Sonnet.';
  }

  // STEP 3: Automatic Switch to Tertiary Provider (Anthropic Claude Sonnet)
  const claudeKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (claudeKey && claudeKey.trim().length > 0) {
    const claudeResult = await callClaude(prompt, options);
    if (claudeResult) {
      return {
        text: claudeResult.text,
        provider: 'claude',
        model: claudeResult.model,
        isFallback: true,
        switchReason: switchReason || 'Switched to Claude Sonnet as quota fallback.',
      };
    }
  }

  return null;
}

/**
 * Standard content generator maintaining complete backwards compatibility.
 * Automatically fails over to OpenAI and Claude Sonnet if Gemini quota is reached.
 */
export async function executeGenerativeSynthesis(
  prompt: string,
  options: GenerationOptions = {}
): Promise<string | null> {
  const result = await executeGenerativeSynthesisWithProvider(prompt, options);
  return result?.text || null;
}
