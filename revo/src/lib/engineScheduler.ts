/**
 * Unified In-Process Background Trading Engine Scheduler (src/lib/engineScheduler.ts)
 * Runs directly inside the Node.js server process without requiring external worker scripts or daemons.
 * Runs a 3-second heartbeat loop whenever Auto-Trading is active, continuing trades and trailing stops
 * even when the browser tab is refreshed or closed.
 */

import { stateSync } from './stateSync';
import {
  getActiveExnessCredentials,
  loadServerCryptoVault,
  isCryptoVaultConfigured,
  CryptoVaultData,
} from './cryptoVault';
import { ExnessClient } from '@/core/exnessClient';
import { loadVaultCredentials } from '@/core/exnessVault';
import { BinanceFuturesClient } from '@/core/binanceClient';
import { BitgetFuturesService } from '@/services/bitgetService';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL } from '@/core/pairConfig';
import { evaluateSignalGates } from '@/core/signalGate';
import { evaluateMultiAiConsensus } from '@/core/aiJudge';
import {
  readCentralAiConfig,
  getActiveAiProviders,
  formatActiveAiSummaryLabel,
  calculateDynamicThreshold,
  formatAutoGovernanceTelemetry,
} from '@/core/centralAiConfig';
import { computeRealTimeKronosForecast } from '@/core/kronosService';
import { evaluatePositionTrailing, evaluateCryptoPositionTrailing, ManagedPosition } from '@/core/trailingManager';
import {
  evaluatePreTradeRisk,
  idempotencyLocks,
  validateSlippage,
  validateConsecutiveEntryRules,
  DEFAULT_RISK_CONFIG,
  RiskGuardConfig,
  dualRoomProtections,
  calculateForexLotSize,
} from '@/core/riskGuard';
import {
  evaluateCryptoSignal,
  evaluateBtcVelocityGuard,
  getCryptoDynamicThreshold,
} from '@/core/cryptoSignalEngine';
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

  // Crypto Room 2 Automation Controls
  public cryptoAutoTradingEnabled = false; // Strictly defaults to false on startup (Idle)
  private isPanicClosing = false;
  private panicCloseExpiry = 0;

  // Live Synced User Margin & Risk Settings (Synced with UI Store)
  public cryptoMarginUsdt = 25.0;
  public cryptoLeverage = 10;
  public cryptoMarginMode: 'ISOLATED' | 'CROSS' = 'ISOLATED';
  public cryptoMaxConcurrentCoins = 5;

  public setCryptoAutoTrading(enabled: boolean) {
    this.cryptoAutoTradingEnabled = Boolean(enabled);
    console.log(`[EngineScheduler] Crypto auto-trading set to ${this.cryptoAutoTradingEnabled}`);
  }

  public isCryptoAutoTrading(): boolean {
    return this.cryptoAutoTradingEnabled && !this.isPanicClosingActive();
  }

  public setPanicClosingLock(durationMs: number = 5000) {
    this.isPanicClosing = true;
    this.panicCloseExpiry = Date.now() + durationMs;
    this.cryptoAutoTradingEnabled = false;
    console.log(`[EngineScheduler] Panic close execution lock set for ${durationMs}ms`);
  }

  public isPanicClosingActive(): boolean {
    if (this.isPanicClosing) {
      if (Date.now() < this.panicCloseExpiry) {
        return true;
      }
      this.isPanicClosing = false;
    }
    return false;
  }

  public setCryptoTradeSettings(settings: {
    marginUsdt?: number;
    leverage?: number;
    marginMode?: 'ISOLATED' | 'CROSS';
    maxConcurrentCoins?: number;
  }) {
    if (typeof settings.marginUsdt === 'number' && settings.marginUsdt > 0) {
      this.cryptoMarginUsdt = settings.marginUsdt;
    }
    if (typeof settings.leverage === 'number' && settings.leverage > 0) {
      this.cryptoLeverage = settings.leverage;
    }
    if (settings.marginMode) {
      this.cryptoMarginMode = settings.marginMode;
    }
    if (typeof settings.maxConcurrentCoins === 'number' && settings.maxConcurrentCoins > 0) {
      this.cryptoMaxConcurrentCoins = settings.maxConcurrentCoins;
    }
  }

  constructor() {
    try {
      this.init();
    } catch (err) {
      console.warn('[EngineScheduler] Constructor initialization warning:', err);
    }
  }

  public init() {
    try {
      if (this.isInitialized) return;
      this.isInitialized = true;

      // Skip starting interval loop during production build to prevent hanging next build
      if (process.env.NEXT_PHASE === 'phase-production-build') {
        return;
      }

      // Start background loop
      this.startLoop();
      console.log('[EngineScheduler] Unified in-process engine scheduler initialized (3s heartbeat).');
    } catch (err) {
      console.warn('[EngineScheduler] Failed to initialize scheduler loop:', err);
    }
  }

  private startLoop() {
    try {
      if (this.timer) {
        clearInterval(this.timer);
      }

      this.timer = setInterval(async () => {
        try {
          await this.heartbeatTick();
        } catch (err) {
          console.error('[EngineScheduler] Error during heartbeat tick:', err);
        }
        try {
          await this.executeCryptoTick();
        } catch {
          // Keep crypto tick non-blocking
        }
      }, this.tickIntervalMs);

      // Unref timer if available so Node.js process / serverless lambda can exit cleanly
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    } catch (err) {
      console.warn('[EngineScheduler] Error starting heartbeat loop:', err);
    }
  }

  public stopLoop() {
    try {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    } catch {}
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

      const vaultCreds = await loadVaultCredentials();
      if (!vaultCreds) {
        return {
          executed: false,
          timestamp: Date.now(),
          positions: [],
          telemetryCount: state.telemetryLogs.length,
          message: 'No Exness credentials configured in Vault (Engine Idle)',
        };
      }
      const client = new ExnessClient(vaultCreds);

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

      let updatedPositions: ManagedPosition[];
      try {
        updatedPositions = await client.fetchOpenPositions();
      } catch (err: any) {
        return {
          executed: false,
          timestamp: Date.now(),
          positions: state.positions || [],
          telemetryCount: state.telemetryLogs.length,
          message: `Failed to fetch Exness positions: ${err?.message || err}`,
        };
      }
      let accountEquity: number | undefined;
      try {
        const acct = await client.getAccountInfo();
        if (acct?.equity && acct.equity > 0) {
          accountEquity = acct.equity;
        }
      } catch {}

      const riskConfig: RiskGuardConfig = { ...DEFAULT_RISK_CONFIG };

      // Daily Circuit Breaker at -6% daily drawdown
      if (accountEquity && accountEquity > 0) {
        const dailyLossPct = (state.dailyRealizedLossUsd / accountEquity) * 100;
        if (dailyLossPct >= (riskConfig.maxDailyLossPercent || 6.0)) {
          stateSync.addTelemetry('GLOBAL', 'RISK', `[CIRCUIT BREAKER] Daily loss -${dailyLossPct.toFixed(2)}% exceeds -${riskConfig.maxDailyLossPercent || 6.0}% limit on equity $${accountEquity.toFixed(2)}. Halting trading.`);
          await stateSync.updateRuntimeState({
            isAutoTrading: false,
            circuitBreakerTriggered: true,
            positions: updatedPositions,
            lastTickTimestamp: Date.now(),
          });
          return {
            executed: false,
            timestamp: Date.now(),
            positions: updatedPositions,
            telemetryCount: state.telemetryLogs.length,
            message: `Daily Circuit Breaker triggered at -${dailyLossPct.toFixed(1)}% daily drawdown`,
          };
        }
      }

      const centralAi = await readCentralAiConfig();
      const activeAiProviders = getActiveAiProviders(centralAi);
      const activeAiSummaryLabel = formatActiveAiSummaryLabel(centralAi);
      const effectiveThreshold = centralAi.confidenceThreshold || state.aiConfidenceThreshold || 65;

      if (centralAi.engineSwitches?.emergencyKillSwitch) {
        return {
          executed: false,
          timestamp: Date.now(),
          positions: updatedPositions,
          telemetryCount: state.telemetryLogs.length,
          message: 'Admin Emergency Kill-Switch active',
        };
      }

      const log = (symbol: string, category: any, message: string) => {
        stateSync.addTelemetry(symbol, category, message);
      };

      // 1. Process Trailing Stops & Partial Closes for all active positions
      for (const pos of updatedPositions) {
        const profile = getPairProfile(pos.symbol);
        const quote = await client.getSymbolQuote(pos.symbol);
        const curPrice = pos.side === 'BUY' ? quote.bid : quote.ask;

        // Extreme Price Deviation Guard (> 15% jump):
        // Prevents corrupted 0/NaN or mismatched quotes from triggering SL/TP prematurely
        const previousValidPrice = pos.currentPrice || pos.entryPrice;
        if (previousValidPrice > 0) {
          const deviation = Math.abs(curPrice - previousValidPrice) / previousValidPrice;
          if (deviation > 0.15) {
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
            dualRoomProtections.recordStopLossHit(
              pos.symbol,
              'forex',
              trailingAction.reason.includes('TIME_DECAY') ? 'TIME_DECAY' : 'HARD_SL_CLOSE'
            );
            await client.closePosition(pos.id, undefined, pos.symbol);
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
            continue;
          }

          if (trailingAction.type === 'PARTIAL_CLOSE' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
            log(pos.symbol, 'TRAILING', trailingAction.reason);
            dualRoomProtections.recordProfitHit(pos.symbol, 'forex');
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

        // Pre-Trade Risk Check (Forex Room with Freqtrade Protection Guards)
        const riskCheck = evaluatePreTradeRisk(
          symbolSnapshot,
          quote.spreadPips,
          updatedPositions.length,
          state.dailyRealizedLossUsd,
          riskConfig,
          'forex',
          accountEquity
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

        // Multi-AI Consensus / Risk Governance (Gate 3) + Kronos Quant Metrics
        const kronosForecast = computeRealTimeKronosForecast({
          symbol: symbolSnapshot,
          timeframe: 'M5',
          candles,
          aiModel: activeAiSummaryLabel,
        });

        // Kronos Volume Profile Gravity (POC Magnet Alignment)
        const middleBB = signalResult.indicators.c0.middleBB;
        const curPrice = signalResult.signalTriggerPrice;
        const pocPrice = kronosForecast.pocPrice;
        let pocMagnetAligned = false;
        if (signalResult.side === 'BUY') {
          pocMagnetAligned = curPrice < pocPrice && pocPrice <= middleBB;
        } else if (signalResult.side === 'SELL') {
          pocMagnetAligned = curPrice > pocPrice && pocPrice >= middleBB;
        }

        signalResult.technicalSnapshot.marketType = 'FOREX';
        signalResult.technicalSnapshot.pocMagnetAligned = pocMagnetAligned;
        signalResult.technicalSnapshot.zScore = kronosForecast.zScore;

        if (activeAiProviders.length === 0) {
          log(
            symbolSnapshot,
            'AI',
            `[MULTI-AI CONSENSUS] Kronos Quantitative Engine active (POC Magnet ${pocMagnetAligned ? 'Aligned' : 'Off'}). Evaluating ${signalResult.setupName || signalResult.signalType}...`
          );
        } else {
          log(
            symbolSnapshot,
            'AI',
            `[MULTI-AI CONSENSUS] Querying ${activeAiProviders.length} active provider(s) (${activeAiSummaryLabel}, POC Magnet ${pocMagnetAligned ? 'Aligned' : 'Off'})...`
          );
        }
        const recentSlForex = dualRoomProtections.hasRecentStopLoss(symbolSnapshot, 'forex');
        const dynamicThresholdRes = calculateDynamicThreshold({
          efficiencyRatio: signalResult.indicators.efficiencyRatio,
          pocMagnetAligned,
          kronosProbability: kronosForecast.bullishPct || 50,
          bbwExpandingRapidly: signalResult.indicators.bbwExpansionPct > 15,
          recentStopLoss: recentSlForex,
          symbol: symbolSnapshot,
          marketType: 'FOREX',
        });

        const symbolEffectiveThreshold = centralAi.autoAdaptiveThreshold !== false
          ? dynamicThresholdRes.threshold
          : effectiveThreshold;

        const aiVerdict = await evaluateMultiAiConsensus(
          signalResult.technicalSnapshot,
          activeAiProviders,
          symbolEffectiveThreshold,
          {
            pocPrice: kronosForecast.pocPrice,
            vahPrice: kronosForecast.vahPrice,
            valPrice: kronosForecast.valPrice,
            rsi: kronosForecast.rsi,
            zScore: kronosForecast.zScore,
            regime: kronosForecast.regime,
            bullishPct: kronosForecast.bullishPct,
          }
        );

        const autoGovDecision = aiVerdict.executionAllowed ? 'EXECUTE' : 'REJECT';
        log(
          symbolSnapshot,
          'AI',
          `[AUTO-GOVERNANCE] AI Score: ${aiVerdict.confidence_score}% vs Dynamic Threshold: ${dynamicThresholdRes.threshold}% (${dynamicThresholdRes.reasons.join(', ')}) -> ${autoGovDecision}`
        );

        log(
          symbolSnapshot,
          'AI',
          `Multi-AI Verdict: ${aiVerdict.decision} (${aiVerdict.confidence_score}% via ${aiVerdict.source}). ${aiVerdict.reasoning}`
        );

        if (!aiVerdict.executionAllowed || centralAi.engineSwitches?.localEaExecutor === false) {
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

        // Calculate 0.75% Equity Risk Capped Lot Size
        const slDist = Math.abs(signalResult.signalTriggerPrice - signalResult.proposedSlPrice);
        const sizedLot = calculateForexLotSize({
          equity: accountEquity || 1000,
          slDistancePrice: slDist,
          pairProfile: profile,
          maxRiskPct: riskConfig.perTradeRiskPercent || 0.75,
          defaultLot: state.lotSize,
        });

        // Execute Market Order strictly for symbolSnapshot
        log(symbolSnapshot, 'ORDER', `Submitting ${vaultCreds.mode} ${signalResult.side} ${sizedLot} ${symbolSnapshot} (0.75% equity risk cap)...`);

        const orderResult = await client.placeMarketOrder({
          symbol: symbolSnapshot,
          side: signalResult.side,
          volume: sizedLot,
          stopLossPrice: signalResult.proposedSlPrice,
          takeProfitPrice: signalResult.proposedTpPrice,
          comment: `EXN_${vaultCreds.mode}_AI${aiVerdict.confidence_score}`,
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
        if (curPrice <= 0 || isNaN(curPrice)) continue;
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
    } catch (err: any) {
      console.error('[EngineScheduler] Error during heartbeatTick execution (handled safely):', err);
      return {
        executed: false,
        timestamp: Date.now(),
        positions: [],
        telemetryCount: 0,
        message: err?.message || 'Heartbeat tick execution error',
      };
    } finally {
      this.isTickExecuting = false;
    }
  }

  /**
   * Evaluates Crypto Room 2 positions, 2-Stage Trailing Stop, and Auto Execution
   * Automatically routes to Binance or Bitget based on whichever exchange was connected in Vault.
   */
  public async executeCryptoTick(): Promise<{ executed: boolean; exchange: string; positionsCount: number }> {
    try {
      // 1. Strictly abort if panic close execution lock is active
      if (this.isPanicClosingActive()) {
        return { executed: false, exchange: 'LOCKED', positionsCount: 0 };
      }

      // 2. Read runtime state from stateSync
      const state = await stateSync.getRuntimeState();
      // Strictly requires both in-memory scheduler flag and stateSync flag to be true
      const isAutoTradingActive = this.cryptoAutoTradingEnabled && Boolean(state.cryptoIsAutoTrading);

      const cryptoVault = await loadServerCryptoVault();
      if (!cryptoVault || !isCryptoVaultConfigured(cryptoVault)) {
        return { executed: false, exchange: 'NONE', positionsCount: 0 };
      }

      const activeExchange = cryptoVault.activeCryptoExchange || 'BINANCE';
      const userMargin = typeof state.cryptoMarginUsdt === 'number' && state.cryptoMarginUsdt > 0 ? state.cryptoMarginUsdt : this.cryptoMarginUsdt;
      const userLeverage = typeof state.cryptoLeverage === 'number' && state.cryptoLeverage > 0 ? state.cryptoLeverage : this.cryptoLeverage;
      const userMarginMode = state.cryptoMarginMode || this.cryptoMarginMode || 'ISOLATED';
      const maxConcurrentCoins = typeof state.cryptoMaxConcurrentCoins === 'number' && state.cryptoMaxConcurrentCoins > 0 ? state.cryptoMaxConcurrentCoins : this.cryptoMaxConcurrentCoins;
      const userNotional = userMargin * userLeverage;

      if (activeExchange === 'BITGET') {
        const { apiKey, secretKey, passphrase = '', accountType } = cryptoVault.bitget;
        if (!apiKey || !secretKey || !passphrase) {
          return { executed: false, exchange: 'BITGET', positionsCount: 0 };
        }

        const bitget = new BitgetFuturesService(apiKey, secretKey, passphrase, accountType);
        const openPositions = await bitget.getOpenPositions();

        for (const pos of openPositions) {
          // Trailing evaluation: 50% Stage-1 partial close & Stage-2 Trailing Stop
          const isLong = pos.positionAmt > 0;
          const entryPrice = pos.entryPrice;
          const markPrice = pos.markPrice;
          if (entryPrice <= 0 || markPrice <= 0) continue;

          const trailingAction = evaluateCryptoPositionTrailing({
            symbol: pos.symbol,
            side: isLong ? 'BUY' : 'SELL',
            entryPrice,
            currentPrice: markPrice,
            quantity: Math.abs(pos.positionAmt),
            partialClosed: pos.partialClosed,
            currentSl: pos.trailingStopPrice || pos.stopLossPrice,
            atr14: markPrice * 0.012,
            exchange: 'BITGET',
          });

          // Stage 1: 50% partial close at +0.6R / Middle BB if not yet partial closed
          if (trailingAction.action === 'PARTIAL_CLOSE' && !pos.partialClosed) {
            const halfSize = (trailingAction.closeQuantity || (Math.abs(pos.positionAmt) * 0.5)).toFixed(3);
            if (parseFloat(halfSize) > 0) {
              await bitget.partialClosePosition(pos.symbol, pos.positionAmt, parseFloat(halfSize));
              const newSl = trailingAction.newSlPrice || (isLong ? entryPrice * 1.0008 : entryPrice * 0.9992);
              await bitget.updateTrailingStop({
                symbol: pos.symbol,
                holdSide: isLong ? 'long' : 'short',
                triggerPrice: Number(newSl.toFixed(4)),
                planType: 'pos_loss',
              });
            }
          } else if (trailingAction.action === 'MODIFY_SL' && trailingAction.newSlPrice) {
            // Stage 2: Adaptive ATR Trailing Stop
            await bitget.updateTrailingStop({
              symbol: pos.symbol,
              holdSide: isLong ? 'long' : 'short',
              triggerPrice: Number(trailingAction.newSlPrice.toFixed(4)),
              planType: 'pos_loss',
            });
          }

          // Stage 2 Circuit Breaker / Trailing SL Hit
          const slPrice = pos.trailingStopPrice || pos.stopLossPrice;
          const slHit = trailingAction.action === 'HARD_SL_CLOSE' || (slPrice && slPrice > 0 ? (isLong ? markPrice <= slPrice : markPrice >= slPrice) : false);
          if (slHit) {
            await bitget.panicCloseAll([pos]);
            stateSync.addTelemetry(pos.symbol, 'ORDER', `🛑 [BITGET] Trailing SL / Stop Loss hit on ${pos.symbol} at $${markPrice}`);
            continue;
          }
        }

        let positionsCount = openPositions.length;

        // Auto-Scan & Auto-Trade Trigger ONLY when crypto auto-trading is explicitly active and NOT in panic lock
        if (this.cryptoAutoTradingEnabled && isAutoTradingActive && !this.isPanicClosingActive() && positionsCount < maxConcurrentCoins) {
          const scanQueue = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'];
          let btcGuard: { dumpBlocked: boolean; pumpBlocked: boolean; statusText: string } | undefined;
          try {
            const btcKlines = await bitget.getKlines('BTCUSDT', '5m', 60);
            if (btcKlines && btcKlines.length >= 10) {
              btcGuard = evaluateBtcVelocityGuard(btcKlines);
            }
          } catch {}

          for (const sym of scanQueue) {
            if (!this.cryptoAutoTradingEnabled || this.isPanicClosingActive() || positionsCount >= maxConcurrentCoins) break;
            if (openPositions.some((p) => p.symbol === sym)) continue;

            const protectionCheck = dualRoomProtections.checkSymbolProtection(sym, 'crypto');
            if (!protectionCheck.allowed) continue;

            try {
              const klines = await bitget.getKlines(sym, '5m', 60);
              if (!klines || klines.length < 30) continue;

              const verdict = await evaluateCryptoSignal({
                symbol: sym,
                klines,
                fundingRate: 0.0001,
                btcGuard,
                enableAiJudge: true,
              });

              const cryptoDynamicThreshold = verdict.dynamicThreshold || getCryptoDynamicThreshold({
                efficiencyRatio: verdict.indicators?.efficiencyRatio,
                pocMagnetAligned: verdict.indicators?.pocMagnetAligned,
              });

              const effectiveConfidence = verdict.aiVerdict?.confidence || verdict.score;
              const isSignalQualified = (verdict.approved || verdict.score >= cryptoDynamicThreshold || effectiveConfidence >= cryptoDynamicThreshold) &&
                effectiveConfidence >= cryptoDynamicThreshold &&
                !verdict.btcGuardBlocked;

              const erCrypto = verdict.indicators?.efficiencyRatio ?? 0.50;
              const pocLabel = verdict.indicators?.pocMagnetAligned ? 'Kronos POC Aligned' : 'Normal POC';
              const autoGovDecision = isSignalQualified ? 'EXECUTE' : 'REJECT';
              stateSync.addTelemetry(
                sym,
                'AI',
                `[AUTO-GOVERNANCE] AI Score: ${effectiveConfidence}% vs Dynamic Threshold: ${cryptoDynamicThreshold}% (Regime ER=${erCrypto.toFixed(2)}, ${pocLabel}) -> ${autoGovDecision}`
              );

              if (isSignalQualified && this.cryptoAutoTradingEnabled && !this.isPanicClosingActive() && positionsCount < maxConcurrentCoins) {
                const orderSide = verdict.side === 'LONG' ? 'BUY' : 'SELL';
                const notional = userNotional; // Synced with live store setting (e.g. $25 * 10x = $250)
                const qty = (notional / verdict.entryPrice).toFixed(2);

                if (parseFloat(qty) > 0) {
                  await bitget.placeMarketOrder({
                    symbol: sym,
                    side: orderSide,
                    size: qty,
                    price: verdict.entryPrice,
                    margin: userMargin,
                    leverage: userLeverage,
                    marginMode: userMarginMode.toLowerCase() === 'cross' ? 'crossed' : 'isolated',
                    stopLossPrice: verdict.stopLossPrice,
                  });
                  positionsCount++;
                  stateSync.addTelemetry(sym, 'ORDER', `⚡ [BITGET AUTO-TRADE] Dispatched ${orderSide} on ${sym} (${qty} coins | Margin $${userMargin.toFixed(2)} @ ${userLeverage}x | Confidence ${effectiveConfidence}% >= ${cryptoDynamicThreshold}%)`);
                }
              }
            } catch (err: any) {
              console.warn(`[EngineScheduler] Bitget auto-trade scan error on ${sym}:`, err?.message);
            }
          }
        }

        return { executed: true, exchange: 'BITGET', positionsCount };
      } else {
        // Active Exchange: BINANCE
        const { apiKey, secretKey, accountType } = cryptoVault.binance;
        if (!apiKey || !secretKey) {
          return { executed: false, exchange: 'BINANCE', positionsCount: 0 };
        }

        const binance = new BinanceFuturesClient(apiKey, secretKey, accountType === 'DEMO');
        const acct = await binance.getAccountInfo();

        for (const pos of acct.positions) {
          const isLong = pos.positionAmt > 0;
          const entryPrice = pos.entryPrice;
          const markPrice = pos.markPrice;
          if (entryPrice <= 0 || markPrice <= 0) continue;

          const profitDist = isLong ? markPrice - entryPrice : entryPrice - markPrice;
          const minProfitDist = entryPrice * 0.003;

          // Stage 1: 50% partial close
          if (!pos.partialClosed && profitDist >= minProfitDist) {
            const halfQty = Math.abs(pos.positionAmt) * 0.5;
            if (halfQty > 0) {
              await binance.closePosition(pos.symbol, pos.positionAmt, halfQty);
            }
          }
        }

        let positionsCount = acct.positions.length;

        // Auto-Scan & Auto-Trade Trigger ONLY when crypto auto-trading is explicitly active and NOT in panic lock
        if (this.cryptoAutoTradingEnabled && isAutoTradingActive && !this.isPanicClosingActive() && positionsCount < maxConcurrentCoins) {
          const scanQueue = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'];
          let btcGuard: { dumpBlocked: boolean; pumpBlocked: boolean; statusText: string } | undefined;
          try {
            const btcKlines = await binance.getKlines('BTCUSDT', '5m', 60);
            if (btcKlines && btcKlines.length >= 10) {
              btcGuard = evaluateBtcVelocityGuard(btcKlines);
            }
          } catch {}

          for (const sym of scanQueue) {
            if (!this.cryptoAutoTradingEnabled || this.isPanicClosingActive() || positionsCount >= maxConcurrentCoins) break;
            if (acct.positions.some((p) => p.symbol === sym)) continue;

            const protectionCheck = dualRoomProtections.checkSymbolProtection(sym, 'crypto');
            if (!protectionCheck.allowed) continue;

            try {
              const klines = await binance.getKlines(sym, '5m', 60);
              if (!klines || klines.length < 30) continue;

              const verdict = await evaluateCryptoSignal({
                symbol: sym,
                klines,
                fundingRate: 0.0001,
                btcGuard,
                enableAiJudge: true,
              });

              const cryptoDynamicThreshold = verdict.dynamicThreshold || getCryptoDynamicThreshold({
                efficiencyRatio: verdict.indicators?.efficiencyRatio,
                pocMagnetAligned: verdict.indicators?.pocMagnetAligned,
              });

              const effectiveConfidence = verdict.aiVerdict?.confidence || verdict.score;
              const isSignalQualified = (verdict.approved || verdict.score >= cryptoDynamicThreshold || effectiveConfidence >= cryptoDynamicThreshold) &&
                effectiveConfidence >= cryptoDynamicThreshold &&
                !verdict.btcGuardBlocked;

              const erCrypto = verdict.indicators?.efficiencyRatio ?? 0.50;
              const pocLabel = verdict.indicators?.pocMagnetAligned ? 'Kronos POC Aligned' : 'Normal POC';
              const autoGovDecision = isSignalQualified ? 'EXECUTE' : 'REJECT';
              stateSync.addTelemetry(
                sym,
                'AI',
                `[AUTO-GOVERNANCE] AI Score: ${effectiveConfidence}% vs Dynamic Threshold: ${cryptoDynamicThreshold}% (Regime ER=${erCrypto.toFixed(2)}, ${pocLabel}) -> ${autoGovDecision}`
              );

              if (isSignalQualified && this.cryptoAutoTradingEnabled && !this.isPanicClosingActive() && positionsCount < maxConcurrentCoins) {
                const orderSide = verdict.side === 'LONG' ? 'BUY' : 'SELL';
                const notional = userNotional; // Synced with live store setting (e.g. $25 * 10x = $250)
                const qty = (notional / verdict.entryPrice).toFixed(1);

                if (parseFloat(qty) > 0) {
                  await binance.placeOrder({
                    symbol: sym,
                    side: orderSide,
                    type: 'MARKET',
                    quantity: qty,
                    stopPrice: verdict.stopLossPrice ? String(verdict.stopLossPrice) : undefined,
                  });
                  positionsCount++;
                  stateSync.addTelemetry(sym, 'ORDER', `⚡ [BINANCE AUTO-TRADE] Dispatched ${orderSide} on ${sym} (${qty} coins | Margin $${userMargin.toFixed(2)} @ ${userLeverage}x | Confidence ${effectiveConfidence}% >= ${cryptoDynamicThreshold}%)`);
                }
              }
            } catch (err: any) {
              console.warn(`[EngineScheduler] Binance auto-trade scan error on ${sym}:`, err?.message);
            }
          }
        }

        return { executed: true, exchange: 'BINANCE', positionsCount };
      }
    } catch (err: any) {
      console.error('[EngineScheduler] Error in executeCryptoTick:', err);
      return { executed: false, exchange: 'ERROR', positionsCount: 0 };
    }
  }
}

/**
 * Unified Crypto Router helper for Scheduler & Backend Services
 */
export async function getActiveCryptoAdapter(): Promise<{
  exchange: 'BINANCE' | 'BITGET';
  accountType: 'REAL' | 'DEMO';
  binance?: BinanceFuturesClient;
  bitget?: BitgetFuturesService;
  isConfigured: boolean;
}> {
  const vault = await loadServerCryptoVault();
  if (!vault || !isCryptoVaultConfigured(vault)) {
    return { exchange: 'BINANCE', accountType: 'DEMO', isConfigured: false };
  }

  const exchange = vault.activeCryptoExchange || 'BINANCE';
  if (exchange === 'BITGET') {
    const bitget = new BitgetFuturesService(
      vault.bitget.apiKey,
      vault.bitget.secretKey,
      vault.bitget.passphrase || '',
      vault.bitget.accountType
    );
    return { exchange: 'BITGET', accountType: vault.bitget.accountType, bitget, isConfigured: true };
  }

  const binance = new BinanceFuturesClient(
    vault.binance.apiKey,
    vault.binance.secretKey,
    vault.binance.accountType === 'DEMO'
  );
  return { exchange: 'BINANCE', accountType: vault.binance.accountType, binance, isConfigured: true };
}

export async function routeCryptoPanicClose(): Promise<any> {
  const adapter = await getActiveCryptoAdapter();
  if (!adapter.isConfigured) return { success: false, message: 'Vault unconfigured' };

  if (adapter.exchange === 'BITGET' && adapter.bitget) {
    return await adapter.bitget.panicCloseAll();
  }

  if (adapter.exchange === 'BINANCE' && adapter.binance) {
    const acct = await adapter.binance.getAccountInfo();
    const results = [];
    for (const p of acct.positions) {
      const res = await adapter.binance.closePosition(p.symbol, p.positionAmt);
      results.push(res);
    }
    return results;
  }
}

export async function routeCryptoKlines(symbol: string, interval: string = '5m', limit: number = 100): Promise<any[]> {
  const adapter = await getActiveCryptoAdapter();
  if (adapter.exchange === 'BITGET' && adapter.bitget) {
    return await adapter.bitget.getKlines(symbol, interval, limit);
  }
  const binance = adapter.binance || new BinanceFuturesClient('', '', true);
  return await binance.getKlines(symbol, interval, limit);
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
  try {
    engineScheduler.init();
  } catch (err) {
    console.warn('[EngineScheduler] ensureSchedulerStarted error (handled safely):', err);
  }
}
