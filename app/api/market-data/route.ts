import { NextResponse } from 'next/server';
import { getMarketSnapshot } from '@/lib/price-feed';
import { filterUpcoming, getEconomicCalendar, usdOnly } from '@/lib/economic-calendar';
import { buildInstitutionalRead } from '@/lib/analysis-pipeline';
import { getContractSpecification } from '@/lib/market-engine';
import { round2 } from '@/lib/candles';
import { AccountType, BrokerId, BROKER_PROFILES } from '@/lib/types';
import { publicErrorMessage } from '@/lib/safe-error';

export const dynamic = 'force-dynamic';

function parseAccountType(value: string | null): AccountType {
  return value === 'Cent' || value === 'Pro' ? value : 'Standard';
}

function parseBrokerId(value: string | null): BrokerId {
  return value && value in BROKER_PROFILES ? (value as BrokerId) : 'EXNESS';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const accountType = parseAccountType(url.searchParams.get('accountType'));
  const brokerId = parseBrokerId(url.searchParams.get('brokerId'));

  try {
    const snapshot = await getMarketSnapshot();

    // No provider reachable. Report it rather than serving an invented price.
    if (snapshot.status === 'unavailable' || snapshot.price === null) {
      return NextResponse.json(
        {
          success: false,
          status: 'unavailable',
          symbol: 'XAUUSD',
          marketPrice: null,
          message: snapshot.message,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const specs = getContractSpecification(accountType, brokerId);
    const spreadDollars = (specs.typicalSpreadPips * 0.1) / 2;
    const price = snapshot.price;

    const previousClose = snapshot.previousClose;
    const change24h = previousClose === null ? null : round2(price - previousClose);
    const changePercent =
      previousClose === null || previousClose === 0 ? null : round2(((price - previousClose) / previousClose) * 100);

    const read = buildInstitutionalRead(snapshot);

    // The calendar used to reach the screen only as part of an analysis, so it
    // sat empty whenever no setup was open, which is most of the time. It is
    // cached for fifteen minutes upstream, so serving it beside every quote
    // costs nothing and keeps the panel populated on its own.
    const calendar = await getEconomicCalendar();

    return NextResponse.json({
      success: true,
      status: snapshot.status,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      ageSeconds: Math.round(snapshot.ageMs / 1000),
      message: snapshot.message,
      symbol: 'XAUUSD',
      marketPrice: price,
      // Gold is priced in dollars, so only the dollar side is listed.
      economicEvents: usdOnly(filterUpcoming(calendar.events)),
      calendarConfigured: calendar.configured,
      calendarMessage: calendar.message,
      bid: round2(price - spreadDollars),
      ask: round2(price + spreadDollars),
      spreadPips: specs.typicalSpreadPips,
      brokerName: specs.brokerName,
      change24h,
      changePercent,
      high24h: snapshot.dayHigh,
      low24h: snapshot.dayLow,
      candleCount: snapshot.candlesM15.length,
      // Trim to what a chart needs so the payload stays small.
      candlesM15: snapshot.candlesM15.slice(-192),
      structureAvailable: read !== null,
      multiTimeframe: read?.multiTimeframe ?? null,
      technicalIndicators: read?.indicators ?? null,
      wyckoffVsa: read?.wyckoff ?? null,
      quasimodo: read?.quasimodo ?? null,
      tradingCentralBias: read?.tradingCentral ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    console.error('Market data error:', err);
    return NextResponse.json(
      {
        success: false,
        status: 'unavailable',
        symbol: 'XAUUSD',
        marketPrice: null,
        message: publicErrorMessage(err, 'Market data could not be fetched right now.'),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
