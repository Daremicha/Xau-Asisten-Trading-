/**
 * Validation for an order proposed by a language model.
 *
 * A model can write a persuasive rationale around a stop loss on the wrong side
 * of the entry, or quote a level that exists nowhere on the chart. Nothing it
 * proposes reaches the user until it survives every check here, and a rejection
 * always says which rule it broke.
 */

import { round2, priceToPips } from './candles';
import { STYLE_PROFILES, maxEntryDistance, type StyleProfile } from './signal-engine';
import { SmcStructure, TechnicalIndicators, TradingStyle } from './types';

export interface ProposedOrder {
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  rationale: string;
}

export interface ProposalContext {
  price: number;
  indicators: TechnicalIndicators;
  structures: { d1: SmcStructure; h4: SmcStructure; h1: SmcStructure; m15: SmcStructure };
  tradingStyle: TradingStyle;
}

export interface ProposalVerdict {
  accepted: boolean;
  /** Every rule the proposal broke, in the order they were checked. */
  reasons: string[];
  /** Structural level the entry was matched to, when it was accepted. */
  anchoredTo?: string;
}

/** Minimum reward on the first target. Below this the trade is not worth the risk. */
const MIN_REWARD_RATIO = 1.0;
/** How close an entry must sit to a real level, as a multiple of ATR. */
const ANCHOR_TOLERANCE_ATR = 0.5;
/** Nothing may be quoted further than this from live price, as a multiple of ATR. */
const SANITY_BAND_ATR = 12;

function isUsableNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Parses a model's JSON reply into a proposal, or explains why it could not. */
export function parseProposal(raw: string): { proposal: ProposedOrder | null; reasons: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { proposal: null, reasons: ['Model tidak mengembalikan JSON yang valid.'] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { proposal: null, reasons: ['Model mengembalikan sesuatu yang bukan objek.'] };
  }

  const p = parsed as Record<string, unknown>;
  const reasons: string[] = [];

  const direction = String(p.direction ?? '').toLowerCase();
  if (direction !== 'long' && direction !== 'short') {
    reasons.push('Arah harus tepat "long" atau "short".');
  }

  const numeric: Record<string, number> = {};
  for (const field of ['entryPrice', 'stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3']) {
    const value = p[field];
    if (!isUsableNumber(value)) reasons.push(`${field} kosong atau bukan angka positif.`);
    else numeric[field] = value;
  }

  const rationale = typeof p.rationale === 'string' ? p.rationale.trim() : '';
  if (rationale.length < 20) reasons.push('Alasannya kosong atau terlalu pendek untuk ditinjau.');

  if (reasons.length > 0) return { proposal: null, reasons };

  return {
    proposal: {
      direction: direction as 'long' | 'short',
      entryPrice: numeric.entryPrice,
      stopLoss: numeric.stopLoss,
      takeProfit1: numeric.takeProfit1,
      takeProfit2: numeric.takeProfit2,
      takeProfit3: numeric.takeProfit3,
      rationale,
    },
    reasons: [],
  };
}

/** Every structural level the engine measured, as candidate anchors. */
export function structuralLevels(
  ctx: ProposalContext
): Array<{ name: string; price: number }> {
  const out: Array<{ name: string; price: number }> = [];
  for (const [label, s] of Object.entries(ctx.structures)) {
    const tf = label.toUpperCase();
    out.push({ name: `high order block ${tf}`, price: s.orderBlock.high });
    out.push({ name: `low order block ${tf}`, price: s.orderBlock.low });
    out.push({ name: `tengah order block ${tf}`, price: (s.orderBlock.high + s.orderBlock.low) / 2 });
    if (s.fairValueGap.detected) {
      out.push({ name: `atas fair value gap ${tf}`, price: s.fairValueGap.top });
      out.push({ name: `bawah fair value gap ${tf}`, price: s.fairValueGap.bottom });
      out.push({
        name: `tengah fair value gap ${tf}`,
        price: (s.fairValueGap.top + s.fairValueGap.bottom) / 2,
      });
    }
    if (typeof s.bosLevel === 'number') out.push({ name: `break of structure ${tf}`, price: s.bosLevel });
    out.push({ name: `high hari sebelumnya ${tf}`, price: s.liquidityPools.pdh });
    out.push({ name: `low hari sebelumnya ${tf}`, price: s.liquidityPools.pdl });
    out.push({ name: `high Asia ${tf}`, price: s.liquidityPools.asiaHigh });
    out.push({ name: `low Asia ${tf}`, price: s.liquidityPools.asiaLow });
  }
  out.push({ name: `EMA ${ctx.indicators.emaFastPeriod}`, price: ctx.indicators.ema50 });
  out.push({ name: `EMA ${ctx.indicators.emaSlowPeriod}`, price: ctx.indicators.ema200 });
  return out;
}

/**
 * Checks a proposal against the same constraints the deterministic engine obeys.
 * The proposal is accepted only when it breaks none of them.
 */
export function validateProposal(proposal: ProposedOrder, ctx: ProposalContext): ProposalVerdict {
  const reasons: string[] = [];
  const profile: StyleProfile = STYLE_PROFILES[ctx.tradingStyle];
  const atr = ctx.indicators.atr14;
  const isLong = proposal.direction === 'long';
  const { entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3 } = proposal;

  // A level far from the market is a typo or a hallucination, not a trade idea.
  const band = atr * SANITY_BAND_ATR;
  for (const [label, value] of Object.entries({ entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3 })) {
    if (Math.abs(value - ctx.price) > band) {
      reasons.push(
        `${label} di ${value.toFixed(2)} berjarak ${priceToPips(value - ctx.price)} pips dari harga, di luar batas wajar ${priceToPips(band)} pip.`
      );
    }
  }

  // Geometry must match the stated direction.
  if (isLong) {
    if (stopLoss >= entryPrice) reasons.push('Stop loss posisi long harus di bawah entry.');
    if (takeProfit1 <= entryPrice) reasons.push('Target pertama posisi long harus di atas entry.');
    if (takeProfit2 <= takeProfit1 || takeProfit3 <= takeProfit2) {
      reasons.push('Target long harus naik dari yang pertama sampai yang ketiga.');
    }
  } else {
    if (stopLoss <= entryPrice) reasons.push('Stop loss posisi short harus di atas entry.');
    if (takeProfit1 >= entryPrice) reasons.push('Target pertama posisi short harus di bawah entry.');
    if (takeProfit2 >= takeProfit1 || takeProfit3 >= takeProfit2) {
      reasons.push('Target short harus turun dari yang pertama sampai yang ketiga.');
    }
  }

  // Risk must fit the style the user chose.
  const risk = Math.abs(entryPrice - stopLoss);
  if (risk < profile.minStopDollars - 0.005) {
    reasons.push(
      `Stop ${ctx.tradingStyle} sebesar ${priceToPips(risk)} pips lebih sempit dari minimum ${priceToPips(profile.minStopDollars)} pip untuk gaya ini.`
    );
  }
  if (risk > profile.maxStopDollars + 0.005) {
    reasons.push(
      `Stop ${ctx.tradingStyle} sebesar ${priceToPips(risk)} pips lebih lebar dari batas ${priceToPips(profile.maxStopDollars)} pip untuk gaya ini.`
    );
  }

  // The order has to be reachable to be worth placing.
  const reach = maxEntryDistance(profile, atr);
  const distance = Math.abs(entryPrice - ctx.price);
  if (distance > reach) {
    reasons.push(
      `Entry berjarak ${priceToPips(distance)} pips, di luar jangkauan ${priceToPips(reach)} pip untuk setup ${ctx.tradingStyle}.`
    );
  }

  // The first target must pay for the risk taken.
  const reward = Math.abs(takeProfit1 - entryPrice);
  if (risk > 0 && reward / risk < MIN_REWARD_RATIO) {
    reasons.push(
      `Target pertama membayar ${(reward / risk).toFixed(2)} kali risiko, di bawah minimum ${MIN_REWARD_RATIO.toFixed(2)}.`
    );
  }

  // The entry must correspond to something the engine actually measured.
  const tolerance = atr * ANCHOR_TOLERANCE_ATR;
  let anchoredTo: string | undefined;
  let closest = Infinity;
  for (const level of structuralLevels(ctx)) {
    const gap = Math.abs(level.price - entryPrice);
    if (gap < closest) closest = gap;
    if (gap <= tolerance && !anchoredTo) anchoredTo = level.name;
  }
  if (!anchoredTo) {
    reasons.push(
      `Entry di ${entryPrice.toFixed(2)} tidak cocok dengan level terukur mana pun; yang terdekat berjarak ${priceToPips(closest)} pips, di luar toleransi ${priceToPips(tolerance)} pip.`
    );
  }

  return { accepted: reasons.length === 0, reasons, anchoredTo };
}

/** Rounds an accepted proposal to quoting precision. */
export function normaliseProposal(proposal: ProposedOrder): ProposedOrder {
  return {
    ...proposal,
    entryPrice: round2(proposal.entryPrice),
    stopLoss: round2(proposal.stopLoss),
    takeProfit1: round2(proposal.takeProfit1),
    takeProfit2: round2(proposal.takeProfit2),
    takeProfit3: round2(proposal.takeProfit3),
  };
}
