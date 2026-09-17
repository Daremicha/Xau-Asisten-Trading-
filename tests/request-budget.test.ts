import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetBudget,
  budgetState,
  dailyLimit,
  sustainedIntervalSeconds,
  takeRequest,
} from '../lib/request-budget';

const NOON = Date.UTC(2026, 8, 17, 12, 0, 0);
/** Just after a UTC midnight, so a whole allowance fits inside one day. */
const DAY_START = Date.UTC(2026, 8, 17, 0, 1, 0);
const MINUTE = 60_000;
const ORIGINAL_LIMIT = process.env.TWELVE_DATA_DAILY_LIMIT;

beforeEach(() => {
  delete process.env.TWELVE_DATA_DAILY_LIMIT;
  __resetBudget(NOON);
});

afterEach(() => {
  if (ORIGINAL_LIMIT === undefined) delete process.env.TWELVE_DATA_DAILY_LIMIT;
  else process.env.TWELVE_DATA_DAILY_LIMIT = ORIGINAL_LIMIT;
});

describe('what the day may spend', () => {
  test('the default sits below the free plan, because instances cannot see each other', () => {
    expect(dailyLimit()).toBe(700);
    expect(dailyLimit()).toBeLessThan(800);
  });

  test('a plan with a different allowance can be configured', () => {
    process.env.TWELVE_DATA_DAILY_LIMIT = '5000';
    expect(dailyLimit()).toBe(5000);
    // Nonsense is ignored rather than trusted.
    process.env.TWELVE_DATA_DAILY_LIMIT = '2';
    expect(dailyLimit()).toBe(700);
    process.env.TWELVE_DATA_DAILY_LIMIT = 'lots';
    expect(dailyLimit()).toBe(700);
  });

  test('the sustained rate is the honest arithmetic, not a wish', () => {
    // Seven hundred requests over a day is one every two minutes or so. No
    // schedule turns that into a ten second tick around the clock.
    expect(sustainedIntervalSeconds()).toBe(123);
  });
});

describe('the reserve, and the drip', () => {
  test('a burst is available immediately, for the minutes that matter', () => {
    let taken = 0;
    for (let i = 0; i < 600; i++) if (takeRequest(false, NOON)) taken += 1;
    // The reserve, and nothing beyond it, without any time passing.
    expect(taken).toBe(400);
    expect(budgetState(NOON).paced).toBe(true);
  });

  test('once the burst is gone the rate is the plan’s own', () => {
    for (let i = 0; i < 600; i++) takeRequest(false, NOON);
    expect(takeRequest(false, NOON)).toBe(false);
    // One request earned back after the sustained interval.
    const later = NOON + sustainedIntervalSeconds() * 1000 + 1_000;
    expect(takeRequest(false, later)).toBe(true);
    expect(takeRequest(false, later)).toBe(false);
  });

  test('the burst refills over time rather than only at midnight', () => {
    for (let i = 0; i < 600; i++) takeRequest(false, NOON);
    const anHourLater = NOON + 60 * MINUTE;
    // Seven hundred a day is about twenty nine an hour.
    expect(budgetState(anHourLater).available).toBeGreaterThanOrEqual(25);
    expect(budgetState(anHourLater).available).toBeLessThanOrEqual(35);
  });
});

describe('what the day can never exceed', () => {
  test('no pattern of use crosses the limit', () => {
    // A machine asking as fast as it can, every minute of one UTC day.
    __resetBudget(DAY_START);
    let spent = 0;
    for (let minute = 0; minute < 23 * 60; minute++) {
      const at = DAY_START + minute * MINUTE;
      for (let i = 0; i < 20; i++) if (takeRequest(false, at)) spent += 1;
    }
    expect(spent).toBeLessThanOrEqual(dailyLimit());
    expect(spent).toBeLessThan(800);
  });

  test('the candle and daily series keep a reserve the tick cannot touch', () => {
    // Spend everything a tick is allowed to spend, inside one UTC day.
    __resetBudget(DAY_START);
    for (let minute = 0; minute < 22 * 60; minute++) {
      const at = DAY_START + minute * MINUTE;
      for (let i = 0; i < 20; i++) takeRequest(false, at);
    }
    const afterwards = DAY_START + 22 * 60 * MINUTE;
    expect(takeRequest(false, afterwards)).toBe(false);
    // Structure still runs: a hundred and twenty calls were never on the table.
    let essentials = 0;
    for (let i = 0; i < 200; i++) if (takeRequest(true, afterwards)) essentials += 1;
    expect(essentials).toBeGreaterThanOrEqual(100);
  });

  test('a fresh allowance arrives at midnight, not before', () => {
    for (let i = 0; i < 1000; i++) takeRequest(false, NOON);
    const beforeMidnight = Date.UTC(2026, 8, 17, 23, 59, 0);
    const spentByNight = budgetState(beforeMidnight).spent;
    expect(spentByNight).toBeGreaterThan(0);

    const afterMidnight = Date.UTC(2026, 8, 18, 0, 1, 0);
    const fresh = budgetState(afterMidnight);
    expect(fresh.spent).toBe(0);
    expect(fresh.available).toBe(400);
  });
});
