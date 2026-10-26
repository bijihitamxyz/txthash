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
  maxSlippagePips: number;
  rolloverStartUtc: string; // "21:00"
  rolloverEndUtc: string;   // "22:15"
  enableRolloverProtection: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskGuardConfig = {
  maxSpreadPips: 4.0,
  maxOpenPositions: 4,
  maxDailyLossUsd: 150.0,
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
  maxSlippagePips?: number
): { allowed: boolean; slippagePips: number; message: string; isAnomalousJump?: boolean } {
  const allowedMax = maxSlippagePips ?? pairProfile.preset.maxSlippagePips;
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
      ? `[SLIPPAGE GUARD] Order aborted: Price slipped by ${slippagePips} pips during AI evaluation (Max allowed: ${allowedMax} pips)`
      : `Slippage within tolerance (${slippagePips} pips <= ${allowedMax} pips)`,
  };
}

/**
 * Evaluates pre-trade circuit breakers (Daily Drawdown, Rollover, Max Concurrency, Max Spread)
 */
export function evaluatePreTradeRisk(
  symbol: string,
  currentSpreadPips: number,
  currentOpenPositionsCount: number,
  dailyRealizedLossUsd: number,
  config: RiskGuardConfig
): RiskCheckResult {
  // 1. Daily Realized Loss Circuit Breaker
  if (dailyRealizedLossUsd >= config.maxDailyLossUsd) {
    return {
      allowed: false,
      circuitBreakerTriggered: true,
      reason: `CIRCUIT BREAKER TRIGGERED: Daily loss limit ($${dailyRealizedLossUsd.toFixed(2)} >= $${config.maxDailyLossUsd.toFixed(2)}) reached. Auto-trading paused.`,
    };
  }

  // 2. Rollover Window Protection
  if (config.enableRolloverProtection) {
    const rollover = isInsideRolloverWindow(config.rolloverStartUtc, config.rolloverEndUtc);
    if (rollover.inWindow) {
      return {
        allowed: false,
        reason: rollover.message,
      };
    }
  }

  // 3. Max Open Positions Concurrency
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
