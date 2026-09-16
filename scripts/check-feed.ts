/**
 * Confirms the market data feed is working before you start the app.
 *
 *   bun run check:feed
 *
 * Reads the same environment variables the app reads, calls the same provider
 * chain, and prints plainly whether a live gold price came back.
 */

import { getMarketSnapshot } from '../lib/price-feed';
import { buildInstitutionalRead } from '../lib/analysis-pipeline';

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  console.log('\nChecking the XAUUSD market data feed...\n');

  const hasTwelveData = Boolean(process.env.TWELVE_DATA_API_KEY?.trim());
  line('TWELVE_DATA_API_KEY', hasTwelveData ? 'set' : 'NOT set (will try Yahoo only)');

  const snapshot = await getMarketSnapshot();

  if (snapshot.status === 'unavailable' || snapshot.price === null) {
    console.log('\n  RESULT: no live data.\n');
    console.log(`  ${snapshot.message}\n`);
    console.log('  Things to check:');
    console.log('    1. Is TWELVE_DATA_API_KEY spelled exactly right in .env.local?');
    console.log('    2. Did you paste the key without quotes or trailing spaces?');
    console.log('    3. Can this machine reach the internet (a proxy or firewall may block it)?');
    console.log('    4. Is the free plan quota for the day already used up?\n');
    process.exit(1);
  }

  line('Status', snapshot.status);
  line('Source', snapshot.source ?? 'unknown');
  line('Gold price', `$${snapshot.price.toFixed(2)}`);
  line('Candles received', String(snapshot.candlesM15.length));

  const read = buildInstitutionalRead(snapshot);
  if (!read) {
    console.log('\n  RESULT: price works, but there are too few candles to build market structure.');
    console.log('  The app will show a price but no signal. A provider with more history fixes this.\n');
    process.exit(1);
  }

  line('D1 trend', read.multiTimeframe.d1.trend);
  line('H1 trend', read.multiTimeframe.h1.trend);
  line('EMA 200', read.indicators.ema200.toFixed(2));
  line('ATR 14', read.indicators.atr14.toFixed(2));
  line('Pivot', read.tradingCentral.pivotPoint.toFixed(2));

  if (snapshot.status === 'stale') {
    console.log('\n  RESULT: working, but the quote is stale. The provider did not answer this time.\n');
    process.exit(1);
  }

  console.log('\n  RESULT: everything works. Start the app with `bun run dev`.\n');
}

main().catch((err) => {
  console.error('\n  The check itself failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
