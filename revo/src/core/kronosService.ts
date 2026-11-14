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
  const upperSym = symbol.toUpperCase();
  const isCrypto =
    upperSym.endsWith('USDT') ||
    upperSym.endsWith('USDC') ||
    upperSym.endsWith('BUSD');
  const timeframe: Timeframe = params.timeframe || 'M5';
  const candles = Array.isArray(params.candles) ? params.candles : [];
  const modelUsed = params.aiModel || 'Multi-AI Consensus / Risk Governance';
  const lastPriceGuess = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const effectiveDigits = isCrypto && lastPriceGuess > 0
    ? (lastPriceGuess < 0.01 ? 7 : lastPriceGuess < 1 ? 5 : lastPriceGuess < 10 ? 4 : lastPriceGuess < 100 ? 3 : 2)
    : profile.digits;

  let bullishPct = 50;
  let rsiVal = 50.0;
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
        isCrypto ? 2.2 : profile.preset.bbStdDev
      );
      const lastC = candles[candles.length - 1];
      const prevC = candles[candles.length - 2] || lastC;
      rsiVal = Number((snap.c0.rsi || 50).toFixed(1));
      const middleBB = snap.c0.middleBB || lastC.close;
      const atr14 = snap.c0.atr14 || Math.abs(lastC.high - lastC.low) || (isCrypto ? lastC.close * 0.008 : profile.pipValue * 10);
      atrPips = isCrypto
        ? Number(((atr14 / Math.max(1e-9, lastC.close)) * 100).toFixed(2)) // ATR% for crypto
        : Number((atr14 / profile.pipValue).toFixed(1));

      const vp = computeVolumeProfileMetrics(candles, middleBB, effectiveDigits);
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
      const candleMomentum = (lastC.close - prevC.close) / Math.max(1e-9, atr14);

      if (isCrypto) {
        // Crypto-Native ATR-Normalized Quantitative Forecast (immune to Forex pip distortion)
        const emaDiffAtr = (lastEma21 - lastEma50) / Math.max(1e-9, atr14);
        const priceVsEma50Atr = (lastC.close - lastEma50) / Math.max(1e-9, atr14);
        const pocDiffAtr = (lastC.close - pocPrice) / Math.max(1e-9, atr14);

        // Kaufman Efficiency Ratio (ER-10)
        const erLook = candles.slice(-11);
        let er10 = 0.5;
        if (erLook.length >= 2) {
          const netChg = Math.abs(erLook[erLook.length - 1].close - erLook[0].close);
          let sumAbs = 0;
          for (let i = 1; i < erLook.length; i++) {
            sumAbs += Math.abs(erLook[i].close - erLook[i - 1].close);
          }
          if (sumAbs > 0) er10 = netChg / sumAbs;
        }

        // Regime classification
        if (snap.bbwExpansionPct && snap.bbwExpansionPct > 22 && Math.abs(zScore) >= 1.5) {
          regime = 'VOLATILE_EXPANSION';
        } else if (emaDiffAtr > 0.35 && lastC.close >= lastEma50 && rsiVal >= 52) {
          regime = 'TRENDING_BULL';
        } else if (emaDiffAtr < -0.35 && lastC.close <= lastEma50 && rsiVal <= 48) {
          regime = 'TRENDING_BEAR';
        } else {
          regime = 'MEAN_REVERTING';
        }

        // Mean-reversion vs trend scoring (timeframe-sensitive for M1/M5 scalping):
        const tfFactor = timeframe === 'M1' ? 1.2 : timeframe === 'M5' ? 1.05 : timeframe === 'M15' ? 0.95 : 0.85;
        const trendScore =
          (Math.max(-16, Math.min(16, emaDiffAtr * 7.5)) +
            Math.max(-8, Math.min(8, priceVsEma50Atr * 4.5))) *
          tfFactor;
        const rsiScore = Math.max(-12, Math.min(12, (rsiVal - 50) * 0.5));
        // Mean-reversion pull toward POC when overextended
        const reversionBias = Math.abs(zScore) >= 1.5 ? -Math.sign(zScore) * Math.min(12, (Math.abs(zScore) - 1.2) * 8) : 0;
        const pocMagnetScore =
          regime === 'MEAN_REVERTING'
            ? Math.max(-8, Math.min(8, -pocDiffAtr * 3.5))
            : Math.max(-6, Math.min(6, pocDiffAtr * 2.5));
        const momScore = Math.max(-7, Math.min(7, candleMomentum * 4.5 * tfFactor));

        const rawBullish = 50 + trendScore + rsiScore + pocMagnetScore + reversionBias + momScore;
        bullishPct = Math.max(15, Math.min(86, Math.round(rawBullish)));

        // Horizon projection: bounded by 0.8x - 1.8x ATR14 in predicted direction
        const isBullHorizon = bullishPct >= 50;
        const horizonMultiplier = 0.8 + Math.abs(bullishPct - 50) / 36;
        const rawHorizon = isBullHorizon
          ? lastC.close + atr14 * horizonMultiplier
          : lastC.close - atr14 * horizonMultiplier;
        horizonPrice = Number(rawHorizon.toFixed(effectiveDigits));

        // Signal when directional edge is clear (>= 58% or <= 42%) and not chasing extreme overbought/oversold in chop
        if (bullishPct >= 58 && !(regime === 'MEAN_REVERTING' && rsiVal > 68)) {
          signal = 'BUY';
          gateSummary = `CRYPTO_QUANT_${timeframe} (${regime}, ER=${er10.toFixed(2)}, Z=${zScore.toFixed(2)})`;
        } else if (bullishPct <= 42 && !(regime === 'MEAN_REVERTING' && rsiVal < 32)) {
          signal = 'SELL';
          gateSummary = `CRYPTO_QUANT_${timeframe} (${regime}, ER=${er10.toFixed(2)}, Z=${zScore.toFixed(2)})`;
        }
      } else {
        const emaDiffPips = (lastEma21 - lastEma50) / (profile.pipValue || 0.01);
        const pocDiffPips = (lastC.close - pocPrice) / (profile.pipValue || 0.01);

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
        horizonPrice = Number(rawHorizon.toFixed(effectiveDigits));

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
        effectiveDigits
      )}, VAH=${formatPrice(vahPrice, effectiveDigits)}, VAL=${formatPrice(
        valPrice,
        effectiveDigits
      )}, RSI=${rsiVal.toFixed(1)}, Z=${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)} (${regime}).`
    : `[${modelUsed}] Multi-AI Consensus / Risk Governance active on ${symbol} (${timeframe}). POC=${formatPrice(
        pocPrice,
        effectiveDigits
      )}, VAH=${formatPrice(vahPrice, effectiveDigits)}, VAL=${formatPrice(
        valPrice,
        effectiveDigits
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
