import { afterEach, describe, expect, test } from 'bun:test';
import { publicErrorMessage, redactSecrets, safeProviderNote } from '../lib/safe-error';

const ORIGINAL = process.env.TWELVE_DATA_API_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TWELVE_DATA_API_KEY;
  else process.env.TWELVE_DATA_API_KEY = ORIGINAL;
});

describe('nothing a provider says reaches the browser intact', () => {
  test('the configured key is removed wherever it appears', () => {
    process.env.TWELVE_DATA_API_KEY = 'sk-live-2f8a91c3';
    const quoted = 'Your API key sk-live-2f8a91c3 is invalid or expired.';
    expect(redactSecrets(quoted)).not.toContain('sk-live-2f8a91c3');
    expect(redactSecrets(quoted)).toContain('[redacted]');
  });

  test('a key carried in a request URL is removed', () => {
    const failed = 'request to https://api.twelvedata.com/price?symbol=XAU/USD&apikey=abcd1234efgh failed';
    const clean = redactSecrets(failed);
    expect(clean).not.toContain('abcd1234efgh');
    expect(clean).toContain('[redacted]');
  });

  test('a token quoted in prose is removed even when nothing is configured', () => {
    delete process.env.TWELVE_DATA_API_KEY;
    const clean = redactSecrets('Rejected credential 9f2b7c4e8a1d6053f7b2c9e4a8d1 supplied.');
    expect(clean).not.toContain('9f2b7c4e8a1d6053f7b2c9e4a8d1');
  });

  test('ordinary words survive, so the message still reads', () => {
    expect(redactSecrets('The provider is rate limiting this account.')).toBe(
      'The provider is rate limiting this account.'
    );
  });
});

describe('what the user is told instead', () => {
  test('recognised failures get a specific, safe sentence', () => {
    expect(publicErrorMessage(new Error('The operation was aborted'), 'fallback')).toContain(
      'tidak menjawab tepat waktu'
    );
    expect(publicErrorMessage(new Error('HTTP 429 too many requests'), 'fallback')).toContain(
      'membatasi akun ini'
    );
    expect(publicErrorMessage(new Error('Twelve Data HTTP 401'), 'fallback')).toContain(
      'menolak kredensial server'
    );
    expect(publicErrorMessage(new Error('fetch failed'), 'fallback')).toContain(
      'tidak bisa menghubungi provider data'
    );
  });

  test('anything unrecognised falls back rather than repeating itself', () => {
    process.env.TWELVE_DATA_API_KEY = 'sk-live-2f8a91c3';
    const message = publicErrorMessage(
      new Error('Your API key sk-live-2f8a91c3 produced an unmapped failure'),
      'The analysis engine could not complete this request.'
    );
    expect(message).toBe('The analysis engine could not complete this request.');
    expect(message).not.toContain('sk-live-2f8a91c3');
  });

  test('a non-error value never becomes a message', () => {
    expect(publicErrorMessage({ secret: 'sk-live-2f8a91c3' }, 'fallback')).toBe('fallback');
  });

  test('a provider note is prefixed, safe and redacted', () => {
    process.env.TWELVE_DATA_API_KEY = 'sk-live-2f8a91c3';
    const note = safeProviderNote(new Error('401 for key sk-live-2f8a91c3'), 'Provider error');
    expect(note.startsWith('Provider error:')).toBe(true);
    expect(note).not.toContain('sk-live-2f8a91c3');
  });
});
