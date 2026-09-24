/**
 * The dollar releases that move gold most, back to September 2024, so a
 * replay can react to news the way live analysis does.
 *
 * The live calendar only covers the current week, so without this the
 * backtest ran with no news at all. These are the three releases every gold
 * trader plans around. Each date was checked against the publisher's own
 * archive: the Federal Reserve's FOMC statement pages, and the Bureau of Labor
 * Statistics' archived Employment Situation and CPI releases. The shifts forced
 * by the 2025 and 2026 US government shutdowns are included, and the October
 * 2025 reports that were never published are left out. Nothing here is
 * inferred from a rule of thumb.
 *
 * Other high impact releases (PPI, retail sales, ISM, GDP) are not in this
 * list, so a replay reacts to fewer events than live analysis does. The live
 * calendar is archived as it is fetched (see calendar-archive), so later
 * replays fill that gap for the weeks since.
 */

import type { ForexFactoryEvent } from './types';
import { newYorkTime } from './market-hours';

/** FOMC statement days; the statement is released at 14:00 New York time. */
export const FOMC_DECISIONS = [
  '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16',
];

/** Employment Situation (non-farm payrolls) release days, 08:30 New York time. */
export const NFP_RELEASES = [
  '2024-09-06', '2024-10-04', '2024-11-01', '2024-12-06',
  '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02', '2025-06-06', '2025-07-03', '2025-08-01',
  '2025-09-05', '2025-11-20', '2025-12-16',
  '2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07',
  '2026-09-04',
];

/** Consumer Price Index release days, 08:30 New York time. */
export const CPI_RELEASES = [
  '2024-09-11', '2024-10-10', '2024-11-13', '2024-12-11',
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12',
  '2025-09-11', '2025-10-24', '2025-12-18',
  '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12',
  '2026-09-11',
];

function event(title: string, date: string, hour: number, minute: number): ForexFactoryEvent {
  const at = new Date(newYorkTime(date, hour, minute));
  return {
    id: `hist-${title.replace(/\W+/g, '-').toLowerCase()}-${date}`,
    title,
    country: 'USD',
    currency: 'USD',
    impact: 'High',
    time: at.toISOString().slice(11, 16),
    date,
    scheduledTimestamp: at.toISOString(),
    forecast: '',
    previous: '',
    marketImplication: '',
  };
}

/** Every verified release above, oldest first. */
export function historicalHighImpactEvents(): ForexFactoryEvent[] {
  return [
    ...FOMC_DECISIONS.map((d) => event('FOMC Statement', d, 14, 0)),
    ...NFP_RELEASES.map((d) => event('Non-Farm Employment Change', d, 8, 30)),
    ...CPI_RELEASES.map((d) => event('CPI m/m', d, 8, 30)),
  ].sort((a, b) => a.scheduledTimestamp.localeCompare(b.scheduledTimestamp));
}
