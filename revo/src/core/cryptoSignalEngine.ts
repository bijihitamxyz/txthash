import { BinanceKline } from './binanceClient';
import {
  calculateDynamicThreshold,
  formatAutoGovernanceTelemetry,
  DynamicThresholdResult,
} from './centralAiConfig';
import { dualRoomProtections } from './riskGuard';

export interface CryptoIndicatorSnapshot {
  timestamp: number;
  price: number;
  rsi: number;
  upperBB: number;
  middleBB: number; // SMA 20
  lowerBB: number;
  bbWidthPct: number;
  vwap: number;
  ema50: number;
  ema200: number;
  atr14: number;
  volume: number;
  volumeSma20: number;
  volumeRatio: number;
  lowerWickRatio: number;
  upperWickRatio: number;
  fundingRate: number;
  divergence: 'BULLISH' | 'BEARISH' | 'NONE';
  efficiencyRatio?: number;
  pocMagnetAligned?: boolean;
}

export interface CryptoSignalVerdict {
  symbol: string;
  side: 'LONG' | 'SHORT';
  approved: boolean;
  score: number; // 0 - 100
  entryPrice: number;
  stopLossPrice: number;
  takeProfit1Price: number; // +0.7R or VWAP
  takeProfit2Price: number; // +2.0R
  rDistance: number;
  partialCloseRatio: number; // 0.60 (60%)
  moonbagRatio: number; // 0.40 (40%)
  reason: string;
  btcGuardBlocked: boolean;
  indicators: CryptoIndicatorSnapshot;
  dynamicThreshold?: number;
  setupName?: 'SETUP_A_TREND_PULLBACK' | 'SETUP_B_SNAPBACK_REVERSION' | 'NONE';
  aiVerdict?: {
    decision: 'EXECUTE' | 'REJECT';
    confidence: number;
    reasoning: string;
    source: string;
    modelUsed: string;
  };
}

/**
 * Calculates dynamic AI threshold for Binance / Bitget Crypto.
 * Uses Pure Quantitative Autonomous Dynamic Confidence Threshold Engine (58% - 82%)
 */
export function getCryptoDynamicThreshold(options?: {
  efficiencyRatio?: number;
  pocMagnetAligned?: boolean;
  configThreshold?: number;
  recentStopLoss?: boolean;
  symbol?: string;
}): number {
  if (
    typeof options?.configThreshold === 'number' &&
    options.configThreshold > 0 &&
    options.configThreshold !== 56 &&
    options.configThreshold !== 65
  ) {
    return options.configThreshold;
  }
  const result = calculateDynamicThreshold({
    efficiencyRatio: options?.efficiencyRatio,
    pocMagnetAligned: options?.pocMagnetAligned,
    kronosProbability: 60,
    recentStopLoss: options?.recentStopLoss,
    symbol: options?.symbol,
    marketType: 'CRYPTO',
  });
  return result.threshold;
}

/**
 * Calculates EMA series
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/**
 * Calculates RSI(14)
 */
export function calculateRSI(closes: number[], period: number = 14): number[] {
  if (closes.length <= period) return new Array(closes.length).fill(50);
  const rsi: number[] = new Array(period).fill(50);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  return rsi;
}

/**
 * Calculates Bollinger Bands (20, 2.2)
 */
export function calculateBollingerBands(closes: number[], period: number = 20, multiplier: number = 2.2): {
  upper: number[];
  middle: number[];
  lower: number[];
} {
  const upper: number[] = [];
  const middle: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      middle.push(closes[i]);
      upper.push(closes[i]);
      lower.push(closes[i]);
      continue;
    }

    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    middle.push(mean);
    upper.push(mean + multiplier * stdDev);
    lower.push(mean - multiplier * stdDev);
  }

  return { upper, middle, lower };
}

/**
 * Calculates Intraday VWAP: sum(typicalPrice * volume) / sum(volume)
 */
export function calculateVWAP(klines: BinanceKline[]): number[] {
  const vwap: number[] = [];
  let cumulativeTypicalVolume = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const typicalPrice = (k.high + k.low + k.close) / 3;
    const vol = k.volume > 0 ? k.volume : 1;

    cumulativeTypicalVolume += typicalPrice * vol;
    cumulativeVolume += vol;

    vwap.push(cumulativeVolume > 0 ? cumulativeTypicalVolume / cumulativeVolume : typicalPrice);
  }

  return vwap;
}

/**
 * Calculates ATR(14)
 */
export function calculateATR(klines: BinanceKline[], period: number = 14): number[] {
  if (klines.length === 0) return [];
  const tr: number[] = [klines[0].high - klines[0].low];

  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const prevC = klines[i - 1].close;
    const currentTr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    tr.push(currentTr);
  }

  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i < period) {
      atr.push(sum / (i + 1));
    } else {
      sum -= tr[i - period];
      atr.push(sum / period);
    }
  }

  return atr;
}

/**
 * Simple 15-candle regular RSI divergence check
 */
export function detectDivergence(closes: number[], rsis: number[]): 'BULLISH' | 'BEARISH' | 'NONE' {
  const len = closes.length;
  if (len < 15) return 'NONE';

  const cCurr = closes[len - 1];
  const rCurr = rsis[len - 1];

  let lowestClose = cCurr;
  let lowestRsi = rCurr;
  let highestClose = cCurr;
  let highestRsi = rCurr;

  for (let i = len - 15; i < len - 1; i++) {
    if (closes[i] < lowestClose) {
      lowestClose = closes[i];
      lowestRsi = rsis[i];
    }
    if (closes[i] > highestClose) {
      highestClose = closes[i];
      highestRsi = rsis[i];
    }
  }

  // Bullish regular divergence: Price made lower low, but RSI made higher low
  if (cCurr < lowestClose && rCurr > lowestRsi + 2.0) {
    return 'BULLISH';
  }

  // Bearish regular divergence: Price made higher high, but RSI made lower high
  if (cCurr > highestClose && rCurr < highestRsi - 2.0) {
    return 'BEARISH';
  }

  return 'NONE';
}

/**
 * Kaufman Efficiency Ratio (ER-10) for Microstructure Regime Detection:
 * ER = |close[n] - close[n - period]| / sum(|close[i] - close[i - 1]| for last 10 candles)
 * Returns 0.0 (chop/noise) to 1.0 (pure straight-line momentum).
 * - ER > 0.68: Strong runaway institutional trend (penalizes counter-trend snapback)
 * - ER <= 0.50: Mean-reverting regime (boosts confidence)
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
 * Checks BTC Dump / Pump velocity, Kaufman ER-10, and 3-candle ROC over the last 15 minutes.
 * If BTC dumped > 1.2% in 5m OR is in a high-efficiency dump (ER > 0.65 and negative ROC),
 * strictly sets dumpBlocked = true (VETO all Altcoin/L2 LONGS).
 */
export function evaluateBtcVelocityGuard(btcKlines: BinanceKline[]): {
  velocityPct: number;
  btcEr: number;
  btcRoc3: number;
  dumpBlocked: boolean;
  pumpBlocked: boolean;
  statusText: string;
} {
  if (!btcKlines || btcKlines.length < 2) {
    return {
      velocityPct: 0,
      btcEr: 0.5,
      btcRoc3: 0,
      dumpBlocked: false,
      pumpBlocked: false,
      statusText: 'BTC Guard: Normal',
    };
  }

  const btcCloses = btcKlines.map((k) => k.close);
  const len = btcCloses.length;
  const lastCandle = btcKlines[len - 1];
  const velocityPct = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;

  // Kaufman Efficiency Ratio (ER-10) on BTC
  const btcEr = calculateKaufmanEfficiencyRatio(btcCloses, 10);

  // 3-candle Rate of Change (15m window on M5 candles)
  const btcRoc3 = len >= 4
    ? ((btcCloses[len - 1] - btcCloses[len - 4]) / btcCloses[len - 4]) * 100
    : velocityPct;

  // Relaxed BTC Velocity Guard:
  // Only block Altcoin LONGs when BTC 3-bar ROC is crashing hard (< -0.55% with ER > 0.65),
  // NOT during normal minor fluctuations (-0.01% to -0.30%).
  const isHighEfficiencyDump = btcEr > 0.65 && btcRoc3 < -0.55;
  const dumpBlocked = velocityPct <= -1.5 || isHighEfficiencyDump;

  // Sharp pump threshold: +1.5% in 5m
  const pumpBlocked = velocityPct >= 1.5;

  let statusText = `BTC 5m Velocity: ${velocityPct >= 0 ? '+' : ''}${velocityPct.toFixed(2)}% | ER-10: ${btcEr.toFixed(2)} | 3-bar ROC: ${btcRoc3.toFixed(2)}% (Normal)`;
  if (isHighEfficiencyDump) {
    statusText = `🚨 BTC HIGH-EFFICIENCY DUMP VETO (ER ${btcEr.toFixed(2)} > 0.65, 3-bar ROC ${btcRoc3.toFixed(2)}% < -0.55%): All Altcoin LONGS VETOED to prevent cascade trap`;
  } else if (dumpBlocked) {
    statusText = `🚨 BTC DUMP GUARD ACTIVE (${velocityPct.toFixed(2)}% in 5m): All Altcoin LONGS blocked to prevent liquidation trap`;
  } else if (pumpBlocked) {
    statusText = `⚠️ BTC PUMP GUARD ACTIVE (+${velocityPct.toFixed(2)}% in 5m): Altcoin SHORTS restricted`;
  }

  return { velocityPct, btcEr, btcRoc3, dumpBlocked, pumpBlocked, statusText };
}

/**
 * Core Triple-Core 5-Indicator Confluence Evaluator for Binance Futures
 */
export async function evaluateCryptoSignal(params: {
  symbol: string;
  klines: BinanceKline[];
  fundingRate?: number;
  btcGuard?: { dumpBlocked: boolean; pumpBlocked: boolean };
  enableAiJudge?: boolean;
}): Promise<CryptoSignalVerdict> {
  const { symbol, klines, fundingRate = 0.0001, btcGuard, enableAiJudge = true } = params;

  if (!klines || klines.length < 50) {
    return {
      symbol,
      side: 'LONG',
      approved: false,
      score: 0,
      entryPrice: 0,
      stopLossPrice: 0,
      takeProfit1Price: 0,
      takeProfit2Price: 0,
      rDistance: 0,
      partialCloseRatio: 0.6,
      moonbagRatio: 0.4,
      reason: 'Insufficient candle history (<50 bars)',
      btcGuardBlocked: false,
      indicators: {} as any,
    };
  }

  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const len = klines.length;
  const currentCandle = klines[len - 1];
  const price = currentCandle.close;

  // Indicators calculation
  const rsiSeries = calculateRSI(closes, 14);
  const bb = calculateBollingerBands(closes, 20, 2.2);
  const vwapSeries = calculateVWAP(klines);
  const ema50Series = calculateEMA(closes, 50);
  const ema200Series = calculateEMA(closes, 200);
  const atrSeries = calculateATR(klines, 14);

  const curRsi = rsiSeries[len - 1];
  const curUpperBB = bb.upper[len - 1];
  const curMiddleBB = bb.middle[len - 1];
  const curLowerBB = bb.lower[len - 1];
  const curVwap = vwapSeries[len - 1];
  const curEma50 = ema50Series[len - 1];
  const curEma200 = ema200Series[len - 1];
  const curAtr = atrSeries[len - 1] || (price * 0.015);

  // Volume SMA 20
  const volSlice = volumes.slice(Math.max(0, len - 20));
  const volSma20 = volSlice.reduce((a, b) => a + b, 0) / (volSlice.length || 1);
  const volumeRatio = volSma20 > 0 ? currentCandle.volume / volSma20 : 1.0;

  // Candle wick proportions
  const candleRange = Math.max(currentCandle.high - currentCandle.low, price * 0.001);
  const bodyTop = Math.max(currentCandle.open, currentCandle.close);
  const bodyBottom = Math.min(currentCandle.open, currentCandle.close);
  const lowerWickRatio = (bodyBottom - currentCandle.low) / candleRange;
  const upperWickRatio = (currentCandle.high - bodyTop) / candleRange;

  // Divergence
  const divergence = detectDivergence(closes, rsiSeries);

  const bbWidthPct = curMiddleBB > 0 ? ((curUpperBB - curLowerBB) / curMiddleBB) * 100 : 2.0;

  // Kaufman ER-10 and Z-Score Calculation
  const er10 = calculateKaufmanEfficiencyRatio(closes, 10);
  const digits = price < 1 ? 5 : price < 10 ? 3 : 2;
  const recent20 = closes.slice(-20);
  const mean20 = recent20.reduce((s, v) => s + v, 0) / Math.max(1, recent20.length);
  const std20 = Math.sqrt(
    recent20.reduce((s, v) => s + Math.pow(v - mean20, 2), 0) / Math.max(1, recent20.length)
  );
  const zScore = std20 > 0 ? Number(((price - mean20) / std20).toFixed(2)) : 0;
  const vahPrice = Number((curMiddleBB + (curUpperBB - curMiddleBB) * 0.7).toFixed(digits));
  const valPrice = Number((curMiddleBB - (curMiddleBB - curLowerBB) * 0.7).toFixed(digits));
  const pocPrice = Number((curVwap || curMiddleBB).toFixed(digits));

  const isPocAlignedLong = price < pocPrice && pocPrice <= curMiddleBB;
  const isPocAlignedShort = price > pocPrice && pocPrice >= curMiddleBB;

  const snapshot: CryptoIndicatorSnapshot = {
    timestamp: currentCandle.timestamp,
    price,
    rsi: curRsi,
    upperBB: curUpperBB,
    middleBB: curMiddleBB,
    lowerBB: curLowerBB,
    bbWidthPct,
    vwap: curVwap,
    ema50: curEma50,
    ema200: curEma200,
    atr14: curAtr,
    volume: currentCandle.volume,
    volumeSma20: volSma20,
    volumeRatio,
    lowerWickRatio,
    upperWickRatio,
    fundingRate,
    divergence,
    efficiencyRatio: er10,
    pocMagnetAligned: isPocAlignedLong || isPocAlignedShort,
  };

  // --- CRYPTO DUAL-GATE EVALUATION (EITHER SETUP A OR SETUP B) ---
  // Setup A: Trend Pullback / VWAP & POC Bounce (RSI 32-68 near VWAP, EMA50, POC, VAL, VAH)
  // Setup B: Snap-Back Reversion (BB Outer Band or |zScore| >= 1.35 with RSI < 36 / > 64)

  // LONG SETUP A:
  const nearVwapLong = Math.abs(price - curVwap) / curVwap <= 0.015;
  const nearEma50Long = Math.abs(price - curEma50) / curEma50 <= 0.015;
  const nearPocLong = Math.abs(price - pocPrice) / pocPrice <= 0.015;
  const nearValLong = Math.abs(price - valPrice) / valPrice <= 0.015;
  const isNearSupportLong = nearVwapLong || nearEma50Long || nearPocLong || nearValLong;
  const isMomentumBullish = curEma50 >= curEma200 || price >= curEma200 * 0.995 || currentCandle.close >= currentCandle.open;
  const isRsiSetupA = curRsi >= 32 && curRsi <= 68;
  const setupAPassedLong = isNearSupportLong && isMomentumBullish && isRsiSetupA;

  // LONG SETUP B:
  const bbOuterTouchedLong = currentCandle.low <= curLowerBB * 1.002 || zScore <= -1.35;
  const rsiOversoldLong = curRsi < 36;
  const setupBPassedLong = bbOuterTouchedLong && rsiOversoldLong;

  // SHORT SETUP A:
  const nearVwapShort = Math.abs(price - curVwap) / curVwap <= 0.015;
  const nearEma50Short = Math.abs(price - curEma50) / curEma50 <= 0.015;
  const nearPocShort = Math.abs(price - pocPrice) / pocPrice <= 0.015;
  const nearVahShort = Math.abs(price - vahPrice) / vahPrice <= 0.015;
  const isNearResistanceShort = nearVwapShort || nearEma50Short || nearPocShort || nearVahShort;
  const isMomentumBearish = curEma50 <= curEma200 || price <= curEma200 * 1.005 || currentCandle.close <= currentCandle.open;
  const setupAPassedShort = isNearResistanceShort && isMomentumBearish && isRsiSetupA;

  // SHORT SETUP B:
  const bbOuterTouchedShort = currentCandle.high >= curUpperBB * 0.998 || zScore >= 1.35;
  const rsiOverboughtShort = curRsi > 64;
  const setupBPassedShort = bbOuterTouchedShort && rsiOverboughtShort;

  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];
  let longSetupName: 'SETUP_A_TREND_PULLBACK' | 'SETUP_B_SNAPBACK_REVERSION' | 'NONE' = 'NONE';
  let shortSetupName: 'SETUP_A_TREND_PULLBACK' | 'SETUP_B_SNAPBACK_REVERSION' | 'NONE' = 'NONE';

  if (setupAPassedLong) {
    longSetupName = 'SETUP_A_TREND_PULLBACK';
    longScore += 40;
    const supportLabel = nearVwapLong ? 'VWAP' : nearEma50Long ? 'EMA50' : nearPocLong ? 'POC' : 'VAL';
    longReasons.push(`Setup A Qualified: Trend Pullback to ${supportLabel} (RSI ${curRsi.toFixed(1)} [32-68], +40pts)`);
  } else if (setupBPassedLong) {
    longSetupName = 'SETUP_B_SNAPBACK_REVERSION';
    longScore += 40;
    longReasons.push(`Setup B Qualified: Snap-Back Reversion at Lower BB/zScore ${zScore.toFixed(2)} (RSI ${curRsi.toFixed(1)} < 36, +40pts)`);
  } else if (isNearSupportLong && isMomentumBullish) {
    longScore += 25;
    longReasons.push(`Near Support with Bullish Bias (+25pts)`);
  }

  if (setupAPassedShort) {
    shortSetupName = 'SETUP_A_TREND_PULLBACK';
    shortScore += 40;
    const resLabel = nearVwapShort ? 'VWAP' : nearEma50Short ? 'EMA50' : nearPocShort ? 'POC' : 'VAH';
    shortReasons.push(`Setup A Qualified: Trend Pullback to ${resLabel} (RSI ${curRsi.toFixed(1)} [32-68], +40pts)`);
  } else if (setupBPassedShort) {
    shortSetupName = 'SETUP_B_SNAPBACK_REVERSION';
    shortScore += 40;
    shortReasons.push(`Setup B Qualified: Snap-Back Reversion at Upper BB/zScore ${zScore.toFixed(2)} (RSI ${curRsi.toFixed(1)} > 64, +40pts)`);
  } else if (isNearResistanceShort && isMomentumBearish) {
    shortScore += 25;
    shortReasons.push(`Near Resistance with Bearish Bias (+25pts)`);
  }

  // Confluence Additions (Score boosts when setups are active)
  if (longScore > 0) {
    if (lowerWickRatio >= 0.35) {
      longScore += 12;
      longReasons.push(`Rejection Wick: ${(lowerWickRatio * 100).toFixed(0)}% lower wick (+12pts)`);
    } else if (lowerWickRatio >= 0.20) {
      longScore += 6;
      longReasons.push(`Moderate Lower Wick (+6pts)`);
    }
    if (volumeRatio >= 1.2) {
      longScore += 8;
      longReasons.push(`Volume Spike: ${volumeRatio.toFixed(1)}x SMA20 (+8pts)`);
    } else if (volumeRatio >= 0.9) {
      longScore += 4;
    }
    if (curEma50 >= curEma200 || price > curEma200) {
      longScore += 8;
      longReasons.push(`Macro Trend Bullish (+8pts)`);
    }
    if (divergence === 'BULLISH') {
      longScore += 8;
      longReasons.push(`Bullish RSI Divergence (+8pts)`);
    }
    if (fundingRate <= 0.0003) {
      longScore += 6;
      longReasons.push(`Funding Rate Safe (+6pts)`);
    }
    if (er10 <= 0.50) {
      longScore += 6;
      longReasons.push(`ER-10 Mean-Reverting (${er10.toFixed(2)}, +6pts)`);
    }
    if (isPocAlignedLong) {
      longScore += 6;
      longReasons.push(`POC Magnet Aligned ($${pocPrice}, +6pts)`);
    }
  }

  if (shortScore > 0) {
    if (upperWickRatio >= 0.35) {
      shortScore += 12;
      shortReasons.push(`Rejection Wick: ${(upperWickRatio * 100).toFixed(0)}% upper wick (+12pts)`);
    } else if (upperWickRatio >= 0.20) {
      shortScore += 6;
      shortReasons.push(`Moderate Upper Wick (+6pts)`);
    }
    if (volumeRatio >= 1.2) {
      shortScore += 8;
      shortReasons.push(`Volume Spike: ${volumeRatio.toFixed(1)}x SMA20 (+8pts)`);
    } else if (volumeRatio >= 0.9) {
      shortScore += 4;
    }
    if (curEma50 <= curEma200 || price < curEma200) {
      shortScore += 8;
      shortReasons.push(`Macro Trend Bearish (+8pts)`);
    }
    if (divergence === 'BEARISH') {
      shortScore += 8;
      shortReasons.push(`Bearish RSI Divergence (+8pts)`);
    }
    if (fundingRate >= -0.0003) {
      shortScore += 6;
      shortReasons.push(`Funding Rate Safe (+6pts)`);
    }
    if (er10 <= 0.50) {
      shortScore += 6;
      shortReasons.push(`ER-10 Mean-Reverting (${er10.toFixed(2)}, +6pts)`);
    }
    if (isPocAlignedShort) {
      shortScore += 6;
      shortReasons.push(`POC Magnet Aligned ($${pocPrice}, +6pts)`);
    }
  }

  const isLong = longScore >= shortScore;
  const candidateSide: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';
  const candidateScore = Math.min(100, isLong ? longScore : shortScore);
  const candidateReasons = isLong ? longReasons : shortReasons;
  const qualifiedSetup = isLong ? longSetupName : shortSetupName;
  const pocMagnetAligned = candidateSide === 'LONG' ? isPocAlignedLong : isPocAlignedShort;

  // Check BTC Guard
  let btcBlocked = false;
  if (candidateSide === 'LONG' && btcGuard?.dumpBlocked) {
    btcBlocked = true;
  } else if (candidateSide === 'SHORT' && btcGuard?.pumpBlocked) {
    btcBlocked = true;
  }

  // Pure Quantitative Autonomous Dynamic Confidence Threshold Engine (58% - 82%)
  const recentSl = dualRoomProtections.hasRecentStopLoss(symbol, 'crypto');
  const dynamicThresholdResult = calculateDynamicThreshold({
    efficiencyRatio: er10,
    pocMagnetAligned,
    kronosProbability: 60,
    bbwExpandingRapidly: bbWidthPct > 5.0,
    isFundingWindow: Boolean(fundingRate && Math.abs(fundingRate) > 0.0005),
    recentStopLoss: recentSl,
    symbol,
    marketType: 'CRYPTO',
  });
  const cryptoDynamicThreshold = dynamicThresholdResult.threshold;

  // Any verified signal scoring >= cryptoDynamicThreshold when Risk Guard is clear MUST execute!
  let isApproved = candidateScore >= cryptoDynamicThreshold && !btcBlocked;

  // Dynamic Stop Loss at 1.5x ATR(14) beyond the sweep wick
  const rDistance = Math.max(1.5 * curAtr, price * 0.005);
  let stopLossPrice = 0;
  let takeProfit1Price = 0;
  let takeProfit2Price = 0;

  if (candidateSide === 'LONG') {
    stopLossPrice = Number((Math.min(currentCandle.low, price) - rDistance).toFixed(6));
    const tp1Target = price + 0.7 * rDistance;
    takeProfit1Price = Number(tp1Target.toFixed(6));
    takeProfit2Price = Number((price + 2.0 * rDistance).toFixed(6));
  } else {
    stopLossPrice = Number((Math.max(currentCandle.high, price) + rDistance).toFixed(6));
    const tp1Target = price - 0.7 * rDistance;
    takeProfit1Price = Number(tp1Target.toFixed(6));
    takeProfit2Price = Number((price - 2.0 * rDistance).toFixed(6));
  }

  let aiVerdict: CryptoSignalVerdict['aiVerdict'] | undefined;

  // Call Multi-AI Consensus / Risk Governance Judge when setup is qualified or scoring >= dynamic threshold
  if (isApproved && enableAiJudge && typeof window !== 'undefined') {
    try {
      const regime =
        Math.abs(zScore) >= 2.0
          ? 'VOLATILE_EXPANSION'
          : curEma50 > curEma200 && curRsi >= 54
          ? 'TRENDING_BULL'
          : curEma50 < curEma200 && curRsi <= 46
          ? 'TRENDING_BEAR'
          : 'MEAN_REVERTING';

      const res = await fetch('/api/ai/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          side: candidateSide === 'LONG' ? 'BUY' : 'SELL',
          timeframe: 'M5',
          price,
          confluenceScore: candidateScore,
          bbWickSweepPct: candidateSide === 'LONG' ? lowerWickRatio : upperWickRatio,
          volumeRatio,
          rsi: curRsi,
          pocPrice,
          vahPrice,
          valPrice,
          zScore,
          regime,
          vwapDistancePct: Math.abs(price - curVwap) / price,
          fundingRate,
          emaTrend: curEma50 >= curEma200 ? 'BULLISH' : 'BEARISH',
          divergence,
          room: 'BINANCE',
          marketType: 'CRYPTO',
          efficiencyRatio: er10,
          pocMagnetAligned,
          btcGuardStatus: (btcGuard as any)?.statusText || (btcBlocked ? 'VETO_DUMP_BLOCKED' : 'NORMAL'),
        }),
      });

      const aiData = await res.json();
      if (aiData.success && aiData.verdict) {
        aiVerdict = {
          decision: aiData.verdict.decision,
          confidence: aiData.verdict.confidence_score,
          reasoning: aiData.verdict.reasoning,
          source: aiData.verdict.source,
          modelUsed: aiData.verdict.modelUsed,
        };

        // When qwen2.5:3b outputs confidence >= cryptoDynamicThreshold (56%), it MUST execute!
        if (aiVerdict.confidence >= cryptoDynamicThreshold) {
          isApproved = !btcBlocked;
        } else if (aiVerdict.decision === 'REJECT' && aiVerdict.confidence < 50) {
          isApproved = false;
        }
      }
    } catch (e) {
      console.warn('[evaluateCryptoSignal] AI Judge call failed, using quantitative fallback');
    }
  }

  const reason = btcBlocked
    ? `🚨 BTC Velocity Guard Triggered: Contrarian ${candidateSide} blocked to prevent liquidation trap`
    : isApproved
    ? `✅ Crypto Qualified [${qualifiedSetup}] (${candidateScore}/100 >= ${cryptoDynamicThreshold}%): ${candidateReasons.slice(0, 3).join(', ')}`
    : `❌ Confluence Insufficient (${candidateScore}/100, ${cryptoDynamicThreshold}% required): ${candidateReasons.slice(0, 2).join(', ')}`;

  return {
    symbol,
    side: candidateSide,
    approved: isApproved,
    score: candidateScore,
    entryPrice: price,
    stopLossPrice,
    takeProfit1Price,
    takeProfit2Price,
    rDistance,
    partialCloseRatio: 0.6,
    moonbagRatio: 0.4,
    reason,
    btcGuardBlocked: btcBlocked,
    indicators: snapshot,
    dynamicThreshold: cryptoDynamicThreshold,
    setupName: qualifiedSetup,
    aiVerdict,
  };
}
