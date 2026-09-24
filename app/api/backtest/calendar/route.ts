import { NextResponse } from 'next/server';
import { backtestCalendar } from '@/lib/calendar-archive';

export const dynamic = 'force-dynamic';

/**
 * The releases a replay reacts to: the checked FOMC, NFP and CPI history plus
 * whatever the live calendar has archived since. An archive that cannot be
 * read leaves the history on its own rather than failing the run.
 */
export async function GET() {
  const { events, archived } = await backtestCalendar();
  return NextResponse.json({ success: true, events, archived });
}
