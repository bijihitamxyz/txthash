/**
 * Pure TypeScript Technical Indicator Engine (src/core/indicatorEngine.ts)
 * Computes RSI(14), Bollinger Bands(20,2), EMA(200), ATR(14), BBW Expansion,
 * and 15-candle RSI Regular & Hidden Divergence Detection.
 */

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

export function timeframeToMs(tf: Timeframe | string): number {
  switch (tf) {
    case 'M1': return 60 * 1000;
    case 'M5': return 5 * 60 * 1000;
    case 'M15': return 15 * 60 * 1000;
    case 'H1': return 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[]; // (upper - lower) / middle
}

export interface DivergenceResult {
  detected: boolean;
  bullishDivergence: boolean;
  bearishDivergence: boolean;
  type: 'BULLISH_REGULAR' | 'BEARISH_REGULAR' | 'BULLISH_HIDDEN' | 'BEARISH_HIDDEN' | 'NONE';
  description: string;
  priceAnchorIndex: number;
  rsiAnchorIndex: number;
  priceDiffPct: number;
  rsiDiff: number;
}

export interface ExpectedMoveProjection {
  expectedTargetPrice: number;
  expectedMoveUsd: number;
  expectedMovePct: number;
  magnetType: 'POC_PULLBACK' | 'VAL_DEEP_DIP' | 'VAH_DEEP_RISE' | 'DRASTIC_DROP' | 'DRASTIC_RISE' | 'EQUILIBRIUM';
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
}

export interface ExpectedMoveInput {
  currentPrice: number;
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
  atr14: number;
  zScore: number;
  rsi?: number;
  momentum5?: number;
  bbwExpansionPct?: number;
  bullishPct?: number;
  digits?: number;
}

export interface IndicatorSnapshot {
  rsi: number[];
  bb: BollingerBandsResult;
  ema21: number[];
  ema50: number[];
  ema200: number[];
  atr14: number[];
  bbwExpansionPct: number;
  rsiSlope: number;
  ema200Slope: number;
  avgBodySize: number;
  momentum5: number;
  bbPositionPct: number;
  atrRatio: number;
  efficiencyRatio: number;
  supportPrice: number;
  resistancePrice: number;
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
  expectedTargetPrice: number;
  expectedMoveUsd: number;
  expectedMovePct: number;
  expectedMove: ExpectedMoveProjection;
  divergence: DivergenceResult;
  // Last three closed candles reference (C0 trigger, C1 setup, C2 prior context)
  c0: {
    candle: Candle;
    rsi: number;
    upperBB: number;
    middleBB: number;
    lowerBB: number;
    bbWidth: number;
    ema50: number;
    ema200: number;
    atr14: number;
    zScore: number;
    lowerWickRatio: number;
    upperWickRatio: number;
  };
  c1: {
    candle: Candle;
    rsi: number;
    upperBB: number;
    middleBB: number;
    lowerBB: number;
    bbWidth: number;
    ema50: number;
    ema200: number;
    atr14: number;
    zScore: number;
    lowerWickRatio: number;
    upperWickRatio: number;
  };
  c2: {
    candle: Candle;
    rsi: number;
    upperBB: number;
    middleBB: number;
    lowerBB: number;
    bbWidth: number;
    ema50: number;
    ema200: number;
    atr14: number;
    zScore: number;
    lowerWickRatio: number;
    upperWickRatio: number;
  };
}

/**
 * Calculates Wilder's smoothed RSI (Relative Strength Index)
 */
export function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff >= 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i] = Number((100 - (100 / (1 + rs))).toFixed(2));
    }
  }

  return rsi;
}

/**
 * Calculates Bollinger Bands (SMA, Upper, Lower, Bandwidth)
 */
export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2.0
): BollingerBandsResult {
  const upper: number[] = new Array(closes.length).fill(0);
  const middle: number[] = new Array(closes.length).fill(0);
  const lower: number[] = new Array(closes.length).fill(0);
  const width: number[] = new Array(closes.length).fill(0);

  if (closes.length < period) {
    return { upper, middle, lower, width };
  }

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += closes[i - j];
    }
    const sma = sum / period;
    middle[i] = sma;

    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      varianceSum += Math.pow(closes[i - j] - sma, 2);
    }
    const stdDev = Math.sqrt(varianceSum / period);

    upper[i] = sma + (stdDevMultiplier * stdDev);
    lower[i] = sma - (stdDevMultiplier * stdDev);
    width[i] = sma !== 0 ? (upper[i] - lower[i]) / sma : 0;
  }

  for (let i = 0; i < period - 1; i++) {
    upper[i] = upper[period - 1];
    middle[i] = middle[period - 1];
    lower[i] = lower[period - 1];
    width[i] = width[period - 1];
  }

  return { upper, middle, lower, width };
}

/**
 * Calculates Exponential Moving Average (EMA)
 */
export function calculateEMA(closes: number[], period: number = 200): number[] {
  const ema: number[] = new Array(closes.length).fill(0);
  if (closes.length === 0) return ema;

  const k = 2 / (period + 1);
  const initialPeriod = Math.min(closes.length, period);
  let sum = 0;
  for (let i = 0; i < initialPeriod; i++) {
    sum += closes[i];
  }
  let prevEma = sum / initialPeriod;

  for (let i = 0; i < initialPeriod; i++) {
    ema[i] = prevEma;
  }

  for (let i = initialPeriod; i < closes.length; i++) {
    prevEma = (closes[i] * k) + (prevEma * (1 - k));
    ema[i] = prevEma;
  }

  return ema;
}

/**
 * Calculates Average True Range (ATR)
 */
export function calculateATR(candles: Candle[], period: number = 14): number[] {
  const atr: number[] = new Array(candles.length).fill(0);
  if (candles.length < 2) return atr;

  const tr: number[] = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hcp = Math.abs(candles[i].high - candles[i - 1].close);
    const lcp = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hcp, lcp);
  }

  const effectivePeriod = Math.min(period, candles.length);
  let trSum = 0;
  for (let i = 0; i < effectivePeriod; i++) {
    trSum += tr[i];
  }
  let currentAtr = trSum / effectivePeriod;
  atr[effectivePeriod - 1] = currentAtr;

  for (let i = effectivePeriod; i < candles.length; i++) {
    currentAtr = (currentAtr * (period - 1) + tr[i]) / period;
    atr[i] = currentAtr;
  }

  for (let i = 0; i < effectivePeriod - 1; i++) {
    atr[i] = atr[effectivePeriod - 1];
  }

  return atr;
}

/**
 * Kaufman Efficiency Ratio (ER-10) for Microstructure Regime Detection:
 * ER = |close[n] - close[n - period]| / sum(|close[i] - close[i - 1]| for last 10 candles)
 * Returns 0.0 (pure chop/noise) to 1.0 (pure straight-line trend without pullbacks).
 * - ER > 0.68: Strong one-way institutional trend/cascade (penalizes counter-trend snapback)
 * - ER <= 0.50: Optimal mean-reverting regime (boosts snapback signal confidence)
 */
export function calculateKaufmanEfficiencyRatio(closes: number[], period: number = 10): number {
  if (closes.length <= period) return 0.5;
  const n = closes.length - 1;
  const netChange = Math.abs(closes[n] - closes[n - period]);
  let totalVolatility = 0;
  for (let i = n - period + 1; i <= n; i++) {
    totalVolatility += Math.abs(closes[i] - closes[i - 1]);
  }
  if (totalVolatility === 0) return 0.5;
  return Number((netChange / totalVolatility).toFixed(4));
}

/**
 * Detects Bullish and Bearish RSI Divergences (Regular & Hidden) over lookback window (15 candles)
 */
export function detectDivergence(
  candles: Candle[],
  rsi: number[],
  lookback: number = 15
): DivergenceResult {
  const len = candles.length;
  if (len < lookback + 2) {
    return {
      detected: false,
      bullishDivergence: false,
      bearishDivergence: false,
      type: 'NONE',
      description: 'Insufficient candles for divergence detection',
      priceAnchorIndex: -1,
      rsiAnchorIndex: -1,
      priceDiffPct: 0,
      rsiDiff: 0,
    };
  }

  const c0Index = len - 1;
  const c0Rsi = rsi[c0Index];

  // Search prior swing lows and swing highs in the 15-candle lookback window
  const searchStart = Math.max(2, len - lookback);
  const searchEnd = len - 3;

  // 1. Regular & Hidden Bullish Divergence
  let lowestSwingLowIndex = -1;
  let lowestSwingLowPrice = Infinity;

  for (let i = searchStart; i <= searchEnd; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      if (candles[i].low < lowestSwingLowPrice) {
        lowestSwingLowPrice = candles[i].low;
        lowestSwingLowIndex = i;
      }
    }
  }

  if (lowestSwingLowIndex !== -1) {
    const anchorRsi = rsi[lowestSwingLowIndex];
    const currentLow = Math.min(candles[c0Index].low, candles[len - 2].low);
    const currentRsi = Math.min(c0Rsi, rsi[len - 2]);

    if (currentLow < lowestSwingLowPrice && currentRsi > anchorRsi + 1.0) {
      const priceDiffPct = ((currentLow - lowestSwingLowPrice) / lowestSwingLowPrice) * 100;
      return {
        detected: true,
        bullishDivergence: true,
        bearishDivergence: false,
        type: 'BULLISH_REGULAR',
        description: `Regular Bullish Divergence: Price Lower Low (${currentLow.toFixed(2)} vs ${lowestSwingLowPrice.toFixed(2)}) with RSI Higher Low (${currentRsi.toFixed(1)} vs ${anchorRsi.toFixed(1)})`,
        priceAnchorIndex: lowestSwingLowIndex,
        rsiAnchorIndex: lowestSwingLowIndex,
        priceDiffPct: Number(priceDiffPct.toFixed(2)),
        rsiDiff: Number((currentRsi - anchorRsi).toFixed(1)),
      };
    } else if (currentLow > lowestSwingLowPrice && currentRsi < anchorRsi - 1.0) {
      const priceDiffPct = ((currentLow - lowestSwingLowPrice) / lowestSwingLowPrice) * 100;
      return {
        detected: true,
        bullishDivergence: true,
        bearishDivergence: false,
        type: 'BULLISH_HIDDEN',
        description: `Hidden Bullish Divergence: Price Higher Low (${currentLow.toFixed(2)} vs ${lowestSwingLowPrice.toFixed(2)}) with RSI Lower Low (${currentRsi.toFixed(1)} vs ${anchorRsi.toFixed(1)})`,
        priceAnchorIndex: lowestSwingLowIndex,
        rsiAnchorIndex: lowestSwingLowIndex,
        priceDiffPct: Number(priceDiffPct.toFixed(2)),
        rsiDiff: Number((currentRsi - anchorRsi).toFixed(1)),
      };
    }
  }

  // 2. Regular & Hidden Bearish Divergence
  let highestSwingHighIndex = -1;
  let highestSwingHighPrice = -Infinity;

  for (let i = searchStart; i <= searchEnd; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      if (candles[i].high > highestSwingHighPrice) {
        highestSwingHighPrice = candles[i].high;
        highestSwingHighIndex = i;
      }
    }
  }

  if (highestSwingHighIndex !== -1) {
    const anchorRsi = rsi[highestSwingHighIndex];
    const currentHigh = Math.max(candles[c0Index].high, candles[len - 2].high);
    const currentRsi = Math.max(c0Rsi, rsi[len - 2]);

    if (currentHigh > highestSwingHighPrice && currentRsi < anchorRsi - 1.0) {
      const priceDiffPct = ((currentHigh - highestSwingHighPrice) / highestSwingHighPrice) * 100;
      return {
        detected: true,
        bullishDivergence: false,
        bearishDivergence: true,
        type: 'BEARISH_REGULAR',
        description: `Regular Bearish Divergence: Price Higher High (${currentHigh.toFixed(2)} vs ${highestSwingHighPrice.toFixed(2)}) with RSI Lower High (${currentRsi.toFixed(1)} vs ${anchorRsi.toFixed(1)})`,
        priceAnchorIndex: highestSwingHighIndex,
        rsiAnchorIndex: highestSwingHighIndex,
        priceDiffPct: Number(priceDiffPct.toFixed(2)),
        rsiDiff: Number((currentRsi - anchorRsi).toFixed(1)),
      };
    } else if (currentHigh < highestSwingHighPrice && currentRsi > anchorRsi + 1.0) {
      const priceDiffPct = ((currentHigh - highestSwingHighPrice) / highestSwingHighPrice) * 100;
      return {
        detected: true,
        bullishDivergence: false,
        bearishDivergence: true,
        type: 'BEARISH_HIDDEN',
        description: `Hidden Bearish Divergence: Price Lower High (${currentHigh.toFixed(2)} vs ${highestSwingHighPrice.toFixed(2)}) with RSI Higher High (${currentRsi.toFixed(1)} vs ${anchorRsi.toFixed(1)})`,
        priceAnchorIndex: highestSwingHighIndex,
        rsiAnchorIndex: highestSwingHighIndex,
        priceDiffPct: Number(priceDiffPct.toFixed(2)),
        rsiDiff: Number((currentRsi - anchorRsi).toFixed(1)),
      };
    }
  }

  return {
    detected: false,
    bullishDivergence: false,
    bearishDivergence: false,
    type: 'NONE',
    description: 'No divergence detected in 15-candle window',
    priceAnchorIndex: -1,
    rsiAnchorIndex: -1,
    priceDiffPct: 0,
    rsiDiff: 0,
  };
}

/**
 * Calculates upper and lower wick ratios for rejection detection
 */
export function calculateWickRatios(candle: Candle): { lowerWickRatio: number; upperWickRatio: number } {
  const range = candle.high - candle.low;
  if (range <= 0) return { lowerWickRatio: 0, upperWickRatio: 0 };

  const bodyMin = Math.min(candle.open, candle.close);
  const bodyMax = Math.max(candle.open, candle.close);

  const lowerWick = bodyMin - candle.low;
  const upperWick = candle.high - bodyMax;

  return {
    lowerWickRatio: Number((lowerWick / range).toFixed(3)),
    upperWickRatio: Number((upperWick / range).toFixed(3)),
  };
}

/**
 * Master Indicator Snapshot Generator
 */
export function computeIndicatorSnapshot(
  candles: Candle[],
  rsiPeriod: number = 14,
  bbPeriod: number = 20,
  bbStdDev: number = 2.0
): IndicatorSnapshot {
  if (candles.length < 2) {
    throw new Error('computeIndicatorSnapshot requires at least 2 candles');
  }

  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, rsiPeriod);
  const bb = calculateBollingerBands(closes, bbPeriod, bbStdDev);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr14 = calculateATR(candles, 14);
  const divergence = detectDivergence(candles, rsi, 15);

  const len = candles.length;
  const c0Index = len - 1;
  const c1Index = len - 2;
  const c2Index = Math.max(0, len - 3);
  const c3Index = Math.max(0, len - 4);

  // BBW Expansion calculation: Expansion rate from C3 to C0
  const bbwC0 = bb.width[c0Index];
  const bbwC3 = bb.width[c3Index] || bbwC0;
  const bbwExpansionPct = bbwC3 > 0 ? Number((((bbwC0 - bbwC3) / bbwC3) * 100).toFixed(2)) : 0;

  // RSI slope from C1 to C0 (momentum velocity)
  const rsiSlope = Number((rsi[c0Index] - rsi[c1Index]).toFixed(2));

  // EMA200 slope (trend direction velocity)
  const ema200Slope = Number((ema200[c0Index] - ema200[c1Index]).toFixed(6));

  // Average body size over last 14 candles
  const bodyLookback = Math.min(14, len);
  let totalBody = 0;
  for (let i = len - bodyLookback; i < len; i++) {
    totalBody += Math.abs(candles[i].close - candles[i].open);
  }
  const avgBodySize = bodyLookback > 0 ? Number((totalBody / bodyLookback).toFixed(5)) : 0;

  // 5-candle momentum: price delta from 5 candles ago
  const mom5Index = Math.max(0, len - 6);
  const momentum5 = Number((candles[c0Index].close - candles[mom5Index].close).toFixed(5));

  // BB Position percentage: where price is located within the bands (0% = lowerBB, 50% = middleBB, 100% = upperBB)
  const bbSpread = bb.upper[c0Index] - bb.lower[c0Index];
  const bbPositionPct = bbSpread > 0
    ? Number((((candles[c0Index].close - bb.lower[c0Index]) / bbSpread) * 100).toFixed(1))
    : 50;

  // Volatility metric: True Range / ATR14 ratio
  const c0Range = candles[c0Index].high - candles[c0Index].low;
  const atrVal = atr14[c0Index] > 0 ? atr14[c0Index] : 1;
  const atrRatio = Number((c0Range / atrVal).toFixed(2));

  // Kaufman Efficiency Ratio (ER-10) for Microstructure Regime Detection
  const efficiencyRatio = calculateKaufmanEfficiencyRatio(closes, 10);

  // Support & Resistance swing boundary calculation over lookback window (up to 30 candles)
  const srLookback = Math.min(30, len);
  const srStart = Math.max(0, len - srLookback);
  let supportPrice = Infinity;
  let resistancePrice = -Infinity;
  for (let i = srStart; i < len; i++) {
    if (candles[i].low < supportPrice) supportPrice = candles[i].low;
    if (candles[i].high > resistancePrice) resistancePrice = candles[i].high;
  }
  if (!isFinite(supportPrice)) supportPrice = candles[c0Index].low;
  if (!isFinite(resistancePrice)) resistancePrice = candles[c0Index].high;

  const c0Wicks = calculateWickRatios(candles[c0Index]);
  const c1Wicks = calculateWickRatios(candles[c1Index]);
  const c2Wicks = calculateWickRatios(candles[c2Index]);

  // Compute Z-Scores based on Bollinger Band stdDev
  const c0Std = (bb.upper[c0Index] - bb.middle[c0Index]) / (bbStdDev || 2);
  const c0ZScore = c0Std > 0 ? Number(((candles[c0Index].close - bb.middle[c0Index]) / c0Std).toFixed(2)) : 0;
  const c1Std = (bb.upper[c1Index] - bb.middle[c1Index]) / (bbStdDev || 2);
  const c1ZScore = c1Std > 0 ? Number(((candles[c1Index].close - bb.middle[c1Index]) / c1Std).toFixed(2)) : 0;
  const c2Std = (bb.upper[c2Index] - bb.middle[c2Index]) / (bbStdDev || 2);
  const c2ZScore = c2Std > 0 ? Number(((candles[c2Index].close - bb.middle[c2Index]) / c2Std).toFixed(2)) : 0;

  const inferredDigits = candles[c0Index].close > 500 ? 2 : candles[c0Index].close > 50 ? 3 : 5;
  const vpLevels = computeVolumeProfileLevels(candles, bb.middle[c0Index], inferredDigits);
  const expectedMove = computeExpectedMarketMove({
    currentPrice: candles[c0Index].close,
    pocPrice: vpLevels.poc,
    vahPrice: vpLevels.vah,
    valPrice: vpLevels.val,
    atr14: atr14[c0Index],
    zScore: c0ZScore,
    rsi: rsi[c0Index],
    momentum5,
    bbwExpansionPct,
    digits: inferredDigits,
  });

  return {
    rsi,
    bb,
    ema21,
    ema50,
    ema200,
    atr14,
    bbwExpansionPct,
    rsiSlope,
    ema200Slope,
    avgBodySize,
    momentum5,
    bbPositionPct,
    atrRatio,
    efficiencyRatio,
    supportPrice: Number(supportPrice.toFixed(5)),
    resistancePrice: Number(resistancePrice.toFixed(5)),
    pocPrice: vpLevels.poc,
    vahPrice: vpLevels.vah,
    valPrice: vpLevels.val,
    expectedTargetPrice: expectedMove.expectedTargetPrice,
    expectedMoveUsd: expectedMove.expectedMoveUsd,
    expectedMovePct: expectedMove.expectedMovePct,
    expectedMove,
    divergence,
    c0: {
      candle: candles[c0Index],
      rsi: rsi[c0Index],
      upperBB: bb.upper[c0Index],
      middleBB: bb.middle[c0Index],
      lowerBB: bb.lower[c0Index],
      bbWidth: bb.width[c0Index],
      ema50: ema50[c0Index],
      ema200: ema200[c0Index],
      atr14: atr14[c0Index],
      zScore: c0ZScore,
      lowerWickRatio: c0Wicks.lowerWickRatio,
      upperWickRatio: c0Wicks.upperWickRatio,
    },
    c1: {
      candle: candles[c1Index],
      rsi: rsi[c1Index],
      upperBB: bb.upper[c1Index],
      middleBB: bb.middle[c1Index],
      lowerBB: bb.lower[c1Index],
      bbWidth: bb.width[c1Index],
      ema50: ema50[c1Index],
      ema200: ema200[c1Index],
      atr14: atr14[c1Index],
      zScore: c1ZScore,
      lowerWickRatio: c1Wicks.lowerWickRatio,
      upperWickRatio: c1Wicks.upperWickRatio,
    },
    c2: {
      candle: candles[c2Index],
      rsi: rsi[c2Index],
      upperBB: bb.upper[c2Index],
      middleBB: bb.middle[c2Index],
      lowerBB: bb.lower[c2Index],
      bbWidth: bb.width[c2Index],
      ema50: ema50[c2Index],
      ema200: ema200[c2Index],
      atr14: atr14[c2Index],
      zScore: c2ZScore,
      lowerWickRatio: c2Wicks.lowerWickRatio,
      upperWickRatio: c2Wicks.upperWickRatio,
    },
  };
}

/**
 * Computes Volume-Weighted Point of Control (POC), Value Area High (VAH), and Value Area Low (VAL)
 * across recent candles for Expected Market Move projection.
 */
export function computeVolumeProfileLevels(
  candles: Candle[],
  middleBB: number,
  digits: number = 2
): { poc: number; vah: number; val: number } {
  if (!candles || candles.length === 0) {
    const base = Number((middleBB || 0).toFixed(digits));
    return { poc: base, vah: base, val: base };
  }
  const recent = candles.slice(-50);
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of recent) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  }
  if (!isFinite(minP) || !isFinite(maxP) || maxP <= minP) {
    const fallback = Number((middleBB || recent[recent.length - 1].close).toFixed(digits));
    return { poc: fallback, vah: fallback, val: fallback };
  }

  const buckets = 16;
  const step = (maxP - minP) / buckets;
  const volBins = new Array<number>(buckets).fill(0);
  let totalVol = 0;

  for (const c of recent) {
    const typicalPrice = (c.high + c.low + c.close * 2) / 4;
    const vol = Math.max(1, c.volume || 1);
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((typicalPrice - minP) / step)));
    volBins[idx] += vol;
    totalVol += vol;
  }

  let bestBin = 0;
  let maxVol = -1;
  for (let i = 0; i < buckets; i++) {
    if (volBins[i] > maxVol) {
      maxVol = volBins[i];
      bestBin = i;
    }
  }

  const targetVol = totalVol * 0.7;
  let capturedVol = volBins[bestBin];
  let lowBin = bestBin;
  let highBin = bestBin;

  while (capturedVol < targetVol && (lowBin > 0 || highBin < buckets - 1)) {
    const nextLowVol = lowBin > 0 ? volBins[lowBin - 1] : -1;
    const nextHighVol = highBin < buckets - 1 ? volBins[highBin + 1] : -1;
    if (nextHighVol >= nextLowVol && highBin < buckets - 1) {
      highBin++;
      capturedVol += volBins[highBin];
    } else if (lowBin > 0) {
      lowBin--;
      capturedVol += volBins[lowBin];
    } else {
      break;
    }
  }

  const rawPoc = minP + (bestBin + 0.5) * step;
  const blendedPoc = middleBB > 0 ? rawPoc * 0.65 + middleBB * 0.35 : rawPoc;
  const rawVal = minP + lowBin * step;
  const rawVah = minP + (highBin + 1) * step;

  return {
    poc: Number(blendedPoc.toFixed(digits)),
    vah: Number(Math.max(blendedPoc, rawVah).toFixed(digits)),
    val: Number(Math.min(blendedPoc, rawVal).toFixed(digits)),
  };
}

/**
 * Calculates real-time Quantitative Expected Market Move (% and target price)
 * from Kronos POC/VAH/VAL + ATR(14) + Z-Score:
 * - If price is extended above POC (Z > 1.0 or bearish momentum), primary downside magnet is POC (moderate dip)
 *   and VAL (deep dip); if VAL breaks with high volume/momentum, project currentPrice - (2.0 * atr) (drastic drop).
 * - Symmetric logic for upside magnet (POC -> VAH -> currentPrice + 2.0 * atr).
 * - expectedMoveUsd = expectedTargetPrice - currentPrice
 * - expectedMovePct = (expectedMoveUsd / currentPrice) * 100
 */
export function computeExpectedMarketMove(input: ExpectedMoveInput): ExpectedMoveProjection {
  const {
    currentPrice,
    pocPrice,
    vahPrice,
    valPrice,
    atr14,
    zScore,
    rsi = 50,
    momentum5 = 0,
    bbwExpansionPct = 10,
    bullishPct = 50,
  } = input;

  const digits = input.digits ?? (currentPrice > 500 ? 2 : currentPrice > 50 ? 3 : 5);
  if (!currentPrice || currentPrice <= 0 || isNaN(currentPrice)) {
    return {
      expectedTargetPrice: 0,
      expectedMoveUsd: 0,
      expectedMovePct: 0,
      magnetType: 'EQUILIBRIUM',
      pocPrice: pocPrice || 0,
      vahPrice: vahPrice || 0,
      valPrice: valPrice || 0,
    };
  }

  const safeAtr = atr14 > 0 ? atr14 : currentPrice * 0.0015;
  const poc = pocPrice > 0 ? pocPrice : currentPrice;
  const vah = vahPrice > 0 ? Math.max(poc, vahPrice) : poc + safeAtr;
  const val = valPrice > 0 ? Math.min(poc, valPrice) : poc - safeAtr;
  const bearishPct = 100 - bullishPct;
  const hasBearishMomentum = momentum5 < 0 || bearishPct > 52 || rsi >= 62;
  const hasBullishMomentum = momentum5 > 0 || bullishPct > 52 || rsi <= 38;

  let expectedTargetPrice = poc;
  let magnetType: ExpectedMoveProjection['magnetType'] = 'POC_PULLBACK';

  // 1. VAL break with high volume/momentum -> Drastic Drop: currentPrice - (2.0 * atr)
  if (
    currentPrice < val &&
    (momentum5 < -0.35 * safeAtr || bbwExpansionPct >= 20 || zScore <= -1.35 || bearishPct >= 65)
  ) {
    expectedTargetPrice = currentPrice - 2.0 * safeAtr;
    magnetType = 'DRASTIC_DROP';
  }
  // 2. VAH break with high volume/momentum -> Drastic Rise: currentPrice + (2.0 * atr)
  else if (
    currentPrice > vah &&
    (momentum5 > 0.35 * safeAtr || bbwExpansionPct >= 20 || zScore >= 1.35 || bullishPct >= 65) &&
    zScore <= 2.2
  ) {
    expectedTargetPrice = currentPrice + 2.0 * safeAtr;
    magnetType = 'DRASTIC_RISE';
  }
  // 3. Extended above POC (Z > 1.0 or bearish momentum) -> Downside magnet: POC (moderate dip) or VAL (deep dip)
  else if (currentPrice > poc && (zScore > 1.0 || hasBearishMomentum)) {
    const distToPoc = currentPrice - poc;
    if (zScore > 1.75 || (momentum5 < -0.6 * safeAtr && bearishPct >= 58) || distToPoc < 0.2 * safeAtr) {
      expectedTargetPrice = val < currentPrice ? val : currentPrice - 1.2 * safeAtr;
      magnetType = 'VAL_DEEP_DIP';
    } else {
      expectedTargetPrice = poc;
      magnetType = 'POC_PULLBACK';
    }
  }
  // 4. Extended below POC (Z < -1.0 or bullish momentum) -> Upside magnet: POC (moderate rise) or VAH (deep rise)
  else if (currentPrice < poc && (zScore < -1.0 || hasBullishMomentum)) {
    const distToPoc = poc - currentPrice;
    if (zScore < -1.75 || (momentum5 > 0.6 * safeAtr && bullishPct >= 58) || distToPoc < 0.2 * safeAtr) {
      expectedTargetPrice = vah > currentPrice ? vah : currentPrice + 1.2 * safeAtr;
      magnetType = 'VAH_DEEP_RISE';
    } else {
      expectedTargetPrice = poc;
      magnetType = 'POC_PULLBACK';
    }
  }
  // 5. Inside Value Area near POC -> gravitate toward VAH (bullish) or VAL (bearish) or POC
  else if (Math.abs(currentPrice - poc) >= 0.25 * safeAtr) {
    expectedTargetPrice = poc;
    magnetType = 'POC_PULLBACK';
  } else if (bullishPct >= 50) {
    expectedTargetPrice = vah > currentPrice + 0.1 * safeAtr ? vah : currentPrice + 0.8 * safeAtr;
    magnetType = 'VAH_DEEP_RISE';
  } else {
    expectedTargetPrice = val < currentPrice - 0.1 * safeAtr ? val : currentPrice - 0.8 * safeAtr;
    magnetType = 'VAL_DEEP_DIP';
  }

  const roundedTarget = Number(expectedTargetPrice.toFixed(digits));
  const expectedMoveUsd = Number((roundedTarget - currentPrice).toFixed(digits));
  const expectedMovePct = Number((((roundedTarget - currentPrice) / currentPrice) * 100).toFixed(2));

  return {
    expectedTargetPrice: roundedTarget,
    expectedMoveUsd,
    expectedMovePct,
    magnetType,
    pocPrice: poc,
    vahPrice: vah,
    valPrice: val,
  };
}

/**
 * Resamples a series of OHLCV candles to the target timeframe (M1, M5, M15, H1).
 * Supports both multi-bar aggregation (e.g., M1/M5 -> M15/H1) and high-resolution sub-bar interpolation.
 */
export function resampleCandles(
  candles: Candle[],
  targetTimeframe: Timeframe,
  digits: number = 2
): Candle[] {
  if (!candles || candles.length === 0) return [];
  const targetMs = timeframeToMs(targetTimeframe);

  // Estimate input interval
  let inputIntervalMs = 5 * 60 * 1000;
  if (candles.length >= 2) {
    const diffs: number[] = [];
    for (let i = 1; i < Math.min(10, candles.length); i++) {
      const d = Math.abs(candles[i].timestamp - candles[i - 1].timestamp);
      if (d > 0) diffs.push(d);
    }
    if (diffs.length > 0) {
      inputIntervalMs = diffs[Math.floor(diffs.length / 2)];
    }
  }

  // 1. If target timeframe is larger than input, aggregate into larger buckets
  if (targetMs > inputIntervalMs * 1.5) {
    const buckets = new Map<number, Candle[]>();
    for (const c of candles) {
      const bucketTime = Math.floor(c.timestamp / targetMs) * targetMs;
      const list = buckets.get(bucketTime);
      if (list) list.push(c);
      else buckets.set(bucketTime, [c]);
    }

    const resampled: Candle[] = [];
    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const key of sortedKeys) {
      const group = buckets.get(key)!;
      if (group.length === 0) continue;
      const open = group[0].open;
      const close = group[group.length - 1].close;
      let high = -Infinity;
      let low = Infinity;
      let volume = 0;
      for (const item of group) {
        if (item.high > high) high = item.high;
        if (item.low < low) low = item.low;
        volume += item.volume || 1;
      }
      resampled.push({
        timestamp: key,
        open: Number(open.toFixed(digits)),
        high: Number(high.toFixed(digits)),
        low: Number(low.toFixed(digits)),
        close: Number(close.toFixed(digits)),
        volume,
      });
    }

    if (resampled.length >= 10) {
      return resampled;
    }
  }

  // 2. If target timeframe is smaller or already matches, create realistic sub-bars / adjust spacing
  if (Math.abs(inputIntervalMs - targetMs) < targetMs * 0.2) {
    return candles;
  }

  // Sub-divide larger candles into target smaller candles (e.g. M5/M15 -> M1)
  const factor = Math.max(1, Math.round(inputIntervalMs / targetMs));
  const subCandles: Candle[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const subDuration = targetMs;
    const priceDelta = (c.close - c.open) / factor;
    let curOpen = c.open;

    for (let s = 0; s < factor; s++) {
      const subTimestamp = c.timestamp + (s * subDuration);
      const isLastSub = s === factor - 1;
      const subClose = isLastSub ? c.close : Number((curOpen + priceDelta + (Math.random() - 0.5) * (c.high - c.low) * 0.15).toFixed(digits));
      const subHigh = Number((Math.max(curOpen, subClose) + Math.random() * (c.high - Math.max(curOpen, subClose)) * 0.6).toFixed(digits));
      const subLow = Number((Math.min(curOpen, subClose) - Math.random() * (Math.min(curOpen, subClose) - c.low) * 0.6).toFixed(digits));

      subCandles.push({
        timestamp: subTimestamp,
        open: curOpen,
        high: Math.min(c.high, Math.max(subHigh, curOpen, subClose)),
        low: Math.max(c.low, Math.min(subLow, curOpen, subClose)),
        close: subClose,
        volume: Math.max(10, Math.floor((c.volume || 100) / factor)),
      });

      curOpen = subClose;
    }
  }

  return subCandles.length > 0 ? subCandles.slice(-150) : candles;
}
