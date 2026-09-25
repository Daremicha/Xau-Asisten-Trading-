import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetKeyRotation,
  keyProblem,
  requestTwelveData,
  TWELVE_DATA_KEY_VARS,
  twelveDataKeys,
} from '../lib/twelve-data-keys';

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of TWELVE_DATA_KEY_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  __resetKeyRotation();
});

afterEach(() => {
  for (const name of TWELVE_DATA_KEY_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const outOfMinute = { code: 429, status: 'error', message: 'You have run out of API credits for the current minute.' };
const outOfDay = { code: 429, status: 'error', message: 'You have run out of API credits for the day.' };

/** A fake provider: each key answers from its own script, and every call is logged. */
function provider(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    const key = new URL(url).searchParams.get('apikey')!;
    calls.push(key);
    return answers[key]();
  };
  return { calls, fetcher };
}
const url = (key: string) => `https://example.test/price?apikey=${key}`;

describe('reading the keys', () => {
  test('up to three named keys, or a list, without duplicates', () => {
    process.env.TWELVE_DATA_API_KEY = 'aaa';
    process.env.TWELVE_DATA_API_KEY_2 = 'bbb';
    process.env.TWELVE_DATA_API_KEY_3 = ' ccc ';
    process.env.TWELVE_DATA_API_KEYS = 'bbb, ddd';
    expect(twelveDataKeys()).toEqual(['aaa', 'bbb', 'ccc', 'ddd']);
  });

  test('tells the minute limit, the daily limit and a bad key apart', () => {
    expect(keyProblem(200, outOfMinute)).toBe('minute');
    expect(keyProblem(200, outOfDay)).toBe('day');
    expect(keyProblem(429, null)).toBe('minute');
    expect(keyProblem(401, { code: 401, message: 'apikey parameter is incorrect' })).toBe('invalid');
    expect(keyProblem(200, { price: '4300.1' })).toBeNull();
  });
});

describe('moving between keys', () => {
  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = 'k1';
    process.env.TWELVE_DATA_API_KEY_2 = 'k2';
    process.env.TWELVE_DATA_API_KEY_3 = 'k3';
  });

  test('stays on the first key while it works', async () => {
    const { calls, fetcher } = provider({ k1: () => json({ price: '1' }), k2: () => json({}), k3: () => json({}) });
    await requestTwelveData(url, fetcher);
    await requestTwelveData(url, fetcher);
    expect(calls).toEqual(['k1', 'k1']);
  });

  test('a spent key hands over to the next at once, and is skipped afterwards', async () => {
    const { calls, fetcher } = provider({ k1: () => json(outOfDay), k2: () => json({ price: '2' }), k3: () => json({}) });
    const first = await requestTwelveData(url, fetcher, 1_000);
    expect(first?.ok).toBe(true);
    expect(first?.payload).toEqual({ price: '2' });
    await requestTwelveData(url, fetcher, 2_000);
    expect(calls).toEqual(['k1', 'k2', 'k2']);
  });

  test('when every key is spent the caller is told to wait', async () => {
    const { calls, fetcher } = provider({ k1: () => json(outOfMinute), k2: () => json(outOfMinute), k3: () => json(outOfMinute) });
    const reply = await requestTwelveData(url, fetcher, 0);
    expect(reply?.ok).toBe(false);
    expect(reply?.allKeysSpent).toBe(true);
    expect(calls).toEqual(['k1', 'k2', 'k3']);
    // Still inside the minute: nothing is worth asking.
    const again = await requestTwelveData(url, fetcher, 30_000);
    expect(again?.allKeysSpent).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test('the cycle comes back round once a key recovers', async () => {
    let k1Spent = true;
    const { calls, fetcher } = provider({
      k1: () => json(k1Spent ? outOfMinute : { price: '1' }),
      k2: () => json(outOfDay),
      k3: () => json(outOfDay),
    });
    await requestTwelveData(url, fetcher, 0);
    k1Spent = false;
    const later = await requestTwelveData(url, fetcher, 70_000);
    expect(later?.ok).toBe(true);
    expect(calls).toEqual(['k1', 'k2', 'k3', 'k1']);
  });

  test('with no key at all there is nothing to ask', async () => {
    for (const name of TWELVE_DATA_KEY_VARS) delete process.env[name];
    const { fetcher } = provider({});
    expect(await requestTwelveData(url, fetcher)).toBeNull();
  });
});
