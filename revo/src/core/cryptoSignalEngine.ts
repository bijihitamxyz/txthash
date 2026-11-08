import { BinanceKline } from './binanceClient';

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
  aiVerdict?: {
    decision: 'EXECUTE' | 'REJECT';
    confidence: number;
    reasoning: string;
    source: string;
    modelUsed: string;
  };
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
 * Checks BTC Dump / Pump velocity over the last 5 minutes.
 * If BTC dumped > 1.2% in 5m, returns dumpBlocked = true (blocks longs on Altcoins/L2).
 */
export function evaluateBtcVelocityGuard(btcKlines: BinanceKline[]): {
  velocityPct: number;
  dumpBlocked: boolean;
  pumpBlocked: boolean;
  statusText: string;
} {
  if (!btcKlines || btcKlines.length < 2) {
    return { velocityPct: 0, dumpBlocked: false, pumpBlocked: false, statusText: 'BTC Guard: Normal' };
  }

  // Last 5-minute candle velocity
  const lastCandle = btcKlines[btcKlines.length - 1];
  const velocityPct = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;

  // Sharp dump threshold: -1.2% in 5m
  const dumpBlocked = velocityPct <= -1.2;
  // Sharp pump threshold: +1.2% in 5m
  const pumpBlocked = velocityPct >= 1.2;

  let statusText = `BTC 5m Velocity: ${velocityPct >= 0 ? '+' : ''}${velocityPct.toFixed(2)}% (Normal)`;
  if (dumpBlocked) {
    statusText = `🚨 BTC DUMP GUARD ACTIVE (${velocityPct.toFixed(2)}% in 5m): All Altcoin LONGS blocked to prevent liquidation trap`;
  } else if (pumpBlocked) {
    statusText = `⚠️ BTC PUMP GUARD ACTIVE (+${velocityPct.toFixed(2)}% in 5m): Altcoin SHORTS restricted`;
  }

  return { velocityPct, dumpBlocked, pumpBlocked, statusText };
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
  };

  // SCORING ENGINE: LONG vs SHORT
  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];

  // 1. BB(20, 2.2) Liquidity Wick Sweep & Vol Spike (+30 pts)
  // LONG: Low swept below lower BB or touched lower band, with rejection wick >= 45% & Vol Spike > 1.5x
  if (currentCandle.low <= curLowerBB * 1.002 && lowerWickRatio >= 0.45) {
    longScore += 20;
    longReasons.push(`Lower BB Wick Sweep (${(lowerWickRatio * 100).toFixed(0)}% wick)`);
    if (volumeRatio >= 1.5) {
      longScore += 10;
      longReasons.push(`Vol Spike (${volumeRatio.toFixed(1)}x SMA20)`);
    }
  } else if (currentCandle.low <= curLowerBB && lowerWickRatio >= 0.35) {
    longScore += 15;
    longReasons.push(`Moderate Lower Wick Rejection`);
  }

  // SHORT: High swept above upper BB, rejection wick >= 45% & Vol Spike > 1.5x
  if (currentCandle.high >= curUpperBB * 0.998 && upperWickRatio >= 0.45) {
    shortScore += 20;
    shortReasons.push(`Upper BB Wick Sweep (${(upperWickRatio * 100).toFixed(0)}% wick)`);
    if (volumeRatio >= 1.5) {
      shortScore += 10;
      shortReasons.push(`Vol Spike (${volumeRatio.toFixed(1)}x SMA20)`);
    }
  } else if (currentCandle.high >= curUpperBB && upperWickRatio >= 0.35) {
    shortScore += 15;
    shortReasons.push(`Moderate Upper Wick Rejection`);
  }

  // 2. Intraday VWAP Fair Value Magnet (+20 pts)
  // For LONG: Price below VWAP by at least 0.5% (room to snap back up to fair value)
  if (price < curVwap) {
    const vwapRoomPct = ((curVwap - price) / price) * 100;
    if (vwapRoomPct >= 0.4) {
      longScore += 20;
      longReasons.push(`VWAP Fair Value Room (+${vwapRoomPct.toFixed(2)}%)`);
    } else {
      longScore += 10;
    }
  }

  // For SHORT: Price above VWAP by at least 0.5%
  if (price > curVwap) {
    const vwapRoomPct = ((price - curVwap) / price) * 100;
    if (vwapRoomPct >= 0.4) {
      shortScore += 20;
      shortReasons.push(`VWAP Fair Value Room (-${vwapRoomPct.toFixed(2)}%)`);
    } else {
      shortScore += 10;
    }
  }

  // 3. EMA 50 & EMA 200 Trend alignment (+15 pts)
  if (curEma50 >= curEma200 || price > curEma200) {
    longScore += 15;
    longReasons.push('Macro Trend Bullish (EMA 50/200)');
  } else if (price < curEma50 && curEma50 < curEma200) {
    shortScore += 15;
    shortReasons.push('Macro Trend Bearish (EMA 50/200)');
  }

  // 4. Extreme RSI(14) & Divergence (+25 pts)
  if (curRsi < 26) {
    longScore += 20;
    longReasons.push(`Extreme RSI Oversold (${curRsi.toFixed(1)})`);
  } else if (curRsi < 35) {
    longScore += 10;
  }
  if (divergence === 'BULLISH') {
    longScore += 10;
    longReasons.push('Bullish RSI Divergence');
  }

  if (curRsi > 74) {
    shortScore += 20;
    shortReasons.push(`Extreme RSI Overbought (${curRsi.toFixed(1)})`);
  } else if (curRsi > 65) {
    shortScore += 10;
  }
  if (divergence === 'BEARISH') {
    shortScore += 10;
    shortReasons.push('Bearish RSI Divergence');
  }

  // 5. Funding Rate Filter (+10 pts)
  // Avoid longing into heavy positive funding (> 0.03% per 8h)
  if (fundingRate <= 0.0003) {
    longScore += 10;
    longReasons.push('Funding Rate Safe for Longs');
  }
  // Avoid shorting into heavy negative funding (< -0.03%)
  if (fundingRate >= -0.0003) {
    shortScore += 10;
    shortReasons.push('Funding Rate Safe for Shorts');
  }

  const isLong = longScore >= shortScore;
  const candidateSide: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';
  const candidateScore = isLong ? longScore : shortScore;
  const candidateReasons = isLong ? longReasons : shortReasons;

  // Check BTC Guard
  let btcBlocked = false;
  if (candidateSide === 'LONG' && btcGuard?.dumpBlocked) {
    btcBlocked = true;
  } else if (candidateSide === 'SHORT' && btcGuard?.pumpBlocked) {
    btcBlocked = true;
  }

  // Minimum threshold: Score >= 80/100
  let isApproved = candidateScore >= 80 && !btcBlocked;

  // Calculate Asymmetric Winrate Lock Parameters
  // Dynamic Stop Loss at 1.5x ATR(14) beyond the sweep wick
  const rDistance = Math.max(1.5 * curAtr, price * 0.005);
  let stopLossPrice = 0;
  let takeProfit1Price = 0;
  let takeProfit2Price = 0;

  if (candidateSide === 'LONG') {
    stopLossPrice = Number((Math.min(currentCandle.low, price) - rDistance).toFixed(6));
    // TP1 is at +0.7R (or VWAP / Mid-BB if closer)
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

  // If score >= 80 and not blocked by BTC, call Multi-AI Consensus / Risk Governance Judge with Kronos quant metrics
  if (isApproved && enableAiJudge && typeof window !== 'undefined') {
    try {
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

        if (aiVerdict.decision === 'REJECT' && aiVerdict.confidence < 60) {
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
    ? `✅ 5-Indicator Confluence (${candidateScore}/100): ${candidateReasons.slice(0, 3).join(', ')}`
    : `❌ Confluence Insufficient (${candidateScore}/100, 80 required): ${candidateReasons.slice(0, 2).join(', ')}`;

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
    aiVerdict,
  };
}
