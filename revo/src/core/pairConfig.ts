/**
 * Built-In Institutional Market DNA Profiles (src/core/pairConfig.ts)
 * Calibrated specifically for Exness accounts (Suffix 'm' for Mini/Standard accounts)
 * Fully automatic institutional presets loaded without manual tuning.
 */

export interface StrategyPreset {
  rsiPeriod: number;
  rsiTrendOversold: number;
  rsiTrendOverbought: number;
  rsiCounterExtremeLow: number;
  rsiCounterExtremeHigh: number;
  bbPeriod: number;
  bbStdDev: number;
  maxBbwExpansionPct: number;
  atrSlMultiplier: number;
  atrTrailDistanceMultiplier: number;
  atrTrailStepMultiplier: number;
  maxSpreadPips: number;
  maxSlippagePips: number;
}

export interface PairProfile {
  symbol: string;
  name: string;
  category: 'METAL' | 'FOREX_MAJOR' | 'FOREX_VOLATILE' | 'YEN_CROSS';
  digits: number;
  pipValue: number; // Price difference corresponding to 1 pip
  minLot: number;
  lotStep: number;
  contractSize: number;
  preset: StrategyPreset;
}

export const EXNESS_PAIR_PROFILES: Record<string, PairProfile> = {
  XAUUSDm: {
    symbol: 'XAUUSDm',
    name: 'Gold vs US Dollar',
    category: 'METAL',
    digits: 2,
    pipValue: 0.10, // $1.00 move = 10 pips, 0.10 move = 1 pip
    minLot: 0.01,
    lotStep: 0.01,
    contractSize: 100, // 100 oz per 1.0 standard lot
    preset: {
      rsiPeriod: 14,
      rsiTrendOversold: 35,
      rsiTrendOverbought: 65,
      rsiCounterExtremeLow: 25,
      rsiCounterExtremeHigh: 75,
      bbPeriod: 20,
      bbStdDev: 2.0,
      maxBbwExpansionPct: 48,
      atrSlMultiplier: 1.5,
      atrTrailDistanceMultiplier: 1.2,
      atrTrailStepMultiplier: 0.25,
      maxSpreadPips: 4.0,
      maxSlippagePips: 5.0,
    },
  },
  EURUSDm: {
    symbol: 'EURUSDm',
    name: 'Euro vs US Dollar',
    category: 'FOREX_MAJOR',
    digits: 5,
    pipValue: 0.0001, // 4th decimal place = 1 pip
    minLot: 0.01,
    lotStep: 0.01,
    contractSize: 100000,
    preset: {
      rsiPeriod: 14,
      rsiTrendOversold: 35,
      rsiTrendOverbought: 65,
      rsiCounterExtremeLow: 25,
      rsiCounterExtremeHigh: 75,
      bbPeriod: 20,
      bbStdDev: 2.0,
      maxBbwExpansionPct: 35,
      atrSlMultiplier: 1.2,
      atrTrailDistanceMultiplier: 1.0,
      atrTrailStepMultiplier: 0.25,
      maxSpreadPips: 2.2,
      maxSlippagePips: 2.0,
    },
  },
  GBPUSDm: {
    symbol: 'GBPUSDm',
    name: 'Great Britain Pound vs US Dollar',
    category: 'FOREX_VOLATILE',
    digits: 5,
    pipValue: 0.0001,
    minLot: 0.01,
    lotStep: 0.01,
    contractSize: 100000,
    preset: {
      rsiPeriod: 14,
      rsiTrendOversold: 35,
      rsiTrendOverbought: 65,
      rsiCounterExtremeLow: 25,
      rsiCounterExtremeHigh: 75,
      bbPeriod: 20,
      bbStdDev: 2.0,
      maxBbwExpansionPct: 35,
      atrSlMultiplier: 1.2,
      atrTrailDistanceMultiplier: 1.0,
      atrTrailStepMultiplier: 0.25,
      maxSpreadPips: 2.2,
      maxSlippagePips: 2.0,
    },
  },
  USDJPYm: {
    symbol: 'USDJPYm',
    name: 'US Dollar vs Japanese Yen',
    category: 'YEN_CROSS',
    digits: 3,
    pipValue: 0.01, // 2nd decimal place = 1 pip
    minLot: 0.01,
    lotStep: 0.01,
    contractSize: 100000,
    preset: {
      rsiPeriod: 14,
      rsiTrendOversold: 35,
      rsiTrendOverbought: 65,
      rsiCounterExtremeLow: 25,
      rsiCounterExtremeHigh: 75,
      bbPeriod: 20,
      bbStdDev: 2.0,
      maxBbwExpansionPct: 35,
      atrSlMultiplier: 1.2,
      atrTrailDistanceMultiplier: 1.0,
      atrTrailStepMultiplier: 0.25,
      maxSpreadPips: 2.0,
      maxSlippagePips: 2.0,
    },
  },
};

export const PAIR_PROFILES = EXNESS_PAIR_PROFILES;
export const SUPPORTED_SYMBOLS = Object.keys(EXNESS_PAIR_PROFILES);

/**
 * Retrieves the pair profile for any symbol, with graceful fallback to matching profile or dynamic profile
 */
export function getPairProfile(symbol?: string): PairProfile {
  if (!symbol) return EXNESS_PAIR_PROFILES.XAUUSDm;
  const raw = symbol.trim();
  if (EXNESS_PAIR_PROFILES[raw]) return EXNESS_PAIR_PROFILES[raw];

  const upper = raw.toUpperCase();
  for (const key of Object.keys(EXNESS_PAIR_PROFILES)) {
    if (key.toUpperCase() === upper) {
      return EXNESS_PAIR_PROFILES[key];
    }
    const keyWithoutM = key.replace(/m$/i, '').toUpperCase();
    const upperWithoutM = upper.replace(/m$/i, '');
    if (keyWithoutM === upperWithoutM) {
      return EXNESS_PAIR_PROFILES[key];
    }
  }

  // If not a predefined forex profile, return a dynamic profile preserving the exact symbol name
  const isJpy = upper.includes('JPY');
  const isUsdt = upper.endsWith('USDT') || upper.endsWith('BUSD') || upper.endsWith('USDC');
  const isMajorCrypto = upper.includes('BTC') || upper.includes('ETH') || upper.includes('BNB') || upper.includes('SOL');
  const isMicroMeme =
    upper.includes('PEPE') ||
    upper.includes('BONK') ||
    upper.includes('SHIB') ||
    upper.includes('FLOKI') ||
    upper.startsWith('1000');
  const isCrypto = isUsdt || isMajorCrypto;
  const cryptoDigits = isMicroMeme
    ? 7
    : upper.includes('BTC') || upper.includes('ETH') || upper.includes('BNB') || upper.includes('SOL')
    ? 2
    : 4;
  const cryptoPip = upper.includes('BTC')
    ? 10.0
    : upper.includes('ETH')
    ? 1.0
    : isMicroMeme
    ? 0.000001
    : 0.01;
  return {
    symbol: raw,
    name: raw,
    category: isCrypto ? 'FOREX_VOLATILE' : 'FOREX_MAJOR',
    digits: isCrypto ? cryptoDigits : isJpy ? 3 : 5,
    pipValue: isCrypto ? cryptoPip : isJpy ? 0.01 : 0.0001,
    minLot: 0.01,
    lotStep: 0.01,
    contractSize: isCrypto ? 1 : 100000,
    preset: EXNESS_PAIR_PROFILES.EURUSDm.preset,
  };
}

/**
 * Converts pips to price difference
 */
export function pipsToPriceDiff(pips: number, pipValue: number): number {
  return Number((pips * pipValue).toFixed(8));
}

/**
 * Converts price difference to pips
 */
export function priceDiffToPips(diff: number, pipValue: number): number {
  if (pipValue <= 0) return 0;
  return Number((Math.abs(diff) / pipValue).toFixed(1));
}

/**
 * Formats price strictly to instrument decimal digits
 */
export function formatPrice(price: number, digits: number): string {
  return price.toFixed(digits);
}

/**
 * Rounds order volume according to lot step (0.01) and minLot (0.01)
 */
export function roundLotVolume(volume: number, minLot: number = 0.01, lotStep: number = 0.01): number {
  const steps = Math.floor(volume / lotStep);
  const rounded = Number((steps * lotStep).toFixed(2));
  return Math.max(minLot, rounded);
}

export interface PositionPnLResult {
  curPrice: number;
  priceDiff: number;
  pnlPips: number;
  pnlUsd: number;
  pnlPercent: number;
}

/**
 * Calculates unrealized or realized PnL in USD and percentage return
 */
export function calculatePnL(
  side: 'BUY' | 'SELL',
  entryPrice: number,
  currentPrice: number,
  volume: number,
  profile: PairProfile
): { pnlPips: number; pnlUsd: number; pnlPercent: number } {
  const priceDiff = side === 'BUY' ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
  const pnlPips = Number((priceDiff / profile.pipValue).toFixed(1));
  const pnlPercent = entryPrice > 0 ? Number(((priceDiff / entryPrice) * 100).toFixed(2)) : 0;

  // Strict volume guard: on 0.01 lot, 1 pip ($0.10 move on Gold) = $0.01 profit ($1.00 per $1.00 move)
  const validVolume = typeof volume === 'number' && !isNaN(volume) && volume > 0 ? volume : 0.01;

  let pnlUsd = 0;
  if (profile.category === 'METAL' || profile.symbol === 'XAUUSDm') {
    // For Gold (XAUUSD): 1 Lot = 100 oz. $1 price change = $100 profit per 1.0 lot.
    // On 0.01 lot: $1 price change = $1.00 ($0.10 price change = 1 pip = $0.10 * 100 * 0.01 = $0.10)
    pnlUsd = priceDiff * 100 * validVolume;
  } else if (profile.symbol.startsWith('USDJPY')) {
    // USDJPY: pipSize = 0.01, converts JPY PnL to USD accurately ((priceDiff * 100 * lots * 1000) / currentUsdjpyPrice)
    const currentUsdjpyPrice = currentPrice > 0 ? currentPrice : 156.840;
    pnlUsd = (priceDiff * 100 * validVolume * 1000) / currentUsdjpyPrice;
  } else {
    // For EURUSD / GBPUSD: priceDiff * contractSize * volume
    pnlUsd = priceDiff * profile.contractSize * validVolume;
  }

  return {
    pnlPips,
    pnlUsd: Number(pnlUsd.toFixed(2)),
    pnlPercent,
  };
}

/**
 * Evaluates position PnL strictly using the live Bid for BUY and live Ask for SELL
 * Single source of truth for PnL calculation across entire application.
 */
export function evaluatePositionPnL(
  pos: { side: 'BUY' | 'SELL'; entryPrice: number; volume: number; symbol: string },
  quote: { bid: number; ask: number }
): PositionPnLResult {
  const profile = getPairProfile(pos.symbol);
  // Strict rule: BUY positions close at live Bid, SELL positions close at live Ask
  const curPrice = pos.side === 'BUY' ? quote.bid : quote.ask;
  const res = calculatePnL(pos.side, pos.entryPrice, curPrice, pos.volume, profile);
  const priceDiff = pos.side === 'BUY' ? (curPrice - pos.entryPrice) : (pos.entryPrice - curPrice);

  return {
    curPrice,
    priceDiff,
    pnlPips: res.pnlPips,
    pnlUsd: res.pnlUsd,
    pnlPercent: res.pnlPercent,
  };
}
