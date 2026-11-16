import { GoogleGenAI } from '@google/genai';
import { EngineProvider } from '@/lib/types';

export interface GenerationOptions {
  responseMimeType?: string;
  systemInstruction?: string;
  primaryModel?: string;
  fallbackModel?: string;
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
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function cleanMarkdownFences(text?: string): string | null {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  return cleaned || null;
}

/** Gemini-only synthesis. If Gemini is unavailable, callers use deterministic output. */
export async function executeGenerativeSynthesisWithProvider(
  prompt: string,
  options: GenerationOptions = {}
): Promise<SynthesisResult | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const primary = options.primaryModel || 'gemini-2.5-flash';
  const fallback = options.fallbackModel || 'gemini-2.5-flash-lite';
  const models = [...new Set([primary, fallback])];
  const client = new GoogleGenAI({ apiKey: key });
  let lastError = 'Gemini tidak mengembalikan jawaban.';

  for (const [index, model] of models.entries()) {
    try {
      const result = await withTimeout(client.models.generateContent({
        model,
        contents: prompt,
        config: {
          ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
          ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
        },
      }), 12_000);
      const text = cleanMarkdownFences(result.text);
      if (text) {
        return {
          text,
          provider: 'gemini',
          model,
          isFallback: index > 0,
          switchReason: index > 0 ? `Model Gemini utama tidak tersedia; memakai ${model}.` : undefined,
        };
      }
      lastError = 'Gemini mengirim jawaban kosong.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryable = /TIMEOUT|429|404|503|quota|resource_exhausted|unavailable|overloaded/i.test(lastError);
      if (!retryable) break;
    }
  }

  console.warn('Gemini synthesis failed:', lastError);
  return null;
}

export async function executeGenerativeSynthesis(
  prompt: string,
  options: GenerationOptions = {}
): Promise<string | null> {
  const result = await executeGenerativeSynthesisWithProvider(prompt, options);
  return result?.text || null;
}
