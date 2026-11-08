import { NextRequest, NextResponse } from 'next/server';
import {
  readCentralAiConfig,
  formatActiveAiSummaryLabel,
} from '@/core/centralAiConfig';
import {
  computeRealTimeKronosForecast,
  DEFAULT_KRONOS_API_KEY,
} from '@/core/kronosService';
import { ExnessClient } from '@/core/exnessClient';
import { loadVaultCredentials } from '@/core/exnessVault';
import { Candle, Timeframe } from '@/core/indicatorEngine';

export const dynamic = 'force-dynamic';

function isValidFastApiVpsUrl(url: string): boolean {
  if (!url) return false;
  const clean = url.trim().toLowerCase();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) return false;
  if (
    clean.includes('<oracle_vps_ip>') ||
    clean.includes('localhost:3000') ||
    clean.includes('127.0.0.1:3000')
  ) {
    return false;
  }
  return true;
}

function mapTimeframeToBinanceInterval(tf: Timeframe): string {
  switch (tf) {
    case 'M1':
      return '1m';
    case 'M5':
      return '5m';
    case 'M15':
      return '15m';
    case 'H1':
      return '1h';
    default:
      return '5m';
  }
}

async function fetchBinanceFallbackCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
  const interval = mapTimeframeToBinanceInterval(timeframe);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 2500);
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=80`,
      { signal: controller.signal, cache: 'no-store' }
    );
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((k: any) => ({
      timestamp: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  } catch {
    clearTimeout(timeoutId);
    return [];
  }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const centralConfig = await readCentralAiConfig();
    const expectedKey = (centralConfig.kronosApiKey || DEFAULT_KRONOS_API_KEY).trim();

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const symbol: string = (body.symbol || 'XAUUSDm').trim();
    const timeframe: Timeframe = (
      ['M1', 'M5', 'M15', 'H1'].includes(body.timeframe) ? body.timeframe : 'M5'
    ) as Timeframe;
    let candles: Candle[] = Array.isArray(body.candles) ? body.candles : [];

    const isCryptoSymbol =
      symbol.toUpperCase().endsWith('USDT') ||
      symbol.toUpperCase().endsWith('USDC') ||
      symbol.toUpperCase().endsWith('BUSD');

    if (candles.length < 10) {
      if (isCryptoSymbol) {
        candles = await fetchBinanceFallbackCandles(symbol, timeframe);
      } else {
        try {
          const vaultCreds = await loadVaultCredentials();
          const client = new ExnessClient(vaultCreds || undefined);
          candles = await client.getCandles(symbol, timeframe, 80);
        } catch {}
      }
    }

    const aiModelLabel = formatActiveAiSummaryLabel(centralConfig);
    const baseForecast = computeRealTimeKronosForecast({
      symbol,
      timeframe,
      candles,
      aiModel: aiModelLabel,
      latencyMs: Math.max(1, Date.now() - startTime),
      vpsStatus: 'LOCAL_ENGINE',
    });

    const targetVpsUrl = (centralConfig.kronosVpsUrl || 'http://127.0.0.1:8000')
      .trim()
      .replace(/\/+$/, '');

    if (
      centralConfig.engineSwitches?.kronosForecaster !== false &&
      isValidFastApiVpsUrl(targetVpsUrl)
    ) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, 2500);
      try {
        const vpsRes = await fetch(`${targetVpsUrl}/v1/predict`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': expectedKey || DEFAULT_KRONOS_API_KEY,
          },
          body: JSON.stringify({
            symbol,
            timeframe,
            candles: candles.slice(-60),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (vpsRes.ok) {
          const remoteData = await vpsRes.json();
          const remoteBull = Number(
            remoteData.bullish_pct ??
              remoteData.bullishPct ??
              remoteData.probability_bullish ??
              baseForecast.bullishPct
          );
          const validBull =
            !isNaN(remoteBull) && remoteBull >= 0 && remoteBull <= 100
              ? Math.round(remoteBull <= 1 && remoteBull > 0 ? remoteBull * 100 : remoteBull)
              : baseForecast.bullishPct;
          const validBear = 100 - validBull;
          const validPoc =
            Number(remoteData.poc_price ?? remoteData.pocPrice ?? baseForecast.pocPrice) ||
            baseForecast.pocPrice;
          const validVah =
            Number(remoteData.vah_price ?? remoteData.vahPrice ?? baseForecast.vahPrice) ||
            baseForecast.vahPrice;
          const validVal =
            Number(remoteData.val_price ?? remoteData.valPrice ?? baseForecast.valPrice) ||
            baseForecast.valPrice;
          const validZScore =
            typeof (remoteData.z_score ?? remoteData.zScore) === 'number'
              ? Number(remoteData.z_score ?? remoteData.zScore)
              : baseForecast.zScore;
          const validRegime = remoteData.regime || baseForecast.regime;
          const validHorizon =
            Number(
              remoteData.horizon_price ?? remoteData.horizonPrice ?? baseForecast.horizonPrice
            ) || baseForecast.horizonPrice;
          const remoteSignal = String(remoteData.signal || baseForecast.signal).toUpperCase();
          const validSignal: 'BUY' | 'SELL' | 'NEUTRAL' =
            remoteSignal === 'BUY' || remoteSignal === 'SELL'
              ? remoteSignal
              : baseForecast.signal;
          const validVerdict =
            remoteData.verdict ||
            (validBull >= 58
              ? 'BULLISH ACCUMULATION'
              : validBull <= 42
              ? 'BEARISH DISTRIBUTION'
              : 'NEUTRAL CONSOLIDATION');
          const validSummary =
            remoteData.consensus_summary ||
            remoteData.multiAiSummary ||
            remoteData.reasoning ||
            baseForecast.multiAiSummary;

          return NextResponse.json({
            ...baseForecast,
            bullishPct: validBull,
            bearishPct: validBear,
            bullish_pct: validBull,
            bearish_pct: validBear,
            pocPrice: validPoc,
            poc_price: validPoc,
            vahPrice: validVah,
            vah_price: validVah,
            valPrice: validVal,
            val_price: validVal,
            zScore: validZScore,
            z_score: validZScore,
            regime: validRegime,
            horizonPrice: validHorizon,
            horizon_price: validHorizon,
            signal: validSignal,
            verdict: validVerdict,
            multiAiSummary: validSummary,
            consensus_summary: validSummary,
            vpsStatus: 'ONLINE',
            vpsReady: true,
            kronosReady: true,
            latencyMs: Math.max(1, Date.now() - startTime),
          });
        }
      } catch {
        clearTimeout(timeoutId);
      }
    }

    return NextResponse.json({
      ...baseForecast,
      vpsStatus: 'LOCAL_ENGINE',
      vpsReady: false,
      kronosReady: false,
      latencyMs: Math.max(1, Date.now() - startTime),
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: err?.message || 'Prediction error',
      },
      { status: 200 }
    );
  }
}
