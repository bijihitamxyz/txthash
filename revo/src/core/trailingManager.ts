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

export type PositionTrailingStatus = 'INITIAL' | 'PARTIAL_CLOSED_BE' | 'BREAKEVEN_LOCKED' | 'ATR_TRAILING';

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
  highestPrice: number;
  lowestPrice: number;
  openTime: number;
  partialClosed: boolean;
  trailingStatus: PositionTrailingStatus;
  lastSlUpdateTime?: number;
  unrealizedPnl?: number;
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
  } = input;

  const profile = pairProfile;
  const isBuy = position.side === 'BUY';
  const currentPrice = isBuy ? currentBid : currentAsk;

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
  // HARD SL CIRCUIT BREAKER: Auto-close if position unrealizedPnl <= -(lots * 100)
  // (-$1.00 risk threshold for 0.01 lot)
  // =========================================================================
  const hardSlLimitUsd = -(position.volume * 100);
  if (unrealizedPnl <= hardSlLimitUsd) {
    return {
      type: 'HARD_SL_CLOSE',
      positionId: position.id,
      symbol: position.symbol,
      reason: `[HARD SL CIRCUIT BREAKER] Position PnL ($${unrealizedPnl.toFixed(2)}) breached -$${Math.abs(hardSlLimitUsd).toFixed(2)} limit for ${position.volume} lot. Auto-closing position immediately.`,
      statusUpdate: position.trailingStatus,
    };
  }

  // =========================================================================
  // PHASE 1 — BREAKEVEN (+0.15 PRICE UNITS) & AUTO 50% PARTIAL CLOSE AT MID BB
  // - Breakeven (+0.15 price units on Gold) triggers as soon as profit reaches +$0.60
  // - Auto 50% Partial Close executes ONLY when all required profit & Mid BB conditions are met
  // =========================================================================
  const beOffset = profile.symbol === 'XAUUSDm' ? 0.15 : 1.5 * profile.pipValue;
  const beSlPrice = isBuy ? (position.entryPrice + beOffset) : (position.entryPrice - beOffset);
  const formattedBeSl = formatPrice(beSlPrice, profile.digits);
  const numericBeSl = Number(formattedBeSl);

  const beProfitThresholdUsd = (position.volume / 0.01) * 0.60;
  const beDistThreshold = profile.symbol === 'XAUUSDm' ? 0.60 : 6 * profile.pipValue;
  const reachedProfitBe = unrealizedPnl >= beProfitThresholdUsd || currentProfitDistance >= beDistThreshold;

  // Strict Partial Close Conditions:
  // 1. Min profit distance: at least +3.5 pips (0.35 on Gold, 3.5 * pipValue on Forex)
  const minProfitPips = 3.5;
  const minProfitDistance = minProfitPips * profile.pipValue;

  // Initial Stop Loss distance (R distance):
  // If currentSl is set, riskDistance = |entryPrice - currentSl|
  // Fallback to 1.5 * atr14 if currentSl is 0
  const riskDistance = position.currentSl > 0
    ? Math.abs(position.entryPrice - position.currentSl)
    : Math.max(1.5 * atr14, minProfitDistance / 0.6);

  // Condition 1: Position is in net positive profit of at least +3.5 pips (or >= +0.6R)
  const hasNetPositiveProfit = isBuy
    ? (currentBid > position.entryPrice + minProfitDistance || (riskDistance > 0 && currentBid >= position.entryPrice + 0.6 * riskDistance))
    : (currentAsk < position.entryPrice - minProfitDistance || (riskDistance > 0 && currentAsk <= position.entryPrice - 0.6 * riskDistance));

  // Condition 2 for BUY:
  // currentBid > pos.entryPrice + minProfitDistance AND
  // ((middleBB > pos.entryPrice + minProfitDistance && currentBid >= middleBB) OR currentBid >= pos.entryPrice + 0.6 * riskDistance)
  // NEVER trigger MID BB PARTIAL CLOSE if middleBB is behind/worse than entryPrice!
  const buyPartialCloseQualified = isBuy &&
    (currentBid > position.entryPrice + minProfitDistance) &&
    (
      (middleBB > position.entryPrice + minProfitDistance && currentBid >= middleBB) ||
      (riskDistance > 0 && currentBid >= position.entryPrice + 0.6 * riskDistance)
    );

  // Condition 3 for SELL:
  // currentAsk < pos.entryPrice - minProfitDistance AND
  // ((middleBB < pos.entryPrice - minProfitDistance && currentAsk <= middleBB) OR currentAsk <= pos.entryPrice - 0.6 * riskDistance)
  // NEVER trigger MID BB PARTIAL CLOSE if middleBB is behind/worse than entryPrice!
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

  const isSlImprovementToBe = isBuy
    ? (position.currentSl === 0 || numericBeSl > position.currentSl)
    : (position.currentSl === 0 || numericBeSl < position.currentSl);

  // Auto 50% Partial Close execution
  if (shouldTriggerPartialClose) {
    const partialCloseVol = roundLotVolume(position.volume * 0.5, profile.minLot, profile.lotStep);
    const remainingVol = Number((position.volume - partialCloseVol).toFixed(2));
    const isMidBbTriggered = isBuy
      ? (middleBB > position.entryPrice + minProfitDistance && currentBid >= middleBB)
      : (middleBB < position.entryPrice - minProfitDistance && currentAsk <= middleBB);

    const triggerLabel = isMidBbTriggered
      ? `Middle BB (${formatPrice(middleBB, profile.digits)} > Entry ${formatPrice(position.entryPrice, profile.digits)})`
      : `+0.6R Target (${formatPrice(isBuy ? position.entryPrice + 0.6 * riskDistance : position.entryPrice - 0.6 * riskDistance, profile.digits)})`;

    return {
      type: isSlImprovementToBe ? 'PARTIAL_AND_MODIFY_SL' : 'PARTIAL_CLOSE',
      positionId: position.id,
      symbol: position.symbol,
      closeVolume: partialCloseVol,
      remainingVolume: remainingVol,
      newSlPrice: numericBeSl,
      formattedSlPrice: formattedBeSl,
      reason: `[MID BB PARTIAL CLOSE] Reached ${triggerLabel}: 50% Banked (${partialCloseVol} lots) + BE Locked at ${formattedBeSl}`,
      statusUpdate: 'PARTIAL_CLOSED_BE',
    };
  }

  // Breakeven (+0.15 price units) triggers as soon as profit reaches +$0.60
  if (reachedProfitBe && isSlImprovementToBe && position.trailingStatus === 'INITIAL') {
    return {
      type: 'MODIFY_SL',
      positionId: position.id,
      symbol: position.symbol,
      newSlPrice: numericBeSl,
      formattedSlPrice: formattedBeSl,
      reason: `[AUTO-BREAKEVEN] Profit reached +$0.60 ($${unrealizedPnl.toFixed(2)}): SL locked at Breakeven (+0.15 price units) at ${formattedBeSl}`,
      statusUpdate: 'BREAKEVEN_LOCKED',
    };
  }

  // =========================================================================
  // PHASE 2 — TIGHT ATR TRAILING (0.40 TO 0.75 PRICE UNITS ON GOLD)
  // Locks in profits rapidly once Breakeven is locked, past Mid BB, or profit >= +$0.60
  // =========================================================================
  const reachedValidMiddleBb = isBuy
    ? (middleBB > position.entryPrice + minProfitDistance && currentBid >= middleBB)
    : (middleBB < position.entryPrice - minProfitDistance && currentAsk <= middleBB);

  const canTrail = reachedValidMiddleBb || reachedProfitBe || position.trailingStatus === 'BREAKEVEN_LOCKED' || position.trailingStatus === 'PARTIAL_CLOSED_BE' || position.trailingStatus === 'ATR_TRAILING';

  if (canTrail) {
    let trailDist = 0.55;
    let regimeLabel = 'Tight ATR Trail (0.55)';

    if (profile.symbol === 'XAUUSDm') {
      const isExtremeClimax = isBuy ? (currentRsi >= 78) : (currentRsi <= 22);
      if (isExtremeClimax) {
        trailDist = 0.40; // Climax: ultra-tight 0.40 price units
        regimeLabel = `Extreme Climax Trail (0.40 distance, RSI ${currentRsi.toFixed(1)})`;
      } else if (bbwExpansionPct >= 20) {
        trailDist = 0.75; // Breakout: maximum 0.75 price units
        regimeLabel = `Momentum Breakout Trail (0.75 distance, BBW ${bbwExpansionPct.toFixed(1)}%)`;
      } else {
        // Normal tight trail clamped strictly between 0.40 and 0.75 price units on Gold
        trailDist = Math.min(0.75, Math.max(0.40, 0.35 * atr14));
        regimeLabel = `Tight ATR Trail (${formatPrice(trailDist, profile.digits)} distance)`;
      }
    } else {
      // Forex pairs: 4.0 to 7.5 pips
      const isExtremeClimax = isBuy ? (currentRsi >= 78) : (currentRsi <= 22);
      const trailPips = isExtremeClimax ? 4.0 : (bbwExpansionPct >= 20 ? 7.5 : 5.5);
      trailDist = trailPips * profile.pipValue;
      regimeLabel = `Tight ATR Trail (${trailPips.toFixed(1)} pips)`;
    }

    const minStep = profile.symbol === 'XAUUSDm' ? 0.10 : profile.pipValue; // Minimum 1 pip step to advance SL

    const candidateSl = isBuy ? (updatedHighest - trailDist) : (updatedLowest + trailDist);
    const formattedCandidateSl = formatPrice(candidateSl, profile.digits);
    const numericCandidateSl = Number(formattedCandidateSl);

    if (isBuy) {
      const slImprovement = numericCandidateSl - (position.currentSl || 0);
      // New SL must be at or above breakeven price and advance by at least minStep
      if (numericCandidateSl >= numericBeSl && slImprovement >= minStep) {
        return {
          type: 'MODIFY_SL',
          positionId: position.id,
          symbol: position.symbol,
          newSlPrice: numericCandidateSl,
          formattedSlPrice: formattedCandidateSl,
          reason: `[TIGHT ATR TRAIL] ${regimeLabel} | Peak ${formatPrice(updatedHighest, profile.digits)}: Trailing SL up to ${formattedCandidateSl} (+${priceDiffToPips(slImprovement, profile.pipValue)} pips advance)`,
          statusUpdate: 'ATR_TRAILING',
        };
      }
    } else {
      const currentSlVal = position.currentSl === 0 ? Infinity : position.currentSl;
      const slImprovement = currentSlVal - numericCandidateSl;
      // New SL must be at or below breakeven price and lower by at least minStep
      if (numericCandidateSl <= numericBeSl && slImprovement >= minStep) {
        return {
          type: 'MODIFY_SL',
          positionId: position.id,
          symbol: position.symbol,
          newSlPrice: numericCandidateSl,
          formattedSlPrice: formattedCandidateSl,
          reason: `[TIGHT ATR TRAIL] ${regimeLabel} | Trough ${formatPrice(updatedLowest, profile.digits)}: Trailing SL down to ${formattedCandidateSl} (+${priceDiffToPips(slImprovement, profile.pipValue)} pips advance)`,
          statusUpdate: 'ATR_TRAILING',
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
