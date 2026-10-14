/**
 * What an error is allowed to say to the browser.
 *
 * The API routes used to hand `err.message` straight back in the response, and
 * some of those messages come from upstream providers. A data provider that
 * rejects a key commonly quotes it back — "Your API key abc123… is invalid" —
 * and a fetch failure can carry the request URL, which has the key in its query
 * string. Either one turns a server-side secret into something anyone with the
 * browser's network tab can read.
 *
 * So nothing upstream is repeated verbatim. Known shapes are rewritten into
 * plain sentences, anything else becomes a generic message, and whatever is
 * left is scrubbed of key-shaped text as a last line of defence.
 */

/** Environment variables whose values must never appear in a response. */
const SECRET_ENV_KEYS = [
  'TWELVE_DATA_API_KEY',
  'TWELVE_DATA_API_KEY_2',
  'TWELVE_DATA_API_KEY_3',
  'TWELVE_DATA_API_KEYS',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'ECONOMIC_CALENDAR_URL',
];

/**
 * Removes anything that looks like a credential.
 *
 * Three passes: the actual configured values, query parameters that carry keys,
 * and long unbroken runs of key-shaped characters, which is what a token looks
 * like when a provider quotes one back inside a sentence.
 */
export function redactSecrets(text: string): string {
  let out = text;

  for (const name of SECRET_ENV_KEYS) {
    // A list variable holds several keys separated by commas; each is a secret.
    for (const part of (process.env[name] ?? '').split(',')) {
      const value = part.trim();
      if (value.length >= 6) out = out.split(value).join('[redacted]');
    }
  }

  // apikey=…, api_key=…, key=…, token=… in a URL or a sentence.
  out = out.replace(/\b(api[-_]?key|apikey|key|token|secret)\b\s*[=:]\s*[^\s&"']+/gi, '$1=[redacted]');
  // A bare token quoted inside prose: twenty or more key-shaped characters.
  out = out.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');

  return out;
}

/**
 * The sentence a user should see when a request fails.
 *
 * `fallback` is what to say when the error is not one of the recognised
 * shapes — deliberately vague about the cause and specific about what to do.
 */
export function publicErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const text = raw.toLowerCase();

  if (text.includes('abort') || text.includes('timeout') || text.includes('etimedout')) {
    return 'Provider data tidak menjawab tepat waktu. Coba lagi sebentar lagi.';
  }
  if (text.includes('429') || text.includes('rate limit') || text.includes('quota')) {
    return 'Provider data sedang membatasi akun ini. Coba lagi semenit lagi.';
  }
  if (text.includes('401') || text.includes('403') || text.includes('unauthor') || text.includes('invalid api')) {
    return 'Provider data menolak kredensial server. Cek key provider di environment deployment.';
  }
  if (text.includes('fetch failed') || text.includes('enotfound') || text.includes('econnrefused')) {
    return 'Server tidak bisa menghubungi provider data. Cek akses jaringan keluar lalu coba lagi.';
  }

  return fallback;
}

/** A provider failure, said safely, for a field the browser will read. */
export function safeProviderNote(err: unknown, prefix: string): string {
  const message = publicErrorMessage(err, 'Provider mengembalikan error.');
  return redactSecrets(`${prefix}: ${message}`);
}
