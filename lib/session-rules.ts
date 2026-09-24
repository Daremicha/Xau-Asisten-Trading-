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
  return `The Asian session asks for a conviction of ${floor}: weaker setups in this quiet range lost money in both halves of a 24 month replay. London opens at 07:00 UTC (14:00 WIB).`;
}
