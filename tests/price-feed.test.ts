import { afterEach, describe, expect, test } from 'bun:test';
import {
  QUOTE_POLL_MS,
  __toSnapshotForTest,
  cacheSeconds,
  candlesSinceUtcMidnight,
  mapTwelveDataCandles,
  mapYahooCandles,
  parseTwelveDataTime,
  previousDayClose,
  YAHOO_SYMBOLS,
} from '../lib/price-feed';
import { __resetBudget, takeRequest } from '../lib/request-budget';

describe('Twelve Data parsing', () => {
  test('a zoneless datetime is read as UTC, not as local time', () => {
    expect(parseTwelveDataTime('2026-09-16 04:30:00')).toBe(Date.UTC(2026, 8, 16, 4, 30, 0));
  });

  test('an explicit zone is honoured', () => {
    expect(parseTwelveDataTime('2026-09-16T04:30:00Z')).toBe(Date.UTC(2026, 8, 16, 4, 30, 0));
  });

  test('newest first rows are returned oldest first', () => {
    const candles = mapTwelveDataCandles({
      values: [
        { datetime: '2026-09-16 10:30:00', open: '4210', high: '4215', low: '4208', close: '4212', volume: '30' },
        { datetime: '2026-09-16 10:15:00', open: '4200', high: '4211', low: '4199', close: '4210', volume: '20' },
      ],
    });
    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(4210);
    expect(candles[1].close).toBe(4212);
    expect(candles[0].time).toBeLessThan(candles[1].time);
  });

  test('rows with unusable numbers are dropped rather than becoming NaN candles', () => {
    const candles = mapTwelveDataCandles({
      values: [
        { datetime: '2026-09-16 10:15:00', open: 'x', high: '1', low: '1', close: '1', volume: '1' },
        { datetime: '2026-09-16 10:30:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '1' },
      ],
    });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(1.5);
  });

  test('a malformed payload yields no candles instead of throwing', () => {
    expect(mapTwelveDataCandles(null)).toHaveLength(0);
    expect(mapTwelveDataCandles({})).toHaveLength(0);
    expect(mapTwelveDataCandles({ values: 'nope' })).toHaveLength(0);
  });
});

describe('Yahoo parsing', () => {
  const payload = {
    chart: {
      result: [
        {
          timestamp: [1_700_000_000, 1_700_000_900],
          indicators: {
            quote: [
              {
                open: [4200, 4210],
                high: [4211, 4216],
                low: [4199, 4208],
                close: [4210, 4212],
                volume: [20, 30],
              },
            ],
          },
        },
      ],
    },
  };

  test('candles are built in chronological order with seconds converted to milliseconds', () => {
    const candles = mapYahooCandles(payload);
    expect(candles).toHaveLength(2);
    expect(candles[0].time).toBe(1_700_000_000_000);
    expect(candles[1].close).toBe(4212);
  });

  test('null gaps in the quote arrays are skipped', () => {
    const withGap = JSON.parse(JSON.stringify(payload));
    withGap.chart.result[0].indicators.quote[0].close[0] = null;
    expect(mapYahooCandles(withGap)).toHaveLength(1);
  });

  test('a malformed payload yields no candles instead of throwing', () => {
    expect(mapYahooCandles(null)).toHaveLength(0);
    expect(mapYahooCandles({ chart: {} })).toHaveLength(0);
  });
});

describe('session helpers', () => {
  const DAY = 86_400_000;
  const candles = [
    { time: 0, open: 1, high: 2, low: 0, close: 1.5, volume: 1 },
    { time: DAY - 900_000, open: 1, high: 2, low: 0, close: 1.75, volume: 1 },
    { time: DAY, open: 2, high: 3, low: 1, close: 2.5, volume: 1 },
    { time: DAY + 900_000, open: 2, high: 3, low: 1, close: 2.75, volume: 1 },
  ];

  test('only the reference day is kept', () => {
    const today = candlesSinceUtcMidnight(candles, DAY + 900_000);
    expect(today).toHaveLength(2);
    expect(today[0].time).toBe(DAY);
  });

  test('the previous close is the last candle before midnight', () => {
    expect(previousDayClose(candles, DAY + 900_000)).toBe(1.75);
  });

  test('with no earlier day there is no previous close to report', () => {
    expect(previousDayClose(candles.slice(2), DAY + 900_000)).toBeNull();
  });
});

describe('quota aware cache window', () => {
  const original = process.env.MARKET_DATA_CACHE_SECONDS;
  afterEach(() => {
    if (original === undefined) delete process.env.MARKET_DATA_CACHE_SECONDS;
    else process.env.MARKET_DATA_CACHE_SECONDS = original;
  });

  test('defaults to twenty seconds, close enough to the chart to be usable', () => {
    delete process.env.MARKET_DATA_CACHE_SECONDS;
    expect(cacheSeconds()).toBe(20);
  });

  test('an explicit value is honoured', () => {
    process.env.MARKET_DATA_CACHE_SECONDS = '120';
    expect(cacheSeconds()).toBe(120);
  });

  test('nonsense values fall back to the default rather than hammering the provider', () => {
    for (const bad of ['', 'abc', '-5', '0', '1']) {
      process.env.MARKET_DATA_CACHE_SECONDS = bad;
      expect(cacheSeconds()).toBe(20);
    }
  });

  test('an absurdly long window is capped so the price cannot go hours stale', () => {
    process.env.MARKET_DATA_CACHE_SECONDS = '99999';
    expect(cacheSeconds()).toBe(900);
  });

  test('the browser polls for the panel, not for the provider', () => {
    // What the browser asks for and what reaches the provider are no longer the
    // same thing. Polling is fast while an order is working because that is
    // when the status panel is read against the chart; the request budget, not
    // this interval, decides how often the provider is actually called.
    delete process.env.MARKET_DATA_CACHE_SECONDS;
    expect(QUOTE_POLL_MS.withOpenOrder).toBeLessThanOrEqual(10_000);
    expect(QUOTE_POLL_MS.idle).toBeGreaterThan(QUOTE_POLL_MS.withOpenOrder);
    // A poll costs nothing beyond our own route while the snapshot is fresh.
    expect(cacheSeconds()).toBeGreaterThanOrEqual(QUOTE_POLL_MS.withOpenOrder / 1000);
  });

  test('a heavy day of watching cannot outspend the plan', () => {
    // Twelve hours of a browser polling every eight seconds: five thousand
    // four hundred polls. What the provider sees is bounded by the budget.
    __resetBudget(Date.UTC(2026, 8, 17, 0, 1, 0));
    let providerCalls = 0;
    for (let poll = 0; poll < (12 * 3_600_000) / QUOTE_POLL_MS.withOpenOrder; poll++) {
      const at = Date.UTC(2026, 8, 17, 0, 1, 0) + poll * QUOTE_POLL_MS.withOpenOrder;
      if (takeRequest(false, at)) providerCalls += 1;
    }
    expect(providerCalls).toBeLessThan(800);
  });
});

describe('a market order needs a price that still exists', () => {
  // The reported bug: the snapshot carried the close of the last finished
  // fifteen minute candle, so the engine quoted BUY INSTANT at 4287.49 while
  // gold was trading at 4293.76, and called the quote zero seconds old.
  const CANDLE_MS = 15 * 60_000;

  test('a price taken from a finished candle is reported at that candle age', () => {
    const takenAt = Date.now() - 8 * 60_000;
    const snapshot = __toSnapshotForTest(
      {
        source: 'Twelve Data (XAU/USD spot)',
        instrument: 'spot' as const,
        price: 4287.49,
        priceTakenAt: takenAt,
        dayHigh: null,
        dayLow: null,
        previousClose: null,
        candlesM15: [],
        candlesD1: [],
      },
      Date.now(),
      'live'
    );
    expect(snapshot.ageMs).toBeGreaterThan(7 * 60_000);
    expect(snapshot.fetchedAt).toBe(new Date(takenAt).toISOString());
  });

  test('a price too old to trade on is marked stale even when the provider answered', () => {
    const snapshot = __toSnapshotForTest(
      {
        source: 'Twelve Data (XAU/USD spot)',
        instrument: 'spot' as const,
        price: 4287.49,
        priceTakenAt: Date.now() - CANDLE_MS,
        dayHigh: null,
        dayLow: null,
        previousClose: null,
        candlesM15: [],
        candlesD1: [],
      },
      Date.now(),
      'live'
    );
    expect(snapshot.status).toBe('stale');
    expect(snapshot.message).toContain('not current enough for a market order');
  });

  test('a live tick is live, and says nothing alarming', () => {
    const snapshot = __toSnapshotForTest(
      {
        source: 'Twelve Data (XAU/USD spot)',
        instrument: 'spot' as const,
        price: 4293.76,
        priceTakenAt: Date.now(),
        dayHigh: null,
        dayLow: null,
        previousClose: null,
        candlesM15: [],
        candlesD1: [],
      },
      Date.now(),
      'live'
    );
    expect(snapshot.status).toBe('live');
    expect(snapshot.ageMs).toBeLessThan(1000);
    expect(snapshot.message).toContain('Live data from');
  });
});

describe('which instrument the quote actually is', () => {
  test('a spot feed says so, and its message says nothing about futures', () => {
    const snapshot = __toSnapshotForTest(
      {
        source: 'Twelve Data (XAU/USD spot)',
        instrument: 'spot' as const,
        price: 4380.6,
        priceTakenAt: Date.now(),
        dayHigh: null,
        dayLow: null,
        previousClose: null,
        candlesM15: [],
        candlesD1: [],
      },
      Date.now(),
      'live'
    );
    expect(snapshot.instrument).toBe('spot');
    expect(snapshot.message).not.toContain('futures');
  });

  test('a futures feed is carried, labelled, and says no levels come from it', () => {
    // The reported bug: the header read "XAUUSD Live Spot $4380.60" while the
    // spot chart beside it read 4341.84 — the COMEX basis, thirty nine dollars
    // of it, quoted as though it were the instrument being traded.
    const snapshot = __toSnapshotForTest(
      {
        source: 'Yahoo Finance (COMEX GC=F front month futures, not spot)',
        instrument: 'futures' as const,
        price: 4380.6,
        priceTakenAt: Date.now(),
        dayHigh: null,
        dayLow: null,
        previousClose: null,
        candlesM15: [],
        candlesD1: [],
      },
      Date.now(),
      'live'
    );
    expect(snapshot.instrument).toBe('futures');
    expect(snapshot.message).toContain('not spot XAUUSD');
    expect(snapshot.message).toContain('no order levels are produced from it');
  });
});

describe('the fallback provider prefers the instrument being traded', () => {
  test('spot is tried before the futures contract', () => {
    expect(YAHOO_SYMBOLS[0].instrument).toBe('spot');
    expect(YAHOO_SYMBOLS[0].symbol).toBe('XAUUSD=X');
  });

  test('the futures contract is last, and is never described as spot', () => {
    const futures = YAHOO_SYMBOLS[YAHOO_SYMBOLS.length - 1];
    expect(futures.instrument).toBe('futures');
    expect(futures.symbol).toBe('GC=F');
    expect(futures.source).toContain('not spot');
  });
});
