'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTradingStore, getValidLivePrice, isValidPriceUpdate, getPersistedVerifiedAccount } from '@/store/useTradingStore';
import { getActiveExnessCredentials } from '@/lib/cryptoVault';
import { useRoomStore } from '@/store/useRoomStore';
import { PnlCalendarModal } from '@/components/PnlCalendarModal';
import { getPairProfile, formatPrice, evaluatePositionPnL } from '@/core/pairConfig';
import { computeIndicatorSnapshot, computeExpectedMarketMove, Timeframe } from '@/core/indicatorEngine';
import { computeVolumeProfileMetrics } from '@/core/kronosService';
import { computeForwardMarketOutlook } from '@/core/aiJudge';
import {
  Terminal,
  BrainCircuit,
  Zap,
  Play,
  Square,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  RefreshCw,
  Sliders,
  Trash2,
  CalendarDays,
} from 'lucide-react';

const TradingChart = dynamic(
  () => import('@/components/TradingChart').then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 rounded-2xl overflow-hidden flex flex-col h-full shadow-[0_2px_12px_rgba(15,23,42,0.03)] items-center justify-center min-h-[440px]">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 font-mono text-xs">
          <span className="w-2 h-2 rounded-full bg-[#10B981] animate-ping" />
          <span>Initializing NMSSx Institutional Chart Engine...</span>
        </div>
      </div>
    ),
  }
);

let isDashboardLoopRunning = false;
let hasLoggedFullCapacityTransition = false;
const MAX_OPEN_POSITIONS = 2;

const SYMBOLS = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'] as const;
const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1'];

export interface ForexTerminalRoomProps {
  isActiveRoom?: boolean;
}

export const ForexTerminalRoom: React.FC<ForexTerminalRoomProps> = ({ isActiveRoom = true }) => {
  const [isMounted, setIsMounted] = useState(false);
  const [isForexPnlOpen, setIsForexPnlOpen] = useState(false);

  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const activeRoom = useRoomStore((s) => s.activeRoom);
  const isForexActive = isActiveRoom && activeRoom !== 'CRYPTO' && activeRoom !== 'ROOM_2_BINANCE';

  // Exness Forex Store state
  const balance = useTradingStore((s) => s.balance);
  const equity = useTradingStore((s) => s.equity);
  const accountInfo = useTradingStore((s) => s.accountInfo);
  const accountMode = useTradingStore((s) => s.accountMode);
  const openPositions = useTradingStore((s) => s.openPositions);
  const positions = useTradingStore((s) => s.positions);
  const focusSymbol = useTradingStore((s) => s.focusSymbol);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const setFocusSymbol = useTradingStore((s) => s.setFocusSymbol);
  const timeframe = useTradingStore((s) => s.timeframe);
  const setTimeframe = useTradingStore((s) => s.setTimeframe);
  const quotes = useTradingStore((s) => s.quotes);
  const candles = useTradingStore((s) => s.candles);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const toggleAutoTrading = useTradingStore((s) => s.toggleAutoTrading);
  const lotSize = useTradingStore((s) => s.lotSize);
  const setLotSize = useTradingStore((s) => s.setLotSize);
  const enablePartialClose = useTradingStore((s) => s.enablePartialClose);
  const setEnablePartialClose = useTradingStore((s) => s.setEnablePartialClose);
  const telemetryLogs = useTradingStore((s) => s.telemetryLogs);
  const addTelemetryLog = useTradingStore((s) => s.addTelemetryLog);
  const clearTelemetry = useTradingStore((s) => s.clearTelemetry);
  const closePosition = useTradingStore((s) => s.closePosition);
  const modifyPosition = useTradingStore((s) => s.modifyPosition);
  const panicCloseAll = useTradingStore((s) => s.panicCloseAll);
  const fetchAccountInfo = useTradingStore((s) => s.fetchAccountInfo);
  const kronosPrediction = useTradingStore((s) => s.kronosPrediction);
  const kronosHealth = useTradingStore((s) => s.kronosHealth);
  const checkKronosHealth = useTradingStore((s) => s.checkKronosHealth);

  // Synchronized SL/TP execution parameter states with useTradingStore
  const storeSlPips = useTradingStore((s) => s.stopLossPips ?? 25);
  const storeTpPips = useTradingStore((s) => s.takeProfitPips ?? 50);
  const setStoreSlPips = useTradingStore((s) => s.setStopLossPips);
  const setStoreTpPips = useTradingStore((s) => s.setTakeProfitPips);

  const [slPips, setLocalSlPips] = useState<number>(storeSlPips);
  const [tpPips, setLocalTpPips] = useState<number>(storeTpPips);

  useEffect(() => {
    setLocalSlPips(storeSlPips);
  }, [storeSlPips]);

  useEffect(() => {
    setLocalTpPips(storeTpPips);
  }, [storeTpPips]);

  const handleSlChange = (val: number) => {
    const valid = Math.max(5, Math.min(500, val));
    setLocalSlPips(valid);
    setStoreSlPips(valid).catch(() => {});
  };

  const handleTpChange = (val: number) => {
    const valid = Math.max(5, Math.min(1000, val));
    setLocalTpPips(valid);
    setStoreTpPips(valid).catch(() => {});
  };

  const [isPlacingOrder, setIsPlacingOrder] = useState<'BUY' | 'SELL' | 'PANIC' | null>(null);
  const [closingIds, setClosingIds] = useState<Record<string, boolean>>({});
  const [modifyingIds, setModifyingIds] = useState<Record<string, boolean>>({});

  const loopLockRef = useRef(false);

  const activeSymbol = focusSymbol || selectedSymbol || 'XAUUSDm';
  const activeProfile = getPairProfile(activeSymbol);
  const activeQuote = quotes[activeSymbol];

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Initial load on mount - load real Exness vault, account, and real-time GET /api/kronos health & prediction
  useEffect(() => {
    const initTerminal = async () => {
      if (!isActiveRoom && !useTradingStore.getState().isAutoTrading && (!useTradingStore.getState().openPositions || useTradingStore.getState().openPositions.length === 0)) {
        return;
      }
      await Promise.allSettled([
        useTradingStore.getState().checkKronosHealth(),
        useTradingStore.getState().loadVaultOnStartup(),
        useTradingStore.getState().fetchAccountInfo(),
        useTradingStore.getState().fetchKronosPrediction(),
      ]);
      const st = useTradingStore.getState();
      const cleanPositions = (st.openPositions || []).filter(
        (p) => p && p.id !== 'F-637' && p.id !== '#F-637'
      );
      if (cleanPositions.length !== (st.openPositions || []).length) {
        useTradingStore.setState({
          positions: cleanPositions,
          openPositions: cleanPositions,
        });
      }
      if (cleanPositions.length === 0 && typeof st.balance === 'number' && st.balance > 0) {
        useTradingStore.setState({ equity: st.balance });
      }
    };
    initTerminal();
  }, [isActiveRoom]);

  // When room becomes active from background, fetch fresh forex data immediately
  useEffect(() => {
    if (isActiveRoom) {
      useTradingStore.getState().executeLiveTickStream().catch(() => {});
      useTradingStore.getState().fetchAccountInfo().catch(() => {});
      useTradingStore.getState().fetchKronosPrediction().catch(() => {});
    }
  }, [isActiveRoom]);

  // Real-time Kronos + Multi-AI forecast sync via POST /api/kronos
  const lastCandleClose = candles && candles.length > 0 ? candles[candles.length - 1]?.close : 0;
  useEffect(() => {
    if (!isForexActive && !isAutoTrading && (!openPositions || openPositions.length === 0)) return;
    let isCancelled = false;
    const syncKronosVps = async () => {
      const state = useTradingStore.getState();
      try {
        const res = await fetch('/api/kronos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: activeSymbol,
            timeframe,
            candles: (state.candles || []).slice(-60),
          }),
        });
        if (!isCancelled && res.ok) {
          const data = await res.json();
          if (data.ok || data.success) {
            useTradingStore.setState({
              kronosPrediction: {
                ...data,
                symbol: activeSymbol,
                timeframe,
              },
            });
          }
        }
      } catch {}
    };

    syncKronosVps();
    return () => {
      isCancelled = true;
    };
  }, [isForexActive, activeSymbol, timeframe, lastCandleClose]);

  // Singleton Coordinated Tick, Health Polling & Execution Loop
  useEffect(() => {
    if (isDashboardLoopRunning || loopLockRef.current) {
      return;
    }
    isDashboardLoopRunning = true;
    loopLockRef.current = true;

    let tickCounter = 0;
    let isExecuting = false;

    useTradingStore.getState().executeLiveTickStream().catch(() => {});

    const intervalId = setInterval(async () => {
      if (isExecuting) return;
      isExecuting = true;
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
        tickCounter++;
        const st = useTradingStore.getState();
        const currentRoom = useRoomStore.getState().activeRoom;
        const currentIsForexActive = isActiveRoom && currentRoom !== 'CRYPTO' && currentRoom !== 'ROOM_2_BINANCE';
        const isAuto = st.isAutoTrading;
        const rawOpen =
          Array.isArray(st.openPositions) && st.openPositions.length > 0
            ? st.openPositions
            : Array.isArray(st.positions)
            ? st.positions
            : [];
        const currentOpenList = rawOpen.filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637');
        const hasPositions = currentOpenList.length > 0;
        const isFullCapacity = currentOpenList.length >= MAX_OPEN_POSITIONS;

        if (!currentIsForexActive && !isAuto && !hasPositions) {
          return;
        }

        // 1. Real-time GET /api/kronos health polling every ~9s
        if (tickCounter % 3 === 0) {
          await st.checkKronosHealth();
        }

        // 2. Forex tick stream & Trailing Stop Guardian execution
        await st.executeLiveTickStream();

        if (isFullCapacity) {
          // Slot 2/2 Full: Entry Scanner IDLE — Log ONLY ONCE on transition into full capacity
          if (!hasLoggedFullCapacityTransition) {
            hasLoggedFullCapacityTransition = true;
            const guardMsg =
              '[POSITION-GUARD] Slot 2/2 terisi penuh — Entry Scanner IDLE. Mengalihkan pemrosesan ke Prediksi Arah & Trailing Stop.';
            const alreadyLogged = (st.telemetryLogs || [])
              .slice(0, 8)
              .some((l) => l.message.includes('[POSITION-GUARD] Slot'));
            if (!alreadyLogged) {
              const sym = st.focusSymbol || st.selectedSymbol || currentOpenList[0]?.symbol || 'XAUUSDm';
              st.addTelemetryLog(sym, 'AI', guardMsg);
            }
          }
          // Reallocate cycle strictly to Forward Market Forecast & Trailing Stop Management (no entry calls)
          if (tickCounter % 2 === 0) {
            await st.fetchKronosPrediction();
          }
        } else {
          hasLoggedFullCapacityTransition = false;
          if (isAuto) {
            await st.executeEngineTick();
          }
        }

        if (tickCounter % 4 === 0) {
          await useTradingStore.getState().fetchAccountInfo();
          if (!isFullCapacity) {
            await useTradingStore.getState().fetchKronosPrediction();
          }
        }

        if (tickCounter % 8 === 0) {
          await useTradingStore.getState().syncWithServerState();
        }
      } catch (err) {
        console.error('[NMSSx Execution Loop] Error:', err);
      } finally {
        isExecuting = false;
      }
    }, 3000);

    return () => {
      clearInterval(intervalId);
      isDashboardLoopRunning = false;
      loopLockRef.current = false;
    };
  }, []);

  // Live Active Forex Positions
  const activePositions = useMemo(() => {
    const raw =
      Array.isArray(openPositions) && openPositions.length > 0
        ? openPositions
        : Array.isArray(positions)
        ? positions
        : [];
    return raw.filter((p) => p && p.id !== 'F-637' && p.id !== '#F-637');
  }, [openPositions, positions]);

  const isSlotsFull = activePositions.length >= MAX_OPEN_POSITIONS;
  const entryScannerState = isSlotsFull
    ? 'IDLE (2/2 FULL — GUARDING POSITIONS)'
    : isAutoTrading
    ? 'ACTIVE'
    : 'IDLE';
  const forwardTightenLockRef = useRef<Record<string, number>>({});

  // Purge any legacy "Max concurrency limit:" spam from telemetryLogs store state
  useEffect(() => {
    if (telemetryLogs.some((l) => l.message.includes('Max concurrency limit:'))) {
      useTradingStore.setState({
        telemetryLogs: telemetryLogs.filter((l) => !l.message.includes('Max concurrency limit:')),
      });
    }
  }, [telemetryLogs]);

  // Live Floating PnL calculation across all active Forex positions strictly using filtered live prices
  const totalFloatingPnl = useMemo(() => {
    return activePositions.reduce((sum, pos) => {
      const q = quotes[pos.symbol];
      const validPrice = getValidLivePrice(pos.symbol);
      const prof = getPairProfile(pos.symbol);
      const safeQ = (q && isValidPriceUpdate(pos.symbol, q.bid))
        ? q
        : {
            symbol: pos.symbol,
            bid: validPrice,
            ask: Number((validPrice + (pos.symbol.startsWith('XAU') ? 0.20 : prof.pipValue)).toFixed(prof.digits)),
            spreadPips: pos.symbol.startsWith('XAU') ? 2.0 : 0.8,
            timestamp: Date.now(),
          };
      const pnl = evaluatePositionPnL(pos, safeQ);
      return sum + pnl.pnlUsd;
    }, 0);
  }, [activePositions, quotes]);

  // Compute live Kronos Forecaster & Multi-AI Consensus / Risk Governance metrics
  const aiMetrics = useMemo(() => {
    let bullishPct = 58;
    const liveRefPrice =
      activeQuote?.bid ||
      (candles && candles.length > 0 ? candles[candles.length - 1].close : 0);
    let pocPrice = liveRefPrice;
    let vahPrice = pocPrice;
    let valPrice = pocPrice;
    let rsiVal = 52.4;
    let zScore = 0;
    let atrVal = activeProfile.pipValue * (activeSymbol === 'XAUUSDm' ? 20 : 12);
    let momentum5 = 0;
    let bbwExpansionPct = 10;
    let regime = 'MEAN_REVERTING';
    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';

    if (candles && candles.length >= 15) {
      try {
        const snap = computeIndicatorSnapshot(
          candles,
          activeProfile.preset.rsiPeriod,
          activeProfile.preset.bbPeriod,
          activeProfile.preset.bbStdDev
        );
        rsiVal = snap.c0.rsi || 50;
        atrVal = snap.c0.atr14 || atrVal;
        momentum5 = snap.momentum5 || 0;
        bbwExpansionPct = snap.bbwExpansionPct || 10;
        const middleBB = snap.c0.middleBB || candles[candles.length - 1].close;
        const vp = computeVolumeProfileMetrics(candles, middleBB, activeProfile.digits);
        pocPrice = vp.poc;
        vahPrice = vp.vah;
        valPrice = vp.val;

        const lookback = candles.slice(-20);
        const mean = lookback.reduce((a, c) => a + c.close, 0) / lookback.length;
        const std = Math.sqrt(
          lookback.reduce((a, c) => a + Math.pow(c.close - mean, 2), 0) / lookback.length
        );
        zScore = std > 0 ? Number(((candles[candles.length - 1].close - mean) / std).toFixed(2)) : 0;

        const lastEma21 = snap.ema21?.[snap.ema21.length - 1] ?? middleBB;
        const lastEma50 = snap.ema50?.[snap.ema50.length - 1] ?? middleBB;
        const emaDiff = (lastEma21 - lastEma50) / (activeProfile.pipValue || 0.01);
        if (Math.abs(zScore) >= 1.5 && snap.bbwExpansionPct > 20) regime = 'VOLATILE_EXPANSION';
        else if (emaDiff > 3 && rsiVal >= 54) regime = 'TRENDING_BULL';
        else if (emaDiff < -3 && rsiVal <= 46) regime = 'TRENDING_BEAR';

        const rawScore = 50 + (rsiVal - 50) * 0.55 + Math.max(-20, Math.min(20, emaDiff * 0.4));
        bullishPct = Math.max(18, Math.min(88, Math.round(rawScore)));
      } catch {}
    }

    if (kronosPrediction && kronosPrediction.symbol === activeSymbol) {
      if (typeof kronosPrediction.bullishPct === 'number') {
        bullishPct = kronosPrediction.bullishPct;
      }
      if (typeof kronosPrediction.pocPrice === 'number' && kronosPrediction.pocPrice > 0) {
        pocPrice = kronosPrediction.pocPrice;
      }
      if (typeof kronosPrediction.vahPrice === 'number' && kronosPrediction.vahPrice > 0) {
        vahPrice = kronosPrediction.vahPrice;
      }
      if (typeof kronosPrediction.valPrice === 'number' && kronosPrediction.valPrice > 0) {
        valPrice = kronosPrediction.valPrice;
      }
      if (typeof kronosPrediction.rsi === 'number' && kronosPrediction.rsi > 0) {
        rsiVal = kronosPrediction.rsi;
      }
      if (typeof kronosPrediction.zScore === 'number') {
        zScore = kronosPrediction.zScore;
      }
      if (kronosPrediction.regime) {
        regime = kronosPrediction.regime;
      }
      if (kronosPrediction.signal) {
        signal = kronosPrediction.signal;
      }
    }

    if (signal === 'NEUTRAL') {
      if (bullishPct >= 62) signal = 'BUY';
      else if (bullishPct <= 38) signal = 'SELL';
    }

    const bearishPct = 100 - bullishPct;

    // Quantitative Expected Market Move (% and Target Price) from Kronos POC/VAH/VAL + ATR + Z-Score
    const expectedMove = computeExpectedMarketMove({
      currentPrice: liveRefPrice || pocPrice,
      pocPrice,
      vahPrice,
      valPrice,
      atr14: atrVal,
      zScore,
      rsi: rsiVal,
      momentum5,
      bbwExpansionPct,
      bullishPct,
      digits: activeProfile.digits,
    });

    const pctSign = expectedMove.expectedMovePct >= 0 ? '+' : '';
    const usdSign = expectedMove.expectedMoveUsd >= 0 ? '+$' : '-$';
    const projMoveFormatted = `${pctSign}${expectedMove.expectedMovePct.toFixed(2)}% (${usdSign}${Math.abs(
      expectedMove.expectedMoveUsd
    ).toFixed(activeProfile.digits)} -> ${formatPrice(
      expectedMove.expectedTargetPrice,
      activeProfile.digits
    )})`;

    // Forward Market Forecast (forwardOutlook) for Active Position Guardian & Style 2 Trailing Stop
    const forwardOutlook = computeForwardMarketOutlook({
      symbol: activeSymbol,
      currentPrice: liveRefPrice || pocPrice,
      pocPrice,
      vahPrice,
      valPrice,
      zScore,
      rsi: rsiVal,
      momentum5,
      bbwExpansionPct,
      bullishPct,
      expectedMovePct: expectedMove.expectedMovePct,
      expectedMoveUsd: expectedMove.expectedMoveUsd,
      expectedTargetPrice: expectedMove.expectedTargetPrice,
      digits: activeProfile.digits,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      openPositions: activePositions,
    });

    const latestAiLog = telemetryLogs.find(
      (l) =>
        !l.message.includes('Max concurrency limit:') &&
        (l.category === 'AI' ||
          l.message.toUpperCase().includes('MULTI-AI') ||
          l.message.toUpperCase().includes('CONSENSUS'))
    );
    const latestSignalLog = telemetryLogs.find(
      (l) => !l.message.includes('Max concurrency limit:') && l.category === 'SIGNAL'
    );

    const verdict = isSlotsFull
      ? `${forwardOutlook.nextBias} (${forwardOutlook.dominantPct}%) • ${forwardOutlook.reversalRisk}`
      : kronosPrediction?.symbol === activeSymbol && kronosPrediction?.verdict
      ? kronosPrediction.verdict
      : bullishPct >= 58
      ? 'BULLISH ACCUMULATION'
      : bullishPct <= 42
      ? 'BEARISH DISTRIBUTION'
      : 'NEUTRAL CONSOLIDATION';

    const multiAiSummary = isSlotsFull
      ? forwardOutlook.advisoryText
      : latestAiLog?.message ||
        (kronosPrediction?.symbol === activeSymbol ? kronosPrediction.multiAiSummary : '') ||
        latestSignalLog?.message ||
        `Multi-AI Consensus / Risk Governance active on ${activeSymbol} (${timeframe}). POC=${formatPrice(
          pocPrice,
          activeProfile.digits
        )}, VAH=${formatPrice(vahPrice, activeProfile.digits)}, VAL=${formatPrice(
          valPrice,
          activeProfile.digits
        )}, RSI=${rsiVal.toFixed(1)}, Z=${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)} (${regime}).`;

    return {
      bullishPct,
      bearishPct,
      verdict,
      multiAiSummary,
      pocPrice,
      vahPrice,
      valPrice,
      rsiVal,
      zScore,
      regime,
      signal,
      expectedTargetPrice: expectedMove.expectedTargetPrice,
      expectedMoveUsd: expectedMove.expectedMoveUsd,
      expectedMovePct: expectedMove.expectedMovePct,
      magnetType: expectedMove.magnetType,
      projMoveFormatted,
      forwardOutlook,
      reversalRisk: forwardOutlook.reversalRisk,
    };
  }, [candles, activeProfile, activeQuote, activeSymbol, timeframe, telemetryLogs, kronosPrediction, activePositions, isSlotsFull]);

  // Feed Forward Forecast directly into Style 2 Trailing Stop for active positions:
  // If user holds a BUY (LONG) position and Forward Forecast shifts strongly to SHORT (Bearish >= 68% and negative Proj. Move)
  // (or SELL position when LONG >= 68% and positive Proj. Move), freeze Phase A elastic cushion & tighten SL immediately to protect profit.
  useEffect(() => {
    if (activePositions.length === 0) return;
    const { forwardOutlook } = aiMetrics;
    if (!forwardOutlook.shouldTightenOrFreezeSl) return;

    const now = Date.now();
    activePositions.forEach((pos) => {
      if (pos.symbol !== activeSymbol) return;
      const isBuy = pos.side === 'BUY';
      const strongOpposing =
        (isBuy && forwardOutlook.shortPct >= 68 && forwardOutlook.expectedMovePct < 0) ||
        (!isBuy && forwardOutlook.longPct >= 68 && forwardOutlook.expectedMovePct > 0);
      if (!strongOpposing) return;

      // Immediately lock strict one-way ratchet so Style 2 Trailing Stop freezes against pullback
      pos.strictRatchetLocked = true;

      const prof = getPairProfile(pos.symbol);
      const q = quotes[pos.symbol];
      const curPrice = q ? (isBuy ? q.bid : q.ask) : pos.currentPrice || pos.entryPrice;
      if (!curPrice || curPrice <= 0) return;

      const profitDist = isBuy ? curPrice - pos.entryPrice : pos.entryPrice - curPrice;
      const profitPips = profitDist / (prof.pipValue || 0.01);
      const minStep = pos.symbol === 'XAUUSDm' ? 0.10 : prof.pipValue;

      if (profitPips >= 5) {
        const tightSlRaw = isBuy
          ? Math.max(pos.entryPrice + prof.pipValue, curPrice - 6 * prof.pipValue)
          : Math.min(pos.entryPrice - prof.pipValue, curPrice + 6 * prof.pipValue);
        const tightSl = Number(tightSlRaw.toFixed(prof.digits));
        const canTighten = isBuy
          ? tightSl < curPrice - 2 * prof.pipValue && (pos.currentSl === 0 || tightSl > pos.currentSl + minStep)
          : tightSl > curPrice + 2 * prof.pipValue && (pos.currentSl === 0 || tightSl < pos.currentSl - minStep);

        const lastTightenAt = forwardTightenLockRef.current[pos.id] || 0;
        if (canTighten && now - lastTightenAt > 12000) {
          forwardTightenLockRef.current[pos.id] = now;
          modifyPosition(pos.id, tightSl, pos.currentTp > 0 ? pos.currentTp : undefined).catch(() => {});
          addTelemetryLog(
            pos.symbol,
            'TRAILING',
            `[FORWARD-GUARD] Forward Forecast shifted to ${forwardOutlook.nextBias} (${forwardOutlook.dominantPct}%, Proj. Move ${forwardOutlook.expectedMovePct >= 0 ? '+' : ''}${forwardOutlook.expectedMovePct.toFixed(2)}% -> ${formatPrice(forwardOutlook.expectedTargetPrice, prof.digits)}): Tightened & froze Trailing SL at ${formatPrice(tightSl, prof.digits)} to protect open profit.`
          );
        }
      }
    });
  }, [activePositions, aiMetrics, activeSymbol, quotes, modifyPosition, addTelemetryLog]);

  // Direct Manual EA Market Execution wired to /api/exness
  const handleManualMarketOrder = async (side: 'BUY' | 'SELL') => {
    setIsPlacingOrder(side);
    try {
      const q = quotes[activeSymbol];
      const validPrice = getValidLivePrice(activeSymbol);
      const isQuoteValid = q && isValidPriceUpdate(activeSymbol, q.bid);
      const safeBid = isQuoteValid ? q.bid : validPrice;
      const safeAsk = isQuoteValid ? q.ask : Number((validPrice + (activeSymbol.startsWith('XAU') ? 0.20 : activeProfile.pipValue)).toFixed(activeProfile.digits));
      const refPrice = side === 'BUY' ? safeAsk : safeBid;
      const pipVal = activeProfile.pipValue;
      const stopLoss =
        refPrice > 0 && slPips > 0
          ? Number(
              (side === 'BUY' ? refPrice - slPips * pipVal : refPrice + slPips * pipVal).toFixed(
                activeProfile.digits
              )
            )
          : undefined;
      const takeProfit =
        refPrice > 0 && tpPips > 0
          ? Number(
              (side === 'BUY' ? refPrice + tpPips * pipVal : refPrice - tpPips * pipVal).toFixed(
                activeProfile.digits
              )
            )
          : undefined;

      addTelemetryLog(
        activeSymbol,
        'ORDER',
        `[EA] Dispatching ${side} Market Order (${lotSize.toFixed(2)} Lots) | SL: ${stopLoss ?? 'None'} | TP: ${takeProfit ?? 'None'}`
      );

      const activeCreds = getActiveExnessCredentials(useTradingStore.getState().credentials);
      const res = await fetch('/api/exness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'openOrder',
          symbol: activeSymbol,
          side,
          lot: lotSize,
          stopLoss,
          takeProfit,
          comment: `NMSSx_EA_${side}`,
          credentials: {
            accountId: activeCreds.accountId,
            server: activeCreds.server,
            apiKey: activeCreds.apiKey,
            token: activeCreds.apiKey,
            secret: activeCreds.secret,
            privateKey: activeCreds.secret,
            mode: activeCreds.mode,
          },
        }),
      });
      const data = await res.json();
      if (data.ok || data.success) {
        const orderId = data.order?.orderId || data.data?.orderId || 'LIVE';
        const fillPrice = data.order?.fillPrice || data.data?.fillPrice || refPrice;
        addTelemetryLog(
          activeSymbol,
          'ORDER',
          `[EA] Order FILLED #${orderId}: ${side} ${lotSize.toFixed(2)} ${activeSymbol} @ ${fillPrice}`
        );
        if (Array.isArray(data.positions) && (data.positions.length > 0 || data.positionsSuccess !== false)) {
          useTradingStore.setState({
            positions: data.positions,
            openPositions: data.positions,
          });
        }
        await fetchAccountInfo();
      } else {
        addTelemetryLog(
          activeSymbol,
          'RISK',
          `[EA] Order Rejected: ${data.error || data.message || 'Check Exness Vault connection'}`
        );
      }
    } catch (err: any) {
      addTelemetryLog(activeSymbol, 'RISK', `[EA] Execution Error: ${err?.message || 'Network failure'}`);
    } finally {
      setIsPlacingOrder(null);
    }
  };

  const handlePanicCloseAll = async () => {
    setIsPlacingOrder('PANIC');
    try {
      addTelemetryLog('SYSTEM', 'RISK', '[EA] Emergency Panic Close All triggered across Exness account');
      await panicCloseAll();
      await fetchAccountInfo();
    } finally {
      setIsPlacingOrder(null);
    }
  };

  const handleClosePosition = async (posId: string) => {
    setClosingIds((prev) => ({ ...prev, [posId]: true }));
    try {
      await closePosition(posId);
      await fetchAccountInfo();
    } finally {
      setClosingIds((prev) => {
        const next = { ...prev };
        delete next[posId];
        return next;
      });
    }
  };

  const handleModifyPosition = async (pos: any) => {
    setModifyingIds((prev) => ({ ...prev, [pos.id]: true }));
    try {
      const prof = getPairProfile(pos.symbol);
      const newSl =
        pos.side === 'BUY'
          ? Number((pos.entryPrice - slPips * prof.pipValue).toFixed(prof.digits))
          : Number((pos.entryPrice + slPips * prof.pipValue).toFixed(prof.digits));
      const newTp =
        pos.side === 'BUY'
          ? Number((pos.entryPrice + tpPips * prof.pipValue).toFixed(prof.digits))
          : Number((pos.entryPrice - tpPips * prof.pipValue).toFixed(prof.digits));
      await modifyPosition(pos.id, newSl, newTp);
      addTelemetryLog(
        pos.symbol,
        'TRAILING',
        `[EA] Modified #${pos.id.slice(-6)} -> SL: ${formatPrice(newSl, prof.digits)} | TP: ${formatPrice(newTp, prof.digits)}`
      );
    } finally {
      setModifyingIds((prev) => {
        const next = { ...prev };
        delete next[pos.id];
        return next;
      });
    }
  };

  // Unified ALL Telemetry stream (suppressing any repeat concurrency spam)
  const formattedTelemetry = useMemo(() => {
    let seenPositionGuard = false;
    return telemetryLogs
      .filter((item) => {
        if (item.message.includes('Max concurrency limit:')) {
          return false;
        }
        if (item.message.includes('[POSITION-GUARD] Slot')) {
          if (seenPositionGuard) return false;
          seenPositionGuard = true;
        }
        return true;
      })
      .slice(0, 100)
      .map((item) => {
      let tag: 'KRONOS' | 'MULTI-AI' | 'EA-ORDER' | 'ACCOUNT' = 'EA-ORDER';
      const msgUpper = item.message.toUpperCase();
      if (
        item.category === 'SIGNAL' ||
        msgUpper.includes('KRONOS') ||
        msgUpper.includes('HYBRID SIGNAL') ||
        msgUpper.includes('CANDLE')
      ) {
        tag = 'KRONOS';
      } else if (
        item.category === 'AI' ||
        item.category === 'RISK' ||
        msgUpper.includes('MULTI-AI') ||
        msgUpper.includes('CONSENSUS')
      ) {
        tag = 'MULTI-AI';
      } else if (
        item.symbol === 'ACCOUNT' ||
        item.symbol === 'VAULT' ||
        msgUpper.includes('BALANCE') ||
        msgUpper.includes('VAULT')
      ) {
        tag = 'ACCOUNT';
      } else {
        tag = 'EA-ORDER';
      }
      return { ...item, institutionalTag: tag };
    });
  }, [telemetryLogs]);

  const credentials = useTradingStore((s) => s.credentials);
  const verifiedAcc = getPersistedVerifiedAccount();
  const activeCreds = getActiveExnessCredentials(credentials);
  const hasVaultCreds = Boolean(
    (credentials.demoAccountId && credentials.demoApiKey) ||
    (credentials.realAccountId && credentials.realApiKey) ||
    (credentials.exnessAccountId && credentials.exnessToken) ||
    (activeCreds.accountId && activeCreds.apiKey)
  );
  const isBound = Boolean(accountInfo?.connected || hasVaultCreds || verifiedAcc);

  // Strictly bind liveBalance to actual broker account balance ($85.37), never overwrite with balance + floatingPnl
  const liveBalance = (balance !== null && balance !== undefined && balance > 0)
    ? balance
    : (accountInfo?.balance !== null && accountInfo?.balance !== undefined && accountInfo.balance > 0)
    ? accountInfo.balance
    : (verifiedAcc?.balance ?? null);

  const liveEquity = (equity !== null && equity !== undefined && equity > 0)
    ? equity
    : (accountInfo?.equity !== null && accountInfo?.equity !== undefined && accountInfo.equity > 0)
    ? accountInfo.equity
    : (liveBalance !== null && liveBalance !== undefined)
    ? Number((liveBalance + totalFloatingPnl).toFixed(2))
    : (verifiedAcc?.equity ?? null);

  const liveAccountNumber = accountInfo?.accountNumber || verifiedAcc?.accountId || activeCreds.accountId || '30000143146';
  const liveMode = accountInfo?.mode || verifiedAcc?.mode || accountMode || 'DEMO';
  const isConnected = Boolean(accountInfo?.connected || (isBound && liveBalance !== null));
  const liveLatency = accountInfo?.latencyMs && accountInfo.latencyMs > 0 ? accountInfo.latencyMs : 14;

  return (
    <div className="flex-1 flex max-w-[1920px] w-full mx-auto">
      {/* Left Minimalist Watchlist Sidebar on Desktop */}
      <aside className="hidden xl:flex w-60 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 flex-col justify-between p-4 shrink-0 select-none">
        <div className="space-y-6">
          <div className="space-y-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-2">
              TERMINAL WORKSPACE
            </div>
            <div className="pt-1 space-y-1.5">
              <div className="w-full px-3 py-2.5 rounded-xl bg-[#0F172A] dark:bg-emerald-500/15 text-white dark:text-emerald-300 dark:border dark:border-emerald-500/30 text-xs font-medium flex items-center justify-between shadow-2xs">
                <span className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <span>Forex Execution</span>
                </span>
                <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
              </div>
              <button
                type="button"
                onClick={() => setActiveRoom('CRYPTO')}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 border border-slate-200/80 dark:border-zinc-800 text-slate-600 dark:text-slate-300 hover:text-[#0F172A] dark:hover:text-slate-100 text-xs font-mono font-medium flex items-center justify-between transition-colors cursor-pointer"
              >
                <span>Switch to Crypto Perpetuals</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
          </div>

          {/* Active Symbol Watchlist in Sidebar */}
          <div className="space-y-2 pt-4 border-t border-slate-100 dark:border-zinc-800">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-2">
              LIVE EXNESS FEED
            </div>
            <div className="space-y-1.5">
              {SYMBOLS.map((sym) => {
                const q = quotes[sym];
                const prof = getPairProfile(sym);
                const isSel = activeSymbol === sym;
                return (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setFocusSymbol(sym)}
                    className={`w-full p-2.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between ${
                      isSel
                        ? 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-emerald-500/40 shadow-2xs'
                        : 'bg-white dark:bg-zinc-900/70 border-slate-200/70 dark:border-zinc-800 hover:bg-slate-50 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    <div>
                      <div className="font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100">
                        {sym}
                      </div>
                      <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono">
                        Spread: {q?.spreadPips ?? 1.2}p
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                        {q ? formatPrice(q.bid, prof.digits) : '---'}
                      </div>
                      <div className="text-[10px] text-rose-600 dark:text-rose-400">
                        {q ? formatPrice(q.ask, prof.digits) : '---'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sidebar Bottom Status Card */}
        <div className="p-3.5 rounded-2xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
              ED25519 SIGNING
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-[#10B981] animate-pulse' : 'bg-amber-400'
              }`}
            />
          </div>
          <div className="font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100 truncate">
            #{liveAccountNumber}
          </div>
          <div className="font-mono text-[10px] text-slate-500 dark:text-zinc-500 truncate">
            ap-6756732d.exness-api.com
          </div>
        </div>
      </aside>

      {/* Main Forex Terminal Content */}
      <main className="flex-1 p-3 sm:p-5 space-y-4 min-w-0">
        {/* TOP STATUS & KPI STRIP */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* 1. CONSOLIDATED EXNESS BALANCE, ACCOUNT ID, EQUITY & FLOATING PNL */}
          <div className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                  EXNESS BALANCE
                </span>
                <button
                  type="button"
                  onClick={() => setIsForexPnlOpen(true)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                  title="Open PnL Calendar"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isConnected
                        ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]'
                        : 'bg-slate-500'
                    }`}
                  />
                  <span>#{liveAccountNumber}</span>
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold">
                  {liveMode}
                </span>
                <button
                  type="button"
                  onClick={() => fetchAccountInfo()}
                  className="text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer p-0.5"
                  title="Sync Exness Balance"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            <div className="my-2">
              <div className="font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-xl sm:text-2xl font-mono">
                {liveBalance !== null && liveBalance !== undefined
                  ? `$${Number(liveBalance).toFixed(2)}`
                  : 'Vault Unbound'}
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 dark:text-zinc-400 pt-1 border-t border-slate-100 dark:border-zinc-800/80">
              <div className="flex items-center gap-1.5 truncate">
                <span>
                  Equity:{' '}
                  <strong className="text-slate-700 dark:text-slate-200 font-semibold">
                    {liveEquity !== null && liveEquity !== undefined
                      ? `$${Number(liveEquity).toFixed(2)}`
                      : '---'}
                  </strong>
                </span>
                <span className="text-slate-300 dark:text-zinc-600">•</span>
                <span>
                  PnL:{' '}
                  <strong
                    className={`font-semibold ${
                      totalFloatingPnl >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {totalFloatingPnl >= 0 ? '+' : ''}${totalFloatingPnl.toFixed(2)}
                  </strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsForexPnlOpen(true)}
                className="text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer shrink-0"
                title="PnL Calendar"
              >
                <CalendarDays className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 2. MULTI-AI CONSENSUS / RISK GOVERNANCE */}
          <div className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold truncate">
                MULTI-AI CONSENSUS
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border shrink-0 ${
                  isSlotsFull
                    ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-200/80 dark:border-amber-500/30'
                    : isAutoTrading
                    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                    : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                }`}
              >
                {entryScannerState}
              </span>
            </div>
            <div className="my-1.5 space-y-1 font-mono text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-zinc-400">Kronos Horizon:</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-400">
                  {aiMetrics.bullishPct}% Bull / {aiMetrics.bearishPct}% Bear
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-zinc-400">Proj. Move:</span>
                <span
                  className={`font-bold ${
                    aiMetrics.expectedMovePct >= 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {aiMetrics.projMoveFormatted}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-zinc-400">Risk Governance:</span>
                <span className="font-bold text-[#0F172A] dark:text-slate-100 truncate max-w-[130px]">
                  {aiMetrics.verdict}
                </span>
              </div>
            </div>
            <div className="text-[10px] font-mono text-slate-400 dark:text-zinc-500 flex items-center justify-between">
              <span>Dynamic AI Gate: AUTO (58–82%)</span>
              <span
                className={`font-semibold ${
                  kronosHealth?.aiReady
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {kronosHealth?.aiReady ? 'AI READY' : 'QUANT MODE'}
              </span>
            </div>
          </div>
        </section>

        {/* MAIN CONTENT GRID */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* LEFT / CENTER AREA (8 cols on lg) */}
          <div className="lg:col-span-8 space-y-4 min-w-0">
            {/* LIVE MARKET CHART CARD */}
            <div className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-3 sm:p-4 space-y-3">
              {/* Instrument Selector Pills + Timeframe Pills */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  {SYMBOLS.map((sym) => {
                    const isActive = activeSymbol === sym;
                    return (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setFocusSymbol(sym)}
                        className={`px-3 py-1.5 rounded-xl font-mono text-xs font-semibold transition-all cursor-pointer ${
                          isActive
                            ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                            : 'bg-slate-50 dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {sym}
                      </button>
                    );
                  })}
                </div>

                {/* Timeframe Pills */}
                <div className="flex items-center gap-1 bg-slate-50 dark:bg-slate-950 p-1 rounded-xl border border-slate-200/80 dark:border-zinc-800 font-mono">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        timeframe === tf
                          ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Bid / Ask / Spread & Kronos Quant Metrics Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200/80 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 font-semibold">
                    BID: {activeQuote ? formatPrice(activeQuote.bid, activeProfile.digits) : '---'}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 font-semibold">
                    ASK: {activeQuote ? formatPrice(activeQuote.ask, activeProfile.digits) : '---'}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200">
                    SPREAD: <strong>{activeQuote?.spreadPips ?? 1.2} pips</strong>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 font-semibold">
                    POC: {formatPrice(aiMetrics.pocPrice, activeProfile.digits)}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 font-semibold">
                    VAH: {formatPrice(aiMetrics.vahPrice, activeProfile.digits)} · VAL:{' '}
                    {formatPrice(aiMetrics.valPrice, activeProfile.digits)}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 font-semibold">
                    Z: {aiMetrics.zScore >= 0 ? '+' : ''}
                    {aiMetrics.zScore}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-semibold border ${
                      aiMetrics.signal === 'BUY'
                        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                        : aiMetrics.signal === 'SELL'
                        ? 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    Signal: {aiMetrics.signal}
                  </span>
                </div>
              </div>

              {/* Adaptive Dark / Light TradingChart Component */}
              <div className="h-[430px] sm:h-[470px] w-full">
                <TradingChart />
              </div>
            </div>

            {/* ACTIVE OPEN POSITIONS TABLE */}
            <div className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200/80 dark:border-zinc-800 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
                  <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm">
                    Active Posisi
                  </h2>
                  <span className="bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold">
                    {activePositions.length} Open
                  </span>
                </div>
                {activePositions.length > 0 && (
                  <button
                    type="button"
                    onClick={handlePanicCloseAll}
                    disabled={isPlacingOrder === 'PANIC'}
                    className="bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isPlacingOrder === 'PANIC' ? 'Closing All...' : 'Panic Close All'}
                  </button>
                )}
              </div>

              {activePositions.length === 0 ? (
                <div className="p-8 text-center space-y-1">
                  <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
                    No active positions open.
                  </div>
                  <p className="text-slate-400 dark:text-zinc-500 text-xs">
                    Use Manual EA Quick Execution or toggle START AUTO-TRADING to execute live Exness orders.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="bg-slate-50/90 dark:bg-slate-950/90 text-[10px] sm:text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 border-b border-slate-200/80 dark:border-zinc-800">
                      <tr>
                        <th className="px-3 sm:px-4 py-2.5">TICKET / SYMBOL &amp; SIDE</th>
                        <th className="px-3 sm:px-4 py-2.5">ENTRY -&gt; CURRENT</th>
                        <th className="px-3 sm:px-4 py-2.5">PNL (USD / PIPS)</th>
                        <th className="px-3 sm:px-4 py-2.5 text-right">ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                      {activePositions.map((pos) => {
                        const prof = getPairProfile(pos.symbol);
                        const q = quotes[pos.symbol];
                        const validLivePrice = getValidLivePrice(pos.symbol);
                        const safeQuote = (q && isValidPriceUpdate(pos.symbol, q.bid))
                          ? q
                          : {
                              symbol: pos.symbol,
                              bid: validLivePrice,
                              ask: Number((validLivePrice + (pos.symbol.startsWith('XAU') ? 0.20 : prof.pipValue)).toFixed(prof.digits)),
                              spreadPips: pos.symbol.startsWith('XAU') ? 2.0 : 0.8,
                              timestamp: Date.now(),
                            };
                        const pnlData = evaluatePositionPnL(pos, safeQuote);
                        const isProfit = pnlData.pnlUsd >= 0;

                        return (
                          <tr
                            key={pos.id}
                            className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors"
                          >
                            <td className="px-3 sm:px-4 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-bold text-[#0F172A] dark:text-slate-100">
                                  {pos.symbol}
                                </span>
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                    pos.side === 'BUY'
                                      ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                                      : 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
                                  }`}
                                >
                                  {pos.side}
                                </span>
                                <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                                  {pos.volume.toFixed(2)} Lot
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">
                                #{pos.id.slice(-7)}
                              </div>
                            </td>
                            <td className="px-3 sm:px-4 py-2.5 text-slate-700 dark:text-slate-300">
                              <div className="whitespace-nowrap">
                                {formatPrice(pos.entryPrice, prof.digits)} -&gt;{' '}
                                <strong className="text-[#0F172A] dark:text-white">
                                  {formatPrice(pnlData.curPrice, prof.digits)}
                                </strong>
                              </div>
                              {(pos.currentSl > 0 || pos.currentTp > 0) && (
                                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 whitespace-nowrap">
                                  <span className="text-rose-500/90 dark:text-rose-400/90">
                                    SL: {pos.currentSl > 0 ? formatPrice(pos.currentSl, prof.digits) : '—'}
                                  </span>
                                  {' • '}
                                  <span className="text-emerald-600/90 dark:text-emerald-400/90">
                                    TP: {pos.currentTp > 0 ? formatPrice(pos.currentTp, prof.digits) : '—'}
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap">
                              <div
                                className={`font-bold text-xs sm:text-sm ${
                                  isProfit
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {isProfit ? '+' : ''}${pnlData.pnlUsd.toFixed(2)}
                              </div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500">
                                {isProfit ? '+' : ''}
                                {pnlData.pnlPips} pips
                              </div>
                            </td>
                            <td className="px-3 sm:px-4 py-2.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => handleClosePosition(pos.id)}
                                disabled={closingIds[pos.id]}
                                className="bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-50"
                              >
                                {closingIds[pos.id] ? 'Closing...' : 'Close'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT CONTROL PANEL (4 cols on lg: MULTI-AI CONSENSUS / RISK GOVERNANCE + EA EXECUTION CONTROL) */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 space-y-5">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 pb-3.5">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
                  <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm uppercase">
                    EA EXECUTION &amp; RISK GOVERNANCE
                  </h2>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-200 font-semibold">
                  {activeSymbol}
                </span>
              </div>

              {/* Master Auto-Trading Button */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => toggleAutoTrading()}
                  className={`w-full py-3.5 px-4 rounded-xl font-sans font-bold text-xs sm:text-sm transition-all flex items-center justify-center gap-2 shadow-xs cursor-pointer ${
                    isAutoTrading
                      ? 'bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100'
                      : 'bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white'
                  }`}
                >
                  {isAutoTrading ? (
                    <>
                      <Square className="w-4 h-4 fill-current" />
                      <span>STOP AUTO-TRADING</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current text-emerald-400 dark:text-white" />
                      <span>START AUTO-TRADING</span>
                    </>
                  )}
                </button>
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400 px-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isSlotsFull
                          ? 'bg-amber-500 animate-pulse'
                          : isAutoTrading
                          ? 'bg-[#10B981] animate-pulse'
                          : 'bg-slate-300 dark:bg-zinc-600'
                      }`}
                    />
                    <span>
                      {isSlotsFull
                        ? 'IDLE (2/2 FULL — GUARDING POSITIONS)'
                        : isAutoTrading
                        ? 'Autonomous Loop Active'
                        : 'Autonomous Loop Standby'}
                    </span>
                  </span>
                  <span>Cycle: 3.0s</span>
                </div>
                {isSlotsFull && (
                  <div className="px-2.5 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-500/15 border border-amber-200/90 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 font-mono text-[10px] font-bold tracking-tight text-center shadow-2xs">
                    STATUS: ENTRY IDLE (2/2 FULL) • MODE: FORWARD FORECAST &amp; TRAILING GUARD
                  </div>
                )}
              </div>

              {/* Manual EA Quick Execution */}
              <div className="p-4 rounded-xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs uppercase tracking-wider font-semibold text-[#0F172A] dark:text-slate-100 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    MANUAL EA QUICK EXECUTION
                  </span>
                  <span className="font-mono text-[10px] text-slate-500 dark:text-zinc-400">
                    Direct Ed25519
                  </span>
                </div>

                {/* Lot Size (0.01 - 1.00) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label className="text-slate-500 dark:text-zinc-400 font-medium">
                      Lot Size (0.01 - 1.00)
                    </label>
                    <span className="font-mono font-bold text-[#0F172A] dark:text-slate-100">
                      {lotSize.toFixed(2)} Lots
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="1.00"
                      value={lotSize}
                      onChange={(e) =>
                        setLotSize(
                          Math.max(0.01, Math.min(1.0, parseFloat(e.target.value) || 0.01))
                        )
                      }
                      className="w-24 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-1.5 font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100 focus:outline-none focus:border-[#0F172A] dark:focus:border-emerald-500"
                    />
                    <div className="flex-1 grid grid-cols-4 gap-1 font-mono text-[11px]">
                      {[0.01, 0.05, 0.1, 0.5].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setLotSize(preset)}
                          className={`py-1.5 rounded-lg border transition-all cursor-pointer ${
                            lotSize === preset
                              ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600 font-semibold'
                              : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {preset.toFixed(2)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Stop Loss (Pips) & Take Profit (Pips) */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="block text-slate-500 dark:text-zinc-400 text-xs">
                      Stop Loss (Pips)
                    </label>
                    <input
                      type="number"
                      min="5"
                      max="500"
                      value={slPips}
                      onChange={(e) =>
                        handleSlChange(parseInt(e.target.value, 10) || 25)
                      }
                      className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-1.5 font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-slate-500 dark:text-zinc-400 text-xs">
                      Take Profit (Pips)
                    </label>
                    <input
                      type="number"
                      min="5"
                      max="1000"
                      value={tpPips}
                      onChange={(e) =>
                        handleTpChange(parseInt(e.target.value, 10) || 50)
                      }
                      className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-1.5 font-mono text-xs font-bold text-[#0F172A] dark:text-slate-100"
                    />
                  </div>
                </div>

                {/* Hybrid Style 2 Trailing Stop Toggle */}
                <div className="flex items-center justify-between pt-1">
                  <div>
                    <div className="text-xs font-semibold text-[#0F172A] dark:text-slate-100">
                      Hybrid Trailing Stop (Style 2)
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                      Phase A Elastic Cushion + Phase B Ratchet
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEnablePartialClose(!enablePartialClose)}
                    className={`px-3 py-1 rounded-full font-mono text-xs font-semibold border transition-all cursor-pointer ${
                      enablePartialClose
                        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    {enablePartialClose ? 'ACTIVE' : 'OFF'}
                  </button>
                </div>

                {/* BUY MARKET and SELL MARKET Buttons */}
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => handleManualMarketOrder('BUY')}
                    disabled={isPlacingOrder !== null}
                    className="bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-medium rounded-xl px-3 py-2.5 text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <ArrowUpRight className="w-4 h-4 text-emerald-400 dark:text-white" />
                    <span>{isPlacingOrder === 'BUY' ? 'EXECUTING...' : 'BUY MARKET'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleManualMarketOrder('SELL')}
                    disabled={isPlacingOrder !== null}
                    className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-zinc-800 rounded-xl px-3 py-2.5 text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <ArrowDownRight className="w-4 h-4 text-rose-500" />
                    <span>{isPlacingOrder === 'SELL' ? 'EXECUTING...' : 'SELL MARKET'}</span>
                  </button>
                </div>
              </div>

              {/* Multi-AI Consensus / Risk Governance + Kronos Quant Metrics Widget */}
              <div className="p-4 rounded-xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs uppercase tracking-wider font-semibold text-[#0F172A] dark:text-slate-100 flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>Multi-AI Consensus / Risk Governance</span>
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border shrink-0 ${
                      kronosHealth?.vpsReady
                        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    {kronosHealth?.vpsReady ? 'VPS LIVE' : 'QUANT ENGINE'}
                  </span>
                </div>

                {/* Kronos K-Line Probability Bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                      Kronos Bullish: {aiMetrics.bullishPct}%
                    </span>
                    <span className="text-rose-600 dark:text-rose-400 font-semibold">
                      Bearish: {aiMetrics.bearishPct}%
                    </span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-rose-100 dark:bg-rose-950/70 overflow-hidden flex">
                    <div
                      className="h-full bg-[#10B981] transition-all duration-300"
                      style={{ width: `${aiMetrics.bullishPct}%` }}
                    />
                  </div>
                </div>

                {/* Kronos Quant Metrics Grid: POC, VAH, VAL, RSI, Z-Score, Regime */}
                <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px]">
                  <div className="p-2 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800">
                    <div className="text-slate-400 dark:text-zinc-500">POC</div>
                    <div className="font-bold text-[#0F172A] dark:text-slate-100">
                      {formatPrice(aiMetrics.pocPrice, activeProfile.digits)}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800">
                    <div className="text-slate-400 dark:text-zinc-500">VAH / VAL</div>
                    <div className="font-bold text-[#0F172A] dark:text-slate-100 truncate">
                      {formatPrice(aiMetrics.vahPrice, activeProfile.digits)} / {formatPrice(aiMetrics.valPrice, activeProfile.digits)}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800">
                    <div className="text-slate-400 dark:text-zinc-500">RSI / Z</div>
                    <div className="font-bold text-[#0F172A] dark:text-slate-100">
                      {aiMetrics.rsiVal.toFixed(1)} / {aiMetrics.zScore}
                    </div>
                  </div>
                </div>

                {/* Quantitative Expected Market Move (% / $) Estimator */}
                <div className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 flex items-center justify-between font-mono text-[11px]">
                  <span className="text-slate-500 dark:text-zinc-400 font-semibold">
                    Proj. Move:
                  </span>
                  <span
                    className={`font-bold ${
                      aiMetrics.expectedMovePct >= 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {aiMetrics.projMoveFormatted}
                  </span>
                </div>

                {/* Multi-AI Consensus / Risk Governance Summary */}
                <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 font-semibold">
                      Multi-AI Consensus / Risk Governance
                    </div>
                    {isSlotsFull && (
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                          aiMetrics.reversalRisk === 'HIGH REVERSAL RISK'
                            ? 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
                            : aiMetrics.reversalRisk === 'MODERATE'
                            ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/30'
                            : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                        }`}
                      >
                        {aiMetrics.reversalRisk}
                      </span>
                    )}
                  </div>
                  {isSlotsFull && (
                    <div className="px-2 py-1 rounded-lg bg-amber-50/90 dark:bg-amber-500/15 border border-amber-200/80 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 font-mono text-[10px] font-bold tracking-tight">
                      STATUS: ENTRY IDLE (2/2 FULL) • MODE: FORWARD FORECAST &amp; TRAILING GUARD
                    </div>
                  )}
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-mono">
                    {aiMetrics.multiAiSummary}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* BOTTOM CARD: LIVE EXECUTION TELEMETRY */}
        <section className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200/80 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
              <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-xs sm:text-sm uppercase">
                LIVE EXECUTION TELEMETRY
              </h2>
              <span className="font-mono text-xs text-slate-400 dark:text-zinc-500">
                ({formattedTelemetry.length})
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="px-2.5 py-1 rounded-lg font-mono text-[11px] uppercase tracking-wider bg-[#0F172A] dark:bg-emerald-600 text-white font-semibold cursor-default"
              >
                ALL
              </button>
              <button
                type="button"
                onClick={clearTelemetry}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Clear Telemetry Logs"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800/80 font-mono text-xs">
            {formattedTelemetry.length === 0 ? (
              <div className="p-6 text-center text-slate-400 dark:text-zinc-500">
                [SYSTEM] Live Execution Telemetry stream active for Account #{liveAccountNumber}. Waiting for next tick event...
              </div>
            ) : (
              formattedTelemetry.map((log) => {
                const timeStr = isMounted ? new Date(log.timestamp).toLocaleTimeString() : '';
                const badgeStyle =
                  log.institutionalTag === 'KRONOS'
                    ? 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-500/30'
                    : log.institutionalTag === 'MULTI-AI'
                    ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-500/30'
                    : log.institutionalTag === 'ACCOUNT'
                    ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30'
                    : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30';
                return (
                  <div
                    key={log.id}
                    className="px-4 py-2 hover:bg-slate-50/80 dark:hover:bg-zinc-800/40 flex items-start gap-2.5 leading-relaxed"
                  >
                    <span className="text-slate-400 dark:text-zinc-500 shrink-0">[{timeStr}]</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${badgeStyle}`}
                    >
                      [{log.institutionalTag}]
                    </span>
                    <span className="font-semibold text-[#0F172A] dark:text-slate-200 shrink-0">
                      [{log.symbol}]
                    </span>
                    <span className="text-slate-600 dark:text-slate-300 break-all">
                      {log.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>

      {/* Forex PnL Calendar Modal */}
      <PnlCalendarModal isOpen={isForexPnlOpen} onClose={() => setIsForexPnlOpen(false)} />
    </div>
  );
};

export default ForexTerminalRoom;
