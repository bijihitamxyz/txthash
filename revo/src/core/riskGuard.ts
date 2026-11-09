/**
 * Institutional Risk Safeguards & Circuit Breakers (src/core/riskGuard.ts)
 * 1. Exness Rollover Blackout Window: 21:00 - 22:15 UTC (04:00 - 05:15 WIB)
 * 2. Max Spread Filter per symbol
 * 3. Idempotency Candle Lock (Anti-Double-Order): ${symbol}_${timeframe}_${C0.timestamp}_${side}
 * 4. AI Latency Slippage Guard: Math.abs(currentPrice - triggerPrice) / pipValue <= maxSlippagePips
 * 5. Daily Realized Loss Circuit Breaker
 */

import { PairProfile, priceDiffToPips, formatPrice } from './pairConfig';
import { ManagedPosition } from './trailingManager';

export interface RiskGuardConfig {
  maxSpreadPips: number;
  maxOpenPositions: number;
  maxDailyLossUsd: number;
  maxDailyLossPercent: number; // -6.0% Daily Circuit Breaker
  perTradeRiskPercent: number; // 0.75% per-trade risk cap
  maxSlippagePips: number;
  rolloverStartUtc: string; // "21:00"
  rolloverEndUtc: string;   // "22:15"
  enableRolloverProtection: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskGuardConfig = {
  maxSpreadPips: 4.0,
  maxOpenPositions: 2, // Cap at max 2 concurrent Forex positions total
  maxDailyLossUsd: 150.0,
  maxDailyLossPercent: 6.0, // Daily Circuit Breaker at -6% daily drawdown
  perTradeRiskPercent: 0.75, // Cap per-trade risk in Forex to 0.75% of account equity
  maxSlippagePips: 3.5,
  rolloverStartUtc: '21:00',
  rolloverEndUtc: '22:15',
  enableRolloverProtection: true,
};

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  circuitBreakerTriggered?: boolean;
}

export type MarketType = 'forex' | 'crypto';

export interface SymbolProtectionState {
  symbol: string;
  market: MarketType;
  lastLossTimestamp: number;
  consecutiveLossCount: number;
  cooldownUntil: number; // 5m (2 candles) post-SL cooldown
  consecutiveLockUntil: number; // 30m lock after 2 consecutive losses in 60m
  lossHistory: Array<{ timestamp: number; reason: string }>;
}

/**
 * Dual-Room Freqtrade Protection Engine (Room 1: Exness Forex | Room 2: Binance Crypto)
 * - CooldownPeriod Guard: Blocks new entries on a symbol for 5 minutes (2 candles) after an SL hit.
 * - StoplossGuard: Locks a symbol for 30 minutes (SYMBOL_COOLDOWN_LOCK) after 2 consecutive losses within 60 minutes.
 * - FundingWindowVolatilityCheck: Tightens slippage/spread by 50% during +/- 5m Binance funding settlement (00:00, 08:00, 16:00 UTC).
 */
export class DualRoomProtectionEngine {
  private protectionMap = new Map<string, SymbolProtectionState>();

  private getKey(symbol: string, market: MarketType): string {
    return `${market.toUpperCase()}_${symbol}`;
  }

  private getOrCreate(symbol: string, market: MarketType): SymbolProtectionState {
    const key = this.getKey(symbol, market);
    let state = this.protectionMap.get(key);
    if (!state) {
      state = {
        symbol,
        market,
        lastLossTimestamp: 0,
        consecutiveLossCount: 0,
        cooldownUntil: 0,
        consecutiveLockUntil: 0,
        lossHistory: [],
      };
      this.protectionMap.set(key, state);
    }
    return state;
  }

  /**
   * Registers a Stop Loss / Hard SL hit for a symbol.
   * Enforces immediate 15-minute symbol cooldown and checks for 2 consecutive losses within 60 minutes.
   */
  public recordStopLossHit(symbol: string, market: MarketType = 'forex', reason: string = 'STOP_LOSS'): void {
    const now = Date.now();
    const state = this.getOrCreate(symbol, market);

    // 1. Immediate 15-Minute Symbol Cooldown Guard
    state.cooldownUntil = now + 15 * 60 * 1000;
    state.lastLossTimestamp = now;

    // Prune losses older than 60 minutes
    const windowStart = now - 60 * 60 * 1000;
    state.lossHistory = state.lossHistory.filter((l) => l.timestamp >= windowStart);
    state.lossHistory.push({ timestamp: now, reason });
    state.consecutiveLossCount += 1;

    // 2. StoplossGuard: 2 consecutive losses within 60 minutes -> 30-minute lock
    if (state.lossHistory.length >= 2 || state.consecutiveLossCount >= 2) {
      state.consecutiveLockUntil = now + 30 * 60 * 1000;
    }
  }

  /**
   * Registers a winning / profit take (TP1/TP2 or partial close) on a symbol.
   * Clears consecutive loss strike counter.
   */
  public recordProfitHit(symbol: string, market: MarketType = 'forex'): void {
    const state = this.getOrCreate(symbol, market);
    state.consecutiveLossCount = 0;
    state.lossHistory = [];
  }

  /**
   * Checks whether new entries are allowed on a symbol based on Freqtrade protection state.
   */
  public checkSymbolProtection(symbol: string, market: MarketType = 'forex'): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const state = this.getOrCreate(symbol, market);

    // Check 1: 30-minute consecutive loss lock (2 losses within 60m)
    if (now < state.consecutiveLockUntil) {
      const remainingMinutes = Math.ceil((state.consecutiveLockUntil - now) / 60000);
      return {
        allowed: false,
        reason: `[STOPLOSS_GUARD] ${symbol} locked for 30m (${remainingMinutes}m remaining) due to 2 consecutive losses within 60m. Other pairs continue normally.`,
      };
    }

    // Check 2: Immediate 15-minute post-SL protection cooldown
    if (now < state.cooldownUntil) {
      const remainingMinutes = Math.ceil((state.cooldownUntil - now) / 60000);
      const remainingSeconds = Math.ceil((state.cooldownUntil - now) / 1000);
      return {
        allowed: false,
        reason: `[COOLDOWN_PERIOD_GUARD] ${symbol} in post-SL protection cooldown (${remainingMinutes}m / ${remainingSeconds}s remaining). Immediate re-entry blocked.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Sniper Recovery Guard: Checks if a symbol experienced a Stop Loss within the specified window (default 2 hours).
   * Triggers +5% stricter threshold requirement in Auto-Adaptive Governance.
   */
  public hasRecentStopLoss(symbol: string, market: MarketType = 'forex', windowMs: number = 2 * 60 * 60 * 1000): boolean {
    const key = this.getKey(symbol, market);
    const state = this.protectionMap.get(key);
    if (!state || !state.lastLossTimestamp) return false;
    return Date.now() - state.lastLossTimestamp <= windowMs;
  }

  /**
   * Crypto Room Session Guard: Checks +/- 5 minutes around Binance funding settlement (00:00, 08:00, 16:00 UTC).
   * Returns tighter tolerance multiplier (0.5 = 50% tighter) during settlement spikes.
   */
  public checkFundingWindowVolatility(nowDate: Date = new Date()): {
    inFundingWindow: boolean;
    toleranceMultiplier: number;
    message: string;
  } {
    const currentMinutes = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
    // Funding hours: 00:00 (0 / 1440), 08:00 (480), 16:00 (960)
    // +/- 5 minutes window
    const inMidnight = currentMinutes >= 1435 || currentMinutes <= 5;
    const inEightAm = currentMinutes >= 475 && currentMinutes <= 485;
    const inFourPm = currentMinutes >= 955 && currentMinutes <= 965;

    const inFundingWindow = inMidnight || inEightAm || inFourPm;

    if (inFundingWindow) {
      return {
        inFundingWindow: true,
        toleranceMultiplier: 0.5, // Tightens spread & slippage limits by 50%
        message: `[FUNDING WINDOW VOLATILITY] Binance funding settlement (+/- 5m around 00:00/08:00/16:00 UTC). Tightened spread & slippage tolerance active.`,
      };
    }

    return {
      inFundingWindow: false,
      toleranceMultiplier: 1.0,
      message: 'Crypto market outside funding settlement spike window.',
    };
  }

  public getStatus(symbol: string, market: MarketType = 'forex'): SymbolProtectionState {
    return { ...this.getOrCreate(symbol, market) };
  }
}

export const dualRoomProtections = new DualRoomProtectionEngine();
export const freqtradeProtections = dualRoomProtections;

export function hasRecentStopLoss(
  symbol: string,
  market: MarketType = 'forex',
  windowMs: number = 2 * 60 * 60 * 1000
): boolean {
  return dualRoomProtections.hasRecentStopLoss(symbol, market, windowMs);
}

class IdempotencyLockManager {
  private executedLocks = new Map<string, number>();
  private lastExecutedCandleTimes = new Map<string, number>();

  /**
   * Generates unique key per symbol, timeframe, trigger candle timestamp and side:
   * ${symbol}_${timeframe}_${C0.timestamp}_${side}
   */
  public generateKey(symbol: string, timeframe: string, candleTimestamp: number, side?: 'BUY' | 'SELL'): string {
    return side ? `${symbol}_${timeframe}_${candleTimestamp}_${side}` : `${symbol}_${timeframe}_${candleTimestamp}`;
  }

  public isLocked(key: string): boolean {
    return this.executedLocks.has(key);
  }

  /**
   * Checks whether a candle has already been locked/executed for a given symbol & timeframe.
   * Enables silent early return to prevent telemetry spam.
   */
  public isCandleLocked(symbol: string, timeframe: string, candleTimestamp: number): boolean {
    const symbolTfKey = `${symbol}_${timeframe}`;
    const lastTime = this.lastExecutedCandleTimes.get(symbolTfKey);
    if (lastTime !== undefined && lastTime === candleTimestamp) {
      return true;
    }
    const baseKey = `${symbol}_${timeframe}_${candleTimestamp}`;
    return this.executedLocks.has(baseKey) ||
           this.executedLocks.has(`${baseKey}_BUY`) ||
           this.executedLocks.has(`${baseKey}_SELL`);
  }

  /**
   * Records an executed candle ONLY after an order is actually placed and added to openPositions.
   */
  public recordExecutedCandle(symbol: string, timeframe: string, candleTimestamp: number, side?: 'BUY' | 'SELL'): void {
    const symbolTfKey = `${symbol}_${timeframe}`;
    this.lastExecutedCandleTimes.set(symbolTfKey, candleTimestamp);
    this.executedLocks.set(`${symbol}_${timeframe}_${candleTimestamp}`, Date.now());
    if (side) {
      this.executedLocks.set(`${symbol}_${timeframe}_${candleTimestamp}_${side}`, Date.now());
    }
  }

  public acquireLock(key: string): boolean {
    if (this.isLocked(key)) {
      return false;
    }
    this.executedLocks.set(key, Date.now());
    return true;
  }

  public releaseLock(key: string): void {
    this.executedLocks.delete(key);
  }

  public pruneOldLocks(maxAgeMs: number = 86400000): void {
    const now = Date.now();
    for (const [key, timestamp] of this.executedLocks.entries()) {
      if (now - timestamp > maxAgeMs) {
        this.executedLocks.delete(key);
      }
    }
  }

  public getAllLocks(): string[] {
    return Array.from(this.executedLocks.keys());
  }
}

export const idempotencyLocks = new IdempotencyLockManager();

/**
 * Checks whether current UTC time is inside the Exness rollover blackout window (21:00 - 22:15 UTC)
 */
export function isInsideRolloverWindow(
  startUtc: string = '21:00',
  endUtc: string = '22:15'
): { inWindow: boolean; message: string } {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const [startH, startM] = startUtc.split(':').map(Number);
  const [endH, endM] = endUtc.split(':').map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  let inWindow = false;
  if (startMinutes <= endMinutes) {
    inWindow = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } else {
    // Crosses UTC midnight
    inWindow = currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  return {
    inWindow,
    message: inWindow
      ? `Active Exness Rollover Blackout Window (${startUtc} - ${endUtc} UTC / 04:00 - 05:15 WIB). Entries & trailing updates paused.`
      : `Market outside rollover window. Execution permitted.`,
  };
}

/**
 * Validates whether live price slippage during AI evaluation exceeds allowed tolerance:
 * Math.abs(currentLivePrice - signalTriggerPrice) / pipValue <= profile.maxSlippagePips.
 * Also discards anomalous price ticks (>50 pips jump in <= 5s) to prevent price source mismatches.
 */
export function validateSlippage(
  side: 'BUY' | 'SELL',
  signalTriggerPrice: number,
  currentLivePrice: number,
  pairProfile: PairProfile,
  maxSlippagePips?: number,
  market: MarketType = 'forex'
): { allowed: boolean; slippagePips: number; message: string; isAnomalousJump?: boolean } {
  let allowedMax = maxSlippagePips ?? pairProfile.preset.maxSlippagePips;

  // Crypto Room: Tighten slippage tolerance by 50% during Binance funding settlement spikes
  if (market === 'crypto') {
    const fundingCheck = dualRoomProtections.checkFundingWindowVolatility();
    if (fundingCheck.inFundingWindow) {
      allowedMax = Number((allowedMax * fundingCheck.toleranceMultiplier).toFixed(2));
    }
  }

  const priceDiff = Math.abs(currentLivePrice - signalTriggerPrice);
  const slippagePips = priceDiffToPips(priceDiff, pairProfile.pipValue);

  // If a quote jumps by > 50 pips in 5 seconds (price source mismatch/anomaly), discard the anomalous tick
  if (slippagePips > 50) {
    return {
      allowed: false,
      slippagePips,
      isAnomalousJump: true,
      message: `[SLIPPAGE GUARD] Anomalous price tick discarded: price jumped by ${slippagePips} pips (> 50 pips) between trigger (${signalTriggerPrice}) and execution (${currentLivePrice}). Aborting order without updating positions.`,
    };
  }

  const exceeds = slippagePips > allowedMax;

  return {
    allowed: !exceeds,
    slippagePips,
    isAnomalousJump: false,
    message: exceeds
      ? `[SLIPPAGE GUARD] Order aborted: Price slipped by ${slippagePips} pips during AI evaluation (Max allowed: ${allowedMax} pips${market === 'crypto' ? ' [Tightened in Funding Window]' : ''})`
      : `Slippage within tolerance (${slippagePips} pips <= ${allowedMax} pips)`,
  };
}

/**
 * Evaluates pre-trade circuit breakers (Freqtrade Cooldown & StoplossLock, Daily Drawdown -6%, Rollover / Funding Session, Max Concurrency 2, Max Spread)
 */
export function evaluatePreTradeRisk(
  symbol: string,
  currentSpreadPips: number,
  currentOpenPositionsCount: number,
  dailyRealizedLossUsd: number,
  config: RiskGuardConfig,
  market: MarketType = 'forex',
  accountEquity?: number
): RiskCheckResult {
  // 0. Dual-Room Freqtrade Protection Engine Check (Cooldown & Consecutive Loss Lock)
  const protectionCheck = dualRoomProtections.checkSymbolProtection(symbol, market);
  if (!protectionCheck.allowed) {
    return {
      allowed: false,
      reason: protectionCheck.reason,
    };
  }

  // 1. Daily Realized Loss Circuit Breaker (-6% Daily Drawdown OR Absolute USD Limit)
  const dailyDrawdownPercent = accountEquity && accountEquity > 0
    ? (dailyRealizedLossUsd / accountEquity) * 100
    : 0;
  const maxLossPercent = config.maxDailyLossPercent || 6.0;

  if (dailyDrawdownPercent >= maxLossPercent) {
    return {
      allowed: false,
      circuitBreakerTriggered: true,
      reason: `CIRCUIT BREAKER TRIGGERED: Daily loss (-${dailyDrawdownPercent.toFixed(2)}% >= -${maxLossPercent.toFixed(1)}% daily limit) reached on account equity ($${accountEquity?.toFixed(2)}). Auto-trading paused.`,
    };
  }

  if (dailyRealizedLossUsd >= config.maxDailyLossUsd) {
    return {
      allowed: false,
      circuitBreakerTriggered: true,
      reason: `CIRCUIT BREAKER TRIGGERED: Daily loss limit ($${dailyRealizedLossUsd.toFixed(2)} >= $${config.maxDailyLossUsd.toFixed(2)}) reached. Auto-trading paused.`,
    };
  }

  // 2. Market-Specific Session Guard
  if (market === 'forex') {
    // Forex Room: Rollover Window Protection (21:00 - 22:15 UTC)
    if (config.enableRolloverProtection) {
      const rollover = isInsideRolloverWindow(config.rolloverStartUtc, config.rolloverEndUtc);
      if (rollover.inWindow) {
        return {
          allowed: false,
          reason: rollover.message,
        };
      }
    }
  } else if (market === 'crypto') {
    // Crypto Room: 24/7 trading, but check Funding Settlement Window (+/- 5m around 00:00, 08:00, 16:00 UTC)
    const fundingCheck = dualRoomProtections.checkFundingWindowVolatility();
    if (fundingCheck.inFundingWindow) {
      const tightenedSpread = config.maxSpreadPips * fundingCheck.toleranceMultiplier;
      if (currentSpreadPips > tightenedSpread) {
        return {
          allowed: false,
          reason: `${fundingCheck.message} Spread ${currentSpreadPips.toFixed(1)} > tightened limit ${tightenedSpread.toFixed(1)} pips for ${symbol}.`,
        };
      }
    }
  }

  // 3. Max Open Positions Concurrency (Capped at 2 concurrent Forex positions total)
  if (currentOpenPositionsCount >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max concurrency limit: ${currentOpenPositionsCount}/${config.maxOpenPositions} positions open.`,
    };
  }

  // 4. Spread Gate
  if (currentSpreadPips > config.maxSpreadPips) {
    return {
      allowed: false,
      reason: `Spread filter: Current spread ${currentSpreadPips.toFixed(1)} pips > max allowed ${config.maxSpreadPips.toFixed(1)} pips for ${symbol}.`,
    };
  }

  return {
    allowed: true,
  };
}

/**
 * Calculates position sizing capped to maximum 0.75% equity risk per position for Forex / Gold
 */
export function calculateForexLotSize(params: {
  equity: number;
  slDistancePrice: number;
  pairProfile: PairProfile;
  maxRiskPct?: number; // default 0.75%
  defaultLot?: number;
}): number {
  const equity = params.equity > 0 ? params.equity : 1000;
  const maxRiskPct = params.maxRiskPct ?? 0.75;
  const maxRiskUsd = equity * (maxRiskPct / 100);
  const slDist = Math.max(0.00001, params.slDistancePrice);

  let lossPerLot = 0;
  if (params.pairProfile.category === 'METAL' || params.pairProfile.symbol === 'XAUUSDm') {
    // 1.0 standard lot = 100 oz. $1.00 move = $100
    lossPerLot = slDist * 100;
  } else if (params.pairProfile.symbol.startsWith('USDJPY')) {
    // USDJPY: JPY conversion to USD
    lossPerLot = (slDist * 100 * 1000) / 155.0;
  } else {
    // Standard Forex Major / Volatile
    lossPerLot = slDist * (params.pairProfile.contractSize || 100000);
  }

  const rawLots = lossPerLot > 0 ? maxRiskUsd / lossPerLot : 0.01;
  const step = params.pairProfile.lotStep || 0.01;
  const minLot = params.pairProfile.minLot || 0.01;
  const stepped = Math.floor(rawLots / step) * step;
  const safeLot = Math.max(minLot, Number(stepped.toFixed(2)));

  if (params.defaultLot !== undefined && params.defaultLot > 0) {
    return Number(Math.min(params.defaultLot, safeLot).toFixed(2));
  }
  return safeLot;
}

/**
 * Consecutive Entry & Anti-Hedging Guard:
 * 1. Anti-Hedging: Prevent opening BUY and SELL simultaneously on the same symbol (e.g. XAUUSDm)
 * 2. 15-second execution cooldown between consecutive entries on the same symbol
 * 3. 15-pip minimum price distance between consecutive entries on the same symbol
 */
export function validateConsecutiveEntryRules(
  symbol: string,
  proposedSide: 'BUY' | 'SELL',
  currentPrice: number,
  openPositions: ManagedPosition[],
  pairProfile: PairProfile
): { allowed: boolean; reason?: string } {
  const symbolPositions = openPositions.filter((p) => p.symbol === symbol);
  if (symbolPositions.length === 0) {
    return { allowed: true };
  }

  // 1. Anti-Hedging Guard: Prevent opening both BUY and SELL simultaneously on same symbol
  const oppositeSide = proposedSide === 'BUY' ? 'SELL' : 'BUY';
  const hasOpposite = symbolPositions.some((p) => p.side === oppositeSide);
  if (hasOpposite) {
    return {
      allowed: false,
      reason: `[ANTI-HEDGING] Rejected ${proposedSide} on ${symbol}: Opposite ${oppositeSide} position is already open. Simultaneous hedging is disabled.`,
    };
  }

  const now = Date.now();
  for (const pos of symbolPositions) {
    // 2. Minimum 15-second execution cooldown between consecutive entries on same symbol
    const timeSinceOpenMs = now - pos.openTime;
    if (timeSinceOpenMs < 15000) {
      const remainingSec = Math.ceil((15000 - timeSinceOpenMs) / 1000);
      return {
        allowed: false,
        reason: `[ENTRY COOLDOWN] Rejected ${proposedSide} on ${symbol}: Execution cooldown active (${remainingSec}s remaining). Minimum 15s required between entries.`,
      };
    }

    // 3. Minimum 15-pip price distance between consecutive entries on same symbol
    const distancePrice = Math.abs(currentPrice - pos.entryPrice);
    const distancePips = priceDiffToPips(distancePrice, pairProfile.pipValue);
    if (distancePips < 15.0) {
      return {
        allowed: false,
        reason: `[15-PIP DISTANCE] Rejected ${proposedSide} on ${symbol}: Price distance to existing #${pos.id.slice(-6)} entry (${formatPrice(pos.entryPrice, pairProfile.digits)}) is ${distancePips.toFixed(1)} pips (< 15 pips required).`,
      };
    }
  }

  return { allowed: true };
}
