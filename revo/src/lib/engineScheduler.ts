/**
 * Unified In-Process Background Trading Engine Scheduler (src/lib/engineScheduler.ts)
 * Runs directly inside the Node.js server process without requiring external worker scripts or daemons.
 * Runs a 3-second heartbeat loop whenever Auto-Trading is active, continuing trades and trailing stops
 * even when the browser tab is refreshed or closed.
 */

import { stateSync } from './stateSync';
import { getActiveExnessCredentials } from './cryptoVault';
import { ExnessClient } from '@/core/exnessClient';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL } from '@/core/pairConfig';
import { evaluateSignalGates } from '@/core/signalGate';
import { evaluateWithAi, AiConfig, DEFAULT_AI_CONFIG } from '@/core/aiJudge';
import { evaluatePositionTrailing, ManagedPosition } from '@/core/trailingManager';
import {
  evaluatePreTradeRisk,
  idempotencyLocks,
  validateSlippage,
  validateConsecutiveEntryRules,
  DEFAULT_RISK_CONFIG,
  RiskGuardConfig,
} from '@/core/riskGuard';
import { computeIndicatorSnapshot } from '@/core/indicatorEngine';

export interface SchedulerExecutionResult {
  executed: boolean;
  timestamp: number;
  positions: ManagedPosition[];
  telemetryCount: number;
  message?: string;
}

class EngineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isTickExecuting = false;
  private tickIntervalMs = 3000; // 3 seconds per specification
  private isInitialized = false;

  constructor() {
    this.init();
  }

  public init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Start background loop
    this.startLoop();
    console.log('[EngineScheduler] Unified in-process engine scheduler initialized (3s heartbeat).');
  }

  private startLoop() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(async () => {
      try {
        await this.heartbeatTick();
      } catch (err) {
        console.error('[EngineScheduler] Error during heartbeat tick:', err);
      }
    }, this.tickIntervalMs);
  }

  public stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Heartbeat Tick executed every 3 seconds
   */
  public async heartbeatTick(): Promise<SchedulerExecutionResult> {
    if (this.isTickExecuting) {
      return { executed: false, timestamp: Date.now(), positions: [], telemetryCount: 0, message: 'Tick already in progress' };
    }

    this.isTickExecuting = true;

    try {
      const state = await stateSync.getRuntimeState();

      // If auto-trading is paused or inactive, strictly stay idle without scanning or opening new signals
      if (!state.isAutoTrading) {
        return {
          executed: false,
          timestamp: Date.now(),
          positions: state.positions || [],
          telemetryCount: state.telemetryLogs.length,
          message: 'Auto-trading inactive (Engine Idle)',
        };
      }

      const activeCreds = getActiveExnessCredentials(state.credentials);
      const client = new ExnessClient({
        accountId: activeCreds.accountId,
        server: activeCreds.server,
        token: activeCreds.apiKey,
      });

      // Target market symbols to evaluate
      let targetSymbols: string[] = ['XAUUSDm'];
      if (state.targetMarket === 'GOLD') {
        targetSymbols = ['XAUUSDm'];
      } else if (state.targetMarket === 'FOREX') {
        targetSymbols = ['EURUSDm', 'GBPUSDm', 'USDJPYm'];
      } else if (state.targetMarket === 'BOTH') {
        targetSymbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
      } else if (state.scannedSymbols && state.scannedSymbols.length > 0) {
        targetSymbols = state.scannedSymbols;
      }

      const updatedPositions: ManagedPosition[] = [...state.positions];
      const riskConfig: RiskGuardConfig = { ...DEFAULT_RISK_CONFIG };
      const aiConfig: AiConfig = {
        ...DEFAULT_AI_CONFIG,
        baseUrl: state.credentials.aiBaseUrl || DEFAULT_AI_CONFIG.baseUrl,
        apiKey: state.credentials.aiApiKey || '',
        model: state.credentials.aiModel || DEFAULT_AI_CONFIG.model,
        confidenceThreshold: state.aiConfidenceThreshold || 70,
      };

      const log = (symbol: string, category: any, message: string) => {
        stateSync.addTelemetry(symbol, category, message);
      };

      // 1. Process Trailing Stops & Partial Closes for all active positions
      for (const pos of updatedPositions) {
        const profile = getPairProfile(pos.symbol);
        const quote = await client.getSymbolQuote(pos.symbol);
        const curPrice = pos.side === 'BUY' ? quote.bid : quote.ask;

        // Anomalous Tick Guard (>50 pips in 5s) & 2% Price Deviation Guard:
        // Never evaluate SL, TP, Partial Close, or Trailing Stop if quote is anomalous or corrupted
        const previousValidPrice = pos.currentPrice || pos.entryPrice;
        if (previousValidPrice > 0) {
          const pipsDiff = Math.abs(curPrice - previousValidPrice) / profile.pipValue;
          if (pipsDiff > 50) {
            log(pos.symbol, 'RISK', `[AnomalousTickGuard] Scheduler discarding tick for #${pos.id}: quote price ${curPrice} jumps ${pipsDiff.toFixed(1)} pips (> 50 pips) from previous ${previousValidPrice}. Skipping position update.`);
            continue;
          }
          const deviation = Math.abs(curPrice - previousValidPrice) / previousValidPrice;
          if (deviation > 0.02) {
            log(pos.symbol, 'RISK', `[PositionPriceGuard] Scheduler skipping trailing evaluation for #${pos.id}: quote price ${curPrice} differs by ${(deviation * 100).toFixed(1)}% from previous valid price ${previousValidPrice}`);
            continue;
          }
        }
        pos.currentPrice = curPrice;

        const candles = await client.getCandles(pos.symbol, 'M5', 100);

        if (candles.length >= 25) {
          const indicators = computeIndicatorSnapshot(
            candles,
            profile.preset.rsiPeriod,
            profile.preset.bbPeriod,
            profile.preset.bbStdDev
          );

          const trailingAction = evaluatePositionTrailing({
            position: pos,
            currentBid: quote.bid,
            currentAsk: quote.ask,
            middleBB: indicators.c0.middleBB,
            atr14: indicators.c0.atr14,
            bbwExpansionPct: indicators.bbwExpansionPct,
            currentRsi: indicators.c0.rsi,
            pairProfile: profile,
            enablePartialClose: state.enablePartialClose,
          });

          // Hard SL Circuit Breaker handling
          if (trailingAction.type === 'HARD_SL_CLOSE') {
            log(pos.symbol, 'RISK', trailingAction.reason);
            await client.closePosition(pos.id, undefined, pos.symbol);
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
            continue;
          }

          if (trailingAction.type === 'PARTIAL_CLOSE' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            log(pos.symbol, 'TRAILING', trailingAction.reason);
            const closeRes = await client.closePosition(pos.id, trailingAction.closeVolume, pos.symbol);
            if (closeRes.success) {
              pos.volume = trailingAction.remainingVolume || pos.volume;
              pos.partialClosed = true;
              pos.trailingStatus = trailingAction.statusUpdate;
            }
          }

          if (trailingAction.type === 'MODIFY_SL' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            if (trailingAction.newSlPrice) {
              log(pos.symbol, 'TRAILING', trailingAction.reason);
              const modRes = await client.modifyPosition(pos.id, trailingAction.newSlPrice, undefined, pos.symbol);
              if (modRes) {
                pos.currentSl = trailingAction.newSlPrice;
                pos.trailingStatus = trailingAction.statusUpdate;
              }
            }
          }
        }
      }

      // If auto-trading is turned off or circuit breaker tripped, stop here after trailing evaluation
      if (!state.isAutoTrading || state.circuitBreakerTriggered) {
        await stateSync.updateRuntimeState({
          positions: updatedPositions,
          lastTickTimestamp: Date.now(),
        });
        return {
          executed: true,
          timestamp: Date.now(),
          positions: updatedPositions,
          telemetryCount: state.telemetryLogs.length,
        };
      }

      // 2. Scan Target Markets for Unified Hybrid Signals (With-Trend & Counter-Trend)
      for (const symbol of targetSymbols) {
        if (state.targetMarket === 'GOLD' && symbol !== 'XAUUSDm') {
          continue;
        }
        // In Both Simultaneously mode, capture symbolSnapshot scoped to this specific pair
        const symbolSnapshot = symbol;
        const profile = getPairProfile(symbolSnapshot);
        const quote = await client.getSymbolQuote(symbolSnapshot);
        const candles = await client.getCandles(symbolSnapshot, 'M5', 200);

        if (candles.length < 35) {
          continue;
        }

        // Pre-Trade Risk Check
        const riskCheck = evaluatePreTradeRisk(
          symbolSnapshot,
          quote.spreadPips,
          updatedPositions.length,
          state.dailyRealizedLossUsd,
          riskConfig
        );

        if (!riskCheck.allowed) {
          if (riskCheck.circuitBreakerTriggered) {
            log(symbolSnapshot, 'RISK', riskCheck.reason || 'Circuit breaker tripped');
            await stateSync.updateRuntimeState({
              isAutoTrading: false,
              circuitBreakerTriggered: true,
              positions: updatedPositions,
              lastTickTimestamp: Date.now(),
            });
            break;
          }
          continue;
        }

        // SILENT Candle Idempotency Check:
        // Check the candle idempotency lock SILENTLY before evaluating signals or logging.
        const c0Candle = candles[candles.length - 1];
        const c0Timestamp = c0Candle.timestamp;

        if (idempotencyLocks.isCandleLocked(symbolSnapshot, 'M5', c0Timestamp)) {
          continue;
        }

        // Institutional Hybrid Signal Gate
        const signalResult = evaluateSignalGates(candles, {
          pairProfile: profile,
          timeframe: 'M5',
        });

        if (!signalResult.isValid || signalResult.side === 'NONE') {
          if (signalResult.rejectionReason) {
            log(symbolSnapshot, 'SIGNAL', signalResult.rejectionReason);
          }
          continue;
        }

        // Silent Side-Specific Idempotency Guard
        const lockKey = idempotencyLocks.generateKey(symbolSnapshot, 'M5', c0Timestamp, signalResult.side);
        if (idempotencyLocks.isLocked(lockKey)) {
          continue;
        }

        if (!signalResult.technicalSnapshot) {
          continue;
        }

        log(
          symbolSnapshot,
          'SIGNAL',
          `Hybrid Signal: ${signalResult.setupName || signalResult.signalType} qualified with Confluence Score ${signalResult.confluenceScore || 65}/100 at ${signalResult.signalTriggerPrice}`
        );

        // Consecutive Entry & Anti-Hedging Guard:
        // - Prevent opening BUY and SELL simultaneously on same symbol
        // - 15-second execution cooldown
        // - 15-pip price distance
        const consecutiveCheck = validateConsecutiveEntryRules(
          symbolSnapshot,
          signalResult.side,
          signalResult.signalTriggerPrice,
          updatedPositions,
          profile
        );

        if (!consecutiveCheck.allowed) {
          log(symbolSnapshot, 'RISK', consecutiveCheck.reason || 'Consecutive entry barrier');
          continue;
        }

        // AI Confluence Judge (Gate 3) with 6.0s Timeout & Deterministic Quant Fallback
        log(symbolSnapshot, 'AI', `[AI JUDGE] Evaluating ${signalResult.setupName || signalResult.signalType} (${aiConfig.model}) [6.0s timeout]...`);
        const aiVerdict = await evaluateWithAi(signalResult.technicalSnapshot, aiConfig);

        log(
          symbolSnapshot,
          'AI',
          `AI Verdict: ${aiVerdict.decision} (${aiVerdict.confidence_score}% via ${aiVerdict.source}). ${aiVerdict.reasoning}`
        );

        if (!aiVerdict.executionAllowed) {
          continue;
        }

        // Slippage Guard Check: read post-AI quote strictly from getSymbolQuote(symbolSnapshot)
        const postAiQuote = await client.getSymbolQuote(symbolSnapshot);
        const executionPrice = signalResult.side === 'BUY' ? postAiQuote.ask : postAiQuote.bid;
        const slippageCheck = validateSlippage(
          signalResult.side,
          signalResult.signalTriggerPrice,
          executionPrice,
          profile,
          riskConfig.maxSlippagePips
        );

        if (!slippageCheck.allowed) {
          log(symbolSnapshot, 'RISK', slippageCheck.message);
          continue;
        }

        // Execute Market Order strictly for symbolSnapshot
        log(symbolSnapshot, 'ORDER', `Submitting ${activeCreds.mode} ${signalResult.side} ${state.lotSize} ${symbolSnapshot}...`);

        const orderResult = await client.placeMarketOrder({
          symbol: symbolSnapshot,
          side: signalResult.side,
          volume: state.lotSize,
          stopLossPrice: signalResult.proposedSlPrice,
          takeProfitPrice: signalResult.proposedTpPrice,
          comment: `EXN_${activeCreds.mode}_AI${aiVerdict.confidence_score}`,
        });

        if (orderResult.success) {
          // ONLY record executed candle timestamp / lock AFTER order is actually placed and added to openPositions!
          idempotencyLocks.recordExecutedCandle(symbolSnapshot, 'M5', c0Timestamp, signalResult.side);

          log(
            symbolSnapshot,
            'ORDER',
            `Order FILLED: #${orderResult.orderId} ${orderResult.side} ${orderResult.volume} ${orderResult.symbol} @ ${orderResult.fillPrice}`
          );

          updatedPositions.push({
            id: orderResult.orderId,
            symbol: symbolSnapshot,
            side: signalResult.side,
            volume: orderResult.volume,
            initialVolume: orderResult.volume,
            entryPrice: orderResult.fillPrice,
            currentPrice: orderResult.fillPrice,
            currentSl: orderResult.stopLoss,
            currentTp: orderResult.takeProfit,
            highestPrice: orderResult.fillPrice,
            lowestPrice: orderResult.fillPrice,
            openTime: Date.now(),
            partialClosed: false,
            trailingStatus: 'INITIAL',
          });
        } else {
          log(symbolSnapshot, 'ORDER', `Order FAILED: ${orderResult.message}`);
        }
      }

      // Accurately compute unrealizedPnl for all open positions strictly using live Bid for BUY and live Ask for SELL
      for (const p of updatedPositions) {
        const q = await client.getQuote(p.symbol);
        const curPrice = p.side === 'BUY' ? q.bid : q.ask;
        const prevValid = p.currentPrice || p.entryPrice;
        const posProfile = getPairProfile(p.symbol);
        if (prevValid > 0 && Math.abs(curPrice - prevValid) / posProfile.pipValue > 50) {
          // Discard anomalous tick > 50 pips jump
          continue;
        }
        const res = evaluatePositionPnL(p, q);
        p.currentPrice = curPrice;
        p.unrealizedPnl = res.pnlUsd;
      }

      await stateSync.updateRuntimeState({
        positions: updatedPositions,
        lastTickTimestamp: Date.now(),
      });

      return {
        executed: true,
        timestamp: Date.now(),
        positions: updatedPositions,
        telemetryCount: state.telemetryLogs.length,
      };
    } finally {
      this.isTickExecuting = false;
    }
  }
}

// Global in-process singleton
const globalForScheduler = globalThis as unknown as {
  __exnessEngineScheduler?: EngineScheduler;
};

export const engineScheduler = globalForScheduler.__exnessEngineScheduler ?? new EngineScheduler();
if (process.env.NODE_ENV !== 'production') {
  globalForScheduler.__exnessEngineScheduler = engineScheduler;
}

export function ensureSchedulerStarted() {
  engineScheduler.init();
}
