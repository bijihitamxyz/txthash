/**
 * Context-Aware Auto Trailing Stop & Auto 50% Partial Close (src/core/trailingManager.ts)
 * Zero manual tuning required — dynamically adapts trailing tightness based on
 * live market state, ATR(14) volatility, and Bollinger Band position.
 *
 * Phase 1 — Auto-Breakeven & 50% Partial Close at Middle BB:
 *   - When price reaches >= 70% of distance from entryPrice to MiddleBB:
 *     - If volume >= 0.02 and !partialClosed, automatically partial-close 50%
 *     - Move Stop Loss to entryPrice + (2 * pipValue) [BUY] or - (2 * pipValue) [SELL] (Breakeven Locked)
 *
 * Phase 2 — Adaptive Market-Condition Trailing (Beyond Middle BB):
 *   - Once price crosses MiddleBB, dynamically calculate trailing distance:
 *     - Calm/Normal (BBW Expansion < 20%): Tight = 0.9 * ATR_14
 *     - Strong Breakout (BBW Expansion >= 20%): Wide = 1.4 * ATR_14
 *     - Extreme Climax (RSI >= 78 on BUY or RSI <= 22 on SELL): Ultra-tight = 0.5 * ATR_14
 *   - Only send PATCH SL update when new SL advances by at least 0.25 * ATR_14 (min 2 pips).
 */

import { PairProfile, roundLotVolume, priceDiffToPips, formatPrice, calculatePnL, getPairProfile } from './pairConfig';
import {
  computeExpectedMarketMove,
  ExpectedMoveProjection,
  ExpectedMoveInput,
} from './indicatorEngine';

export { computeExpectedMarketMove };
export type { ExpectedMoveProjection, ExpectedMoveInput };

export type PositionTrailingStatus =
  | 'INITIAL'
  | 'PARTIAL_CLOSED_BE'
  | 'BREAKEVEN_LOCKED'
  | 'ATR_TRAILING'
  | 'TIME_DECAY_PROTECT'
  | 'PHASE_A_ELASTIC'
  | 'PHASE_B_RATCHET'
  | 'CRASH_FREEZE_LOCK';

export interface ManagedPosition {
  id: string; // Exness order / position ticket id
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number; // Current open lots
  initialVolume: number;
  entryPrice: number;
  currentPrice?: number;
  currentSl: number;
  currentTp: number;
  virtualSl?: number;
  virtualTp?: number;
  highestPrice: number;
  lowestPrice: number;
  openTime: number;
  partialClosed: boolean;
  trailingStatus: PositionTrailingStatus;
  lastSlUpdateTime?: number;
  unrealizedPnl?: number;
  // Style 2 Hybrid Trailing Stop state locks
  elasticFloorLocked?: boolean;
  strictRatchetLocked?: boolean;
  // Closing lock & cooldown state (prevents 2 Open <-> 3 Open flicker & zombie close loops)
  isClosing?: boolean;
  closingStartedAt?: number;
  // Floating metrics refreshed every tick (UI: ACTIVE OPEN POSITIONS)
  pnl?: number;
  pips?: number;
  // Persistence metadata for activeForexPositions ledger (merge remote Exness + local filled orders)
  accountId?: string;
  source?: 'EXNESS' | 'LOCAL_LEDGER';
  seenOnBroker?: boolean;
}

// =========================================================================
// IN-FLIGHT CLOSE LOCK & 15-SECOND COOLDOWN PER TICKET ID
// Prevents zombie [STOP LOSS / TRAILING STOP HIT] loops every 3 seconds
// =========================================================================
const CLOSE_COOLDOWN_MS = 15_000;

declare global {
  // eslint-disable-next-line no-var
  var __inFlightClosingIds: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __closingCooldownMap: Map<string, number> | undefined;
}

export const inFlightClosingIds: Set<string> =
  globalThis.__inFlightClosingIds || (globalThis.__inFlightClosingIds = new Set<string>());

export const closingCooldownMap: Map<string, number> =
  globalThis.__closingCooldownMap || (globalThis.__closingCooldownMap = new Map<string, number>());

function normTicketId(id: string): string {
  return String(id || '').replace(/^#+/, '').trim();
}

/**
 * Returns true ONLY if the ticket is not currently in-flight for closing
 * AND has not triggered a close attempt within the last 15 seconds.
 */
export function canAttemptPositionClose(positionId: string, cooldownMs: number = CLOSE_COOLDOWN_MS): boolean {
  const cleanId = normTicketId(positionId);
  if (!cleanId) return false;
  const now = Date.now();
  const lastAttempt = closingCooldownMap.get(cleanId) || 0;
  if (inFlightClosingIds.has(cleanId)) {
    // Release stale in-flight lock if older than cooldownMs
    if (now - lastAttempt < cooldownMs) {
      return false;
    }
    inFlightClosingIds.delete(cleanId);
  }
  if (now - lastAttempt < cooldownMs) {
    return false;
  }
  return true;
}

export function markPositionClosingStart(positionId: string): void {
  const cleanId = normTicketId(positionId);
  if (!cleanId) return;
  inFlightClosingIds.add(cleanId);
  closingCooldownMap.set(cleanId, Date.now());
}

export function markPositionClosingDone(positionId: string, closedSuccess: boolean = false): void {
  const cleanId = normTicketId(positionId);
  if (!cleanId) return;
  inFlightClosingIds.delete(cleanId);
  if (!closedSuccess) {
    // Keep the 15s cooldown active from the attempt timestamp so it won't spam every 3s
    if (!closingCooldownMap.has(cleanId)) {
      closingCooldownMap.set(cleanId, Date.now());
    }
  }
}

/**
 * Sanitizes & validates Stop Loss / Take Profit direction and auto-assigns
 * Virtual SL, Virtual TP, and initial Hybrid Trailing SL for positions opened
 * without broker SL/TP (e.g. via Retry 1 Strip Inline SL/TP).
 *
 * - Rule for BUY (LONG):
 *   sl MUST strictly be < entryPrice (unless profit has already exceeded entry AND currentPrice is STILL above sl).
 *   If sl >= entryPrice while currentPrice <= entryPrice (like BUY @ 4050.06 with bogus SL: 4108.30),
 *   or if sl >= currentPrice while sl >= entryPrice, immediately recalculate to entryPrice - (slPips * pipVal).
 * - Rule for SELL (SHORT):
 *   sl MUST strictly be > entryPrice when at or above entry (in loss).
 *   If sl <= entryPrice while in loss, or if sl <= currentPrice while sl <= entryPrice,
 *   immediately recalculate to entryPrice + (slPips * pipVal).
 */
export function sanitizePositionSlTp(
  pos: ManagedPosition,
  livePrice?: number,
  slPips: number = 25,
  tpPips: number = 50
): ManagedPosition {
  if (!pos || !(pos.entryPrice > 0)) return pos;
  const profile = getPairProfile(pos.symbol || 'XAUUSDm');
  const isGold = profile.symbol === 'XAUUSDm' || profile.symbol.startsWith('XAU');
  const pipVal = isGold ? 0.10 : profile.pipValue;
  const digits = profile.digits;
  const isBuy = pos.side === 'BUY';

  const effectiveSlPips = slPips > 0 ? slPips : 25;
  const effectiveTpPips = tpPips > 0 ? tpPips : 50;

  const defaultVirtualSl = isBuy
    ? Number((pos.entryPrice - effectiveSlPips * pipVal).toFixed(digits))
    : Number((pos.entryPrice + effectiveSlPips * pipVal).toFixed(digits));

  const defaultVirtualTp = isBuy
    ? Number((pos.entryPrice + effectiveTpPips * pipVal).toFixed(digits))
    : Number((pos.entryPrice - effectiveTpPips * pipVal).toFixed(digits));

  const curPx =
    typeof livePrice === 'number' && livePrice > 0 && !isNaN(livePrice)
      ? livePrice
      : typeof pos.currentPrice === 'number' && pos.currentPrice > 0 && !isNaN(pos.currentPrice)
      ? pos.currentPrice
      : pos.entryPrice;

  // Sanitize highestPrice / lowestPrice against stale baseline pollution (e.g. 4110.30 when entry is 4050.06)
  const maxExcursionGuard = isGold ? 15.0 : 150 * pipVal;
  const maxValidHigh = Math.max(pos.entryPrice, curPx) + maxExcursionGuard;
  const minValidLow = Math.min(pos.entryPrice, curPx) - maxExcursionGuard;

  if (!pos.highestPrice || pos.highestPrice <= 0 || pos.highestPrice > maxValidHigh || pos.highestPrice < pos.entryPrice) {
    pos.highestPrice = Math.max(pos.entryPrice, curPx);
    if (isBuy && curPx <= pos.entryPrice + 25 * pipVal) {
      pos.strictRatchetLocked = false;
    }
  }
  if (!pos.lowestPrice || pos.lowestPrice <= 0 || pos.lowestPrice < minValidLow || pos.lowestPrice > pos.entryPrice) {
    pos.lowestPrice = Math.min(pos.entryPrice, curPx);
    if (!isBuy && curPx >= pos.entryPrice - 25 * pipVal) {
      pos.strictRatchetLocked = false;
    }
  }

  // Validate existing SL
  let rawSl = Number(pos.currentSl || pos.virtualSl || 0);
  if (!isFinite(rawSl) || rawSl <= 0) {
    rawSl = defaultVirtualSl;
  } else if (isBuy) {
    // Rule for BUY (LONG):
    // sl MUST strictly be < entryPrice unless profit has already exceeded entry AND currentPrice is STILL above sl.
    // Also reject any SL that is > $15.00 (150 pips) away from both entryPrice and curPx.
    const inLossOrAtEntry = curPx <= pos.entryPrice;
    const isAboveEntryWhileInLoss = rawSl >= pos.entryPrice && inLossOrAtEntry;
    const isAboveCurrentInProfit = rawSl >= pos.entryPrice && curPx <= rawSl;
    const isBogusFarSl = Math.abs(rawSl - pos.entryPrice) > maxExcursionGuard && Math.abs(rawSl - curPx) > maxExcursionGuard;
    if (isAboveEntryWhileInLoss || isAboveCurrentInProfit || isBogusFarSl) {
      rawSl = defaultVirtualSl;
      pos.trailingStatus = 'INITIAL';
      pos.strictRatchetLocked = false;
    }
  } else {
    // Rule for SELL (SHORT):
    // sl MUST strictly be > entryPrice when at or above entry (in loss).
    const inLossOrAtEntry = curPx >= pos.entryPrice;
    const isBelowEntryWhileInLoss = rawSl <= pos.entryPrice && inLossOrAtEntry;
    const isBelowCurrentInProfit = rawSl <= pos.entryPrice && curPx >= rawSl;
    const isBogusFarSl = Math.abs(rawSl - pos.entryPrice) > maxExcursionGuard && Math.abs(rawSl - curPx) > maxExcursionGuard;
    if (isBelowEntryWhileInLoss || isBelowCurrentInProfit || isBogusFarSl) {
      rawSl = defaultVirtualSl;
      pos.trailingStatus = 'INITIAL';
      pos.strictRatchetLocked = false;
    }
  }

  // Validate existing TP
  let rawTp = Number(pos.currentTp || pos.virtualTp || 0);
  const maxTpGuard = isGold ? 30.0 : 300 * pipVal;
  if (!isFinite(rawTp) || rawTp <= 0) {
    rawTp = defaultVirtualTp;
  } else if (isBuy) {
    if (rawTp <= pos.entryPrice || Math.abs(rawTp - pos.entryPrice) > maxTpGuard) {
      rawTp = defaultVirtualTp;
    }
  } else {
    if (rawTp >= pos.entryPrice || Math.abs(rawTp - pos.entryPrice) > maxTpGuard) {
      rawTp = defaultVirtualTp;
    }
  }

  pos.virtualSl = Number(rawSl.toFixed(digits));
  pos.virtualTp = Number(rawTp.toFixed(digits));
  pos.currentSl = pos.virtualSl;
  pos.currentTp = pos.virtualTp;

  return pos;
}

export interface TrailingAction {
  type: 'NONE' | 'PARTIAL_CLOSE' | 'MODIFY_SL' | 'PARTIAL_AND_MODIFY_SL' | 'HARD_SL_CLOSE';
  positionId: string;
  symbol: string;
  closeVolume?: number;
  remainingVolume?: number;
  newSlPrice?: number;
  formattedSlPrice?: string;
  reason: string;
  statusUpdate: PositionTrailingStatus;
}

export interface TrailingEvaluationInput {
  position: ManagedPosition;
  currentBid: number;
  currentAsk: number;
  middleBB: number;
  atr14: number;
  bbwExpansionPct?: number;
  currentRsi?: number;
  pairProfile: PairProfile;
  enablePartialClose?: boolean;
  stopLossPips?: number;
  // Quantitative Expected Market Move & Kronos metrics for Style 2 Hybrid Trailing
  expectedMovePct?: number;
  expectedTargetPrice?: number;
  expectedMoveUsd?: number;
  pocPrice?: number;
  vahPrice?: number;
  valPrice?: number;
  zScore?: number;
  opposingRegimePct?: number;
}

/**
 * Evaluates whether an open position qualifies for Auto Partial Close, Breakeven Lock,
 * or Adaptive Market-Condition Trailing.
 */
export function evaluatePositionTrailing(input: TrailingEvaluationInput): TrailingAction {
  const {
    position,
    currentBid,
    currentAsk,
    middleBB,
    atr14,
    bbwExpansionPct = 10,
    currentRsi = 50,
    pairProfile,
    enablePartialClose = true,
    stopLossPips = 25,
  } = input;

  const profile = pairProfile;
  const isBuy = position.side === 'BUY';
  const currentPrice = isBuy ? currentBid : currentAsk;

  if (!currentPrice || currentPrice <= 0 || isNaN(currentPrice)) {
    return {
      type: 'NONE',
      positionId: position.id,
      symbol: position.symbol,
      reason: `[QUOTE GUARD] Invalid live quote for ${position.symbol} (bid=${currentBid}, ask=${currentAsk}). Skipping trailing evaluation.`,
      statusUpdate: position.trailingStatus,
    };
  }

  // 2% Price Deviation Guard: Never evaluate SL, TP, Partial Close, or Trailing Stop if quote differs by > 2% from previous valid price
  const prevPrice = position.currentPrice || position.entryPrice;
  if (prevPrice > 0) {
    const deviation = Math.abs(currentPrice - prevPrice) / prevPrice;
    if (deviation > 0.02) {
      return {
        type: 'NONE',
        positionId: position.id,
        symbol: position.symbol,
        reason: `[PRICE DEVIATION GUARD] Quote price ${currentPrice} differs by ${(deviation * 100).toFixed(1)}% from previous valid price ${prevPrice} (> 2%). Skipping trailing evaluation.`,
        statusUpdate: position.trailingStatus,
      };
    }
  }
  position.currentPrice = currentPrice;

  // Sanitize & validate SL/TP direction and auto-assign virtualSl / virtualTp before evaluating trailing
  sanitizePositionSlTp(position, currentPrice, stopLossPips);

  // Track Peak and Trough price over lifetime of position
  const updatedHighest = Math.max(position.highestPrice || position.entryPrice, currentPrice);
  const updatedLowest = position.lowestPrice === 0
    ? currentPrice
    : Math.min(position.lowestPrice || position.entryPrice, currentPrice);

  position.highestPrice = updatedHighest;
  position.lowestPrice = updatedLowest;

  const currentProfitDistance = isBuy
    ? (currentPrice - position.entryPrice)
    : (position.entryPrice - currentPrice);

  const currentProfitPips = priceDiffToPips(currentProfitDistance, profile.pipValue);

  // Calculate exact Unrealized PnL ($1.00 per 1.00 move per 0.01 lot on Gold)
  let unrealizedPnl = 0;
  if (profile.category === 'METAL' || profile.symbol === 'XAUUSDm') {
    unrealizedPnl = isBuy
      ? (currentPrice - position.entryPrice) * (position.volume * 100)
      : (position.entryPrice - currentPrice) * (position.volume * 100);
  } else {
    unrealizedPnl = calculatePnL(position.side, position.entryPrice, currentPrice, position.volume, profile).pnlUsd;
  }
  unrealizedPnl = Number(unrealizedPnl.toFixed(2));
  position.unrealizedPnl = unrealizedPnl;

  // =========================================================================
  // HARD SL CIRCUIT BREAKER:
  // - Minimum 15-second grace period after order entry (protects initial spread/noise)
  // - Calculated strictly from user's configured stopLossPips (safety floor of 25 pips on XAUUSDm)
  //   e.g. 25 pips on 0.01 lot -> -$2.50 limit; 25 pips on 0.10 lot -> -$25.00 limit.
  // =========================================================================
  const tradeAgeMs = Date.now() - (position.openTime || Date.now());
  const isInGracePeriod = position.openTime > 0 && tradeAgeMs < 15000;

  const effectiveSlPips = Math.max(25, stopLossPips || 25);
  let pipValueUsdPerLot = 10;
  if (profile.category === 'METAL' || profile.symbol === 'XAUUSDm') {
    pipValueUsdPerLot = 100 * profile.pipValue;
  } else if (profile.symbol.startsWith('USDJPY')) {
    pipValueUsdPerLot = (100000 * profile.pipValue) / (currentPrice > 0 ? currentPrice : 157.0);
  } else {
    pipValueUsdPerLot = (profile.contractSize || 100000) * profile.pipValue;
  }

  const hardSlLimitUsd = -Number((position.volume * pipValueUsdPerLot * effectiveSlPips).toFixed(2));

  if (!isInGracePeriod && unrealizedPnl <= hardSlLimitUsd) {
    if (!canAttemptPositionClose(position.id)) {
      return {
        type: 'NONE',
        positionId: position.id,
        symbol: position.symbol,
        reason: `[CLOSE COOLDOWN] Close request for #${position.id} is already in-flight or within 15s cooldown.`,
        statusUpdate: position.trailingStatus,
      };
    }
    return {
      type: 'HARD_SL_CLOSE',
      positionId: position.id,
      symbol: position.symbol,
      reason: `[HARD SL CIRCUIT BREAKER] Position PnL ($${unrealizedPnl.toFixed(2)}) breached -$${Math.abs(hardSlLimitUsd).toFixed(2)} limit (${effectiveSlPips} pips) for ${position.volume} lot. Auto-closing position immediately.`,
      statusUpdate: position.trailingStatus,
    };
  }

  // =========================================================================
  // QUANTITATIVE EXPECTED MOVE (% AND TARGET PRICE) ESTIMATOR
  // =========================================================================
  const peakProfitDistance = isBuy
    ? (updatedHighest - position.entryPrice)
    : (position.entryPrice - updatedLowest);
  const peakProfitPips = priceDiffToPips(peakProfitDistance, profile.pipValue);

  const safeAtr = atr14 > 0 ? atr14 : 15 * profile.pipValue;
  const pocPrice = input.pocPrice && input.pocPrice > 0 ? input.pocPrice : (middleBB > 0 ? middleBB : currentPrice);
  const vahPrice = input.vahPrice && input.vahPrice > 0 ? input.vahPrice : pocPrice + safeAtr;
  const valPrice = input.valPrice && input.valPrice > 0 ? input.valPrice : pocPrice - safeAtr;
  const zScore = input.zScore ?? 0;

  const expectedProj = computeExpectedMarketMove({
    currentPrice,
    pocPrice,
    vahPrice,
    valPrice,
    atr14: safeAtr,
    zScore,
    rsi: currentRsi,
    bbwExpansionPct,
    digits: profile.digits,
  });

  const expectedMovePct = input.expectedMovePct ?? expectedProj.expectedMovePct;
  const expectedTargetPrice = input.expectedTargetPrice ?? expectedProj.expectedTargetPrice;
  const expectedMoveUsd = input.expectedMoveUsd ?? expectedProj.expectedMoveUsd;
  const opposingRegimePct =
    input.opposingRegimePct ??
    (isBuy ? (currentRsi <= 32 ? 78 : 50) : (currentRsi >= 68 ? 78 : 50));

  // Opposing move against position direction:
  // For BUY: negative expectedMovePct (downside move); for SELL: positive expectedMovePct (upside move)
  const isMoveAgainstPosition = isBuy ? expectedMovePct < 0 : expectedMovePct > 0;
  const opposingMovePct = isMoveAgainstPosition ? Math.abs(expectedMovePct) : 0;
  const opposingMoveDist = isMoveAgainstPosition ? Math.abs(expectedMoveUsd) : 0;

  const isDrasticDropFreeze = opposingMovePct > 0.12 || opposingRegimePct > 75;
  const isSevereCrashSpike = opposingMovePct > 0.15 || opposingRegimePct > 80;

  // Permanently lock Phase B strict one-way ratchet once profit >= 25 pips or drastic drop detected
  if (
    peakProfitPips >= 25 ||
    currentProfitPips >= 25 ||
    isDrasticDropFreeze ||
    position.trailingStatus === 'PHASE_B_RATCHET' ||
    position.trailingStatus === 'CRASH_FREEZE_LOCK'
  ) {
    position.strictRatchetLocked = true;
  }

  // =========================================================================
  // AUTO 50% PARTIAL CLOSE AT MID BB / +0.6R
  // =========================================================================
  const minProfitPips = 3.5;
  const minProfitDistance = minProfitPips * profile.pipValue;
  const riskDistance = position.currentSl > 0
    ? Math.abs(position.entryPrice - position.currentSl)
    : Math.max(1.5 * safeAtr, minProfitDistance / 0.6);

  const hasNetPositiveProfit = isBuy
    ? (currentBid > position.entryPrice + minProfitDistance || (riskDistance > 0 && currentBid >= position.entryPrice + 0.6 * riskDistance))
    : (currentAsk < position.entryPrice - minProfitDistance || (riskDistance > 0 && currentAsk <= position.entryPrice - 0.6 * riskDistance));

  const buyPartialCloseQualified = isBuy &&
    (currentBid > position.entryPrice + minProfitDistance) &&
    (
      (middleBB > position.entryPrice + minProfitDistance && currentBid >= middleBB) ||
      (riskDistance > 0 && currentBid >= position.entryPrice + 0.6 * riskDistance)
    );

  const sellPartialCloseQualified = !isBuy &&
    (currentAsk < position.entryPrice - minProfitDistance) &&
    (
      (middleBB < position.entryPrice - minProfitDistance && currentAsk <= middleBB) ||
      (riskDistance > 0 && currentAsk <= position.entryPrice - 0.6 * riskDistance)
    );

  const shouldTriggerPartialClose = enablePartialClose &&
    !position.partialClosed &&
    position.volume >= 0.02 &&
    hasNetPositiveProfit &&
    (buyPartialCloseQualified || sellPartialCloseQualified);

  const beSlPrice = position.entryPrice;
  const formattedBeSl = formatPrice(beSlPrice, profile.digits);
  const numericBeSl = Number(formattedBeSl);
  const isSlImprovementToBe = isBuy
    ? (position.currentSl === 0 || numericBeSl > position.currentSl)
    : (position.currentSl === 0 || numericBeSl < position.currentSl);

  if (shouldTriggerPartialClose) {
    const partialCloseVol = roundLotVolume(position.volume * 0.5, profile.minLot, profile.lotStep);
    const remainingVol = Number((position.volume - partialCloseVol).toFixed(2));
    const isMidBbTriggered = isBuy
      ? (middleBB > position.entryPrice + minProfitDistance && currentBid >= middleBB)
      : (middleBB < position.entryPrice - minProfitDistance && currentAsk <= middleBB);

    const triggerLabel = isMidBbTriggered
      ? `Middle BB (${formatPrice(middleBB, profile.digits)} > Entry ${formatPrice(position.entryPrice, profile.digits)})`
      : `+0.6R Target (${formatPrice(isBuy ? position.entryPrice + 0.6 * riskDistance : position.entryPrice - 0.6 * riskDistance, profile.digits)})`;

    const lockBeOnPartial = peakProfitPips >= 10 && isSlImprovementToBe;
    return {
      type: lockBeOnPartial ? 'PARTIAL_AND_MODIFY_SL' : 'PARTIAL_CLOSE',
      positionId: position.id,
      symbol: position.symbol,
      closeVolume: partialCloseVol,
      remainingVolume: remainingVol,
      newSlPrice: lockBeOnPartial ? numericBeSl : position.currentSl,
      formattedSlPrice: lockBeOnPartial ? formattedBeSl : formatPrice(position.currentSl, profile.digits),
      reason: `[MID BB PARTIAL CLOSE] Reached ${triggerLabel}: 50% Banked (${partialCloseVol} lots)${lockBeOnPartial ? ` + Initial Trailing SL at ${formattedBeSl}` : ''}`,
      statusUpdate: 'PARTIAL_CLOSED_BE',
    };
  }

  // =========================================================================
  // FREQTRADE TIME-DECAY STAGNANT TRADE EXIT (>9 candles / 45 minutes)
  // =========================================================================
  const isStagnant = tradeAgeMs >= 45 * 60 * 1000;
  const isSlightlyPositive =
    unrealizedPnl > 0.10 ||
    currentProfitDistance >= (profile.symbol === 'XAUUSDm' ? 0.15 : 1.5 * profile.pipValue);

  if (isStagnant && !position.partialClosed && isSlightlyPositive) {
    if (isSlImprovementToBe) {
      return {
        type: 'MODIFY_SL',
        positionId: position.id,
        symbol: position.symbol,
        newSlPrice: numericBeSl,
        formattedSlPrice: formattedBeSl,
        reason: `[TIME_DECAY_PROTECT] Stagnant trade active ${(tradeAgeMs / 60000).toFixed(0)}m (>45m / 9 candles): Moved SL to Entry (${formattedBeSl}) to eliminate drawdown.`,
        statusUpdate: 'TIME_DECAY_PROTECT',
      };
    } else if (position.trailingStatus === 'TIME_DECAY_PROTECT' && unrealizedPnl >= 0.20) {
      return {
        type: 'HARD_SL_CLOSE',
        positionId: position.id,
        symbol: position.symbol,
        reason: `[TIME_DECAY_PROTECT] Executing protective close on stagnant trade (${(tradeAgeMs / 60000).toFixed(0)}m active) at +$${unrealizedPnl.toFixed(2)} to recycle margin.`,
        statusUpdate: 'TIME_DECAY_PROTECT',
      };
    }
  }

  const minStep = profile.symbol === 'XAUUSDm' ? 0.10 : profile.pipValue; // 1 pip minimum step
  const ratchetDist = 20 * profile.pipValue; // $2.00 on XAUUSDm (20 pips)
  const elasticMaxFloorDist = 30 * profile.pipValue; // $3.00 strict floor on XAUUSDm (30 pips)
  const crashTightLockDist = 5 * profile.pipValue; // $0.50 tight lock on XAUUSDm (5 pips)

  // =========================================================================
  // STYLE 2 HYBRID TRAILING STOP — PHASE B:
  // STRICT MT5 ONE-WAY RATCHET & CRASH FREEZE
  // (When Profit >= +25 pips OR Drastic Drop > 0.12% Detected)
  // =========================================================================
  if (position.strictRatchetLocked || peakProfitPips >= 25 || isDrasticDropFreeze) {
    position.strictRatchetLocked = true;

    // 1. Drastic Crash Tight Lock: if position is in profit >= +15 pips while a drastic crash (> 0.15% opposing spike) starts,
    // lock SL tight at currentPrice - $0.50 (BUY) or currentPrice + $0.50 (SELL) to capture profit immediately!
    if (currentProfitPips >= 15 && isSevereCrashSpike) {
      const crashSlRaw = isBuy ? (currentPrice - crashTightLockDist) : (currentPrice + crashTightLockDist);
      const formattedCrashSl = formatPrice(crashSlRaw, profile.digits);
      const numericCrashSl = Number(formattedCrashSl);
      const isValidDir = isBuy
        ? numericCrashSl < currentPrice - profile.pipValue
        : numericCrashSl > currentPrice + profile.pipValue;
      const improvesSl = isValidDir && (isBuy
        ? (position.currentSl === 0 || numericCrashSl > position.currentSl)
        : (position.currentSl === 0 || numericCrashSl < position.currentSl));

      if (improvesSl) {
        return {
          type: 'MODIFY_SL',
          positionId: position.id,
          symbol: position.symbol,
          newSlPrice: numericCrashSl,
          formattedSlPrice: formattedCrashSl,
          reason: `[PHASE B CRASH FREEZE] Opposing spike (${expectedMovePct >= 0 ? '+' : ''}${expectedMovePct.toFixed(2)}%) at +${currentProfitPips.toFixed(1)}p profit: Locked tight SL at ${formattedCrashSl} (Price ${isBuy ? '-' : '+'} $${crashTightLockDist.toFixed(profile.digits)}) to capture profit immediately!`,
          statusUpdate: 'CRASH_FREEZE_LOCK',
        };
      }
    }

    // 2. Strict One-Way MT5 Ratchet (peakPrice - $2.00 for BUY, peakPrice + $2.00 for SELL):
    // Permanently disables backward relaxation; ONLY moves forward in profit and freezes 100% if price drops.
    if (peakProfitPips >= 25) {
      const ratchetCandidateRaw = isBuy
        ? (updatedHighest - ratchetDist)
        : (updatedLowest + ratchetDist);
      const formattedRatchetSl = formatPrice(ratchetCandidateRaw, profile.digits);
      const numericRatchetSl = Number(formattedRatchetSl);

      if (isBuy) {
        const slImprovement = numericRatchetSl - (position.currentSl || 0);
        if (
          numericRatchetSl < currentPrice - profile.pipValue &&
          numericRatchetSl > (position.currentSl || 0) &&
          slImprovement >= minStep
        ) {
          return {
            type: 'MODIFY_SL',
            positionId: position.id,
            symbol: position.symbol,
            newSlPrice: numericRatchetSl,
            formattedSlPrice: formattedRatchetSl,
            reason: `[PHASE B STRICT RATCHET] Peak ${formatPrice(updatedHighest, profile.digits)} (+${peakProfitPips.toFixed(1)}p >= 25p): One-way MT5 ratchet SL advanced to ${formattedRatchetSl} (Peak - $${ratchetDist.toFixed(profile.digits)}, 100% frozen against drops)`,
            statusUpdate: 'PHASE_B_RATCHET',
          };
        }
      } else {
        const currentSlVal = position.currentSl === 0 ? Infinity : position.currentSl;
        const slImprovement = currentSlVal - numericRatchetSl;
        if (
          numericRatchetSl > currentPrice + profile.pipValue &&
          numericRatchetSl < currentSlVal &&
          slImprovement >= minStep
        ) {
          return {
            type: 'MODIFY_SL',
            positionId: position.id,
            symbol: position.symbol,
            newSlPrice: numericRatchetSl,
            formattedSlPrice: formattedRatchetSl,
            reason: `[PHASE B STRICT RATCHET] Trough ${formatPrice(updatedLowest, profile.digits)} (+${peakProfitPips.toFixed(1)}p >= 25p): One-way MT5 ratchet SL advanced to ${formattedRatchetSl} (Trough + $${ratchetDist.toFixed(profile.digits)}, 100% frozen against spikes)`,
            statusUpdate: 'PHASE_B_RATCHET',
          };
        }
      }
    }

    return {
      type: 'NONE',
      positionId: position.id,
      symbol: position.symbol,
      reason: isDrasticDropFreeze
        ? `[PHASE B CRASH FREEZE] Opposing move (${expectedMovePct.toFixed(2)}%) > 0.12%: Trailing SL frozen at ${formatPrice(position.currentSl, profile.digits)}.`
        : `[PHASE B STRICT RATCHET] One-way ratchet active and frozen at ${formatPrice(position.currentSl, profile.digits)}.`,
      statusUpdate: position.trailingStatus,
    };
  }

  // =========================================================================
  // STYLE 2 HYBRID TRAILING STOP — PHASE A:
  // EARLY TRADE ELASTIC CUSHION (When Peak Profit is between +10 pips and < +25 pips)
  // - Initial Trailing SL moves to entryPrice (e.g. BUY at 4058.00 reaching 4060.00 [+20p] -> SL 4058.00)
  // - If scan predicts only a minor/moderate pullback (|expectedMovePct| <= 0.08% / <= $3.00 toward POC/VAL, NOT a crash),
  //   allow Trailing SL to step back slightly beneath projected pullback target (down to strict floor of entryPrice - $3.00, e.g. 4055.00).
  // - Once it touches that 4055.00 floor, it is 100% locked and can never move lower.
  // =========================================================================
  if (peakProfitPips >= 10 && peakProfitPips < 25) {
    const strictFloorPrice = isBuy
      ? Number(formatPrice(position.entryPrice - elasticMaxFloorDist, profile.digits))
      : Number(formatPrice(position.entryPrice + elasticMaxFloorDist, profile.digits));

    // Check if currentSl already touched the strict floor
    if (
      position.currentSl > 0 &&
      (isBuy ? position.currentSl <= strictFloorPrice + 1e-6 : position.currentSl >= strictFloorPrice - 1e-6)
    ) {
      position.elasticFloorLocked = true;
    }

    // Initial Phase A forward SL: entryPrice (from +10p to +20p) or peakPrice - $2.00 (from +20p to < +25p)
    const forwardSlRaw = isBuy
      ? Math.max(position.entryPrice, updatedHighest - ratchetDist)
      : Math.min(position.entryPrice, updatedLowest + ratchetDist);
    const numericForwardSl = Number(formatPrice(forwardSlRaw, profile.digits));

    // Check if latest scan predicts a minor/moderate pullback toward POC/VAL (and NOT a drastic crash)
    const isMinorModeratePullback =
      isMoveAgainstPosition &&
      !isDrasticDropFreeze &&
      opposingMovePct > 0 &&
      opposingMovePct <= 0.08 &&
      opposingMoveDist <= elasticMaxFloorDist;

    const pullbackThreatensSl = isBuy
      ? expectedTargetPrice <= numericForwardSl
      : expectedTargetPrice >= numericForwardSl;

    if (isMinorModeratePullback && pullbackThreatensSl && !position.elasticFloorLocked) {
      // Allow Trailing SL to step back slightly ($0.50 / 5 pips) beneath projected pullback target, down to strict floor (entryPrice - $3.00)
      const rawCushionSl = isBuy
        ? Math.max(strictFloorPrice, expectedTargetPrice - crashTightLockDist)
        : Math.min(strictFloorPrice, expectedTargetPrice + crashTightLockDist);
      const formattedCushionSl = formatPrice(rawCushionSl, profile.digits);
      const numericCushionSl = Number(formattedCushionSl);

      // Lock 100% once it touches the strict floor (e.g. 4055.00)
      if (isBuy ? numericCushionSl <= strictFloorPrice + 1e-6 : numericCushionSl >= strictFloorPrice - 1e-6) {
        position.elasticFloorLocked = true;
      }

      const validCushionDir = isBuy
        ? numericCushionSl < currentPrice - profile.pipValue
        : numericCushionSl > currentPrice + profile.pipValue;

      if (validCushionDir && Math.abs(numericCushionSl - (position.currentSl || 0)) >= minStep) {
        return {
          type: 'MODIFY_SL',
          positionId: position.id,
          symbol: position.symbol,
          newSlPrice: numericCushionSl,
          formattedSlPrice: formattedCushionSl,
          reason: `[PHASE A ELASTIC CUSHION] Minor pullback predicted (${expectedMovePct.toFixed(2)}% -> ${formatPrice(expectedTargetPrice, profile.digits)}): Relaxed SL to ${formattedCushionSl} (Floor ${formatPrice(strictFloorPrice, profile.digits)}${position.elasticFloorLocked ? ' LOCKED 100%' : ''}) to absorb wick retest`,
          statusUpdate: 'PHASE_A_ELASTIC',
        };
      }
    } else {
      // Advance SL forward to entryPrice (4058.00 at +20p) or peak - $2.00
      const validForwardDir = isBuy
        ? numericForwardSl < currentPrice - profile.pipValue
        : numericForwardSl > currentPrice + profile.pipValue;
      const canAdvanceForward = validForwardDir && (isBuy
        ? (position.currentSl === 0 || (numericForwardSl > position.currentSl && numericForwardSl - position.currentSl >= minStep))
        : (position.currentSl === 0 || (numericForwardSl < position.currentSl && position.currentSl - numericForwardSl >= minStep)));

      if (canAdvanceForward) {
        const formattedForwardSl = formatPrice(numericForwardSl, profile.digits);
        return {
          type: 'MODIFY_SL',
          positionId: position.id,
          symbol: position.symbol,
          newSlPrice: numericForwardSl,
          formattedSlPrice: formattedForwardSl,
          reason: `[PHASE A INITIAL TRAIL] Peak ${formatPrice(updatedHighest, profile.digits)} (+${peakProfitPips.toFixed(1)}p): Moved Trailing SL to ${formattedForwardSl}`,
          statusUpdate: 'PHASE_A_ELASTIC',
        };
      }
    }
  }

  return {
    type: 'NONE',
    positionId: position.id,
    symbol: position.symbol,
    reason: 'Position within normal bounds. No trailing modification needed.',
    statusUpdate: position.trailingStatus,
  };
}

/**
 * Validates whether an open position qualifies for a Middle BB partial close.
 * Enforces that price is in net positive profit (>= +3.5 pips or >= +0.6R) and
 * never triggers if Middle BB is behind/worse than entryPrice.
 */
export function canTriggerMidBbPartialClose(
  position: ManagedPosition,
  quote: { bid: number; ask: number },
  middleBB: number,
  atr14: number = 0
): boolean {
  const profile = getPairProfile(position.symbol);
  const minProfitDistance = 3.5 * profile.pipValue;
  const isBuy = position.side === 'BUY';
  const riskDistance = position.currentSl > 0
    ? Math.abs(position.entryPrice - position.currentSl)
    : Math.max(1.5 * atr14, minProfitDistance / 0.6);

  if (isBuy) {
    const hasProfit = quote.bid > position.entryPrice + minProfitDistance;
    const midBbValid = middleBB > position.entryPrice + minProfitDistance && quote.bid >= middleBB;
    const rValid = riskDistance > 0 && quote.bid >= position.entryPrice + 0.6 * riskDistance;
    return hasProfit && (midBbValid || rValid);
  } else {
    const hasProfit = quote.ask < position.entryPrice - minProfitDistance;
    const midBbValid = middleBB < position.entryPrice - minProfitDistance && quote.ask <= middleBB;
    const rValid = riskDistance > 0 && quote.ask <= position.entryPrice - 0.6 * riskDistance;
    return hasProfit && (midBbValid || rValid);
  }
}

/**
 * Evaluates 2-Stage Trailing Stop specifically for Crypto Perpetuals (Binance / Bitget)
 * Stage 1: 50% partial close at Middle BB / +0.6R, lock stop loss to Breakeven (+ buffer).
 * Stage 2: Adaptive ATR Trailing Stop beyond Middle BB.
 */
export function evaluateCryptoPositionTrailing(params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  partialClosed?: boolean;
  currentSl?: number;
  middleBB?: number;
  atr14?: number;
  exchange?: 'BINANCE' | 'BITGET';
}): {
  action: 'NONE' | 'PARTIAL_CLOSE' | 'MODIFY_SL' | 'HARD_SL_CLOSE';
  closeQuantity?: number;
  newSlPrice?: number;
  reason?: string;
} {
  const isLong = params.side === 'BUY';
  const priceMove = isLong ? params.currentPrice - params.entryPrice : params.entryPrice - params.currentPrice;
  const pricePct = priceMove / params.entryPrice;

  // Hard SL circuit breaker: loss > 3% on high leverage
  if (pricePct <= -0.03) {
    return {
      action: 'HARD_SL_CLOSE',
      closeQuantity: params.quantity,
      reason: `[CRYPTO HARD SL] Loss reached ${(pricePct * 100).toFixed(2)}% on ${params.symbol}. Liquidating position immediately.`,
    };
  }

  // Stage 1: 50% Partial Close at +0.6R (or >= +0.3% move)
  const minStage1Pct = 0.003;
  if (!params.partialClosed && pricePct >= minStage1Pct) {
    const halfQty = params.quantity * 0.5;
    const bePrice = isLong ? params.entryPrice * 1.0008 : params.entryPrice * 0.9992;
    return {
      action: 'PARTIAL_CLOSE',
      closeQuantity: halfQty,
      newSlPrice: Number(bePrice.toFixed(params.symbol.includes('BTC') ? 2 : 4)),
      reason: `[STAGE-1 PARTIAL CLOSE] ${params.symbol} reached +${(pricePct * 100).toFixed(2)}%: 50% Closed (${halfQty}) & SL locked at Breakeven.`,
    };
  }

  // Stage 2: Adaptive ATR Trailing Stop
  if (params.partialClosed && pricePct > minStage1Pct && params.atr14) {
    const trailDist = 1.2 * params.atr14;
    const candidateSl = isLong ? params.currentPrice - trailDist : params.currentPrice + trailDist;
    const isAdvancing = isLong
      ? (!params.currentSl || candidateSl > params.currentSl)
      : (!params.currentSl || candidateSl < params.currentSl);

    if (isAdvancing) {
      return {
        action: 'MODIFY_SL',
        newSlPrice: Number(candidateSl.toFixed(params.symbol.includes('BTC') ? 2 : 4)),
        reason: `[STAGE-2 ATR TRAILING] Advanced trailing SL to ${candidateSl.toFixed(4)} on ${params.symbol}.`,
      };
    }
  }

  return { action: 'NONE' };
}
