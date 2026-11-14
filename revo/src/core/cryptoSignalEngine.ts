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
 * Calculates Rolling Intraday VWAP (last `window` bars, default 48 = 4 hours on 5m):
 * Avoids stale 18h+ cumulative lag while preserving session volume profile.
 */
export function calculateVWAP(klines: BinanceKline[], window: number = 48): number[] {
  const vwap: number[] = [];
  const win = Math.max(1, window);

  for (let i = 0; i < klines.length; i++) {
    const start = Math.max(0, i - win + 1);
    let typicalVolSum = 0;
    let volSum = 0;
    for (let j = start; j <= i; j++) {
      const k = klines[j];
      const typicalPrice = (k.high + k.low + k.close) / 3;
      const vol = k.volume > 0 ? k.volume : 1;
      typicalVolSum += typicalPrice * vol;
      volSum += vol;
    }
    const fallbackTp = (klines[i].high + klines[i].low + klines[i].close) / 3;
    vwap.push(volSum > 0 ? typicalVolSum / volSum : fallbackTp);
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
  const vwapSeries = calculateVWAP(klines, 48);
  const ema21Series = calculateEMA(closes, 21);
  const ema50Series = calculateEMA(closes, 50);
  const ema200Series = calculateEMA(closes, 200);
  const atrSeries = calculateATR(klines, 14);

  const curRsi = rsiSeries[len - 1];
  const curUpperBB = bb.upper[len - 1];
  const curMiddleBB = bb.middle[len - 1];
  const curLowerBB = bb.lower[len - 1];
  const curVwap = vwapSeries[len - 1];
  const curEma21 = ema21Series[len - 1];
  const curEma50 = ema50Series[len - 1];
  const curEma200 = ema200Series[len - 1];
  const curAtr = atrSeries[len - 1] || (price * 0.008);
  const atrPct = price > 0 ? curAtr / price : 0.008;

  // Volume SMA 20
  const volSlice = volumes.slice(Math.max(0, len - 20));
  const volSma20 = volSlice.reduce((a, b) => a + b, 0) / (volSlice.length || 1);
  const volumeRatio = volSma20 > 0 ? currentCandle.volume / volSma20 : 1.0;

  // Candle body & wick proportions
  const candleRange = Math.max(currentCandle.high - currentCandle.low, price * 0.0005);
  const bodySize = Math.abs(currentCandle.close - currentCandle.open);
  const bodyRatio = bodySize / candleRange;
  const bodyTop = Math.max(currentCandle.open, currentCandle.close);
  const bodyBottom = Math.min(currentCandle.open, currentCandle.close);
  const lowerWickRatio = (bodyBottom - currentCandle.low) / candleRange;
  const upperWickRatio = (currentCandle.high - bodyTop) / candleRange;

  // Divergence
  const divergence = detectDivergence(closes, rsiSeries);

  const bbWidthPct = curMiddleBB > 0 ? ((curUpperBB - curLowerBB) / curMiddleBB) * 100 : 2.0;

  // Kaufman ER-10 and Z-Score Calculation
  const er10 = calculateKaufmanEfficiencyRatio(closes, 10);
  const digits = price < 0.01 ? 7 : price < 1 ? 5 : price < 10 ? 4 : price < 100 ? 3 : 2;
  const recent20 = closes.slice(-20);
  const mean20 = recent20.reduce((s, v) => s + v, 0) / Math.max(1, recent20.length);
  const std20 = Math.sqrt(
    recent20.reduce((s, v) => s + Math.pow(v - mean20, 2), 0) / Math.max(1, recent20.length)
  );
  const zScore = std20 > 0 ? Number(((price - mean20) / std20).toFixed(2)) : 0;
  const vahPrice = Number((curMiddleBB + (curUpperBB - curMiddleBB) * 0.7).toFixed(digits));
  const valPrice = Number((curMiddleBB - (curMiddleBB - curLowerBB) * 0.7).toFixed(digits));
  const pocPrice = Number((curVwap || curMiddleBB).toFixed(digits));

  const isPocAlignedLong = price <= pocPrice * 1.003 && pocPrice <= curMiddleBB * 1.005;
  const isPocAlignedShort = price >= pocPrice * 0.997 && pocPrice >= curMiddleBB * 0.995;

  const ema50Prev = ema50Series[Math.max(0, len - 6)] || curEma50;
  const ema50Slope = ema50Prev > 0 ? (curEma50 - ema50Prev) / ema50Prev : 0;
  // Require both EMA alignment AND price not broken far below/above macro structure
  const isMacroBull =
    (len >= 200 ? curEma50 >= curEma200 : curEma50 >= curEma200 || ema50Slope > 0.0005) &&
    price >= curEma200 * 0.992 &&
    curEma21 >= curEma50 * 0.996 &&
    ema50Slope >= -0.0015;
  const isMacroBear =
    (len >= 200 ? curEma50 <= curEma200 : curEma50 <= curEma200 || ema50Slope < -0.0005) &&
    price <= curEma200 * 1.008 &&
    curEma21 <= curEma50 * 1.004 &&
    ema50Slope <= 0.0015;

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

  // --- CRYPTO DUAL-GATE EVALUATION (STRICT SETUP A OR SETUP B + FEE-EDGE FILTER) ---
  // Fee-Edge Volatility Guard: reject dead chop where ATR < 0.18% (taker fees would eat profit)
  const hasViableVolatility = atrPct >= 0.0018;
  // Tighter ATR-adaptive proximity band (max 0.75% or 1.0x ATR) instead of loose 1.5%
  const proxBand = Math.min(0.0075, Math.max(0.0025, atrPct * 1.05));

  // Real candle reversal/momentum confirmation (rejects tiny dojis & falling knives)
  const isBullishConfirm =
    (currentCandle.close > currentCandle.open && bodyRatio >= 0.25 && upperWickRatio < 0.45) ||
    (lowerWickRatio >= 0.34 && currentCandle.close >= currentCandle.open * 0.999);
  const isBearishConfirm =
    (currentCandle.close < currentCandle.open && bodyRatio >= 0.25 && lowerWickRatio < 0.45) ||
    (upperWickRatio >= 0.34 && currentCandle.close <= currentCandle.open * 1.001);

  // LONG SETUP A: Trend Pullback to Dynamic Support (VWAP / EMA50 / POC / VAL)
  const nearVwapLong = Math.abs(price - curVwap) / curVwap <= proxBand;
  const nearEma50Long = Math.abs(price - curEma50) / curEma50 <= proxBand;
  const nearPocLong = Math.abs(price - pocPrice) / pocPrice <= proxBand;
  const nearValLong = Math.abs(price - valPrice) / valPrice <= proxBand;
  const isNearSupportLong = nearVwapLong || nearEma50Long || nearPocLong || nearValLong;
  const isRsiSetupALong = curRsi >= 38 && curRsi <= 58;
  const setupAPassedLong = hasViableVolatility && isNearSupportLong && isMacroBull && isBullishConfirm && isRsiSetupALong;

  // LONG SETUP B: Snap-Back Reversion (MUST have bullish reversal candle & not runaway dump)
  const bbOuterTouchedLong = currentCandle.low <= curLowerBB * 1.0015 || zScore <= -1.45;
  const rsiOversoldLong = curRsi <= 32 || (divergence === 'BULLISH' && curRsi <= 38);
  const notFallingKnifeLong = !(er10 > 0.65 && lowerWickRatio < 0.28);
  const setupBPassedLong = hasViableVolatility && bbOuterTouchedLong && rsiOversoldLong && isBullishConfirm && notFallingKnifeLong;

  // SHORT SETUP A: Trend Pullback to Dynamic Resistance (VWAP / EMA50 / POC / VAH)
  const nearVwapShort = Math.abs(price - curVwap) / curVwap <= proxBand;
  const nearEma50Short = Math.abs(price - curEma50) / curEma50 <= proxBand;
  const nearPocShort = Math.abs(price - pocPrice) / pocPrice <= proxBand;
  const nearVahShort = Math.abs(price - vahPrice) / vahPrice <= proxBand;
  const isNearResistanceShort = nearVwapShort || nearEma50Short || nearPocShort || nearVahShort;
  const isRsiSetupAShort = curRsi >= 42 && curRsi <= 62;
  const setupAPassedShort = hasViableVolatility && isNearResistanceShort && isMacroBear && isBearishConfirm && isRsiSetupAShort;

  // SHORT SETUP B: Snap-Back Reversion (MUST have bearish reversal candle & not runaway pump)
  const bbOuterTouchedShort = currentCandle.high >= curUpperBB * 0.9985 || zScore >= 1.45;
  const rsiOverboughtShort = curRsi >= 68 || (divergence === 'BEARISH' && curRsi >= 62);
  const notRunawayPumpShort = !(er10 > 0.65 && upperWickRatio < 0.28);
  const setupBPassedShort = hasViableVolatility && bbOuterTouchedShort && rsiOverboughtShort && isBearishConfirm && notRunawayPumpShort;

  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];
  let longSetupName: 'SETUP_A_TREND_PULLBACK' | 'SETUP_B_SNAPBACK_REVERSION' | 'NONE' = 'NONE';
  let shortSetupName: 'SETUP_A_TREND_PULLBACK' | 'SETUP_B_SNAPBACK_REVERSION' | 'NONE' = 'NONE';

  if (setupAPassedLong) {
    longSetupName = 'SETUP_A_TREND_PULLBACK';
    longScore += 46;
    const supportLabel = nearVwapLong ? 'VWAP' : nearEma50Long ? 'EMA50' : nearPocLong ? 'POC' : 'VAL';
    longReasons.push(`Setup A Qualified: Trend Pullback to ${supportLabel} (RSI ${curRsi.toFixed(1)} [38-58], +46pts)`);
  } else if (setupBPassedLong) {
    longSetupName = 'SETUP_B_SNAPBACK_REVERSION';
    longScore += 44;
    longReasons.push(`Setup B Qualified: Confirmed Reversal at Lower BB/zScore ${zScore.toFixed(2)} (RSI ${curRsi.toFixed(1)}, +44pts)`);
  } else if (!hasViableVolatility) {
    longReasons.push(`Low Volatility Chop (ATR ${(atrPct * 100).toFixed(2)}% < 0.18%)`);
  }

  if (setupAPassedShort) {
    shortSetupName = 'SETUP_A_TREND_PULLBACK';
    shortScore += 46;
    const resLabel = nearVwapShort ? 'VWAP' : nearEma50Short ? 'EMA50' : nearPocShort ? 'POC' : 'VAH';
    shortReasons.push(`Setup A Qualified: Trend Pullback to ${resLabel} (RSI ${curRsi.toFixed(1)} [42-62], +46pts)`);
  } else if (setupBPassedShort) {
    shortSetupName = 'SETUP_B_SNAPBACK_REVERSION';
    shortScore += 44;
    shortReasons.push(`Setup B Qualified: Confirmed Reversal at Upper BB/zScore ${zScore.toFixed(2)} (RSI ${curRsi.toFixed(1)}, +44pts)`);
  } else if (!hasViableVolatility) {
    shortReasons.push(`Low Volatility Chop (ATR ${(atrPct * 100).toFixed(2)}% < 0.18%)`);
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
    if (isMacroBull && price > curEma200) {
      longScore += 8;
      longReasons.push(`Macro Trend Bullish (+8pts)`);
    } else if (isMacroBull) {
      longScore += 4;
    }
    if (divergence === 'BULLISH') {
      longScore += 8;
      longReasons.push(`Bullish RSI Divergence (+8pts)`);
    }
    if (fundingRate <= 0.0003) {
      longScore += 6;
      longReasons.push(`Funding Rate Safe (+6pts)`);
    }
    if (longSetupName === 'SETUP_A_TREND_PULLBACK' && er10 >= 0.45) {
      longScore += 8;
      longReasons.push(`ER-10 Trend Alignment (${er10.toFixed(2)}, +8pts)`);
    } else if (er10 <= 0.50) {
      longScore += 8;
      longReasons.push(`ER-10 Mean-Reverting (${er10.toFixed(2)}, +8pts)`);
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
    if (isMacroBear && price < curEma200) {
      shortScore += 8;
      shortReasons.push(`Macro Trend Bearish (+8pts)`);
    } else if (isMacroBear) {
      shortScore += 4;
    }
    if (divergence === 'BEARISH') {
      shortScore += 8;
      shortReasons.push(`Bearish RSI Divergence (+8pts)`);
    }
    if (fundingRate >= -0.0003) {
      shortScore += 6;
      shortReasons.push(`Funding Rate Safe (+6pts)`);
    }
    if (shortSetupName === 'SETUP_A_TREND_PULLBACK' && er10 >= 0.45) {
      shortScore += 8;
      shortReasons.push(`ER-10 Trend Alignment (${er10.toFixed(2)}, +8pts)`);
    } else if (er10 <= 0.50) {
      shortScore += 8;
      shortReasons.push(`ER-10 Mean-Reverting (${er10.toFixed(2)}, +8pts)`);
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
  const estKronosProb = Math.min(85, Math.max(45, candidateScore));
  const dynamicThresholdResult = calculateDynamicThreshold({
    efficiencyRatio: er10,
    pocMagnetAligned,
    kronosProbability: estKronosProb,
    bbwExpandingRapidly: bbWidthPct > 5.0,
    isFundingWindow: Boolean(fundingRate && Math.abs(fundingRate) > 0.0005),
    recentStopLoss: recentSl,
    symbol,
    marketType: 'CRYPTO',
  });
  const cryptoDynamicThreshold = dynamicThresholdResult.threshold;

  // Strictly require a qualified Setup A or Setup B + viable volatility + score >= dynamic threshold
  let isApproved =
    hasViableVolatility &&
    qualifiedSetup !== 'NONE' &&
    candidateScore >= cryptoDynamicThreshold &&
    !btcBlocked;

  // Dynamic Stop Loss anchored cleanly with capped wick buffer (never oversized) & positive R:R
  const rawR = Math.max(1.5 * curAtr, price * 0.0055);
  const rDistance = Math.min(rawR, price * 0.025); // Cap max risk at 2.5% price move
  const slTpDigits = Math.max(digits, 4);
  let stopLossPrice = 0;
  let takeProfit1Price = 0;
  let takeProfit2Price = 0;

  if (candidateSide === 'LONG') {
    const wickAnchor = Math.max(currentCandle.low, price - 0.6 * curAtr);
    stopLossPrice = Number((wickAnchor - 1.2 * curAtr).toFixed(slTpDigits));
    const actualRisk = Math.max(rDistance, price - stopLossPrice);
    stopLossPrice = Number((price - actualRisk).toFixed(slTpDigits));
    takeProfit1Price = Number((price + 1.0 * actualRisk).toFixed(slTpDigits));
    takeProfit2Price = Number((price + 2.2 * actualRisk).toFixed(slTpDigits));
  } else {
    const wickAnchor = Math.min(currentCandle.high, price + 0.6 * curAtr);
    stopLossPrice = Number((wickAnchor + 1.2 * curAtr).toFixed(slTpDigits));
    const actualRisk = Math.max(rDistance, stopLossPrice - price);
    stopLossPrice = Number((price + actualRisk).toFixed(slTpDigits));
    takeProfit1Price = Number((price - 1.0 * actualRisk).toFixed(slTpDigits));
    takeProfit2Price = Number((price - 2.2 * actualRisk).toFixed(slTpDigits));
  }

  let aiVerdict: CryptoSignalVerdict['aiVerdict'] | undefined;

  // Call Multi-AI Consensus / Risk Governance Judge when setup is qualified or scoring >= dynamic threshold
  if (isApproved && enableAiJudge) {
    try {
      const regime =
        Math.abs(zScore) >= 2.0
          ? 'VOLATILE_EXPANSION'
          : curEma50 > curEma200 && curRsi >= 54
          ? 'TRENDING_BULL'
          : curEma50 < curEma200 && curRsi <= 46
          ? 'TRENDING_BEAR'
          : 'MEAN_REVERTING';

      const judgePayload = {
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
      };

      if (typeof window !== 'undefined') {
        const res = await fetch('/api/ai/judge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(judgePayload),
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
        }
      } else {
        // Server-side direct Multi-AI Consensus evaluation (for 24/7 EngineScheduler)
        const { readCentralAiConfig, getActiveAiProviders } = await import('@/core/centralAiConfig');
        const { evaluateMultiAiConsensus } = await import('@/core/aiJudge');
        const centralCfg = await readCentralAiConfig();
        if (centralCfg.engineSwitches?.emergencyKillSwitch) {
          isApproved = false;
          aiVerdict = {
            decision: 'REJECT',
            confidence: 0,
            reasoning: 'Blocked by Admin Emergency Kill Switch.',
            source: 'HEURISTIC_QUANT_FALLBACK',
            modelUsed: 'Admin-Kill-Switch',
          };
        } else if (centralCfg.engineSwitches?.multiAiRiskJudge !== false) {
          const activeProviders = getActiveAiProviders(centralCfg);
          const prevIdx = Math.max(0, len - 2);
          const prevCandle = klines[prevIdx] || currentCandle;
          const prevRsi = rsiSeries[prevIdx] ?? curRsi;
          const prevUpperBB = bb.upper[prevIdx] ?? curUpperBB;
          const prevLowerBB = bb.lower[prevIdx] ?? curLowerBB;
          const prevMidBB = bb.middle[prevIdx] ?? curMiddleBB;
          const prevBbw = prevMidBB > 0 ? ((prevUpperBB - prevLowerBB) / prevMidBB) * 100 : bbWidthPct;
          const bbwExpansionPct = prevBbw > 0 ? ((bbWidthPct - prevBbw) / prevBbw) * 100 : 0;
          const bbRange = curUpperBB - curLowerBB;
          const bbPositionPct = bbRange > 0 ? ((price - curLowerBB) / bbRange) * 100 : 50;
          const isSetupA = qualifiedSetup === 'SETUP_A_TREND_PULLBACK';
          const serverSnap: any = {
            symbol,
            timestamp: Date.now(),
            timeframe: 'M5',
            side: candidateSide === 'LONG' ? 'BUY' : 'SELL',
            signalType: isSetupA
              ? (candidateSide === 'LONG' ? 'WITH_TREND_BUY' : 'WITH_TREND_SELL')
              : (candidateSide === 'LONG' ? 'COUNTER_TREND_BUY' : 'COUNTER_TREND_SELL'),
            setupName: qualifiedSetup,
            confluence_score: candidateScore,
            regime: curEma50 >= curEma200 ? 'WITH_TREND' : 'COUNTER_TREND',
            triggerPrice: price,
            rsi: curRsi,
            wick_ratio: candidateSide === 'LONG' ? lowerWickRatio : upperWickRatio,
            bbw_expansion_pct: Number(bbwExpansionPct.toFixed(2)),
            bb_position_pct: Number(bbPositionPct.toFixed(2)),
            divergence_detected: divergence !== 'NONE',
            divergence_type: divergence,
            ema200Distance: Math.abs(price - curEma200),
            atr_pips: curAtr,
            atr_ratio: 1,
            volatility_regime: 'OPTIMAL',
            support_price: valPrice,
            resistance_price: vahPrice,
            distance_to_support_pips: Math.abs(price - valPrice),
            distance_to_resistance_pips: Math.abs(vahPrice - price),
            wick_rejection_strength: (candidateSide === 'LONG' ? lowerWickRatio : upperWickRatio) >= 0.35 ? 'STRONG' : 'MODERATE',
            rsi_slope: Number((curRsi - prevRsi).toFixed(2)),
            c0: {
              open: currentCandle.open,
              high: currentCandle.high,
              low: currentCandle.low,
              close: currentCandle.close,
              rsi: curRsi,
              upperBB: curUpperBB,
              middleBB: curMiddleBB,
              lowerBB: curLowerBB,
              ema200: curEma200,
              lowerWickRatio,
              upperWickRatio,
            },
            c1: {
              open: prevCandle.open,
              high: prevCandle.high,
              low: prevCandle.low,
              close: prevCandle.close,
              rsi: prevRsi,
              upperBB: prevUpperBB,
              lowerBB: prevLowerBB,
            },
            proposedSlPrice: stopLossPrice,
            proposedTpPrice: takeProfit1Price,
            proposedSlPips: rDistance,
            proposedTpPips: Math.abs(takeProfit1Price - price),
            riskRewardRatio: 1.5,
            marketType: 'CRYPTO',
            efficiencyRatio: er10,
            pocMagnetAligned,
            zScore,
            btcGuardStatus: judgePayload.btcGuardStatus,
          };
          const srvVerdict = await evaluateMultiAiConsensus(
            serverSnap,
            activeProviders,
            centralCfg.autoAdaptiveThreshold !== false ? cryptoDynamicThreshold : centralCfg.confidenceThreshold,
            {
              bullishPct: candidateSide === 'LONG' ? 62 : 38,
              pocPrice,
              vahPrice,
              valPrice,
              rsi: curRsi,
              zScore,
              regime,
            }
          );
          aiVerdict = {
            decision: srvVerdict.decision,
            confidence: srvVerdict.confidence_score,
            reasoning: srvVerdict.reasoning,
            source: srvVerdict.source,
            modelUsed: srvVerdict.modelsUsed?.[0] || 'Multi-AI Consensus',
          };
        }
      }

      if (aiVerdict) {
        if (aiVerdict.decision === 'EXECUTE' && aiVerdict.confidence >= cryptoDynamicThreshold) {
          isApproved = !btcBlocked;
        } else if (aiVerdict.decision === 'REJECT' || aiVerdict.confidence < cryptoDynamicThreshold) {
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
