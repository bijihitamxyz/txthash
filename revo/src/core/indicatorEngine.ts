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

export interface IndicatorSnapshot {
  rsi: number[];
  bb: BollingerBandsResult;
  ema200: number[];
  atr14: number[];
  bbwExpansionPct: number;
  rsiSlope: number;
  ema200Slope: number;
  avgBodySize: number;
  momentum5: number;
  bbPositionPct: number;
  atrRatio: number;
  supportPrice: number;
  resistancePrice: number;
  divergence: DivergenceResult;
  // Last three closed candles reference (C0 trigger, C1 setup, C2 prior context)
  c0: {
    candle: Candle;
    rsi: number;
    upperBB: number;
    middleBB: number;
    lowerBB: number;
    bbWidth: number;
    ema200: number;
    atr14: number;
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
    ema200: number;
    atr14: number;
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
    ema200: number;
    atr14: number;
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

  return {
    rsi,
    bb,
    ema200,
    atr14,
    bbwExpansionPct,
    rsiSlope,
    ema200Slope,
    avgBodySize,
    momentum5,
    bbPositionPct,
    atrRatio,
    supportPrice: Number(supportPrice.toFixed(5)),
    resistancePrice: Number(resistancePrice.toFixed(5)),
    divergence,
    c0: {
      candle: candles[c0Index],
      rsi: rsi[c0Index],
      upperBB: bb.upper[c0Index],
      middleBB: bb.middle[c0Index],
      lowerBB: bb.lower[c0Index],
      bbWidth: bb.width[c0Index],
      ema200: ema200[c0Index],
      atr14: atr14[c0Index],
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
      ema200: ema200[c1Index],
      atr14: atr14[c1Index],
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
      ema200: ema200[c2Index],
      atr14: atr14[c2Index],
      lowerWickRatio: c2Wicks.lowerWickRatio,
      upperWickRatio: c2Wicks.upperWickRatio,
    },
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
