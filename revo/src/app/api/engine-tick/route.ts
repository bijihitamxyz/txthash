import { NextRequest, NextResponse } from 'next/server';
import { ExnessClient, realTimeFeed } from '@/core/exnessClient';
import { getPairProfile, SUPPORTED_SYMBOLS, calculatePnL, evaluatePositionPnL } from '@/core/pairConfig';
import { evaluateSignalGates } from '@/core/signalGate';
import { evaluateMultiAiConsensus, AiConfig } from '@/core/aiJudge';
import {
  evaluatePositionTrailing,
  ManagedPosition,
  sanitizePositionSlTp,
  canAttemptPositionClose,
  reconcileOrphanPositions,
  evaluateWatchdogEmergencyClose,
} from '@/core/trailingManager';
import {
  evaluatePreTradeRisk,
  idempotencyLocks,
  validateSlippage,
  validateConsecutiveEntryRules,
  RiskGuardConfig,
  DEFAULT_RISK_CONFIG,
  calculateForexLotSize,
  dualRoomProtections,
} from '@/core/riskGuard';
import { stateSync, TargetMarket } from '@/lib/stateSync';
import { ensureSchedulerStarted } from '@/lib/engineScheduler';
import { getActiveExnessCredentials } from '@/lib/cryptoVault';
import {
  tryAcquireEngineLock,
  releaseEngineLock,
  tryAcquireOrderExecutionLock,
  releaseOrderExecutionLock,
} from '@/lib/engineLock';
import {
  readCentralAiConfig,
  getActiveAiProviders,
  formatActiveAiSummaryLabel,
  calculateDynamicThreshold,
} from '@/core/centralAiConfig';
import { loadVaultCredentials } from '@/core/exnessVault';
import { computeRealTimeKronosForecast } from '@/core/kronosService';
import { Timeframe } from '@/core/indicatorEngine';

export const dynamic = 'force-dynamic';

function sanitizeRuntimeState(state: any) {
  if (!state) return state;
  const cleanPositions = Array.isArray(state.positions)
    ? state.positions.filter((p: any) => p && p.id !== 'F-637' && p.id !== '#F-637')
    : [];
  const base = {
    ...state,
    isRunning: Boolean(state.isAutoTrading),
    isAutoTrading: Boolean(state.isAutoTrading),
    positions: cleanPositions,
    openPositions: cleanPositions,
    balance: typeof state.accountInfo?.balance === 'number' && state.accountInfo.balance > 0 ? state.accountInfo.balance : null,
    equity: typeof state.accountInfo?.equity === 'number' && state.accountInfo.equity > 0 ? state.accountInfo.equity : null,
    lotSize: typeof state.lotSize === 'number' && state.lotSize > 0 ? state.lotSize : 0.10,
    maxPositions: 2,
    slPips: state.stopLossPips ?? state.slPips ?? 25,
    tpPips: state.takeProfitPips ?? state.tpPips ?? 50,
  };
  if (!state.credentials) return base;
  return {
    ...base,
    credentials: {
      accountMode: state.credentials.accountMode,
      demoAccountId: state.credentials.demoAccountId,
      demoServer: state.credentials.demoServer,
      demoApiKey: state.credentials.demoApiKey ? '••••••••' : '',
      demoInitialBalance: state.credentials.demoInitialBalance ?? 0,
      realAccountId: state.credentials.realAccountId,
      realServer: state.credentials.realServer,
      realApiKey: state.credentials.realApiKey ? '••••••••' : '',
      realInitialBalance: state.credentials.realInitialBalance ?? 0,
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
    apiKey?: string;
    privateKey?: string;
    secret?: string;
    mode?: 'REAL' | 'DEMO';
    bridgeUrl?: string;
  };
  symbols?: string[];
  targetMarket?: TargetMarket;
  timeframe?: string;
  orderVolume?: number;
  stopLossPips?: number;
  takeProfitPips?: number;
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
  let lockToken = 0;
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

    // Acquire execution lock so API tick does not collide with the in-process 3s scheduler
    lockToken = tryAcquireEngineLock('api-tick');
    if (!lockToken) {
      // Background scheduler or another tick is already actively running right now.
      // Return fresh state immediately to avoid parallel broker spam or request queuing.
      return NextResponse.json({
        ok: true,
        success: true,
        circuitBreakerTriggered: runtimeState.circuitBreakerTriggered || false,
        telemetry: runtimeState.telemetryLogs || [],
        positions: runtimeState.positions || [],
        orders: [],
        closedTrades: [],
        inFlight: true,
      }, { status: 200 });
    }

    const activeCreds = getActiveExnessCredentials(runtimeState.credentials);

    // Exness credentials are ALWAYS loaded from the server-side AES vault or server state.
    let vaultCreds = await loadVaultCredentials();
    if (!vaultCreds && activeCreds.apiKey && activeCreds.secret && activeCreds.secret.length >= 32) {
      vaultCreds = {
        accountId: activeCreds.accountId || '30000143146',
        mode: activeCreds.mode === 'REAL' ? 'REAL' : 'DEMO',
        server: activeCreds.server || 'https://api.exness-api.com',
        apiKey: activeCreds.apiKey,
        privateKey: activeCreds.secret,
        updatedAt: Date.now(),
      };
    }
    if (!vaultCreds && body.credentials && (body.credentials.apiKey || body.credentials.token || body.credentials.accountId)) {
      vaultCreds = {
        accountId: String(body.credentials.accountId || '30000143146').trim(),
        mode: body.credentials.mode === 'REAL' ? 'REAL' : 'DEMO',
        server: String(body.credentials.server || 'https://api.exness-api.com').trim(),
        apiKey: String(body.credentials.apiKey || body.credentials.token || '').trim(),
        privateKey: String(body.credentials.privateKey || body.credentials.secret || '').trim(),
        updatedAt: Date.now(),
      };
    }

    const effectiveMarket = body.targetMarket || runtimeState.targetMarket || 'FOREX';
    let symbols: string[];
    if (Array.isArray(body.symbols) && body.symbols.length > 0) {
      symbols = body.symbols;
    } else if (effectiveMarket === 'GOLD') {
      symbols = ['XAUUSDm'];
    } else if (effectiveMarket === 'FOREX') {
      symbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
    } else {
      symbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
    }

    // Immediately synchronize client configuration changes to runtime state
    if (body.targetMarket || body.orderVolume !== undefined || body.stopLossPips !== undefined || body.takeProfitPips !== undefined || body.enablePartialClose !== undefined || body.symbols) {
      await stateSync.updateRuntimeState({
        targetMarket: effectiveMarket,
        scannedSymbols: symbols,
        ...(body.orderVolume !== undefined ? { lotSize: body.orderVolume } : {}),
        ...(body.stopLossPips !== undefined ? { stopLossPips: body.stopLossPips } : {}),
        ...(body.takeProfitPips !== undefined ? { takeProfitPips: body.takeProfitPips } : {}),
        ...(body.enablePartialClose !== undefined ? { enablePartialClose: body.enablePartialClose } : {}),
      });
    }

    const timeframe = body.timeframe || 'M5';
    const orderVolume = body.orderVolume ?? runtimeState.lotSize ?? 0.10;
    const stopLossPips = body.stopLossPips ?? runtimeState.stopLossPips ?? 25;
    const takeProfitPips = body.takeProfitPips ?? runtimeState.takeProfitPips ?? 50;
    const enablePartialClose = body.enablePartialClose ?? runtimeState.enablePartialClose ?? true;

    const mergedRisk: RiskGuardConfig = { ...DEFAULT_RISK_CONFIG, ...body.riskConfig };
    const centralAi = await readCentralAiConfig();
    const activeAiProviders = getActiveAiProviders(centralAi);
    const activeAiSummaryLabel = formatActiveAiSummaryLabel(centralAi);
    const effectiveAiThreshold = centralAi.confidenceThreshold ?? runtimeState.aiConfidenceThreshold ?? 70;

    if (centralAi.engineSwitches?.emergencyKillSwitch) {
      log('SYSTEM', 'RISK', '[ADMIN KILL-SWITCH] Emergency Halt is active in Admin Dashboard. Skipping execution cycle.');
      return NextResponse.json({
        ok: false,
        success: false,
        circuitBreakerTriggered: true,
        error: 'Emergency Kill-Switch active via Admin Governance.',
        telemetry: telemetryLogs,
        positions: runtimeState.positions || [],
        orders: [],
      }, { status: 200 });
    }

    if (!vaultCreds) {
      log('SYSTEM', 'RISK', '[EA] Order blocked: No Exness credentials configured in Vault or session.');
      return NextResponse.json({
        ok: false,
        success: false,
        error: 'Akun Exness belum terhubung. Engine tidak akan trading tanpa kredensial Exness asli.',
        telemetry: telemetryLogs,
        positions: [],
        orders: [],
      }, { status: 200 });
    }
    const client = new ExnessClient(vaultCreds);

    let validSymbols = symbols.filter((s) => SUPPORTED_SYMBOLS.includes(s));
    if (validSymbols.length === 0) {
      validSymbols = ['XAUUSDm'];
    }

    // Authoritative open positions are ALWAYS read live from Exness (forceLive=true).
    // On timeout/failure, retain lastKnownGoodState (runtimeState.positions) instead of wiping to [].
    let currentPositions: ManagedPosition[];
    try {
      currentPositions = await client.fetchOpenPositions(true);
      currentPositions = reconcileOrphanPositions(currentPositions, runtimeState.positions || [], stopLossPips, takeProfitPips);
    } catch (err: any) {
      log('SYSTEM', 'RISK', `Gagal membaca posisi dari Exness: ${err?.message || err}. Tick dilewati.`);
      return NextResponse.json({
        ok: false,
        success: false,
        error: String(err?.message || err),
        telemetry: telemetryLogs,
        positions: runtimeState.positions || [],
        orders: [],
      }, { status: 200 });
    }

    // When auto-trading is stopped, HALT scanning but NEVER purge active open positions!
    if (!runtimeState.isAutoTrading) {
      return NextResponse.json({
        ok: true,
        success: true,
        circuitBreakerTriggered: false,
        telemetry: telemetryLogs,
        positions: currentPositions,
        orders: [],
      }, { status: 200 });
    }

    const updatedPositions: ManagedPosition[] = [...currentPositions];
    const newOrdersPlaced: any[] = [];
    const closedTrades: { id: string; symbol: string; pnl: number; reason: string }[] = [];
    const dailyLoss = Math.max(
      Number(runtimeState.dailyRealizedLossUsd || 0),
      Math.max(0, -realTimeFeed.getDailyRealizedPnL())
    );

    for (const symbol of validSymbols) {
      // Enforce targetMarket strictly: if targetMarket === 'GOLD', restricted to XAUUSDm only
      if (effectiveMarket === 'GOLD' && symbol !== 'XAUUSDm') {
        continue;
      }
      // In Both Simultaneously mode, capture symbolSnapshot scoped to this specific pair
      const symbolSnapshot = symbol;
      const profile = getPairProfile(symbolSnapshot);

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

        // Extreme Price Deviation Guard (> 15% jump):
        // Prevents corrupted 0/NaN or mismatched quotes from triggering SL/TP prematurely
        const previousValidPrice = pos.currentPrice || pos.entryPrice;
        if (previousValidPrice > 0) {
          const deviation = Math.abs(curPrice - previousValidPrice) / previousValidPrice;
          if (deviation > 0.15) {
            log(symbolSnapshot, 'RISK', `[PositionPriceGuard] Skipping SL/TP/Trailing evaluation for #${pos.id}: quote price ${curPrice} differs by ${(deviation * 100).toFixed(1)}% from previous valid price ${previousValidPrice}`);
            continue;
          }
        }
        pos.currentPrice = curPrice;
        sanitizePositionSlTp(pos, curPrice, stopLossPips, takeProfitPips);

        // 1.0 Watchdog Emergency Close Sweeper (checks every tick regardless of candle/trailing state)
        const watchdog = evaluateWatchdogEmergencyClose(pos, curPrice, profile, stopLossPips);
        if (watchdog.shouldClose) {
          if (!canAttemptPositionClose(pos.id)) {
            pos.isClosing = true;
            continue;
          }
          const realizedPnl = watchdog.unrealizedPnl;
          log(symbol, 'RISK', watchdog.reason || `[WATCHDOG EMERGENCY CLOSE] #${pos.id} breached Hard SL (-${stopLossPips} pips).`);
          dualRoomProtections.recordStopLossHit(symbol, 'forex', 'WATCHDOG_HARD_SL');
          pos.isClosing = true;
          pos.closingStartedAt = Date.now();
          const closeRes = await client.closePosition(pos.id, undefined, symbol);
          if (closeRes.success) {
            closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'WATCHDOG_HARD_SL' });
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
          }
          continue;
        }

        // 1a. Take Profit hit verification
        if (pos.currentTp > 0 && (isBuy ? curPrice >= pos.currentTp : curPrice <= pos.currentTp)) {
          if (!canAttemptPositionClose(pos.id)) {
            pos.isClosing = true;
            continue;
          }
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'ORDER', `[TAKE PROFIT HIT] #${pos.id} ${pos.side} @ ${curPrice} (+$${realizedPnl.toFixed(2)})`);
          pos.isClosing = true;
          pos.closingStartedAt = Date.now();
          const closeRes = await client.closePosition(pos.id, undefined, symbol);
          if (closeRes.success) {
            closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'TP' });
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
          }
          continue;
        }

        // 1b. Stop Loss / Trailing Stop hit verification
        if (pos.currentSl > 0 && (isBuy ? curPrice <= pos.currentSl : curPrice >= pos.currentSl)) {
          if (!canAttemptPositionClose(pos.id)) {
            pos.isClosing = true;
            continue;
          }
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'ORDER', `[STOP LOSS / TRAILING STOP HIT] #${pos.id} ${pos.side} @ ${curPrice} (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})`);
          pos.isClosing = true;
          pos.closingStartedAt = Date.now();
          const closeRes = await client.closePosition(pos.id, undefined, symbol);
          if (closeRes.success) {
            closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'SL' });
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
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
          stopLossPips,
          expectedMovePct: indicators.expectedMovePct,
          expectedTargetPrice: indicators.expectedTargetPrice,
          expectedMoveUsd: indicators.expectedMoveUsd,
          pocPrice: indicators.pocPrice,
          vahPrice: indicators.vahPrice,
          valPrice: indicators.valPrice,
          zScore: indicators.c0.zScore,
        });

        // Hard SL Circuit Breaker handling
        if (trailingAction.type === 'HARD_SL_CLOSE') {
          if (!canAttemptPositionClose(pos.id)) {
            pos.isClosing = true;
            continue;
          }
          const pnlData = evaluatePositionPnL(pos, quote);
          const realizedPnl = Number(pnlData.pnlUsd.toFixed(2));
          log(symbol, 'RISK', trailingAction.reason);
          pos.isClosing = true;
          pos.closingStartedAt = Date.now();
          const closeRes = await client.closePosition(pos.id, undefined, symbol);
          if (closeRes.success) {
            closedTrades.push({ id: pos.id, symbol, pnl: realizedPnl, reason: 'HARD_SL' });
            const posIdx = updatedPositions.findIndex((p) => p.id === pos.id);
            if (posIdx !== -1) {
              updatedPositions.splice(posIdx, 1);
            }
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
              pos.virtualSl = trailingAction.newSlPrice;
              pos.trailingStatus = trailingAction.statusUpdate;
            }
          }
        }
      }

      // 2. Pre-Trade Institutional Circuit Breakers (computed directly from live updatedPositions.length)
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
        const rejectMsg = signalResult.rejectionReason || `[GATE] Confluence score ${signalResult.confluenceScore || 0}/100 insufficient (< 65). Order rejected.`;
        log(symbol, 'SIGNAL', rejectMsg);
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
        log(symbol, 'RISK', `Order REJECTED by Anti-Hedging/Cooldown Guard: ${consecutiveCheck.reason || 'Consecutive entry barrier'}`);
        continue;
      }

      // 5. Silent Side-Specific Idempotency Guard
      const lockKey = idempotencyLocks.generateKey(symbol, timeframe, currentCandleTime, signalResult.side);
      if (idempotencyLocks.isLocked(lockKey)) {
        continue;
      }

      // 6. Gate 3: Multi-AI Confluence Judge + Kronos VPS Forecast with 6.0s Quantitative Fallback
      if (!signalResult.technicalSnapshot) {
        continue;
      }

      const kronosForecast = computeRealTimeKronosForecast({
        symbol: symbolSnapshot,
        timeframe: (timeframe as Timeframe) || 'M5',
        candles,
        aiModel: activeAiSummaryLabel,
      });

      log(
        symbolSnapshot,
        'SIGNAL',
        `[KRONOS VPS] ${symbolSnapshot} (${timeframe}) Bullish: ${kronosForecast.bullishPct}% | POC: ${kronosForecast.pocPrice} | VAH: ${kronosForecast.vahPrice} | VAL: ${kronosForecast.valPrice} | Z: ${kronosForecast.zScore} (${kronosForecast.regime})`
      );

      const recentSlForex = dualRoomProtections.hasRecentStopLoss(symbolSnapshot, 'forex');
      const latestPrice = candles[candles.length - 1]?.close || quote.bid;
      const pocPrice = kronosForecast.pocPrice || latestPrice;
      let pocMagnetAligned = false;
      if (signalResult.side === 'BUY') {
        pocMagnetAligned = latestPrice < pocPrice && pocPrice <= middleBB;
      } else if (signalResult.side === 'SELL') {
        pocMagnetAligned = latestPrice > pocPrice && pocPrice >= middleBB;
      }
      signalResult.technicalSnapshot.pocMagnetAligned = pocMagnetAligned;

      const dynamicThresholdRes = calculateDynamicThreshold({
        efficiencyRatio: signalResult.indicators.efficiencyRatio,
        pocMagnetAligned,
        kronosProbability: kronosForecast.bullishPct || 50,
        bbwExpandingRapidly: signalResult.indicators.bbwExpansionPct > 15,
        recentStopLoss: recentSlForex,
        symbol: symbolSnapshot,
        marketType: 'FOREX',
      });

      const symbolThreshold = centralAi.autoAdaptiveThreshold !== false
        ? dynamicThresholdRes.threshold
        : effectiveAiThreshold;

      if (activeAiProviders.length === 0) {
        log(symbolSnapshot, 'AI', `[MULTI-AI CONSENSUS] Kronos Quantitative Engine active. Evaluating ${signalResult.setupName || signalResult.signalType}...`);
      } else {
        log(symbolSnapshot, 'AI', `[MULTI-AI CONSENSUS] Querying ${activeAiProviders.length} active provider(s) (${activeAiSummaryLabel}) in parallel...`);
      }
      const aiVerdict = await evaluateMultiAiConsensus(
        signalResult.technicalSnapshot,
        activeAiProviders,
        symbolThreshold,
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

      const isSignalVerified = aiVerdict.executionAllowed || aiVerdict.confidence_score >= dynamicThresholdRes.threshold;
      const autoGovDecision = isSignalVerified ? 'EXECUTE' : 'REJECT';
      log(
        symbolSnapshot,
        'AI',
        `[AUTO-GOVERNANCE] AI Score: ${aiVerdict.confidence_score}% vs Dynamic Threshold: ${dynamicThresholdRes.threshold}% (${dynamicThresholdRes.reasons.join(', ')}) -> ${autoGovDecision}`
      );

      log(
        symbolSnapshot,
        'AI',
        `Multi-AI Verdict: ${autoGovDecision === 'EXECUTE' ? 'EXECUTE' : aiVerdict.decision} (${aiVerdict.confidence_score}% via ${aiVerdict.source}). ${aiVerdict.reasoning}`
      );

      if (!isSignalVerified) {
        log(symbolSnapshot, 'AI', `Order REJECTED by Multi-AI Consensus: Score ${aiVerdict.confidence_score}% < Dynamic Threshold ${dynamicThresholdRes.threshold}%`);
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
        log(symbolSnapshot, 'RISK', `Order REJECTED by Slippage Guard: ${slippageCheck.message}`);
        continue;
      }

      // 7. Order Execution on Exness strictly scoped to symbolSnapshot
      if (centralAi.engineSwitches?.localEaExecutor === false) {
        log(symbolSnapshot, 'RISK', `[ADMIN GOVERNANCE] Local EA Executor switch is disabled by Admin. Order skipped.`);
        continue;
      }

      // Calculate Lot Size strictly respecting user's configured UI lot size
      const userLot = typeof orderVolume === 'number' && orderVolume > 0 ? orderVolume : (runtimeState.lotSize || 0.10);
      const safeVolume = Math.max(profile.minLot || 0.01, Number(userLot.toFixed(2)));

      // Calculate SL and TP prices strictly from user's configured stopLossPips and takeProfitPips
      const userSlPips = typeof stopLossPips === 'number' && stopLossPips > 0 ? stopLossPips : 25;
      const userTpPips = typeof takeProfitPips === 'number' && takeProfitPips > 0 ? takeProfitPips : 50;
      const pipVal = profile.pipValue;
      const refPrice = executionPrice > 0 ? executionPrice : signalResult.signalTriggerPrice;
      const computedSlPrice = signalResult.side === 'BUY'
        ? Number((refPrice - userSlPips * pipVal).toFixed(profile.digits))
        : Number((refPrice + userSlPips * pipVal).toFixed(profile.digits));
      const computedTpPrice = signalResult.side === 'BUY'
        ? Number((refPrice + userTpPips * pipVal).toFixed(profile.digits))
        : Number((refPrice - userTpPips * pipVal).toFixed(profile.digits));

      const orderLockToken = tryAcquireOrderExecutionLock('api-tick');
      if (!orderLockToken) {
        log(symbolSnapshot, 'RISK', `[ORDER_MUTEX] Skipping ${signalResult.side} ${symbolSnapshot}: another order execution is currently in-flight.`);
        continue;
      }

      let orderResult: any;
      try {
        // Live fetch directly from Exness API right before placing order (never trust cached counts)
        const liveOpenPositions = await client.fetchOpenPositions(true);
        if (liveOpenPositions.length >= 2) {
          log(symbolSnapshot, 'RISK', `[POSITION_GUARD] Max 2 positions reached on Exness server (${liveOpenPositions.length}/2). Order aborted.`);
          break;
        }

        log(
          symbolSnapshot,
          'ORDER',
          `Placing ${activeCreds.mode} ${signalResult.side} order for ${safeVolume} lots on ${symbolSnapshot} (SL: ${userSlPips} pips, TP: ${userTpPips} pips)...`
        );

        orderResult = await client.placeMarketOrder({
          symbol: symbolSnapshot,
          side: signalResult.side,
          volume: safeVolume,
          stopLossPrice: computedSlPrice,
          takeProfitPrice: computedTpPrice,
          comment: `EXN_${activeCreds.mode}_AI${aiVerdict.confidence_score}`,
        });
      } finally {
        releaseOrderExecutionLock(orderLockToken);
      }

      if (orderResult.marginAutoScaleLog) {
        log(symbolSnapshot, 'ORDER', orderResult.marginAutoScaleLog);
      }

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
        log(symbolSnapshot, 'ORDER', `Order REJECTED by Broker: ${orderResult.message}`);
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
  } finally {
    if (lockToken) {
      releaseEngineLock(lockToken);
    }
  }
}
