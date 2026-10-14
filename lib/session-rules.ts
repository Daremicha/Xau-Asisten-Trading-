/**
 * Conviction the market session itself demands, on top of the user's floor.
 *
 * The Asian session is gold's quiet range, where liquidity builds for London
 * to sweep. A 24 month Intraday replay, weekend bars removed, split its weak
 * setups by session: under a conviction of 55, Asian ones returned -0.11R in
 * the first half and -0.12R in the second, the only session losing in both.
 * Stronger Asian setups paid in both halves. Declining the weak ones took a
 * floor of 40 from profit factor 1.20 to 1.27 and its worst losing streak from
 * 16 to 13, with both halves improving; Scalping at 40 went from 1.09 to 1.17.
 * A cut at 40 changed nothing and one at 70 helped less, so 55 is the level.
 */

import type { getICTKillZoneStatus } from './market-engine';

type Zone = ReturnType<typeof getICTKillZoneStatus>['currentZone'];

export const ASIAN_SESSION_MIN_CONVICTION = 55;

/** The lowest conviction this session allows, whatever the user's floor. */
export function sessionConvictionFloor(zone: Zone): number {
  return zone === 'Asian Session' ? ASIAN_SESSION_MIN_CONVICTION : 0;
}

/** The floor actually applied: the user's, or the session's when it is higher. */
export function effectiveConvictionFloor(userFloor: number, zone: Zone): number {
  return Math.max(userFloor, sessionConvictionFloor(zone));
}

/** Why a setup the user's floor would have allowed was still declined, or null. */
export function sessionDeclineNote(userFloor: number, zone: Zone, score: number): string | null {
  const floor = sessionConvictionFloor(zone);
  if (score >= floor || userFloor >= floor) return null;
  return `Sesi Asia meminta conviction minimal ${floor}: setup yang lebih lemah di range sepi ini rugi di kedua paruh backtest 24 bulan. London buka jam 07:00 UTC (14:00 WIB).`;
}

/**
 * The weakest setups are only worth taking when the directional bias agrees.
 *
 * Under a conviction of 40, taking everything was the part of the engine that
 * lost: swings from hundreds of break-even trades, each a minimum lot. Split
 * by how each factor voted, the pivot and directional bias read was the
 * clearest divider, the same way round in both halves of a 24 month Intraday
 * replay: setups it argued for returned +0.09R and +0.25R, setups it argued
 * against -0.06R and -0.11R. Taking only the first kind moved taking
 * everything from profit factor 1.02 and a 60% worst drawdown, losing money in
 * the second half, to 1.22 and 24%, both halves paying: more trades than a
 * floor of 40 and more money, for the same drawdown. Applying the same test up
 * to 55 did worse, so it stops at 40.
 */
export const WEAK_SETUP_BELOW = 40;
const PIVOT_FACTOR = 'Pivot and directional bias';
const AGREES = 0.15;

/** Why a weak setup is declined, or null when it may be taken. */
export function weakSetupDecline(score: number, alignedFactorVotes: Record<string, number>): string | null {
  if (score >= WEAK_SETUP_BELOW) return null;
  if ((alignedFactorVotes[PIVOT_FACTOR] ?? 0) > AGREES) return null;
  return `Setup dengan conviction di bawah ${WEAK_SETUP_BELOW} hanya ditawarkan kalau pivot dan arah bias mendukungnya. Setup lemah tanpa dukungan itu rugi di kedua paruh backtest 24 bulan.`;
}
