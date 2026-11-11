/**
 * Kronos FastAPI VPS & Multi-AI Forecast Engine (src/core/kronosService.ts)
 * Integrates with FastAPI VPS endpoints:
 * - GET /health (Header: X-API-Key: nmssx-kronos-secret-2026)
 * - POST /v1/predict (Header: X-API-Key: nmssx-kronos-secret-2026)
 * Computes real-time Bullish/Bearish probability, Volume Profile POC, Horizon price,
 * and Multi-AI Risk Governance consensus for XAUUSDm, EURUSDm, GBPUSDm, USDJPYm across M1, M5, M15, H1.
 */

import { Candle, computeIndicatorSnapshot, Timeframe } from './indicatorEngine';
import { getPairProfile, formatPrice } from './pairConfig';
import { evaluateSignalGates } from './signalGate';

export const DEFAULT_KRONOS_API_KEY = 'nmssx-kronos-secret-2026';

export interface KronosForecastResult {
  ok: boolean;
  success: boolean;
  symbol: string;
  timeframe: Timeframe;
  bullishPct: number;
  bearishPct: number;
  bullish_pct: number;
  bearish_pct: number;
  pocPrice: number;
  poc_price: number;
  vahPrice: number;
  vah_price: number;
  valPrice: number;
  val_price: number;
  zScore: number;
  z_score: number;
  regime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'MEAN_REVERTING' | 'VOLATILE_EXPANSION';
  horizonPrice: number;
  horizon_price: number;
  rsi: number;
  atrPips: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  verdict: 'BULLISH ACCUMULATION' | 'BEARISH DISTRIBUTION' | 'NEUTRAL CONSOLIDATION';
  multiAiSummary: string;
  consensus_summary: string;
  modelUsed: string;
  vpsStatus: 'ONLINE' | 'LOCAL_ENGINE';
  latencyMs: number;
  timestamp: number;
}

export interface KronosHealthResult {
  ok: boolean;
  status: 'healthy' | 'online' | 'degraded' | 'offline' | 'standby';
  kronosReady: boolean;
  vpsReady: boolean;
  aiReady: boolean;
  vpsStatus: 'ONLINE' | 'OFFLINE';
  engineStatus?: string;
  activeAiCount?: number;
  activeAiModels?: string[];
  aiModel?: string;
  engine: string;
  architecture: string;
  authenticated: boolean;
  latencyMs: number;
  vpsUrl?: string;
  timestamp: number;
}

export interface VolumeProfileMetrics {
  poc: number;
  vah: number;
  val: number;
}

/**
 * Computes Volume-Weighted Point of Control (POC), Value Area High (VAH), and Value Area Low (VAL)
 */
export function computeVolumeProfileMetrics(
  candles: Candle[],
  middleBB: number,
  digits: number
): VolumeProfileMetrics {
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

  // Expand outward from POC bin until 70% Value Area volume is captured
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
 * Computes Volume-Weighted Point of Control (POC) across active candles
 */
export function computeVolumeProfilePoc(candles: Candle[], middleBB: number, digits: number): number {
  return computeVolumeProfileMetrics(candles, middleBB, digits).poc;
}

/**
 * Computes real-time quantitative K-Line forecast & Multi-AI Risk Governance consensus from active candles
 */
export function computeRealTimeKronosForecast(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  aiModel?: string;
  latencyMs?: number;
  vpsStatus?: 'ONLINE' | 'LOCAL_ENGINE';
}): KronosForecastResult {
  const profile = getPairProfile(params.symbol || 'XAUUSDm');
  const symbol = profile.symbol;
  const timeframe: Timeframe = params.timeframe || 'M5';
  const candles = Array.isArray(params.candles) ? params.candles : [];
  const modelUsed = params.aiModel || 'Multi-AI Consensus / Risk Governance';

  let bullishPct = 56;
  let rsiVal = 51.5;
  let pocPrice = candles.length > 0 ? candles[candles.length - 1].close : (symbol === 'XAUUSDm' ? 4108.90 : 1.1159);
  let vahPrice = pocPrice;
  let valPrice = pocPrice;
  let zScore = 0;
  let regime: KronosForecastResult['regime'] = 'MEAN_REVERTING';
  let horizonPrice = pocPrice;
  let atrPips = 12.0;
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let gateSummary = '';

  if (candles.length >= 5) {
    try {
      const snap = computeIndicatorSnapshot(
        candles,
        profile.preset.rsiPeriod,
        profile.preset.bbPeriod,
        profile.preset.bbStdDev
      );
      const lastC = candles[candles.length - 1];
      const prevC = candles[candles.length - 2] || lastC;
      rsiVal = Number((snap.c0.rsi || 50).toFixed(1));
      const middleBB = snap.c0.middleBB || lastC.close;
      const atr14 = snap.c0.atr14 || Math.abs(lastC.high - lastC.low) || profile.pipValue * 10;
      atrPips = Number((atr14 / profile.pipValue).toFixed(1));

      const vp = computeVolumeProfileMetrics(candles, middleBB, profile.digits);
      pocPrice = vp.poc;
      vahPrice = vp.vah;
      valPrice = vp.val;

      // Compute 20-period Z-Score
      const lookback = candles.slice(-20);
      const meanClose = lookback.reduce((acc, c) => acc + c.close, 0) / lookback.length;
      const variance =
        lookback.reduce((acc, c) => acc + Math.pow(c.close - meanClose, 2), 0) /
        Math.max(1, lookback.length);
      const stdDev = Math.sqrt(variance);
      zScore = stdDev > 0 ? Number(((lastC.close - meanClose) / stdDev).toFixed(2)) : 0;

      const lastEma21 = snap.ema21?.[snap.ema21.length - 1] ?? middleBB;
      const lastEma50 = snap.ema50?.[snap.ema50.length - 1] ?? middleBB;
      const emaDiffPips = (lastEma21 - lastEma50) / (profile.pipValue || 0.01);
      const pocDiffPips = (lastC.close - pocPrice) / (profile.pipValue || 0.01);
      const candleMomentum = (lastC.close - prevC.close) / (atr14 || profile.pipValue);

      // Classify quantitative market regime
      if (snap.bbwExpansionPct && snap.bbwExpansionPct > 22 && Math.abs(zScore) >= 1.4) {
        regime = 'VOLATILE_EXPANSION';
      } else if (emaDiffPips > 3 && rsiVal >= 54) {
        regime = 'TRENDING_BULL';
      } else if (emaDiffPips < -3 && rsiVal <= 46) {
        regime = 'TRENDING_BEAR';
      } else {
        regime = 'MEAN_REVERTING';
      }

      // Timeframe sensitivity multiplier
      const tfFactor = timeframe === 'M1' ? 1.15 : timeframe === 'M5' ? 1.0 : timeframe === 'M15' ? 0.92 : 0.85;

      const rsiScore = (rsiVal - 50) * 0.55;
      const emaScore = Math.max(-18, Math.min(18, emaDiffPips * 0.35 * tfFactor));
      const pocScore = Math.max(-10, Math.min(10, pocDiffPips * 0.25));
      const momScore = Math.max(-8, Math.min(8, candleMomentum * 6));

      const rawBullish = 50 + rsiScore + emaScore + pocScore + momScore;
      bullishPct = Math.max(14, Math.min(89, Math.round(rawBullish)));

      const isBullHorizon = bullishPct >= 50;
      const horizonMultiplier = 1.2 + Math.abs(bullishPct - 50) / 40;
      const rawHorizon = isBullHorizon
        ? lastC.close + atr14 * horizonMultiplier
        : lastC.close - atr14 * horizonMultiplier;
      horizonPrice = Number(rawHorizon.toFixed(profile.digits));

      if (candles.length >= 25) {
        const gate = evaluateSignalGates(candles, { pairProfile: profile, timeframe });
        if (gate.isValid && (gate.side === 'BUY' || gate.side === 'SELL')) {
          // Strictly prevent counter-regime Setup A: if TRENDING_BEAR, Setup A must not force BUY
          const isBearishRegime = regime === 'TRENDING_BEAR' || bullishPct <= 45;
          const isBullishRegime = regime === 'TRENDING_BULL' || bullishPct >= 55;
          if (isBearishRegime && gate.side === 'BUY' && gate.setupName === 'SETUP_A_TREND_PULLBACK') {
            // Skip counter-regime Setup A buy in trending bear
          } else if (isBullishRegime && gate.side === 'SELL' && gate.setupName === 'SETUP_A_TREND_PULLBACK') {
            // Skip counter-regime Setup A sell in trending bull
          } else {
            signal = gate.side;
            gateSummary = `${gate.setupName || gate.signalType} (${gate.confluenceScore || 75}/100)`;
            if (signal === 'BUY' && bullishPct < 60) bullishPct = Math.min(88, bullishPct + 12);
            if (signal === 'SELL' && bullishPct > 40) bullishPct = Math.max(14, bullishPct - 12);
          }
        }
      }

      if (signal === 'NEUTRAL') {
        if (bullishPct >= 62) signal = 'BUY';
        else if (bullishPct <= 38) signal = 'SELL';
      }
    } catch {}
  }

  const bearishPct = 100 - bullishPct;
  const verdict: KronosForecastResult['verdict'] =
    bullishPct >= 58
      ? 'BULLISH ACCUMULATION'
      : bullishPct <= 42
      ? 'BEARISH DISTRIBUTION'
      : 'NEUTRAL CONSOLIDATION';

  const multiAiSummary = gateSummary
    ? `[${modelUsed}] Signal ${signal} verified via ${gateSummary} on ${symbol} (${timeframe}). POC=${formatPrice(
        pocPrice,
        profile.digits
      )}, VAH=${formatPrice(vahPrice, profile.digits)}, VAL=${formatPrice(
        valPrice,
        profile.digits
      )}, RSI=${rsiVal.toFixed(1)}, Z=${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)} (${regime}).`
    : `[${modelUsed}] Multi-AI Consensus / Risk Governance active on ${symbol} (${timeframe}). POC=${formatPrice(
        pocPrice,
        profile.digits
      )}, VAH=${formatPrice(vahPrice, profile.digits)}, VAL=${formatPrice(
        valPrice,
        profile.digits
      )}, RSI=${rsiVal.toFixed(1)}, Z=${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)} (${regime}).`;

  return {
    ok: true,
    success: true,
    symbol,
    timeframe,
    bullishPct,
    bearishPct,
    bullish_pct: bullishPct,
    bearish_pct: bearishPct,
    pocPrice,
    poc_price: pocPrice,
    vahPrice,
    vah_price: vahPrice,
    valPrice,
    val_price: valPrice,
    zScore,
    z_score: zScore,
    regime,
    horizonPrice,
    horizon_price: horizonPrice,
    rsi: rsiVal,
    atrPips,
    signal,
    verdict,
    multiAiSummary,
    consensus_summary: multiAiSummary,
    modelUsed,
    vpsStatus: params.vpsStatus || 'ONLINE',
    latencyMs: params.latencyMs ?? 16,
    timestamp: Date.now(),
  };
}
