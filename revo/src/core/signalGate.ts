/**
 * Multi-Regime Institutional Hybrid Strategy Engine (src/core/signalGate.ts)
 * Eliminates the mutually exclusive single-rule paradox by evaluating every scan tick
 * across THREE distinct institutional setups (Setup A, Setup B, Setup C).
 *
 * If ANY of the 3 setups scores >= 65 points:
 * Immediately qualifies the signal, packages the technical snapshot, and passes to Gate 3 (AI Judge).
 *
 * SETUPS:
 * 1. SETUP A — Trend Continuation Pullback (EMA 200 + Middle BB Bounce)
 * 2. SETUP B — Bollinger Band Extreme Snap-Back (Relaxed & Realistic Mean Reversion)
 * 3. SETUP C — Momentum Breakout Impulse (Expanding BBW + Strong Candle Body + RSI Break)
 *
 * DIAGNOSTICS:
 * Provides live real-time quantitative telemetry on every scan tick:
 * e.g., `[XAUUSDm] SCAN: Price 4134.91 | Regime: BEARISH (<EMA200) | RSI: 49.8 | BB Pos: 42% | Confluence Score: 58/65 (Waiting for ...)`
 */

import { Candle, IndicatorSnapshot, computeIndicatorSnapshot, DivergenceResult, calculateKaufmanEfficiencyRatio } from './indicatorEngine';
import { PairProfile, StrategyPreset, priceDiffToPips, formatPrice } from './pairConfig';

export type HybridSignalType = 'WITH_TREND_BUY' | 'WITH_TREND_SELL' | 'COUNTER_TREND_BUY' | 'COUNTER_TREND_SELL' | 'NONE';

export type StrategySetupType =
  | 'SETUP_A_TREND_PULLBACK'
  | 'SETUP_B_BB_EXTREME_SNAPBACK'
  | 'SETUP_C_MOMENTUM_BREAKOUT'
  | 'NONE';

export interface SignalGateParams {
  pairProfile: PairProfile;
  overridePreset?: Partial<StrategyPreset>;
  timeframe?: string;
}

export interface TechnicalSnapshotPayload {
  symbol: string;
  timestamp: number;
  timeframe: string;
  side: 'BUY' | 'SELL';
  signalType: HybridSignalType;
  setupName: StrategySetupType;
  confluence_score: number;
  regime: 'WITH_TREND' | 'COUNTER_TREND';
  triggerPrice: number;
  rsi: number;
  wick_ratio: number;
  bbw_expansion_pct: number;
  bb_position_pct: number;
  divergence_detected: boolean;
  divergence_type: string;
  ema200Distance: number;
  atr_pips: number;
  // Multi-Timeframe Volatility & S/R Enriched Context
  atr_ratio: number;
  volatility_regime: 'OPTIMAL' | 'ELEVATED' | 'COMPRESSED';
  support_price: number;
  resistance_price: number;
  distance_to_support_pips: number;
  distance_to_resistance_pips: number;
  wick_rejection_strength: 'HIGH_CONVICTION' | 'MODERATE' | 'WEAK';
  rsi_slope: number;
  c0: {
    open: number;
    high: number;
    low: number;
    close: number;
    rsi: number;
    upperBB: number;
    middleBB: number;
    lowerBB: number;
    ema200: number;
    lowerWickRatio: number;
    upperWickRatio: number;
  };
  c1: {
    open: number;
    high: number;
    low: number;
    close: number;
    rsi: number;
    upperBB: number;
    lowerBB: number;
  };
  proposedSlPrice: number;
  proposedTpPrice: number;
  proposedSlPips: number;
  proposedTpPips: number;
  riskRewardRatio: number;
  marketType?: 'FOREX' | 'CRYPTO';
  efficiencyRatio?: number;
  pocMagnetAligned?: boolean;
  zScore?: number;
  btcGuardStatus?: string;
}

export interface SignalGateResult {
  isValid: boolean;
  side: 'BUY' | 'SELL' | 'NONE';
  symbol: string;
  signalType: HybridSignalType;
  setupName?: StrategySetupType;
  confluenceScore?: number;
  regime?: 'WITH_TREND' | 'COUNTER_TREND';
  gate1Passed: boolean;
  gate2Passed: boolean;
  stormProtectionPassed: boolean;
  regimeFilterPassed: boolean;
  divergenceDetected: boolean;
  divergenceDetails?: DivergenceResult;
  signalTriggerPrice: number;
  proposedSlPrice: number;
  proposedTpPrice: number;
  slPips: number;
  tpPips: number;
  riskRewardRatio: number;
  reasons: string[];
  rejectionReason?: string;
  diagnosticTelemetry?: string;
  technicalSnapshot?: TechnicalSnapshotPayload;
  indicators: IndicatorSnapshot;
}

interface EvaluatedSetup {
  name: StrategySetupType;
  side: 'BUY' | 'SELL';
  score: number;
  reasons: string[];
  waiting: string;
  regime: 'WITH_TREND' | 'COUNTER_TREND';
  signalType: HybridSignalType;
}

/**
 * SETUP A — Trend Continuation Pullback (EMA 200 + Middle BB Bounce)
 * BUY: Price > EMA200 (or EMA200 slope is rising), price pulls back near/below Middle BB within last 3 candles,
 *      RSI(14) between 35 and 58 curling up, C0 or C1 is bullish.
 * SELL: Price < EMA200 (or EMA200 slope is falling), price rallies near/above Middle BB within last 3 candles,
 *       RSI(14) between 42 and 65 curling down, C0 or C1 is bearish.
 */
function evaluateSetupA(indicators: IndicatorSnapshot, pairProfile: PairProfile): { buy: EvaluatedSetup; sell: EvaluatedSetup } {
  const { c0, c1, c2, ema200Slope, divergence } = indicators;
  const digits = pairProfile.digits;

  // --- BUY EVALUATION ---
  let buyScore = 0;
  const buyReasons: string[] = [];
  let buyWaiting = 'Waiting for bullish/bearish trigger candle';

  const isPriceAboveEma = c0.candle.close > c0.ema200;
  const isEmaRising = ema200Slope >= 0 || c0.ema200 >= c1.ema200;
  const trendBuyAligned = isPriceAboveEma || isEmaRising;

  if (isPriceAboveEma && isEmaRising) {
    buyScore += 30;
    buyReasons.push(`Trend Alignment: Price (${formatPrice(c0.candle.close, digits)}) > EMA200 (${formatPrice(c0.ema200, digits)}) & EMA200 rising (+30pts)`);
  } else if (isPriceAboveEma) {
    buyScore += 22;
    buyReasons.push(`Trend Alignment: Price > EMA200 (+22pts)`);
  } else if (isEmaRising) {
    buyScore += 18;
    buyReasons.push(`Trend Alignment: EMA200 slope rising (+18pts)`);
  }

  // Middle BB Pullback within last 3 candles
  const minLow3 = Math.min(c0.candle.low, c1.candle.low, c2.candle.low);
  const minClose3 = Math.min(c0.candle.close, c1.candle.close, c2.candle.close);
  const isBelowMidBB = minLow3 <= c0.middleBB;
  const isNearMidBB = minLow3 <= c0.middleBB * 1.002 || minClose3 <= c0.middleBB * 1.0025;

  if (isBelowMidBB) {
    buyScore += 25;
    buyReasons.push(`Middle BB Pullback: Candle low (${formatPrice(minLow3, digits)}) pierced/bounced below Middle BB (${formatPrice(c0.middleBB, digits)}) (+25pts)`);
  } else if (isNearMidBB) {
    buyScore += 20;
    buyReasons.push(`Middle BB Pullback: Candle low (${formatPrice(minLow3, digits)}) pulled back within 0.2% of Middle BB (+20pts)`);
  }

  // RSI(14) 35 - 58 and curling up
  const rsiInRangeBuy = c0.rsi >= 35 && c0.rsi <= 58;
  const rsiCurlingUp = c0.rsi > c1.rsi;

  if (rsiInRangeBuy && rsiCurlingUp) {
    buyScore += 25;
    buyReasons.push(`RSI Pullback & Curl: RSI ${c0.rsi.toFixed(1)} in [35, 58] and curling up (+${(c0.rsi - c1.rsi).toFixed(1)}) (+25pts)`);
  } else if (rsiInRangeBuy) {
    buyScore += 15;
    buyReasons.push(`RSI Pullback: RSI ${c0.rsi.toFixed(1)} in [35, 58] (+15pts)`);
  } else if (rsiCurlingUp && c0.rsi >= 30 && c0.rsi <= 62) {
    buyScore += 12;
    buyReasons.push(`RSI Curling Up: RSI ${c0.rsi.toFixed(1)} curling up (+12pts)`);
  }

  // Trigger Candle: C0 or C1 bullish
  const isC0Bullish = c0.candle.close > c0.candle.open;
  const isC1Bullish = c1.candle.close > c1.candle.open;

  if (isC0Bullish) {
    buyScore += 15;
    buyReasons.push(`Trigger Candle: Current C0 is bullish close > open (+15pts)`);
    if (c0.lowerWickRatio >= 0.25) {
      buyScore += 5;
      buyReasons.push(`Wick Confluence: C0 lower absorption wick ${c0.lowerWickRatio.toFixed(2)} (+5pts)`);
    }
  } else if (isC1Bullish) {
    buyScore += 10;
    buyReasons.push(`Trigger Candle: Prior C1 is bullish (+10pts)`);
  }

  // Bonus: Hidden or Regular Bullish Divergence
  if (divergence.detected && divergence.bullishDivergence) {
    buyScore += 10;
    buyReasons.push(`Divergence Confluence: Bullish divergence active (+10pts)`);
  }

  // Waiting condition diagnosis for BUY
  if (!trendBuyAligned) {
    buyWaiting = 'Waiting for Price > EMA200 or rising slope';
  } else if (!isNearMidBB) {
    buyWaiting = 'Waiting for Middle BB pullback';
  } else if (!rsiCurlingUp) {
    buyWaiting = 'Waiting for RSI upward curl';
  } else if (!isC0Bullish && !isC1Bullish) {
    buyWaiting = 'Waiting for bullish trigger candle';
  } else if (!rsiInRangeBuy) {
    buyWaiting = `Waiting for RSI in [35, 58] range (current ${c0.rsi.toFixed(1)})`;
  }

  // --- SELL EVALUATION ---
  let sellScore = 0;
  const sellReasons: string[] = [];
  let sellWaiting = 'Waiting for bullish/bearish trigger candle';

  const isPriceBelowEma = c0.candle.close < c0.ema200;
  const isEmaFalling = ema200Slope <= 0 || c0.ema200 <= c1.ema200;
  const trendSellAligned = isPriceBelowEma || isEmaFalling;

  if (isPriceBelowEma && isEmaFalling) {
    sellScore += 30;
    sellReasons.push(`Trend Alignment: Price (${formatPrice(c0.candle.close, digits)}) < EMA200 (${formatPrice(c0.ema200, digits)}) & EMA200 falling (+30pts)`);
  } else if (isPriceBelowEma) {
    sellScore += 22;
    sellReasons.push(`Trend Alignment: Price < EMA200 (+22pts)`);
  } else if (isEmaFalling) {
    sellScore += 18;
    sellReasons.push(`Trend Alignment: EMA200 slope falling (+18pts)`);
  }

  // Middle BB Rally within last 3 candles
  const maxHigh3 = Math.max(c0.candle.high, c1.candle.high, c2.candle.high);
  const maxClose3 = Math.max(c0.candle.close, c1.candle.close, c2.candle.close);
  const isAboveMidBB = maxHigh3 >= c0.middleBB;
  const isNearMidBBRally = maxHigh3 >= c0.middleBB * 0.998 || maxClose3 >= c0.middleBB * 0.9975;

  if (isAboveMidBB) {
    sellScore += 25;
    sellReasons.push(`Middle BB Rally: Candle high (${formatPrice(maxHigh3, digits)}) pierced/tested above Middle BB (${formatPrice(c0.middleBB, digits)}) (+25pts)`);
  } else if (isNearMidBBRally) {
    sellScore += 20;
    sellReasons.push(`Middle BB Rally: Candle high (${formatPrice(maxHigh3, digits)}) rallied within 0.2% of Middle BB (+20pts)`);
  }

  // RSI(14) 42 - 65 and curling down
  const rsiInRangeSell = c0.rsi >= 42 && c0.rsi <= 65;
  const rsiCurlingDown = c0.rsi < c1.rsi;

  if (rsiInRangeSell && rsiCurlingDown) {
    sellScore += 25;
    sellReasons.push(`RSI Rally & Curl: RSI ${c0.rsi.toFixed(1)} in [42, 65] and curling down (-${(c1.rsi - c0.rsi).toFixed(1)}) (+25pts)`);
  } else if (rsiInRangeSell) {
    sellScore += 15;
    sellReasons.push(`RSI Rally: RSI ${c0.rsi.toFixed(1)} in [42, 65] (+15pts)`);
  } else if (rsiCurlingDown && c0.rsi >= 38 && c0.rsi <= 70) {
    sellScore += 12;
    sellReasons.push(`RSI Curling Down: RSI ${c0.rsi.toFixed(1)} curling down (+12pts)`);
  }

  // Trigger Candle: C0 or C1 bearish
  const isC0Bearish = c0.candle.close < c0.candle.open;
  const isC1Bearish = c1.candle.close < c1.candle.open;

  if (isC0Bearish) {
    sellScore += 15;
    sellReasons.push(`Trigger Candle: Current C0 is bearish close < open (+15pts)`);
    if (c0.upperWickRatio >= 0.25) {
      sellScore += 5;
      sellReasons.push(`Wick Confluence: C0 upper rejection wick ${c0.upperWickRatio.toFixed(2)} (+5pts)`);
    }
  } else if (isC1Bearish) {
    sellScore += 10;
    sellReasons.push(`Trigger Candle: Prior C1 is bearish (+10pts)`);
  }

  // Bonus: Hidden or Regular Bearish Divergence
  if (divergence.detected && divergence.bearishDivergence) {
    sellScore += 10;
    sellReasons.push(`Divergence Confluence: Bearish divergence active (+10pts)`);
  }

  // Waiting condition diagnosis for SELL
  if (!trendSellAligned) {
    sellWaiting = 'Waiting for Price < EMA200 or falling slope';
  } else if (!isNearMidBBRally) {
    sellWaiting = 'Waiting for Middle BB rally';
  } else if (!rsiCurlingDown) {
    sellWaiting = 'Waiting for RSI downward curl';
  } else if (!isC0Bearish && !isC1Bearish) {
    sellWaiting = 'Waiting for bearish trigger candle';
  } else if (!rsiInRangeSell) {
    sellWaiting = `Waiting for RSI in [42, 65] range (current ${c0.rsi.toFixed(1)})`;
  }

  return {
    buy: {
      name: 'SETUP_A_TREND_PULLBACK',
      side: 'BUY',
      score: Math.min(100, buyScore),
      reasons: buyReasons,
      waiting: buyWaiting,
      regime: 'WITH_TREND',
      signalType: 'WITH_TREND_BUY',
    },
    sell: {
      name: 'SETUP_A_TREND_PULLBACK',
      side: 'SELL',
      score: Math.min(100, sellScore),
      reasons: sellReasons,
      waiting: sellWaiting,
      regime: 'WITH_TREND',
      signalType: 'WITH_TREND_SELL',
    },
  };
}

/**
 * SETUP B — Bollinger Band Extreme Snap-Back (Relaxed & Realistic Mean Reversion)
 * BUY: Any of the last 3 candles (C0, C1, C2) had low <= lowerBB * 1.0003
 *      AND (RSI <= 45 OR Bullish Divergence OR Lower Wick >= 25%)
 *      AND Current price is bouncing (C0.close > C0.open OR C0.close > C1.low).
 * SELL: Any of the last 3 candles (C0, C1, C2) had high >= upperBB * 0.9997
 *       AND (RSI >= 55 OR Bearish Divergence OR Upper Wick >= 25%)
 *       AND Current price is rejecting (C0.close < C0.open OR C0.close < C1.high).
 */
function evaluateSetupB(indicators: IndicatorSnapshot, pairProfile: PairProfile): { buy: EvaluatedSetup; sell: EvaluatedSetup } {
  const { c0, c1, c2, divergence } = indicators;
  const digits = pairProfile.digits;

  // --- BUY EVALUATION (Mean Reversion Snap-Back) ---
  let buyScore = 0;
  const buyReasons: string[] = [];
  let buyWaiting = 'Waiting for Confirmation Hook at Lower BB';

  // 1. Mandatory Momentum Expansion Veto:
  // Do NOT trigger a counter-trend BUY while a strong momentum candle is expanding outside the Bollinger Band.
  const isC0ExpandingDown = c0.candle.close <= c0.lowerBB && c0.candle.close < c0.candle.open && c0.lowerWickRatio < 0.35;

  // 2. Prior candle pierced / touched outside Lower BB OR |zScore| >= 1.85
  const c1PiercedLower = c1.candle.low <= c1.lowerBB * 1.0003 || c1.candle.close <= c1.lowerBB || (c1.zScore !== undefined && c1.zScore <= -1.85);
  const c2PiercedLower = c2.candle.low <= c2.lowerBB * 1.0003 || c2.candle.close <= c2.lowerBB || (c2.zScore !== undefined && c2.zScore <= -1.85);
  const prevPiercedLower = c1PiercedLower || c2PiercedLower;

  // 3. Current candle shows rejection:
  // Lower wick >= 35% of range OR closes back inside lower BB with RSI hooking back toward 50 (curling up).
  const c0LowerWickRejection = c0.lowerWickRatio >= 0.35;
  const c0ClosedInsideWithRsiHook = c0.candle.close > c0.lowerBB && c0.rsi > c1.rsi && c0.rsi <= 52;
  const c0ShowsRejection = c0LowerWickRejection || c0ClosedInsideWithRsiHook;

  const buyConfirmationHookPassed = prevPiercedLower && c0ShowsRejection && !isC0ExpandingDown;

  if (isC0ExpandingDown) {
    buyWaiting = 'Counter-trend BUY blocked: Strong momentum candle expanding outside Lower BB (Falling Knife)';
  } else if (!prevPiercedLower) {
    buyWaiting = 'Waiting for previous candle to pierce outside Lower BB or |zScore| >= 1.85';
  } else if (!c0ShowsRejection) {
    buyWaiting = 'Waiting for rejection confirmation (Lower wick >= 35% or close back inside BB with RSI hook toward 50)';
  } else {
    // Confirmation Hook Passed (+40 pts)
    buyScore += 40;
    buyReasons.push(`Confirmation Hook: Previous candle pierced Lower BB/|zScore| >= 1.85 & C0 rejected (${c0LowerWickRejection ? `lower wick ${(c0.lowerWickRatio * 100).toFixed(0)}% >= 35%` : 'closed back inside BB with RSI hook toward 50'}) (+40pts)`);

    // Additional confluence points
    if (c0.lowerWickRatio >= 0.35) {
      buyScore += 20;
      buyReasons.push(`Rejection Wick: Strong lower absorption wick ${c0.lowerWickRatio.toFixed(2)} (+20pts)`);
    } else if (c0.lowerWickRatio >= 0.25) {
      buyScore += 10;
      buyReasons.push(`Absorption Wick: Lower wick >= 0.25 (+10pts)`);
    }

    if (c0ClosedInsideWithRsiHook) {
      buyScore += 15;
      buyReasons.push(`RSI Hook Toward 50: Closed inside BB and RSI curled (${c1.rsi.toFixed(1)} -> ${c0.rsi.toFixed(1)}) (+15pts)`);
    }

    if (c0.rsi <= 35) {
      buyScore += 15;
      buyReasons.push(`Oversold RSI: RSI ${c0.rsi.toFixed(1)} <= 35 (+15pts)`);
    } else if (c0.rsi <= 45) {
      buyScore += 10;
      buyReasons.push(`Relaxed Oversold RSI: RSI ${c0.rsi.toFixed(1)} <= 45 (+10pts)`);
    }

    if (divergence.detected && divergence.bullishDivergence) {
      buyScore += 15;
      buyReasons.push(`Bullish Divergence: Confirmed divergence active (+15pts)`);
    }

    const isC0Bullish = c0.candle.close > c0.candle.open;
    if (isC0Bullish && c0.candle.close > c1.candle.close) {
      buyScore += 10;
      buyReasons.push(`Bullish Engulfing: Close > C1 close (+10pts)`);
    }
  }

  const buyRegime = c0.candle.close >= c0.ema200 ? 'WITH_TREND' : 'COUNTER_TREND';
  const buySignalType = buyRegime === 'WITH_TREND' ? 'WITH_TREND_BUY' : 'COUNTER_TREND_BUY';

  // --- SELL EVALUATION (Mean Reversion Snap-Back) ---
  let sellScore = 0;
  const sellReasons: string[] = [];
  let sellWaiting = 'Waiting for Confirmation Hook at Upper BB';

  // 1. Mandatory Momentum Expansion Veto:
  // Do NOT trigger a counter-trend SELL while a strong momentum candle is expanding outside the Bollinger Band.
  const isC0ExpandingUp = c0.candle.close >= c0.upperBB && c0.candle.close > c0.candle.open && c0.upperWickRatio < 0.35;

  // 2. Prior candle pierced / touched outside Upper BB OR |zScore| >= 1.85
  const c1PiercedUpper = c1.candle.high >= c1.upperBB * 0.9997 || c1.candle.close >= c1.upperBB || (c1.zScore !== undefined && c1.zScore >= 1.85);
  const c2PiercedUpper = c2.candle.high >= c2.upperBB * 0.9997 || c2.candle.close >= c2.upperBB || (c2.zScore !== undefined && c2.zScore >= 1.85);
  const prevPiercedUpper = c1PiercedUpper || c2PiercedUpper;

  // 3. Current candle shows rejection:
  // Upper wick >= 35% of range OR closes back inside upper BB with RSI hooking back toward 50 (curling down).
  const c0UpperWickRejection = c0.upperWickRatio >= 0.35;
  const c0ClosedInsideWithRsiHookSell = c0.candle.close < c0.upperBB && c0.rsi < c1.rsi && c0.rsi >= 48;
  const c0ShowsRejectionSell = c0UpperWickRejection || c0ClosedInsideWithRsiHookSell;

  const sellConfirmationHookPassed = prevPiercedUpper && c0ShowsRejectionSell && !isC0ExpandingUp;

  if (isC0ExpandingUp) {
    sellWaiting = 'Counter-trend SELL blocked: Strong momentum candle expanding outside Upper BB (Rocketing Outlier)';
  } else if (!prevPiercedUpper) {
    sellWaiting = 'Waiting for previous candle to pierce outside Upper BB or |zScore| >= 1.85';
  } else if (!c0ShowsRejectionSell) {
    sellWaiting = 'Waiting for rejection confirmation (Upper wick >= 35% or close back inside BB with RSI hook toward 50)';
  } else {
    // Confirmation Hook Passed (+40 pts)
    sellScore += 40;
    sellReasons.push(`Confirmation Hook: Previous candle pierced Upper BB/|zScore| >= 1.85 & C0 rejected (${c0UpperWickRejection ? `upper wick ${(c0.upperWickRatio * 100).toFixed(0)}% >= 35%` : 'closed back inside BB with RSI hook toward 50'}) (+40pts)`);

    // Additional confluence points
    if (c0.upperWickRatio >= 0.35) {
      sellScore += 20;
      sellReasons.push(`Rejection Wick: Strong upper rejection wick ${c0.upperWickRatio.toFixed(2)} (+20pts)`);
    } else if (c0.upperWickRatio >= 0.25) {
      sellScore += 10;
      sellReasons.push(`Rejection Wick: Upper wick >= 0.25 (+10pts)`);
    }

    if (c0ClosedInsideWithRsiHookSell) {
      sellScore += 15;
      sellReasons.push(`RSI Hook Toward 50: Closed inside BB and RSI curled (${c1.rsi.toFixed(1)} -> ${c0.rsi.toFixed(1)}) (+15pts)`);
    }

    if (c0.rsi >= 65) {
      sellScore += 15;
      sellReasons.push(`Overbought RSI: RSI ${c0.rsi.toFixed(1)} >= 65 (+15pts)`);
    } else if (c0.rsi >= 55) {
      sellScore += 10;
      sellReasons.push(`Relaxed Overbought RSI: RSI ${c0.rsi.toFixed(1)} >= 55 (+10pts)`);
    }

    if (divergence.detected && divergence.bearishDivergence) {
      sellScore += 15;
      sellReasons.push(`Bearish Divergence: Confirmed divergence active (+15pts)`);
    }

    const isC0Bearish = c0.candle.close < c0.candle.open;
    if (isC0Bearish && c0.candle.close < c1.candle.close) {
      sellScore += 10;
      sellReasons.push(`Bearish Engulfing: Close < C1 close (+10pts)`);
    }
  }

  const sellRegime = c0.candle.close <= c0.ema200 ? 'WITH_TREND' : 'COUNTER_TREND';
  const sellSignalType = sellRegime === 'WITH_TREND' ? 'WITH_TREND_SELL' : 'COUNTER_TREND_SELL';

  return {
    buy: {
      name: 'SETUP_B_BB_EXTREME_SNAPBACK',
      side: 'BUY',
      score: Math.min(100, buyScore),
      reasons: buyReasons,
      waiting: buyWaiting,
      regime: buyRegime,
      signalType: buySignalType,
    },
    sell: {
      name: 'SETUP_B_BB_EXTREME_SNAPBACK',
      side: 'SELL',
      score: Math.min(100, sellScore),
      reasons: sellReasons,
      waiting: sellWaiting,
      regime: sellRegime,
      signalType: sellSignalType,
    },
  };
}

/**
 * SETUP C — Momentum Breakout Impulse
 * BBW Expanding (expanding bands, volatility breakout)
 * AND Candle body > 1.2x average body size
 * AND RSI(14) breaking strongly (>55 for BUY, <45 for SELL)
 * AND aligned with EMA 200 or short-term 5-candle momentum.
 */
function evaluateSetupC(indicators: IndicatorSnapshot, pairProfile: PairProfile): { buy: EvaluatedSetup; sell: EvaluatedSetup } {
  const { c0, c1, bbwExpansionPct, avgBodySize, momentum5 } = indicators;
  const c0Body = Math.abs(c0.candle.close - c0.candle.open);
  const bodyMultiplier = avgBodySize > 0 ? Number((c0Body / avgBodySize).toFixed(2)) : 1.0;

  // --- BUY EVALUATION ---
  let buyScore = 0;
  const buyReasons: string[] = [];
  let buyWaiting = 'Waiting for bullish momentum impulse';

  const isBbwExpanding = bbwExpansionPct > 0 || c0.bbWidth > c1.bbWidth;
  if (bbwExpansionPct >= 10) {
    buyScore += 25;
    buyReasons.push(`BBW Expansion: Volatility breakout expansion +${bbwExpansionPct.toFixed(1)}% (+25pts)`);
  } else if (isBbwExpanding) {
    buyScore += 18;
    buyReasons.push(`BBW Expanding: Band width increasing (+18pts)`);
  }

  const isBullishCandle = c0.candle.close > c0.candle.open;
  if (isBullishCandle) {
    if (bodyMultiplier >= 1.5) {
      buyScore += 30;
      buyReasons.push(`Impulse Body: Large bullish body ${bodyMultiplier}x average body (+30pts)`);
    } else if (bodyMultiplier >= 1.2) {
      buyScore += 25;
      buyReasons.push(`Impulse Body: Bullish body ${bodyMultiplier}x average body (+25pts)`);
    } else if (bodyMultiplier >= 1.0) {
      buyScore += 15;
      buyReasons.push(`Impulse Body: Moderate bullish body ${bodyMultiplier}x avg (+15pts)`);
    } else {
      buyScore += 10;
    }
  }

  // RSI > 55
  if (c0.rsi >= 60) {
    buyScore += 25;
    buyReasons.push(`Strong RSI Surge: RSI ${c0.rsi.toFixed(1)} >= 60 (+25pts)`);
  } else if (c0.rsi > 55) {
    buyScore += 20;
    buyReasons.push(`RSI Breakout: RSI ${c0.rsi.toFixed(1)} > 55 (+20pts)`);
  } else if (c0.rsi > 50 && c0.rsi > c1.rsi) {
    buyScore += 12;
    buyReasons.push(`RSI Momentum: RSI ${c0.rsi.toFixed(1)} rising above 50 (+12pts)`);
  }

  // Alignment with EMA200 or 5-candle momentum
  const isAboveEma = c0.candle.close > c0.ema200;
  const isMomPositive = momentum5 > 0;
  if (isAboveEma && isMomPositive) {
    buyScore += 20;
    buyReasons.push(`Trend & Momentum Aligned: Price > EMA200 & 5-candle momentum positive (+20pts)`);
  } else if (isAboveEma || isMomPositive) {
    buyScore += 15;
    buyReasons.push(`Alignment: ${isAboveEma ? 'Price > EMA200' : '5-candle momentum positive'} (+15pts)`);
  }

  // Waiting condition diagnosis for BUY
  if (!isBbwExpanding) {
    buyWaiting = 'Waiting for BBW expansion';
  } else if (!isBullishCandle) {
    buyWaiting = 'Waiting for bullish impulse candle';
  } else if (bodyMultiplier < 1.2) {
    buyWaiting = `Waiting for candle body > 1.2x avg (currently ${bodyMultiplier}x)`;
  } else if (c0.rsi <= 55) {
    buyWaiting = `Waiting for RSI > 55 momentum break (current ${c0.rsi.toFixed(1)})`;
  }

  // --- SELL EVALUATION ---
  let sellScore = 0;
  const sellReasons: string[] = [];
  let sellWaiting = 'Waiting for bearish momentum impulse';

  if (bbwExpansionPct >= 10) {
    sellScore += 25;
    sellReasons.push(`BBW Expansion: Volatility breakout expansion +${bbwExpansionPct.toFixed(1)}% (+25pts)`);
  } else if (isBbwExpanding) {
    sellScore += 18;
    sellReasons.push(`BBW Expanding: Band width increasing (+18pts)`);
  }

  const isBearishCandle = c0.candle.close < c0.candle.open;
  if (isBearishCandle) {
    if (bodyMultiplier >= 1.5) {
      sellScore += 30;
      sellReasons.push(`Impulse Body: Large bearish body ${bodyMultiplier}x average body (+30pts)`);
    } else if (bodyMultiplier >= 1.2) {
      sellScore += 25;
      sellReasons.push(`Impulse Body: Bearish body ${bodyMultiplier}x average body (+25pts)`);
    } else if (bodyMultiplier >= 1.0) {
      sellScore += 15;
      sellReasons.push(`Impulse Body: Moderate bearish body ${bodyMultiplier}x avg (+15pts)`);
    } else {
      sellScore += 10;
    }
  }

  // RSI < 45
  if (c0.rsi <= 40) {
    sellScore += 25;
    sellReasons.push(`Strong RSI Drop: RSI ${c0.rsi.toFixed(1)} <= 40 (+25pts)`);
  } else if (c0.rsi < 45) {
    sellScore += 20;
    sellReasons.push(`RSI Breakdown: RSI ${c0.rsi.toFixed(1)} < 45 (+20pts)`);
  } else if (c0.rsi < 50 && c0.rsi < c1.rsi) {
    sellScore += 12;
    sellReasons.push(`RSI Momentum: RSI ${c0.rsi.toFixed(1)} falling below 50 (+12pts)`);
  }

  // Alignment with EMA200 or 5-candle momentum
  const isBelowEma = c0.candle.close < c0.ema200;
  const isMomNegative = momentum5 < 0;
  if (isBelowEma && isMomNegative) {
    sellScore += 20;
    sellReasons.push(`Trend & Momentum Aligned: Price < EMA200 & 5-candle momentum negative (+20pts)`);
  } else if (isBelowEma || isMomNegative) {
    sellScore += 15;
    sellReasons.push(`Alignment: ${isBelowEma ? 'Price < EMA200' : '5-candle momentum negative'} (+15pts)`);
  }

  // Waiting condition diagnosis for SELL
  if (!isBbwExpanding) {
    sellWaiting = 'Waiting for BBW expansion';
  } else if (!isBearishCandle) {
    sellWaiting = 'Waiting for bearish impulse candle';
  } else if (bodyMultiplier < 1.2) {
    sellWaiting = `Waiting for candle body > 1.2x avg (currently ${bodyMultiplier}x)`;
  } else if (c0.rsi >= 45) {
    sellWaiting = `Waiting for RSI < 45 momentum break (current ${c0.rsi.toFixed(1)})`;
  }

  return {
    buy: {
      name: 'SETUP_C_MOMENTUM_BREAKOUT',
      side: 'BUY',
      score: Math.min(100, buyScore),
      reasons: buyReasons,
      waiting: buyWaiting,
      regime: 'WITH_TREND',
      signalType: 'WITH_TREND_BUY',
    },
    sell: {
      name: 'SETUP_C_MOMENTUM_BREAKOUT',
      side: 'SELL',
      score: Math.min(100, sellScore),
      reasons: sellReasons,
      waiting: sellWaiting,
      regime: 'WITH_TREND',
      signalType: 'WITH_TREND_SELL',
    },
  };
}

/**
 * Master Unified Multi-Regime Signal Gate Evaluator
 */
export function evaluateSignalGates(
  candles: Candle[],
  params: SignalGateParams
): SignalGateResult {
  const { pairProfile, overridePreset, timeframe = 'M5' } = params;
  const config: StrategyPreset = { ...pairProfile.preset, ...overridePreset };

  // Generate pure TypeScript indicators
  const indicators = computeIndicatorSnapshot(
    candles,
    config.rsiPeriod,
    config.bbPeriod,
    config.bbStdDev
  );

  const { c0, c1, c2, bbwExpansionPct, divergence } = indicators;
  const currentAtr = c0.atr14;
  const atrPips = priceDiffToPips(currentAtr, pairProfile.pipValue);
  const triggerPrice = c0.candle.close;

  // Real-time market state telemetry values
  const formattedPrice = formatPrice(triggerPrice, pairProfile.digits);
  const isBullishRegime = triggerPrice >= c0.ema200;
  const regimeLabel = isBullishRegime ? 'BULLISH (>EMA200)' : 'BEARISH (<EMA200)';
  const rsiVal = c0.rsi.toFixed(1);
  const bbPosVal = Math.round(indicators.bbPositionPct);

  // Evaluate the 3 distinct institutional setups across BUY and SELL
  const setupA = evaluateSetupA(indicators, pairProfile);
  const setupB = evaluateSetupB(indicators, pairProfile);
  const setupC = evaluateSetupC(indicators, pairProfile);

  const er10 = indicators.efficiencyRatio ?? calculateKaufmanEfficiencyRatio(candles.map((c) => c.close), 10);

  const allCandidates: EvaluatedSetup[] = [
    setupA.buy,
    setupA.sell,
    setupB.buy,
    setupB.sell,
    setupC.buy,
    setupC.sell,
  ];

  // Strict Trend Veto on Forex/Gold (XAUUSDm Protection) & Kaufman ER Calibration:
  const ema50Val = indicators.c0.ema50 || (indicators.ema50 ? indicators.ema50[indicators.ema50.length - 1] : indicators.c0.middleBB);
  const ema50Prev = indicators.c1.ema50 || (indicators.ema50 ? indicators.ema50[indicators.ema50.length - 2] : ema50Val);
  const ema50Slope = ema50Val - ema50Prev;
  const isBbwExpanding = indicators.bbwExpansionPct > 0;

  for (const cand of allCandidates) {
    if (cand.regime === 'COUNTER_TREND') {
      // 1. Kaufman ER Veto: ER > 0.52 denotes non-ranging / institutional trending flow
      if (er10 > 0.52) {
        cand.score = 0;
        cand.reasons.push(`[STRICT TREND VETO] Kaufman ER ${er10.toFixed(2)} > 0.52 denotes trending regime. Counter-trend entry strictly blocked.`);
        cand.waiting = `Counter-trend blocked by Strict Trend Veto (Kaufman ER ${er10.toFixed(2)} > 0.52)`;
        continue;
      }

      // 2. Strong trend away from EMA50 with expanding BBW
      const isTrendingAway = cand.side === 'BUY'
        ? (triggerPrice < ema50Val && ema50Slope < 0 && isBbwExpanding)
        : (triggerPrice > ema50Val && ema50Slope > 0 && isBbwExpanding);

      if (isTrendingAway) {
        cand.score = 0;
        cand.reasons.push(`[STRICT TREND VETO] Price strongly trending away from EMA50 with expanding BBW (+${indicators.bbwExpansionPct.toFixed(1)}%). Counter-trend entry strictly blocked.`);
        cand.waiting = `Counter-trend blocked: Trending away from EMA50 with expanding BBW`;
        continue;
      }

      // 3. True ranging regime (ER <= 0.52): Optimal mean-reverting regime boost
      cand.score = Math.min(100, cand.score + 8);
      cand.reasons.push(`[ER-10 REGIME BOOST] Kaufman ER ${er10.toFixed(2)} <= 0.52 confirms true ranging regime (+8pts).`);
    } else {
      // With-trend entries: boost if aligned with strong momentum
      if (er10 > 0.52) {
        cand.score = Math.min(100, cand.score + 6);
        cand.reasons.push(`[TREND CONFLUENCE] Aligned with strong institutional trend (ER ${er10.toFixed(2)} > 0.52, +6pts).`);
      }
    }
  }

  // Pick highest scoring setup
  allCandidates.sort((a, b) => b.score - a.score);
  const bestSetup = allCandidates[0];

  const CONFLUENCE_THRESHOLD = 65;
  const isQualified = bestSetup.score >= CONFLUENCE_THRESHOLD;

  // Build live quantitative telemetry string
  const diagnosticTelemetry = `[${pairProfile.symbol}] SCAN: Price ${formattedPrice} | Regime: ${regimeLabel} | RSI: ${rsiVal} | BB Pos: ${bbPosVal}% | Confluence Score: ${bestSetup.score}/${CONFLUENCE_THRESHOLD} (${isQualified ? `${bestSetup.name} QUALIFIED` : bestSetup.waiting})`;

  // If score < 65, return non-triggering diagnostic telemetry without static spam
  if (!isQualified) {
    return {
      isValid: false,
      side: 'NONE',
      symbol: pairProfile.symbol,
      signalType: 'NONE',
      setupName: bestSetup.name,
      confluenceScore: bestSetup.score,
      regime: bestSetup.regime,
      gate1Passed: false,
      gate2Passed: false,
      stormProtectionPassed: true,
      regimeFilterPassed: false,
      divergenceDetected: divergence.detected,
      divergenceDetails: divergence,
      signalTriggerPrice: triggerPrice,
      proposedSlPrice: 0,
      proposedTpPrice: 0,
      slPips: 0,
      tpPips: 0,
      riskRewardRatio: 0,
      reasons: [diagnosticTelemetry],
      rejectionReason: diagnosticTelemetry,
      diagnosticTelemetry,
      indicators,
    };
  }

  // --- SIGNAL QUALIFIED (Score >= 65) ---
  const qualifiedSide = bestSetup.side;
  const qualifiedSignal = bestSetup.signalType;
  const qualifiedRegime = bestSetup.regime;
  const activeWickRatio = qualifiedSide === 'BUY' ? c0.lowerWickRatio : c0.upperWickRatio;

  // Calculate Context-Aware Initial SL and Dynamic TP:
  // Wider Breathing Room SL: max(2.2 * ATR, swingHighLowBuffer + spread * 2)
  // Enforce a minimum Reward-to-Risk ratio of 1.4R (TP distance >= 1.4 * SL distance)
  let proposedSlPrice = 0;
  let proposedTpPrice = 0;

  const spreadDistance = (config.maxSpreadPips || 3.0) * pairProfile.pipValue;

  if (qualifiedSide === 'BUY') {
    const swingLow = Math.min(c0.candle.low, c1.candle.low, c2.candle.low);
    const swingLowBuffer = Math.max(0, triggerPrice - swingLow);
    const slDist = Math.max(2.2 * currentAtr, swingLowBuffer + spreadDistance * 2);
    proposedSlPrice = triggerPrice - slDist;

    // Minimum Reward-to-Risk ratio of 1.4R (TP distance >= 1.4 * SL distance)
    let candidateTpDist = slDist * 2.0;
    if (bestSetup.name === 'SETUP_C_MOMENTUM_BREAKOUT') {
      candidateTpDist = Math.max(slDist * 1.4, Math.max(slDist * 2.2, 2.5 * currentAtr));
    } else {
      const bbDist = c0.upperBB - triggerPrice;
      if (bbDist > 0) {
        candidateTpDist = Math.max(slDist * 1.4, Math.min(slDist * 2.8, bbDist));
      }
    }
    candidateTpDist = Math.max(slDist * 1.4, candidateTpDist);
    proposedTpPrice = triggerPrice + candidateTpDist;
  } else {
    const swingHigh = Math.max(c0.candle.high, c1.candle.high, c2.candle.high);
    const swingHighBuffer = Math.max(0, swingHigh - triggerPrice);
    const slDist = Math.max(2.2 * currentAtr, swingHighBuffer + spreadDistance * 2);
    proposedSlPrice = triggerPrice + slDist;

    // Minimum Reward-to-Risk ratio of 1.4R (TP distance >= 1.4 * SL distance)
    let candidateTpDist = slDist * 2.0;
    if (bestSetup.name === 'SETUP_C_MOMENTUM_BREAKOUT') {
      candidateTpDist = Math.max(slDist * 1.4, Math.max(slDist * 2.2, 2.5 * currentAtr));
    } else {
      const bbDist = triggerPrice - c0.lowerBB;
      if (bbDist > 0) {
        candidateTpDist = Math.max(slDist * 1.4, Math.min(slDist * 2.8, bbDist));
      }
    }
    candidateTpDist = Math.max(slDist * 1.4, candidateTpDist);
    proposedTpPrice = triggerPrice - candidateTpDist;
  }

  const slPips = priceDiffToPips(Math.abs(triggerPrice - proposedSlPrice), pairProfile.pipValue);
  const tpPips = priceDiffToPips(Math.abs(proposedTpPrice - triggerPrice), pairProfile.pipValue);
  const riskRewardRatio = slPips > 0 ? Number((tpPips / slPips).toFixed(2)) : 0;
  const ema200Distance = Number((Math.abs(triggerPrice - c0.ema200) / pairProfile.pipValue).toFixed(1));

  // Multi-Timeframe Volatility & S/R Enriched Context
  const c0Range = c0.candle.high - c0.candle.low;
  const atrRatio = currentAtr > 0 ? Number((c0Range / currentAtr).toFixed(2)) : 1.0;
  const volatilityRegime: 'OPTIMAL' | 'ELEVATED' | 'COMPRESSED' =
    atrRatio > 1.8 ? 'ELEVATED' : atrRatio < 0.6 ? 'COMPRESSED' : 'OPTIMAL';

  const supportPrice = indicators.supportPrice;
  const resistancePrice = indicators.resistancePrice;
  const distToSupport = priceDiffToPips(Math.abs(triggerPrice - supportPrice), pairProfile.pipValue);
  const distToResistance = priceDiffToPips(Math.abs(resistancePrice - triggerPrice), pairProfile.pipValue);

  const wickRejectionStrength: 'HIGH_CONVICTION' | 'MODERATE' | 'WEAK' =
    activeWickRatio >= 0.35 ? 'HIGH_CONVICTION' : activeWickRatio >= 0.20 ? 'MODERATE' : 'WEAK';

  const rsiSlopeVal = Number((c0.rsi - c1.rsi).toFixed(2));

  const reasons = [
    `[${bestSetup.name}] ${qualifiedSide} QUALIFIED with Confluence Score ${bestSetup.score}/${CONFLUENCE_THRESHOLD}`,
    ...bestSetup.reasons,
    `SL: ${formatPrice(proposedSlPrice, pairProfile.digits)} (${slPips} pips) | TP: ${formatPrice(proposedTpPrice, pairProfile.digits)} (${tpPips} pips, R:R ${riskRewardRatio}:1)`,
    `Context: ATR Ratio ${atrRatio}x (${volatilityRegime}), BB Pos ${bbPosVal}%, S/R [${distToSupport}p to Sup, ${distToResistance}p to Res], Wick: ${wickRejectionStrength}`,
  ];

  const technicalSnapshot: TechnicalSnapshotPayload = {
    symbol: pairProfile.symbol,
    timestamp: c0.candle.timestamp,
    timeframe,
    side: qualifiedSide,
    signalType: qualifiedSignal,
    setupName: bestSetup.name,
    confluence_score: bestSetup.score,
    regime: qualifiedRegime,
    triggerPrice,
    rsi: Number(c0.rsi.toFixed(1)),
    wick_ratio: Number(activeWickRatio.toFixed(3)),
    bbw_expansion_pct: Number(bbwExpansionPct.toFixed(2)),
    bb_position_pct: Number(indicators.bbPositionPct.toFixed(1)),
    divergence_detected: divergence.detected,
    divergence_type: divergence.type,
    ema200Distance,
    atr_pips: Number(atrPips.toFixed(1)),
    atr_ratio: atrRatio,
    volatility_regime: volatilityRegime,
    support_price: supportPrice,
    resistance_price: resistancePrice,
    distance_to_support_pips: distToSupport,
    distance_to_resistance_pips: distToResistance,
    wick_rejection_strength: wickRejectionStrength,
    rsi_slope: rsiSlopeVal,
    c0: {
      open: c0.candle.open,
      high: c0.candle.high,
      low: c0.candle.low,
      close: c0.candle.close,
      rsi: c0.rsi,
      upperBB: c0.upperBB,
      middleBB: c0.middleBB,
      lowerBB: c0.lowerBB,
      ema200: c0.ema200,
      lowerWickRatio: c0.lowerWickRatio,
      upperWickRatio: c0.upperWickRatio,
    },
    c1: {
      open: c1.candle.open,
      high: c1.candle.high,
      low: c1.candle.low,
      close: c1.candle.close,
      rsi: c1.rsi,
      upperBB: c1.upperBB,
      lowerBB: c1.lowerBB,
    },
    proposedSlPrice: Number(proposedSlPrice.toFixed(pairProfile.digits)),
    proposedTpPrice: Number(proposedTpPrice.toFixed(pairProfile.digits)),
    proposedSlPips: slPips,
    proposedTpPips: tpPips,
    riskRewardRatio,
    marketType: 'FOREX',
    efficiencyRatio: Number(er10.toFixed(4)),
    pocMagnetAligned: false,
  };

  return {
    isValid: true,
    side: qualifiedSide,
    symbol: pairProfile.symbol,
    signalType: qualifiedSignal,
    setupName: bestSetup.name,
    confluenceScore: bestSetup.score,
    regime: qualifiedRegime,
    gate1Passed: true,
    gate2Passed: true,
    stormProtectionPassed: true,
    regimeFilterPassed: true,
    divergenceDetected: divergence.detected,
    divergenceDetails: divergence,
    signalTriggerPrice: triggerPrice,
    proposedSlPrice: Number(proposedSlPrice.toFixed(pairProfile.digits)),
    proposedTpPrice: Number(proposedTpPrice.toFixed(pairProfile.digits)),
    slPips,
    tpPips,
    riskRewardRatio,
    reasons,
    diagnosticTelemetry,
    technicalSnapshot,
    indicators,
  };
}