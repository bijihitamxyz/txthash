import { NextRequest, NextResponse } from 'next/server';
import { ExnessClient, realTimeFeed } from '@/core/exnessClient';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL } from '@/core/pairConfig';
import { evaluateSignalGates } from '@/core/signalGate';
import { evaluateWithAi, AiConfig, DEFAULT_AI_CONFIG } from '@/core/aiJudge';
import { evaluatePositionTrailing, ManagedPosition } from '@/core/trailingManager';
import {
  evaluatePreTradeRisk,
  idempotencyLocks,
  validateSlippage,
  validateConsecutiveEntryRules,
  RiskGuardConfig,
  DEFAULT_RISK_CONFIG,
} from '@/core/riskGuard';
import { stateSync, TargetMarket } from '@/lib/stateSync';
import { ensureSchedulerStarted } from '@/lib/engineScheduler';
import { getActiveExnessCredentials } from '@/lib/cryptoVault';
import { readCentralAiConfig } from '@/app/api/ai/judge/route';

export const dynamic = 'force-dynamic';

function sanitizeRuntimeState(state: any) {
  if (!state || !state.credentials) return state;
  return {
    ...state,
    credentials: {
      accountMode: state.credentials.accountMode,
      demoAccountId: state.credentials.demoAccountId,
      demoServer: state.credentials.demoServer,
      demoApiKey: state.credentials.demoApiKey ? '••••••••' : '',
      demoInitialBalance: state.credentials.demoInitialBalance ?? 100.0,
      realAccountId: state.credentials.realAccountId,
      realServer: state.credentials.realServer,
      realApiKey: state.credentials.realApiKey ? '••••••••' : '',
      realInitialBalance: state.credentials.realInitialBalance ?? 100.0,
      aiProvider: state.credentials.aiProvider,
      aiBaseUrl: state.credentials.aiBaseUrl,
      aiModel: state.credentials.aiModel,
      aiApiKey: state.credentials.aiApiKey ? '••••••••' : '',
      updatedAt: state.credentials.updatedAt,
    },
  };
}

export interface EngineTickRequestPayload {
  credentials?: {
    accountId?: string;
    server?: string;
    token?: string;
    bridgeUrl?: string;
  };
  symbols?: string[];
  targetMarket?: TargetMarket;
  timeframe?: string;
  orderVolume?: number;
  enablePartialClose?: boolean;
  riskConfig?: Partial<RiskGuardConfig>;
  aiConfig?: Partial<AiConfig>;
  activePositions?: ManagedPosition[];
  dailyRealizedLossUsd?: number;
  syntheticSignal?: {
    symbol: string;
    side: 'BUY' | 'SELL';
  };
}

export interface EngineTickTelemetry {
  timestamp: number;
  symbol: string;
  category: 'RISK' | 'SIGNAL' | 'AI' | 'ORDER' | 'TRAILING' | 'INFO';
  message: string;
}

export async function GET() {
  try {
    ensureSchedulerStarted();
    const runtimeState = await stateSync.getRuntimeState();
    return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(runtimeState) }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, success: false, error: String(err?.message || err) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  const telemetryLogs: EngineTickTelemetry[] = [];
  try {
    // Ensure the background engine scheduler is running inside the Node.js server process
    ensureSchedulerStarted();

    const log = (symbol: string, category: EngineTickTelemetry['category'], message: string) => {
      telemetryLogs.push({ timestamp: Date.now(), symbol, category, message });
      stateSync.addTelemetry(symbol, category, message);
    };
    let body: EngineTickRequestPayload = {};
    try {
      body = await req.json();
    } catch {}

    const runtimeState = await stateSync.getRuntimeState();
    const activeCreds = getActiveExnessCredentials(runtimeState.credentials);

    const credentials = body.credentials || {
      accountId: activeCreds.accountId,
      server: activeCreds.server,
      token: activeCreds.apiKey,
      password: activeCreds.password || activeCreds.apiKey,
      initialBalance: activeCreds.initialBalance,
    };

    const effectiveMarket = body.targetMarket || runtimeState.targetMarket || 'GOLD';
    let symbols: string[];
    if (effectiveMarket === 'GOLD') {
      symbols = ['XAUUSDm'];
    } else if (effectiveMarket === 'FOREX') {
      symbols = ['EURUSDm', 'GBPUSDm', 'USDJPYm'];
    } else {
      symbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
    }

    // Immediately synchronize client configuration changes to runtime state
    if (body.targetMarket || body.orderVolume !== undefined || body.symbols) {
      await stateSync.updateRuntimeState({
        targetMarket: effectiveMarket,
        scannedSymbols: symbols,
        ...(body.orderVolume !== undefined ? { lotSize: body.orderVolume } : {}),
      });
    }

    const timeframe = body.timeframe || 'M5';
    const orderVolume = body.orderVolume ?? runtimeState.lotSize ?? 0.01;
    const enablePartialClose = body.enablePartialClose ?? runtimeState.enablePartialClose ?? true;

    const mergedRisk: RiskGuardConfig = { ...DEFAULT_RISK_CONFIG, ...body.riskConfig };
    const centralAi = await readCentralAiConfig();
    const mergedAi: AiConfig = {
      ...DEFAULT_AI_CONFIG,
      baseUrl: body.aiConfig?.baseUrl || centralAi.baseUrl || runtimeState.credentials.aiBaseUrl || DEFAULT_AI_CONFIG.baseUrl,
      apiKey: body.aiConfig?.apiKey || centralAi.apiKey || runtimeState.credentials.aiApiKey || '',
      model: body.aiConfig?.model || centralAi.model || runtimeState.credentials.aiModel || DEFAULT_AI_CONFIG.model,
      confidenceThreshold: runtimeState.aiConfidenceThreshold || 70,
      ...body.aiConfig,
    };

    const client = new ExnessClient(credentials);

    let validSymbols = symbols.filter((s) => SUPPORTED_SYMBOLS.includes(s));
    if (validSymbols.length === 0) {
      validSymbols = ['XAUUSDm'];
    }

    // When auto-trading is stopped, HALT scanning but NEVER purge active open positions!
    // Existing positions remain active and managed by trailing stop/TP/SL.
    if (!runtimeState.isAutoTrading) {
      const retainedPositions = Array.isArray(body.activePositions) ? body.activePositions : (runtimeState.positions || []);
      return NextResponse.json({
        ok: true,
        success: true,
        circuitBreakerTriggered: false,
        telemetry: telemetryLogs,
        positions: retainedPositions,
        orders: [],
      }, { status: 200 });
    }

    // Client-side Zustand store is the single source of truth for active positions in Demo mode.
    // If client passes activePositions (including empty array []), respect it and NEVER resurrect stale server positions!
    const currentPositions: ManagedPosition[] = Array.isArray(body.activePositions)
      ? body.activePositions
      : (runtimeState.positions || []);

    const updatedPositions: ManagedPosition[] = [...currentPositions];
    const newOrdersPlaced: any[] = [];
    const closedTrades: { id: string; symbol: string; pnl: number; reason: string }[] = [];
    const dailyLoss = body.dailyRealizedLossUsd ?? runtimeState.dailyRealizedLossUsd ?? 0;

    for (const symbol of validSymbols) {
      // Enforce targetMarket strictly: if targetMarket === 'GOLD', restricted to XAUUSDm only
      if (effectiveMarket === 'GOLD' && symbol !== 'XAUUSDm') {
        continue;
      }
      // In Both Simultaneously mode, capture symbolSnapshot scoped to this specific pair
      const symbolSnapshot = symbol;
      const profile = getPairProfile(symbolSnapshot);

      // Diagnostic synthetic signal injection
      if (body.syntheticSignal && body.syntheticSignal.symbol === symbolSnapshot) {
        realTimeFeed.injectSyntheticSignal(symbolSnapshot, body.syntheticSignal.side);
        log(symbolSnapshot, 'INFO', `Synthetic ${body.syntheticSignal.side} snap-back candle injected for diagnosis`);
      }

      // Read pre-AI quote strictly scoped to symbolSnapshot
      const quote = await client.getSymbolQuote(symbolSnapshot);
      const candles = await client.getCandles(symbolSnapshot, timeframe, 200);

      if (candles.length < 30) {
        log(symbolSnapshot, 'INFO', `Building candle history: ${candles.length}/30 required`);
        continue;
      }

      const { computeIndicatorSnapshot } = await import('@/core/indicatorEngine');
      const indicators = computeIndicatorSnapshot(
        candles,
        profile.preset.rsiPeriod,
        profile.preset.bbPeriod,
        profile.preset.bbStdDev
      );
      const middleBB = indicators.c0.middleBB;
      const currentAtr = indicators.c0.atr14;

      // 1. Process Automatic 2-Phase Trailing Stop & Partial Close for existing positions
      const symbolPositions = updatedPositions.filter((p) => p.symbol === symbolSnapshot);
      for (const pos of symbolPositions) {
        const isBuy = pos.side === 'BUY';
        const curPrice = isBuy ? quote.bid : quote.ask;

        // Anomalous Tick Guard (>50 pips in 5s) & 2% Price Deviation Guard:
        // Never evaluate SL, TP, Partial Close, or Trailing Stop if quote is anomalous or corrupted
        const previousValidPrice = pos.currentPrice || pos.entryPrice;
        if (previousValidPrice > 0) {
          const pipsDiff = Math.abs(curPrice - previousValidPrice) / profile.pipValue;
          if (pipsDiff > 50) {
            log(symbolSnapshot, 'RISK', `[AnomalousTickGuard] Discarding tick for #${pos.id}: quote price ${curPrice} jumps ${pipsDiff.toFixed(1)} pips (> 50 pips) from previous ${previousValidPrice}. Skipping position update.`);
            continue;
          }
          const deviation = Math.abs(curPrice - previousValidPrice) / previousValidPrice;
          if (deviation > 0.02) {
            log(symbolSnapshot, 'RISK', `[PositionPriceGuard] Skipping SL/TP/Trailing evaluation for #${pos.id}: quote price ${curPrice} differs by ${(deviation * 100).toFixed(1)}% from previous valid price ${previousValidPrice}`);
            continue;
          }
        }
        pos.currentPrice = curPrice;

        // 1a. Take Profit hit verification
        if (pos.currentTp > 0 && (isBuy ? curPrice >= pos.currentTp : curPrice <= pos.currentTp)) {
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'ORDER', `[TAKE PROFIT HIT] #${pos.id} ${pos.side} @ ${curPrice} (+$${realizedPnl.toFixed(2)})`);
          await client.closePosition(pos.id, undefined, symbol);
          closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'TP' });
          const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
          if (posIdx !== -1) {
            updatedPositions.splice(posIdx, 1);
          }
          continue;
        }

        // 1b. Stop Loss / Trailing Stop hit verification
        if (pos.currentSl > 0 && (isBuy ? curPrice <= pos.currentSl : curPrice >= pos.currentSl)) {
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'ORDER', `[STOP LOSS / TRAILING STOP HIT] #${pos.id} ${pos.side} @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`);
          await client.closePosition(pos.id, undefined, symbol);
          closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'SL' });
          const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
          if (posIdx !== -1) {
            updatedPositions.splice(posIdx, 1);
          }
          continue;
        }

        const trailingAction = evaluatePositionTrailing({
          position: pos,
          currentBid: quote.bid,
          currentAsk: quote.ask,
          middleBB,
          atr14: currentAtr,
          bbwExpansionPct: indicators.bbwExpansionPct,
          currentRsi: indicators.c0.rsi,
          pairProfile: profile,
          enablePartialClose,
        });

        // Hard SL Circuit Breaker handling
        if (trailingAction.type === 'HARD_SL_CLOSE') {
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'RISK', trailingAction.reason);
          await client.closePosition(pos.id, undefined, symbol);
          closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'HARD_SL' });
          const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
          if (posIdx !== -1) {
            updatedPositions.splice(posIdx, 1);
          }
          continue;
        }

        if (trailingAction.type === 'PARTIAL_CLOSE' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
          log(symbol, 'TRAILING', trailingAction.reason);
          const closeRes = await client.closePosition(pos.id, trailingAction.closeVolume, symbol);
          if (closeRes.success) {
            const closedVol = trailingAction.closeVolume || (pos.volume * 0.5);
            const partialPnl = Number(evaluatePositionPnL({ ...pos, volume: closedVol }, quote).pnlUsd.toFixed(2));
            closedTrades.push({ id: pos.id, symbol, pnl: partialPnl, reason: 'PARTIAL_CLOSE' });
            pos.volume = trailingAction.remainingVolume || pos.volume;
            pos.partialClosed = true;
            pos.trailingStatus = trailingAction.statusUpdate;
          }
        }

        if (trailingAction.type === 'MODIFY_SL' || trailingAction.type === 'PARTIAL_AND_MODIFY_SL') {
          if (trailingAction.newSlPrice) {
            log(symbol, 'TRAILING', trailingAction.reason);
            const modRes = await client.modifyPosition(pos.id, trailingAction.newSlPrice, undefined, symbol);
            if (modRes) {
              pos.currentSl = trailingAction.newSlPrice;
              pos.trailingStatus = trailingAction.statusUpdate;
            }
          }
        }
      }

      // 2. Pre-Trade Institutional Circuit Breakers
      const riskCheck = evaluatePreTradeRisk(
        symbol,
        quote.spreadPips,
        updatedPositions.length,
        dailyLoss,
        mergedRisk
      );

      if (!riskCheck.allowed) {
        if (riskCheck.circuitBreakerTriggered) {
          log(symbol, 'RISK', riskCheck.reason || 'Circuit breaker tripped');
          await stateSync.updateRuntimeState({
            isAutoTrading: false,
            circuitBreakerTriggered: true,
            positions: updatedPositions,
            lastTickTimestamp: Date.now(),
          });

          return NextResponse.json({
            success: false,
            circuitBreakerTriggered: true,
            telemetry: telemetryLogs,
            positions: updatedPositions,
            orders: newOrdersPlaced,
          });
        }
        log(symbol, 'RISK', riskCheck.reason || 'Pre-trade risk barrier');
        continue;
      }

      // SILENT Candle Idempotency Check:
      // Check the candle idempotency lock SILENTLY at the very beginning of the scan cycle
      // BEFORE evaluating signals or logging "Hybrid Signal: ...".
      // If the current candle timestamp is already locked, return early without spamming telemetry logs.
      const currentCandle = candles[candles.length - 1];
      const currentCandleTime = currentCandle.timestamp;

      if (idempotencyLocks.isCandleLocked(symbol, timeframe, currentCandleTime)) {
        continue;
      }

      // 3. Unified Institutional Hybrid Strategy Engine
      const signalResult = evaluateSignalGates(candles, {
        pairProfile: profile,
        timeframe,
      });

      if (!signalResult.isValid || signalResult.side === 'NONE') {
        if (signalResult.rejectionReason) {
          log(symbol, 'SIGNAL', signalResult.rejectionReason);
        }
        continue;
      }

      log(
        symbol,
        'SIGNAL',
        `Hybrid Signal: ${signalResult.setupName || signalResult.signalType} qualified with Confluence Score ${signalResult.confluenceScore || 65}/100 at ${signalResult.signalTriggerPrice}`
      );

      // 4. Consecutive Entry & Anti-Hedging Guard:
      // - Prevent opening BUY and SELL simultaneously on same symbol
      // - 15-second execution cooldown
      // - 15-pip price distance
      const consecutiveCheck = validateConsecutiveEntryRules(
        symbol,
        signalResult.side,
        signalResult.signalTriggerPrice,
        updatedPositions,
        profile
      );

      if (!consecutiveCheck.allowed) {
        log(symbol, 'RISK', consecutiveCheck.reason || 'Consecutive entry barrier');
        continue;
      }

      // 5. Silent Side-Specific Idempotency Guard
      const lockKey = idempotencyLocks.generateKey(symbol, timeframe, currentCandleTime, signalResult.side);
      if (idempotencyLocks.isLocked(lockKey)) {
        continue;
      }

      // 6. Gate 3: AI Confluence Judge with 6.0s Quantitative Fallback
      if (!signalResult.technicalSnapshot) {
        continue;
      }

      log(symbolSnapshot, 'AI', `[AI JUDGE] Evaluating ${signalResult.setupName || signalResult.signalType} (${mergedAi.model}) [6.0s timeout]...`);
      const aiVerdict = await evaluateWithAi(signalResult.technicalSnapshot, mergedAi);

      log(
        symbolSnapshot,
        'AI',
        `AI Verdict: ${aiVerdict.decision} (${aiVerdict.confidence_score}% via ${aiVerdict.source}). ${aiVerdict.reasoning}`
      );

      if (!aiVerdict.executionAllowed) {
        log(symbolSnapshot, 'AI', `Order REJECTED by AI: Score ${aiVerdict.confidence_score}% < Threshold ${mergedAi.confidenceThreshold}%`);
        continue;
      }

      // 6. Slippage Guard Check: strictly read post-AI quote from getSymbolQuote(symbolSnapshot)
      const postAiQuote = await client.getSymbolQuote(symbolSnapshot);
      const executionPrice = signalResult.side === 'BUY' ? postAiQuote.ask : postAiQuote.bid;
      const slippageCheck = validateSlippage(
        signalResult.side,
        signalResult.signalTriggerPrice,
        executionPrice,
        profile,
        mergedRisk.maxSlippagePips
      );

      if (!slippageCheck.allowed) {
        log(symbolSnapshot, 'RISK', slippageCheck.message);
        continue;
      }

      // 7. Order Execution on Exness strictly scoped to symbolSnapshot
      log(symbolSnapshot, 'ORDER', `Placing ${activeCreds.mode} ${signalResult.side} order for ${orderVolume} lots on ${symbolSnapshot}...`);

      const orderResult = await client.placeMarketOrder({
        symbol: symbolSnapshot,
        side: signalResult.side,
        volume: orderVolume,
        stopLossPrice: signalResult.proposedSlPrice,
        takeProfitPrice: signalResult.proposedTpPrice,
        comment: `EXN_${activeCreds.mode}_AI${aiVerdict.confidence_score}`,
      });

      if (orderResult.success) {
        // ONLY set lastExecutedCandleTime / acquire idempotency lock AFTER an order is actually placed and pushed into openPositions!
        idempotencyLocks.recordExecutedCandle(symbolSnapshot, timeframe, currentCandleTime, signalResult.side);

        log(symbolSnapshot, 'ORDER', `Order FILLED: #${orderResult.orderId} ${orderResult.side} ${orderResult.volume} ${orderResult.symbol} @ ${orderResult.fillPrice}`);
        newOrdersPlaced.push(orderResult);

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

    return NextResponse.json({
      ok: true,
      success: true,
      circuitBreakerTriggered: false,
      telemetry: telemetryLogs,
      positions: updatedPositions,
      orders: newOrdersPlaced,
      closedTrades,
    }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: String(err?.message || err || 'Engine tick error'),
        telemetry: telemetryLogs,
      },
      { status: 200 }
    );
  }
}
